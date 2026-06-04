/**
 * Capture Handler - extracts sessionId and models from CDP network events
 *
 * This module handles:
 * 1. SessionId capture from request body or response body (based on site configuration)
 * 2. Model list capture from API responses (based on site configuration)
 */

import type { SiteConfig, CaptureRule, ModelInfo } from './types'
import { credentialStore } from './store/credential-store'
import { modelStore } from './store/model-store'
import { siteStore } from './store/site-store'
import { getMainLogger } from './logger'

// Lazy logger initialization to avoid issues with module load order
let _log: ReturnType<typeof getMainLogger> | null = null
function getLog() {
  if (!_log) {
    _log = getMainLogger()
  }
  return _log
}

/**
 * Check if URL matches a pattern
 * Supports wildcards (*) and exact matches
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  if (pattern === '*') return true

  // Convert pattern to regex
  // Escape special regex chars except *
  const regexPattern = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')

  return new RegExp(regexPattern).test(url)
}

/**
 * Extract a value from a nested JSON object using dot notation path
 * e.g., extractJsonPath({ a: { b: 'value' } }, 'a.b') => 'value'
 */
function extractJsonPath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined

  const parts = path.split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

/**
 * Try to capture sessionId from request body
 * Called when Network.requestWillBeSent is received
 */
export function captureSessionIdFromBody(
  siteId: string,
  url: string,
  postData: string
): boolean {
  const site = siteStore.getById(siteId)
  if (!site) return false

  // Find matching capture rule with body source
  const rule = site.captureRules.find(r =>
    r.captureSessionId &&
    r.sessionIdField &&
    r.sessionIdSource === 'body' &&
    urlMatchesPattern(url, r.urlPattern)
  )

  if (!rule || !rule.sessionIdField) return false

  try {
    const bodyJson = JSON.parse(postData)
    const sessionId = extractJsonPath(bodyJson, rule.sessionIdField)

    if (sessionId && typeof sessionId === 'string') {
      credentialStore.setSessionId(siteId, sessionId)
      getLog().info(`[CaptureHandler] Captured sessionId from request body for site "${siteId}": ${rule.sessionIdField}=${sessionId}`)
      return true
    }
  } catch (err) {
    getLog().debug(`[CaptureHandler] Failed to parse request body for sessionId: ${err}`)
  }

  return false
}

/**
 * Try to capture sessionId from response body
 * Called when response body is available
 */
export function captureSessionIdFromResponse(
  siteId: string,
  url: string,
  responseBody: string
): boolean {
  const site = siteStore.getById(siteId)
  if (!site) return false

  // Find matching capture rule with response source
  const rule = site.captureRules.find(r =>
    r.captureSessionId &&
    r.sessionIdField &&
    r.sessionIdSource === 'response' &&
    urlMatchesPattern(url, r.urlPattern)
  )

  if (!rule || !rule.sessionIdField) return false

  try {
    const bodyJson = JSON.parse(responseBody)
    const sessionId = extractJsonPath(bodyJson, rule.sessionIdField)

    if (sessionId && typeof sessionId === 'string') {
      credentialStore.setSessionId(siteId, sessionId)
      getLog().info(`[CaptureHandler] Captured sessionId from response body for site "${siteId}": ${rule.sessionIdField}=${sessionId}`)
      return true
    }
  } catch (err) {
    getLog().debug(`[CaptureHandler] Failed to parse response body for sessionId: ${err}`)
  }

  return false
}

/**
 * Try to capture models from response body
 * Called when response body is available
 */
export function captureModelsFromResponse(
  siteId: string,
  url: string,
  responseBody: string
): boolean {
  const site = siteStore.getById(siteId)
  if (!site || !site.modelCaptureConfig) return false

  const config = site.modelCaptureConfig

  // Check if URL matches the pattern
  if (!urlMatchesPattern(url, config.urlPattern)) return false

  try {
    const bodyJson = JSON.parse(responseBody)
    const sources = Array.isArray(bodyJson) ? bodyJson : [bodyJson]
    let foundModelList = false

    const models: ModelInfo[] = []

    for (const source of sources) {
      const modelList = extractJsonPath(source, config.responseField)
      if (!Array.isArray(modelList)) continue
      foundModelList = true

      for (const item of modelList) {
        if (!item || typeof item !== 'object') continue

        const modelName = (item as Record<string, unknown>)[config.modelNameField]
        if (!modelName || typeof modelName !== 'string') continue

        const modelIdField = config.modelIdField || config.modelNameField
        const modelId = (item as Record<string, unknown>)[modelIdField]

        const displayNameField = config.displayNameField
        const displayName = displayNameField
          ? (item as Record<string, unknown>)[displayNameField]
          : undefined

        models.push({
          modelName: `${siteId}/${modelName}`,
          modelId: typeof modelId === 'string' ? modelId : modelName,
          displayName: typeof displayName === 'string' ? displayName : `${siteId} - ${modelName}`
        })
      }
    }

    if (!foundModelList) {
      getLog().debug(`[CaptureHandler] Model list is not an array for site "${siteId}"`)
      return false
    }

    if (models.length > 0) {
      modelStore.setModels(siteId, models)
      getLog().info(`[CaptureHandler] Captured ${models.length} models from response for site "${siteId}"`)
      return true
    }
  } catch (err) {
    getLog().debug(`[CaptureHandler] Failed to parse response body for models: ${err}`)
  }

  return false
}

/**
 * Process captured response - tries to extract sessionId and models
 * This is the main entry point called from handleCDPMessage
 */
export function processResponseCapture(
  siteId: string,
  url: string,
  responseBody: string
): void {
  // Try to capture sessionId from response
  captureSessionIdFromResponse(siteId, url, responseBody)

  // Try to capture models from response
  captureModelsFromResponse(siteId, url, responseBody)
}

/**
 * Process captured request - tries to extract sessionId from body
 * This is called from handleCDPMessage when postData is available
 */
export function processRequestCapture(
  siteId: string,
  url: string,
  postData: string
): void {
  // Try to capture sessionId from request body
  captureSessionIdFromBody(siteId, url, postData)
}
