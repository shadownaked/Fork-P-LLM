import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import WebSocket from 'ws'
import type {
  OpenAIChatRequest,
  OpenAIModelsResponse,
  OpenAIErrorResponse,
  OpenAIModel,
  ModelInfo,
  WebSocketAdapter,
  SiteConfig,
  Credentials,
  Config,
  OAuthProviderType,
  Adapter
} from './types'
import { credentialStore, siteStore, modelStore, usageStore, toolSettingsStore } from './store'
import { adapterRegistry, getOAuthAdapter, isWebSocketAdapter } from './adapters'
import { getMainLogger, getSiteProxyLogger } from './logger'
import { isTokenExpired, requestTokenRefresh, refreshOAuthToken, canRefreshOAuth, isRefreshInProgress } from './token-refresh'
import { isClerkTokenExpired, ensureClerkToken, canRefreshClerkToken } from './clerk-token-refresh'
import { resolveRefreshPolicy, shouldRefreshCredentials, type RefreshReason } from './refresh-policy'
import { PROXY_TOKEN_PLACEHOLDER } from './claude-settings'
import {
  type AnthropicRequest,
  type AnthropicResponse,
  parseAnthropicSSE,
  transformAnthropicStreamToOpenAI
} from './adapters/anthropic'
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  transformOpenAIChunkToAnthropic,
  createStreamTransformState,
  type OpenAIResponse,
  type OpenAIRequest,
  type StreamTransformState
} from './adapters/transform'
import {
  oauthProviderRegistry,
  oauthSessionStore,
  registerOAuthProviders,
  extractEmailFromIdToken,
  findOAuthModelOwner,
  getModelsForProvider,
  getProviderDisplayName,
  OAUTH_PROVIDER_MODELS
} from './oauth'
import { detectModelType } from './utils/model-normalizer'

const log = getMainLogger()

// Server start time for uptime calculation
const serverStartTime = Date.now()

// Force IPv4 for all HTTPS requests to avoid IPv6 DNS issues
// Some domains have misconfigured IPv6 AAAA records pointing to wrong servers
const FORCE_IPV4 = 4

// Token refresh callback - will be set by main.ts
let tokenRefreshCallback: ((siteId: string) => Promise<void>) | null = null

/**
 * Set the callback function for token refresh
 * This allows api-server to trigger window reload without direct dependency on Electron
 */
export function setTokenRefreshCallback(callback: (siteId: string) => Promise<void>): void {
  tokenRefreshCallback = callback
}

/**
 * OpenAI-compatible API Server
 * Exposes /v1/chat/completions and /v1/models endpoints
 * Routes requests to appropriate adapters based on model/site
 *
 * Security features:
 * - Binds to localhost (127.0.0.1) by default
 * - Optional API key authentication for /v1/* endpoints
 * - Model aliasing for client compatibility
 */
export class APIServer {
  private server: http.Server | null = null
  private port: number
  private host: string
  private apiKeys: string[]
  private requireApiKey: boolean
  private modelAliases: Map<string, string>

  constructor(config: Partial<Config> = {}) {
    this.port = config.apiServerPort || 8080
    this.host = config.apiServerHost || '127.0.0.1'  // Default to localhost only
    this.apiKeys = config.apiKeys || []
    this.requireApiKey = config.requireApiKey || false
    this.modelAliases = new Map(Object.entries(config.modelAliases || {}))
  }

  /**
   * Update configuration at runtime (for hot reload)
   */
  updateConfig(config: Partial<Config>): void {
    if (config.apiKeys !== undefined) {
      this.apiKeys = config.apiKeys
    }
    if (config.requireApiKey !== undefined) {
      this.requireApiKey = config.requireApiKey
    }
    if (config.modelAliases !== undefined) {
      this.modelAliases = new Map(Object.entries(config.modelAliases))
    }
    log.info(`[API] Config updated: requireApiKey=${this.requireApiKey}, apiKeys=${this.apiKeys.length}, aliases=${this.modelAliases.size}`)
  }

  /**
   * Resolve model alias to actual model name
   */
  private resolveModelAlias(model: string): string {
    return this.modelAliases.get(model) || model
  }

  /**
   * Check if the request has a valid API key
   * Returns true if:
   * - API key authentication is not required
   * - No API keys are configured
   * - Request has a valid API key in Authorization header
   */
  private checkApiKey(req: http.IncomingMessage): boolean {
    // If API key is not required or no keys configured, allow all
    if (!this.requireApiKey || this.apiKeys.length === 0) {
      return true
    }

    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false
    }

    const key = authHeader.slice(7)  // Remove 'Bearer ' prefix
    return this.apiKeys.includes(key)
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Parse retry-after header from response
   * Returns delay in milliseconds, or null if not present
   */
  private parseRetryAfter(headers: http.IncomingHttpHeaders): number | null {
    const retryAfter = headers['retry-after']
    if (!retryAfter) return null

    // Could be a number (seconds) or a date string
    const seconds = parseInt(retryAfter as string, 10)
    if (!Number.isNaN(seconds)) {
      return seconds * 1000
    }

    // Try parsing as date
    const date = new Date(retryAfter as string)
    if (!Number.isNaN(date.getTime())) {
      return Math.max(0, date.getTime() - Date.now())
    }

    return null
  }

  /**
   * Check if error is retryable
   * Retryable: 429 (rate limit), 5xx (server errors), network errors
   * Not retryable: 4xx (client errors except 429)
   */
  private isRetryableError(statusCode: number | undefined): boolean {
    if (!statusCode) return true  // Network error
    if (statusCode === 429) return true  // Rate limit
    if (statusCode >= 500) return true  // Server error
    return false
  }

