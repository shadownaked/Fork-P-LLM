/**
 * Zod schemas for configuration validation
 *
 * Provides type-safe validation for:
 * - Config files (rules.json)
 * - Site configurations
 * - Capture rules
 * - API request/response types
 */

import { z } from 'zod'

// ============================================================================
// Capture Rule Schema
// ============================================================================

export const CaptureRuleSchema = z.object({
  urlPattern: z.string().min(1, 'URL pattern is required'),
  captureAuth: z.boolean(),
  captureSessionId: z.boolean(),
  sessionIdField: z.string().optional(),
  sessionIdSource: z.enum(['url', 'body', 'response']).optional(),
  authHeader: z.string().default('Authorization')
})

export type CaptureRule = z.infer<typeof CaptureRuleSchema>

// ============================================================================
// Model Capture Config Schema
// ============================================================================

export const ModelCaptureConfigSchema = z.object({
  urlPattern: z.string().min(1, 'URL pattern is required'),
  responseField: z.string().min(1, 'Response field is required'),
  modelNameField: z.string().min(1, 'Model name field is required'),
  modelIdField: z.string().optional(),
  displayNameField: z.string().optional()
})

export type ModelCaptureConfig = z.infer<typeof ModelCaptureConfigSchema>

// ============================================================================
// Refresh Config Schema
// ============================================================================

export const RefreshConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMs: z.number().min(1000).max(86400000), // 1s to 24h
  thresholdMs: z.number().min(1000).max(86400000).optional(), // 1s to 24h
  strategy: z.enum(['reopen', 'api']),
  endpoint: z.string().url().optional()
})

export type RefreshConfig = z.infer<typeof RefreshConfigSchema>

// ============================================================================
// Site Config Schema
// ============================================================================

export const SiteConfigSchema = z.object({
  id: z.string().min(1, 'Site ID is required').regex(/^[a-z0-9-]+$/, 'Site ID must be lowercase alphanumeric with dashes'),
  name: z.string().min(1, 'Site name is required'),
  targetUrl: z.string().url('Target URL must be a valid URL'),
  enabled: z.boolean(),
  captureRules: z.array(CaptureRuleSchema),
  adapterType: z.string().min(1, 'Adapter type is required'),
  adapterConfig: z.record(z.string(), z.unknown()).optional(),
  refresh: RefreshConfigSchema.optional(),
  modelCaptureConfig: ModelCaptureConfigSchema.optional()
})

export type SiteConfig = z.infer<typeof SiteConfigSchema>

// ============================================================================
// Main Config Schema
// ============================================================================

export const ConfigSchema = z.object({
  apiServerPort: z.number().int().min(1).max(65535).default(8080),
  apiServerHost: z.string().default('127.0.0.1'),
  apiKeys: z.array(z.string()).default([]),
  requireApiKey: z.boolean().default(false),
  defaultTargetUrl: z.string().url(),
  modelAliases: z.record(z.string(), z.string()).default({})
})

export type Config = z.infer<typeof ConfigSchema>

// ============================================================================
// Credential Schemas
// ============================================================================

export const CredentialsSchema = z.object({
  authorization: z.string().nullable(),
  sessionId: z.string().nullable(),
  capturedAt: z.number().nullable(),
  expiresAt: z.number().nullable().optional(),
  requestHeaders: z.record(z.string(), z.string()).nullable().optional()
})

export type Credentials = z.infer<typeof CredentialsSchema>

export const SiteCredentialSchema = z.object({
  siteId: z.string(),
  authorization: z.string().nullable(),
  sessionId: z.string().nullable(),
  capturedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
  requestHeaders: z.record(z.string(), z.string()).nullable().optional()
})

export type SiteCredential = z.infer<typeof SiteCredentialSchema>

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Validation result with detailed error information
 */
export interface ValidationResult<T> {
  success: boolean
  data: T | null
  errors: ValidationError[]
}

export interface ValidationError {
  path: string
  message: string
  code: string
}

/**
 * Validate data against a schema with detailed error reporting
 */
export function validateWithDetails<T>(
  schema: z.ZodType<T>,
  data: unknown
): ValidationResult<T> {
  const result = schema.safeParse(data)

  if (result.success) {
    return {
      success: true,
      data: result.data,
      errors: []
    }
  }

  const errors: ValidationError[] = result.error.issues.map(err => ({
    path: err.path.join('.'),
    message: err.message,
    code: err.code
  }))

  return {
    success: false,
    data: null,
    errors
  }
}

/**
 * Validate config file with user-friendly error messages
 */
export function validateConfig(data: unknown): ValidationResult<Config> {
  return validateWithDetails(ConfigSchema, data)
}

/**
 * Validate site config with user-friendly error messages
 */
export function validateSiteConfig(data: unknown): ValidationResult<SiteConfig> {
  return validateWithDetails(SiteConfigSchema, data)
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return ''

  return errors.map(err => {
    const path = err.path || 'root'
    return `  - ${path}: ${err.message}`
  }).join('\n')
}
