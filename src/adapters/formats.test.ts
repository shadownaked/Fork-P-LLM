import { describe, it, expect } from 'vitest'
import {
  transformRequestBody,
  detectRequestFormat,
  parseResponseChunk,
  detectResponseFormat,
  mapFinishReason,
  ANTHROPIC_STOP_REASON_MAP,
  type RequestFormatConfig,
  type ResponseFormatConfig
} from './formats'

describe('Request Format Detection', () => {
  it('should detect parts format', () => {
    const template = {
      messages: [{
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }]
      }]
    }
    expect(detectRequestFormat(template)).toBe('parts')
  })

  it('should detect openai format', () => {
    const template = {
      messages: [{
        role: 'user',
        content: 'hello'
      }]
    }
    expect(detectRequestFormat(template)).toBe('openai')
  })

  it('should detect simple-message format', () => {
    const template = { message: 'hello' }
    expect(detectRequestFormat(template)).toBe('simple-message')
  })

  it('should detect simple-content format', () => {
    const template = { content: 'hello' }
    expect(detectRequestFormat(template)).toBe('simple-content')
  })

  it('should detect simple-prompt format', () => {
    const template = { prompt: 'hello' }
    expect(detectRequestFormat(template)).toBe('simple-prompt')
  })
})

describe('Request Body Transformation', () => {
  const messages = [
    { role: 'user' as const, content: 'What is 2+2?' }
  ]

  it('should transform parts format', () => {
    const template = {
      modelId: 'gpt-4',
      id: 'old-id',
      messages: [{
        role: 'user',
        parts: [{ type: 'text', text: 'old message' }],
        id: 'msg-1'
      }]
    }
    const config: RequestFormatConfig = { format: 'parts' }
    const result = transformRequestBody(template, messages, config)

    expect(result.modelId).toBe('gpt-4')
    expect((result.messages as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text).toBe('What is 2+2?')
    // ID should be regenerated
    expect(result.id).not.toBe('old-id')
  })

  it('should transform openai format', () => {
    const template = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'old' }]
    }
    const config: RequestFormatConfig = { format: 'openai' }
    const result = transformRequestBody(template, messages, config)

    expect(result.model).toBe('gpt-4')
    expect(result.messages).toEqual(messages)
  })

  it('should transform simple-message format', () => {
    const template = { message: 'old', sessionId: 'old-session' }
    const config: RequestFormatConfig = { format: 'simple-message' }
    const result = transformRequestBody(template, messages, config)

    expect(result.message).toBe('What is 2+2?')
  })

  it('should regenerate ID fields', () => {
    const template = {
      id: 'old-id',
      conversationId: 'old-conv',
      message: 'old'
    }
    const config: RequestFormatConfig = { format: 'simple-message' }
    const result = transformRequestBody(template, messages, config)

    expect(result.id).not.toBe('old-id')
    // Only first ID field is regenerated
    expect(result.conversationId).toBe('old-conv')
  })
})

describe('Response Format Detection', () => {
  it('should detect openai format', () => {
    const data = {
      choices: [{ delta: { content: 'hello' } }]
    }
    expect(detectResponseFormat(data)).toBe('openai')
  })

  it('should detect text-delta format', () => {
    const data = { type: 'text-delta', delta: 'hello' }
    expect(detectResponseFormat(data)).toBe('text-delta')
  })

  it('should detect text-delta format from text-start', () => {
    const data = { type: 'text-start', id: 'msg-1' }
    expect(detectResponseFormat(data)).toBe('text-delta')
  })

  it('should detect obj-content format', () => {
    const data = { obj: { type: 'message_delta', content: 'hello' } }
    expect(detectResponseFormat(data)).toBe('obj-content')
  })

  it('should detect simple-content format', () => {
    const data = { content: 'hello' }
    expect(detectResponseFormat(data)).toBe('simple-content')
  })
})

