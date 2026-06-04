/**
 * OAuth Provider Interface
 *
 * Defines the contract for OAuth providers.
 * Each provider implements the specific OAuth flow for its service:
 * - authorization_code: Standard OAuth2 with redirect
 * - pkce: OAuth2 with PKCE extension (no client_secret)
 * - device_code: Device authorization flow (for CLI tools)
 */

import type {
  OAuthFlowType,
  OAuthProviderType,
  OAuthProviderConfig,
  OAuthStartResult,
  OAuthToken
} from '../types'

/**
 * OAuth Provider interface
 * All providers must implement this interface
 */
export interface OAuthProvider {
  /**
   * Provider identifier (e.g., 'gemini', 'codex', 'qwen')
   */
  readonly name: OAuthProviderType

  /**
   * Display name for UI
   */
  readonly displayName: string

  /**
   * OAuth flow type used by this provider
   */
  readonly flowType: OAuthFlowType

  /**
   * Provider configuration
   */
  readonly config: OAuthProviderConfig

  /**
   * Start the OAuth flow
   * Returns information needed to initiate authorization
   */
  startAuth(): Promise<OAuthStartResult>

  /**
   * Handle OAuth callback (for authorization_code and pkce flows)
   * Exchanges authorization code for tokens
   *
   * @param code - Authorization code from callback
   * @param state - State parameter for verification
   * @param codeVerifier - PKCE code_verifier (required for pkce flow)
   */
  handleCallback(code: string, state: string, codeVerifier?: string): Promise<OAuthToken>

  /**
   * Poll for token (for device_code flow)
   * Polls the token endpoint until user authorizes or timeout
   *
   * @param deviceCode - Device code from startAuth
   * @param codeVerifier - PKCE code_verifier if used
   */
  pollForToken?(deviceCode: string, codeVerifier?: string): Promise<OAuthToken>

  /**
   * Refresh access token using refresh_token
   *
   * @param refreshToken - The refresh token
   */
  refreshToken(refreshToken: string): Promise<OAuthToken>

  /**
   * Validate if a token is still valid
   * Default implementation checks expiration
   */
  validateToken?(token: OAuthToken): boolean
}

/**
 * Base class for OAuth providers
 * Provides common functionality and default implementations
 */
export abstract class BaseOAuthProvider implements OAuthProvider {
  abstract readonly name: OAuthProviderType
  abstract readonly displayName: string
  abstract readonly flowType: OAuthFlowType
  abstract readonly config: OAuthProviderConfig

  abstract startAuth(): Promise<OAuthStartResult>
  abstract handleCallback(code: string, state: string, codeVerifier?: string): Promise<OAuthToken>
  abstract refreshToken(refreshToken: string): Promise<OAuthToken>

  /**
   * Default token validation - checks expiration
   */
  validateToken(token: OAuthToken): boolean {
    if (!token.expiresAt) {
      return true // No expiration info, assume valid
    }
    // Add 60 second buffer
    return Date.now() + 60000 < token.expiresAt
  }
}
