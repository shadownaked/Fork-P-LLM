// OpenAI API Types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

/**
 * OpenAI-compatible finish_reason values
 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | null

/**
 * Tool call delta for streaming responses
 */
export interface ToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

/**
 * Tool call for non-streaming responses
 */
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Usage statistics
 */
export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      tool_calls?: ToolCallDelta[]
    }
    finish_reason: FinishReason
  }>
}

/**
 * Non-streaming chat completion response
 */
export interface OpenAIChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: ToolCall[]
    }
    finish_reason: FinishReason
  }>
  usage?: Usage
}

export interface OpenAIModel {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export interface OpenAIModelsResponse {
  object: 'list'
  data: OpenAIModel[]
}

export interface OpenAIErrorResponse {
  error: {
    message: string
    type: string
    code: string | null
  }
}

// Captured request for credential extraction
export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

// Base Adapter Interface - common properties for all adapters
export interface BaseAdapter {
  name: string
  urlPattern?: string
  getModels(): OpenAIModel[]

  // Optional: Fetch dynamic models from remote API
  // Used for sites that require API calls to get available models
  fetchDynamicModels?(credentials: Credentials): Promise<ModelInfo[]>

  // Optional: Adapter capability flags
  capabilities?: AdapterCapabilities
}

// Adapter capability flags
export interface AdapterCapabilities {
  // Supports Anthropic API format (for /v1/messages endpoint)
  anthropicApi?: boolean
  // Supports dynamic model fetching
  dynamicModels?: boolean
  // Uses Clerk authentication (short-lived JWT tokens)
  clerkAuth?: boolean
  // Has static predefined models (registered on credential capture)
  staticModels?: boolean
  // Requires relaxed credential validation (only check authorization presence)
  relaxedCredentialValidation?: boolean
  // Auto-capture patterns for special URL handling
  autoCapture?: {
    // Pattern to match for Clerk session capture (e.g., 'clerk.orchids.app')
    clerkSessionPattern?: string
    // Pattern to match for projectId/sessionId capture from URL
    sessionIdPattern?: RegExp
  }
}

// HTTP Adapter Interface
export interface Adapter extends BaseAdapter {
  targetBaseUrl: string
  transformRequest(openaiReq: OpenAIChatRequest, credentials: Credentials): TargetRequest
  transformStreamChunk(chunk: unknown): OpenAIStreamChunk | null

  // Optional: Extract sessionId from captured request (site-specific logic)
  extractSessionId?(request: CapturedRequest): string | null

  // Optional: Get static models for this site (if models are predefined)
  getStaticModels?(): ModelInfo[] | null

  // Optional: Get refresh URL for token refresh (site-specific logic)
  getRefreshUrl?(baseUrl: string, credentials: Credentials): string | null

  // Optional: Get default capture rules for this adapter
  // These rules will be merged with user-provided rules when creating a site
  getDefaultCaptureRules?(): CaptureRule[]

  // Optional: Get default model capture config for this adapter
  getDefaultModelCaptureConfig?(): ModelCaptureConfig | null
}

// WebSocket Adapter Interface (for sites using WebSocket instead of HTTP)
export interface WebSocketAdapter extends BaseAdapter {
  isWebSocket: true
  wsUrl: string

  // Create the initial WebSocket connection message
  createConnectMessage(credentials: Credentials, siteConfig: SiteConfig): string | null

  // Create the chat message to send over WebSocket
  createChatMessage(openaiReq: OpenAIChatRequest, credentials: Credentials, siteConfig: SiteConfig): string

  // Transform incoming WebSocket message to OpenAI stream chunk
  transformMessage(data: string): OpenAIStreamChunk | null

