/**
 * OAuth Module
 *
 * Provides CLI OAuth authentication capabilities for:
 * - Gemini CLI (Google OAuth2)
 * - OpenAI Codex CLI (PKCE)
 * - Qwen Code (Device Flow)
 */

// Types
export type { OAuthProvider } from './provider'
export { BaseOAuthProvider } from './provider'

// Session management
export { oauthSessionStore, OAuthSessionStore } from './session-store'

// Provider registry
export {
  oauthProviderRegistry,
  registerOAuthProviders,
  geminiOAuthProvider,
  codexOAuthProvider,
  qwenOAuthProvider
} from './registry'

// Utility functions
export {
  generateState,
  generatePKCE,
  buildAuthUrl,
  exchangeCodeForToken,
  exchangeCodeForTokenPKCE,
  refreshAccessToken,
  initiateDeviceFlow,
  pollDeviceToken,
  parseTokenResponse,
  isOAuthTokenExpired,
  extractEmailFromIdToken,
  fetchGCPProjects,
  selectBestGCPProject
} from './utils'
export type { GCPProject } from './utils'

// OAuth Models
export {
  OAUTH_PROVIDER_MODELS,
  GEMINI_MODELS,
  CODEX_MODELS,
  QWEN_MODELS,
  getModelsForProvider,
  getProviderDisplayName,
  findOAuthModelOwner,
  getAllOAuthModelIds,
  isOAuthModel
} from './models'
export type { OAuthModel, OAuthProviderModels } from './models'
