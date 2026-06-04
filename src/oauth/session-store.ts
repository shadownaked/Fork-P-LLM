/**
 * OAuth Session Store
 *
 * Manages in-progress OAuth flows. Each session tracks:
 * - State parameter (unique identifier)
 * - Provider type
 * - PKCE code_verifier (if applicable)
 * - Device code (if using device flow)
 * - Status (pending, polling, completed, error)
 *
 * Sessions automatically expire after TTL to prevent memory leaks.
 */

import type { OAuthSession, OAuthProviderType } from '../types'

// Lazy logger to avoid Electron dependency in tests
type LogFn = (...args: unknown[]) => void
interface Logger {
  info: LogFn
  warn: LogFn
  debug: LogFn
}

let _log: Logger | null = null

function getLog(): Logger {
  if (!_log) {
    try {
      const { getMainLogger } = require('../logger')
      _log = getMainLogger()
    } catch {
      _log = {
        info: () => {},
        warn: () => {},
        debug: () => {}
      }
    }
  }
  return _log!
}

/**
 * Default TTL for OAuth sessions (10 minutes)
 * Most OAuth flows should complete within this time
 */
const DEFAULT_SESSION_TTL = 10 * 60 * 1000

/**
 * Extended TTL for device flow (15 minutes)
 * Device flow may take longer as user needs to visit URL manually
 */
const DEVICE_FLOW_SESSION_TTL = 15 * 60 * 1000

/**
 * Grace period after completion (1 minute)
 * Keeps session around briefly for status checks
 */
const COMPLETION_GRACE_PERIOD = 60 * 1000

class OAuthSessionStore {
  private sessions: Map<string, OAuthSession> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null

  constructor() {
    // Start periodic cleanup every minute
    this.cleanupInterval = setInterval(() => {
      this.purgeExpired()
    }, 60 * 1000)
  }

  /**
   * Register a new OAuth session
   */
  register(
    state: string,
    provider: OAuthProviderType,
    options?: {
      codeVerifier?: string
      deviceCode?: string
      userCode?: string
      pollInterval?: number
      ttl?: number
    }
  ): OAuthSession {
    // Purge expired sessions first
    this.purgeExpired()

    const now = Date.now()
    const ttl = options?.ttl || (options?.deviceCode ? DEVICE_FLOW_SESSION_TTL : DEFAULT_SESSION_TTL)

    const session: OAuthSession = {
      state,
      provider,
      codeVerifier: options?.codeVerifier,
      deviceCode: options?.deviceCode,
      userCode: options?.userCode,
      pollInterval: options?.pollInterval,
      createdAt: now,
      expiresAt: now + ttl,
      status: options?.deviceCode ? 'polling' : 'pending'
    }

    this.sessions.set(state, session)
    getLog().info(`[OAuth] Session registered: ${state} (provider: ${provider}, status: ${session.status})`)

    return session
  }

  /**
   * Get session by state
   */
  get(state: string): OAuthSession | undefined {
    const session = this.sessions.get(state)

    // Check if expired
    if (session && session.expiresAt < Date.now()) {
      this.sessions.delete(state)
      return undefined
    }

    return session
  }

  /**
   * Get all active sessions
   */
  getAll(): OAuthSession[] {
    this.purgeExpired()
    return Array.from(this.sessions.values())
  }

  /**
   * Get sessions by provider
   */
  getByProvider(provider: OAuthProviderType): OAuthSession[] {
    this.purgeExpired()
    return Array.from(this.sessions.values()).filter(s => s.provider === provider)
  }

  /**
   * Update session status to 'polling' (for device flow)
   */
  setPolling(state: string): void {
    const session = this.sessions.get(state)
    if (session) {
      session.status = 'polling'
      getLog().info(`[OAuth] Session ${state} status -> polling`)
    }
  }

  /**
   * Mark session as completed
   * Extends TTL slightly to allow status checks
   */
  complete(state: string): void {
    const session = this.sessions.get(state)
    if (session) {
      session.status = 'completed'
      session.expiresAt = Date.now() + COMPLETION_GRACE_PERIOD
      getLog().info(`[OAuth] Session ${state} completed`)
    }
  }

  /**
   * Mark session as error
   */
  setError(state: string, error: string): void {
    const session = this.sessions.get(state)
    if (session) {
      session.status = 'error'
      session.error = error
      session.expiresAt = Date.now() + COMPLETION_GRACE_PERIOD
      getLog().warn(`[OAuth] Session ${state} error: ${error}`)
    }
  }

  /**
   * Delete a session
   */
  delete(state: string): boolean {
    const deleted = this.sessions.delete(state)
    if (deleted) {
      getLog().info(`[OAuth] Session ${state} deleted`)
    }
    return deleted
  }

  /**
   * Clear all sessions
   */
  clear(): void {
    const count = this.sessions.size
    this.sessions.clear()
    getLog().info(`[OAuth] Cleared ${count} sessions`)
  }

  /**
   * Get session count
   */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Check if session exists and is valid
   */
  has(state: string): boolean {
    return this.get(state) !== undefined
  }

  /**
   * Purge expired sessions
   */
  private purgeExpired(): void {
    const now = Date.now()
    let purged = 0

    for (const [state, session] of this.sessions) {
      if (session.expiresAt < now) {
        this.sessions.delete(state)
        purged++
      }
    }

    if (purged > 0) {
      getLog().debug(`[OAuth] Purged ${purged} expired sessions`)
    }
  }

  /**
   * Stop cleanup interval (for testing)
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

// Export singleton instance
export const oauthSessionStore = new OAuthSessionStore()

// Export class for testing
export { OAuthSessionStore }
