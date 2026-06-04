import { describe, it, expect } from 'vitest'
import { resolveRefreshPolicy, shouldRefreshCredentials } from './refresh-policy'
import type { Credentials, SiteConfig } from './types'

function createMockJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = 'mock-signature'
  return `${header}.${payloadStr}.${signature}`
}

function baseCreds(overrides: Partial<Credentials> = {}): Credentials {
  return {
    authorization: null,
    sessionId: null,
    capturedAt: null,
    expiresAt: null,
    requestHeaders: null,
    ...overrides
  }
}

function baseSite(refresh?: SiteConfig['refresh']): SiteConfig {
  return {
    id: 'theoldllm',
    name: 'Theoldllm',
    targetUrl: 'https://theoldllm.vercel.app',
    enabled: true,
    captureRules: [],
    adapterType: 'theoldllm',
    refresh
  }
}

describe('refresh policy', () => {
  it('refreshes when JWT is within threshold', () => {
    const exp = Math.floor(Date.now() / 1000) + 60
    const token = createMockJWT({ exp })
    const creds = baseCreds({ authorization: `Bearer ${token}` })
    const policy = resolveRefreshPolicy(baseSite({ enabled: true, intervalMs: 3600000, thresholdMs: 5 * 60 * 1000, strategy: 'reopen' }))

    const decision = shouldRefreshCredentials(creds, policy)
    expect(decision.shouldRefresh).toBe(true)
    expect(decision.reason).toBe('jwt-expiring')
  })

  it('refreshes when expiresAt is within threshold', () => {
    const creds = baseCreds({
      authorization: 'opaque',
      expiresAt: Date.now() + 1000
    })
    const policy = resolveRefreshPolicy(baseSite({ enabled: true, intervalMs: 3600000, thresholdMs: 5000, strategy: 'reopen' }))

    const decision = shouldRefreshCredentials(creds, policy)
    expect(decision.shouldRefresh).toBe(true)
    expect(decision.reason).toBe('expiresAt-expiring')
  })

  it('refreshes when capturedAt exceeds interval', () => {
    const creds = baseCreds({
      authorization: 'opaque',
      capturedAt: Date.now() - 2 * 60 * 60 * 1000
    })
    const policy = resolveRefreshPolicy(baseSite({ enabled: true, intervalMs: 60 * 60 * 1000, thresholdMs: 5000, strategy: 'reopen' }))

    const decision = shouldRefreshCredentials(creds, policy)
    expect(decision.shouldRefresh).toBe(true)
    expect(decision.reason).toBe('age-exceeded')
  })

  it('does not refresh when disabled', () => {
    const creds = baseCreds({
      authorization: 'opaque',
      capturedAt: Date.now() - 10 * 60 * 60 * 1000
    })
    const policy = resolveRefreshPolicy(baseSite({ enabled: false, intervalMs: 1000, thresholdMs: 1000, strategy: 'reopen' }))

    const decision = shouldRefreshCredentials(creds, policy)
    expect(decision.shouldRefresh).toBe(false)
  })
})
