import { describe, it, expect } from 'vitest'
import {
  ConfigSchema,
  SiteConfigSchema,
  CaptureRuleSchema,
  validateConfig,
  formatValidationErrors
} from './index'

describe('CaptureRuleSchema', () => {
  it('should validate a valid capture rule', () => {
    const rule = {
      urlPattern: '*example.com/api/*',
      captureAuth: true,
      captureSessionId: false
    }
    const result = CaptureRuleSchema.safeParse(rule)
    expect(result.success).toBe(true)
  })

  it('should reject empty urlPattern', () => {
    const rule = {
      urlPattern: '',
      captureAuth: true,
      captureSessionId: false
    }
    const result = CaptureRuleSchema.safeParse(rule)
    expect(result.success).toBe(false)
  })

  it('should apply default authHeader', () => {
    const rule = {
      urlPattern: '*example.com/*',
      captureAuth: true,
      captureSessionId: false
    }
    const result = CaptureRuleSchema.parse(rule)
    expect(result.authHeader).toBe('Authorization')
  })
})

describe('SiteConfigSchema', () => {
  it('should validate a valid site config', () => {
    const site = {
      id: 'my-site',
      name: 'My Site',
      targetUrl: 'https://example.com',
      enabled: true,
      captureRules: [{
        urlPattern: '*example.com/*',
        captureAuth: true,
        captureSessionId: false
      }],
      adapterType: 'generic'
    }
    const result = SiteConfigSchema.safeParse(site)
    expect(result.success).toBe(true)
  })

  it('should reject invalid site ID format', () => {
    const site = {
      id: 'My Site',  // Invalid: contains uppercase and space
      name: 'My Site',
      targetUrl: 'https://example.com',
      enabled: true,
      captureRules: [],
      adapterType: 'generic'
    }
    const result = SiteConfigSchema.safeParse(site)
    expect(result.success).toBe(false)
  })

  it('should reject invalid URL', () => {
    const site = {
      id: 'my-site',
      name: 'My Site',
      targetUrl: 'not-a-url',
      enabled: true,
      captureRules: [],
      adapterType: 'generic'
    }
    const result = SiteConfigSchema.safeParse(site)
    expect(result.success).toBe(false)
  })
})

describe('ConfigSchema', () => {
  it('should validate a valid config', () => {
    const config = {
      apiServerPort: 8080,
      apiServerHost: '127.0.0.1',
      requireApiKey: false,
      apiKeys: [],
      defaultTargetUrl: 'https://example.com',
      rules: [{
        urlPattern: '*example.com/*',
        captureAuth: true,
        captureSessionId: false,
        sessionIdField: 'session_id'
      }],
      modelAliases: {}
    }
    const result = ConfigSchema.safeParse(config)
    expect(result.success).toBe(true)
  })

  it('should apply default values', () => {
    const config = {
      defaultTargetUrl: 'https://example.com',
      rules: [{
        urlPattern: '*example.com/*',
        captureAuth: true,
        captureSessionId: false,
        sessionIdField: 'session_id'
      }]
    }
    const result = ConfigSchema.parse(config)
    expect(result.apiServerPort).toBe(8080)
    expect(result.apiServerHost).toBe('127.0.0.1')
    expect(result.requireApiKey).toBe(false)
    expect(result.apiKeys).toEqual([])
  })

  it('should reject invalid port', () => {
    const config = {
      apiServerPort: 70000,  // Invalid: port > 65535
      defaultTargetUrl: 'https://example.com',
      rules: []
    }
    const result = ConfigSchema.safeParse(config)
    expect(result.success).toBe(false)
  })
})

describe('validateConfig', () => {
  it('should return success for valid config', () => {
    const config = {
      defaultTargetUrl: 'https://example.com',
      rules: [{
        urlPattern: '*example.com/*',
        captureAuth: true,
        captureSessionId: false,
        sessionIdField: 'session_id'
      }]
    }
    const result = validateConfig(config)
    expect(result.success).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.data).not.toBeNull()
  })

  it('should return errors for invalid config', () => {
    const config = {
      apiServerPort: 'not-a-number',
      defaultTargetUrl: 'not-a-url'
    }
    const result = validateConfig(config)
    expect(result.success).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.data).toBeNull()
  })
})

describe('formatValidationErrors', () => {
  it('should format errors correctly', () => {
    const errors = [
      { path: 'apiServerPort', message: 'Expected number', code: 'invalid_type' },
      { path: 'defaultTargetUrl', message: 'Invalid url', code: 'invalid_string' }
    ]
    const formatted = formatValidationErrors(errors)
    expect(formatted).toContain('apiServerPort')
    expect(formatted).toContain('Expected number')
    expect(formatted).toContain('defaultTargetUrl')
    expect(formatted).toContain('Invalid url')
  })

  it('should return empty string for no errors', () => {
    const formatted = formatValidationErrors([])
    expect(formatted).toBe('')
  })
})
