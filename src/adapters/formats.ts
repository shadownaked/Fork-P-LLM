/**
 * Message format definitions for request/response transformation
 *
 * Each site may use different formats for sending messages and receiving responses.
 * This module defines the supported formats and provides transformation functions.
 */

import type { OpenAIMessage } from '../types'

// ============================================================================
// Request Format Types
// ============================================================================

/**
 * Supported request message formats
 */
export type RequestFormat =
  | 'openai'           // { messages: [{ role, content }] }
  | 'anthropic'        // { system, messages: [{ role, content: [{ type: "text", text }] }] }
  | 'factory-openai'   // { instructions, input: [{ role, content: [{ type: "input_text", text }] }] }
  | 'parts'            // { messages: [{ role, parts: [{ type: "text", text }] }] }
  | 'simple-message'   // { message: "..." }
  | 'simple-content'   // { content: "..." }
  | 'simple-prompt'    // { prompt: "..." }
  | 'simple-query'     // { query: "..." }
  | 'simple-text'      // { text: "..." }
  | 'simple-input'     // { input: "..." }

/**
 * Configuration for request transformation
 */
export interface RequestFormatConfig {
  format: RequestFormat
  messageField?: string        // Override default field name
  idFields?: string[]          // Fields to regenerate IDs for
  preserveFields?: string[]    // Fields to preserve from template
}

// ============================================================================
// Response Format Types
// ============================================================================

/**
 * Supported response stream formats
 */
export type ResponseFormat =
  | 'openai'           // { choices: [{ delta: { content } }] }
  | 'anthropic'        // Anthropic SSE events (message_start, content_block_delta, etc.)
  | 'text-delta'       // { type: "text-delta", delta: "..." }
  | 'obj-content'      // { obj: { type, content } }
  | 'simple-content'   // { content: "..." }
  | 'simple-message'   // { message: "..." }
  | 'simple-text'      // { text: "..." }
  | 'simple-response'  // { response: "..." }

/**
 * Configuration for response transformation
 */
export interface ResponseFormatConfig {
  format: ResponseFormat
  contentField?: string        // Override default content field
  stopSignals?: string[]       // Additional stop signal types
}

// ============================================================================
// Request Transformers
// ============================================================================

/**
 * Transform OpenAI messages to target format within a template body
 */
export function transformRequestBody(
  template: Record<string, unknown>,
  messages: OpenAIMessage[],
  config: RequestFormatConfig
): Record<string, unknown> {
  const body = JSON.parse(JSON.stringify(template)) // Deep clone
  const lastUserMessage = messages.filter(m => m.role === 'user').pop()
  const userContent = lastUserMessage?.content || ''

  switch (config.format) {
    case 'openai':
      // Replace entire messages array with OpenAI format
      if (Array.isArray(body.messages)) {
        body.messages = messages
      }
      break

    case 'parts':
      // Update text in parts array structure
      if (Array.isArray(body.messages) && body.messages.length > 0) {
        const lastMsg = body.messages[body.messages.length - 1] as Record<string, unknown>
        if (Array.isArray(lastMsg.parts)) {
          for (const part of lastMsg.parts as Array<Record<string, unknown>>) {
            if (part.type === 'text' && typeof part.text === 'string') {
              part.text = userContent
              break
            }
          }
        }
      }
      break

    case 'simple-message':
      body[config.messageField || 'message'] = userContent
      break

    case 'simple-content':
      body[config.messageField || 'content'] = userContent
      break

    case 'simple-prompt':
      body[config.messageField || 'prompt'] = userContent
      break

    case 'simple-query':
      body[config.messageField || 'query'] = userContent
      break

    case 'simple-text':
      body[config.messageField || 'text'] = userContent
      break

    case 'simple-input':
      body[config.messageField || 'input'] = userContent
      break
  }

  // Regenerate IDs to avoid cached responses
  const idFields = config.idFields || ['id', 'conversationId', 'conversation_id', 'sessionId', 'session_id', 'chatId', 'chat_id']
  for (const field of idFields) {
    if (field in body && typeof body[field] === 'string') {
      body[field] = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
      break
    }
  }

  return body
}

/**
 * Auto-detect request format from template body
 */
export function detectRequestFormat(template: Record<string, unknown>): RequestFormat {
  // Check for messages array
  if (Array.isArray(template.messages) && template.messages.length > 0) {
    const firstMsg = template.messages[0] as Record<string, unknown>

    // Check for parts structure
    if (Array.isArray(firstMsg.parts)) {
      return 'parts'
    }

    // Check for content field (OpenAI style)
    if ('content' in firstMsg) {
      return 'openai'
    }
  }

  // Check for simple field formats
  if ('message' in template) return 'simple-message'
  if ('content' in template) return 'simple-content'
  if ('prompt' in template) return 'simple-prompt'
  if ('query' in template) return 'simple-query'
  if ('text' in template) return 'simple-text'
  if ('input' in template) return 'simple-input'

  // Default to openai
  return 'openai'
}

// ============================================================================
// Response Transformers
// ============================================================================

/**
 * OpenAI-compatible finish_reason values
 */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | null

/**
 * Map Anthropic stop_reason to OpenAI finish_reason
 */
