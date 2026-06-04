/**
 * Adapter Module Entry Point
 *
 * This module provides a clean API for adapter management:
 * - registerAdapters(): Initialize all built-in adapters
 * - adapterRegistry: Access the global registry for adapter lookup
 *
 * Adding a new adapter:
 * 1. For OpenAI-compatible sites: Use adapterType='openai' with apiUrl in adapterConfig
 * 2. For special sites: Create adapter in src/adapters/special/ with default export
 *    The adapter will be auto-registered at startup. No need to edit this file.
 */

import { adapterRegistry, isWebSocketAdapter } from './registry'
import { templateAdapter } from './template-adapter'

// Import all special adapters - each must have a default export
// Adding a new adapter: just add an import line below
// Example: import newAdapter from './special/newsite'
import theOldLLMAdapter from './special/theoldllm'
import orchidsAdapter from './special/orchids'
import gumloopAdapter from './special/gumloop'

/**
 * Register all built-in adapters
 *
 * This function is called once at application startup.
 * To add a new adapter, add an import statement above.
 */
export function registerAdapters(): void {
  // Register special adapters (sites with custom API formats)
  theOldLLMAdapter && adapterRegistry.register(theOldLLMAdapter)
  orchidsAdapter && adapterRegistry.register(orchidsAdapter)
  gumloopAdapter && adapterRegistry.registerWebSocket(gumloopAdapter)

  // Register template adapter as 'generic' for backward compatibility
  // and as 'template' for new sites
  adapterRegistry.register({ ...templateAdapter, name: 'generic' })
  adapterRegistry.register(templateAdapter)

  // Note: 'openai' adapter is handled dynamically by registry.getForSite()
  // No need to register it here as it requires site-specific configuration
}

// Re-export registry and utilities
export { adapterRegistry, isWebSocketAdapter } from './registry'

// Re-export template adapter for direct use
export { createTemplateAdapter, templateAdapter } from './template-adapter'

// Re-export OpenAI adapter factory
export { createOpenAIAdapter, openaiAdapter } from './common/openai'
export type { OpenAIAdapterConfig } from './common/openai'

// Re-export format utilities
export * from './formats'

// OAuth adapters
export {
  getOAuthAdapter,
  getAllOAuthAdapters,
  geminiOAuthAdapter,
  codexOAuthAdapter,
  qwenOAuthAdapter
} from './oauth-adapter'
export type { OAuthAdapter, OAuthAdapterRequest } from './oauth-adapter'
