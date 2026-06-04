/**
 * Anthropic <-> OpenAI 格式转换模块
 *
 * 实现 Claude /v1/messages 请求/响应与 OpenAI /v1/chat/completions 格式的双向转换
 */

import type { AnthropicRequest, AnthropicContentBlock as AnthropicContentBlockType } from './anthropic'
import type { OpenAIChatRequest, OpenAIMessage as TypesOpenAIMessage } from '../types'

// ============ 类型定义 ============

/** OpenAI Chat Completion 请求 */
export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; function?: { name: string } }
}

/** OpenAI 消息 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

/** OpenAI 内容部分 */
export interface OpenAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** OpenAI 工具调用 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** OpenAI 工具定义 */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** OpenAI Chat Completion 响应 */
export interface OpenAIResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/** OpenAI 选择 */
export interface OpenAIChoice {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
}

/** OpenAI 流式响应块 */
export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
  }
}

// ============ Anthropic -> OpenAI 请求转换 ============

/**
 * 将 Anthropic 请求转换为 OpenAI 请求
 */
export function anthropicToOpenAI(request: AnthropicRequest, targetModel?: string): OpenAIRequest {
  const result: OpenAIRequest = {
    model: targetModel || request.model,
    messages: [],
    stream: request.stream,
  }

  // 转换参数
  if (request.max_tokens) {
    result.max_tokens = request.max_tokens
  }
  if (request.temperature !== undefined) {
    result.temperature = request.temperature
  }
  if (request.top_p !== undefined) {
    result.top_p = request.top_p
  }
  if (request.stop_sequences) {
    result.stop = request.stop_sequences
  }

  // 处理 system prompt
  if (request.system) {
    if (typeof request.system === 'string') {
      result.messages.push({ role: 'system', content: request.system })
    } else if (Array.isArray(request.system)) {
      // 多个 system message 合并
      const systemTexts = request.system
        .filter((s): s is { type: 'text'; text: string } => s.type === 'text')
        .map((s) => s.text)
      if (systemTexts.length > 0) {
        result.messages.push({ role: 'system', content: systemTexts.join('\n') })
      }
    }
  }

  // 转换 messages
  if (request.messages) {
    for (const msg of request.messages) {
      const converted = convertAnthropicMessageToOpenAI(msg)
      result.messages.push(...converted)
    }
  }

  // 转换 tools
  if (request.tools && request.tools.length > 0) {
    result.tools = request.tools
      .filter((t) => t.type !== 'BatchTool') // 过滤 BatchTool
      .map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: cleanSchema(t.input_schema || {}),
        },
      }))
  }

  // 转换 tool_choice
  if (request.tool_choice) {
    if (typeof request.tool_choice === 'object') {
      const tc = request.tool_choice as { type: string; name?: string }
      if (tc.type === 'auto') {
        result.tool_choice = 'auto'
      } else if (tc.type === 'any') {
        result.tool_choice = 'required'
      } else if (tc.type === 'tool' && tc.name) {
        result.tool_choice = { type: 'function', function: { name: tc.name } }
      }
    }
  }

  return result
}

/**
 * 转换单条 Anthropic 消息到 OpenAI 格式
 */
function convertAnthropicMessageToOpenAI(
  msg: { role: string; content: string | AnthropicContentBlockType[] }
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  const role = msg.role as 'user' | 'assistant'

  // 字符串内容
  if (typeof msg.content === 'string') {
    result.push({ role, content: msg.content })
    return result
  }

  // 数组内容
  if (Array.isArray(msg.content)) {
    const contentParts: OpenAIContentPart[] = []
    const toolCalls: OpenAIToolCall[] = []

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            contentParts.push({ type: 'text', text: block.text })
          }
          break

        case 'image':
          if (block.source) {
            let imageUrl: string
            if (block.source.type === 'base64') {
              const mediaType = block.source.media_type || 'image/png'
              imageUrl = `data:${mediaType};base64,${block.source.data}`
            } else {
              imageUrl = block.source.url || ''
            }
            if (imageUrl) {
              contentParts.push({ type: 'image_url', image_url: { url: imageUrl } })
            }
          }
          break

        case 'tool_use':
          if (block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input || {}),
              },
            })
          }
          break

        case 'tool_result':
          // tool_result 变成单独的 tool role 消息
          if (block.tool_use_id) {
            let contentStr: string
            if (typeof block.content === 'string') {
              contentStr = block.content
            } else if (Array.isArray(block.content)) {
              contentStr = block.content
                .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                .map((c) => c.text)
                .join('\n')
            } else {
              contentStr = ''
            }
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: contentStr,
            })
          }
          break

        case 'thinking':
          // 跳过 thinking blocks
          break
      }
    }

    // 添加带内容的消息
    if (contentParts.length > 0 || toolCalls.length > 0) {
      const openAIMsg: OpenAIMessage = { role, content: null }

      // 内容处理
      if (contentParts.length === 0) {
        openAIMsg.content = null
      } else if (contentParts.length === 1 && contentParts[0].type === 'text') {
        openAIMsg.content = contentParts[0].text || ''
      } else {
        openAIMsg.content = contentParts
      }

      // 工具调用
      if (toolCalls.length > 0) {
        openAIMsg.tool_calls = toolCalls
      }

      result.push(openAIMsg)
    }
  }

  return result
}

