import https from 'node:https'
import type {
  WebSocketAdapter,
  OpenAIChatRequest,
  OpenAIStreamChunk,
  OpenAIModel,
  Credentials,
  SiteConfig,
  ModelInfo
} from '../../types'
import { getMainLogger } from '../../logger'
import { isTokenExpired } from '../../token-refresh'

const log = getMainLogger()

/**
 * Gumloop WebSocket Message Types
 */
interface GumloopStartMessage {
  type: 'start'
  payload: {
    id_token: string
    context: GumloopContext
  }
}

// GumloopContext is the context object expected by the server
interface GumloopContext {
  chat: GumloopChat
  type: 'chat'
  gummie_id: string
}

interface GumloopChat {
  id: string
  msgs: GumloopChatMessage[]
}

interface GumloopAssistantMessage {
  id: string
  role: 'assistant'
  parts: GumloopMessagePart[]
  timestamp: string
}

interface GumloopUserMessage {
  id: string
  role: 'user'
  content: string
  timestamp: string
}

type GumloopChatMessage = GumloopAssistantMessage | GumloopUserMessage

interface GumloopMessagePart {
  id: string
  type: 'text'
  text: string
}

interface GumloopTextDelta {
  type: 'text-delta'
  id: string
  delta: string
  providerMetadata: unknown
}

interface GumloopFinish {
  type: 'finish'
  finishReason: string
  usage: {
    input_tokens: number
    output_tokens: number
    cached_tokens: number
    total_tokens: number
  }
  credits: number
  providerMetadata: unknown
  final: boolean
}

type GumloopMessage = GumloopTextDelta | GumloopFinish | { type: string; [key: string]: unknown }

/**
 * Gumloop WebSocket Adapter
 *
 * Gumloop uses WebSocket for real-time chat communication.
 * WebSocket URL: wss://ws.gumloop.com/ws/gummies
 *
 * Protocol:
 * 1. Client sends "start" message with id_token, gummie_id, chat_id, and message
 * 2. Server responds with streaming messages:
 *    - step-start: Processing started
 *    - reasoning-start/delta/end: Thinking process (optional)
 *    - text-start: Text response starting
 *    - text-delta: Text content chunks
 *    - text-end: Text response complete
 *    - finish: Final message with usage stats
 */
