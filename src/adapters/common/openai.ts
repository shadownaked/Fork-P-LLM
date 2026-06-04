/**
 * OpenAI Format Adapter
 *
 * Generic adapter for sites using standard OpenAI-compatible API format.
 * This adapter handles:
 * - Standard /v1/chat/completions endpoint
 * - Bearer token authentication
 * - SSE streaming responses
 *
 * Configuration (via SiteConfig.adapterConfig):
 * - apiUrl: Full API endpoint URL
 * - authHeader: Header name for auth (default: 'Authorization')
 * - forwardHeaders: Headers to forward from captured request
 */

import type {
  Adapter,
  OpenAIChatRequest,
  OpenAIStreamChunk,
  OpenAIModel,
  Credentials,
  TargetRequest
} from '../../types'
import { getMainLogger } from '../../logger'
import {
  type ResponseFormatConfig,
  parseResponseChunk,
  detectResponseFormat
} from '../formats'

const log = getMainLogger()

/**
 * OpenAI adapter configuration
 */
export interface OpenAIAdapterConfig {
  apiUrl: string                          // Full API URL (e.g., https://api.vendor.com/v1/chat/completions)
  requestFormat?: 'openai'                // Currently only OpenAI format supported
  responseFormat?: 'openai' | 'anthropic' // Response format (auto-detected if not specified)
  authHeader?: string                     // Auth header name (default: 'Authorization')
  forwardHeaders?: string[]               // Headers to forward from captured request
}

/**
 * Create an OpenAI-compatible adapter instance
 */
export function createOpenAIAdapter(config: OpenAIAdapterConfig): Adapter {
  let detectedResponseFormat: ResponseFormatConfig | null = null

  return {
    name: 'openai',
    urlPattern: '*',
    targetBaseUrl: '',

    transformRequest(openaiReq: OpenAIChatRequest, credentials: Credentials): TargetRequest {
      const apiUrl = config.apiUrl
      if (!apiUrl) {
        log.error('OpenAI adapter: No API URL configured')
        throw new Error('No API URL configured for OpenAI adapter')
      }

      // Build request body - pass through OpenAI format directly
      const body: Record<string, unknown> = {
        model: openaiReq.model,
        messages: openaiReq.messages,
        stream: openaiReq.stream ?? true
      }

      // Forward optional parameters
      if (openaiReq.temperature !== undefined) {
        body.temperature = openaiReq.temperature
      }
      if (openaiReq.max_tokens !== undefined) {
        body.max_tokens = openaiReq.max_tokens
      }

      // Build headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      }

      // Add authorization
      const authHeader = config.authHeader || 'Authorization'
      if (credentials.authorization) {
        headers[authHeader] = credentials.authorization
      }

      // Forward headers from captured request
      if (credentials.requestHeaders && config.forwardHeaders) {
        for (const headerName of config.forwardHeaders) {
          const lowerName = headerName.toLowerCase()
          for (const [key, value] of Object.entries(credentials.requestHeaders)) {
            if (key.toLowerCase() === lowerName) {
              headers[key] = value
              log.debug(`OpenAI adapter: Forwarding header "${key}"`)
            }
          }
        }
      }

      log.info(`OpenAI adapter: Sending request to ${apiUrl}`)
      log.debug(`OpenAI adapter: Model = ${openaiReq.model}`)

      return {
        url: apiUrl,
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      }
    },

    transformStreamChunk(chunk: unknown): OpenAIStreamChunk | null {
      const data = chunk as Record<string, unknown>
      const chunkId = `chatcmpl-${Date.now()}`
      const timestamp = Math.floor(Date.now() / 1000)

      // Auto-detect response format on first chunk
      if (!detectedResponseFormat) {
        const format = config.responseFormat || detectResponseFormat(data)
        detectedResponseFormat = { format }
        log.debug(`OpenAI adapter: Using response format "${format}"`)
      }

      // If response is already OpenAI format, pass through with minimal processing
      if (detectedResponseFormat.format === 'openai' && data.choices) {
        // Validate and return as-is (with type coercion)
        return data as unknown as OpenAIStreamChunk
      }

      // Parse non-OpenAI format responses
      const { content, isStop, finishReason, role } = parseResponseChunk(data, detectedResponseFormat)

      if (role === 'assistant' && !content) {
        // Initial role message
        return {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'openai',
          choices: [{
            index: 0,
            delta: { role: 'assistant' },
            finish_reason: null
          }]
        }
      }

      if (content) {
        return {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'openai',
          choices: [{
            index: 0,
            delta: { content },
            finish_reason: null
          }]
        }
      }

      if (isStop) {
        return {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'openai',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason || 'stop'
          }]
        }
      }

      return null
    },

    getModels(): OpenAIModel[] {
      // Dynamic models should be registered via site config
      return [{
        id: 'openai',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'openai-adapter'
      }]
    }
  }
}

/**
 * Default OpenAI adapter instance (requires config at runtime)
 */
export const openaiAdapter: Adapter = {
  name: 'openai',
  urlPattern: '*',
  targetBaseUrl: '',

  transformRequest(_openaiReq: OpenAIChatRequest, _credentials: Credentials): TargetRequest {
    throw new Error('OpenAI adapter requires configuration. Use createOpenAIAdapter() with config.')
  },

  transformStreamChunk(_chunk: unknown): OpenAIStreamChunk | null {
    return null
  },

  getModels(): OpenAIModel[] {
    return []
  }
}