describe('Response Chunk Parsing', () => {
  it('should parse openai format', () => {
    const data = {
      choices: [{ delta: { content: 'Hello' }, finish_reason: null }]
    }
    const config: ResponseFormatConfig = { format: 'openai' }
    const result = parseResponseChunk(data, config)

    expect(result.content).toBe('Hello')
    expect(result.isStop).toBe(false)
  })

  it('should parse openai format stop signal', () => {
    const data = {
      choices: [{ delta: {}, finish_reason: 'stop' }]
    }
    const config: ResponseFormatConfig = { format: 'openai' }
    const result = parseResponseChunk(data, config)

    expect(result.content).toBe(null)
    expect(result.isStop).toBe(true)
  })

  it('should parse text-delta format', () => {
    const data = { type: 'text-delta', delta: 'World' }
    const config: ResponseFormatConfig = { format: 'text-delta' }
    const result = parseResponseChunk(data, config)

    expect(result.content).toBe('World')
    expect(result.isStop).toBe(false)
  })

  it('should parse text-delta format finish signal', () => {
    const data = { type: 'finish', finishReason: 'stop' }
    const config: ResponseFormatConfig = { format: 'text-delta' }
    const result = parseResponseChunk(data, config)

    expect(result.content).toBe(null)
    expect(result.isStop).toBe(true)
  })

  it('should parse obj-content format', () => {
    const data = { obj: { type: 'message_delta', content: 'Test' } }
    const config: ResponseFormatConfig = { format: 'obj-content' }
    const result = parseResponseChunk(data, config)

    expect(result.content).toBe('Test')
    expect(result.isStop).toBe(false)
  })

  it('should parse obj-content format stop signal', () => {
    const data = { obj: { type: 'stop' } }
    const config: ResponseFormatConfig = { format: 'obj-content' }
    const result = parseResponseChunk(data, config)

    expect(result.content).toBe(null)
    expect(result.isStop).toBe(true)
  })

  it('should handle common stop signals', () => {
    const config: ResponseFormatConfig = { format: 'simple-content' }

    expect(parseResponseChunk({ done: true }, config).isStop).toBe(true)
    expect(parseResponseChunk({ finished: true }, config).isStop).toBe(true)
    expect(parseResponseChunk({ stop: true }, config).isStop).toBe(true)
  })
})