export const gumloopAdapter: WebSocketAdapter = {
  name: 'gumloop',
  isWebSocket: true,
  urlPattern: 'gumloop.com',
  wsUrl: 'wss://ws.gumloop.com/ws/gummies',

  createConnectMessage(_credentials: Credentials, _siteConfig: SiteConfig): string | null {
    // Gumloop doesn't need a separate connection message
    // Authentication is included in the start message
    return null
  },

  createChatMessage(openaiReq: OpenAIChatRequest, credentials: Credentials, siteConfig: SiteConfig): string {
    // Extract the last user message
    const lastUserMessage = openaiReq.messages
      .filter(m => m.role === 'user')
      .pop()
    const userMessage = lastUserMessage?.content || ''

    // Get gummie_id: priority is adapterConfig.modelId > adapterConfig.gummieId > URL extraction
    let gummieId = ''

    // First priority: modelId from adapterConfig (set by api-server based on model name)
    if (siteConfig.adapterConfig?.modelId) {
      gummieId = siteConfig.adapterConfig.modelId as string
    }
    // Second priority: gummieId from adapterConfig
    else if (siteConfig.adapterConfig?.gummieId) {
      gummieId = siteConfig.adapterConfig.gummieId as string
    }
    // Fallback: extract from targetUrl
    else {
      const urlMatch = siteConfig.targetUrl.match(/\/agents\/([^/]+)/)
      if (urlMatch) {
        gummieId = urlMatch[1]
      }
    }

    // Generate a chat_id for this conversation
    const chatId = siteConfig.adapterConfig?.chatId as string ||
      `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 15)}`

    // Build chat messages from previous messages (excluding the last user message)
    const chatMsgs: GumloopChatMessage[] = []

    // Add initial assistant message
    chatMsgs.push({
      id: 'GUMMIE_INITIAL_MESSAGE',
      role: 'assistant',
      parts: [{
        id: 'GUMMIE_INITIAL_MESSAGE_PART',
        type: 'text',
        text: "Hey, I'm your custom Gumloop Agent! Let me know how I can assist."
      }],
      timestamp: new Date().toISOString()
    })

    // Add previous conversation messages
    for (let i = 0; i < openaiReq.messages.length - 1; i++) {
      const msg = openaiReq.messages[i]
      const msgId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`

      if (msg.role === 'assistant') {
        chatMsgs.push({
          id: msgId,
          role: 'assistant',
          parts: [{
            id: `${msgId}-part`,
            type: 'text',
            text: msg.content
          }],
          timestamp: new Date().toISOString()
        })
      } else if (msg.role === 'user') {
        chatMsgs.push({
          id: msgId,
          role: 'user',
          content: msg.content,
          timestamp: new Date().toISOString()
        })
      }
    }

    // Add the current user message
    const userMsgId = `msg-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`
    chatMsgs.push({
      id: userMsgId,
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    })

    // Gumloop expects context with chat object containing id and msgs
    const context: GumloopContext = {
      chat: {
        id: chatId,
        msgs: chatMsgs
      },
      type: 'chat',
      gummie_id: gummieId
    }

    // The id_token is the Firebase JWT token captured from Authorization header
    // Format: "Bearer eyJhbGc..." -> extract just the token
    let idToken = credentials.authorization || ''
    if (idToken.startsWith('Bearer ')) {
      idToken = idToken.substring(7)
    }

    const message: GumloopStartMessage = {
      type: 'start',
      payload: {
        id_token: idToken,
        context: context
      }
    }

    log.info(`[Gumloop] Creating chat message for gummie: ${gummieId}`)
    log.debug(`[Gumloop] Message: ${userMessage.substring(0, 100)}...`)
    log.debug(`[Gumloop] Chat messages: ${chatMsgs.length}`)

    return JSON.stringify(message)
  },

  transformMessage(data: string): OpenAIStreamChunk | null {
    try {
      const msg = JSON.parse(data) as GumloopMessage
      const chunkId = `chatcmpl-${Date.now()}`
      const timestamp = Math.floor(Date.now() / 1000)

      // Handle text-delta messages (actual response content)
      if (msg.type === 'text-delta') {
        const textDelta = msg as GumloopTextDelta
        return {
          id: chunkId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: 'gumloop',
          choices: [{
            index: 0,
            delta: { content: textDelta.delta },
            finish_reason: null
          }]
        }
      }

      // Handle finish message
      if (msg.type === 'finish') {
        const finish = msg as GumloopFinish
        if (finish.final) {
          return {
            id: chunkId,
            object: 'chat.completion.chunk',
            created: timestamp,
            model: 'gumloop',
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          }
        }
      }

      // Ignore other message types (step-start, reasoning-*, text-start, text-end)
      return null
    } catch (err) {
      log.warn(`[Gumloop] Failed to parse message: ${data}`, err)
      return null
    }
  },

  isComplete(data: string): boolean {
    try {
      const msg = JSON.parse(data) as GumloopMessage
      if (msg.type === 'finish') {
        const finish = msg as GumloopFinish
        return finish.final === true
      }
      return false
    } catch {
      return false
    }
  },

  getModels(): OpenAIModel[] {
    // Static fallback - actual models are fetched dynamically via fetchDynamicModels
    return []
  },

  // Adapter capabilities
  capabilities: {
    dynamicModels: true
  },

  // Fetch dynamic models from Gumloop API
  async fetchDynamicModels(credentials: Credentials): Promise<ModelInfo[]> {
    return fetchGumloopModels(credentials)
  }
}

/**
 * Gumloop API response for gummies list
 */
interface GumloopGummie {
  gummie_id: string
  name: string
  model_name: string
  description: string
  author_id: string
  is_active: boolean
}

/**
 * Fetch models from Gumloop API
 * Returns a list of ModelInfo with model_name as the exposed model name
 * and gummie_id as the internal ID
 */
export async function fetchGumloopModels(credentials: Credentials): Promise<ModelInfo[]> {
  if (!credentials.authorization) {
    log.warn('[Gumloop] No authorization token, cannot fetch models')
    return []
  }

  // Check if token is expired BEFORE making any request
  if (isTokenExpired(credentials.authorization)) {
    log.debug('[Gumloop] Token expired, skipping model fetch')
    return []
  }

  // Extract user ID from JWT token to get author_id
  let authorId: string | null = null
  try {
    const token = credentials.authorization.startsWith('Bearer ')
      ? credentials.authorization.substring(7)
      : credentials.authorization

    // Decode JWT payload (base64)
    const parts = token.split('.')
    if (parts.length >= 2) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
      authorId = payload.user_id || payload.sub
    }
  } catch (err) {
    log.warn('[Gumloop] Failed to decode JWT token:', err)
  }

  if (!authorId) {
    log.warn('[Gumloop] Could not extract author_id from token')
    return []
  }

  const url = `https://api.gumloop.com/gummies?author_id=${authorId}`
  log.info(`[Gumloop] Fetching models from ${url}`)

  // Extract just the token (without Bearer prefix) for the API call
  let token = credentials.authorization!
  if (token.startsWith('Bearer ')) {
    token = token.substring(7)
  }

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-auth-key': authorId,
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': 'https://www.gumloop.com',
        'Referer': 'https://www.gumloop.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            log.warn(`[Gumloop] API returned ${res.statusCode}: ${data}`)
            resolve([])
            return
          }

          const gummies = JSON.parse(data) as GumloopGummie[]
          const models: ModelInfo[] = []
          const seenModelNames = new Set<string>()

          for (const gummie of gummies) {
            if (!gummie.is_active) continue
            if (!gummie.model_name) continue

            // Only keep first gummie for each model_name
            if (seenModelNames.has(gummie.model_name)) continue
            seenModelNames.add(gummie.model_name)

            // Display format: "Agent Name (model_name)"
            // e.g., "Silver Raven (claude-opus-4-5)"
            const displayName = `${gummie.name} (${gummie.model_name})`

            models.push({
              modelName: gummie.model_name,
              modelId: gummie.gummie_id,
              displayName
            })
          }

          log.info(`[Gumloop] Fetched ${models.length} models: ${models.map(m => m.modelName).join(', ')}`)
          resolve(models)
        } catch (err) {
          log.error('[Gumloop] Failed to parse API response:', err)
          resolve([])
        }
      })
    })

    req.on('error', (err) => {
      log.error('[Gumloop] API request failed:', err)
      resolve([])
    })

    req.setTimeout(10000, () => {
      log.warn('[Gumloop] API request timeout')
      req.destroy()
      resolve([])
    })
  })
}

// Default export for auto-registration
export default gumloopAdapter