  start(): Promise<void> {
    // Register OAuth providers
    registerOAuthProviders()

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.listen(this.port, this.host, () => {
        log.info(`API Server listening on http://${this.host}:${this.port}`)
        if (this.requireApiKey) {
          log.info(`API key authentication is ENABLED (${this.apiKeys.length} keys configured)`)
        } else {
          log.info(`API key authentication is DISABLED`)
        }
        if (this.modelAliases.size > 0) {
          log.info(`Model aliases configured: ${Array.from(this.modelAliases.entries()).map(([k, v]) => `${k}->${v}`).join(', ')}`)
        }
        resolve()
      })

      this.server.on('error', reject)
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          log.info('API Server stopped')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${this.host}:${this.port}`)
    const path = url.pathname

    // API key authentication for /v1/* endpoints
    if (path.startsWith('/v1/') && !this.checkApiKey(req)) {
      this.sendError(res, 401, 'Invalid or missing API key', 'authentication_error', 'invalid_api_key')
      return
    }

    try {
      if (path === '/health' && req.method === 'GET') {
        this.handleHealth(res)
      } else if (path === '/status' && req.method === 'GET') {
        this.handleStatus(res)
      } else if (path === '/v1/chat/completions' && req.method === 'POST') {
        await this.handleChatCompletions(req, res)
      } else if (path === '/v1/messages' && req.method === 'POST') {
        // Anthropic native API endpoint (used by Claude Code)
        await this.handleAnthropicMessages(req, res)
      } else if (path === '/v1/models' && req.method === 'GET') {
        await this.handleModels(res)
      } else if (path === '/debug/credentials' && req.method === 'GET') {
        this.handleDebugCredentials(res, url)
      } else if (path === '/debug/sites' && req.method === 'GET') {
        this.handleDebugSites(res)
      } else if (path === '/debug/usage' && req.method === 'GET') {
        this.handleDebugUsage(res)
      // OAuth routes (no API key required)
      } else if (path === '/oauth/providers' && req.method === 'GET') {
        this.handleOAuthProviders(res)
      } else if (path === '/oauth/start' && req.method === 'POST') {
        await this.handleOAuthStart(req, res)
      } else if (path.startsWith('/oauth/callback/') && req.method === 'GET') {
        await this.handleOAuthCallback(req, res, path, url)
      } else if (path === '/oauth/status' && req.method === 'GET') {
        this.handleOAuthStatus(res, url)
      } else if (path === '/oauth/poll' && req.method === 'POST') {
        await this.handleOAuthPoll(req, res)
      } else {
        this.sendError(res, 404, 'Not Found', 'invalid_request_error', 'endpoint_not_found')
      }
    } catch (error) {
      log.error('Request handling error:', error)
      this.sendError(res, 500, 'Internal Server Error', 'server_error', 'internal_error')
    }
  }

  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Parse request body
    const body = await this.readBody(req)
    let openaiReq: OpenAIChatRequest

    try {
      openaiReq = JSON.parse(body)
    } catch {
      this.sendError(res, 400, 'Invalid JSON', 'invalid_request_error', 'invalid_json')
      return
    }

    // Resolve model alias first
    const requestedModel = this.resolveModelAlias(openaiReq.model)
    if (requestedModel !== openaiReq.model) {
      log.info(`[API] Model alias resolved: "${openaiReq.model}" -> "${requestedModel}"`)
    }

    // Try to find site by model name first (for sites with dynamic models)
    let site: SiteConfig | undefined
    let modelId: string | undefined

    const modelOwner = modelStore.findModelOwner(requestedModel)
    if (modelOwner) {
      site = siteStore.getById(modelOwner.siteId)
      modelId = modelOwner.modelInfo.modelId
      log.info(`[API] Model "${requestedModel}" -> site "${modelOwner.siteId}", modelId "${modelId}"`)
    } else {
      // Fallback: treat model name as site ID (legacy behavior)
      site = siteStore.getById(requestedModel)
    }

    // Check if site is enabled
    if (site && !site.enabled) {
      this.sendError(
        res,
        403,
        `Site "${site.id}" is disabled`,
        'forbidden',
        'site_disabled'
      )
      return
    }

    // Check if this is an OAuth model
    const oauthModelOwner = findOAuthModelOwner(requestedModel)
    if (oauthModelOwner && !site) {
      // Check if the OAuth tool is enabled
      if (!toolSettingsStore.isEnabled(oauthModelOwner.provider)) {
        this.sendError(
          res,
          403,
          `OAuth tool "${oauthModelOwner.provider}" is disabled`,
          'forbidden',
          'tool_disabled'
        )
        return
      }
      // Route to OAuth adapter
      await this.handleOAuthChatCompletions(openaiReq, oauthModelOwner.provider, requestedModel, res)
      return
    }

    if (!site) {
      // List available models
      const availableModels = modelStore.getAllModels().map(m => m.modelInfo.modelName)
      const availableSites = siteStore.getEnabled().map(s => s.id)
      const available = [...new Set([...availableModels, ...availableSites])].join(', ')

      this.sendError(
        res,
        404,
        `Model "${requestedModel}" not found. Available: ${available}`,
        'invalid_request_error',
        'model_not_found'
      )
      return
    }

    const siteId = site.id
    log.debug(`[API] Processing request for site: ${siteId}`)

    // Check credentials for the site
    if (!credentialStore.hasValidCredential(siteId)) {
      log.warn(`[API] No valid credentials for site: ${siteId}`)
      this.sendError(
        res,
        401,
        `No valid credentials for site "${siteId}". Please use the browser to interact with the target service first.`,
        'authentication_error',
        'no_credentials'
      )
      return
    }

    log.debug(`[API] Credentials valid for site: ${siteId}`)

    // Check if token is expired and try to refresh
    const credentials = credentialStore.getCredentials(siteId)
    const siteAdapter = adapterRegistry.getForSite(site)

    // For Clerk-based auth sites, use Clerk token refresh mechanism
    if (siteAdapter?.capabilities?.clerkAuth) {
      if (isClerkTokenExpired(siteId)) {
        if (canRefreshClerkToken(siteId)) {
          log.info(`[API] Clerk token expired for ${siteId}, attempting refresh...`)
          const refreshed = await ensureClerkToken(siteId)

          if (refreshed) {
            log.info(`[API] Clerk token refreshed successfully for ${siteId}`)
            // Re-fetch credentials after refresh
            const newCredentials = credentialStore.getCredentials(siteId)
            Object.assign(credentials, newCredentials)
          } else {
            log.warn(`[API] Clerk token refresh failed for ${siteId}`)
            this.sendError(
              res,
              401,
              `Token expired for ${site.name} and Clerk refresh failed. Please re-authenticate in the browser.`,
              'authentication_error',
              'token_expired'
            )
            return
          }
        } else {
          log.warn(`[API] Clerk token expired for ${siteId} but no Clerk session info available`)
          this.sendError(
            res,
            401,
            `Token expired for ${site.name}. Please visit the site in the browser to capture new credentials.`,
            'authentication_error',
            'token_expired'
          )
          return
        }
      }
    } else {
      // Standard token refresh for non-Clerk sites
      await this.maybeRefreshCredentials(site, credentials, 'proactive')
      log.debug(`[API] After maybeRefreshCredentials for site: ${siteId}`)

      if (isTokenExpired(credentials.authorization)) {
        log.info(`[API] Token expired for site "${siteId}", attempting refresh...`)

        if (tokenRefreshCallback) {
          const refreshed = await requestTokenRefresh(siteId, () => tokenRefreshCallback!(siteId))

          if (refreshed) {
            // Re-fetch credentials after refresh
            const newCredentials = credentialStore.getCredentials(siteId)
            if (!isTokenExpired(newCredentials.authorization)) {
              log.info(`[API] Token refreshed successfully for site "${siteId}"`)
              // Update credentials reference for later use
              Object.assign(credentials, newCredentials)
            } else {
              log.warn(`[API] Token still expired after refresh for site "${siteId}"`)
              this.sendError(
                res,
                401,
                `Token expired for site "${siteId}" and refresh failed. Please re-authenticate.`,
                'authentication_error',
                'token_expired'
              )
              return
            }
          } else {
            log.warn(`[API] Token refresh failed for site "${siteId}"`)
            this.sendError(
              res,
              401,
              `Token expired for site "${siteId}" and refresh failed. Please re-authenticate.`,
              'authentication_error'
            )
            return
          }
        } else {
          log.warn(`[API] Token expired but no refresh callback configured for site "${siteId}"`)
          this.sendError(
            res,
            401,
            `Token expired for site "${siteId}". Please re-authenticate.`,
            'authentication_error',
            'token_expired'
          )
          return
        }
      }
    }
    log.debug(`[API] Token check passed for site: ${siteId}`)

    // Get adapter for the site (check WebSocket adapters first)
    const wsAdapter = adapterRegistry.getWebSocketByName(site.adapterType)
    log.debug(`[API] WebSocket adapter for ${siteId}: ${wsAdapter ? 'found' : 'not found'}`)
    if (wsAdapter) {
      // Handle WebSocket-based adapter
      // Create a modified site config with modelId in adapterConfig
      const siteWithModel: SiteConfig = modelId ? {
        ...site,
        adapterConfig: { ...site.adapterConfig, modelId }
      } : site

      if (openaiReq.stream !== false) {
        await this.handleWebSocketStreamResponse(wsAdapter, openaiReq, credentials, siteWithModel, res, requestedModel)
        // Record usage after successful WebSocket stream
        usageStore.recordRequest(siteId, requestedModel, true)
      } else {
        await this.handleWebSocketNonStreamResponse(wsAdapter, openaiReq, credentials, siteWithModel, res, requestedModel)
        // Record usage after successful WebSocket non-stream
        usageStore.recordRequest(siteId, requestedModel, true)
      }
      return
    }

    // Fall back to HTTP adapter
    const adapter = adapterRegistry.getForSite(site)
    log.debug(`[API] HTTP adapter for ${siteId}: ${adapter ? adapter.name : 'not found'}`)
    if (!adapter) {
      this.sendError(
        res,
        500,
        `Adapter "${site.adapterType}" not found for site "${siteId}"`,
        'server_error',
        'adapter_not_found'
      )
      return
    }

    // At this point we expect HTTP adapter (WebSocket was handled above)
    if (isWebSocketAdapter(adapter)) {
      this.sendError(
        res,
        500,
        `Unexpected WebSocket adapter for site "${siteId}"`,
        'server_error',
        'invalid_adapter'
      )
      return
    }

    // Transform request
    const targetReq = adapter.transformRequest(openaiReq, credentials)
    log.info(`[API] Sending request to: ${targetReq.url}`)

    // Make request to target service
    if (openaiReq.stream !== false) {
      const result = await this.handleStreamResponse(targetReq, adapter, siteId, res, requestedModel)
      // Record usage with status code
      usageStore.recordRequest(siteId, requestedModel, result.success, result.statusCode)
    } else {
      const result = await this.handleNonStreamResponse(targetReq, adapter, siteId, res, requestedModel)
      // Record usage with status code
      usageStore.recordRequest(siteId, requestedModel, result.success, result.statusCode)
    }
  }

  private async handleStreamResponse(
    targetReq: { url: string; method: string; headers: Record<string, string>; body: string },
    adapter: { transformStreamChunk: (chunk: unknown) => { id: string; object: string; created: number; model: string; choices: Array<{ index: number; delta: { role?: string; content?: string }; finish_reason: string | null }> } | null },
    siteId: string,
    res: http.ServerResponse,
    modelName?: string
  ): Promise<{ success: boolean; statusCode?: number }> {
    const siteLog = getSiteProxyLogger(siteId)
    const url = new URL(targetReq.url)
    const timeoutMs = 25000

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: targetReq.method,
      headers: targetReq.headers,
      family: FORCE_IPV4
    }

    return new Promise((resolve) => {
      const proxyReq = https.request(options, (proxyRes) => {
        siteLog.info(`[Proxy] Response status: ${proxyRes.statusCode} ${proxyRes.statusMessage}`)
        siteLog.debug(`[Proxy] Response headers: ${JSON.stringify(proxyRes.headers)}`)

        const statusCode = proxyRes.statusCode || 500

        if (statusCode !== 200) {
          if (statusCode === 401 || statusCode === 403) {
            this.triggerRefreshOnFailure(siteId, `upstream-${statusCode}`)
          }
          this.sendError(
            res,
            statusCode,
            `Target service error: ${proxyRes.statusMessage}`,
            'upstream_error',
            'upstream_error'
          )
          resolve({ success: false, statusCode })
          return
        }

        // Set SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })

        let buffer = ''

        proxyRes.on('data', (chunk: Buffer) => {
          const chunkStr = chunk.toString()
          siteLog.debug(`[Proxy] Received chunk: ${chunkStr.substring(0, 200)}...`)
          buffer += chunkStr

          // Process complete lines (NDJSON or SSE format)
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue

            // Handle SSE format: "data: {...}"
            let jsonStr = line
            if (line.startsWith('data: ')) {
              jsonStr = line.substring(6) // Remove "data: " prefix
            }

            // Skip non-JSON lines like "[DONE]"
            if (!jsonStr.startsWith('{')) continue

            try {
              const parsed = JSON.parse(jsonStr)
              const transformed = adapter.transformStreamChunk(parsed)

              if (transformed) {
                // Override model name if provided
                if (modelName) {
                  transformed.model = modelName
                }
                const output = `data: ${JSON.stringify(transformed)}\n\n`
                siteLog.debug(`[Proxy] Sending transformed: ${output.substring(0, 100)}...`)
                res.write(output)
              }
            } catch {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        })

        proxyRes.on('end', () => {
          // Process any remaining buffer
          if (buffer.trim()) {
            let jsonStr = buffer
            if (buffer.startsWith('data: ')) {
              jsonStr = buffer.substring(6)
            }
            if (jsonStr.startsWith('{')) {
              try {
                const parsed = JSON.parse(jsonStr)
                const transformed = adapter.transformStreamChunk(parsed)
                if (transformed) {
                  if (modelName) {
                    transformed.model = modelName
                  }
                  res.write(`data: ${JSON.stringify(transformed)}\n\n`)
                }
              } catch {
                // Ignore
              }
            }
          }

          res.write('data: [DONE]\n\n')
          res.end()
          resolve({ success: true, statusCode: 200 })
        })

        proxyRes.on('error', (err) => {
          siteLog.error('[Proxy] Response error:', err)
          res.end()
          resolve({ success: false, statusCode: 500 })
        })
      })

      proxyReq.on('error', (err) => {
        const isTimeout = /timeout/i.test(err.message)
        siteLog.error('[Proxy] Request error:', err)
        this.triggerRefreshOnFailure(siteId, isTimeout ? 'upstream-timeout' : 'connection-failed')
        if (!res.headersSent) {
          this.sendError(
            res,
            isTimeout ? 504 : 502,
            isTimeout ? 'Upstream timeout' : `Failed to connect to target service: ${err.message}`,
            'upstream_error',
            isTimeout ? 'upstream_timeout' : 'connection_failed'
          )
        } else {
          res.end()
        }
        resolve({ success: false, statusCode: isTimeout ? 504 : 502 })
      })

      proxyReq.setTimeout(timeoutMs, () => {
        siteLog.error(`[Proxy] Upstream timeout after ${timeoutMs}ms`)
        proxyReq.destroy(new Error('Upstream timeout'))
      })

      proxyReq.write(targetReq.body)
      proxyReq.end()
    })
  }

  private async handleNonStreamResponse(
    targetReq: { url: string; method: string; headers: Record<string, string>; body: string },
    adapter: { transformStreamChunk: (chunk: unknown) => { id: string; object: string; created: number; model: string; choices: Array<{ index: number; delta: { role?: string; content?: string }; finish_reason: string | null }> } | null },
    siteId: string,
    res: http.ServerResponse,
    modelName?: string,
    maxRetries: number = 2
  ): Promise<{ success: boolean; statusCode?: number }> {
    const siteLog = getSiteProxyLogger(siteId)
    const url = new URL(targetReq.url)

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: targetReq.method,
      headers: targetReq.headers,
      family: FORCE_IPV4
    }

    let lastError: Error | null = null
    let attempt = 0
    let lastStatusCode = 500

    while (attempt <= maxRetries) {
      attempt++

      try {
        const result = await this.executeNonStreamRequest(options, targetReq.body, siteLog)
        lastStatusCode = result.statusCode

        if (result.statusCode === 200) {
          // Success - process and return response
          const fullContent = this.extractContentFromResponse(result.data, adapter)
          siteLog.info(`[Proxy] NonStream extracted content length: ${fullContent.length}`)

          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelName || 'generic',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: fullContent
              },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
          return { success: true, statusCode: 200 }
        }

        // Check if error is retryable
        if (!this.isRetryableError(result.statusCode) || attempt > maxRetries) {
          siteLog.warn(`[Proxy] NonStream target returned error: ${result.statusCode}`)
          if (result.statusCode === 401 || result.statusCode === 403) {
            this.triggerRefreshOnFailure(siteId, `upstream-${result.statusCode}`)
          }
          this.sendError(
            res,
            result.statusCode || 500,
            `Target service error: ${result.statusMessage} - ${result.data}`,
            'upstream_error',
            'upstream_error'
          )
          return { success: false, statusCode: result.statusCode }
        }

        // Retryable error - calculate delay
        const retryDelay = this.parseRetryAfter(result.headers) || (1000 * attempt)
        siteLog.info(`[Proxy] Retryable error ${result.statusCode}, attempt ${attempt}/${maxRetries + 1}, waiting ${retryDelay}ms`)
        await this.sleep(retryDelay)

      } catch (err) {
        lastError = err as Error
        siteLog.error(`[Proxy] Request error (attempt ${attempt}/${maxRetries + 1}):`, err)

        if (attempt > maxRetries) {
          this.triggerRefreshOnFailure(siteId, 'connection-failed')
          this.sendError(res, 502, `Failed to connect to target service: ${lastError.message}`, 'upstream_error', 'connection_failed')
          return { success: false, statusCode: 502 }
        }

        // Wait before retry
        await this.sleep(1000 * attempt)
      }
    }

    // Should not reach here, but just in case
    this.triggerRefreshOnFailure(siteId, 'connection-failed')
    this.sendError(res, 502, `Failed after ${maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`, 'upstream_error', 'max_retries_exceeded')
    return { success: false, statusCode: lastStatusCode }
  }

  /**
   * Execute a single non-stream HTTP request
   */
  private executeNonStreamRequest(
    options: https.RequestOptions,
    body: string,
    siteLog: ReturnType<typeof getSiteProxyLogger>
  ): Promise<{ statusCode: number; statusMessage: string; headers: http.IncomingHttpHeaders; data: string }> {
    return new Promise((resolve, reject) => {
      const proxyReq = https.request(options, (proxyRes) => {
        siteLog.info(`[Proxy] NonStream response status: ${proxyRes.statusCode} ${proxyRes.statusMessage}`)
        let data = ''

        proxyRes.on('data', (chunk: Buffer) => {
          data += chunk.toString()
        })

        proxyRes.on('end', () => {
          siteLog.debug(`[Proxy] NonStream response data: ${data.substring(0, 500)}...`)
          resolve({
            statusCode: proxyRes.statusCode || 500,
            statusMessage: proxyRes.statusMessage || 'Unknown',
            headers: proxyRes.headers,
            data
          })
        })
      })

      proxyReq.on('error', reject)
      proxyReq.write(body)
      proxyReq.end()
    })
  }

  /**
   * Extract content from NDJSON or SSE response format
   */
  private extractContentFromResponse(
    data: string,
    adapter: { transformStreamChunk: (chunk: unknown) => { id: string; object: string; created: number; model: string; choices: Array<{ index: number; delta: { role?: string; content?: string }; finish_reason: string | null }> } | null }
  ): string {
    let fullContent = ''
    const lines = data.split('\n')

    for (const line of lines) {
      if (!line.trim()) continue

      // Handle SSE format: "data: {...}"
      let jsonStr = line
      if (line.startsWith('data: ')) {
        jsonStr = line.substring(6) // Remove "data: " prefix
      }

      // Skip non-JSON lines like "[DONE]"
      if (!jsonStr.startsWith('{')) continue

      try {
        const parsed = JSON.parse(jsonStr)
        const transformed = adapter.transformStreamChunk(parsed)
        if (transformed?.choices[0]?.delta?.content) {
          fullContent += transformed.choices[0].delta.content
        }
      } catch {
        // Ignore parse errors
      }
    }

    return fullContent
  }

  /**
   * Handle WebSocket-based streaming response
   * Connects to WebSocket server, sends message, and streams response as SSE
   */
  private async handleWebSocketStreamResponse(
    adapter: WebSocketAdapter,
    openaiReq: OpenAIChatRequest,
    credentials: { authorization: string | null; sessionId: string | null; capturedAt: number | null },
    site: { id: string; name: string; targetUrl: string; enabled: boolean; captureRules: Array<{ urlPattern: string; captureAuth: boolean; captureSessionId: boolean; sessionIdField?: string; authHeader?: string }>; adapterType: string; adapterConfig?: Record<string, unknown> },
    res: http.ServerResponse,
    modelName?: string
  ): Promise<void> {
    const siteLog = getSiteProxyLogger(site.id)
    return new Promise((resolve) => {
      siteLog.info(`[WebSocket] Connecting to ${adapter.wsUrl}`)

      const ws = new WebSocket(adapter.wsUrl)
      let headersSent = false

      const sendSSEHeaders = () => {
        if (!headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          })
          headersSent = true
        }
      }

      const cleanup = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
      }

      ws.on('open', () => {
        siteLog.info(`[WebSocket] Connected to ${adapter.wsUrl}`)

        // Send connect message if needed
        const connectMsg = adapter.createConnectMessage(credentials, site)
        if (connectMsg) {
          siteLog.debug(`[WebSocket] Sending connect message`)
          ws.send(connectMsg)
        }

        // Send chat message
        const chatMsg = adapter.createChatMessage(openaiReq, credentials, site)
        siteLog.info(`[WebSocket] Sending chat message`)
        siteLog.debug(`[WebSocket] Message: ${chatMsg.substring(0, 200)}...`)
        ws.send(chatMsg)
      })

      ws.on('message', (data: WebSocket.Data) => {
        const dataStr = data.toString()
        siteLog.debug(`[WebSocket] Received: ${dataStr.substring(0, 200)}...`)

        // Transform message to OpenAI format
        const chunk = adapter.transformMessage(dataStr)
        if (chunk) {
          // Override model name if provided
          if (modelName) {
            chunk.model = modelName
          }
          sendSSEHeaders()
          res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }

        // Check if complete
        if (adapter.isComplete(dataStr)) {
          siteLog.info(`[WebSocket] Stream complete`)
          sendSSEHeaders()
          res.write('data: [DONE]\n\n')
          res.end()
          cleanup()
          resolve()
        }
      })

      ws.on('error', (err) => {
        siteLog.error(`[WebSocket] Error:`, err)
        this.triggerRefreshOnFailure(site.id, 'connection-failed')
        if (!headersSent) {
          this.sendError(res, 502, `WebSocket connection failed: ${err.message}`, 'upstream_error', 'websocket_error')
        } else {
          res.end()
        }
        cleanup()
        resolve()
      })

      ws.on('close', (code, reason) => {
        siteLog.info(`[WebSocket] Closed: ${code} ${reason}`)
        if (headersSent && !res.writableEnded) {
          res.write('data: [DONE]\n\n')
          res.end()
        }
        resolve()
      })

      // Timeout after 60 seconds
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          siteLog.warn(`[WebSocket] Timeout, closing connection`)
          ws.close()
        }
      }, 60000)
    })
  }

  /**
   * Handle WebSocket-based non-streaming response
   * Accumulates all content and returns as single response
   */
  private async handleWebSocketNonStreamResponse(
    adapter: WebSocketAdapter,
    openaiReq: OpenAIChatRequest,
    credentials: { authorization: string | null; sessionId: string | null; capturedAt: number | null },
    site: { id: string; name: string; targetUrl: string; enabled: boolean; captureRules: Array<{ urlPattern: string; captureAuth: boolean; captureSessionId: boolean; sessionIdField?: string; authHeader?: string }>; adapterType: string; adapterConfig?: Record<string, unknown> },
    res: http.ServerResponse,
    modelName?: string
  ): Promise<void> {
    const siteLog = getSiteProxyLogger(site.id)
    const responseModelName = modelName || site.id
    return new Promise((resolve) => {
      siteLog.info(`[WebSocket] Connecting to ${adapter.wsUrl} (non-stream)`)

      const ws = new WebSocket(adapter.wsUrl)
      let fullContent = ''

      const cleanup = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
      }

      ws.on('open', () => {
        siteLog.info(`[WebSocket] Connected to ${adapter.wsUrl}`)

        // Send connect message if needed
        const connectMsg = adapter.createConnectMessage(credentials, site)
        if (connectMsg) {
          ws.send(connectMsg)
        }

        // Send chat message
        const chatMsg = adapter.createChatMessage(openaiReq, credentials, site)
        siteLog.info(`[WebSocket] Sending chat message (non-stream)`)
        siteLog.info(`[WebSocket] Full message: ${chatMsg.substring(0, 1000)}`)
        ws.send(chatMsg)
      })

      ws.on('message', (data: WebSocket.Data) => {
        const dataStr = data.toString()
        siteLog.info(`[WebSocket] Received: ${dataStr.substring(0, 500)}`)

        // Transform message and accumulate content
        const chunk = adapter.transformMessage(dataStr)
        if (chunk?.choices[0]?.delta?.content) {
          fullContent += chunk.choices[0].delta.content
        }

        // Check if complete
        if (adapter.isComplete(dataStr)) {
          siteLog.info(`[WebSocket] Response complete, content length: ${fullContent.length}`)

          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: responseModelName,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: fullContent
              },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
          cleanup()
          resolve()
        }
      })

      ws.on('error', (err) => {
        siteLog.error(`[WebSocket] Error:`, err)
        this.triggerRefreshOnFailure(site.id, 'connection-failed')
        this.sendError(res, 502, `WebSocket connection failed: ${err.message}`, 'upstream_error', 'websocket_error')
        cleanup()
        resolve()
      })

      ws.on('close', (code, reason) => {
        siteLog.info(`[WebSocket] Closed: ${code} ${reason}`)
        if (!res.writableEnded) {
          // Return whatever content we have
          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: responseModelName,
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: fullContent || '(No response received)'
              },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        }
        resolve()
      })

      // Timeout after 60 seconds
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          siteLog.warn(`[WebSocket] Timeout, closing connection`)
          ws.close()
        }
      }, 60000)
    })
  }

  /**
   * Handle chat completions for OAuth-authenticated models
   * Routes to the appropriate OAuth adapter based on provider
   */
  private async handleOAuthChatCompletions(
    openaiReq: OpenAIChatRequest,
    provider: OAuthProviderType,
    modelId: string,
    res: http.ServerResponse
  ): Promise<void> {
    const siteId = `oauth:${provider}`

    // Ensure OAuth credentials are valid, attempting refresh if needed
    const hasValidCreds = await this.ensureSiteCredentials(siteId)
    if (!hasValidCreds) {
      this.sendError(
        res,
        401,
        `No valid OAuth credentials for ${provider}. Please authenticate first.`,
        'authentication_error',
        'no_oauth_credentials'
      )
      return
    }

    // Get the OAuth adapter
    const adapter = getOAuthAdapter(provider)
    if (!adapter) {
      this.sendError(
        res,
        500,
        `OAuth adapter not found for provider: ${provider}`,
        'server_error',
        'adapter_not_found'
      )
      return
    }

    // Get access token
    const cred = credentialStore.getCredential(siteId)
    if (!cred?.authorization) {
      this.sendError(
        res,
        401,
        `No access token for ${provider}. Please re-authenticate.`,
        'authentication_error',
        'no_access_token'
      )
      return
    }

    // Extract access token from "Bearer xxx" format
    const accessToken = cred.authorization.replace(/^Bearer\s+/i, '')

    // Get project ID for Gemini
    const projectId = credentialStore.getProjectId(siteId)

    log.info(`[OAuth] Routing request to ${provider} adapter for model ${modelId}, projectId: ${projectId || '(none)'}`)

    // Transform request with extra parameters
    const targetReq = adapter.transformRequest(openaiReq, accessToken, modelId, { projectId: projectId || undefined })

    // Make request
    if (openaiReq.stream !== false) {
      await this.handleOAuthStreamResponse(targetReq, adapter, provider, modelId, res)
    } else {
      await this.handleOAuthNonStreamResponse(targetReq, adapter, provider, modelId, res)
    }

    // Record usage
    usageStore.recordRequest(siteId, modelId, true)
  }

  /**
   * Handle OAuth streaming response
   */
  private async handleOAuthStreamResponse(
    targetReq: { url: string; method: string; headers: Record<string, string>; body: string },
    adapter: ReturnType<typeof getOAuthAdapter>,
    provider: OAuthProviderType,
    modelId: string,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(targetReq.url)

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: targetReq.method,
      headers: targetReq.headers,
      family: FORCE_IPV4
    }

    return new Promise((resolve) => {
      const proxyReq = https.request(options, (proxyRes) => {
        log.info(`[OAuth ${provider}] Response status: ${proxyRes.statusCode}`)

        if (proxyRes.statusCode !== 200) {
          let errorBody = ''
          proxyRes.on('data', (chunk) => { errorBody += chunk.toString() })
          proxyRes.on('end', () => {
            log.error(`[OAuth ${provider}] Error response: ${errorBody}`)
            this.sendError(
              res,
              proxyRes.statusCode || 500,
              `${provider} API error: ${errorBody}`,
              'upstream_error',
              'oauth_api_error'
            )
            resolve()
          })
          return
        }

        // Set SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })

        let buffer = ''

        proxyRes.on('data', (chunk: Buffer) => {
          const chunkStr = chunk.toString()
          buffer += chunkStr

          // Process complete lines
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.trim()) continue

            // Handle SSE format
            let jsonStr = line
            if (line.startsWith('data: ')) {
              jsonStr = line.substring(6)
            }

            // Skip non-JSON lines
            if (!jsonStr.startsWith('{')) continue

            try {
              const parsed = JSON.parse(jsonStr)
              const transformed = adapter!.transformStreamChunk(parsed, modelId)

              if (transformed) {
                res.write(`data: ${JSON.stringify(transformed)}\n\n`)
              }

              if (adapter!.isStreamComplete(parsed)) {
                res.write('data: [DONE]\n\n')
              }
            } catch {
              // Ignore JSON parse errors
            }
          }
        })

        proxyRes.on('end', () => {
          // Process remaining buffer
          if (buffer.trim()) {
            let jsonStr = buffer
            if (buffer.startsWith('data: ')) {
              jsonStr = buffer.substring(6)
            }
            if (jsonStr.startsWith('{')) {
              try {
                const parsed = JSON.parse(jsonStr)
                const transformed = adapter!.transformStreamChunk(parsed, modelId)
                if (transformed) {
                  res.write(`data: ${JSON.stringify(transformed)}\n\n`)
                }
              } catch {
                // Ignore
              }
            }
          }

          res.write('data: [DONE]\n\n')
          res.end()
          resolve()
        })

        proxyRes.on('error', (err) => {
          log.error(`[OAuth ${provider}] Response error:`, err)
          res.end()
          resolve()
        })
      })

      proxyReq.on('error', (err) => {
        log.error(`[OAuth ${provider}] Request error:`, err)
        this.sendError(res, 502, `Failed to connect to ${provider}: ${err.message}`, 'upstream_error', 'connection_failed')
        resolve()
      })

      proxyReq.write(targetReq.body)
      proxyReq.end()
    })
  }

  /**
   * Handle OAuth non-streaming response
   */
  private async handleOAuthNonStreamResponse(
    targetReq: { url: string; method: string; headers: Record<string, string>; body: string },
    adapter: ReturnType<typeof getOAuthAdapter>,
    provider: OAuthProviderType,
    modelId: string,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(targetReq.url)

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: targetReq.method,
      headers: targetReq.headers,
      family: FORCE_IPV4
    }

    return new Promise((resolve) => {
      const proxyReq = https.request(options, (proxyRes) => {
        log.info(`[OAuth ${provider}] NonStream response status: ${proxyRes.statusCode}`)

        let data = ''
        proxyRes.on('data', (chunk) => { data += chunk.toString() })

        proxyRes.on('end', () => {
          if (proxyRes.statusCode !== 200) {
            log.error(`[OAuth ${provider}] Error response: ${data}`)
            this.sendError(
              res,
              proxyRes.statusCode || 500,
              `${provider} API error: ${data}`,
              'upstream_error',
              'oauth_api_error'
            )
            resolve()
            return
          }

          try {
            const parsed = JSON.parse(data)
            const response = adapter!.transformNonStreamResponse(parsed, modelId)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(response))
          } catch (err) {
            log.error(`[OAuth ${provider}] Failed to parse response:`, err)
            this.sendError(res, 500, 'Failed to parse response', 'server_error', 'parse_error')
          }
          resolve()
        })

        proxyRes.on('error', (err) => {
          log.error(`[OAuth ${provider}] Response error:`, err)
          this.sendError(res, 502, `Response error: ${err.message}`, 'upstream_error', 'response_error')
          resolve()
        })
      })

      proxyReq.on('error', (err) => {
        log.error(`[OAuth ${provider}] Request error:`, err)
        this.sendError(res, 502, `Failed to connect to ${provider}: ${err.message}`, 'upstream_error', 'connection_failed')
        resolve()
      })

      proxyReq.write(targetReq.body)
      proxyReq.end()
    })
  }

  private async handleModels(res: http.ServerResponse): Promise<void> {
    const models: OpenAIModel[] = []

    // First, try to refresh models for sites with dynamic model support
    for (const site of siteStore.getEnabled()) {
      if (credentialStore.hasValidCredential(site.id)) {
        // Get adapter and check if it supports dynamic models
        const adapter = adapterRegistry.getForSite(site)
        if (adapter?.capabilities?.dynamicModels && adapter.fetchDynamicModels) {
          const credentials = credentialStore.getCredentials(site.id)
          const dynamicModels = await adapter.fetchDynamicModels(credentials)
          if (dynamicModels.length > 0) {
            modelStore.setModels(site.id, dynamicModels)
          }
        }
      }
    }

    // Add models from modelStore (dynamic models)
    for (const { siteId, modelInfo } of modelStore.getAllModels()) {
      const site = siteStore.getById(siteId)
      // Only include models from enabled sites with valid credentials
      if (site?.enabled && credentialStore.hasValidCredential(siteId)) {
        models.push({
          id: modelInfo.modelName,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: site.name || siteId
        })
      }
    }

    // Add sites without dynamic models (legacy behavior)
    for (const site of siteStore.getEnabled()) {
      // Skip sites that have dynamic models
      if (modelStore.hasModels(site.id)) continue

      if (credentialStore.hasValidCredential(site.id)) {
        models.push({
          id: site.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: site.name
        })
      }
    }

    // If no credentials anywhere, show available sites
    if (models.length === 0) {
      for (const site of siteStore.getEnabled()) {
        models.push({
          id: site.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: `${site.name} (no credentials)`
        })
      }
    }

    // Add OAuth provider models (only for authenticated and enabled providers)
    for (const providerConfig of OAUTH_PROVIDER_MODELS) {
      const siteId = `oauth:${providerConfig.provider}`
      if (credentialStore.hasValidCredential(siteId) && toolSettingsStore.isEnabled(providerConfig.provider)) {
        for (const model of providerConfig.models) {
          models.push({
            id: model.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: providerConfig.displayName
          })
        }
      }
    }

    const response: OpenAIModelsResponse = {
      object: 'list',
      data: models
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  private handleDebugCredentials(res: http.ServerResponse, url: URL): void {
    const targetSiteId = url.searchParams.get('site')

    if (targetSiteId) {
      // Return credentials for specific site
      const cred = credentialStore.getCredential(targetSiteId)
      const response = {
        siteId: targetSiteId,
        hasCredentials: credentialStore.hasValidCredential(targetSiteId),
        authorization: cred?.authorization ? `${cred.authorization.substring(0, 20)}...` : null,
        sessionId: cred?.sessionId || null,
        capturedAt: cred?.capturedAt ? new Date(cred.capturedAt).toISOString() : null,
        expiresAt: cred?.expiresAt ? new Date(cred.expiresAt).toISOString() : null
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response, null, 2))
    } else {
      // Return all credentials
      const allCreds: Record<string, unknown>[] = []
      for (const siteId of credentialStore.getAllSiteIds()) {
        const cred = credentialStore.getCredential(siteId)
        allCreds.push({
          siteId,
          hasCredentials: credentialStore.hasValidCredential(siteId),
          authorization: cred?.authorization ? `${cred.authorization.substring(0, 20)}...` : null,
          sessionId: cred?.sessionId || null,
          capturedAt: cred?.capturedAt ? new Date(cred.capturedAt).toISOString() : null
        })
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ credentials: allCreds }, null, 2))
    }
  }

  private handleDebugSites(res: http.ServerResponse): void {
    const sites = siteStore.getAll().map(site => ({
      id: site.id,
      name: site.name,
      targetUrl: site.targetUrl,
      enabled: site.enabled,
      adapterType: site.adapterType,
      hasCredentials: credentialStore.hasValidCredential(site.id)
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ sites }, null, 2))
  }

  /**
   * Handle /debug/usage endpoint - API usage statistics
   */
  private handleDebugUsage(res: http.ServerResponse): void {
    const summary = usageStore.getSummary()
    const records = usageStore.getAllStats()

    const response = {
      summary,
      records: records.map(r => ({
        ...r,
        lastUsed: new Date(r.lastUsed).toISOString(),
        firstUsed: new Date(r.firstUsed).toISOString(),
        successRate: r.requestCount > 0
          ? Math.round((r.successCount / r.requestCount) * 100)
          : 0
      }))
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response, null, 2))
  }

  /**
   * Handle /v1/messages endpoint - Anthropic native API
   * Used by Claude Code for direct communication
   *
   * This endpoint:
   * 1. Accepts Anthropic-format requests
   * 2. When proxy takeover is detected, converts to OpenAI format and routes to available sites
   * 3. Converts OpenAI responses back to Anthropic format
   * 4. Falls back to Anthropic API if no sites available or not in proxy mode
   */
  private async handleAnthropicMessages(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    // Parse request body
    const body = await this.readBody(req)
    let anthropicReq: AnthropicRequest

    try {
      anthropicReq = JSON.parse(body)
    } catch {
      this.sendAnthropicError(res, 400, 'invalid_request_error', 'Invalid JSON in request body')
      return
    }

    log.info(`[Anthropic] Received request for model: ${anthropicReq.model}`)

    // Get API key from request headers
    const apiKey = this.extractAnthropicApiKey(req)

    // Check if proxy takeover mode
    const isProxyTakeover = apiKey === PROXY_TOKEN_PLACEHOLDER

    if (isProxyTakeover) {
      log.info(`[Anthropic] Proxy takeover detected, routing to available sites with format conversion`)

      // Try to route to an available site with format conversion
      const routed = await this.routeAnthropicToSite(anthropicReq, res)
      if (routed) {
        return
      }

      // No sites available
      this.sendAnthropicError(res, 401, 'authentication_error', 'No valid credentials available. Please configure a site first.')
      return
    }

    // Not proxy takeover - check for anthropic adapter site or forward to Anthropic API
    const targetSite = this.findAnthropicTargetSite()
    const targetUrl = targetSite
      ? this.buildAnthropicTargetUrl(targetSite)
      : 'https://api.anthropic.com/v1/messages'

    let finalApiKey = apiKey
    if (targetSite) {
      const creds = credentialStore.getCredentials(targetSite.id)
      if (creds.authorization) {
        finalApiKey = creds.authorization.replace(/^Bearer\s+/i, '')
        log.info(`[Anthropic] Using stored credentials for site: ${targetSite.id}`)
      }
    }

    if (!finalApiKey) {
      this.sendAnthropicError(res, 401, 'authentication_error', 'No valid API key available')
      return
    }

    // Forward request to Anthropic API or anthropic-type site
    const isStream = anthropicReq.stream !== false

    if (isStream) {
      await this.forwardAnthropicStream(anthropicReq, finalApiKey, targetUrl, res)
    } else {
      await this.forwardAnthropicNonStream(anthropicReq, finalApiKey, targetUrl, res)
    }

    const siteId = targetSite?.id || 'anthropic-direct'
    usageStore.recordRequest(siteId, anthropicReq.model, true)
  }

  /**
   * Synchronously check if a site has valid credentials (without refresh)
   * Used for initial model matching before async refresh
   */
  private checkSiteCredentialsSync(siteId: string): boolean {
    if (!credentialStore.hasValidCredential(siteId)) {
      return false
    }

    // Get adapter to check for Clerk auth capability
    const site = siteStore.getById(siteId)
    if (site) {
      const adapter = adapterRegistry.getForSite(site)
      if (adapter?.capabilities?.clerkAuth) {
        return !isClerkTokenExpired(siteId)
      }
    }

    // For other sites, check standard token expiration
    const credentials = credentialStore.getCredentials(siteId)
    return !isTokenExpired(credentials.authorization)
  }

  /**
   * Ensure site credentials are valid, attempting refresh if needed
   * Returns true if credentials are valid after any necessary refresh
   */
  private async ensureSiteCredentials(siteId: string): Promise<boolean> {
    const cred = credentialStore.getCredential(siteId)
    if (!cred) {
      return false
    }

    // Get adapter to check for Clerk auth capability
    const site = siteStore.getById(siteId)
    if (site) {
      const adapter = adapterRegistry.getForSite(site)
      if (adapter?.capabilities?.clerkAuth) {
        if (isClerkTokenExpired(siteId)) {
          if (canRefreshClerkToken(siteId)) {
            log.info(`[Credentials] Clerk token expired for ${siteId}, attempting refresh...`)
            const refreshed = await ensureClerkToken(siteId)
            if (refreshed) {
              log.info(`[Credentials] Clerk token refreshed successfully for ${siteId}`)
              return true
            }
            log.warn(`[Credentials] Clerk token refresh failed for ${siteId}`)
            return false
          }
          log.warn(`[Credentials] Clerk token expired for ${siteId} but no Clerk session available`)
          return false
        }
        return true
      }
    }

    // For OAuth sites (oauth:*), try OAuth token refresh
    if (siteId.startsWith('oauth:')) {
      const credentials = credentialStore.getCredentials(siteId)
      if (isTokenExpired(credentials.authorization) || (cred.expiresAt && Date.now() > cred.expiresAt)) {
        if (canRefreshOAuth(siteId)) {
          log.info(`[Credentials] OAuth token expired for ${siteId}, attempting refresh...`)
          const refreshed = await refreshOAuthToken(siteId)
          if (refreshed) {
            log.info(`[Credentials] OAuth token refreshed successfully for ${siteId}`)
            return true
          }
          log.warn(`[Credentials] OAuth token refresh failed for ${siteId}`)
          return false
        }
        log.warn(`[Credentials] OAuth token expired for ${siteId} but no refresh token available`)
        return false
      }
      return true
    }

    // For other sites, check standard token expiration
    const credentials = credentialStore.getCredentials(siteId)
    if (isTokenExpired(credentials.authorization)) {
      log.debug(`[Credentials] Site ${siteId} has expired token`)
      return false
    }

    return true
  }

  /**
   * Route Anthropic request to an available site with format conversion
   * Converts Anthropic -> OpenAI for request, OpenAI -> Anthropic for response
   *
   * Model matching strategy (in order):
   * 1. Exact model name match
   * 2. Model type match (haiku/sonnet/opus) - for Claude Code compatibility
   * 3. Fallback to first available site with valid credentials
   */
  private async routeAnthropicToSite(
    anthropicReq: AnthropicRequest,
    res: http.ServerResponse
  ): Promise<boolean> {
    const requestedModel = anthropicReq.model
    log.info(`[Anthropic] Looking for site to handle model: ${requestedModel}`)

    // Detect model type for logging
    const modelType = detectModelType(requestedModel)
    if (modelType) {
      log.info(`[Anthropic] Detected model type: ${modelType}`)
    }

    let targetSite: SiteConfig | null = null
    let modelId: string | undefined

    // Use modelStore.findCompatibleModel for unified matching logic
    // This handles both exact match and type-based match
    const credentialChecker = (siteId: string): boolean => {
      return this.checkSiteCredentialsSync(siteId)
    }

    const compatibleModel = modelStore.findCompatibleModel(requestedModel, credentialChecker)

    if (compatibleModel) {
      const site = siteStore.getById(compatibleModel.siteId)
      if (site) {
        // Attempt async credential refresh if needed
        const refreshed = await this.ensureSiteCredentials(site.id)
        if (refreshed) {
          targetSite = site
          modelId = compatibleModel.modelInfo.modelId
          log.info(`[Anthropic] Model "${requestedModel}" matched to "${compatibleModel.modelInfo.modelName}" -> site "${site.id}", modelId "${modelId}"`)
        }
      }
    }

    // Fallback: find first enabled site with valid credentials
    if (!targetSite) {
      const enabledSites = siteStore.getEnabled()
      log.info(`[Anthropic] No compatible model found, checking ${enabledSites.length} enabled sites for fallback`)

      for (const site of enabledSites) {
        const refreshed = await this.ensureSiteCredentials(site.id)
        if (refreshed) {
          targetSite = site
          log.info(`[Anthropic] Fallback to site: ${site.id}`)
          break
        }
      }
    }

    if (!targetSite) {
      log.warn('[Anthropic] No site with valid credentials found')
      return false
    }

    if (!modelId) {
      const availableModels = modelStore.getModels(targetSite.id)
      if (availableModels.length > 0) {
        const fallbackModel = this.selectFallbackModel(availableModels)
        modelId = fallbackModel.modelId
        log.info(`[Anthropic] Fallback model selected: ${fallbackModel.modelName} (modelId "${modelId}")`)
      } else {
        log.warn(`[Anthropic] No models available for fallback site "${targetSite.id}"`)
      }
    }

    log.info(`[Anthropic] Routing to site: ${targetSite.id} (${targetSite.name})`)

    // Convert Anthropic request to OpenAI format
    const openaiReq = anthropicToOpenAI(anthropicReq, targetSite.id)
    log.debug(`[Anthropic] Converted request: ${JSON.stringify(openaiReq).substring(0, 500)}...`)

    const credentials = credentialStore.getCredentials(targetSite.id)
    const isStream = anthropicReq.stream !== false

    // Skip standard refresh for Clerk-based auth sites (handled separately)
    const targetAdapter = adapterRegistry.getForSite(targetSite)
    if (!targetAdapter?.capabilities?.clerkAuth) {
      await this.maybeRefreshCredentials(targetSite, credentials, 'proactive')
    }

    // Get adapter for the site
    const wsAdapter = adapterRegistry.getWebSocketByName(targetSite.adapterType)
    if (wsAdapter) {
      // Handle WebSocket-based adapter
      const siteWithModel: SiteConfig = modelId ? {
        ...targetSite,
        adapterConfig: { ...targetSite.adapterConfig, modelId }
      } : targetSite

      if (isStream) {
        await this.handleAnthropicWebSocketStream(wsAdapter, openaiReq, credentials, siteWithModel, res, anthropicReq.model)
      } else {
        await this.handleAnthropicWebSocketNonStream(wsAdapter, openaiReq, credentials, siteWithModel, res, anthropicReq.model)
      }
      usageStore.recordRequest(targetSite.id, anthropicReq.model, true)
      return true
    }

    // Fall back to HTTP adapter
    const adapter = adapterRegistry.getForSite(targetSite)
    if (!adapter) {
      log.error(`[Anthropic] Adapter "${targetSite.adapterType}" not found for site "${targetSite.id}"`)
      return false
    }

    if (isWebSocketAdapter(adapter)) {
      log.error(`[Anthropic] Unexpected WebSocket adapter for site "${targetSite.id}"`)
      return false
    }

    // Convert OpenAIRequest to OpenAIChatRequest for adapter
    const chatReq = this.toChatRequest(openaiReq)

    const targetReq = adapter.transformRequest(chatReq, credentials)

    if (isStream) {
      await this.handleAnthropicHttpStream(targetReq, adapter, targetSite.id, res, anthropicReq.model)
    } else {
      await this.handleAnthropicHttpNonStream(targetReq, adapter, targetSite.id, res, anthropicReq.model)
    }

    usageStore.recordRequest(targetSite.id, anthropicReq.model, true)
    return true
  }

  private selectFallbackModel(models: ModelInfo[]): ModelInfo {
    const typePriority = ['sonnet', 'opus', 'haiku']
    for (const preferredType of typePriority) {
      const match = models.find(model => detectModelType(model.modelName) === preferredType)
      if (match) {
        return match
      }
    }
    return models[0]
  }

  private async maybeRefreshCredentials(
    site: SiteConfig,
    credentials: Credentials,
    context: string
  ): Promise<void> {
    const policy = resolveRefreshPolicy(site)
    const decision = shouldRefreshCredentials(credentials, policy)
    if (!decision.shouldRefresh || !decision.reason) return

    const refreshed = await this.triggerRefresh(site.id, decision.reason, context, true)
    if (refreshed) {
      const updated = credentialStore.getCredentials(site.id)
      Object.assign(credentials, updated)
    }
  }

  private triggerRefreshOnFailure(siteId: string, reason: string): void {
    void this.triggerRefresh(siteId, reason, 'failure', false)
  }

  private async triggerRefresh(
    siteId: string,
    reason: RefreshReason | string,
    context: string,
    waitForResult: boolean
  ): Promise<boolean> {
    if (isRefreshInProgress(siteId)) {
      log.info(`[Refresh] ${context} refresh already in progress for ${siteId}`)
      return false
    }
    if (!tokenRefreshCallback) {
      log.warn(`[Refresh] ${context} refresh skipped (no callback) for ${siteId}`)
      return false
    }

    log.info(`[Refresh] ${context} refresh triggered for ${siteId}, reason=${reason}`)
    const refreshPromise = requestTokenRefresh(siteId, () => tokenRefreshCallback!(siteId))

    if (waitForResult) {
      const refreshed = await refreshPromise
      if (refreshed) {
        log.info(`[Refresh] ${context} refresh completed for ${siteId}`)
      } else {
        log.warn(`[Refresh] ${context} refresh failed for ${siteId}`)
      }
      return refreshed
    }

    refreshPromise
      .then((refreshed) => {
        if (refreshed) {
          log.info(`[Refresh] ${context} refresh completed for ${siteId}`)
        } else {
          log.warn(`[Refresh] ${context} refresh failed for ${siteId}`)
        }
      })
      .catch((err) => {
        log.error(`[Refresh] ${context} refresh error for ${siteId}:`, err)
      })

    return false
  }

  private extractTextContent(content: OpenAIRequest['messages'][number]['content']): string {
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      return content
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
    }
    return ''
  }

  private toChatRequest(openaiReq: OpenAIRequest): OpenAIChatRequest {
    return {
      model: openaiReq.model,
      messages: openaiReq.messages
        .filter(m => m.role === 'system' || m.role === 'user' || m.role === 'assistant')
        .map(m => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: this.extractTextContent(m.content)
        })),
      stream: openaiReq.stream,
      temperature: openaiReq.temperature,
      max_tokens: openaiReq.max_tokens
    }
  }

  /**
   * Handle WebSocket stream response with Anthropic format conversion
   */
  private async handleAnthropicWebSocketStream(
    wsAdapter: WebSocketAdapter,
    openaiReq: OpenAIRequest,
    credentials: { authorization: string | null; sessionId: string | null; capturedAt: number | null },
    site: SiteConfig,
    res: http.ServerResponse,
    originalModel: string
  ): Promise<void> {
    const siteLog = getSiteProxyLogger(site.id)
    siteLog.info(`[Anthropic/WS] Starting stream for model: ${originalModel}`)

    return new Promise((resolve) => {
      const state = createStreamTransformState()

      siteLog.info(`[Anthropic/WS] Connecting to ${wsAdapter.wsUrl}`)
      const ws = new WebSocket(wsAdapter.wsUrl)
      let headersSent = false

      ws.on('open', () => {
        siteLog.info('[Anthropic/WS] Connected')

        // Send connect message if needed
        const connectMsg = wsAdapter.createConnectMessage(credentials, site)
        if (connectMsg) {
          ws.send(connectMsg)
        }

        // Send chat message (convert OpenAIRequest to OpenAIChatRequest format)
        const chatReq = this.toChatRequest(openaiReq)
        const chatMsg = wsAdapter.createChatMessage(chatReq, credentials, site)
        ws.send(chatMsg)
      })

      ws.on('message', (data: Buffer) => {
        try {
          const dataStr = data.toString()
          const chunk = wsAdapter.transformMessage(dataStr)

          if (chunk) {
            if (!headersSent) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive'
              })
              headersSent = true
            }

            // Convert OpenAI chunk to Anthropic format
            const openaiData = JSON.stringify(chunk)
            const anthropicEvents = transformOpenAIChunkToAnthropic(openaiData, state)

            for (const event of anthropicEvents) {
              res.write(event)
            }
          }

          if (wsAdapter.isComplete(dataStr)) {
            // Send final events
            const doneEvents = transformOpenAIChunkToAnthropic('[DONE]', state)
            for (const event of doneEvents) {
              res.write(event)
            }
            ws.close()
          }
        } catch (error) {
          siteLog.error('[Anthropic/WS] Message processing error:', error)
        }
      })

      ws.on('close', () => {
        siteLog.info('[Anthropic/WS] Connection closed')
        if (!headersSent) {
          this.sendAnthropicError(res, 500, 'api_error', 'Connection closed without response')
        } else {
          res.end()
        }
        resolve()
      })

      ws.on('error', (error) => {
        siteLog.error('[Anthropic/WS] Error:', error)
        this.triggerRefreshOnFailure(site.id, 'connection-failed')
        if (!headersSent) {
          this.sendAnthropicError(res, 502, 'api_error', `WebSocket error: ${error.message}`)
        } else {
          res.end()
        }
        resolve()
      })
    })
  }

  /**
   * Handle WebSocket non-stream response with Anthropic format conversion
   */
  private async handleAnthropicWebSocketNonStream(
    wsAdapter: WebSocketAdapter,
    openaiReq: OpenAIRequest,
    credentials: { authorization: string | null; sessionId: string | null; capturedAt: number | null },
    site: SiteConfig,
    res: http.ServerResponse,
    originalModel: string
  ): Promise<void> {
    const siteLog = getSiteProxyLogger(site.id)
    siteLog.info(`[Anthropic/WS] Starting non-stream for model: ${originalModel}`)

    return new Promise((resolve) => {
      const chunks: Array<{ delta: { content?: string }; finish_reason: string | null }> = []

      siteLog.info(`[Anthropic/WS] Connecting to ${wsAdapter.wsUrl}`)
      const ws = new WebSocket(wsAdapter.wsUrl)

      ws.on('open', () => {
        siteLog.info('[Anthropic/WS] Connected')

        // Send connect message if needed
        const connectMsg = wsAdapter.createConnectMessage(credentials, site)
        if (connectMsg) {
          ws.send(connectMsg)
        }

        // Send chat message
        const chatReq = this.toChatRequest({ ...openaiReq, stream: false })
        const chatMsg = wsAdapter.createChatMessage(chatReq, credentials, site)
        ws.send(chatMsg)
      })

      ws.on('message', (data: Buffer) => {
        try {
          const dataStr = data.toString()
          const chunk = wsAdapter.transformMessage(dataStr)

          if (chunk && chunk.choices?.[0]) {
            chunks.push(chunk.choices[0])
          }

          if (wsAdapter.isComplete(dataStr)) {
            ws.close()
          }
        } catch (error) {
          siteLog.error('[Anthropic/WS] Message processing error:', error)
        }
      })

      ws.on('close', () => {
        siteLog.info('[Anthropic/WS] Connection closed')

        // Assemble full response
        const content = chunks
          .map((c) => c.delta?.content || '')
          .join('')
        const finishReason = chunks.find((c) => c.finish_reason)?.finish_reason || 'stop'

        const openaiResponse: OpenAIResponse = {
          id: `msg_${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: originalModel,
          choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: finishReason as 'stop' | 'length' | 'tool_calls' | 'content_filter'
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
        }

        // Convert to Anthropic format
        const anthropicResponse = openAIToAnthropic(openaiResponse)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(anthropicResponse))
        resolve()
      })

      ws.on('error', (error) => {
        siteLog.error('[Anthropic/WS] Error:', error)
        this.triggerRefreshOnFailure(site.id, 'connection-failed')
        this.sendAnthropicError(res, 502, 'api_error', `WebSocket error: ${error.message}`)
        resolve()
      })
    })
  }

  /**
   * Handle HTTP stream response with Anthropic format conversion
   */
  private async handleAnthropicHttpStream(
    targetReq: { url: string; method: string; headers: Record<string, string>; body: string },
    adapter: Adapter,
    siteId: string,
    res: http.ServerResponse,
    originalModel: string
  ): Promise<void> {
    const siteLog = getSiteProxyLogger(siteId)
    const url = new URL(targetReq.url)
    const timeoutMs = 25000

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: targetReq.method,
      headers: targetReq.headers,
      family: FORCE_IPV4
    }

    return new Promise((resolve) => {
      const state = createStreamTransformState()

      const proxyReq = https.request(options, (proxyRes) => {
        siteLog.info(`[Anthropic/HTTP] Response status: ${proxyRes.statusCode}`)

        if (proxyRes.statusCode !== 200) {
          if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
            this.triggerRefreshOnFailure(siteId, `upstream-${proxyRes.statusCode}`)
          }
          let errorBody = ''
          proxyRes.on('data', (chunk) => { errorBody += chunk.toString() })
          proxyRes.on('end', () => {
            this.sendAnthropicError(res, proxyRes.statusCode || 500, 'api_error', errorBody || 'Target service error')
            resolve()
          })
          return
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })

        let buffer = ''

        const processLine = (line: string) => {
          const trimmed = line.trim()
          if (!trimmed) return

          let data = trimmed
          if (data.startsWith('data: ')) {
            data = data.slice(6).trim()
          }

          if (data === '[DONE]') {
            const doneEvents = transformOpenAIChunkToAnthropic('[DONE]', state)
            for (const event of doneEvents) {
              res.write(event)
            }
            return
          }

          if (!data.startsWith('{')) return

          try {
            const openaiChunk = JSON.parse(data)
            const transformed = adapter.transformStreamChunk(openaiChunk)

            if (transformed) {
              const anthropicEvents = transformOpenAIChunkToAnthropic(JSON.stringify(transformed), state)
              for (const event of anthropicEvents) {
                res.write(event)
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        proxyRes.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()

          // Parse SSE or NDJSON events
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            processLine(line)
          }
        })

        proxyRes.on('end', () => {
          if (buffer.trim()) {
            processLine(buffer)
          }

          // Send any remaining events
          if (!state.messageStopSent) {
            const doneEvents = transformOpenAIChunkToAnthropic('[DONE]', state)
            for (const event of doneEvents) {
              res.write(event)
            }
          }
          res.end()
          resolve()
        })

        proxyRes.on('error', (err) => {
          siteLog.error('[Anthropic/HTTP] Stream error:', err)
          this.triggerRefreshOnFailure(siteId, 'connection-failed')
          res.end()
          resolve()
        })
      })

      proxyReq.on('error', (err) => {
        siteLog.error('[Anthropic/HTTP] Request error:', err)
        this.triggerRefreshOnFailure(siteId, /timeout/i.test(err.message) ? 'upstream-timeout' : 'connection-failed')
        this.sendAnthropicError(res, 502, 'api_error', `Connection failed: ${err.message}`)
        resolve()
      })

      proxyReq.setTimeout(timeoutMs, () => {
        siteLog.error(`[Anthropic/HTTP] Upstream timeout after ${timeoutMs}ms`)
        proxyReq.destroy(new Error('Upstream timeout'))
      })

      proxyReq.write(targetReq.body)
      proxyReq.end()
    })
  }

  /**
   * Handle HTTP non-stream response with Anthropic format conversion
   */
  private async handleAnthropicHttpNonStream(
    targetReq: { url: string; method: string; headers: Record<string, string>; body: string },
    adapter: Adapter,
    siteId: string,
    res: http.ServerResponse,
    originalModel: string
  ): Promise<void> {
    const siteLog = getSiteProxyLogger(siteId)
    const url = new URL(targetReq.url)
    const timeoutMs = 25000

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: targetReq.method,
      headers: targetReq.headers,
      family: FORCE_IPV4
    }

    return new Promise((resolve) => {
      const proxyReq = https.request(options, (proxyRes) => {
        siteLog.info(`[Anthropic/HTTP] Response status: ${proxyRes.statusCode}`)

        let responseBody = ''
        proxyRes.on('data', (chunk) => { responseBody += chunk.toString() })

        proxyRes.on('end', () => {
          if (proxyRes.statusCode !== 200) {
            if (proxyRes.statusCode === 401 || proxyRes.statusCode === 403) {
              this.triggerRefreshOnFailure(siteId, `upstream-${proxyRes.statusCode}`)
            }
            this.sendAnthropicError(res, proxyRes.statusCode || 500, 'api_error', responseBody || 'Target service error')
            resolve()
            return
          }

          try {
            // Parse as OpenAI format response
            const openaiResponse = JSON.parse(responseBody) as OpenAIResponse
            const anthropicResponse = openAIToAnthropic(openaiResponse)

            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(anthropicResponse))
          } catch (error) {
            siteLog.error('[Anthropic/HTTP] Response transform error:', error)
            this.sendAnthropicError(res, 500, 'api_error', 'Failed to transform response')
          }
          resolve()
        })

        proxyRes.on('error', (err) => {
          siteLog.error('[Anthropic/HTTP] Response error:', err)
          this.triggerRefreshOnFailure(siteId, 'connection-failed')
          this.sendAnthropicError(res, 502, 'api_error', `Response error: ${err.message}`)
          resolve()
        })
      })

      proxyReq.on('error', (err) => {
        siteLog.error('[Anthropic/HTTP] Request error:', err)
        this.triggerRefreshOnFailure(siteId, /timeout/i.test(err.message) ? 'upstream-timeout' : 'connection-failed')
        this.sendAnthropicError(res, 502, 'api_error', `Connection failed: ${err.message}`)
        resolve()
      })

      proxyReq.setTimeout(timeoutMs, () => {
        siteLog.error(`[Anthropic/HTTP] Upstream timeout after ${timeoutMs}ms`)
        proxyReq.destroy(new Error('Upstream timeout'))
      })

      proxyReq.write(targetReq.body)
      proxyReq.end()
    })
  }

  /**
   * Extract API key from Anthropic request headers
   */
  private extractAnthropicApiKey(req: http.IncomingMessage): string | null {
    // Try x-api-key first (Anthropic standard)
    const xApiKey = req.headers['x-api-key']
    if (xApiKey && typeof xApiKey === 'string') {
      return xApiKey
    }

    // Try Authorization header
    const authHeader = req.headers.authorization
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7)
      }
      return authHeader
    }

    return null
  }

  /**
   * Find a site configured for Anthropic API forwarding
   */
  private findAnthropicTargetSite(): SiteConfig | null {
    // Look for a site with anthropicApi capability
    for (const site of siteStore.getEnabled()) {
      const adapter = adapterRegistry.getForSite(site)
      if (adapter?.capabilities?.anthropicApi) {
        return site
      }
    }
    return null
  }

  /**
   * Build target URL for Anthropic API
   */
  private buildAnthropicTargetUrl(site: SiteConfig): string {
    // Use site's targetUrl as base, append /v1/messages if needed
    let baseUrl = site.targetUrl
    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }
    if (!baseUrl.endsWith('/v1/messages')) {
      baseUrl += '/v1/messages'
    }
    return baseUrl
  }

  /**
   * Forward streaming Anthropic request
   */
  private async forwardAnthropicStream(
    request: AnthropicRequest,
    apiKey: string,
    targetUrl: string,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(targetUrl)

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream'
      },
      family: FORCE_IPV4
    }

    const requestBody = JSON.stringify({ ...request, stream: true })

    return new Promise((resolve) => {
      const proxyReq = https.request(options, (proxyRes) => {
        log.info(`[Anthropic] Stream response status: ${proxyRes.statusCode}`)

        if (proxyRes.statusCode !== 200) {
          // Forward error response
          let errorBody = ''
          proxyRes.on('data', (chunk) => { errorBody += chunk.toString() })
          proxyRes.on('end', () => {
            try {
              const errorJson = JSON.parse(errorBody)
              res.writeHead(proxyRes.statusCode || 500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(errorJson))
            } catch {
              this.sendAnthropicError(res, proxyRes.statusCode || 500, 'api_error', errorBody)
            }
            resolve()
          })
          return
        }

        // Set SSE headers for Anthropic format
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })

        // Forward stream data directly (Anthropic format)
        proxyRes.on('data', (chunk: Buffer) => {
          res.write(chunk)
        })

        proxyRes.on('end', () => {
          res.end()
          resolve()
        })

        proxyRes.on('error', (err) => {
          log.error('[Anthropic] Stream error:', err)
          res.end()
          resolve()
        })
      })

      proxyReq.on('error', (err) => {
        log.error('[Anthropic] Request error:', err)
        this.sendAnthropicError(res, 502, 'api_error', `Connection failed: ${err.message}`)
        resolve()
      })

      proxyReq.write(requestBody)
      proxyReq.end()
    })
  }

  /**
   * Forward non-streaming Anthropic request
   */
  private async forwardAnthropicNonStream(
    request: AnthropicRequest,
    apiKey: string,
    targetUrl: string,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(targetUrl)

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      family: FORCE_IPV4
    }

    const requestBody = JSON.stringify({ ...request, stream: false })

    return new Promise((resolve) => {
      const proxyReq = https.request(options, (proxyRes) => {
        log.info(`[Anthropic] NonStream response status: ${proxyRes.statusCode}`)

        let responseBody = ''
        proxyRes.on('data', (chunk) => { responseBody += chunk.toString() })

        proxyRes.on('end', () => {
          // Forward response as-is (Anthropic format)
          res.writeHead(proxyRes.statusCode || 200, {
            'Content-Type': 'application/json'
          })
          res.end(responseBody)
          resolve()
        })

        proxyRes.on('error', (err) => {
          log.error('[Anthropic] Response error:', err)
          this.sendAnthropicError(res, 502, 'api_error', `Response error: ${err.message}`)
          resolve()
        })
      })

      proxyReq.on('error', (err) => {
        log.error('[Anthropic] Request error:', err)
        this.sendAnthropicError(res, 502, 'api_error', `Connection failed: ${err.message}`)
        resolve()
      })

      proxyReq.write(requestBody)
      proxyReq.end()
    })
  }

  /**
   * Send Anthropic-format error response
   */
  private sendAnthropicError(
    res: http.ServerResponse,
    statusCode: number,
    type: string,
    message: string
  ): void {
    const error = {
      type: 'error',
      error: {
        type,
        message
      }
    }
    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(error))
  }

  /**
   * Handle /health endpoint - basic health check
   */
  private handleHealth(res: http.ServerResponse): void {
    const response = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: (Date.now() - serverStartTime) / 1000
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  /**
   * Handle /status endpoint - detailed system status
   */
  private handleStatus(res: http.ServerResponse): void {
    const allSites = siteStore.getAll()
    const enabledSites = siteStore.getEnabled()

    let validCredentials = 0
    let expiredCredentials = 0

    for (const site of allSites) {
      const cred = credentialStore.getCredential(site.id)
      if (cred?.authorization) {
        if (isTokenExpired(cred.authorization)) {
          expiredCredentials++
        } else {
          validCredentials++
        }
      }
    }

    const allModels = modelStore.getAllModels()
    const availableModels = allModels.filter(m =>
      credentialStore.hasValidCredential(m.siteId)
    )

    const response = {
      sites: {
        total: allSites.length,
        enabled: enabledSites.length,
        with_credentials: validCredentials + expiredCredentials
      },
      models: {
        total: allModels.length,
        available: availableModels.length
      },
      credentials: {
        valid: validCredentials,
        expired: expiredCredentials
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  }

  private sendError(
    res: http.ServerResponse,
    statusCode: number,
    message: string,
    type: string,
    code: string | null = null,
    context?: Record<string, unknown>,
    suggestion?: string
  ): void {
    // Enhanced error response with optional structured fields
    const error: OpenAIErrorResponse & {
      error: OpenAIErrorResponse['error'] & {
        context?: Record<string, unknown>
        suggestion?: string
      }
    } = {
      error: {
        message,
        type,
        code,
        ...(context && { context }),
        ...(suggestion && { suggestion })
      }
    }

    res.writeHead(statusCode, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(error))
  }

  // ===========================================================================
  // OAuth Handlers
  // ===========================================================================

  /**
   * GET /oauth/providers - List available OAuth providers
   */
  private handleOAuthProviders(res: http.ServerResponse): void {
    const providers = oauthProviderRegistry.getAll().map(p => ({
      name: p.name,
      displayName: p.displayName,
      flowType: p.flowType
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ providers }))
  }

  /**
   * POST /oauth/start - Start OAuth flow for a provider
   * Body: { provider: 'gemini' | 'codex' | 'qwen' }
   */
  private async handleOAuthStart(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let providerName: OAuthProviderType

    try {
      const parsed = JSON.parse(body)
      providerName = parsed.provider
    } catch {
      this.sendError(res, 400, 'Invalid JSON body', 'invalid_request_error', 'parse_error')
      return
    }

    const provider = oauthProviderRegistry.get(providerName)
    if (!provider) {
      this.sendError(
        res, 400,
        `Unknown OAuth provider: ${providerName}`,
        'invalid_request_error',
        'unknown_provider',
        { availableProviders: oauthProviderRegistry.getNames() }
      )
      return
    }

    try {
      log.info(`[OAuth] Starting ${providerName} OAuth flow`)
      const result = await provider.startAuth()

      // Register session
      oauthSessionStore.register(result.state, providerName, {
        codeVerifier: result.codeVerifier,
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        pollInterval: result.pollInterval
      })

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        authUrl: result.authUrl,
        state: result.state,
        flowType: provider.flowType,
        // Device flow specific
        userCode: result.userCode,
        pollInterval: result.pollInterval,
        expiresIn: result.expiresIn
      }))
    } catch (err) {
      log.error(`[OAuth] Failed to start ${providerName} flow:`, err)
      this.sendError(
        res, 500,
        `Failed to start OAuth flow: ${(err as Error).message}`,
        'server_error',
        'oauth_start_failed'
      )
    }
  }

  /**
   * GET /oauth/callback/:provider - Handle OAuth callback
   */
  private async handleOAuthCallback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
    url: URL
  ): Promise<void> {
    // Extract provider from path
    const providerName = path.split('/').pop() as OAuthProviderType
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const errorDescription = url.searchParams.get('error_description')

    // Handle OAuth error
    if (error) {
      log.warn(`[OAuth] Callback error for ${providerName}: ${error} - ${errorDescription}`)
      if (state) {
        oauthSessionStore.setError(state, errorDescription || error)
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Failed</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>Authentication Failed</h1>
          <p>${errorDescription || error}</p>
          <p>You can close this window.</p>
        </body>
        </html>
      `)
      return
    }

    // Validate parameters
    if (!code || !state) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Invalid Callback</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>Invalid Callback</h1>
          <p>Missing code or state parameter.</p>
        </body>
        </html>
      `)
      return
    }

    // Get session
    const session = oauthSessionStore.get(state)
    if (!session) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Session Expired</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>Session Expired</h1>
          <p>Your authentication session has expired. Please try again.</p>
        </body>
        </html>
      `)
      return
    }

    // Verify provider matches
    if (session.provider !== providerName) {
      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Provider Mismatch</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>Provider Mismatch</h1>
          <p>Expected ${session.provider}, got ${providerName}.</p>
        </body>
        </html>
      `)
      return
    }

    // Get provider
    const provider = oauthProviderRegistry.get(providerName)
    if (!provider) {
      oauthSessionStore.setError(state, 'Provider not found')
      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end('<html><body><h1>Internal Error</h1></body></html>')
      return
    }

    try {
      log.info(`[OAuth] Processing callback for ${providerName}, state: ${state.substring(0, 8)}...`)

      // Exchange code for token
      const token = await provider.handleCallback(code, state, session.codeVerifier)

      // Extract email from ID token if available
      const email = extractEmailFromIdToken(token.idToken)

      // Store credentials (without projectId initially)
      const siteId = `oauth:${providerName}`
      credentialStore.setOAuthCredential(siteId, token, providerName, { email: email || undefined })

      // For Gemini, fetch GCP projects and select the best one
      let projectId: string | null = null
      if (providerName === 'gemini') {
        try {
          const { fetchGCPProjects, selectBestGCPProject } = await import('./oauth/utils')
          const projects = await fetchGCPProjects(token.accessToken)
          projectId = selectBestGCPProject(projects)
          if (projectId) {
            credentialStore.setProjectId(siteId, projectId)
            log.info(`[OAuth] GCP project selected for Gemini: ${projectId}`)
          } else {
            log.warn(`[OAuth] No GCP projects found for Gemini user`)
          }
        } catch (projectErr) {
          log.warn(`[OAuth] Failed to fetch GCP projects: ${projectErr}`)
        }
      }

      // Mark session as completed
      oauthSessionStore.complete(state)

      log.info(`[OAuth] Authentication successful for ${providerName}${email ? ` (${email})` : ''}${projectId ? ` [project: ${projectId}]` : ''}`)

      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Successful</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>Authentication Successful!</h1>
          <p>${email ? `Logged in as ${email}` : 'You are now authenticated.'}</p>
          <p>You can close this window.</p>
          <script>
            // Try to close the window after a short delay
            setTimeout(() => window.close(), 2000);
          </script>
        </body>
        </html>
      `)
    } catch (err) {
      log.error(`[OAuth] Callback processing failed for ${providerName}:`, err)
      oauthSessionStore.setError(state, (err as Error).message)

      res.writeHead(500, { 'Content-Type': 'text/html' })
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Failed</title></head>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>Authentication Failed</h1>
          <p>${(err as Error).message}</p>
          <p>Please try again.</p>
        </body>
        </html>
      `)
    }
  }

  /**
   * GET /oauth/status?state=xxx - Check OAuth session status
   */
  private handleOAuthStatus(res: http.ServerResponse, url: URL): void {
    const state = url.searchParams.get('state')

    if (!state) {
      this.sendError(res, 400, 'Missing state parameter', 'invalid_request_error', 'missing_state')
      return
    }

    const session = oauthSessionStore.get(state)

    if (!session) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'not_found',
        message: 'Session not found or expired'
      }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: session.status,
      provider: session.provider,
      error: session.error,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    }))
  }

  /**
   * POST /oauth/poll - Poll for device code token (for device_code flow)
   * Body: { state: string }
   */
  private async handleOAuthPoll(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let state: string

    try {
      const parsed = JSON.parse(body)
      state = parsed.state
    } catch {
      this.sendError(res, 400, 'Invalid JSON body', 'invalid_request_error', 'parse_error')
      return
    }

    if (!state) {
      this.sendError(res, 400, 'Missing state parameter', 'invalid_request_error', 'missing_state')
      return
    }

    const session = oauthSessionStore.get(state)
    if (!session) {
      this.sendError(res, 404, 'Session not found or expired', 'invalid_request_error', 'session_not_found')
      return
    }

    if (session.status === 'completed') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'completed' }))
      return
    }

    if (session.status === 'error') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'error', error: session.error }))
      return
    }

    // Only device_code flow supports polling
    if (!session.deviceCode) {
      this.sendError(res, 400, 'This session does not support polling', 'invalid_request_error', 'polling_not_supported')
      return
    }

    const provider = oauthProviderRegistry.get(session.provider)
    if (!provider || !provider.pollForToken) {
      this.sendError(res, 500, 'Provider does not support polling', 'server_error', 'polling_not_supported')
      return
    }

    try {
      const token = await provider.pollForToken(session.deviceCode, session.codeVerifier)

      // Extract email from ID token if available
      const email = extractEmailFromIdToken(token.idToken)

      // Store credentials
      const siteId = `oauth:${session.provider}`
      credentialStore.setOAuthCredential(siteId, token, session.provider, { email: email || undefined })

      // Mark session as completed
      oauthSessionStore.complete(state)

      log.info(`[OAuth] Device flow completed for ${session.provider}${email ? ` (${email})` : ''}`)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'completed',
        email
      }))
    } catch (err) {
      const errorMessage = (err as Error).message

      // authorization_pending is expected while waiting for user
      if (errorMessage === 'authorization_pending') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'pending',
          message: 'Waiting for user authorization'
        }))
        return
      }

      // slow_down means we should increase polling interval
      if (errorMessage === 'slow_down') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'slow_down',
          message: 'Please slow down polling'
        }))
        return
      }

      // Other errors
      log.error(`[OAuth] Device flow poll failed for ${session.provider}:`, err)
      oauthSessionStore.setError(state, errorMessage)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'error',
        error: errorMessage
      }))
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }
}
