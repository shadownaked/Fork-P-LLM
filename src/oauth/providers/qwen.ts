/**
 * Qwen Code OAuth Provider
 *
 * Implements OAuth2 Device Code flow for Qwen Code CLI.
 * Uses device_code flow with PKCE enhancement.
 *
 */

import type { OAuthProviderConfig, OAuthStartResult, OAuthToken } from '../../types'
import { BaseOAuthProvider } from '../provider'
import {
  generateState,
  generatePKCE,
  initiateDeviceFlow,
  pollDeviceToken,
  refreshAccessToken
} from '../utils'
import { getMainLogger } from '../../logger'

const log = getMainLogger()

/**
 * Qwen OAuth Provider
 *
 * Uses Device Code flow, which is ideal for CLI tools:
 * 1. Request device code from server
 * 2. Display user code and verification URL to user
 * 3. User visits URL and enters code
 * 4. Poll for token until user authorizes
 */
export class QwenOAuthProvider extends BaseOAuthProvider {
  readonly name = 'qwen' as const
  readonly displayName = 'Qwen Code'
  readonly flowType = 'device_code' as const

  readonly config: OAuthProviderConfig = {
    // Client ID from Qwen Code CLI
    clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
    // Device code endpoints
    deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
    authUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code', // Not used directly
    tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
    scopes: ['openid', 'profile', 'email', 'model.completion'],
    // No redirect URI for device flow
    redirectUri: '',
    flowType: 'device_code'
  }

  /**
   * Start Qwen OAuth device flow
   * Returns device code and user code for display
   */
  async startAuth(): Promise<OAuthStartResult> {
    // Generate PKCE (Qwen uses PKCE with device flow)
    const { codeVerifier, codeChallenge } = generatePKCE()
    const state = generateState()

    log.info('[Qwen OAuth] Initiating device code flow')

    const deviceResponse = await initiateDeviceFlow(
      this.config.deviceCodeUrl!,
      this.config.clientId,
      this.config.scopes,
      codeChallenge
    )

    log.info(`[Qwen OAuth] Device code obtained, user code: ${deviceResponse.user_code}`)

    return {
      // URL for user to visit (may include user code)
      authUrl: deviceResponse.verification_uri_complete || deviceResponse.verification_uri,
      state,
      codeVerifier,
      deviceCode: deviceResponse.device_code,
      userCode: deviceResponse.user_code,
      // Convert seconds to milliseconds
      pollInterval: deviceResponse.interval * 1000,
      expiresIn: deviceResponse.expires_in
    }
  }

  /**
   * Handle callback is not used for device flow
   * This method exists for interface compatibility
   */
  async handleCallback(_code: string, _state: string, _codeVerifier?: string): Promise<OAuthToken> {
    throw new Error('Device flow does not use callback. Use pollForToken instead.')
  }

  /**
   * Poll for token after user authorizes
   * Should be called repeatedly until success or timeout
   */
  async pollForToken(deviceCode: string, codeVerifier?: string): Promise<OAuthToken> {
    log.info('[Qwen OAuth] Polling for token')

    const token = await pollDeviceToken(
      this.config.tokenUrl,
      this.config.clientId,
      deviceCode,
      codeVerifier
    )

    log.info(`[Qwen OAuth] Token obtained, expires at: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`)

    return token
  }

  /**
   * Refresh Qwen access token
   */
  async refreshToken(refreshToken: string): Promise<OAuthToken> {
    log.info('[Qwen OAuth] Refreshing token')

    const token = await refreshAccessToken(this.config, refreshToken)

    // Keep old refresh_token if new one not returned
    if (!token.refreshToken) {
      token.refreshToken = refreshToken
    }

    log.info(`[Qwen OAuth] Token refreshed, expires at: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`)

    return token
  }
}

// Export singleton instance
export const qwenOAuthProvider = new QwenOAuthProvider()
