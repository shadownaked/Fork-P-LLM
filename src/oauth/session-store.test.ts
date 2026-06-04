/**
 * OAuth Session Store Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OAuthSessionStore } from './session-store'

describe('OAuthSessionStore', () => {
  let store: OAuthSessionStore

  beforeEach(() => {
    store = new OAuthSessionStore()
    store.stopCleanup() // Disable auto-cleanup for tests
  })

  afterEach(() => {
    store.stopCleanup()
    store.clear()
  })

  describe('register', () => {
    it('should register a new session', () => {
      const session = store.register('test-state', 'gemini')

      expect(session.state).toBe('test-state')
      expect(session.provider).toBe('gemini')
      expect(session.status).toBe('pending')
      expect(session.createdAt).toBeLessThanOrEqual(Date.now())
      expect(session.expiresAt).toBeGreaterThan(Date.now())
    })

    it('should register session with PKCE code_verifier', () => {
      const session = store.register('test-state', 'codex', {
        codeVerifier: 'test-verifier'
      })

      expect(session.codeVerifier).toBe('test-verifier')
    })

    it('should register device flow session with polling status', () => {
      const session = store.register('test-state', 'qwen', {
        deviceCode: 'test-device-code',
        userCode: 'ABCD-1234',
        pollInterval: 5000
      })

      expect(session.status).toBe('polling')
      expect(session.deviceCode).toBe('test-device-code')
      expect(session.userCode).toBe('ABCD-1234')
      expect(session.pollInterval).toBe(5000)
    })

    it('should use longer TTL for device flow', () => {
      const normalSession = store.register('normal-state', 'gemini')
      const deviceSession = store.register('device-state', 'qwen', {
        deviceCode: 'test-device-code'
      })

      // Device flow should have longer TTL
      expect(deviceSession.expiresAt - deviceSession.createdAt).toBeGreaterThan(
        normalSession.expiresAt - normalSession.createdAt
      )
    })
  })

  describe('get', () => {
    it('should retrieve existing session', () => {
      store.register('test-state', 'gemini')
      const session = store.get('test-state')

      expect(session).toBeDefined()
      expect(session?.state).toBe('test-state')
    })

    it('should return undefined for non-existent session', () => {
      const session = store.get('non-existent')

      expect(session).toBeUndefined()
    })

    it('should return undefined for expired session', () => {
      // Register with very short TTL
      store.register('test-state', 'gemini', { ttl: 1 })

      // Wait for expiration
      return new Promise<void>(resolve => {
        setTimeout(() => {
          const session = store.get('test-state')
          expect(session).toBeUndefined()
          resolve()
        }, 10)
      })
    })
  })

  describe('getAll', () => {
    it('should return all active sessions', () => {
      store.register('state-1', 'gemini')
      store.register('state-2', 'codex')
      store.register('state-3', 'qwen')

      const sessions = store.getAll()

      expect(sessions.length).toBe(3)
    })

    it('should not return expired sessions', () => {
      store.register('state-1', 'gemini')
      store.register('state-2', 'codex', { ttl: 1 })

      return new Promise<void>(resolve => {
        setTimeout(() => {
          const sessions = store.getAll()
          expect(sessions.length).toBe(1)
          expect(sessions[0].state).toBe('state-1')
          resolve()
        }, 10)
      })
    })
  })

  describe('getByProvider', () => {
    it('should return sessions for specific provider', () => {
      store.register('state-1', 'gemini')
      store.register('state-2', 'gemini')
      store.register('state-3', 'codex')

      const geminiSessions = store.getByProvider('gemini')
      const codexSessions = store.getByProvider('codex')

      expect(geminiSessions.length).toBe(2)
      expect(codexSessions.length).toBe(1)
    })
  })

  describe('status updates', () => {
    it('should update status to polling', () => {
      store.register('test-state', 'qwen')
      store.setPolling('test-state')

      const session = store.get('test-state')
      expect(session?.status).toBe('polling')
    })

    it('should mark session as completed', () => {
      store.register('test-state', 'gemini')
      store.complete('test-state')

      const session = store.get('test-state')
      expect(session?.status).toBe('completed')
    })

    it('should mark session as error', () => {
      store.register('test-state', 'gemini')
      store.setError('test-state', 'User denied access')

      const session = store.get('test-state')
      expect(session?.status).toBe('error')
      expect(session?.error).toBe('User denied access')
    })

    it('should extend TTL on completion', () => {
      store.register('test-state', 'gemini', { ttl: 100 })
      const originalExpiry = store.get('test-state')!.expiresAt

      // Wait a bit then complete
      return new Promise<void>(resolve => {
        setTimeout(() => {
          store.complete('test-state')
          const newExpiry = store.get('test-state')!.expiresAt
          expect(newExpiry).toBeGreaterThan(originalExpiry)
          resolve()
        }, 50)
      })
    })
  })

  describe('delete', () => {
    it('should delete existing session', () => {
      store.register('test-state', 'gemini')
      const deleted = store.delete('test-state')

      expect(deleted).toBe(true)
      expect(store.get('test-state')).toBeUndefined()
    })

    it('should return false for non-existent session', () => {
      const deleted = store.delete('non-existent')

      expect(deleted).toBe(false)
    })
  })

  describe('clear', () => {
    it('should clear all sessions', () => {
      store.register('state-1', 'gemini')
      store.register('state-2', 'codex')
      store.register('state-3', 'qwen')

      store.clear()

      expect(store.size).toBe(0)
      expect(store.getAll().length).toBe(0)
    })
  })

  describe('has', () => {
    it('should return true for existing session', () => {
      store.register('test-state', 'gemini')

      expect(store.has('test-state')).toBe(true)
    })

    it('should return false for non-existent session', () => {
      expect(store.has('non-existent')).toBe(false)
    })
  })

  describe('size', () => {
    it('should return correct session count', () => {
      expect(store.size).toBe(0)

      store.register('state-1', 'gemini')
      expect(store.size).toBe(1)

      store.register('state-2', 'codex')
      expect(store.size).toBe(2)

      store.delete('state-1')
      expect(store.size).toBe(1)
    })
  })
})
