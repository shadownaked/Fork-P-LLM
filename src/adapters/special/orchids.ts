/**
 * Orchids AI Adapter
 *
 * Orchids (https://www.orchids.app) is an AI-powered coding assistant.
 * This adapter handles the transformation between OpenAI API format and Orchids' native API.
 *
 * Key characteristics:
 * - Uses SSE (Server-Sent Events) for streaming responses
 * - API endpoint: https://orchids-server.calmstone-6964e08a.westeurope.azurecontainerapps.io/agent/coding-agent
 * - Authentication via Clerk (cookie-based)
 * - Requires projectId in the request
 */

import type {
  Adapter,
  OpenAIChatRequest,
  OpenAIStreamChunk,
  OpenAIModel,
  Credentials,
  TargetRequest,
  CapturedRequest,
  ModelInfo
} from '../../types'
import { getMainLogger } from '../../logger'

const log = getMainLogger()

/**
 * Orchids request body structure
 */
interface OrchidsRequest {
  prompt: string
  projectId: string
  chatSessionId: string | number
  codebaseFiles?: unknown[]
  selectedFiles?: unknown[]
  imageUrls?: string[]
  model?: string
  useWebSearch?: boolean
  useCodebase?: boolean
}

/**
 * Orchids SSE response chunk structure
 */
interface OrchidsChunk {
  // SSE data can have various formats
  type?: string
  content?: string
  text?: string
  delta?: string
  message?: string
  done?: boolean
  finished?: boolean
  error?: string
}

export const orchidsAdapter: Adapter = {
  name: 'orchids',
  urlPattern: 'orchids.app',
  targetBaseUrl: 'https://orchids-server.calmstone-6964e08a.westeurope.azurecontainerapps.io',

  transformRequest(openaiReq: OpenAIChatRequest, credentials: Credentials): TargetRequest {
    // Extract the last user message
    const lastUserMessage = openaiReq.messages
      .filter(m => m.role === 'user')
      .pop()

    // Extract projectId from credentials or use a default
    // The projectId should be captured from the URL pattern
    let projectId = ''
    let chatSessionId: string | number = Date.now()

    // Try to parse projectId from sessionId (which may contain project info)
    if (credentials.sessionId) {
      try {
        const sessionData = JSON.parse(credentials.sessionId)
        if (sessionData.projectId) {
          projectId = sessionData.projectId
        }
        if (sessionData.chatSessionId) {
          chatSessionId = sessionData.chatSessionId
        }
      } catch {
        // sessionId might be the projectId directly
        if (credentials.sessionId.includes('-')) {
          projectId = credentials.sessionId
        }
      }
    }

    const body: OrchidsRequest = {
      prompt: lastUserMessage?.content || '',
      projectId,
      chatSessionId,
      codebaseFiles: [],
      selectedFiles: [],
      imageUrls: [],
      model: openaiReq.model || 'claude-sonnet-4-20250514',
      useWebSearch: false,
      useCodebase: true
    }

    // Build headers from captured request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream'
    }

    // Forward important headers from the original request
    if (credentials.requestHeaders) {
      const headersToForward = ['cookie', 'origin', 'referer', 'user-agent']
      for (const [key, value] of Object.entries(credentials.requestHeaders)) {
        const lowerKey = key.toLowerCase()
        if (headersToForward.includes(lowerKey)) {
          headers[key] = value
        }
      }
    }

    // Add authorization if present
    if (credentials.authorization) {
      headers['Authorization'] = credentials.authorization
    }

    log.info(`Orchids adapter: Sending request to ${this.targetBaseUrl}/agent/coding-agent`)
    log.debug(`Orchids adapter: projectId=${projectId}, prompt length=${body.prompt.length}`)

    return {
      url: `${this.targetBaseUrl}/agent/coding-agent`,
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }
  },

  transformStreamChunk(chunk: unknown): OpenAIStreamChunk | null {
    const data = chunk as OrchidsChunk
    const chunkId = `chatcmpl-${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)

    // Handle various response formats from Orchids

    // Check for text content in various fields
    let content: string | null = null

    if (typeof data === 'string') {
      // Plain text response
      content = data
    } else if (data.content) {
      content = data.content
    } else if (data.text) {
      content = data.text
    } else if (data.delta) {
      content = data.delta
    } else if (data.message) {
      content = data.message
    }

    // Check for completion signals
    const isComplete = data.done === true ||
                       data.finished === true ||
                       data.type === 'done' ||
                       data.type === 'end' ||
                       data.type === 'stop'

    if (content) {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: 'orchids',
        choices: [{
          index: 0,
          delta: { content },
          finish_reason: null
        }]
      }
    }

    if (isComplete) {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: 'orchids',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      }
    }

    // Check for error
    if (data.error) {
      log.error(`Orchids adapter: Error in response - ${data.error}`)
    }

    return null
  },

  getModels(): OpenAIModel[] {
    return [
      {
        id: 'orchids',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'orchids'
      },
      {
        id: 'orchids-claude-sonnet',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'orchids'
      }
    ]
  },

  /**
   * Extract sessionId (projectId) from captured request
   * For Orchids, projectId can be in the URL or request body
   */
  extractSessionId(request: CapturedRequest): string | null {
    // Try to extract projectId from URL (e.g., /projects/uuid or /api/projects/uuid)
    const projectIdMatch = request.url.match(/projects\/([a-f0-9-]{36})/i)
    if (projectIdMatch) {
      log.info(`Extracted projectId from URL for Orchids: ${projectIdMatch[1]}`)
      return projectIdMatch[1]
    }

    // Try to extract from request body
    if (request.body) {
      try {
        const bodyJson = JSON.parse(request.body)
        if (bodyJson.projectId) {
          log.info(`Extracted projectId from body for Orchids: ${bodyJson.projectId}`)
          return bodyJson.projectId
        }
      } catch {
        // Body is not JSON, ignore
      }
    }

    return request.body || null
  },

  /**
   * Get static models for Orchids
   * Orchids has predefined models, not dynamic
   */
  getStaticModels(): ModelInfo[] {
    return [
      { modelName: 'orchids', modelId: 'orchids', displayName: 'Orchids AI' },
      { modelName: 'orchids-claude-sonnet', modelId: 'claude-sonnet-4-20250514', displayName: 'Orchids Claude Sonnet' }
    ]
  },

  /**
   * Get refresh URL for token refresh
   * For Orchids, we need to load a project page to trigger Clerk token refresh
   */
  getRefreshUrl(baseUrl: string, credentials: Credentials): string | null {
    if (credentials.sessionId) {
      // sessionId is the projectId for Orchids
      const refreshUrl = `${baseUrl}/projects/${credentials.sessionId}`
      log.info(`[Orchids] Using project URL for token refresh: ${refreshUrl}`)
      return refreshUrl
    }
    return null
  },

  // Adapter capabilities
  capabilities: {
    clerkAuth: true,
    staticModels: true,
    relaxedCredentialValidation: true,
    autoCapture: {
      clerkSessionPattern: 'clerk.orchids.app',
      sessionIdPattern: /projects\/([a-f0-9-]{36})/i
    }
  }
}

// Default export for auto-registration
export default orchidsAdapter