export const ANTHROPIC_STOP_REASON_MAP: Record<string, FinishReason> = {
  'end_turn': 'stop',
  'max_tokens': 'length',
  'stop_sequence': 'stop',
  'tool_use': 'tool_calls'
}

/**
 * Map common stop reasons to OpenAI finish_reason
 */
export function mapFinishReason(reason: string | null | undefined): FinishReason {
  if (!reason) return null
  if (reason in ANTHROPIC_STOP_REASON_MAP) {
    return ANTHROPIC_STOP_REASON_MAP[reason]
  }
  // Already OpenAI format
  if (reason === 'stop' || reason === 'length' || reason === 'tool_calls') {
    return reason as FinishReason
  }
  return 'stop' // Default to stop for unknown reasons
}

export interface ParsedResponse {
  content: string | null
  isStop: boolean
  finishReason?: FinishReason
  role?: 'assistant'
}

/**
 * Parse response chunk based on format
 */
export function parseResponseChunk(
  data: Record<string, unknown>,
  config: ResponseFormatConfig
): ParsedResponse {
  let content: string | null = null
  let isStop = false
  let finishReason: FinishReason = null
  let role: 'assistant' | undefined 

  switch (config.format) {
    case 'openai':
      if (data.choices && Array.isArray(data.choices)) {
        const choice = data.choices[0] as Record<string, unknown>
        if (choice?.delta && typeof choice.delta === 'object') {
          const delta = choice.delta as Record<string, unknown>
          content = (delta.content as string) || null
          if (delta.role === 'assistant') {
            role = 'assistant'
          }
        }
        if (choice?.finish_reason) {
          isStop = true
          finishReason = mapFinishReason(choice.finish_reason as string)
        }
      }
      break

    case 'anthropic':
      // Handle Anthropic SSE event types
      if (data.type === 'message_start') {
        // Start of message, may contain role
        role = 'assistant'
      } else if (data.type === 'content_block_start') {
        // Start of a content block (text or tool_use)
        const contentBlock = data.content_block as Record<string, unknown> | undefined
        if (contentBlock?.type === 'text') {
          content = (contentBlock.text as string) || null
        }
      } else if (data.type === 'content_block_delta') {
        // Content delta - extract text
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta') {
          content = (delta.text as string) || null
        }
      } else if (data.type === 'message_delta') {
        // Message delta - may contain stop_reason
        const delta = data.delta as Record<string, unknown> | undefined
        if (delta?.stop_reason) {
          isStop = true
          finishReason = mapFinishReason(delta.stop_reason as string)
        }
      } else if (data.type === 'message_stop') {
        // End of message
        isStop = true
        if (!finishReason) {
          finishReason = 'stop'
        }
      }
      // Ignore: ping, content_block_stop
      break

    case 'text-delta':
      if (data.type === 'text-delta' && typeof data.delta === 'string') {
        content = data.delta
      }
      if (data.type === 'finish' || data.type === 'end' || data.type === 'done') {
        isStop = true
        finishReason = 'stop'
      }
      break

    case 'obj-content':
      if (data.obj && typeof data.obj === 'object') {
        const obj = data.obj as Record<string, unknown>
        if (obj.type === 'message_delta' && typeof obj.content === 'string') {
          content = obj.content
        }
        if (obj.type === 'stop') {
          isStop = true
          finishReason = 'stop'
        }
      }
      break

    case 'simple-content':
      if (typeof data.content === 'string') {
        content = data.content
      }
      break

    case 'simple-message':
      if (typeof data.message === 'string') {
        content = data.message
      }
      break

    case 'simple-text':
      if (typeof data.text === 'string') {
        content = data.text
      }
      break

    case 'simple-response':
      if (typeof data.response === 'string') {
        content = data.response
      }
      break
  }

  // Check common stop signals
  const stopSignals = config.stopSignals || []
  if (data.done === true || data.finished === true || data.stop === true) {
    isStop = true
    if (!finishReason) finishReason = 'stop'
  }
  if (typeof data.type === 'string' && stopSignals.includes(data.type)) {
    isStop = true
    if (!finishReason) finishReason = 'stop'
  }

  return { content, isStop, finishReason, role }
}

/**
 * Auto-detect response format from a sample chunk
 */
export function detectResponseFormat(data: Record<string, unknown>): ResponseFormat {
  // OpenAI format
  if (data.choices && Array.isArray(data.choices)) {
    return 'openai'
  }

  // Anthropic SSE format
  const anthropicTypes = ['message_start', 'content_block_start', 'content_block_delta',
                          'content_block_stop', 'message_delta', 'message_stop', 'ping']
  if (typeof data.type === 'string' && anthropicTypes.includes(data.type)) {
    return 'anthropic'
  }

  // text-delta format (Vercel AI SDK style)
  if (data.type === 'text-delta' || data.type === 'text-start' || data.type === 'text-end') {
    return 'text-delta'
  }

  // obj.content
  if (data.obj && typeof data.obj === 'object') {
    return 'obj-content'
  }

  // Simple field formats
  if ('content' in data) return 'simple-content'
  if ('message' in data) return 'simple-message'
  if ('text' in data) return 'simple-text'
  if ('response' in data) return 'simple-response'

  return 'openai'
}
