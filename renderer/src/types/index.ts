// 凭据数据
export interface CredentialsData {
  hasCredentials: boolean
  sessionId: string | null
}

// 站点信息（用于展示）
export interface SiteInfo {
  id: string
  name: string
  targetUrl: string
  enabled: boolean
  hasCredentials: boolean
  sessionId: string | null
  capturedAt: number | null
  isWindowOpen: boolean
  tokenStatus: 'valid' | 'expired' | 'refreshing' | 'none'
  models?: ModelInfo[]
  lastRequestStatus?: {
    statusCode?: number
    error?: string
    lastUsed?: number
  }
}

// 模型信息
export interface ModelInfo {
  modelName: string
  modelId: string
  displayName: string
}

// 站点配置（用于创建/更新）
export interface SiteConfig {
  id: string
  name: string
  targetUrl: string
  enabled: boolean
  captureRules: CaptureRule[]
  adapterType: string
}

// 捕获规则
export interface CaptureRule {
  urlPattern: string
  captureAuth: boolean
  captureSessionId: boolean
  sessionIdField?: string
  authHeader?: string
}

// 请求摘要（列表展示）
export interface RequestSummary {
  id: string
  timestamp: number
  method: string
  url: string
  hasBody: boolean
  contentType: string | null
  isRecommended?: boolean  // True if matches captureRules pattern
}

// 请求详情
export interface RequestDetail {
  id: string
  timestamp: number
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  contentType: string | null
}

// API 操作结果
export interface ApiResult {
  success: boolean
  error?: string
}

// 选择请求作为凭据的结果
export interface SelectRequestResult extends ApiResult {
  authHeader?: string
  note?: string
}

// Claude Code 接管状态
export interface ClaudeTakeoverStatus {
  isTakenOver: boolean
  proxyUrl: string | null
  hasBackup: boolean
  backupPath: string | null
}

// Claude 接管操作结果
export interface ClaudeTakeoverResult extends ApiResult {
  proxyUrl?: string
}

// Claude 连接目标
export interface ConnectTarget {
  type: 'site' | 'tool'
  id: string
  name: string
  model?: string  // 用于 API 测试的模型
}

// API 测试结果
export interface ApiTestResult {
  success: boolean
  responseTimeMs?: number
  error?: string
  httpStatus?: number
}

// OAuth 类型
export type OAuthProviderType = 'gemini' | 'codex' | 'qwen'

export interface OAuthProviderInfo {
  name: OAuthProviderType
  displayName: string
  flowType: 'authorization_code' | 'pkce' | 'device_code'
}

export interface OAuthStartResult {
  authUrl: string
  state: string
  flowType: 'authorization_code' | 'pkce' | 'device_code'
  userCode?: string
  pollInterval?: number
  expiresIn?: number
}

export interface OAuthSessionStatus {
  status: 'pending' | 'polling' | 'completed' | 'error' | 'not_found' | 'slow_down'
  provider?: OAuthProviderType
  error?: string
  email?: string
}

export interface OAuthCredentialInfo {
  provider: OAuthProviderType
  email?: string
  expiresAt?: number
  hasCredential: boolean
}

// Authorized OAuth Tool
export interface AuthorizedTool {
  provider: OAuthProviderType
  displayName: string
  email?: string
  expiresAt: number | null
  enabled: boolean
  models: Array<{
    id: string
    name: string
    description?: string
  }>
}

// Toast 类型
export interface Toast {
  id: string
  message: string
  type: 'success' | 'error' | 'info'
}

// Electron API 接口
export interface ElectronAPI {
  // Legacy
  openTarget: (url: string) => Promise<ApiResult>
  getCredentials: (siteId?: string) => Promise<CredentialsData & { siteId?: string }>
  onCredentials: (callback: (data: CredentialsData) => void) => void

  // Site management
  getAllSites: () => Promise<SiteInfo[]>
  onSitesUpdate: (callback: (sites: SiteInfo[]) => void) => void
  refreshCredentials: (siteId: string) => Promise<ApiResult>
  addSite: (site: SiteConfig) => Promise<ApiResult>
  updateSite: (id: string, updates: Partial<SiteConfig>) => Promise<ApiResult>
  removeSite: (id: string) => Promise<ApiResult>
  clearCredentials: (siteId: string) => Promise<ApiResult>
  clearSiteErrorStatus: (siteId: string) => Promise<ApiResult>

  // Window management
  openSite: (siteId: string) => Promise<ApiResult>
  closeSite: (siteId: string) => Promise<ApiResult>
  getOpenWindows: () => Promise<string[]>
  onSiteWindowClosed: (callback: (siteId: string) => void) => void

  // Request capture
  getRequests: (siteId: string) => Promise<RequestSummary[]>
  getRequestDetail: (siteId: string, requestId: string) => Promise<RequestDetail | null>
  clearRequests: (siteId: string) => Promise<ApiResult>
  selectRequestAsCredential: (siteId: string, requestId: string) => Promise<SelectRequestResult>

  // Claude Code takeover
  claudeTakeoverStatus: () => Promise<ClaudeTakeoverStatus>
  claudeTakeover: (proxyUrl?: string) => Promise<ClaudeTakeoverResult>
  claudeRestore: () => Promise<ApiResult>
  claudeForceCleanup: () => Promise<ApiResult>
  claudeIsInstalled: () => Promise<boolean>
  claudeTestApi: (model: string) => Promise<ApiTestResult>
  claudeGetSelectedTarget: () => Promise<ConnectTarget | null>
  claudeSetSelectedTarget: (target: ConnectTarget | null) => Promise<void>

  // OAuth
  oauthGetProviders: () => Promise<OAuthProviderInfo[]>
  oauthStartAuth: (provider: OAuthProviderType) => Promise<OAuthStartResult>
  oauthGetStatus: (state: string) => Promise<OAuthSessionStatus>
  oauthPoll: (state: string) => Promise<OAuthSessionStatus>
  oauthGetCredentials: () => Promise<OAuthCredentialInfo[]>
  oauthLogout: (provider: OAuthProviderType) => Promise<ApiResult>

  // Authorized Tools
  getAuthorizedTools: () => Promise<AuthorizedTool[]>
  toggleToolEnabled: (provider: OAuthProviderType) => Promise<{ success: boolean; enabled: boolean }>

  // Open URL in system default browser (not Electron's internal browser)
  openExternal: (url: string) => Promise<void>
}

// 扩展 Window 接口
declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
