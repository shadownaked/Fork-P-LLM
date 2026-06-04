/**
 * OAuth Utils Tests
 */

import { describe, it, expect } from 'vitest'
import {
  generateRandomString,
  generateState,
  generatePKCE,
  buildAuthUrl,
  parseTokenResponse,
  isOAuthTokenExpired,
  extractEmailFromIdToken
} from './utils'
import type { OAuthProviderConfig, OAuthToken } from '../types'

describe('generateRandomString', () => {
  it('should generate string of correct length', () => {
    const str = generateRandomString(32)
    // Base64url encoding of 32 bytes = 43 characters
    expect(str.length).toBe(43)
  })

  it('should generate unique strings', () => {
    const str1 = generateRandomString(32)
    const str2 = generateRandomString(32)
    expect(str1).not.toBe(str2)
  })

  it('should only contain base64url characters', () => {
    const str = generateRandomString(32)
    // Base64url uses A-Z, a-z, 0-9, -, _
    expect(str).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('generateState', () => {
  it('should generate non-empty state', () => {
    const state = generateState()
    expect(state.length).toBeGreaterThan(0)
  })

  it('should generate unique states', () => {
    const states = new Set<string>()
    for (let i = 0; i < 100; i++) {
      states.add(generateState())
    }
    expect(states.size).toBe(100)
  })
})

describe('generatePKCE', () => {
  it('should generate code_verifier and code_challenge', () => {
    const { codeVerifier, codeChallenge } = generatePKCE()

    expect(codeVerifier).toBeDefined()
    expect(codeChallenge).toBeDefined()
    expect(codeVerifier.length).toBe(43)
    expect(codeChallenge.length).toBe(43)
  })

  it('should generate unique PKCE pairs', () => {
    const pkce1 = generatePKCE()
    const pkce2 = generatePKCE()

    expect(pkce1.codeVerifier).not.toBe(pkce2.codeVerifier)
    expect(pkce1.codeChallenge).not.toBe(pkce2.codeChallenge)
  })

  it('should generate valid base64url strings', () => {
    const { codeVerifier, codeChallenge } = generatePKCE()

    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('should generate deterministic challenge from verifier', () => {
    // Same verifier should produce same challenge
    // We can't test this directly since verifier is random,
    // but we can verify the challenge is derived correctly
    const { codeVerifier, codeChallenge } = generatePKCE()

    // Manually compute challenge
    const crypto = require('node:crypto')
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest()
      .toString('base64url')

    expect(codeChallenge).toBe(expectedChallenge)
  })
})

describe('buildAuthUrl', () => {
  const mockConfig: OAuthProviderConfig = {
    clientId: 'test-client-id',
    authUrl: 'https://auth.example.com/authorize',
    tokenUrl: 'https://auth.example.com/token',
    scopes: ['openid', 'email', 'profile'],
    redirectUri: 'http://localhost:8080/oauth/callback/test',
    flowType: 'authorization_code'
  }

  it('should build URL with required parameters', () => {
    const url = buildAuthUrl(mockConfig, 'test-state')
    const parsed = new URL(url)

    expect(parsed.origin).toBe('https://auth.example.com')
    expect(parsed.pathname).toBe('/authorize')
    expect(parsed.searchParams.get('client_id')).toBe('test-client-id')
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8080/oauth/callback/test'
    )
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('state')).toBe('test-state')
    expect(parsed.searchParams.get('scope')).toBe('openid email profile')
  })

  it('should include extra parameters', () => {
    const url = buildAuthUrl(mockConfig, 'test-state', {
      code_challenge: 'test-challenge',
      code_challenge_method: 'S256',
      prompt: 'consent'
    })
    const parsed = new URL(url)

    expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
  })

  it('should handle empty scopes', () => {
    const configNoScopes = { ...mockConfig, scopes: [] }
    const url = buildAuthUrl(configNoScopes, 'test-state')
    const parsed = new URL(url)

    expect(parsed.searchParams.has('scope')).toBe(false)
  })
})

describe('parseTokenResponse', () => {
  it('should parse standard token response', () => {
    const response = JSON.stringify({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      id_token: 'test-id-token',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid email'
    })

    const token = parseTokenResponse(response)

    expect(token.accessToken).toBe('test-access-token')
    expect(token.refreshToken).toBe('test-refresh-token')
    expect(token.idToken).toBe('test-id-token')
    expect(token.tokenType).toBe('Bearer')
    expect(token.scope).toBe('openid email')
    expect(token.expiresAt).toBeGreaterThan(Date.now())
    expect(token.expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000)
  })

  it('should handle missing optional fields', () => {
    const response = JSON.stringify({
      access_token: 'test-access-token'
    })

    const token = parseTokenResponse(response)

    expect(token.accessToken).toBe('test-access-token')
    expect(token.refreshToken).toBeNull()
    expect(token.idToken).toBeNull()
    expect(token.tokenType).toBe('Bearer')
    expect(token.scope).toBeNull()
    expect(token.expiresAt).toBeNull()
  })
})

describe('isOAuthTokenExpired', () => {
  it('should return false for non-expired token', () => {
    const token: OAuthToken = {
      accessToken: 'test',
      refreshToken: null,
      idToken: null,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600 * 1000, // 1 hour from now
      scope: null
    }

    expect(isOAuthTokenExpired(token)).toBe(false)
  })

  it('should return true for expired token', () => {
    const token: OAuthToken = {
      accessToken: 'test',
      refreshToken: null,
      idToken: null,
      tokenType: 'Bearer',
      expiresAt: Date.now() - 1000, // 1 second ago
      scope: null
    }

    expect(isOAuthTokenExpired(token)).toBe(true)
  })

  it('should return true for token expiring within buffer', () => {
    const token: OAuthToken = {
      accessToken: 'test',
      refreshToken: null,
      idToken: null,
      tokenType: 'Bearer',
      expiresAt: Date.now() + 30000, // 30 seconds from now
      scope: null
    }

    // Default buffer is 60 seconds
    expect(isOAuthTokenExpired(token)).toBe(true)
    expect(isOAuthTokenExpired(token, 0)).toBe(false)
  })

  it('should return false for token without expiration', () => {
    const token: OAuthToken = {
      accessToken: 'test',
      refreshToken: null,
      idToken: null,
      tokenType: 'Bearer',
      expiresAt: null,
      scope: null
    }

    expect(isOAuthTokenExpired(token)).toBe(false)
  })
})

describe('extractEmailFromIdToken', () => {
  it('should extract email from valid JWT', () => {
    // Create a mock JWT with email in payload
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: '1234567890',
        email: 'test@example.com',
        iat: 1516239022
      })
    ).toString('base64url')
    const signature = 'mock-signature'

    const idToken = `${header}.${payload}.${signature}`
    const email = extractEmailFromIdToken(idToken)

    expect(email).toBe('test@example.com')
  })

  it('should return null for JWT without email', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({
        sub: '1234567890',
        iat: 1516239022
      })
    ).toString('base64url')
    const signature = 'mock-signature'

    const idToken = `${header}.${payload}.${signature}`
    const email = extractEmailFromIdToken(idToken)

    expect(email).toBeNull()
  })

  it('should return null for null input', () => {
    expect(extractEmailFromIdToken(null)).toBeNull()
  })

  it('should return null for invalid JWT format', () => {
    expect(extractEmailFromIdToken('not-a-jwt')).toBeNull()
    expect(extractEmailFromIdToken('only.two.parts.here.extra')).toBeNull()
  })

  it('should return null for invalid base64 payload', () => {
    expect(extractEmailFromIdToken('header.!!!invalid!!!.signature')).toBeNull()
  })
})
