/**
 * OpenAI Codex CLI OAuth Provider
 *
 * Implements OAuth2 with PKCE for OpenAI Codex CLI.
 * Uses authorization_code flow with PKCE (no client_secret required).
 *
 */

import type { OAuthProviderConfig, OAuthStartResult, OAuthToken } from '../../types'
import { BaseOAuthProvider } from '../provider'
import {
  generateState,
  generatePKCE,
  buildAuthUrl,
  exchangeCodeForTokenPKCE,
  refreshAccessToken
} from '../utils'
import { getMainLogger } from '../../logger'

const log = getMainLogger()

/**
 * Default port for Codex OAuth callback
 */
const DEFAULT_PORT = process.env.OAUTH_PORT || '8080'

/**
 * OpenAI Codex OAuth Provider
 *
 * Uses PKCE flow with the following scopes:
 * - openid: OpenID Connect
 * - email: User's email
 * - profile: User's profile
 * - offline_access: Get refresh_token
 */
export class CodexOAuthProvider extends BaseOAuthProvider {
  readonly name = 'codex' as const
  readonly displayName = 'OpenAI Codex CLI'
  readonly flowType = 'pkce' as const

  readonly config: OAuthProviderConfig = {
    // Client ID from OpenAI Codex CLI
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    // No client_secret for PKCE flow
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    scopes: ['openid', 'email', 'profile', 'offline_access'],
    redirectUri: `http://localhost:${DEFAULT_PORT}/oauth/callback/codex`,
    flowType: 'pkce'
  }

  /**
   * Start Codex OAuth flow with PKCE
   */
  async startAuth(): Promise<OAuthStartResult> {
    const state = generateState()
    const { codeVerifier, codeChallenge } = generatePKCE()

    const authUrl = buildAuthUrl(this.config, state, {
      // PKCE parameters
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      // OpenAI specific parameters
      prompt: 'login',
      // Include organization info in ID token
      id_token_add_organizations: 'true',
      // Simplified flow for CLI
      codex_cli_simplified_flow: 'true'
    })

    log.info(`[Codex OAuth] Starting auth flow with PKCE, state: ${state.substring(0, 8)}...`)

    return {
      authUrl,
      state,
      codeVerifier
    }
  }

  /**
   * Handle OAuth callback from OpenAI
   * Exchanges authorization code for tokens using PKCE
   */
  async handleCallback(code: string, state: string, codeVerifier?: string): Promise<OAuthToken> {
    if (!codeVerifier) {
      throw new Error('PKCE code_verifier is required for Codex OAuth')
    }

    log.info(`[Codex OAuth] Handling callback with PKCE, state: ${state.substring(0, 8)}...`)

    const token = await exchangeCodeForTokenPKCE(this.config, code, codeVerifier)

    log.info(`[Codex OAuth] Token obtained, expires at: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`)

    return token
  }

  /**
   * Refresh Codex access token
   */
  async refreshToken(refreshToken: string): Promise<OAuthToken> {
    log.info('[Codex OAuth] Refreshing token')

    const token = await refreshAccessToken(this.config, refreshToken)

    // Keep old refresh_token if new one not returned
    if (!token.refreshToken) {
      token.refreshToken = refreshToken
    }

    log.info(`[Codex OAuth] Token refreshed, expires at: ${token.expiresAt ? new Date(token.expiresAt).toISOString() : 'never'}`)

    return token
  }
}

// Export singleton instance
export const codexOAuthProvider = new CodexOAuthProvider()
