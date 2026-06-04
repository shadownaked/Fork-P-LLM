/**
 * Adapter Registry
 *
 * Central registry for all adapters with factory pattern support.
 * Allows dynamic registration and creation of adapters without modifying core code.
 */

import type { Adapter, WebSocketAdapter, SiteConfig } from '../types'
import { getMainLogger } from '../logger'
import { createOpenAIAdapter, type OpenAIAdapterConfig } from './common/openai'
import { createTemplateAdapter, type TemplateAdapterConfig } from './template-adapter'

const log = getMainLogger()

/**
 * Type guard to check if adapter is WebSocket adapter
 */
export function isWebSocketAdapter(adapter: Adapter | WebSocketAdapter): adapter is WebSocketAdapter {
  return 'isWebSocket' in adapter && adapter.isWebSocket === true
}

/**
 * Adapter factory function type
 */
export type AdapterFactory<T = Adapter | WebSocketAdapter> = (config?: Record<string, unknown>) => T

/**
 * Adapter registration entry
 */
interface AdapterEntry {
  adapter?: Adapter | WebSocketAdapter
  factory?: AdapterFactory
  isWebSocket: boolean
}

/**
 * Adapter Registry Class
 *
 * Manages adapter registration and retrieval with support for:
 * - Static adapter instances
 * - Factory functions for dynamic adapter creation
 * - Site-specific configuration
 */
class AdapterRegistry {
  private adapters: Map<string, AdapterEntry> = new Map()

  /**
   * Register a static adapter instance
   */
  register(adapter: Adapter): void {
    this.adapters.set(adapter.name, {
      adapter,
      isWebSocket: false
    })
    log.info(`Registered adapter: ${adapter.name}`)
  }

  /**
   * Register a WebSocket adapter instance
   */
  registerWebSocket(adapter: WebSocketAdapter): void {
    this.adapters.set(adapter.name, {
      adapter,
      isWebSocket: true
    })
    log.info(`Registered WebSocket adapter: ${adapter.name}`)
  }

  /**
   * Register an adapter factory function
   * Factory functions are called with site-specific config to create adapters
   */
  registerFactory(name: string, factory: AdapterFactory, isWebSocket = false): void {
    this.adapters.set(name, {
      factory,
      isWebSocket
    })
    log.info(`Registered adapter factory: ${name}`)
  }

  /**
   * Get adapter by name (static instance only)
   */
  getByName(name: string): Adapter | undefined {
    const entry = this.adapters.get(name)
    if (entry && !entry.isWebSocket && entry.adapter) {
      return entry.adapter as Adapter
    }
    return undefined
  }

  /**
   * Get WebSocket adapter by name (static instance only)
   */
  getWebSocketByName(name: string): WebSocketAdapter | undefined {
    const entry = this.adapters.get(name)
    if (entry && entry.isWebSocket && entry.adapter) {
      return entry.adapter as WebSocketAdapter
    }
    return undefined
  }

  /**
   * Get any adapter (HTTP or WebSocket) by name
   */
  getAnyByName(name: string): Adapter | WebSocketAdapter | undefined {
    const entry = this.adapters.get(name)
    return entry?.adapter
  }

  /**
   * Get adapter for a site with site-specific configuration
   *
   * This is the primary method for getting adapters. It handles:
   * 1. OpenAI adapter with apiUrl configuration
   * 2. Template/generic adapters with format configuration
   * 3. Special adapters
   * 4. Factory-based adapter creation
   */
  getForSite(site: SiteConfig): Adapter | WebSocketAdapter | undefined {
    const adapterType = site.adapterType

    // Handle OpenAI adapter with configuration
    if (adapterType === 'openai') {
      const config = site.adapterConfig as OpenAIAdapterConfig | undefined
      if (config?.apiUrl) {
        return createOpenAIAdapter(config)
      }
      log.warn(`OpenAI adapter requires apiUrl in adapterConfig for site: ${site.id}`)
      return undefined
    }

    // Handle template/generic adapters
    if (adapterType === 'template' || adapterType === 'generic') {
      const config = site.adapterConfig as TemplateAdapterConfig | undefined
      return createTemplateAdapter(config)
    }

    // Check for registered entry
    const entry = this.adapters.get(adapterType)
    if (!entry) {
      log.warn(`Unknown adapter type: ${adapterType}`)
      return undefined
    }

    // If factory exists, create adapter with config
    if (entry.factory) {
      return entry.factory(site.adapterConfig)
    }

    // Return static adapter instance
    return entry.adapter
  }

  /**
   * Get adapter by URL pattern matching
   */
  getByUrl(url: string): Adapter | WebSocketAdapter | undefined {
    for (const entry of this.adapters.values()) {
      if (!entry.adapter) continue

      const adapter = entry.adapter
      if (adapter.urlPattern && url.includes(adapter.urlPattern)) {
        return adapter
      }
    }
    return undefined
  }

  /**
   * Get all registered HTTP adapters
   */
  getAll(): Adapter[] {
    const adapters: Adapter[] = []
    for (const entry of this.adapters.values()) {
      if (!entry.isWebSocket && entry.adapter) {
        adapters.push(entry.adapter as Adapter)
      }
    }
    return adapters
  }

  /**
   * Get all registered WebSocket adapters
   */
  getAllWebSocket(): WebSocketAdapter[] {
    const adapters: WebSocketAdapter[] = []
    for (const entry of this.adapters.values()) {
      if (entry.isWebSocket && entry.adapter) {
        adapters.push(entry.adapter as WebSocketAdapter)
      }
    }
    return adapters
  }

  /**
   * Check if an adapter type is registered
   */
  has(name: string): boolean {
    return this.adapters.has(name)
  }

  /**
   * Get all registered adapter names
   */
  getNames(): string[] {
    return Array.from(this.adapters.keys())
  }
}

/**
 * Global adapter registry instance
 */
export const adapterRegistry = new AdapterRegistry()
