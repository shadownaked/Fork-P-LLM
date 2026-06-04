/**
 * Template-based adapter that uses captured request as template
 *
 * This adapter is designed to work with any site by:
 * 1. Using a captured request as a template
 * 2. Auto-detecting or using configured request/response formats
 * 3. Transforming OpenAI format to/from the site's native format
 */

import type {
  Adapter,
  OpenAIChatRequest,
  OpenAIStreamChunk,
  OpenAIModel,
  Credentials,
  TargetRequest
} from '../types'
import { getMainLogger } from '../logger'
import {
  type RequestFormatConfig,
  type ResponseFormatConfig,
  transformRequestBody,
  detectRequestFormat,
  parseResponseChunk,
  detectResponseFormat
} from './formats'

const log = getMainLogger()

/**
 * Site-specific adapter configuration
 * This can be stored in SiteConfig.adapterConfig
 */
export interface TemplateAdapterConfig {
  request?: RequestFormatConfig
  response?: ResponseFormatConfig
}

/**
 * Create a template adapter instance
 * The adapter auto-detects formats if not explicitly configured
 */
export function createTemplateAdapter(config?: TemplateAdapterConfig): Adapter {
  // Track detected response format (updated on first chunk)
  let detectedResponseFormat: ResponseFormatConfig | null = null

  return {
    name: 'template',
    urlPattern: '*',
    targetBaseUrl: '',

    transformRequest(openaiReq: OpenAIChatRequest, credentials: Credentials): TargetRequest {
      // Get the API URL from authorization (stored as "REQUEST:url")
      let apiUrl = ''
      let authHeader = ''

      if (credentials.authorization?.startsWith('REQUEST:')) {
        apiUrl = credentials.authorization.substring(8)
      } else {
        authHeader = credentials.authorization || ''
        log.error('Template adapter: No API URL configured')
        throw new Error('No API URL configured. Please select a chat request first.')
      }

      // Get the captured request template
      const templateBody = credentials.sessionId || '{}'
      let template: Record<string, unknown>
      try {
        template = JSON.parse(templateBody)
      } catch {
        template = {}
      }

      // Determine request format
      const requestConfig: RequestFormatConfig = config?.request || {
        format: detectRequestFormat(template)
      }

      log.debug(`Template adapter: Using request format "${requestConfig.format}"`)

      // Transform the request body
      const body = transformRequestBody(template, openaiReq.messages, requestConfig)

      // Build headers
      const headers: Record<string, string> = {}

      // Copy relevant headers from original request
      if (credentials.requestHeaders) {
        const headersToForward = ['cookie', 'accept', 'accept-language', 'origin', 'referer', 'user-agent']
        for (const [key, value] of Object.entries(credentials.requestHeaders)) {
          const lowerKey = key.toLowerCase()
          if (headersToForward.includes(lowerKey)) {
            headers[key] = value
            log.debug(`Template adapter: Forwarding header "${key}"`)
          }
        }
      }

      headers['Content-Type'] = 'application/json'

      if (authHeader) {
        headers.Authorization = authHeader
      }

      log.info(`Template adapter: Sending request to ${apiUrl}`)
      log.debug(`Template adapter: Body = ${JSON.stringify(body)}`)

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

      // Determine response format (auto-detect on first chunk if not configured)
      if (!detectedResponseFormat) {
        detectedResponseFormat = config?.response || {
          format: detectResponseFormat(data)
        }
        log.debug(`Template adapter: Using response format "${detectedResponseFormat.format}"`)
      }

      // Parse the chunk
      const { content, isStop } = parseResponseChunk(data, detectedResponseFormat)

      if (content) {
        return {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'template',
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
          model: 'template',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }]
        }
      }

      return null
    },

    getModels(): OpenAIModel[] {
      return [{
        id: 'template',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'template'
      }]
    }
  }
}

/**
 * Default template adapter instance (auto-detect formats)
 */
export const templateAdapter = createTemplateAdapter()
