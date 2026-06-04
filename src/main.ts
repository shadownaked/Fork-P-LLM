import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { ProtocolHandler } from './protocol-handler'
import { APIServer, setTokenRefreshCallback } from './api-server'
import { registerAdapters, adapterRegistry, isWebSocketAdapter } from './adapters'
import type { Config, SiteConfig } from './types'
import { getMainLogger, clearLogsDir, closeSiteLoggers } from './logger'
import { credentialStore, siteStore, requestStore, modelStore, toolSettingsStore, usageStore, claudeConnectStore } from './store'
import type { ConnectTarget } from './store'
import { ConfigWatcher } from './config-watcher'
import { validateConfig, formatValidationErrors } from './schemas'
import { isTokenExpired, requestTokenRefresh, isRefreshInProgress } from './token-refresh'
import { isClaudeInstalled } from './claude-settings'
import { getTakeoverStatus, takeoverClaude, restoreClaude, forceCleanup } from './claude-takeover'
import { testClaudeApi } from './api-test'
import {
  oauthProviderRegistry,
  registerOAuthProviders,
  oauthSessionStore,
  extractEmailFromIdToken,
  getModelsForProvider,
  getProviderDisplayName,
  OAUTH_PROVIDER_MODELS
} from './oauth'
import type { OAuthProviderType } from './types'
import {
  ProxyServer,
  CertManager,
  loadProxySettings,
  getProxyStatus,
  revealCACert,
  toggleProxy,
  shouldUseProxy
} from './proxy'
import type { CapturedRequest as ProxyCapturedRequest, CapturedResponse } from './proxy'
import { processRequestCapture, processResponseCapture } from './capture-handler'

// Bypass system proxy for MITM forwarding to avoid proxy loops
// This MUST be set before any network requests are made
process.env.NO_PROXY = '*'

// Clear logs directory before initializing loggers
clearLogsDir()

const log = getMainLogger()

let controlWindow: BrowserWindow | null = null
// Multi-window support: Map<siteId, BrowserWindow>
const targetWindows: Map<string, BrowserWindow> = new Map()
let protocolHandler: ProtocolHandler | null = null
let apiServer: APIServer | null = null
let configWatcher: ConfigWatcher | null = null
let proxyServer: ProxyServer | null = null
let certManager: CertManager | null = null
let config: Config

// Proxy server configuration
const PROXY_PORT = 8889
const PROXY_HOST = '127.0.0.1'

// Config file path
const configPath = path.join(__dirname, '..', 'config', 'rules.json')

// Load configuration with schema validation
function loadConfig(): Config {
  const defaultConfig: Config = {
    apiServerPort: 8080,
    apiServerHost: '127.0.0.1',
    requireApiKey: false,
    apiKeys: [],
    modelAliases: {},
    defaultTargetUrl: 'https://example.com'  // Placeholder, not actively used
  }

  try {
    if (!fs.existsSync(configPath)) {
      log.warn('Config file not found, using defaults')
      return defaultConfig
    }

    const configData = fs.readFileSync(configPath, 'utf-8')
    let parsed: unknown

    try {
      parsed = JSON.parse(configData)
    } catch (parseError) {
      const err = parseError as Error
      log.error(`Config JSON parse error: ${err.message}`)
      log.warn('Using default configuration due to parse error')
      return defaultConfig
    }

    // Validate with Zod schema
    const validation = validateConfig(parsed)

    if (!validation.success) {
      log.error('Config validation failed:')
      log.error(formatValidationErrors(validation.errors))
      log.warn('Using default configuration due to validation errors')
      return defaultConfig
    }

    log.info('Config loaded and validated from', configPath)
    return validation.data as Config
  } catch (error) {
    const err = error as Error
    log.error(`Failed to load config: ${err.message}`)
    log.warn('Using default configuration')
    return defaultConfig
  }
}

// Reload configuration and update API server
/**
 * Migrate existing site configurations to apply default adapter rules
 * This ensures sites created before the adapter had default rules get updated
 */
function migrateSiteConfigs(): void {
  let migrated = 0

  for (const site of siteStore.getAll()) {
    const adapter = adapterRegistry.getByName(site.adapterType)
    if (!adapter) continue

    let needsUpdate = false
    const updates: Partial<SiteConfig> = {}

    // Check if capture rules need migration
    // Only migrate if current rules are generic (just '*' pattern)
    if (adapter.getDefaultCaptureRules) {
      const defaultRules = adapter.getDefaultCaptureRules()
      const hasOnlyGenericRules = site.captureRules.every(r => r.urlPattern === '*')

      if (hasOnlyGenericRules && defaultRules.length > 0) {
        updates.captureRules = defaultRules
        needsUpdate = true
        log.info(`[Migration] Applying ${defaultRules.length} default capture rules to site "${site.id}"`)
      }
    }

    // Check if model capture config needs migration
    if (!site.modelCaptureConfig && adapter.getDefaultModelCaptureConfig) {
      const defaultModelConfig = adapter.getDefaultModelCaptureConfig()
      if (defaultModelConfig) {
        updates.modelCaptureConfig = defaultModelConfig
        needsUpdate = true
        log.info(`[Migration] Applying default model capture config to site "${site.id}"`)
      }
    }

    if (needsUpdate) {
      siteStore.update(site.id, updates)
      migrated++
    }
  }

  if (migrated > 0) {
    log.info(`[Migration] Migrated ${migrated} site(s) with adapter default rules`)
  }
}

/**
 * Parse JWT token and extract expiration time
 * @param token JWT token (with or without "Bearer " prefix)
 * @returns expiration timestamp in milliseconds, or null if not a JWT or no exp claim
 */
function parseJwtExpiration(token: string): number | null {
  if (!token) return null

  // Remove Bearer prefix if present
  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null // Not a JWT

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    const exp = payload.exp

    if (!exp) return null // No expiry claim

    return exp * 1000 // Convert to milliseconds
  } catch {
    return null // Can't parse, not a JWT
  }
}

/**
 * Register dynamic models for a site based on captured request data
 * Extracts model information from the request body
 */
