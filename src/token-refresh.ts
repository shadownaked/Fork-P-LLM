/**
 * Token refresh utilities
 *
 * Provides automatic token refresh for JWT-based authentication.
 * When a token is expired, it can trigger a page reload to get a fresh token.
 *
 * Also supports OAuth token refresh using refresh_token.
 */

import { getMainLogger } from './logger'
import { credentialStore } from './store'
import { oauthProviderRegistry } from './oauth'

const log = getMainLogger()

/**
 * Check if a string looks like a valid JWT token
 * JWT format: header.payload.signature (3 parts, base64url encoded)
 */
function isJwtFormat(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  // Check if each part is valid base64url (alphanumeric, -, _, no padding required)
  const base64urlRegex = /^[A-Za-z0-9_-]+$/
  for (const part of parts) {
    if (!part || !base64urlRegex.test(part)) return false
  }

  // Try to decode header to verify it's valid JSON with expected fields
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
    // JWT header should have 'alg' field
    if (typeof header !== 'object' || !header.alg) return false
  } catch {
    return false
  }

  return true
}

/**
 * Check if a JWT token is expired or about to expire
 * @param token JWT token (with or without "Bearer " prefix)
 * @param bufferSeconds Seconds before actual expiry to consider as expired (default: 60)
 * @returns true if expired or will expire within buffer time
 */
export function isTokenExpired(token: string | null, bufferSeconds = 60): boolean {
  if (!token) return true

  // Remove Bearer prefix if present
  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  // Quick check: not a JWT format, assume not expired
  if (!isJwtFormat(jwt)) {
    return false
  }

  try {
    const parts = jwt.split('.')
    // Use base64url decoding for proper JWT handling
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    const exp = payload.exp

    if (!exp) return false // No expiry claim

    const now = Math.floor(Date.now() / 1000)
    const isExpired = exp <= now + bufferSeconds

    return isExpired
  } catch (err) {
    log.debug(`[TokenRefresh] Failed to parse JWT payload: ${err}`)
    return false // Can't parse, assume not expired
  }
}

/**
 * Get token expiry time
 * @param token JWT token (with or without "Bearer " prefix)
 * @returns expiry timestamp in milliseconds, or null if not a JWT
 */
