/**
 * OAuth Provider Registry
 *
 * Manages registration and lookup of OAuth providers.
 * Provides a centralized place to access all available providers.
 */

import type { OAuthProviderType } from '../types'
import type { OAuthProvider } from './provider'
import { geminiOAuthProvider } from './providers/gemini'
import { codexOAuthProvider } from './providers/codex'
import { qwenOAuthProvider } from './providers/qwen'
import { getMainLogger } from '../logger'

const log = getMainLogger()

/**
 * OAuth Provider Registry
 * Singleton that manages all OAuth providers
 */
class OAuthProviderRegistry {
  private providers: Map<OAuthProviderType, OAuthProvider> = new Map()

  /**
   * Register a provider
   */
  register(provider: OAuthProvider): void {
    if (this.providers.has(provider.name)) {
      log.warn(`[OAuth Registry] Provider "${provider.name}" already registered, overwriting`)
    }
    this.providers.set(provider.name, provider)
    log.info(`[OAuth Registry] Registered provider: ${provider.name} (${provider.displayName})`)
  }

  /**
   * Get provider by name
   */
  get(name: OAuthProviderType): OAuthProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * Get all registered providers
   */
  getAll(): OAuthProvider[] {
    return Array.from(this.providers.values())
  }

  /**
   * Get all provider names
   */
  getNames(): OAuthProviderType[] {
    return Array.from(this.providers.keys())
  }

  /**
   * Check if provider is registered
   */
  has(name: OAuthProviderType): boolean {
    return this.providers.has(name)
  }

  /**
   * Get provider count
   */
  get size(): number {
    return this.providers.size
  }

  /**
   * Clear all providers (for testing)
   */
  clear(): void {
    this.providers.clear()
  }
}

// Export singleton instance
export const oauthProviderRegistry = new OAuthProviderRegistry()

/**
 * Register all built-in OAuth providers
 * Call this during application startup
 */
export function registerOAuthProviders(): void {
  oauthProviderRegistry.register(geminiOAuthProvider)
  oauthProviderRegistry.register(codexOAuthProvider)
  oauthProviderRegistry.register(qwenOAuthProvider)

  log.info(`[OAuth Registry] Registered ${oauthProviderRegistry.size} OAuth providers`)
}

// Export individual providers for direct access
export { geminiOAuthProvider } from './providers/gemini'
export { codexOAuthProvider } from './providers/codex'
export { qwenOAuthProvider } from './providers/qwen'
