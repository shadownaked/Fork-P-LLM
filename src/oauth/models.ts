/**
 * OAuth Provider Models
 *
 * Static model definitions for OAuth-authenticated providers.
 * These models are available when the user has authenticated with the provider.
 *
 */

import type { OAuthProviderType } from '../types'

/**
 * Model definition for OAuth providers
 */
export interface OAuthModel {
  id: string                    // Model ID used in API requests
  name: string                  // Display name
  description?: string          // Optional description
  contextWindow?: number        // Context window size
  maxOutputTokens?: number      // Max output tokens
}

/**
 * OAuth provider model configuration
 */
export interface OAuthProviderModels {
  provider: OAuthProviderType
  displayName: string
  models: OAuthModel[]
}

/**
 * Gemini CLI Models
 * Available via Google OAuth authentication
 */
export const GEMINI_MODELS: OAuthModel[] = [
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    description: 'Most capable Gemini model for complex tasks',
    contextWindow: 1000000,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    description: 'Fast and efficient Gemini model',
    contextWindow: 1000000,
    maxOutputTokens: 65536
  },
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    description: 'Previous generation fast model',
    contextWindow: 1000000,
    maxOutputTokens: 8192
  },
  {
    id: 'gemini-2.0-flash-lite',
    name: 'Gemini 2.0 Flash Lite',
    description: 'Lightweight fast model',
    contextWindow: 1000000,
    maxOutputTokens: 8192
  },
  {
    id: 'gemini-exp-1206',
    name: 'Gemini Experimental 1206',
    description: 'Experimental model',
    contextWindow: 2000000,
    maxOutputTokens: 8192
  }
]

/**
 * OpenAI Codex CLI Models
 * Available via OpenAI OAuth authentication
 */
export const CODEX_MODELS: OAuthModel[] = [
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    description: 'Latest GPT-4 model',
    contextWindow: 1047576,
    maxOutputTokens: 32768
  },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    description: 'Smaller, faster GPT-4.1',
    contextWindow: 1047576,
    maxOutputTokens: 32768
  },
  {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    description: 'Smallest GPT-4.1 variant',
    contextWindow: 1047576,
    maxOutputTokens: 32768
  },
  {
    id: 'o3',
    name: 'O3',
    description: 'OpenAI O3 reasoning model',
    contextWindow: 200000,
    maxOutputTokens: 100000
  },
  {
    id: 'o4-mini',
    name: 'O4 Mini',
    description: 'OpenAI O4 Mini reasoning model',
    contextWindow: 200000,
    maxOutputTokens: 100000
  },
  {
    id: 'codex-mini',
    name: 'Codex Mini',
    description: 'Optimized for code generation',
    contextWindow: 200000,
    maxOutputTokens: 100000
  }
]

/**
 * Qwen Code Models
 * Available via Alibaba Cloud OAuth authentication
 */
export const QWEN_MODELS: OAuthModel[] = [
  {
    id: 'qwen3-coder-plus',
    name: 'Qwen3 Coder Plus',
    description: 'Advanced coding model',
    contextWindow: 131072,
    maxOutputTokens: 16384
  },
  {
    id: 'qwen3-coder',
    name: 'Qwen3 Coder',
    description: 'Standard coding model',
    contextWindow: 131072,
    maxOutputTokens: 16384
  },
  {
    id: 'qwen-max',
    name: 'Qwen Max',
    description: 'Most capable Qwen model',
    contextWindow: 131072,
    maxOutputTokens: 16384
  },
  {
    id: 'qwen-plus',
    name: 'Qwen Plus',
    description: 'Balanced performance model',
    contextWindow: 131072,
    maxOutputTokens: 16384
  },
  {
    id: 'qwen-turbo',
    name: 'Qwen Turbo',
    description: 'Fast response model',
    contextWindow: 131072,
    maxOutputTokens: 16384
  }
]

/**
 * All OAuth provider models configuration
 */
export const OAUTH_PROVIDER_MODELS: OAuthProviderModels[] = [
  {
    provider: 'gemini',
    displayName: 'Gemini CLI',
    models: GEMINI_MODELS
  },
  {
    provider: 'codex',
    displayName: 'OpenAI Codex',
    models: CODEX_MODELS
  },
  {
    provider: 'qwen',
    displayName: 'Qwen Code',
    models: QWEN_MODELS
  }
]

/**
 * Get models for a specific OAuth provider
 */
export function getModelsForProvider(provider: OAuthProviderType): OAuthModel[] {
  const config = OAUTH_PROVIDER_MODELS.find(p => p.provider === provider)
  return config?.models || []
}

/**
 * Get display name for a provider
 */
export function getProviderDisplayName(provider: OAuthProviderType): string {
  const config = OAUTH_PROVIDER_MODELS.find(p => p.provider === provider)
  return config?.displayName || provider
}

/**
 * Find which OAuth provider owns a model
 * Returns provider type and model info if found
 */
export function findOAuthModelOwner(modelId: string): { provider: OAuthProviderType; model: OAuthModel } | null {
  for (const providerConfig of OAUTH_PROVIDER_MODELS) {
    const model = providerConfig.models.find(m => m.id === modelId)
    if (model) {
      return {
        provider: providerConfig.provider,
        model
      }
    }
  }
  return null
}

/**
 * Get all OAuth model IDs
 */
export function getAllOAuthModelIds(): string[] {
  return OAUTH_PROVIDER_MODELS.flatMap(p => p.models.map(m => m.id))
}

/**
 * Check if a model ID belongs to an OAuth provider
 */
export function isOAuthModel(modelId: string): boolean {
  return findOAuthModelOwner(modelId) !== null
}