/**
 * 清理 JSON schema（移除不支持的 format）
 */
function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const result = { ...schema }

  // 移除 "format": "uri"
  if (result.format === 'uri') {
    delete result.format
  }

  // 递归清理嵌套 schema
  if (result.properties && typeof result.properties === 'object') {
    const props = result.properties as Record<string, Record<string, unknown>>
    result.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, cleanSchema(v)])
    )
  }

  if (result.items && typeof result.items === 'object') {
    result.items = cleanSchema(result.items as Record<string, unknown>)
  }

  return result
}

// ============ OpenAI -> Anthropic 响应转换 ============

/** Anthropic 响应格式 */
export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicResponseContent[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

/** Anthropic 响应内容块 */
export interface AnthropicResponseContent {
  type: 'text' | 'tool_use'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

/**
 * 将 OpenAI 响应转换为 Anthropic 响应（非流式）
 */
export function openAIToAnthropic(response: OpenAIResponse): AnthropicResponse {
  const choice = response.choices[0]
  if (!choice) {
    throw new Error('No choices in OpenAI response')
  }

  const content: AnthropicResponseContent[] = []

  // 文本内容
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content })
  }

  // 工具调用
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        // ignore parse errors
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      })
    }
  }

  // 映射 finish_reason -> stop_reason
  const stopReason = mapFinishReasonToStopReason(choice.finish_reason)

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content,
    model: response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
    },
  }
}

/**
 * 映射 OpenAI finish_reason 到 Anthropic stop_reason
 */
