import type { Credentials, SiteCredential, OAuthCredentialData, OAuthToken, OAuthProviderType } from '../types'
import { getMainLogger } from '../logger'
import { isTokenExpired } from '../token-refresh'
import {
  getDataPath,
  atomicWriteJsonSync,
  safeReadJsonSync,
  migrateFile,
  createBackup,
  cleanupBackups
} from './storage'

const log = getMainLogger()

/**
 * Stored OAuth data structure
 */
interface StoredOAuthData {
  refreshToken: string | null
  idToken: string | null
  tokenType: string
  scope: string | null
  providerType: OAuthProviderType
  email?: string
  accountId?: string
  projectId?: string  // GCP project ID for Gemini
}

/**
 * Stored credential structure (with optional OAuth data)
 */
interface StoredCredentials {
  [siteId: string]: {
    authorization: string | null
    sessionId: string | null
    capturedAt: number | null
    expiresAt: number | null
    requestHeaders?: Record<string, string> | null
    oauth?: StoredOAuthData
    // Clerk-specific fields
    clerkSessionId?: string | null
    clerkClientToken?: string | null
  }
}

/**
 * Extended site credential with OAuth data
 */
interface SiteCredentialWithOAuth extends SiteCredential {
  oauth?: OAuthCredentialData
}

/**
 * Multi-site credential store with persistence
 * Stores credentials per site with automatic disk persistence
 *
 * Improvements:
 * - Uses stable userData directory (survives app updates)
 * - Atomic writes prevent data corruption
 * - Automatic migration from legacy data location
 * - OAuth token support with refresh_token storage
 */
class CredentialStore {
  private memoryCache: Map<string, SiteCredentialWithOAuth> = new Map()
  private storagePath: string

  constructor() {
    // Migrate from legacy location if needed
    migrateFile('credentials.json')

    // Use stable data path
    this.storagePath = getDataPath('credentials.json')
    this.loadFromDisk()
  }

  /**
   * Set credential for a specific site
   */
  setCredential(siteId: string, credential: Partial<SiteCredential>): void {
    const existing = this.memoryCache.get(siteId) || {
      siteId,
      authorization: null,
      sessionId: null,
      capturedAt: null,
      expiresAt: null,
      requestHeaders: null
    }

    const updated: SiteCredential = {
      ...existing,
      ...credential,
      siteId,
      capturedAt: Date.now()
    }

    this.memoryCache.set(siteId, updated)
    this.saveToDisk()
    log.info(`Credential updated for site: ${siteId}`)
  }

  /**
   * Set authorization for a specific site
   */
  setAuthorization(siteId: string, auth: string): void {
    this.setCredential(siteId, { authorization: auth })
    log.info(`Authorization captured for site: ${siteId}`)
  }

  /**
   * Set session ID for a specific site
   */
  setSessionId(siteId: string, sessionId: string): void {
    this.setCredential(siteId, { sessionId })
    log.info(`Session ID captured for site: ${siteId}, sessionId: ${sessionId}`)
  }

  /**
   * Get credential for a specific site
   */
  getCredential(siteId: string): SiteCredential | null {
    return this.memoryCache.get(siteId) || null
  }

  /**
   * Get credentials in legacy format (for backward compatibility)
   */
  getCredentials(siteId: string): Credentials {
    const cred = this.memoryCache.get(siteId)
    if (!cred) {
      return {
        authorization: null,
        sessionId: null,
        capturedAt: null,
        expiresAt: null,
        requestHeaders: null
      }
    }
    return {
      authorization: cred.authorization,
      sessionId: cred.sessionId,
      capturedAt: cred.capturedAt,
      expiresAt: cred.expiresAt,
      requestHeaders: cred.requestHeaders
    }
  }

