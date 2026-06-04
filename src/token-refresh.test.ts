/**
 * Token Refresh Tests
 *
 * Tests for JWT token expiration detection and parsing
 * Note: We test the pure functions directly without importing from token-refresh.ts
 * to avoid Electron dependencies in the test environment.
 */

import { describe, it, expect } from 'vitest'

/**
 * Helper to create a mock JWT token
 */
function createMockJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = 'mock-signature'
  return `${header}.${payloadStr}.${signature}`
}

/**
 * Pure implementation of isTokenExpired for testing
 * (Copied from token-refresh.ts to avoid Electron dependencies)
 */
function isTokenExpired(token: string | null, bufferSeconds = 60): boolean {
  if (!token) return true

  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return false

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    const exp = payload.exp

    if (!exp) return false

    const now = Math.floor(Date.now() / 1000)
    return exp <= now + bufferSeconds
  } catch {
    return false
  }
}

/**
 * Pure implementation of getTokenExpiry for testing
 */
function getTokenExpiry(token: string | null): number | null {
  if (!token) return null

  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    return payload.exp ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * Pure implementation of parseJwtExpiration for testing
 * (From main.ts)
 */
function parseJwtExpiration(token: string): number | null {
  if (!token) return null

  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token

  try {
    const parts = jwt.split('.')
    if (parts.length < 2) return null

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
    const exp = payload.exp

    if (!exp) return null

    return exp * 1000
  } catch {
    return null
  }
}

describe('isTokenExpired', () => {
  it('should return true for null token', () => {
    expect(isTokenExpired(null)).toBe(true)
  })

  it('should return true for empty token', () => {
    expect(isTokenExpired('')).toBe(true)
  })

  it('should return false for non-JWT token (no expiry check possible)', () => {
    expect(isTokenExpired('not-a-jwt')).toBe(false)
  })

  it('should return false for JWT without exp claim', () => {
    const token = createMockJWT({ sub: '1234567890', iat: Math.floor(Date.now() / 1000) })
    expect(isTokenExpired(token)).toBe(false)
  })

  it('should return true for expired JWT', () => {
    const expiredTime = Math.floor(Date.now() / 1000) - 3600 // 1 hour ago
    const token = createMockJWT({ sub: '1234567890', exp: expiredTime })
    expect(isTokenExpired(token)).toBe(true)
  })

  it('should return false for non-expired JWT', () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600 // 1 hour from now
    const token = createMockJWT({ sub: '1234567890', exp: futureTime })
    expect(isTokenExpired(token)).toBe(false)
  })

  it('should consider buffer time (default 60 seconds)', () => {
    // Token expires in 30 seconds
    const soonExpiry = Math.floor(Date.now() / 1000) + 30
    const token = createMockJWT({ sub: '1234567890', exp: soonExpiry })

    // With default 60 second buffer, should be considered expired
    expect(isTokenExpired(token)).toBe(true)

    // With 0 second buffer, should not be expired
    expect(isTokenExpired(token, 0)).toBe(false)
  })

  it('should handle Bearer prefix', () => {
    const futureTime = Math.floor(Date.now() / 1000) + 3600
    const token = createMockJWT({ sub: '1234567890', exp: futureTime })
    expect(isTokenExpired(`Bearer ${token}`)).toBe(false)
  })

  it('should handle short-lived tokens like Clerk (60 second validity)', () => {
    // Simulate Clerk token: 60 second validity
    const now = Math.floor(Date.now() / 1000)
    const clerkToken = createMockJWT({
      sub: 'user_123',
      iat: now,
      exp: now + 60, // 60 seconds from now
      iss: 'https://clerk.example.com'
    })

    // With default 60 second buffer, should be considered expired
    expect(isTokenExpired(clerkToken, 60)).toBe(true)

    // With 30 second buffer, should not be expired
    expect(isTokenExpired(clerkToken, 30)).toBe(false)
  })
})

describe('getTokenExpiry', () => {
  it('should return null for null token', () => {
    expect(getTokenExpiry(null)).toBeNull()
  })

  it('should return null for non-JWT token', () => {
    expect(getTokenExpiry('not-a-jwt')).toBeNull()
  })

  it('should return null for JWT without exp claim', () => {
    const token = createMockJWT({ sub: '1234567890' })
    expect(getTokenExpiry(token)).toBeNull()
  })

  it('should return expiry time in milliseconds', () => {
    const expTime = Math.floor(Date.now() / 1000) + 3600
    const token = createMockJWT({ sub: '1234567890', exp: expTime })
    expect(getTokenExpiry(token)).toBe(expTime * 1000)
  })

  it('should handle Bearer prefix', () => {
    const expTime = Math.floor(Date.now() / 1000) + 3600
    const token = createMockJWT({ sub: '1234567890', exp: expTime })
    expect(getTokenExpiry(`Bearer ${token}`)).toBe(expTime * 1000)
  })
})

describe('JWT parsing edge cases', () => {
  it('should handle malformed base64 in payload', () => {
    expect(isTokenExpired('header.!!!invalid!!!.signature')).toBe(false)
  })

  it('should handle JWT with only 2 parts', () => {
    expect(isTokenExpired('header.payload')).toBe(false)
  })

  it('should handle JWT with invalid JSON in payload', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')
    const invalidPayload = Buffer.from('not-json').toString('base64url')
    const token = `${header}.${invalidPayload}.signature`
    expect(isTokenExpired(token)).toBe(false)
  })
})

describe('parseJwtExpiration', () => {
  it('should return null for empty token', () => {
    expect(parseJwtExpiration('')).toBeNull()
  })

  it('should return null for non-JWT token', () => {
    expect(parseJwtExpiration('not-a-jwt')).toBeNull()
  })

  it('should return null for JWT without exp claim', () => {
    const token = createMockJWT({ sub: '1234567890' })
    expect(parseJwtExpiration(token)).toBeNull()
  })

  it('should return expiry time in milliseconds', () => {
    const expTime = Math.floor(Date.now() / 1000) + 3600
    const token = createMockJWT({ sub: '1234567890', exp: expTime })
    expect(parseJwtExpiration(token)).toBe(expTime * 1000)
  })

  it('should handle Bearer prefix', () => {
    const expTime = Math.floor(Date.now() / 1000) + 3600
    const token = createMockJWT({ sub: '1234567890', exp: expTime })
    expect(parseJwtExpiration(`Bearer ${token}`)).toBe(expTime * 1000)
  })

  it('should correctly parse Clerk short-lived token', () => {
    // Clerk tokens have 60 second validity
    const now = Math.floor(Date.now() / 1000)
    const iat = now
    const exp = now + 60

    const clerkToken = createMockJWT({
      azp: 'https://orchids.app',
      exp,
      iat,
      iss: 'https://clerk.orchids.app',
      nbf: iat - 5,
      sid: 'sess_abc123',
      sub: 'user_xyz789'
    })

    const expiresAt = parseJwtExpiration(clerkToken)
    expect(expiresAt).toBe(exp * 1000)

    // Verify it's about 60 seconds from now
    const diffSeconds = (expiresAt! - Date.now()) / 1000
    expect(diffSeconds).toBeGreaterThan(55)
    expect(diffSeconds).toBeLessThanOrEqual(60)
  })
})
