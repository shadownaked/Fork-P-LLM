/**
 * Gemini CLI OAuth Provider
 *
 * Implements Google OAuth2 for Gemini CLI / Cloud Code Assist.
 * Uses standard authorization_code flow with client_secret.
 *
 */

import type { OAuthProviderConfig, OAuthStartResult, OAuthToken } from '../../types'
import { BaseOAuthProvider } from '../provider'
import {
  generateState,
  buildAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken
} from '../utils'
import { getMainLogger } from '../../logger'

const log = getMainLogger()

/**
 * Default port for Gemini OAuth callback
 * Can be overridden via environment variable
 */
const DEFAULT_PORT = process.env.OAUTH_PORT || '8080'

/**
 * Gemini OAuth Provider
 *
 * Uses Google OAuth2 with the following scopes:
 * - cloud-platform: Access to GCP resources
 * - userinfo.email: User's email address
 * - userinfo.profile: User's basic profile
 */
export class GeminiOAuthProvider extends BaseOAuthProvider {
  readonly name = 'gemini' as const
  readonly displayName = 'Gemini CLI'
  readonly flowType = 'authorization_code' as const

  // 公开凭证，不构成安全风险
  // Note: This is a public client secret from Gemini CLI,
  // intentionally embedded as per Google's OAuth for installed apps
  readonly config: OAuthProviderConfig = {
    // Client ID from Gemini CLI (Cloud Code Assist)
    clientId: 'YOUR_GOOGLE_CLIENT_ID',
    // Client secret (required for Google OAuth)
    clientSecret: 'YOUR_GOOGLE_CLIENT_SECRET',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'openid'
    ],
    redirectUri: `http://localhost:${DEFAULT_PORT}/oauth/callback/gemini`,
    flowType: 'authorization_code'
  }

  /**
   * Start Gemini OAuth flow
   * Opens browser to Google authorization page
   */
  async startAuth(): Promise<OAuthStartResult> {
    const state = generateState()

    const authUrl = buildAuthUrl(this.config, state, {
      // Request offline access to get refresh_token
      access_type: 'offline',
      // Force consent screen to ensure refresh_token is returned
      prompt: 'consent',
      // Include granted scopes in response
      include_granted_scopes: 'true'
    })

    log.info(`[Gemini OAuth] Starting auth flow, state: ${state.substring(0, 8)}...`)

    return {
      authUrl,
      state
    }
  }

  /**
   * Handle OAuth callback from Google
   * Exchanges authorization code for tokens
   */
  async handleCallback(code: string, state: string): Promise<OAuthToken> {
    log.info(`[Gemini OAuth] Handling callback, state: ${state.substring(0, 8)}...`)

    const token = await exchangeCodeForToken(this.config, code)

    log.info(`[Gemini OAuth] Token obtained, expires at: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`)

    return token
  }

  /**
   * Refresh Gemini access token
   */
  async refreshToken(refreshToken: string): Promise<OAuthToken> {
    log.info('[Gemini OAuth] Refreshing token')

    const token = await refreshAccessToken(this.config, refreshToken)

    // Google may not return a new refresh_token, keep the old one
    if (!token.refreshToken) {
      token.refreshToken = refreshToken
    }

    log.info(`[Gemini OAuth] Token refreshed, expires at: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`)

    return token
  }
}

// Export singleton instance
export const geminiOAuthProvider = new GeminiOAuthProvider()