function registerDynamicModels(siteId: string, requestBody: string | null): void {
  if (!requestBody) {
    log.debug(`No request body for model extraction, site: ${siteId}`)
    return
  }

  try {
    const bodyJson = JSON.parse(requestBody)

    // Common model field names used by different services
    const modelFields = ['model', 'modelId', 'model_id', 'modelName', 'model_name']

    for (const field of modelFields) {
      if (bodyJson[field] && typeof bodyJson[field] === 'string') {
        const modelId = bodyJson[field]

        // Use site ID as prefix to avoid conflicts
        const exposedModelName = `${siteId}/${modelId}`

        modelStore.setModels(siteId, [{
          modelName: exposedModelName,
          modelId: modelId,
          displayName: `${siteId} - ${modelId}`
        }])

        log.info(`Extracted model "${modelId}" from field "${field}" for site "${siteId}"`)
        return
      }
    }

    log.debug(`No model field found in request body for site "${siteId}"`)
  } catch {
    log.debug(`Could not parse request body as JSON for model extraction, site: ${siteId}`)
  }
}

/**
 * Extract siteId from URL by matching against registered sites
 */
function getSiteIdFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const hostname = urlObj.hostname

    // Find matching site by URL pattern
    for (const site of siteStore.getAll()) {
      if (site.targetUrl.includes(hostname)) {
        return site.id
      }
    }

    // Default fallback
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Check if URL should be skipped (tracking/analytics only)
 * Now captures ALL requests except tracking domains
 */
function shouldSkipUrl(url: string): boolean {
  const urlLower = url.toLowerCase()

  // Skip tracking/analytics domains only
  const skipDomains = [
    'googletagmanager.com',
    'google-analytics.com',
    'facebook.com',
    'bing.com',
    'doubleclick.net',
    'analytics.',
    'tracking.',
    'telemetry.'
  ]
  return skipDomains.some(domain => urlLower.includes(domain))
}

/**
 * Initialize proxy server for HTTP/HTTPS traffic capture
 */
function initializeProxyServer(): void {
  // Initialize certificate manager for HTTPS MITM
  const certDir = path.join(app.getPath('userData'), 'certs')
  certManager = new CertManager({ certDir })

  try {
    certManager.initialize()
    log.info(`[Proxy] Certificate manager initialized, CA cert at: ${certManager.getCACertificatePath()}`)
    log.info(`[Proxy] CA fingerprint: ${certManager.getCAFingerprint()}`)
  } catch (err) {
    log.warn('[Proxy] Failed to initialize certificate manager, HTTPS MITM disabled:', err)
    certManager = null
  }

  // Create proxy server
  proxyServer = new ProxyServer({
    port: PROXY_PORT,
    host: PROXY_HOST,
    certManager: certManager || undefined,

    onRequest: (req: ProxyCapturedRequest) => {
      const siteId = getSiteIdFromUrl(req.url)
      if (siteId === 'unknown' || shouldSkipUrl(req.url)) return

      log.debug(`[Proxy] Captured request: ${req.method} ${req.url}`)

      // Store request
      requestStore.addRequest(siteId, {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body?.toString('utf-8') || null,
        contentType: req.headers['content-type'] || null
      })
    },

    onResponse: (req: ProxyCapturedRequest, res: CapturedResponse) => {
      const siteId = getSiteIdFromUrl(req.url)
      if (siteId === 'unknown' || shouldSkipUrl(req.url)) return

      log.debug(`[Proxy] Captured response: ${res.status} ${req.url}`)

      // Update request with response data
      requestStore.updateRequestResponse(siteId, req.url, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
        body: res.body?.toString('utf-8') || null,
        mimeType: res.headers['content-type'] || null
      })
    },

    onSSEChunk: (req: ProxyCapturedRequest, chunk: string) => {
      const siteId = getSiteIdFromUrl(req.url)
      if (siteId === 'unknown') return

      log.debug(`[Proxy] SSE chunk for ${req.url}: ${chunk.substring(0, 100)}...`)

      // Store SSE chunk
      requestStore.addSSEChunk(siteId, req.id, chunk)
    },

    onConnect: (hostname: string, port: number) => {
      log.debug(`[Proxy] CONNECT tunnel: ${hostname}:${port}`)
    },

    onError: (error: Error, context: string) => {
      log.warn(`[Proxy] Error in ${context}: ${error.message}`)
    }
  })

  proxyServer.start()
  log.info(`[Proxy] Proxy server started on ${PROXY_HOST}:${PROXY_PORT}`)
}

function reloadConfig(): void {
  log.info('[HotReload] Reloading configuration...')
  try {
    const newConfig = loadConfig()
    config = newConfig

    // Update API server with new config (hot reload)
    if (apiServer) {
      apiServer.updateConfig(newConfig)
    }

    log.info('[HotReload] Configuration reloaded successfully')
  } catch (err) {
    log.error('[HotReload] Failed to reload configuration:', err)
  }
}

// Check if Vite dev server is running
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

