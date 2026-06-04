/**
 * Structured Error System
 *
 * Provides a unified error handling framework with:
 * - Error codes for programmatic handling
 * - Context information for debugging
 * - User-friendly suggestions
 * - Serialization for IPC/API responses
 */

// ============================================================================
// Error Codes
// ============================================================================

export const ErrorCodes = {
  // Authentication errors (1xxx)
  AUTH_NO_CREDENTIALS: 'AUTH_1001',
  AUTH_TOKEN_EXPIRED: 'AUTH_1002',
  AUTH_REFRESH_FAILED: 'AUTH_1003',
  AUTH_INVALID_API_KEY: 'AUTH_1004',

  // Configuration errors (2xxx)
  CONFIG_PARSE_ERROR: 'CONFIG_2001',
  CONFIG_VALIDATION_ERROR: 'CONFIG_2002',
  CONFIG_FILE_NOT_FOUND: 'CONFIG_2003',
  CONFIG_WRITE_ERROR: 'CONFIG_2004',

  // Site/Model errors (3xxx)
  SITE_NOT_FOUND: 'SITE_3001',
  SITE_DISABLED: 'SITE_3002',
  MODEL_NOT_FOUND: 'MODEL_3003',
  ADAPTER_NOT_FOUND: 'ADAPTER_3004',

  // Network/Upstream errors (4xxx)
  UPSTREAM_CONNECTION_FAILED: 'UPSTREAM_4001',
  UPSTREAM_TIMEOUT: 'UPSTREAM_4002',
  UPSTREAM_ERROR: 'UPSTREAM_4003',
  WEBSOCKET_ERROR: 'WEBSOCKET_4004',

  // Storage errors (5xxx)
  STORAGE_READ_ERROR: 'STORAGE_5001',
  STORAGE_WRITE_ERROR: 'STORAGE_5002',
  STORAGE_MIGRATION_ERROR: 'STORAGE_5003',

  // Internal errors (9xxx)
  INTERNAL_ERROR: 'INTERNAL_9001',
  UNKNOWN_ERROR: 'INTERNAL_9999'
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

// ============================================================================
// Structured Error Class
// ============================================================================

export interface ErrorContext {
  [key: string]: string | number | boolean | null | undefined
}

export interface SerializedError {
  code: ErrorCode
  message: string
  context: ErrorContext
  suggestion?: string
  timestamp: string
  stack?: string
}

/**
 * AppError - Base class for all application errors
 *
 * Features:
 * - Error code for programmatic handling
 * - Context object for debugging details
 * - Optional suggestion for user guidance
 * - Serialization for API/IPC responses
 */
export class AppError extends Error {
  public readonly code: ErrorCode
  public readonly context: ErrorContext
  public readonly suggestion?: string
  public readonly timestamp: Date

  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext = {},
    suggestion?: string
  ) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.context = context
    this.suggestion = suggestion
    this.timestamp = new Date()

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError)
    }
  }

  /**
   * Serialize error for API/IPC responses
   */
  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      context: this.context,
      suggestion: this.suggestion,
      timestamp: this.timestamp.toISOString(),
      stack: process.env.NODE_ENV === 'development' ? this.stack : undefined
    }
  }

  /**
   * Format error for logging
   */
  toLogString(): string {
    const contextStr = Object.entries(this.context)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    return `[${this.code}] ${this.message}${contextStr ? ` (${contextStr})` : ''}`
  }
}

// ============================================================================
// Specialized Error Classes
// ============================================================================

export class AuthenticationError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext = {},
    suggestion?: string
  ) {
    super(code, message, context, suggestion || 'Please re-authenticate by opening the target site.')
    this.name = 'AuthenticationError'
  }
}

export class ConfigurationError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext = {},
    suggestion?: string
  ) {
    super(code, message, context, suggestion || 'Check your configuration file for errors.')
    this.name = 'ConfigurationError'
  }
}

export class UpstreamError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext = {},
    suggestion?: string
  ) {
    super(code, message, context, suggestion || 'The upstream service may be temporarily unavailable. Please try again.')
    this.name = 'UpstreamError'
  }
}

export class StorageError extends AppError {
  constructor(
    code: ErrorCode,
    message: string,
    context: ErrorContext = {},
    suggestion?: string
  ) {
    super(code, message, context, suggestion || 'Check disk space and file permissions.')
    this.name = 'StorageError'
  }
}

// ============================================================================
// Error Factory Functions
// ============================================================================

export function createNoCredentialsError(siteId: string): AuthenticationError {
  return new AuthenticationError(
    ErrorCodes.AUTH_NO_CREDENTIALS,
    `No valid credentials for site "${siteId}"`,
    { siteId },
    'Please use the browser to interact with the target service first to capture credentials.'
  )
}

export function createTokenExpiredError(siteId: string): AuthenticationError {
  return new AuthenticationError(
    ErrorCodes.AUTH_TOKEN_EXPIRED,
    `Token expired for site "${siteId}"`,
    { siteId },
    'Please re-authenticate by opening the target site or wait for automatic refresh.'
  )
}

export function createModelNotFoundError(model: string, available: string[]): AppError {
  return new AppError(
    ErrorCodes.MODEL_NOT_FOUND,
    `Model "${model}" not found`,
    { model, availableCount: available.length },
    `Available models: ${available.slice(0, 5).join(', ')}${available.length > 5 ? '...' : ''}`
  )
}

export function createUpstreamConnectionError(url: string, error: string): UpstreamError {
  return new UpstreamError(
    ErrorCodes.UPSTREAM_CONNECTION_FAILED,
    `Failed to connect to upstream service`,
    { url, error },
    'Check your network connection and try again.'
  )
}

export function createConfigValidationError(errors: string[]): ConfigurationError {
  return new ConfigurationError(
    ErrorCodes.CONFIG_VALIDATION_ERROR,
    'Configuration validation failed',
    { errorCount: errors.length },
    `Fix the following errors:\n${errors.join('\n')}`
  )
}

// ============================================================================
// Error Parsing (for frontend)
// ============================================================================

/**
 * Parse a serialized error from API/IPC response
 */
export function parseError(data: unknown): AppError | null {
  if (!data || typeof data !== 'object') return null

  const obj = data as Record<string, unknown>
  if (!obj.code || !obj.message) return null

  return new AppError(
    obj.code as ErrorCode,
    obj.message as string,
    (obj.context as ErrorContext) || {},
    obj.suggestion as string | undefined
  )
}

/**
 * Check if an error is a specific type
 */
export function isErrorCode(error: unknown, code: ErrorCode): boolean {
  if (error instanceof AppError) {
    return error.code === code
  }
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code: string }).code === code
  }
  return false
}

/**
 * Get user-friendly message from error
 */
export function getUserMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.suggestion || error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return 'An unexpected error occurred'
}
