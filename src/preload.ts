import { contextBridge, ipcRenderer } from 'electron'

interface CredentialsData {
  hasCredentials: boolean
  sessionId: string | null
}

interface SiteInfo {
  id: string
  name: string
  targetUrl: string
  enabled: boolean
  hasCredentials: boolean
  sessionId: string | null
  capturedAt: number | null
  isWindowOpen: boolean
}

interface SiteConfig {
  id: string
  name: string
  targetUrl: string
  enabled: boolean
  captureRules: Array<{
    urlPattern: string
    captureAuth: boolean
    captureSessionId: boolean
    sessionIdField?: string
    authHeader?: string
  }>
  adapterType: string
}

interface RequestSummary {
  id: string
  timestamp: number
  method: string
  url: string
  hasBody: boolean
  contentType: string | null
}

interface RequestDetail {
  id: string
  timestamp: number
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  contentType: string | null
}

// Claude Code takeover status
interface TakeoverStatus {
  isTakenOver: boolean
  proxyUrl: string | null
  hasBackup: boolean
  backupPath: string | null
}

// Claude 连接目标
interface ConnectTarget {
  type: 'site' | 'tool'
  id: string
  name: string
  model?: string
}

// API 测试结果
interface ApiTestResult {
  success: boolean
  responseTimeMs?: number
  error?: string
  httpStatus?: number
}

// Proxy status (simplified - no caTrusted needed)
interface ProxyStatus {
  enabled: boolean
  caExists: boolean
  certPath: string
}

type CredentialsCallback = (data: CredentialsData) => void
type SitesCallback = (sites: SiteInfo[]) => void
type WindowClosedCallback = (siteId: string) => void
type ProxyStatusCallback = (status: ProxyStatus) => void

let credentialsCallback: CredentialsCallback | null = null
let sitesCallback: SitesCallback | null = null
let windowClosedCallback: WindowClosedCallback | null = null
let proxyStatusCallback: ProxyStatusCallback | null = null

// Listen for site window closed events from main process
ipcRenderer.on('site-window-closed', (_event, siteId: string) => {
  if (windowClosedCallback) {
    windowClosedCallback(siteId)
  }
})

// Listen for proxy status changes from main process
ipcRenderer.on('proxy-status-changed', (_event, status: ProxyStatus) => {
  if (proxyStatusCallback) {
    proxyStatusCallback(status)
  }
})

