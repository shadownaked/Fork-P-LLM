/**
 * Clerk Token Refresh Module
 *
 * Handles automatic token refresh for sites using Clerk authentication.
 * Clerk uses short-lived JWT tokens (60 seconds) that need to be refreshed
 * using the session cookie.
 */

import { getMainLogger } from './logger'
import { credentialStore } from './store'

const log = getMainLogger()

// Clerk API configuration
const CLERK_API_VERSION = '2025-11-10'
const CLERK_JS_VERSION = '5.117.0'

/**
 * Clerk token response structure
 */
interface ClerkTokenResponse {
  jwt: string
  // Other fields we don't need
}

/**
 * Parse JWT token and extract expiration time
 */
function parseJwtExpiration(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    return payload.exp ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Extract Clerk base URL from site's target URL
 * Convention: clerk.{domain} (e.g., clerk.orchids.app for orchids.app)
 */
function getClerkBaseUrl(targetUrl: string): string {
  try {
    const url = new URL(targetUrl)
    // Extract the main domain (e.g., orchids.app from www.orchids.app)
    const parts = url.hostname.split('.')
    const mainDomain = parts.length > 2 ? parts.slice(-2).join('.') : url.hostname
    return `https://clerk.${mainDomain}`
  } catch {
    return ''
  }
}

/**
 * Refresh Clerk token for a site
 *
 * Uses the stored Clerk session info to get a new JWT token.
 *
 * @param siteId - The site ID to refresh token for
 * @param clerkBaseUrl - Optional Clerk base URL (auto-detected from site if not provided)
 * @returns New JWT token or null if refresh failed
 */
export async function refreshClerkToken(siteId: string, clerkBaseUrl?: string): Promise<string | null> {
  const credential = credentialStore.getCredential(siteId)

  if (!credential) {
    log.warn(`[Clerk] No credential found for site: ${siteId}`)
    return null
  }

  const { clerkSessionId, clerkClientToken } = credential

  if (!clerkSessionId || !clerkClientToken) {
    log.warn(`[Clerk] Missing Clerk session info for site: ${siteId}. Please open the site in browser first.`)
    return null
  }

  // Get Clerk base URL from site config if not provided
  const baseUrl = clerkBaseUrl || getClerkBaseUrl(credential.requestHeaders?.['Referer'] || '')
  if (!baseUrl) {
    log.warn(`[Clerk] Cannot determine Clerk base URL for site: ${siteId}`)
    return null
  }

  try {
    log.info(`[Clerk] Refreshing token for site ${siteId}, session: ${clerkSessionId.substring(0, 20)}...`)

    const url = `${baseUrl}/v1/client/sessions/${clerkSessionId}/tokens?__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`

    // Get origin from stored headers or derive from Clerk URL
    const origin = credential.requestHeaders?.['Origin'] || baseUrl.replace('clerk.', 'www.')
    const referer = credential.requestHeaders?.['Referer'] || `${origin}/`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': `__client=${clerkClientToken}`,
        'Origin': origin,
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      log.error(`[Clerk] Token refresh failed for ${siteId}: ${response.status} ${response.statusText}`)
      log.error(`[Clerk] Error response: ${errorText}`)

      // If 401/403, the session might be expired - clear Clerk session info
      if (response.status === 401 || response.status === 403) {
        log.warn(`[Clerk] Session expired for ${siteId}. Please re-authenticate in browser.`)
        credentialStore.setCredential(siteId, {
          ...credential,
          clerkSessionId: null,
          clerkClientToken: null
        })
      }

      return null
    }

    const data = await response.json() as ClerkTokenResponse

    if (!data.jwt) {
      log.error('[Clerk] No JWT in response')
      return null
    }

    const newToken = `Bearer ${data.jwt}`
    const expiresAt = parseJwtExpiration(data.jwt)

    // Update credential store with new token
    credentialStore.setCredential(siteId, {
      ...credential,
      authorization: newToken,
      expiresAt,
      capturedAt: Date.now()
    })

    log.info(`[Clerk] Token refreshed successfully for ${siteId}. Expires at: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`)

    return newToken
  } catch (error) {
    log.error(`[Clerk] Token refresh error for ${siteId}: ${error}`)
    return null
  }
}

/**
 * Check if Clerk token refresh is available for a site
 */
export function canRefreshClerkToken(siteId: string): boolean {
  const credential = credentialStore.getCredential(siteId)
  return !!(credential?.clerkSessionId && credential?.clerkClientToken)
}

/**
 * Check if a site's Clerk token is expired or about to expire
 *
 * @param siteId - The site ID to check
 * @param bufferSeconds - Consider expired if within this many seconds of expiry
 */
export function isClerkTokenExpired(siteId: string, bufferSeconds = 30): boolean {
  const credential = credentialStore.getCredential(siteId)

  if (!credential?.authorization) {
    return true
  }

  // Skip check for non-Bearer tokens
  if (!credential.authorization.startsWith('Bearer ')) {
    return false
  }

  const jwt = credential.authorization.substring(7)
  const expiresAt = parseJwtExpiration(jwt)

  if (!expiresAt) {
    return false // Can't determine expiry, assume not expired
  }

  const now = Date.now()
  const isExpired = expiresAt <= now + bufferSeconds * 1000

  if (isExpired) {
    log.debug(`[Clerk] Token for ${siteId} expired or expiring soon. exp=${new Date(expiresAt).toISOString()}, now=${new Date(now).toISOString()}`)
  }

  return isExpired
}

/**
 * Ensure a site has a valid Clerk token, refreshing if necessary
 *
 * @param siteId - The site ID to ensure token for
 * @returns true if a valid token is available, false otherwise
 */
export async function ensureClerkToken(siteId: string): Promise<boolean> {
  // Check if token is still valid
  if (!isClerkTokenExpired(siteId)) {
    return true
  }

  // Try to refresh
  if (!canRefreshClerkToken(siteId)) {
    log.warn(`[Clerk] Cannot refresh token for ${siteId} - no Clerk session info available`)
    return false
  }

  const newToken = await refreshClerkToken(siteId)
  return newToken !== null
}

// ============================================================================
// Legacy exports for backward compatibility (deprecated, use generic versions)
// ============================================================================

/** @deprecated Use isClerkTokenExpired(siteId) instead */
export function isOrchidsTokenExpired(bufferSeconds = 30): boolean {
  return isClerkTokenExpired('orchids', bufferSeconds)
}

/** @deprecated Use ensureClerkToken(siteId) instead */
export async function ensureOrchidsToken(): Promise<boolean> {
  return ensureClerkToken('orchids')
}