  // Check if the message indicates completion
  isComplete(data: string): boolean
}

export interface TargetRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

// Credential Types (legacy, for backward compatibility)
export interface Credentials {
  authorization: string | null
  sessionId: string | null
  capturedAt: number | null
  expiresAt?: number | null
  requestHeaders?: Record<string, string> | null  // Original request headers (including Cookie)
}

// Multi-site Credential Types
export interface SiteCredential {
  siteId: string
  authorization: string | null
  sessionId: string | null
  capturedAt: number | null
  expiresAt: number | null
  requestHeaders?: Record<string, string> | null  // Original request headers (including Cookie)
  // Clerk-specific fields for Orchids token refresh
  clerkSessionId?: string | null      // Clerk session ID (e.g., sess_xxx)
  clerkClientToken?: string | null    // Clerk __client cookie value
}

// Capture Rule for credential extraction
export interface CaptureRule {
  urlPattern: string
  captureAuth: boolean
  captureSessionId: boolean
  sessionIdField?: string
  sessionIdSource?: 'url' | 'body' | 'response'  // where to extract sessionId from (default: 'url')
  authHeader?: string  // defaults to 'Authorization'
}

// Model capture configuration for extracting models from API responses
export interface ModelCaptureConfig {
  urlPattern: string           // URL pattern to match (e.g., '/sv5/llm/provider')
  responseField: string        // JSON path to model list (e.g., 'model_configurations')
  modelNameField: string       // Field name for model name (e.g., 'name')
  modelIdField?: string        // Field name for model ID (defaults to modelNameField)
  displayNameField?: string    // Field name for display name
}

// Refresh configuration for auto-refresh
export interface RefreshConfig {
  enabled: boolean
  intervalMs: number
  thresholdMs?: number
  strategy: 'reopen' | 'api'
  endpoint?: string
}

// Model info for sites with multiple models
export interface ModelInfo {
  modelName: string      // The model name exposed via API (e.g., "claude-opus-4-5")
  modelId: string        // Internal ID used by the site (e.g., gummie_id)
  displayName?: string   // Human-readable name (e.g., "Unique Galaxy")
}

// Site configuration
export interface SiteConfig {
  id: string
  name: string
  targetUrl: string
  enabled: boolean
  captureRules: CaptureRule[]
  adapterType: string
  adapterConfig?: Record<string, unknown>
  refresh?: RefreshConfig
  modelCaptureConfig?: ModelCaptureConfig  // Configuration for capturing models from API responses
}

export interface Config {
  apiServerPort: number
  apiServerHost?: string           // Host to bind to, defaults to '127.0.0.1' (localhost only)
  apiKeys?: string[]               // Optional API keys for authentication
  requireApiKey?: boolean          // Whether to require API key for /v1/* endpoints
  defaultTargetUrl: string
  modelAliases?: Record<string, string>  // Model name aliases
}

// ============================================================================
// OAuth Types
// ============================================================================

/**
 * OAuth flow types supported by different providers
 */
export type OAuthFlowType = 'authorization_code' | 'pkce' | 'device_code'

/**
 * OAuth provider types
 */
export type OAuthProviderType = 'gemini' | 'codex' | 'qwen'

/**
 * OAuth Token structure
 * Stores the complete token information from OAuth providers
 */
export interface OAuthToken {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  tokenType: string              // Usually 'Bearer'
  expiresAt: number | null       // Unix timestamp in milliseconds
  scope: string | null
}

/**
 * OAuth Provider configuration
 * Defines the endpoints and settings for each OAuth provider
 */
export interface OAuthProviderConfig {
  clientId: string
  clientSecret?: string          // Some providers (like Gemini) require this
  authUrl: string                // Authorization endpoint
  tokenUrl: string               // Token exchange endpoint
  deviceCodeUrl?: string         // Device code endpoint (for device_code flow)
  scopes: string[]
  redirectUri: string            // Callback URL (uses API server port)
  flowType: OAuthFlowType
}

/**
 * Result from starting an OAuth flow
 */
export interface OAuthStartResult {
  authUrl: string                // URL user needs to visit
  state: string                  // State parameter for CSRF protection
  codeVerifier?: string          // PKCE code_verifier (for pkce flow)
  deviceCode?: string            // Device code (for device_code flow)
  userCode?: string              // User code to display (for device_code flow)
  pollInterval?: number          // Polling interval in ms (for device_code flow)
  expiresIn?: number             // Expiration time in seconds
}

/**
 * OAuth Session - tracks an in-progress OAuth flow
 */
export interface OAuthSession {
  state: string                  // Unique identifier for this session
  provider: OAuthProviderType    // Which provider this session is for
  codeVerifier?: string          // PKCE code_verifier (stored for callback)
  deviceCode?: string            // Device code (for device_code flow)
  userCode?: string              // User code (for device_code flow)
  pollInterval?: number          // Polling interval in ms
  createdAt: number              // Unix timestamp when session was created
  expiresAt: number              // Unix timestamp when session expires
  status: 'pending' | 'polling' | 'completed' | 'error'
  error?: string                 // Error message if status is 'error'
}

/**
 * Extended credential type for OAuth
 * Adds OAuth-specific fields to SiteCredential
 */
export interface OAuthCredentialData {
  refreshToken: string | null
  idToken: string | null
  tokenType: string
  scope: string | null
  providerType: OAuthProviderType
  email?: string                 // User's email if available
  accountId?: string             // Provider-specific account ID
  projectId?: string             // GCP project ID for Gemini
}

/**
 * Site credential with optional OAuth data
 */
export interface SiteCredentialWithOAuth extends SiteCredential {
  oauth?: OAuthCredentialData
}
