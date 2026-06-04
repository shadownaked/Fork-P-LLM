/**
 * Anthropic API Adapter
 *
 * 处理 Anthropic 原生 API 格式（/v1/messages）
 * Claude Code 直接使用此格式与 API 通信
 *
 * 请求格式：
 * POST /v1/messages
 * {
 *   "model": "claude-sonnet-4-20250514",
 *   "max_tokens": 1024,
 *   "messages": [{"role": "user", "content": "Hello"}]
 * }
 *
 * 响应格式（流式）：
 * event: message_start
 * data: {"type":"message_start","message":{...}}
 *
 * event: content_block_start
 * data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 * event: content_block_delta
 * data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 * event: message_stop
 * data: {"type":"message_stop"}
 */

import type { OpenAIStreamChunk, Credentials, TargetRequest } from '../types'
import { getMainLogger } from '../logger'

const log = getMainLogger()

// Anthropic 消息格式
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking'
  text?: string
  // image fields
  source?: {
    type: 'base64' | 'url'
    media_type?: string
    data?: string
    url?: string
  }
  // tool_use fields
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result fields
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  // thinking fields
  thinking?: string
}

// Anthropic 工具定义
export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
  type?: string
}

// Anthropic 请求格式
export interface AnthropicRequest {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string | Array<{ type: 'text'; text: string }>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  metadata?: Record<string, unknown>
  tools?: AnthropicTool[]
  tool_choice?: { type: string; name?: string }
  thinking?: { type: string; budget_tokens?: number }
}

// Anthropic 流式事件类型
export type AnthropicEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error'

// Anthropic 流式事件数据
export interface AnthropicStreamEvent {
  type: AnthropicEventType
  message?: {
    id: string
    type: 'message'
    role: 'assistant'
    content: AnthropicContentBlock[]
    model: string
    stop_reason: string | null
    stop_sequence: string | null
    usage: {
      input_tokens: number
      output_tokens: number
    }
  }
  index?: number
  content_block?: AnthropicContentBlock
  delta?: {
    type: 'text_delta' | 'input_json_delta'
    text?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string | null
  }
  usage?: {
    output_tokens: number
  }
  error?: {
    type: string
    message: string
  }
}

// 非流式响应格式
export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

/**
 * 将 Anthropic 流式事件转换为 OpenAI 流式格式
 * 这样可以复用现有的 OpenAI 流式处理逻辑
 */
export function transformAnthropicStreamToOpenAI(
  event: AnthropicStreamEvent,
  messageId: string,
  model: string
): OpenAIStreamChunk | null {
  switch (event.type) {
    case 'message_start':
      // 消息开始，发送角色
      return {
        id: messageId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null
        }]
      }

    case 'content_block_delta':
      // 内容增量
      if (event.delta?.type === 'text_delta' && event.delta.text) {
        return {
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: event.delta.text },
            finish_reason: null
          }]
        }
      }
      return null

    case 'message_delta':
      // 消息结束信息
      if (event.delta?.stop_reason) {
        return {
          id: messageId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: event.delta.stop_reason === 'end_turn' ? 'stop' : 'stop'
          }]
        }
      }
      return null

    case 'message_stop':
      // 消息完全结束
      return null

    case 'ping':
    case 'content_block_start':
    case 'content_block_stop':
      // 忽略这些事件
      return null

    case 'error':
      log.error(`[Anthropic] Stream error: ${event.error?.message}`)
      return null

    default:
      log.debug(`[Anthropic] Unknown event type: ${event.type}`)
      return null
  }
}

/**
 * 解析 Anthropic SSE 格式的响应
 * 格式：
 * event: event_type
 * data: {"type":"event_type",...}
 */
export function parseAnthropicSSE(chunk: string): AnthropicStreamEvent | null {
  const lines = chunk.split('\n')
  let eventType: string | null = null
  let data: string | null = null

  for (const line of lines) {
    if (line.startsWith('event: ')) {
      eventType = line.substring(7).trim()
    } else if (line.startsWith('data: ')) {
      data = line.substring(6)
    }
  }

  if (!data) {
    return null
  }

  try {
    const parsed = JSON.parse(data) as AnthropicStreamEvent
    // 使用 event 行的类型，如果没有则使用 data 中的 type
    if (eventType && !parsed.type) {
      parsed.type = eventType as AnthropicEventType
    }
    return parsed
  } catch {
    log.debug(`[Anthropic] Failed to parse SSE data: ${data}`)
    return null
  }
}

/**
 * 构建 Anthropic API 请求
 */
export function buildAnthropicRequest(
  request: AnthropicRequest,
  credentials: Credentials,
  targetUrl: string
): TargetRequest {
  // 从凭证中获取真实的 API Key
  // 如果是占位符，使用凭证中存储的真实 Token
  let apiKey = credentials.authorization || ''

  // 移除 Bearer 前缀（如果有）
  if (apiKey.startsWith('Bearer ')) {
    apiKey = apiKey.substring(7)
  }

  return {
    url: targetUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(request)
  }
}

/**
 * Anthropic 适配器
 * 用于处理 /v1/messages 端点
 */
export const anthropicAdapter = {
  name: 'anthropic',
  urlPattern: 'api.anthropic.com',
  targetBaseUrl: 'https://api.anthropic.com',

  /**
   * 转换请求（透传，因为已经是 Anthropic 格式）
   */
  transformRequest(request: AnthropicRequest, credentials: Credentials): TargetRequest {
    return buildAnthropicRequest(request, credentials, `${this.targetBaseUrl}/v1/messages`)
  },

  /**
   * 转换流式响应块
   */
  transformStreamChunk(chunk: string, messageId: string, model: string): OpenAIStreamChunk | null {
    const event = parseAnthropicSSE(chunk)
    if (!event) {
      return null
    }
    return transformAnthropicStreamToOpenAI(event, messageId, model)
  },

  /**
   * 检查是否是流结束
   */
  isStreamEnd(chunk: string): boolean {
    return chunk.includes('event: message_stop') || chunk.includes('"type":"message_stop"')
  }
}
