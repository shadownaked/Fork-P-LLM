/**
 * OAuth Provider Adapters
 *
 * Adapters for OAuth-authenticated providers (Gemini, Codex, Qwen).
 * These adapters handle the API format transformation between OpenAI format
 * and each provider's native format.
 */

import type {
  OpenAIChatRequest,
  OpenAIStreamChunk,
  OpenAIChatCompletion,
  OpenAIMessage,
  OAuthProviderType
} from '../types'
import { getMainLogger } from '../logger'
import { GEMINI_MODELS, CODEX_MODELS, QWEN_MODELS } from '../oauth/models'

const log = getMainLogger()

// ============================================================================
// Types
// ============================================================================

/**
 * OAuth adapter request configuration
 */
export interface OAuthAdapterRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

/**
 * OAuth adapter interface
 */
export interface OAuthAdapter {
  provider: OAuthProviderType
  transformRequest(openaiReq: OpenAIChatRequest, accessToken: string, model: string, extra?: { projectId?: string }): OAuthAdapterRequest
  transformStreamChunk(chunk: unknown, model: string): OpenAIStreamChunk | null
  transformNonStreamResponse(response: unknown, model: string): OpenAIChatCompletion
  isStreamComplete(chunk: unknown): boolean
}

// ============================================================================
// Gemini Adapter (Cloud Code Assist)
// ============================================================================

/**
 * Cloud Code Assist API endpoint and version
 * This is the endpoint used by Gemini CLI, NOT the public Generative Language API
 */
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com'
const CODE_ASSIST_VERSION = 'v1internal'

/**
 * Gemini CLI request format (Cloud Code Assist)
 * The actual structure wraps contents/generationConfig inside a "request" field
 */
interface GeminiCLIContent {
  role: 'user' | 'model'
  parts: Array<{ text: string }>
}

interface GeminiCLIRequest {
  project: string
  model: string
  request: {
    contents: GeminiCLIContent[]
    systemInstruction?: {
      role: 'user'
      parts: Array<{ text: string }>
    }
    generationConfig?: {
      temperature?: number
      maxOutputTokens?: number
      candidateCount?: number
    }
  }
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>
      role?: string
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Transform OpenAI messages to Gemini CLI format
 * Returns contents array and optional system instruction
 */
function transformMessagesToGeminiCLI(messages: OpenAIMessage[]): {
  contents: GeminiCLIContent[]
  systemInstruction?: { role: 'user'; parts: Array<{ text: string }> }
} {
  const contents: GeminiCLIContent[] = []
  let systemInstruction: { role: 'user'; parts: Array<{ text: string }> } | undefined

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System message becomes systemInstruction
      systemInstruction = {
        role: 'user',
        parts: [{ text: msg.content }]
      }
      continue
    }

    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    })
  }

  return { contents, systemInstruction }
}

export const geminiOAuthAdapter: OAuthAdapter = {
  provider: 'gemini',

  transformRequest(openaiReq: OpenAIChatRequest, accessToken: string, model: string, extra?: { projectId?: string }): OAuthAdapterRequest {
    const { contents, systemInstruction } = transformMessagesToGeminiCLI(openaiReq.messages)

    // Build the nested request structure that Cloud Code Assist expects
    const geminiReq: GeminiCLIRequest = {
      project: extra?.projectId || '', // GCP project ID is required for Cloud Code Assist
      model,
      request: {
        contents,
        generationConfig: {}
      }
    }

    // Add system instruction if present
    if (systemInstruction) {
      geminiReq.request.systemInstruction = systemInstruction
    }

    if (openaiReq.temperature !== undefined) {
      geminiReq.request.generationConfig!.temperature = openaiReq.temperature
    }
    if (openaiReq.max_tokens !== undefined) {
      geminiReq.request.generationConfig!.maxOutputTokens = openaiReq.max_tokens
    }

    // Use streamGenerateContent for streaming
    const endpoint = openaiReq.stream !== false
      ? 'streamGenerateContent'
      : 'generateContent'

    // Cloud Code Assist endpoint (used by Gemini CLI)
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_VERSION}:${endpoint}?alt=sse`

    log.info(`[Gemini OAuth] Request to Cloud Code Assist: ${url}, project: ${extra?.projectId || '(none)'}`)

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        // Required headers for Cloud Code Assist (matching Gemini CLI)
        'User-Agent': 'google-api-nodejs-client/9.15.1',
        'X-Goog-Api-Client': 'gl-node/22.17.0',
        'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
        'Accept': openaiReq.stream !== false ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(geminiReq)
    }
  },

  transformStreamChunk(chunk: unknown, model: string): OpenAIStreamChunk | null {
    const data = chunk as GeminiStreamChunk
    const chunkId = `chatcmpl-${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)

    if (!data.candidates?.[0]) {
      return null
    }

    const candidate = data.candidates[0]
    const content = candidate.content?.parts?.[0]?.text || ''
    const finishReason = candidate.finishReason

    if (content) {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [{
          index: 0,
          delta: { content },
          finish_reason: null
        }]
      }
    }

    if (finishReason === 'STOP') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      }
    }

    return null
  },

  transformNonStreamResponse(response: unknown, model: string): OpenAIChatCompletion {
    const data = response as GeminiStreamChunk
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || ''

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata?.totalTokenCount || 0
      }
    }
  },

  isStreamComplete(chunk: unknown): boolean {
    const data = chunk as GeminiStreamChunk
    return data.candidates?.[0]?.finishReason === 'STOP'
  }
}