  /**
   * Check if site has valid (non-expired) credentials
   * Supports: authorization header, cookie-based auth (COOKIE: prefix), or sessionId only
   * Also checks JWT token internal expiration for short-lived tokens (e.g., Clerk)
   *
   * @param siteId - The site ID to check
   * @param relaxedValidation - If true, only check for authorization and requestHeaders presence
   *                            (useful for Clerk-based auth where token refresh is handled separately)
   */
  hasValidCredential(siteId: string, relaxedValidation = false): boolean {
    const cred = this.memoryCache.get(siteId)
    if (!cred) return false

    // Relaxed validation: only require authorization and requestHeaders to be present
    // This allows API calls to proceed; if token is expired, API will return 401
    // and the caller can handle refresh
    if (relaxedValidation) {
      return !!(cred.authorization && cred.requestHeaders)
    }

    // Check stored expiration time
    if (cred.expiresAt && Date.now() > cred.expiresAt) {
      return false
    }

    // Check JWT token internal expiration (for short-lived tokens like Clerk)
    if (cred.authorization && !cred.authorization.startsWith('COOKIE:') && !cred.authorization.startsWith('REQUEST:')) {
      if (isTokenExpired(cred.authorization, 30)) {
        return false
      }
    }

    // Valid if has authorization (including COOKIE: prefix) or sessionId with requestHeaders
    if (cred.authorization) return true
    if (cred.sessionId && cred.requestHeaders) return true
    return false
  }

  /**
   * Get all site IDs with credentials
   */
  getAllSiteIds(): string[] {
    return Array.from(this.memoryCache.keys())
  }

  /**
   * Get all credentials
   */
  getAllCredentials(): Map<string, SiteCredential> {
    return new Map(this.memoryCache)
  }

  /**
   * Clear credential for a specific site
   */
  clearCredential(siteId: string): void {
    this.memoryCache.delete(siteId)
    this.saveToDisk()
    log.info(`Credential cleared for site: ${siteId}`)
  }

  /**
   * Clear all credentials
   */
  clearAll(): void {
    this.memoryCache.clear()
    this.saveToDisk()
    log.info('All credentials cleared')
  }

  // ===========================================================================
  // OAuth-specific methods
  // ===========================================================================

  /**
   * Set OAuth credential for a site
   * Stores both access token and OAuth metadata (refresh_token, etc.)
   */
  setOAuthCredential(
    siteId: string,
    token: OAuthToken,
    providerType: OAuthProviderType,
    extra?: { email?: string; accountId?: string; projectId?: string }
  ): void {
    const existing = this.memoryCache.get(siteId) || {
      siteId,
      authorization: null,
      sessionId: null,
      capturedAt: null,
      expiresAt: null,
      requestHeaders: null
    }

    const updated: SiteCredentialWithOAuth = {
      ...existing,
      siteId,
      authorization: `${token.tokenType} ${token.accessToken}`,
      capturedAt: Date.now(),
      expiresAt: token.expiresAt,
      oauth: {
        refreshToken: token.refreshToken,
        idToken: token.idToken,
        tokenType: token.tokenType,
        scope: token.scope,
        providerType,
        email: extra?.email,
        accountId: extra?.accountId,
        projectId: extra?.projectId
      }
    }

    this.memoryCache.set(siteId, updated)
    this.saveToDisk()
    log.info(`OAuth credential set for site: ${siteId} (provider: ${providerType}, projectId: ${extra?.projectId || 'none'})`)
  }

  /**
   * Get OAuth data for a site
   */
  getOAuthData(siteId: string): OAuthCredentialData | null {
    const cred = this.memoryCache.get(siteId)
    return cred?.oauth || null
  }

  /**
   * Check if site has OAuth credentials
   */
  hasOAuthCredential(siteId: string): boolean {
    const cred = this.memoryCache.get(siteId)
    return !!(cred?.oauth?.refreshToken || cred?.oauth?.providerType)
  }

  /**
   * Get refresh token for a site
   */
  getRefreshToken(siteId: string): string | null {
    const cred = this.memoryCache.get(siteId)
    return cred?.oauth?.refreshToken || null
  }

  /**
   * Get project ID for a site (for Gemini)
   */
  getProjectId(siteId: string): string | null {
    const cred = this.memoryCache.get(siteId)
    return cred?.oauth?.projectId || null
  }

  /**
   * Set project ID for a site
   */
  setProjectId(siteId: string, projectId: string): void {
    const cred = this.memoryCache.get(siteId)
    if (cred?.oauth) {
      cred.oauth.projectId = projectId
      this.saveToDisk()
      log.info(`Project ID set for site: ${siteId} -> ${projectId}`)
    }
  }

