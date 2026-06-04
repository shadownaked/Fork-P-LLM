import { session } from 'electron'
import { credentialStore, siteStore, requestStore, modelStore } from './store'
import { adapterRegistry } from './adapters'
import type { CaptureRule, SiteConfig, Adapter, WebSocketAdapter } from './types'
import { getMainLogger, getSiteNetworkLogger } from './logger'

const log = getMainLogger()

/**
 * Parse JWT token and extract expiration time
 * @param token JWT token (with or without "Bearer " prefix)
 * @returns expiration timestamp in milliseconds, or null if not a JWT or no exp claim
 */
function parseJwtExpiration(token: string): number | null {
  if (!token) return null

  // Remove Bearer prefix if present
  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null // Not a JWT

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    const exp = payload.exp

    if (!exp) return null // No expiry claim

    return exp * 1000 // Convert to milliseconds
  } catch {
    return null // Can't parse, not a JWT
  }
}

/**
 * Protocol Handler using Electron's webRequest API
 * Monitors HTTPS requests to capture credentials for multiple sites
 * Uses non-blocking listeners that don't interfere with request flow
 */
export class ProtocolHandler {
  // Cache for site URL patterns to avoid repeated regex compilation
  private patternCache: Map<string, RegExp> = new Map()

  /**
   * Register the request monitoring handlers on default session
   */
  register(): void {
    this.registerForSession(session.defaultSession)
    log.info('WebRequest handlers registered')
  }

  /**
   * Register the request monitoring handlers on a specific session
   * Used for isolated session partitions (e.g., target windows with proxy)
   */
  registerForSession(targetSession: Electron.Session): void {
    targetSession.webRequest.onSendHeaders(
      { urls: ['*://*/*'] },
      (details) => {
        this.handleRequest(details)
      }
    )
  }

  private handleRequest(details: Electron.OnSendHeadersListenerDetails): void {
    const url = details.url

    // Skip non-http(s) requests
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return
    }

    // Check all sites for special auto-capture patterns
    for (const site of siteStore.getEnabled()) {
      const adapter = adapterRegistry.getForSite(site)
      if (adapter?.capabilities?.autoCapture) {
        const { clerkSessionPattern, sessionIdPattern } = adapter.capabilities.autoCapture

        // Capture Clerk session info if pattern matches
        if (clerkSessionPattern && url.includes(clerkSessionPattern) &&
            url.includes('/sessions/') && url.includes('/tokens')) {
          this.captureClerkSession(details, site.id)
        }

        // Auto-capture sessionId from URL if pattern matches
        if (sessionIdPattern && this.urlBelongsToSite(url, site)) {
          this.captureSessionIdFromUrl(details, site.id, sessionIdPattern)
        }
      }
    }

    // Find matching site by targetUrl (broad match) or captureRules (specific match)
    const { site, isRecommended } = this.findMatchingSiteWithRecommendation(url)