export function getTokenExpiry(token: string | null): number | null {
  if (!token) return null

  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  // Quick check: not a JWT format
  if (!isJwtFormat(jwt)) {
    return null
  }

  try {
    const parts = jwt.split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return payload.exp ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Token refresh state management
 */
interface RefreshState {
  inProgress: boolean
  promise: Promise<boolean> | null
  lastAttempt: number
}

const refreshStates = new Map<string, RefreshState>()

/**
 * Get or create refresh state for a site
 */
function getRefreshState(siteId: string): RefreshState {
  let state = refreshStates.get(siteId)
  if (!state) {
    state = { inProgress: false, promise: null, lastAttempt: 0 }
    refreshStates.set(siteId, state)
  }
  return state
}

/**
 * Request a token refresh for a site
 * This is called by api-server when it detects an expired token.
 *
 * @param siteId Site ID to refresh
 * @param refreshFn Function that performs the actual refresh (e.g., opens hidden window)
 * @param timeoutMs Maximum time to wait for refresh (default: 30 seconds)
 * @returns Promise that resolves to true if refresh succeeded
 */
export async function requestTokenRefresh(
  siteId: string,
  refreshFn: () => Promise<void>,
  timeoutMs = 30000
): Promise<boolean> {
  const state = getRefreshState(siteId)

  // If refresh is already in progress, wait for it
  if (state.inProgress && state.promise) {
    log.info(`[TokenRefresh] Refresh already in progress for ${siteId}, waiting...`)
    return state.promise
  }

  // Rate limit: don't refresh more than once per 10 seconds
  const now = Date.now()
  if (now - state.lastAttempt < 10000) {
    log.warn(`[TokenRefresh] Rate limited for ${siteId}, last attempt was ${now - state.lastAttempt}ms ago`)
    return false
  }

  state.inProgress = true
  state.lastAttempt = now

  state.promise = new Promise<boolean>((resolve) => {
    log.info(`[TokenRefresh] Starting refresh for ${siteId}`)

    // Set timeout
    const timeout = setTimeout(() => {
      log.warn(`[TokenRefresh] Refresh timeout for ${siteId}`)
      state.inProgress = false
      state.promise = null
      resolve(false)
    }, timeoutMs)

    // Perform refresh
    refreshFn()
      .then(() => {
        // Wait a bit for token to be captured
        setTimeout(() => {
          clearTimeout(timeout)
          log.info(`[TokenRefresh] Refresh completed for ${siteId}`)
          state.inProgress = false
          state.promise = null
          resolve(true)
        }, 3000) // Wait 3 seconds for token capture
      })
      .catch((err) => {
        clearTimeout(timeout)
        log.error(`[TokenRefresh] Refresh failed for ${siteId}:`, err)
        state.inProgress = false
        state.promise = null
        resolve(false)
      })
  })

  return state.promise
}

/**
 * Notify that a token has been refreshed
 * Called when a new token is captured
 */
export function notifyTokenRefreshed(siteId: string): void {
  const state = refreshStates.get(siteId)
  if (state) {
    log.info(`[TokenRefresh] Token refreshed notification for ${siteId}`)
    // The promise will resolve on its own after the wait period
  }
}

/**
 * Check if a refresh is in progress for a site
 */
export function isRefreshInProgress(siteId: string): boolean {
  const state = refreshStates.get(siteId)
  return state?.inProgress || false
}

// ============================================================================
// OAuth Token Refresh
// ============================================================================

/**
 * Refresh OAuth token for a site using refresh_token
 *
 * @param siteId Site ID with OAuth credentials
 * @returns true if refresh succeeded, false otherwise
 */
export async function refreshOAuthToken(siteId: string): Promise<boolean> {
  const oauthData = credentialStore.getOAuthData(siteId)

  if (!oauthData) {
    log.warn(`[TokenRefresh] No OAuth data for site ${siteId}`)
    return false
  }

  if (!oauthData.refreshToken) {
    log.warn(`[TokenRefresh] No refresh_token for site ${siteId}`)
    return false
  }

  const provider = oauthProviderRegistry.get(oauthData.providerType)
  if (!provider) {
    log.warn(`[TokenRefresh] Unknown OAuth provider: ${oauthData.providerType}`)
    return false
  }

  // Check rate limit
  const state = getRefreshState(siteId)
  const now = Date.now()
  if (now - state.lastAttempt < 10000) {
    log.warn(`[TokenRefresh] OAuth refresh rate limited for ${siteId}`)
    return false
  }

  state.lastAttempt = now

  try {
    log.info(`[TokenRefresh] Refreshing OAuth token for ${siteId} (provider: ${oauthData.providerType})`)

    const newToken = await provider.refreshToken(oauthData.refreshToken)

    // Update stored credentials
    credentialStore.updateOAuthToken(siteId, newToken)

    log.info(`[TokenRefresh] OAuth token refreshed for ${siteId}, expires at: ${newToken.expiresAt ? new Date(newToken.expiresAt).toISOString() : 'never'}`)

    return true
  } catch (err) {
    log.error(`[TokenRefresh] OAuth refresh failed for ${siteId}:`, err)
    return false
  }
}

/**
 * Check if a site has OAuth credentials that can be refreshed
 */
export function canRefreshOAuth(siteId: string): boolean {
  const oauthData = credentialStore.getOAuthData(siteId)
  if (!oauthData?.refreshToken) return false

  const provider = oauthProviderRegistry.get(oauthData.providerType)
  return !!provider
}

/**
 * Smart token refresh - tries OAuth refresh first, then falls back to page reload
 *
 * @param siteId Site ID to refresh
 * @param fallbackRefreshFn Fallback function for non-OAuth refresh
 * @returns true if refresh succeeded
 */
export async function smartTokenRefresh(
  siteId: string,
  fallbackRefreshFn?: () => Promise<void>
): Promise<boolean> {
  // Try OAuth refresh first
  if (canRefreshOAuth(siteId)) {
    const success = await refreshOAuthToken(siteId)
    if (success) return true
    log.warn(`[TokenRefresh] OAuth refresh failed for ${siteId}, trying fallback...`)
  }

  // Fall back to page reload if available
  if (fallbackRefreshFn) {
    return requestTokenRefresh(siteId, fallbackRefreshFn)
  }

  log.warn(`[TokenRefresh] No refresh method available for ${siteId}`)
  return false
}