// ============================================================================
// Codex (OpenAI) Adapter
// ============================================================================

/**
 * OpenAI Codex uses standard OpenAI format, so minimal transformation needed
 */
export const codexOAuthAdapter: OAuthAdapter = {
  provider: 'codex',

  transformRequest(openaiReq: OpenAIChatRequest, accessToken: string, model: string): OAuthAdapterRequest {
    const url = 'https://api.openai.com/v1/chat/completions'

    log.info(`[Codex OAuth] Request to ${url}`)

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        ...openaiReq,
        model
      })
    }
  },

  transformStreamChunk(chunk: unknown, model: string): OpenAIStreamChunk | null {
    // OpenAI format is already correct, just ensure model is set
    const data = chunk as OpenAIStreamChunk
    if (data.choices?.[0]) {
      return {
        ...data,
        model
      }
    }
    return null
  },

  transformNonStreamResponse(response: unknown, model: string): OpenAIChatCompletion {
    const data = response as OpenAIChatCompletion
    return {
      ...data,
      model
    }
  },

  isStreamComplete(chunk: unknown): boolean {
    const data = chunk as OpenAIStreamChunk
    return data.choices?.[0]?.finish_reason === 'stop'
  }
}

// ============================================================================
// Qwen Adapter
// ============================================================================

/**
 * Qwen API message format (similar to OpenAI)
 */
interface QwenMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface QwenRequest {
  model: string
  input: {
    messages: QwenMessage[]
  }
  parameters?: {
    temperature?: number
    max_tokens?: number
    result_format?: 'text' | 'message'
    incremental_output?: boolean
  }
}

interface QwenStreamChunk {
  output?: {
    choices?: Array<{
      message?: {
        content?: string
        role?: string
      }
      finish_reason?: string
    }>
    text?: string
    finish_reason?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

export const qwenOAuthAdapter: OAuthAdapter = {
  provider: 'qwen',

  transformRequest(openaiReq: OpenAIChatRequest, accessToken: string, model: string): OAuthAdapterRequest {
    const qwenReq: QwenRequest = {
      model,
      input: {
        messages: openaiReq.messages.map(m => ({
          role: m.role,
          content: m.content
        }))
      },
      parameters: {
        result_format: 'message',
        incremental_output: openaiReq.stream !== false
      }
    }

    if (openaiReq.temperature !== undefined) {
      qwenReq.parameters!.temperature = openaiReq.temperature
    }
    if (openaiReq.max_tokens !== undefined) {
      qwenReq.parameters!.max_tokens = openaiReq.max_tokens
    }

    const url = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'

    log.info(`[Qwen OAuth] Request to ${url}`)

    return {
      url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'X-DashScope-SSE': openaiReq.stream !== false ? 'enable' : 'disable'
      },
      body: JSON.stringify(qwenReq)
    }
  },

  transformStreamChunk(chunk: unknown, model: string): OpenAIStreamChunk | null {
    const data = chunk as QwenStreamChunk
    const chunkId = `chatcmpl-${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)

    const content = data.output?.choices?.[0]?.message?.content || data.output?.text || ''
    const finishReason = data.output?.choices?.[0]?.finish_reason || data.output?.finish_reason

    if (content) {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [{
          index: 0,
          delta: { content },
          finish_reason: null
        }]
      }
    }

    if (finishReason === 'stop') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      }
    }

    return null
  },

  transformNonStreamResponse(response: unknown, model: string): OpenAIChatCompletion {
    const data = response as QwenStreamChunk
    const content = data.output?.choices?.[0]?.message?.content || data.output?.text || ''

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: data.usage?.input_tokens || 0,
        completion_tokens: data.usage?.output_tokens || 0,
        total_tokens: data.usage?.total_tokens || 0
      }
    }
  },

  isStreamComplete(chunk: unknown): boolean {
    const data = chunk as QwenStreamChunk
    const finishReason = data.output?.choices?.[0]?.finish_reason || data.output?.finish_reason
    return finishReason === 'stop'
  }
}

// ============================================================================
// Registry
// ============================================================================

/**
 * OAuth adapter registry
 */
const oauthAdapters: Map<OAuthProviderType, OAuthAdapter> = new Map([
  ['gemini', geminiOAuthAdapter],
  ['codex', codexOAuthAdapter],
  ['qwen', qwenOAuthAdapter]
])

/**
 * Get OAuth adapter for a provider
 */
export function getOAuthAdapter(provider: OAuthProviderType): OAuthAdapter | undefined {
  return oauthAdapters.get(provider)
}

/**
 * Get all OAuth adapters
 */
export function getAllOAuthAdapters(): OAuthAdapter[] {
  return Array.from(oauthAdapters.values())
}