    if (site) {
      // Log to site-specific network log
      const siteLog = getSiteNetworkLogger(site.id)
      siteLog.debug(`[${details.method}] ${url}`)

      // Store request info with recommendation flag
      this.storeRequest(details, site.id, isRecommended)

      // Try to capture credentials using existing rules (only for recommended requests)
      if (isRecommended) {
        const rule = this.findMatchingRule(site, url)
        if (rule) {
          this.captureCredentials(details, site.id, rule)
        }
      }
    }
  }

  /**
   * Capture Clerk session information for token refresh
   * Extracts sessionId and __client cookie from Clerk token requests
   */
  private captureClerkSession(details: Electron.OnSendHeadersListenerDetails, siteId: string): void {
    try {
      const url = details.url

      // Extract session ID from URL: /sessions/{sessionId}/tokens
      const sessionMatch = url.match(/\/sessions\/([^/]+)\/tokens/)
      if (!sessionMatch) {
        return
      }
      const clerkSessionId = sessionMatch[1]

      // Extract __client cookie from headers
      const cookieHeader = details.requestHeaders?.['Cookie'] || details.requestHeaders?.['cookie']
      if (!cookieHeader) {
        log.debug(`[Clerk] No cookie header found in token request for ${siteId}`)
        return
      }

      const cookieStr = String(cookieHeader)

      // Parse __client cookie
      const clientMatch = cookieStr.match(/__client=([^;]+)/)
      if (!clientMatch) {
        log.debug(`[Clerk] No __client cookie found for ${siteId}`)
        return
      }
      const clientToken = clientMatch[1]

      // Store Clerk session info in credential store
      const existingCred = credentialStore.getCredential(siteId)
      credentialStore.setCredential(siteId, {
        ...existingCred,
        clerkSessionId,
        clerkClientToken: clientToken
      })

      log.info(`[Clerk] Captured session info for ${siteId}: sessionId=${clerkSessionId.substring(0, 20)}...`)
    } catch (error) {
      log.warn(`[Clerk] Failed to capture session info for ${siteId}: ${error}`)
    }
  }

  /**
   * Auto-capture sessionId from URL using adapter-defined pattern
   */
  private captureSessionIdFromUrl(details: Electron.OnSendHeadersListenerDetails, siteId: string, pattern: RegExp): void {
    try {
      const url = details.url
      const match = url.match(pattern)
      if (!match || !match[1]) {
        return
      }

      const sessionId = match[1]
      const existingCred = credentialStore.getCredential(siteId)

      // Only update if sessionId changed
      if (existingCred?.sessionId !== sessionId) {
        credentialStore.setCredential(siteId, {
          ...existingCred,
          sessionId
        })
        log.info(`[${siteId}] Auto-captured sessionId: ${sessionId}`)
      }
    } catch (error) {
      log.warn(`[${siteId}] Failed to capture sessionId: ${error}`)
    }
  }

  private storeRequest(details: Electron.OnSendHeadersListenerDetails, siteId: string, isRecommended: boolean): void {
    try {
      // Convert headers to plain object
      const headers: Record<string, string> = {}
      if (details.requestHeaders) {
        for (const [key, value] of Object.entries(details.requestHeaders)) {
          headers[key] = String(value)
        }
      }

      requestStore.addRequest(siteId, {
        method: details.method,
        url: details.url,
        headers,
        body: null,
        contentType: headers['Content-Type'] || headers['content-type'] || null,
        isRecommended
      })
    } catch (error) {
      log.warn(`Failed to store request: ${error}`)
    }
  }

  /**
   * Find matching site and determine if the request is recommended (matches captureRules)
   */
  private findMatchingSiteWithRecommendation(url: string): { site: SiteConfig | null; isRecommended: boolean } {
    for (const site of siteStore.getEnabled()) {
      // Check if URL matches captureRules (recommended)
      for (const rule of site.captureRules) {
        if (this.matchUrlPattern(url, rule.urlPattern)) {
          return { site, isRecommended: true }
        }
      }

      // Check if URL belongs to site's target domain (broad match, not recommended)
      if (this.urlBelongsToSite(url, site)) {
        return { site, isRecommended: false }
      }
    }
    return { site: null, isRecommended: false }
  }

  /**
   * Check if URL belongs to the site's target domain
   */
  private urlBelongsToSite(url: string, site: SiteConfig): boolean {
    try {
      const urlObj = new URL(url)
      const targetObj = new URL(site.targetUrl)

      // Match by domain (including subdomains)
      const urlHost = urlObj.hostname.toLowerCase()
      const targetHost = targetObj.hostname.toLowerCase()

      // Direct match or subdomain match
      if (urlHost === targetHost || urlHost.endsWith('.' + targetHost)) {
        return true
      }

      // Also check if the URL contains the site name (for CDN/API subdomains)
      const siteName = site.id.toLowerCase()
      if (urlHost.includes(siteName)) {
        return true
      }

      return false
    } catch {
      return false
    }
  }

  private findMatchingSite(url: string): SiteConfig | null {
    for (const site of siteStore.getEnabled()) {
      // Check if URL belongs to this site (match any rule's pattern)
      for (const rule of site.captureRules) {
        if (this.matchUrlPattern(url, rule.urlPattern)) {
          return site
        }
      }
    }
    return null
  }

  private findMatchingRule(site: SiteConfig, url: string): CaptureRule | null {
    for (const rule of site.captureRules) {
      if (this.matchUrlPattern(url, rule.urlPattern)) {
        return rule
      }
    }
    return null
  }

  private captureCredentials(
    details: Electron.OnSendHeadersListenerDetails,
    siteId: string,
    rule: CaptureRule
  ): void {
    // Capture Authorization header
    if (rule.captureAuth && details.requestHeaders) {
      const authHeader = rule.authHeader || 'Authorization'

      // Case-insensitive header lookup
      const headerKeys = Object.keys(details.requestHeaders)
      const matchedKey = headerKeys.find(k => k.toLowerCase() === authHeader.toLowerCase())

      if (matchedKey) {
        const auth = details.requestHeaders[matchedKey]
        if (auth) {
          const authStr = String(auth)

          // Parse JWT expiration time
          const expiresAt = parseJwtExpiration(authStr)

          // Check if new token is better than existing one
          const existingCred = credentialStore.getCredential(siteId)
          if (existingCred?.expiresAt && expiresAt) {
            if (expiresAt <= existingCred.expiresAt) {
              // New token is not newer than existing one, skip
              log.debug(`Skipping older token for site "${siteId}"`)
              return
            }
          }

          // Check if token is already expired
          if (expiresAt && expiresAt < Date.now()) {
            log.debug(`Skipping expired token for site "${siteId}"`)
            return
          }

          // Capture complete requestHeaders
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(details.requestHeaders)) {
            headers[key] = String(value)
          }

          // Store complete credential (preserve existing Clerk session info)
          const existingCredForUpdate = credentialStore.getCredential(siteId)
          credentialStore.setCredential(siteId, {
            ...existingCredForUpdate,  // Preserve clerkSessionId, clerkClientToken, etc.
            authorization: authStr,
            requestHeaders: headers,
            expiresAt
          })

          log.info(`Captured auth for site "${siteId}" from:`, details.url)
          log.info(`Token expires at: ${expiresAt ? new Date(expiresAt).toISOString() : 'unknown'}`)

          // Register static models if adapter has them defined
          const site = siteStore.getById(siteId)
          if (site) {
            const adapter = adapterRegistry.getForSite(site)
            if (adapter?.capabilities?.staticModels && 'getStaticModels' in adapter) {
              const httpAdapter = adapter as Adapter
              const staticModels = httpAdapter.getStaticModels?.()
              if (staticModels && staticModels.length > 0) {
                modelStore.setModels(siteId, staticModels)
                log.info(`Registered ${staticModels.length} static models for ${siteId}`)
              }
            }
          }
        }
      }
    }

    // Capture sessionId from URL query parameter or path
    if (rule.captureSessionId && rule.sessionIdField) {
      const sessionId = this.extractSessionIdFromUrl(details.url, rule.sessionIdField)
      if (sessionId) {
        credentialStore.setSessionId(siteId, sessionId)
        log.info(`Captured sessionId (${rule.sessionIdField}=${sessionId}) for site "${siteId}" from:`, details.url)
      }
    }

    // Capture cookies as authorization for sites that use cookie-based auth
    // BUT: Don't overwrite existing Bearer token with cookies
    if (!rule.captureAuth && details.requestHeaders) {
      // Check if we already have a valid Bearer token - don't overwrite with cookies
      const existingCred = credentialStore.getCredential(siteId)
      if (existingCred?.authorization?.startsWith('Bearer ')) {
        // Already have Bearer token, skip cookie capture
        log.debug(`Skipping cookie capture for site "${siteId}" - already have Bearer token`)
        return
      }

      const headerKeys = Object.keys(details.requestHeaders)
      const cookieKey = headerKeys.find(k => k.toLowerCase() === 'cookie')
      if (cookieKey) {
        const cookie = details.requestHeaders[cookieKey]
        if (cookie) {
          // Store cookie as authorization with COOKIE: prefix
          credentialStore.setAuthorization(siteId, `COOKIE:${cookie}`)
          // Also store all request headers for forwarding
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(details.requestHeaders)) {
            headers[key] = String(value)
          }
          credentialStore.setCredential(siteId, { requestHeaders: headers })
          log.info(`Captured cookies for site "${siteId}" from:`, details.url)
        }
      }
    }
  }

  private extractSessionIdFromUrl(url: string, fieldName: string): string | null {
    try {
      const urlObj = new URL(url)

      // Try to extract from query parameter
      const queryValue = urlObj.searchParams.get(fieldName)
      if (queryValue) {
        return queryValue
      }

      // Try to extract from path (e.g., /projects/{projectId}/...)
      // Look for UUID-like patterns after the field name in path
      const pathMatch = urlObj.pathname.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
      if (pathMatch) {
        return pathMatch[1]
      }

      return null
    } catch {
      return null
    }
  }

  private matchUrlPattern(url: string, pattern: string): boolean {
    // Use cached regex if available
    let regex = this.patternCache.get(pattern)
    if (!regex) {
      const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
      regex = new RegExp(regexPattern)
      this.patternCache.set(pattern, regex)
    }
    return regex.test(url)
  }
}
