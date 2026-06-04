import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock data stores - must be defined before vi.mock calls
const mockSessionIds = new Map<string, string>()
const mockModels = new Map<string, Array<{ modelName: string; modelId: string; displayName?: string }>>()
const mockSites = new Map<string, {
  id: string
  captureRules: Array<{
    urlPattern: string
    captureAuth: boolean
    captureSessionId: boolean
    sessionIdField?: string
    sessionIdSource?: 'url' | 'body' | 'response'
  }>
  modelCaptureConfig?: {
    urlPattern: string
    responseField: string
    modelNameField: string
    modelIdField?: string
    displayNameField?: string
  }
}>()

// Mock the logger
vi.mock('./logger', () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock credential store
vi.mock('./store/credential-store', () => ({
  credentialStore: {
    setSessionId(siteId: string, sessionId: string) {
      mockSessionIds.set(siteId, sessionId)
    },
    getSessionId(siteId: string) {
      return mockSessionIds.get(siteId)
    }
  }
}))

// Mock model store
vi.mock('./store/model-store', () => ({
  modelStore: {
    setModels(siteId: string, models: Array<{ modelName: string; modelId: string; displayName?: string }>) {
      mockModels.set(siteId, models)
    },
    getModels(siteId: string) {
      return mockModels.get(siteId) || []
    }
  }
}))

// Mock site store
vi.mock('./store/site-store', () => ({
  siteStore: {
    getById(id: string) {
      return mockSites.get(id)
    }
  }
}))

// Import after mocks
import {
  captureSessionIdFromBody,
  captureSessionIdFromResponse,
  captureModelsFromResponse
} from './capture-handler'

describe('capture-handler', () => {
  beforeEach(() => {
    mockSessionIds.clear()
    mockModels.clear()
    mockSites.clear()
  })

  describe('captureSessionIdFromBody', () => {
    it('should capture sessionId from request body when rule matches', () => {
      // Setup site with body capture rule
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [{
          urlPattern: '*sv5/chat/send-message*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'chat_session_id',
          sessionIdSource: 'body'
        }]
      })

      const postData = JSON.stringify({
        message: 'Hello',
        chat_session_id: 'session-123',
        parent_message_id: null
      })

      const result = captureSessionIdFromBody(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/chat/send-message',
        postData
      )

      expect(result).toBe(true)
      expect(mockSessionIds.get('theoldllm')).toBe('session-123')
    })

    it('should not capture when URL does not match pattern', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [{
          urlPattern: '*sv5/chat/send-message*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'chat_session_id',
          sessionIdSource: 'body'
        }]
      })

      const postData = JSON.stringify({
        chat_session_id: 'session-123'
      })

      const result = captureSessionIdFromBody(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/other/endpoint',
        postData
      )

      expect(result).toBe(false)
      expect(mockSessionIds.get('theoldllm')).toBeUndefined()
    })

    it('should not capture when sessionIdSource is not body', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [{
          urlPattern: '*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'chat_session_id',
          sessionIdSource: 'response' // Not body
        }]
      })

      const postData = JSON.stringify({
        chat_session_id: 'session-123'
      })

      const result = captureSessionIdFromBody(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/chat/send-message',
        postData
      )

      expect(result).toBe(false)
    })

    it('should handle invalid JSON gracefully', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [{
          urlPattern: '*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'chat_session_id',
          sessionIdSource: 'body'
        }]
      })

      const result = captureSessionIdFromBody(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/chat/send-message',
        'not valid json'
      )

      expect(result).toBe(false)
    })

    it('should return false for unknown site', () => {
      const result = captureSessionIdFromBody(
        'unknown-site',
        'https://example.com/api',
        JSON.stringify({ session_id: '123' })
      )

      expect(result).toBe(false)
    })
  })

  describe('captureSessionIdFromResponse', () => {
    it('should capture sessionId from response body when rule matches', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [{
          urlPattern: '*sv5/chat/create-chat-session*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'chat_session_id',
          sessionIdSource: 'response'
        }]
      })

      const responseBody = JSON.stringify({
        chat_session_id: 'new-session-456',
        created_at: '2024-01-01'
      })

      const result = captureSessionIdFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/chat/create-chat-session',
        responseBody
      )

      expect(result).toBe(true)
      expect(mockSessionIds.get('theoldllm')).toBe('new-session-456')
    })

    it('should not capture when sessionIdSource is not response', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [{
          urlPattern: '*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'chat_session_id',
          sessionIdSource: 'body' // Not response
        }]
      })

      const responseBody = JSON.stringify({
        chat_session_id: 'session-123'
      })

      const result = captureSessionIdFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/chat/create-chat-session',
        responseBody
      )

      expect(result).toBe(false)
    })
  })

  describe('captureModelsFromResponse', () => {
    it('should capture models from response body when config matches', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [],
        modelCaptureConfig: {
          urlPattern: '*sv5/llm/provider*',
          responseField: 'model_configurations',
          modelNameField: 'name',
          displayNameField: 'name'
        }
      })

      const responseBody = JSON.stringify({
        model_configurations: [
          { name: 'gpt-4', description: 'GPT-4 model' },
          { name: 'claude-3', description: 'Claude 3 model' },
          { name: 'gemini-pro', description: 'Gemini Pro model' }
        ]
      })

      const result = captureModelsFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/llm/provider',
        responseBody
      )

      expect(result).toBe(true)

      const models = mockModels.get('theoldllm')
      expect(models).toHaveLength(3)
      expect(models![0].modelName).toBe('theoldllm/gpt-4')
      expect(models![0].modelId).toBe('gpt-4')
      expect(models![1].modelName).toBe('theoldllm/claude-3')
      expect(models![2].modelName).toBe('theoldllm/gemini-pro')
    })

    it('should capture models from array response body', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [],
        modelCaptureConfig: {
          urlPattern: '*sv5/llm/provider*',
          responseField: 'model_configurations',
          modelNameField: 'name',
          displayNameField: 'display_name'
        }
      })

      const responseBody = JSON.stringify([
        {
          provider: 'openai',
          model_configurations: [
            { name: 'gpt-4', display_name: 'GPT-4' },
            { name: 'gpt-4o', display_name: 'GPT-4o' }
          ]
        },
        {
          provider: 'anthropic',
          model_configurations: [
            { name: 'claude-3', display_name: 'Claude 3' }
          ]
        }
      ])

      const result = captureModelsFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/llm/provider',
        responseBody
      )

      expect(result).toBe(true)

      const models = mockModels.get('theoldllm')
      expect(models).toHaveLength(3)
      expect(models![0].modelName).toBe('theoldllm/gpt-4')
      expect(models![0].displayName).toBe('GPT-4')
      expect(models![2].modelName).toBe('theoldllm/claude-3')
    })

    it('should not capture when URL does not match pattern', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [],
        modelCaptureConfig: {
          urlPattern: '*sv5/llm/provider*',
          responseField: 'model_configurations',
          modelNameField: 'name'
        }
      })

      const responseBody = JSON.stringify({
        model_configurations: [{ name: 'gpt-4' }]
      })

      const result = captureModelsFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/other/endpoint',
        responseBody
      )

      expect(result).toBe(false)
      expect(mockModels.get('theoldllm')).toBeUndefined()
    })

    it('should not capture when site has no modelCaptureConfig', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: []
        // No modelCaptureConfig
      })

      const responseBody = JSON.stringify({
        model_configurations: [{ name: 'gpt-4' }]
      })

      const result = captureModelsFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/llm/provider',
        responseBody
      )

      expect(result).toBe(false)
    })

    it('should handle invalid JSON gracefully', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [],
        modelCaptureConfig: {
          urlPattern: '*sv5/llm/provider*',
          responseField: 'model_configurations',
          modelNameField: 'name'
        }
      })

      const result = captureModelsFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/llm/provider',
        'not valid json'
      )

      expect(result).toBe(false)
    })

    it('should skip items without required modelNameField', () => {
      mockSites.set('theoldllm', {
        id: 'theoldllm',
        captureRules: [],
        modelCaptureConfig: {
          urlPattern: '*sv5/llm/provider*',
          responseField: 'model_configurations',
          modelNameField: 'name'
        }
      })

      const responseBody = JSON.stringify({
        model_configurations: [
          { name: 'valid-model' },
          { description: 'no name field' }, // Should be skipped
          { name: null }, // Should be skipped
          { name: 'another-valid' }
        ]
      })

      const result = captureModelsFromResponse(
        'theoldllm',
        'https://theoldllm.vercel.app/sv5/llm/provider',
        responseBody
      )

      expect(result).toBe(true)
      const models = mockModels.get('theoldllm')
      expect(models).toHaveLength(2)
      expect(models![0].modelName).toBe('theoldllm/valid-model')
      expect(models![1].modelName).toBe('theoldllm/another-valid')
    })
  })

  describe('URL pattern matching', () => {
    it('should match wildcard pattern *', () => {
      mockSites.set('test', {
        id: 'test',
        captureRules: [{
          urlPattern: '*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'session',
          sessionIdSource: 'body'
        }]
      })

      const result = captureSessionIdFromBody(
        'test',
        'https://any-url.com/any/path',
        JSON.stringify({ session: 'abc' })
      )

      expect(result).toBe(true)
    })

    it('should match partial wildcard pattern', () => {
      mockSites.set('test', {
        id: 'test',
        captureRules: [{
          urlPattern: '*/api/*',
          captureAuth: false,
          captureSessionId: true,
          sessionIdField: 'session',
          sessionIdSource: 'body'
        }]
      })

      const result1 = captureSessionIdFromBody(
        'test',
        'https://example.com/api/endpoint',
        JSON.stringify({ session: 'abc' })
      )
      expect(result1).toBe(true)

      mockSessionIds.clear()

      const result2 = captureSessionIdFromBody(
        'test',
        'https://example.com/other/endpoint',
        JSON.stringify({ session: 'abc' })
      )
      expect(result2).toBe(false)
    })
  })
})