contextBridge.exposeInMainWorld('electronAPI', {
  // Legacy methods
  openTarget: (url: string) => ipcRenderer.invoke('open-target', url),

  getCredentials: async (siteId?: string) => {
    const data = await ipcRenderer.invoke('get-credentials', siteId)
    if (credentialsCallback) {
      credentialsCallback(data)
    }
    return data
  },

  onCredentials: (callback: CredentialsCallback) => {
    credentialsCallback = callback
  },

  // Site management
  getAllSites: async () => {
    const sites = await ipcRenderer.invoke('get-all-sites')
    if (sitesCallback) {
      sitesCallback(sites)
    }
    return sites as SiteInfo[]
  },

  onSitesUpdate: (callback: SitesCallback) => {
    sitesCallback = callback
  },

  refreshCredentials: (siteId: string) => ipcRenderer.invoke('refresh-credentials', siteId),

  addSite: (site: SiteConfig) => ipcRenderer.invoke('add-site', site),

  updateSite: (id: string, updates: Partial<SiteConfig>) => ipcRenderer.invoke('update-site', id, updates),

  removeSite: (id: string) => ipcRenderer.invoke('remove-site', id),

  clearCredentials: (siteId: string) => ipcRenderer.invoke('clear-credentials', siteId),

  clearSiteErrorStatus: (siteId: string) => ipcRenderer.invoke('clear-site-error-status', siteId),

  // Window management
  openSite: (siteId: string) => ipcRenderer.invoke('open-site', siteId),

  closeSite: (siteId: string) => ipcRenderer.invoke('close-site', siteId),

  getOpenWindows: () => ipcRenderer.invoke('get-open-windows') as Promise<string[]>,

  onSiteWindowClosed: (callback: (siteId: string) => void) => {
    windowClosedCallback = callback
  },

  // Request capture
  getRequests: (siteId: string) => ipcRenderer.invoke('get-requests', siteId) as Promise<RequestSummary[]>,

  getRequestDetail: (siteId: string, requestId: string) =>
    ipcRenderer.invoke('get-request-detail', siteId, requestId) as Promise<RequestDetail | null>,

  clearRequests: (siteId: string) => ipcRenderer.invoke('clear-requests', siteId),

  selectRequestAsCredential: (siteId: string, requestId: string) =>
    ipcRenderer.invoke('select-request-as-credential', siteId, requestId) as Promise<{
      success: boolean
      error?: string
      authHeader?: string
      note?: string
    }>,

  // Claude Code takeover management
  claudeTakeoverStatus: () =>
    ipcRenderer.invoke('claude-takeover-status') as Promise<TakeoverStatus>,

  claudeTakeover: (proxyUrl?: string) =>
    ipcRenderer.invoke('claude-takeover', proxyUrl) as Promise<{
      success: boolean
      proxyUrl: string
    }>,

  claudeRestore: () =>
    ipcRenderer.invoke('claude-restore') as Promise<{ success: boolean }>,

  claudeForceCleanup: () =>
    ipcRenderer.invoke('claude-force-cleanup') as Promise<{ success: boolean }>,

  claudeIsInstalled: () =>
    ipcRenderer.invoke('claude-is-installed') as Promise<boolean>,

  claudeTestApi: (model: string) =>
    ipcRenderer.invoke('claude-test-api', model) as Promise<ApiTestResult>,

  claudeGetSelectedTarget: () =>
    ipcRenderer.invoke('claude-get-selected-target') as Promise<ConnectTarget | null>,

  claudeSetSelectedTarget: (target: ConnectTarget | null) =>
    ipcRenderer.invoke('claude-set-selected-target', target) as Promise<void>,

  // OAuth
  oauthGetProviders: () =>
    ipcRenderer.invoke('oauth-get-providers') as Promise<
      Array<{
        name: string
        displayName: string
        flowType: string
      }>
    >,

  oauthStartAuth: (provider: string) =>
    ipcRenderer.invoke('oauth-start-auth', provider) as Promise<{
      authUrl: string
      state: string
      flowType: string
      userCode?: string
      pollInterval?: number
      expiresIn?: number
    }>,

  oauthGetStatus: (state: string) =>
    ipcRenderer.invoke('oauth-get-status', state) as Promise<{
      status: string
      provider?: string
      error?: string
      email?: string
    }>,

  oauthPoll: (state: string) =>
    ipcRenderer.invoke('oauth-poll', state) as Promise<{
      status: string
      provider?: string
      error?: string
      email?: string
    }>,

  oauthGetCredentials: () =>
    ipcRenderer.invoke('oauth-get-credentials') as Promise<
      Array<{
        provider: string
        email?: string
        expiresAt?: number
        hasCredential: boolean
      }>
    >,

  oauthLogout: (provider: string) =>
    ipcRenderer.invoke('oauth-logout', provider) as Promise<{
      success: boolean
      error?: string
    }>,

  // Get authorized OAuth tools with their models
  getAuthorizedTools: () =>
    ipcRenderer.invoke('get-authorized-tools') as Promise<
      Array<{
        provider: string
        displayName: string
        email?: string
        expiresAt: number | null
        enabled: boolean
        models: Array<{
          id: string
          name: string
          description?: string
        }>
      }>
    >,

  // Toggle tool enabled state
  toggleToolEnabled: (provider: string) =>
    ipcRenderer.invoke('toggle-tool-enabled', provider) as Promise<{
      success: boolean
      enabled: boolean
    }>,

  // Open URL in system default browser (not Electron's internal browser)
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Proxy settings (simplified - no system CA installation needed)
  proxyGetStatus: () =>
    ipcRenderer.invoke('proxy-get-status') as Promise<ProxyStatus>,

  proxyRevealCA: () =>
    ipcRenderer.invoke('proxy-reveal-ca') as Promise<{ success: boolean }>,

  proxyToggle: () =>
    ipcRenderer.invoke('proxy-toggle') as Promise<{
      success: boolean
      enabled: boolean
    }>,

  onProxyStatusChanged: (callback: ProxyStatusCallback) => {
    proxyStatusCallback = callback
  }
})