async function isViteDevServerRunning(): Promise<boolean> {
  if (app.isPackaged) return false

  try {
    const response = await fetch(VITE_DEV_SERVER_URL, { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

// Get renderer path - works in both dev and packaged mode
function getRendererPath(): string {
  // In development: renderer/dist/ for built React app, or renderer/ for legacy
  // In packaged app: renderer/ is copied to resources
  const devDistPath = path.join(__dirname, '..', 'renderer', 'dist', 'index.html')
  const devPath = path.join(__dirname, '..', 'renderer', 'index.html')
  const prodPath = path.join(process.resourcesPath, 'renderer', 'index.html')

  if (app.isPackaged && fs.existsSync(prodPath)) {
    return prodPath
  }
  // Prefer built React app in dev mode
  if (fs.existsSync(devDistPath)) {
    return devDistPath
  }
  return devPath
}

// Create control panel window
async function createControlWindow(): Promise<void> {
  controlWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LLM Proxy Control',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  // Load the UI - prefer Vite dev server in development
  const useViteDevServer = await isViteDevServerRunning()

  if (useViteDevServer) {
    log.info(`Loading renderer from Vite dev server: ${VITE_DEV_SERVER_URL}`)
    await controlWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    const rendererPath = getRendererPath()
    log.info(`Loading renderer from: ${rendererPath}`)

    if (fs.existsSync(rendererPath)) {
      await controlWindow.loadFile(rendererPath)
    } else {
      // Fallback: show error message if renderer not found
      log.error(`Renderer not found at: ${rendererPath}`)
      const errorHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>LLM Proxy - Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0a0a0f;
      color: #f0f0f5;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .error {
      text-align: center;
      padding: 40px;
    }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: #a0a0b0; }
    code { background: #1a1a24; padding: 4px 8px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="error">
    <h1>Renderer Not Found</h1>
    <p>Could not load the UI from:</p>
    <p><code>${rendererPath}</code></p>
    <p>Please ensure the renderer files exist.</p>
  </div>
</body>
</html>`
      await controlWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`)
    }
  }

  controlWindow.on('closed', () => {
    controlWindow = null
    // Close all target windows when control window closes
    closeAllTargetWindows()
  })
}

// Create target browser window for a specific site
async function createTargetWindow(siteId: string, url: string, hidden = false): Promise<BrowserWindow> {
  // If window for this site already exists, focus it (don't reload)
  const existingWindow = targetWindows.get(siteId)
  if (existingWindow && !existingWindow.isDestroyed()) {
    if (!hidden) {
      existingWindow.show()
      existingWindow.focus()
    }
    // Don't reload the page - just focus the existing window
    return existingWindow
  }

  // Use a unique session partition for each target window to ensure clean network state
  // This prevents connection reuse from other windows and ensures proxy is properly applied
  const sessionPartition = `persist:target-${siteId}-${Date.now()}`

  const newWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Target: ${siteId}`,
    show: !hidden,
    backgroundColor: '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition: sessionPartition
    }
  })

  // Set a standard Chrome user agent to avoid detection
  newWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  // Configure proxy and certificate trust for this window's isolated session
  if (shouldUseProxy() && proxyServer && certManager) {
    try {
      const windowSession = newWindow.webContents.session

      // Set proxy for this isolated session
      await windowSession.setProxy({
        proxyRules: `${PROXY_HOST}:${PROXY_PORT}`
      })

      // Verify proxy is configured by resolving it
      const proxyConfig = await windowSession.resolveProxy('https://test.com')
      log.info(`[Proxy] Configured proxy for site: ${siteId}, partition: ${sessionPartition}, resolved: ${proxyConfig}`)

      // CRITICAL: Trust our CA certificate within Electron
      // This replaces system-level CA installation
      windowSession.setCertificateVerifyProc((request, callback) => {
        // Trust certificates signed by our CA
        // The certificate chain includes our CA as the issuer
        const { certificate, verificationResult, errorCode } = request

        // If the certificate is from our proxy (signed by our CA), trust it
        if (certManager && certificate.issuerName.includes('ProxyLLM CA')) {
          log.debug(`[Proxy] Trusting certificate for: ${request.hostname} (issued by our CA)`)
          callback(0) // 0 = Trust the certificate
          return
        }

        // For other certificates, use default verification
        // -3 means use Chromium's default verification
        if (verificationResult === 'net::OK' || errorCode === 0) {
          callback(0) // Certificate is valid
        } else {
          callback(-2) // Use default verification result
        }
      })
      log.info(`[Proxy] Certificate trust configured for site: ${siteId}`)
    } catch (err) {
      log.warn(`[Proxy] Failed to configure proxy for site ${siteId}:`, err)
    }
  }

  // Register webRequest handler for this isolated session to capture credentials
  if (protocolHandler) {
    protocolHandler.registerForSession(newWindow.webContents.session)
    log.info(`[Proxy] WebRequest handler registered for session: ${sessionPartition}`)
  }

  // Store window reference
  targetWindows.set(siteId, newWindow)

  // Enable CDP debugger for WebSocket capture (keep for WebSocket support)
  try {
    newWindow.webContents.debugger.attach('1.3')
    log.info(`[CDP] Debugger attached for site: ${siteId}`)

    // Listen for WebSocket events BEFORE enabling network
    newWindow.webContents.debugger.on('message', (_event, method, params) => {
      handleCDPMessage(siteId, method, params, newWindow.webContents.debugger)
    })

    // Enable network monitoring after page starts loading
    newWindow.webContents.once('did-start-loading', async () => {
      try {
        await newWindow.webContents.debugger.sendCommand('Network.enable')
        log.info(`[CDP] Network.enable sent for site: ${siteId}`)
      } catch (err) {
        log.warn(`[CDP] Failed to enable network for site ${siteId}:`, err)
      }
    })
  } catch (err) {
    log.warn(`[CDP] Failed to attach debugger for site ${siteId}:`, err)
  }

  // NOTE: Disabled console-message listener as it may cause flickering
  // due to frequent IPC communication and file writes
  // Uncomment for debugging if needed:
  // newWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
  //   const levelMap: Record<number, string> = {
  //     0: 'debug',
  //     1: 'info',
  //     2: 'warning',
  //     3: 'error'
  //   }
  //   const levelStr = levelMap[level] || 'info'
  //   const source = sourceId ? `${sourceId}:${line}` : 'unknown'
  //   logRendererMessage(levelStr, `[${siteId}][${source}] ${message}`)
  // })

  log.info(`Loading target URL for site ${siteId}:`, url)
  await newWindow.loadURL(url)
  log.info(`Target URL loaded for site ${siteId}`)

  // For hidden windows (refresh), auto-close after a delay to capture credentials
  if (hidden) {
    setTimeout(() => {
      if (!newWindow.isDestroyed()) {
        log.info(`Auto-closing hidden window for site: ${siteId}`)
        newWindow.close()
      }
    }, 5000) // Wait 5 seconds for credentials to be captured
  }

  newWindow.on('closed', () => {
    log.info(`Target window closed for site: ${siteId}`)
    targetWindows.delete(siteId)
    // Notify control window that site window was closed
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('site-window-closed', siteId)
    }
  })

  return newWindow
}

// Handle CDP messages for WebSocket capture, HTTP request body capture, and response capture
// Track SSE streams: Map<requestId, { siteId, url }>
const activeSSEStreams: Map<string, { siteId: string; url: string }> = new Map()
// Track pending responses: Map<requestId, { siteId, url, status, statusText, headers, mimeType }>
const pendingResponses: Map<string, {
  siteId: string
  url: string
  status: number
  statusText: string
  headers: Record<string, string>
  mimeType: string | null
}> = new Map()

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleCDPMessage(siteId: string, method: string, params: any, debuggerInstance?: Electron.Debugger): void {
  switch (method) {
    case 'Network.requestWillBeSent':
      // Capture HTTP request body (postData)
      if (params.request?.postData && params.request?.url) {
        const url = params.request.url
        // Only capture POST requests to API endpoints
        if (params.request.method === 'POST' && (url.includes('/api/') || url.includes('/chat') || url.includes('/agent') || url.includes('/sv5/'))) {
          log.debug(`[CDP] Captured POST body for ${url}: ${params.request.postData.substring(0, 200)}...`)
          requestStore.updateRequestBody(siteId, url, params.request.postData)

          // Try to capture sessionId from request body
          processRequestCapture(siteId, url, params.request.postData)
        }
      }
      break

    case 'Network.responseReceived':
      // Store response metadata for later body retrieval
      if (params.response) {
        const url = params.response.url
        const contentType = params.response.headers?.['content-type'] || params.response.headers?.['Content-Type'] || ''

        // Track SSE streams
        if (contentType.includes('text/event-stream')) {
          log.info(`[CDP] SSE stream detected for site "${siteId}": ${url}`)
          requestStore.startSSEStream(siteId, params.requestId, url)
          activeSSEStreams.set(params.requestId, { siteId, url })
        }

        // Store response metadata for all API responses
        if (url.includes('/api/') || url.includes('/chat') || url.includes('/agent') || url.includes('/sv5/') || url.includes('/llm/')) {
          pendingResponses.set(params.requestId, {
            siteId,
            url,
            status: params.response.status,
            statusText: params.response.statusText || '',
            headers: params.response.headers || {},
            mimeType: params.response.mimeType || null
          })
          log.debug(`[CDP] Response received for ${url}: ${params.response.status}`)
        }
      }
      break

    case 'Network.dataReceived':
      // Track data received for SSE streams
      if (activeSSEStreams.has(params.requestId)) {
        log.debug(`[CDP] SSE data received for ${params.requestId}: ${params.dataLength} bytes`)
      }
      break

    case 'Network.loadingFinished':
      // SSE stream ended
      if (activeSSEStreams.has(params.requestId)) {
        const streamInfo = activeSSEStreams.get(params.requestId)!
        log.info(`[CDP] SSE stream ended for site "${streamInfo.siteId}": ${streamInfo.url}`)
        requestStore.endSSEStream(streamInfo.siteId, params.requestId)
        activeSSEStreams.delete(params.requestId)
      }

      // Try to get response body for API requests
      if (pendingResponses.has(params.requestId) && debuggerInstance) {
        const responseInfo = pendingResponses.get(params.requestId)!
        pendingResponses.delete(params.requestId)

        // Async fetch response body
        debuggerInstance.sendCommand('Network.getResponseBody', { requestId: params.requestId })
          .then((result: { body: string; base64Encoded: boolean }) => {
            let body = result.body
            if (result.base64Encoded) {
              body = Buffer.from(result.body, 'base64').toString('utf-8')
            }

            requestStore.updateRequestResponse(responseInfo.siteId, responseInfo.url, {
              status: responseInfo.status,
              statusText: responseInfo.statusText,
              headers: responseInfo.headers,
              body,
              mimeType: responseInfo.mimeType
            })
            log.info(`[CDP] Response body captured for ${responseInfo.url}: ${body.length} chars`)

            // Try to capture sessionId and models from response body
            processResponseCapture(responseInfo.siteId, responseInfo.url, body)
          })
          .catch((err: Error) => {
            // Some responses (like SSE streams) may not have a body available
            log.debug(`[CDP] Could not get response body for ${responseInfo.url}: ${err.message}`)

            // Still save response metadata without body
            requestStore.updateRequestResponse(responseInfo.siteId, responseInfo.url, {
              status: responseInfo.status,
              statusText: responseInfo.statusText,
              headers: responseInfo.headers,
              body: null,
              mimeType: responseInfo.mimeType
            })
          })
      }
      break

    case 'Network.loadingFailed':
      // SSE stream failed
      if (activeSSEStreams.has(params.requestId)) {
        const streamInfo = activeSSEStreams.get(params.requestId)!
        log.warn(`[CDP] SSE stream failed for site "${streamInfo.siteId}": ${streamInfo.url} - ${params.errorText}`)
        requestStore.endSSEStream(streamInfo.siteId, params.requestId, true)
        activeSSEStreams.delete(params.requestId)
      }
      // Clean up pending response
      pendingResponses.delete(params.requestId)
      break

    case 'Network.webSocketCreated':
      log.info(`[CDP] WebSocket created for site "${siteId}": ${params.url}`)
      requestStore.addWebSocketConnection(siteId, params.url)
      break

    case 'Network.webSocketFrameSent':
      if (params.response?.payloadData) {
        requestStore.addWebSocketMessage(
          siteId,
          params.url || 'unknown',
          'sent',
          params.response.payloadData,
          params.response.opcode || 1
        )
      }
      break

    case 'Network.webSocketFrameReceived':
      if (params.response?.payloadData) {
        requestStore.addWebSocketMessage(
          siteId,
          params.url || 'unknown',
          'received',
          params.response.payloadData,
          params.response.opcode || 1
        )
      }
      break

    case 'Network.webSocketClosed':
      log.info(`[CDP] WebSocket closed for site "${siteId}": ${params.url || 'unknown'}`)
      break
  }
}

// Close target window for a specific site
function closeTargetWindow(siteId: string): boolean {
  const window = targetWindows.get(siteId)
  if (window && !window.isDestroyed()) {
    window.close()
    return true
  }
  return false
}

// Close all target windows
function closeAllTargetWindows(): void {
  for (const [siteId, window] of targetWindows) {
    if (!window.isDestroyed()) {
      window.close()
    }
    targetWindows.delete(siteId)
  }
}

// Get open window status
function getOpenWindows(): string[] {
  const openSites: string[] = []
  for (const [siteId, window] of targetWindows) {
    if (!window.isDestroyed()) {
      openSites.push(siteId)
    }
  }
  return openSites
}

// Build application menu with proxy settings
function buildAppMenu(): Menu {
  const proxyStatus = getProxyStatus()

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Proxy',
      submenu: [
        {
          label: 'Enable Proxy Capture',
          type: 'checkbox',
          checked: proxyStatus.enabled,
          click: () => {
            toggleProxy()
            updateProxyMenu()
            // Notify renderer
            if (controlWindow && !controlWindow.isDestroyed()) {
              controlWindow.webContents.send('proxy-status-changed', getProxyStatus())
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Show CA Certificate',
          click: () => {
            revealCACert()
          },
          enabled: proxyStatus.caExists
        },
        { type: 'separator' },
        {
          label: `Status: ${proxyStatus.enabled ? 'Active' : 'Disabled'}`,
          enabled: false
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

// Update proxy menu (called when status changes)
function updateProxyMenu(): void {
  const menu = buildAppMenu()
  Menu.setApplicationMenu(menu)
}

// Setup IPC handlers
function setupIPC(): void {
  // Legacy: open-target without siteId (for backward compatibility)
  ipcMain.handle('open-target', async (_event, urlOrSiteId: string, url?: string) => {
    // Support both: openTarget(url) and openTarget(siteId, url)
    if (url) {
      // New format: openTarget(siteId, url)
      log.info(`Opening target for site ${urlOrSiteId}:`, url)
      await createTargetWindow(urlOrSiteId, url)
      return { success: true }
    }
    // Legacy format: openTarget(url) - try to find site by URL
    const site = siteStore.findByUrl(urlOrSiteId) || siteStore.getEnabled()[0]
    const siteId = site?.id || 'default'
    log.info(`Opening target URL (legacy):`, urlOrSiteId)
    await createTargetWindow(siteId, urlOrSiteId)
    return { success: true }
  })

  // New: open-site - open window for a specific site
  ipcMain.handle('open-site', async (_event, siteId: string) => {
    const site = siteStore.getById(siteId)
    if (!site) {
      return { success: false, error: 'Site not found' }
    }
    log.info(`Opening site: ${siteId}`)
    await createTargetWindow(siteId, site.targetUrl)
    return { success: true }
  })

  // New: close-site - close window for a specific site
  ipcMain.handle('close-site', (_event, siteId: string) => {
    const closed = closeTargetWindow(siteId)
    return { success: closed }
  })

  // New: get-open-windows - get list of open site windows
  ipcMain.handle('get-open-windows', () => {
    return getOpenWindows()
  })

  ipcMain.handle('get-credentials', (_event, siteId?: string) => {
    // If siteId provided, return credentials for that site
    // Otherwise return credentials for the first enabled site (backward compatibility)
    const targetSiteId = siteId || siteStore.getEnabled()[0]?.id
    const creds = credentialStore.getCredentials(targetSiteId)
    return {
      siteId: targetSiteId,
      hasCredentials: credentialStore.hasValidCredential(targetSiteId),
      sessionId: creds.sessionId
    }
  })

  ipcMain.handle('get-sites', () => {
    return siteStore.getEnabled().map(site => ({
      id: site.id,
      name: site.name,
      targetUrl: site.targetUrl,
      hasCredentials: credentialStore.hasValidCredential(site.id)
    }))
  })

  ipcMain.handle('get-all-sites', async () => {
    const openWindows = getOpenWindows()

    // Refresh dynamic models for sites with valid (non-expired) credentials
    for (const site of siteStore.getAll()) {
      if (!credentialStore.hasValidCredential(site.id)) continue

      // Get adapter and check if it supports dynamic models
      const adapter = adapterRegistry.getForSite(site)
      if (!adapter?.capabilities?.dynamicModels || !adapter.fetchDynamicModels) continue

      const credentials = credentialStore.getCredentials(site.id)

      // Skip if token is expired - don't make API calls with expired tokens
      if (isTokenExpired(credentials.authorization)) {
        log.debug(`[get-all-sites] Skipping model fetch for ${site.id} - token expired`)
        continue
      }

      const models = await adapter.fetchDynamicModels(credentials)
      if (models.length > 0) {
        modelStore.setModels(site.id, models)
      }
    }

    return siteStore.getAll().map(site => {
      const creds = credentialStore.getCredentials(site.id)
      const siteModels = modelStore.getModels(site.id)

      // Determine token status
      let tokenStatus: 'valid' | 'expired' | 'refreshing' | 'none' = 'none'
      if (creds.authorization) {
        if (isRefreshInProgress(site.id)) {
          tokenStatus = 'refreshing'
        } else if (isTokenExpired(creds.authorization)) {
          tokenStatus = 'expired'
        } else {
          tokenStatus = 'valid'
        }
      }

      // Get last request status for this site
      const lastRequestStatus = usageStore.getSiteLastStatus(site.id)

      return {
        id: site.id,
        name: site.name,
        targetUrl: site.targetUrl,
        enabled: site.enabled,
        hasCredentials: credentialStore.hasValidCredential(site.id),
        sessionId: creds.sessionId,
        capturedAt: creds.capturedAt,
        isWindowOpen: openWindows.includes(site.id),
        tokenStatus,
        // New: dynamic models for this site
        models: siteModels.map(m => ({
          modelName: m.modelName,
          modelId: m.modelId,
          displayName: m.displayName
        })),
        // Last request status
        lastRequestStatus: lastRequestStatus || undefined
      }
    })
  })

  ipcMain.handle('get-all-credentials', () => {
    const result: Record<string, unknown>[] = []
    for (const site of siteStore.getEnabled()) {
      const creds = credentialStore.getCredentials(site.id)
      result.push({
        siteId: site.id,
        siteName: site.name,
        hasCredentials: credentialStore.hasValidCredential(site.id),
        sessionId: creds.sessionId,
        capturedAt: creds.capturedAt
      })
    }
    return result
  })

  ipcMain.handle('refresh-credentials', async (_event, siteId: string) => {
    const site = siteStore.getById(siteId)
    if (!site) {
      return { success: false, error: 'Site not found' }
    }
    log.info(`Refreshing credentials for site: ${siteId}`)
    await createTargetWindow(siteId, site.targetUrl, true)
    return { success: true }
  })

  ipcMain.handle('add-site', (_event, site: SiteConfig) => {
    // Auto-detect specialized adapter based on URL
    if (site.adapterType === 'generic' || !site.adapterType) {
      const matchedAdapter = adapterRegistry.getByUrl(site.targetUrl)
      if (matchedAdapter && matchedAdapter.name !== 'template' && matchedAdapter.name !== 'generic') {
        log.info(`Auto-detected adapter "${matchedAdapter.name}" for site "${site.id}" based on URL "${site.targetUrl}"`)
        site.adapterType = matchedAdapter.name
      }
    }

    // Merge default capture rules from adapter if available
    const adapter = adapterRegistry.getByName(site.adapterType)
    if (adapter) {
      // Merge capture rules: adapter defaults first, then user-provided rules
      if (adapter.getDefaultCaptureRules) {
        const defaultRules = adapter.getDefaultCaptureRules()
        const userRules = site.captureRules || []
        // Only use adapter defaults if user didn't provide specific rules
        // (user rules with specific urlPatterns override defaults)
        const hasSpecificUserRules = userRules.some(r => r.urlPattern !== '*')
        if (!hasSpecificUserRules && defaultRules.length > 0) {
          site.captureRules = defaultRules
          log.info(`Applied ${defaultRules.length} default capture rules from adapter "${adapter.name}" for site "${site.id}"`)
        }
      }

      // Set default model capture config if not provided
      if (!site.modelCaptureConfig && adapter.getDefaultModelCaptureConfig) {
        const defaultModelConfig = adapter.getDefaultModelCaptureConfig()
        if (defaultModelConfig) {
          site.modelCaptureConfig = defaultModelConfig
          log.info(`Applied default model capture config from adapter "${adapter.name}" for site "${site.id}"`)
        }
      }
    }

    siteStore.add(site)
    return { success: true }
  })

  ipcMain.handle('update-site', (_event, id: string, updates: Partial<SiteConfig>) => {
    siteStore.update(id, updates)
    return { success: true }
  })

  ipcMain.handle('remove-site', (_event, id: string) => {
    siteStore.remove(id)
    credentialStore.clearCredential(id)
    modelStore.clearModels(id)
    requestStore.clearRequests(id)
    requestStore.clearWebSockets(id)
    requestStore.clearSSEStreams(id)
    usageStore.clearSiteErrorStatus(id)
    return { success: true }
  })

  ipcMain.handle('clear-credentials', (_event, siteId: string) => {
    credentialStore.clearCredential(siteId)
    return { success: true }
  })

  ipcMain.handle('clear-site-error-status', (_event, siteId: string) => {
    usageStore.clearSiteErrorStatus(siteId)
    return { success: true }
  })

  // Request capture handlers
  ipcMain.handle('get-requests', (_event, siteId: string) => {
    return requestStore.getRequestSummary(siteId)
  })

  ipcMain.handle('get-request-detail', (_event, siteId: string, requestId: string) => {
    return requestStore.getRequestById(siteId, requestId)
  })

  ipcMain.handle('clear-requests', (_event, siteId: string) => {
    requestStore.clearRequests(siteId)
    return { success: true }
  })

  ipcMain.handle('select-request-as-credential', (_event, siteId: string, requestId: string) => {
    const request = requestStore.getRequestById(siteId, requestId)
    if (!request) {
      log.warn(`select-request-as-credential: Request not found - siteId=${siteId}, requestId=${requestId}`)
      return { success: false, error: 'Request not found' }
    }

    log.info(`select-request-as-credential: Processing request for site "${siteId}"`)
    log.info(`  URL: ${request.url}`)
    log.info(`  Headers: ${JSON.stringify(request.headers)}`)
    log.info(`  Body: ${request.body ? `${request.body.substring(0, 200)}...` : '(none)'}`)

    // Get site config and adapter for site-specific logic
    const site = siteStore.getById(siteId)
    const adapter = site ? adapterRegistry.getForSite(site) : undefined

    // Extract credentials from the selected request
    // Try common auth headers (case-insensitive)
    const authHeaders = ['authorization', 'x-auth-token', 'x-api-key', 'api-key', 'token']
    const headerKeys = Object.keys(request.headers)

    for (const authHeader of authHeaders) {
      const matchedKey = headerKeys.find(k => k.toLowerCase() === authHeader)
      if (matchedKey) {
        const value = request.headers[matchedKey]
        if (value) {
          // Parse JWT expiration time if present
          const expiresAt = parseJwtExpiration(value)
          if (expiresAt) {
            log.info(`Parsed JWT expiration for site "${siteId}": ${new Date(expiresAt).toISOString()}`)
          }

          // Check if token is already expired or expiring soon (within 30 seconds)
          if (expiresAt && expiresAt < Date.now() + 30000) {
            log.warn(`Token expired or expiring soon for site "${siteId}"`)
            return {
              success: false,
              error: 'token_expired',
              message: 'Token 已过期，请在页面执行一次操作后重新选择最新的请求'
            }
          }

          // Extract sessionId using adapter-specific logic if available
          let sessionId: string | null = null
          if (adapter && !isWebSocketAdapter(adapter) && adapter.extractSessionId) {
            sessionId = adapter.extractSessionId(request)
          } else {
            sessionId = request.body || null
          }

          credentialStore.setCredential(siteId, {
            authorization: value,
            sessionId,
            requestHeaders: request.headers,
            expiresAt
          })

          // Register models: use adapter's static models if available, otherwise dynamic
          const staticModels = adapter && !isWebSocketAdapter(adapter) ? adapter.getStaticModels?.() : null
          if (staticModels) {
            modelStore.setModels(siteId, staticModels)
            log.info(`Registered static models for ${siteId}`)
          } else {
            // Register dynamic models for other sites
            registerDynamicModels(siteId, request.body)
          }

          log.info(`Captured auth from selected request for site "${siteId}": ${matchedKey}`)
          return { success: true, authHeader: matchedKey, hasBody: !!request.body }
        }
      }
    }

    log.info(`No standard auth header found, storing full request info with headers`)

    // If no auth header found, store the full request info for custom handling
    // This site might use cookies or other auth mechanisms
    credentialStore.setCredential(siteId, {
      authorization: `REQUEST:${request.url}`,
      sessionId: request.body || null,
      requestHeaders: request.headers
    })

    // Register dynamic models for sites without auth headers (cookie-based auth)
    registerDynamicModels(siteId, request.body)

    log.info(`Stored request URL, body and headers for site "${siteId}"`)
    return { success: true, note: 'Stored request info with headers (no standard auth header found). Cookie auth will be used.' }
  })

  // WebSocket capture handlers
  ipcMain.handle('get-websockets', (_event, siteId: string) => {
    return requestStore.getWebSocketSummary(siteId)
  })

  ipcMain.handle('get-websocket-messages', (_event, siteId: string, url: string) => {
    return requestStore.getWebSocketMessages(siteId, url)
  })

  ipcMain.handle('clear-websockets', (_event, siteId: string) => {
    requestStore.clearWebSockets(siteId)
    return { success: true }
  })

  // Claude Code takeover handlers
  ipcMain.handle('claude-takeover-status', () => {
    return getTakeoverStatus()
  })

  ipcMain.handle('claude-takeover', (_event, proxyUrl?: string) => {
    // Default to current API server URL
    const url = proxyUrl || `http://${config.apiServerHost || '127.0.0.1'}:${config.apiServerPort || 8080}`
    const success = takeoverClaude(url)
    return { success, proxyUrl: url }
  })

  ipcMain.handle('claude-restore', () => {
    const success = restoreClaude()
    return { success }
  })

  ipcMain.handle('claude-force-cleanup', () => {
    const success = forceCleanup()
    return { success }
  })

  ipcMain.handle('claude-is-installed', () => {
    return isClaudeInstalled()
  })

  // Claude API test
  ipcMain.handle('claude-test-api', async (_event, model: string) => {
    const proxyUrl = `http://${config.apiServerHost || '127.0.0.1'}:${config.apiServerPort || 8080}`
    return testClaudeApi(proxyUrl, { model })
  })

  // Claude connect target management
  ipcMain.handle('claude-get-selected-target', () => {
    return claudeConnectStore.getSelectedTarget()
  })

  ipcMain.handle('claude-set-selected-target', (_event, target: ConnectTarget | null) => {
    claudeConnectStore.setSelectedTarget(target)
  })

  // OAuth handlers
  ipcMain.handle('oauth-get-providers', () => {
    return oauthProviderRegistry.getAll().map(p => ({
      name: p.name,
      displayName: p.displayName,
      flowType: p.flowType
    }))
  })

  ipcMain.handle('oauth-start-auth', async (_event, provider: OAuthProviderType) => {
    const oauthProvider = oauthProviderRegistry.get(provider)
    if (!oauthProvider) {
      throw new Error(`Unknown OAuth provider: ${provider}`)
    }

    log.info(`[OAuth] Starting auth for provider: ${provider}`)
    const result = await oauthProvider.startAuth()

    // Register session
    oauthSessionStore.register(result.state, provider, {
      codeVerifier: result.codeVerifier,
      deviceCode: result.deviceCode,
      userCode: result.userCode,
      pollInterval: result.pollInterval
    })

    return {
      authUrl: result.authUrl,
      state: result.state,
      flowType: oauthProvider.flowType,
      userCode: result.userCode,
      pollInterval: result.pollInterval,
      expiresIn: result.expiresIn
    }
  })

  ipcMain.handle('oauth-get-status', (_event, state: string) => {
    const session = oauthSessionStore.get(state)
    if (!session) {
      return { status: 'not_found' }
    }

    const cred = credentialStore.getCredential(`oauth:${session.provider}`)
    const oauthData = credentialStore.getOAuthData(`oauth:${session.provider}`)

    return {
      status: session.status,
      provider: session.provider,
      error: session.error,
      email: oauthData?.email
    }
  })

  ipcMain.handle('oauth-poll', async (_event, state: string) => {
    const session = oauthSessionStore.get(state)
    if (!session) {
      return { status: 'not_found' }
    }

    const provider = oauthProviderRegistry.get(session.provider)
    if (!provider) {
      return { status: 'error', error: 'Provider not found' }
    }

    // For device flow, poll for token
    if (session.deviceCode) {
      try {
        if (!provider.pollForToken) {
          return { status: 'error', error: 'Provider does not support device flow polling' }
        }
        const token = await provider.pollForToken(session.deviceCode, session.codeVerifier)
        if (token) {
          // Extract email from id_token
          const email = extractEmailFromIdToken(token.idToken)

          // Save token
          credentialStore.setOAuthCredential(
            `oauth:${session.provider}`,
            token,
            session.provider,
            { email: email || undefined }
          )
          oauthSessionStore.complete(state)

          return {
            status: 'completed',
            provider: session.provider,
            email
          }
        }
        // Still polling
        return { status: 'polling', provider: session.provider }
      } catch (err) {
        const error = err as Error
        if (error.message === 'slow_down') {
          return { status: 'slow_down', provider: session.provider }
        }
        if (error.message === 'authorization_pending') {
          return { status: 'polling', provider: session.provider }
        }
        oauthSessionStore.setError(state, error.message)
        return { status: 'error', provider: session.provider, error: error.message }
      }
    }

    // For authorization code flow, check if completed
    const oauthData = credentialStore.getOAuthData(`oauth:${session.provider}`)
    if (session.status === 'completed' || oauthData) {
      return {
        status: 'completed',
        provider: session.provider,
        email: oauthData?.email
      }
    }

    return {
      status: session.status,
      provider: session.provider,
      error: session.error
    }
  })

  ipcMain.handle('oauth-get-credentials', () => {
    const providers = oauthProviderRegistry.getAll()
    return providers.map(p => {
      const siteId = `oauth:${p.name}`
      const cred = credentialStore.getCredential(siteId)
      const oauthData = credentialStore.getOAuthData(siteId)

      return {
        provider: p.name,
        email: oauthData?.email,
        expiresAt: cred?.expiresAt,
        hasCredential: credentialStore.hasValidCredential(siteId)
      }
    })
  })

  ipcMain.handle('oauth-logout', (_event, provider: OAuthProviderType) => {
    const siteId = `oauth:${provider}`
    credentialStore.clearCredential(siteId)
    log.info(`[OAuth] Logged out from provider: ${provider}`)
    return { success: true }
  })

  // Get authorized OAuth tools with their models
  ipcMain.handle('get-authorized-tools', () => {
    const tools: Array<{
      provider: OAuthProviderType
      displayName: string
      email: string | undefined
      expiresAt: number | null
      enabled: boolean
      models: Array<{ id: string; name: string; description?: string }>
    }> = []

    for (const providerConfig of OAUTH_PROVIDER_MODELS) {
      const siteId = `oauth:${providerConfig.provider}`
      if (credentialStore.hasValidCredential(siteId)) {
        const oauthData = credentialStore.getOAuthData(siteId)
        const cred = credentialStore.getCredential(siteId)

        tools.push({
          provider: providerConfig.provider,
          displayName: providerConfig.displayName,
          email: oauthData?.email,
          expiresAt: cred?.expiresAt || null,
          enabled: toolSettingsStore.isEnabled(providerConfig.provider),
          models: providerConfig.models.map(m => ({
            id: m.id,
            name: m.name,
            description: m.description
          }))
        })
      }
    }

    return tools
  })

  // Toggle tool enabled state
  ipcMain.handle('toggle-tool-enabled', (_event, provider: OAuthProviderType) => {
    const newState = toolSettingsStore.toggleEnabled(provider)
    log.info(`[Tool] Toggled ${provider} enabled state to: ${newState}`)
    return { success: true, enabled: newState }
  })

  // Open URL in system default browser
  ipcMain.handle('open-external', async (_event, url: string) => {
    log.info(`[OpenExternal] Opening URL in system browser: ${url}`)
    await shell.openExternal(url)
  })

  // Proxy settings handlers
  ipcMain.handle('proxy-get-status', () => {
    return getProxyStatus()
  })

  ipcMain.handle('proxy-reveal-ca', () => {
    log.info('[Proxy] Revealing CA certificate in Finder...')
    revealCACert()
    return { success: true }
  })

  ipcMain.handle('proxy-toggle', () => {
    const enabled = toggleProxy()
    // Update menu
    updateProxyMenu()
    return { success: true, enabled }
  })
}

async function initialize(): Promise<void> {
  log.info('Initializing application...')
  config = loadConfig()

  // Register adapters
  registerAdapters()
  log.info('Adapters registered')

  // Migrate existing sites: apply default capture rules from adapters
  migrateSiteConfigs()

  // Register OAuth providers
  registerOAuthProviders()
  log.info('OAuth providers registered')

  // Prune orphaned models (models belonging to sites that no longer exist)
  const prunedCount = modelStore.pruneOrphanedModels()
  if (prunedCount > 0) {
    log.info(`Pruned models for ${prunedCount} orphaned sites`)
  }

  // Always initialize proxy server (it will only be used if enabled in settings)
  try {
    initializeProxyServer()
  } catch (err) {
    log.error('[Proxy] Failed to start proxy server:', err)
    // Continue without proxy - fall back to CDP capture
  }

  // Log proxy status
  const proxyStatus = getProxyStatus()
  log.info(`[Proxy] Status: enabled=${proxyStatus.enabled}, caExists=${proxyStatus.caExists}`)

  // Initialize protocol handler (no longer needs config, uses siteStore)
  protocolHandler = new ProtocolHandler()
  log.info('Protocol handler initialized')

  // Initialize API server with full config
  apiServer = new APIServer(config)
  log.info('API server initialized')

  // Set up config file watcher for hot reload
  configWatcher = new ConfigWatcher(500)
  configWatcher.watch(configPath, reloadConfig)
  log.info('Config watcher initialized')

  // Set up token refresh callback
  setTokenRefreshCallback(async (siteId: string) => {
    const site = siteStore.getById(siteId)
    if (!site) {
      throw new Error(`Site not found: ${siteId}`)
    }

    // Determine the URL to load for token refresh
    let refreshUrl = site.targetUrl

    // Use adapter-specific refresh URL if available
    const adapter = adapterRegistry.getForSite(site)
    if (adapter && !isWebSocketAdapter(adapter) && adapter.getRefreshUrl) {
      const credentials = credentialStore.getCredentials(siteId)
      const adapterRefreshUrl = adapter.getRefreshUrl(site.targetUrl, credentials)
      if (adapterRefreshUrl) {
        refreshUrl = adapterRefreshUrl
      }
    }

    log.info(`[TokenRefresh] Refreshing token for site: ${siteId}`)
    // Create a hidden window to reload the page and capture new token
    await createTargetWindow(siteId, refreshUrl, true)
  })
  log.info('Token refresh callback configured')

  // Setup IPC
  setupIPC()

  // Setup application menu
  const menu = buildAppMenu()
  Menu.setApplicationMenu(menu)
  log.info('Application menu configured')
}

app.whenReady().then(async () => {
  log.info('App ready')
  await initialize()

  // Register protocol handler
  protocolHandler?.register()

  // Start API server
  await apiServer?.start()

  // Create control window
  await createControlWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      log.info('Activating app, creating new window')
      await createControlWindow()
    }
  })
})