function mapFinishReasonToStopReason(
  finishReason: string | null
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

// ============ 流式响应转换 ============

/**
 * 流式转换状态
 */
export interface StreamTransformState {
  messageId: string
  model: string
  messageStarted: boolean
  textContentBlockStarted: boolean
  textContentBlockIndex: number
  toolCallsAccumulator: Map<number, { id: string; name: string; arguments: string }>
  toolCallBlockIndexes: Map<number, number>
  nextContentBlockIndex: number
  finishReason: string | null
  contentBlocksStopped: boolean
  messageDeltaSent: boolean
  messageStopSent: boolean
}

/**
 * 创建新的流式转换状态
 */
export function createStreamTransformState(): StreamTransformState {
  return {
    messageId: '',
    model: '',
    messageStarted: false,
    textContentBlockStarted: false,
    textContentBlockIndex: -1,
    toolCallsAccumulator: new Map(),
    toolCallBlockIndexes: new Map(),
    nextContentBlockIndex: 0,
    finishReason: null,
    contentBlocksStopped: false,
    messageDeltaSent: false,
    messageStopSent: false,
  }
}

/**
 * 将 OpenAI SSE 数据转换为 Anthropic SSE 事件
 */
export function transformOpenAIChunkToAnthropic(
  data: string,
  state: StreamTransformState
): string[] {
  const results: string[] = []

  // 处理 [DONE] 标记
  if (data.trim() === '[DONE]') {
    return transformDoneToAnthropic(state)
  }

  let chunk: OpenAIStreamChunk
  try {
    chunk = JSON.parse(data)
  } catch {
    return results
  }

  // 初始化参数
  if (!state.messageId) {
    state.messageId = chunk.id
  }
  if (!state.model) {
    state.model = chunk.model
  }

  const choice = chunk.choices?.[0]
  if (!choice) {
    return results
  }

  const delta = choice.delta

  // 发送 message_start
  if (!state.messageStarted) {
    const messageStart = {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: state.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }
    results.push(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`)
    state.messageStarted = true
  }

  // 处理文本内容
  if (delta.content) {
    if (!state.textContentBlockStarted) {
      if (state.textContentBlockIndex === -1) {
        state.textContentBlockIndex = state.nextContentBlockIndex++
      }
      const contentBlockStart = {
        type: 'content_block_start',
        index: state.textContentBlockIndex,
        content_block: { type: 'text', text: '' },
      }
      results.push(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`)
      state.textContentBlockStarted = true
    }

    const contentDelta = {
      type: 'content_block_delta',
      index: state.textContentBlockIndex,
      delta: { type: 'text_delta', text: delta.content },
    }
    results.push(`event: content_block_delta\ndata: ${JSON.stringify(contentDelta)}\n\n`)
  }

  // 处理工具调用
  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const index = toolCall.index

      // 初始化累加器
      if (!state.toolCallsAccumulator.has(index)) {
        state.toolCallsAccumulator.set(index, { id: '', name: '', arguments: '' })
      }
      const accumulator = state.toolCallsAccumulator.get(index)!

      // 处理 ID
      if (toolCall.id) {
        accumulator.id = toolCall.id
      }

      // 处理函数
      if (toolCall.function) {
        if (toolCall.function.name) {
          accumulator.name = toolCall.function.name

          // 停止文本内容块
          if (state.textContentBlockStarted) {
            const contentBlockStop = {
              type: 'content_block_stop',
              index: state.textContentBlockIndex,
            }
            results.push(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`)
            state.textContentBlockStarted = false
            state.textContentBlockIndex = -1
          }

          // 获取工具调用的块索引
          let blockIndex = state.toolCallBlockIndexes.get(index)
          if (blockIndex === undefined) {
            blockIndex = state.nextContentBlockIndex++
            state.toolCallBlockIndexes.set(index, blockIndex)
          }

          // 发送 content_block_start
          const contentBlockStart = {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: accumulator.id,
              name: accumulator.name,
              input: {},
            },
          }
          results.push(`event: content_block_start\ndata: ${JSON.stringify(contentBlockStart)}\n\n`)
        }

        // 累积参数
        if (toolCall.function.arguments) {
          accumulator.arguments += toolCall.function.arguments
        }
      }
    }
  }

  // 处理 finish_reason
  if (choice.finish_reason) {
    state.finishReason = choice.finish_reason

    // 停止文本内容块
    if (state.textContentBlockStarted) {
      const contentBlockStop = {
        type: 'content_block_stop',
        index: state.textContentBlockIndex,
      }
      results.push(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`)
      state.textContentBlockStarted = false
    }

    // 停止工具调用块
    if (!state.contentBlocksStopped) {
      for (const [index, accumulator] of state.toolCallsAccumulator) {
        const blockIndex = state.toolCallBlockIndexes.get(index)
        if (blockIndex !== undefined && accumulator.arguments) {
          // 发送完整的参数
          const inputDelta = {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'input_json_delta', partial_json: accumulator.arguments },
          }
          results.push(`event: content_block_delta\ndata: ${JSON.stringify(inputDelta)}\n\n`)

          // 停止块
          const contentBlockStop = {
            type: 'content_block_stop',
            index: blockIndex,
          }
          results.push(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`)
        }
      }
      state.contentBlocksStopped = true
    }

    // 发送 message_delta
    const inputTokens = chunk.usage?.prompt_tokens || 0
    const outputTokens = chunk.usage?.completion_tokens || 0
    const messageDelta = {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReasonToStopReason(state.finishReason),
        stop_sequence: null,
      },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }
    results.push(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
    state.messageDeltaSent = true

    // 发送 message_stop
    if (!state.messageStopSent) {
      results.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
      state.messageStopSent = true
    }
  }

  return results
}

/**
 * 处理 [DONE] 标记
 */
function transformDoneToAnthropic(state: StreamTransformState): string[] {
  const results: string[] = []

  // 停止文本内容块
  if (state.textContentBlockStarted) {
    const contentBlockStop = {
      type: 'content_block_stop',
      index: state.textContentBlockIndex,
    }
    results.push(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`)
    state.textContentBlockStarted = false
  }

  // 停止工具调用块
  if (!state.contentBlocksStopped) {
    for (const [index, accumulator] of state.toolCallsAccumulator) {
      const blockIndex = state.toolCallBlockIndexes.get(index)
      if (blockIndex !== undefined && accumulator.arguments) {
        const inputDelta = {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: accumulator.arguments },
        }
        results.push(`event: content_block_delta\ndata: ${JSON.stringify(inputDelta)}\n\n`)

        const contentBlockStop = {
          type: 'content_block_stop',
          index: blockIndex,
        }
        results.push(`event: content_block_stop\ndata: ${JSON.stringify(contentBlockStop)}\n\n`)
      }
    }
    state.contentBlocksStopped = true
  }

  // 发送 message_delta（如果还没发送）
  if (state.finishReason && !state.messageDeltaSent) {
    const messageDelta = {
      type: 'message_delta',
      delta: {
        stop_reason: mapFinishReasonToStopReason(state.finishReason),
        stop_sequence: null,
      },
    }
    results.push(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
    state.messageDeltaSent = true
  }

  // 发送 message_stop
  if (!state.messageStopSent) {
    results.push(`event: message_stop\ndata: {"type":"message_stop"}\n\n`)
    state.messageStopSent = true
  }

  return results
}