  /**
   * Update OAuth token after refresh
   * Preserves existing OAuth metadata while updating tokens
   */
  updateOAuthToken(siteId: string, token: OAuthToken): void {
    const existing = this.memoryCache.get(siteId)
    if (!existing?.oauth) {
      log.warn(`Cannot update OAuth token for ${siteId}: no existing OAuth data`)
      return
    }

    const updated: SiteCredentialWithOAuth = {
      ...existing,
      authorization: `${token.tokenType} ${token.accessToken}`,
      capturedAt: Date.now(),
      expiresAt: token.expiresAt,
      oauth: {
        ...existing.oauth,
        // Update tokens, keep metadata
        refreshToken: token.refreshToken || existing.oauth.refreshToken,
        idToken: token.idToken || existing.oauth.idToken,
        tokenType: token.tokenType,
        scope: token.scope || existing.oauth.scope
      }
    }

    this.memoryCache.set(siteId, updated)
    this.saveToDisk()
    log.info(`OAuth token updated for site: ${siteId}`)
  }

  /**
   * Get all OAuth site IDs
   */
  getOAuthSiteIds(): string[] {
    return Array.from(this.memoryCache.entries())
      .filter(([_, cred]) => cred.oauth?.providerType)
      .map(([siteId]) => siteId)
  }

  private loadFromDisk(): void {
    const result = safeReadJsonSync<StoredCredentials>(this.storagePath)

    if (result.success && result.data) {
      for (const [siteId, cred] of Object.entries(result.data)) {
        const credential: SiteCredentialWithOAuth = {
          siteId,
          authorization: cred.authorization,
          sessionId: cred.sessionId,
          capturedAt: cred.capturedAt,
          expiresAt: cred.expiresAt,
          requestHeaders: cred.requestHeaders || null,
          // Load Clerk-specific fields
          clerkSessionId: cred.clerkSessionId || null,
          clerkClientToken: cred.clerkClientToken || null
        }

        // Load OAuth data if present
        if (cred.oauth) {
          credential.oauth = {
            refreshToken: cred.oauth.refreshToken,
            idToken: cred.oauth.idToken,
            tokenType: cred.oauth.tokenType,
            scope: cred.oauth.scope,
            providerType: cred.oauth.providerType,
            email: cred.oauth.email,
            accountId: cred.oauth.accountId,
            projectId: cred.oauth.projectId
          }
        }

        this.memoryCache.set(siteId, credential)
      }
      log.info(`Loaded ${this.memoryCache.size} credentials from disk`)
    } else if (result.error && result.error.code !== 'FILE_NOT_FOUND') {
      log.warn(`Failed to load credentials: ${result.error.message}`)
    }
  }

  private saveToDisk(): void {
    try {
      const toStore: StoredCredentials = {}
      for (const [siteId, cred] of this.memoryCache) {
        toStore[siteId] = {
          authorization: cred.authorization,
          sessionId: cred.sessionId,
          capturedAt: cred.capturedAt,
          expiresAt: cred.expiresAt,
          requestHeaders: cred.requestHeaders,
          // Save Clerk-specific fields
          clerkSessionId: cred.clerkSessionId,
          clerkClientToken: cred.clerkClientToken
        }

        // Save OAuth data if present
        if (cred.oauth) {
          toStore[siteId].oauth = {
            refreshToken: cred.oauth.refreshToken,
            idToken: cred.oauth.idToken,
            tokenType: cred.oauth.tokenType,
            scope: cred.oauth.scope,
            providerType: cred.oauth.providerType,
            email: cred.oauth.email,
            accountId: cred.oauth.accountId,
            projectId: cred.oauth.projectId
          }
        }
      }

      // Create backup before writing (keep last 5)
      createBackup(this.storagePath)
      cleanupBackups(this.storagePath, 5)

      // Atomic write to prevent corruption
      atomicWriteJsonSync(this.storagePath, toStore)
    } catch (error) {
      log.error('Failed to save credentials to disk:', error)
    }
  }
}

export const credentialStore = new CredentialStore()
