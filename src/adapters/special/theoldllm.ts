import type {
  Adapter,
  OpenAIChatRequest,
  OpenAIStreamChunk,
  OpenAIModel,
  Credentials,
  TargetRequest,
  CaptureRule,
  ModelCaptureConfig
} from '../../types'

interface TheOldLLMRequest {
  message: string
  chat_session_id: string
  parent_message_id: string | null
  file_descriptors: string[]
  search_doc_ids: string[]
  retrieval_options: Record<string, unknown>
}

interface TheOldLLMChunk {
  obj: {
    type: 'message_start' | 'message_delta' | 'stop' | string
    content?: string
    message_id?: string
  }
}

export const theOldLLMAdapter: Adapter = {
  name: 'theoldllm',
  urlPattern: 'theoldllm.vercel.app',
  targetBaseUrl: 'https://theoldllm.vercel.app',

  transformRequest(openaiReq: OpenAIChatRequest, credentials: Credentials): TargetRequest {
    // Extract the last user message
    const lastUserMessage = openaiReq.messages
      .filter(m => m.role === 'user')
      .pop()

    const body: TheOldLLMRequest = {
      message: lastUserMessage?.content || '',
      chat_session_id: credentials.sessionId || '',
      parent_message_id: null,
      file_descriptors: [],
      search_doc_ids: [],
      retrieval_options: {}
    }

    return {
      url: `${this.targetBaseUrl}/sv5/chat/send-message`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': credentials.authorization || ''
      },
      body: JSON.stringify(body)
    }
  },

  transformStreamChunk(chunk: unknown): OpenAIStreamChunk | null {
    const data = chunk as TheOldLLMChunk

    if (!data.obj || typeof data.obj !== 'object') {
      return null
    }

    const { type, content } = data.obj

    // Generate a unique ID for this chunk
    const chunkId = `chatcmpl-${Date.now()}`
    const timestamp = Math.floor(Date.now() / 1000)

    if (type === 'message_delta' && content) {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: 'theoldllm',
        choices: [{
          index: 0,
          delta: { content },
          finish_reason: null
        }]
      }
    }

    if (type === 'stop') {
      return {
        id: chunkId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: 'theoldllm',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      }
    }

    // Ignore message_start and other types
    return null
  },

  getModels(): OpenAIModel[] {
    return [{
      id: 'theoldllm',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'theoldllm'
    }]
  },

  getDefaultCaptureRules(): CaptureRule[] {
    return [
      {
        urlPattern: '*theoldllm.vercel.app/sv5/chat/create-chat-session*',
        captureAuth: true,
        captureSessionId: true,
        sessionIdField: 'chat_session_id',
        sessionIdSource: 'response'
      },
      {
        urlPattern: '*theoldllm.vercel.app/sv5/chat/send-message*',
        captureAuth: true,
        captureSessionId: true,
        sessionIdField: 'chat_session_id',
        sessionIdSource: 'body'
      }
    ]
  },

  getDefaultModelCaptureConfig(): ModelCaptureConfig {
    return {
      urlPattern: '*theoldllm.vercel.app/sv5/llm/provider*',
      responseField: 'model_configurations',
      modelNameField: 'name',
      modelIdField: 'name',
      displayNameField: 'display_name'
    }
  }
}

// Default export for auto-registration
export default theOldLLMAdapter
