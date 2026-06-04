import { describe, it, expect } from 'vitest'
import {
  AppError,
  ErrorCodes,
  AuthenticationError,
  ConfigurationError,
  UpstreamError,
  StorageError,
  createNoCredentialsError,
  createTokenExpiredError,
  createModelNotFoundError,
  createUpstreamConnectionError,
  parseError,
  isErrorCode,
  getUserMessage
} from './index'

describe('AppError', () => {
  it('should create error with all properties', () => {
    const error = new AppError(
      ErrorCodes.AUTH_NO_CREDENTIALS,
      'No credentials found',
      { siteId: 'test-site' },
      'Please authenticate first'
    )

    expect(error.code).toBe(ErrorCodes.AUTH_NO_CREDENTIALS)
    expect(error.message).toBe('No credentials found')
    expect(error.context).toEqual({ siteId: 'test-site' })
    expect(error.suggestion).toBe('Please authenticate first')
    expect(error.timestamp).toBeInstanceOf(Date)
  })

  it('should serialize to JSON correctly', () => {
    const error = new AppError(
      ErrorCodes.MODEL_NOT_FOUND,
      'Model not found',
      { model: 'gpt-5' }
    )

    const json = error.toJSON()
    expect(json.code).toBe(ErrorCodes.MODEL_NOT_FOUND)
    expect(json.message).toBe('Model not found')
    expect(json.context).toEqual({ model: 'gpt-5' })
    expect(json.timestamp).toBeDefined()
  })

  it('should format for logging', () => {
    const error = new AppError(
      ErrorCodes.UPSTREAM_TIMEOUT,
      'Request timed out',
      { url: 'https://api.example.com', timeout: 30000 }
    )

    const logStr = error.toLogString()
    expect(logStr).toContain('[UPSTREAM_4002]')
    expect(logStr).toContain('Request timed out')
    expect(logStr).toContain('url=https://api.example.com')
    expect(logStr).toContain('timeout=30000')
  })
})

describe('Specialized Error Classes', () => {
  it('should create AuthenticationError with default suggestion', () => {
    const error = new AuthenticationError(
      ErrorCodes.AUTH_TOKEN_EXPIRED,
      'Token expired'
    )
    expect(error.name).toBe('AuthenticationError')
    expect(error.suggestion).toContain('re-authenticate')
  })

  it('should create ConfigurationError with default suggestion', () => {
    const error = new ConfigurationError(
      ErrorCodes.CONFIG_PARSE_ERROR,
      'Invalid JSON'
    )
    expect(error.name).toBe('ConfigurationError')
    expect(error.suggestion).toContain('configuration file')
  })

  it('should create UpstreamError with default suggestion', () => {
    const error = new UpstreamError(
      ErrorCodes.UPSTREAM_CONNECTION_FAILED,
      'Connection refused'
    )
    expect(error.name).toBe('UpstreamError')
    expect(error.suggestion).toContain('temporarily unavailable')
  })

  it('should create StorageError with default suggestion', () => {
    const error = new StorageError(
      ErrorCodes.STORAGE_WRITE_ERROR,
      'Write failed'
    )
    expect(error.name).toBe('StorageError')
    expect(error.suggestion).toContain('disk space')
  })
})

describe('Error Factory Functions', () => {
  it('should create no credentials error', () => {
    const error = createNoCredentialsError('my-site')
    expect(error.code).toBe(ErrorCodes.AUTH_NO_CREDENTIALS)
    expect(error.context.siteId).toBe('my-site')
    expect(error.message).toContain('my-site')
  })

  it('should create token expired error', () => {
    const error = createTokenExpiredError('my-site')
    expect(error.code).toBe(ErrorCodes.AUTH_TOKEN_EXPIRED)
    expect(error.context.siteId).toBe('my-site')
  })

  it('should create model not found error', () => {
    const error = createModelNotFoundError('gpt-5', ['gpt-4', 'gpt-3.5', 'claude'])
    expect(error.code).toBe(ErrorCodes.MODEL_NOT_FOUND)
    expect(error.context.model).toBe('gpt-5')
    expect(error.suggestion).toContain('gpt-4')
  })

  it('should create upstream connection error', () => {
    const error = createUpstreamConnectionError('https://api.example.com', 'ECONNREFUSED')
    expect(error.code).toBe(ErrorCodes.UPSTREAM_CONNECTION_FAILED)
    expect(error.context.url).toBe('https://api.example.com')
    expect(error.context.error).toBe('ECONNREFUSED')
  })
})

describe('Error Parsing', () => {
  it('should parse serialized error', () => {
    const original = new AppError(
      ErrorCodes.SITE_NOT_FOUND,
      'Site not found',
      { siteId: 'test' }
    )
    const json = original.toJSON()
    const parsed = parseError(json)

    expect(parsed).not.toBeNull()
    expect(parsed!.code).toBe(ErrorCodes.SITE_NOT_FOUND)
    expect(parsed!.message).toBe('Site not found')
  })

  it('should return null for invalid data', () => {
    expect(parseError(null)).toBeNull()
    expect(parseError({})).toBeNull()
    expect(parseError({ code: 'TEST' })).toBeNull()
    expect(parseError('string')).toBeNull()
  })
})

describe('Error Utilities', () => {
  it('should check error code correctly', () => {
    const error = new AppError(ErrorCodes.AUTH_NO_CREDENTIALS, 'No credentials')

    expect(isErrorCode(error, ErrorCodes.AUTH_NO_CREDENTIALS)).toBe(true)
    expect(isErrorCode(error, ErrorCodes.AUTH_TOKEN_EXPIRED)).toBe(false)
  })

  it('should check error code from plain object', () => {
    const obj = { code: ErrorCodes.MODEL_NOT_FOUND, message: 'Not found' }

    expect(isErrorCode(obj, ErrorCodes.MODEL_NOT_FOUND)).toBe(true)
    expect(isErrorCode(obj, ErrorCodes.SITE_NOT_FOUND)).toBe(false)
  })

  it('should get user message from AppError', () => {
    const error = new AppError(
      ErrorCodes.AUTH_NO_CREDENTIALS,
      'Technical message',
      {},
      'Please login first'
    )
    expect(getUserMessage(error)).toBe('Please login first')
  })

  it('should get user message from Error without suggestion', () => {
    const error = new Error('Something went wrong')
    expect(getUserMessage(error)).toBe('Something went wrong')
  })

  it('should get default message for unknown error', () => {
    expect(getUserMessage(null)).toBe('An unexpected error occurred')
    expect(getUserMessage(undefined)).toBe('An unexpected error occurred')
  })
})