describe('typli.ai Integration', () => {
  it('should correctly transform typli.ai request', () => {
    const template = {
      modelId: 'openai/gpt-5.2',
      id: '752d50a0-17b1-4051-8f5f-181235cc1fa6',
      messages: [{
        role: 'user',
        parts: [{ type: 'text', text: '你好啊' }],
        id: '3619090e-899e-48d2-b29a-f289d1b434e5'
      }],
      trigger: 'submit-message'
    }

    const messages = [{ role: 'user' as const, content: '请你输出一段防抖的js代码' }]
    const config: RequestFormatConfig = { format: 'parts' }

    const result = transformRequestBody(template, messages, config)

    // Message should be replaced
    expect((result.messages as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text)
      .toBe('请你输出一段防抖的js代码')

    // Other fields should be preserved
    expect(result.modelId).toBe('openai/gpt-5.2')
    expect(result.trigger).toBe('submit-message')

    // ID should be regenerated
    expect(result.id).not.toBe('752d50a0-17b1-4051-8f5f-181235cc1fa6')
  })

  it('should correctly parse typli.ai response', () => {
    const config: ResponseFormatConfig = { format: 'text-delta' }

    // Content chunk
    const contentChunk = { type: 'text-delta', delta: 'Hello!' }
    expect(parseResponseChunk(contentChunk, config).content).toBe('Hello!')

    // Finish chunk
    const finishChunk = { type: 'finish', finishReason: 'stop' }
    expect(parseResponseChunk(finishChunk, config).isStop).toBe(true)

    // Start chunk (should be ignored)
    const startChunk = { type: 'start', messageId: 'xxx' }
    const startResult = parseResponseChunk(startChunk, config)
    expect(startResult.content).toBe(null)
    expect(startResult.isStop).toBe(false)
  })
})

describe('theoldllm Integration', () => {
  it('should correctly parse theoldllm response', () => {
    const config: ResponseFormatConfig = { format: 'obj-content' }

    // Content chunk
    const contentChunk = { obj: { type: 'message_delta', content: 'Hello!' } }
    expect(parseResponseChunk(contentChunk, config).content).toBe('Hello!')

    // Stop chunk
    const stopChunk = { obj: { type: 'stop' } }
    expect(parseResponseChunk(stopChunk, config).isStop).toBe(true)

    // Start chunk (should be ignored)
    const startChunk = { obj: { type: 'message_start', message_id: 'xxx' } }
    const startResult = parseResponseChunk(startChunk, config)
    expect(startResult.content).toBe(null)
    expect(startResult.isStop).toBe(false)
  })
})

describe('Finish Reason Mapping', () => {
  it('should map Anthropic stop reasons correctly', () => {
    expect(mapFinishReason('end_turn')).toBe('stop')
    expect(mapFinishReason('max_tokens')).toBe('length')
    expect(mapFinishReason('stop_sequence')).toBe('stop')
    expect(mapFinishReason('tool_use')).toBe('tool_calls')
  })

  it('should pass through OpenAI finish reasons', () => {
    expect(mapFinishReason('stop')).toBe('stop')
    expect(mapFinishReason('length')).toBe('length')
    expect(mapFinishReason('tool_calls')).toBe('tool_calls')
  })

  it('should handle null and undefined', () => {
    expect(mapFinishReason(null)).toBe(null)
    expect(mapFinishReason(undefined)).toBe(null)
  })

  it('should default unknown reasons to stop', () => {
    expect(mapFinishReason('unknown_reason')).toBe('stop')
  })

  it('should have correct ANTHROPIC_STOP_REASON_MAP', () => {
    expect(ANTHROPIC_STOP_REASON_MAP.end_turn).toBe('stop')
    expect(ANTHROPIC_STOP_REASON_MAP.max_tokens).toBe('length')
    expect(ANTHROPIC_STOP_REASON_MAP.stop_sequence).toBe('stop')
    expect(ANTHROPIC_STOP_REASON_MAP.tool_use).toBe('tool_calls')
  })
})

describe('Anthropic Response Format', () => {
  it('should detect anthropic format', () => {
    expect(detectResponseFormat({ type: 'message_start' })).toBe('anthropic')
    expect(detectResponseFormat({ type: 'content_block_delta' })).toBe('anthropic')
    expect(detectResponseFormat({ type: 'message_delta' })).toBe('anthropic')
    expect(detectResponseFormat({ type: 'message_stop' })).toBe('anthropic')
    expect(detectResponseFormat({ type: 'ping' })).toBe('anthropic')
  })

  it('should parse message_start event', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = {
      type: 'message_start',
      message: { id: 'msg_123', role: 'assistant' }
    }
    const result = parseResponseChunk(data, config)
    expect(result.role).toBe('assistant')
    expect(result.content).toBe(null)
    expect(result.isStop).toBe(false)
  })

  it('should parse content_block_start event with text', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    }
    const result = parseResponseChunk(data, config)
    // content_block_start with empty text should return null (empty string is falsy for content)
    expect(result.content).toBe(null)
    expect(result.isStop).toBe(false)
  })

  it('should parse content_block_delta event', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello, ' }
    }
    const result = parseResponseChunk(data, config)
    expect(result.content).toBe('Hello, ')
    expect(result.isStop).toBe(false)
  })

  it('should parse message_delta event with stop_reason', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null }
    }
    const result = parseResponseChunk(data, config)
    expect(result.isStop).toBe(true)
    expect(result.finishReason).toBe('stop')
  })

  it('should parse message_delta with max_tokens stop reason', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' }
    }
    const result = parseResponseChunk(data, config)
    expect(result.isStop).toBe(true)
    expect(result.finishReason).toBe('length')
  })

  it('should parse message_stop event', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = { type: 'message_stop' }
    const result = parseResponseChunk(data, config)
    expect(result.isStop).toBe(true)
    expect(result.finishReason).toBe('stop')
  })

  it('should ignore ping events', () => {
    const config: ResponseFormatConfig = { format: 'anthropic' }
    const data = { type: 'ping' }
    const result = parseResponseChunk(data, config)
    expect(result.content).toBe(null)
    expect(result.isStop).toBe(false)
  })
})

describe('OpenAI Response Format with finish_reason', () => {
  it('should parse finish_reason stop', () => {
    const config: ResponseFormatConfig = { format: 'openai' }
    const data = {
      choices: [{ delta: { content: '' }, finish_reason: 'stop' }]
    }
    const result = parseResponseChunk(data, config)
    expect(result.isStop).toBe(true)
    expect(result.finishReason).toBe('stop')
  })

  it('should parse finish_reason length', () => {
    const config: ResponseFormatConfig = { format: 'openai' }
    const data = {
      choices: [{ delta: {}, finish_reason: 'length' }]
    }
    const result = parseResponseChunk(data, config)
    expect(result.isStop).toBe(true)
    expect(result.finishReason).toBe('length')
  })

  it('should parse finish_reason tool_calls', () => {
    const config: ResponseFormatConfig = { format: 'openai' }
    const data = {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }]
    }
    const result = parseResponseChunk(data, config)
    expect(result.isStop).toBe(true)
    expect(result.finishReason).toBe('tool_calls')
  })

  it('should parse role from delta', () => {
    const config: ResponseFormatConfig = { format: 'openai' }
    const data = {
      choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }]
    }
    const result = parseResponseChunk(data, config)
    expect(result.role).toBe('assistant')
  })
})