app.on('window-all-closed', () => {
  log.info('All windows closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', async () => {
  log.info('App will quit')
  configWatcher?.close()
  closeSiteLoggers()
  requestStore.saveNow() // Ensure pending requests are saved
  await proxyServer?.stop()
  await apiServer?.stop()
})

// Handle certificate errors - trust our CA certificates
app.on('certificate-error', (event, _webContents, url, error, certificate, callback) => {
  // Trust certificates signed by our proxy CA
  if (certManager && certificate.issuerName?.includes('ProxyLLM CA')) {
    log.debug(`[Proxy] Trusting certificate via app event for: ${url}`)
    event.preventDefault()
    callback(true)
    return
  }

  log.warn('Certificate error:', url, error)
  if (process.env.NODE_ENV === 'development') {
    event.preventDefault()
    callback(true)
  } else {
    callback(false)
  }
})

// Global exception handlers - catch all unhandled errors
process.on('uncaughtException', (error) => {
  // Ignore EPIPE errors during shutdown (broken pipe when parent process closes)
  if (error.message === 'write EPIPE') {
    return
  }
  try {
    log.error('Uncaught exception:', error.message, error.stack)
  } catch {
    // Ignore logging errors during shutdown
  }
})

process.on('unhandledRejection', (reason, promise) => {
  try {
    log.error('Unhandled rejection at:', String(promise), 'reason:', String(reason))
  } catch {
    // Ignore logging errors during shutdown
  }
})
