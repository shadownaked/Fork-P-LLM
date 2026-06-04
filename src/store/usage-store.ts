import * as fs from 'node:fs'
import * as path from 'node:path'
import { getMainLogger } from '../logger'

const log = getMainLogger()

/**
 * Usage record for tracking API requests per model/site
 */
export interface UsageRecord {
  siteId: string
  modelName: string
  requestCount: number
  successCount: number
  errorCount: number
  lastUsed: number
  firstUsed: number
  lastStatusCode?: number  // Last HTTP status code
  lastError?: string       // Last error message (if any)
}

/**
 * UsageStore - tracks API usage statistics per site/model
 *
 * Features:
 * - Tracks request counts, success/error rates
 * - Persists to disk for historical tracking
 * - Provides simple analytics for debugging
 */
class UsageStore {
  private usage: Map<string, UsageRecord> = new Map()
  private storagePath: string

  constructor() {
    this.storagePath = path.join(process.cwd(), 'data', 'usage.json')
    this.ensureStorageDir()
    this.loadFromDisk()
  }

  private ensureStorageDir(): void {
    const dir = path.dirname(this.storagePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  /**
   * Record an API request
   * @param siteId - The site ID
   * @param modelName - The model name used
   * @param success - Whether the request succeeded
   * @param statusCode - HTTP status code (optional)
   * @param errorMessage - Error message if failed (optional)
   */
  recordRequest(siteId: string, modelName: string, success: boolean, statusCode?: number, errorMessage?: string): void {
    const key = `${siteId}:${modelName}`
    const now = Date.now()

    let record = this.usage.get(key)
    if (!record) {
      record = {
        siteId,
        modelName,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        lastUsed: now,
        firstUsed: now
      }
    }

    record.requestCount++
    record.lastUsed = now

    if (statusCode !== undefined) {
      record.lastStatusCode = statusCode
    }

    if (success) {
      record.successCount++
      record.lastError = undefined
    } else {
      record.errorCount++
      if (errorMessage) {
        record.lastError = errorMessage
      }
    }

    this.usage.set(key, record)
    this.saveToDisk()
  }

  /**
   * Get the last status for a site (across all models)
   */
  getSiteLastStatus(siteId: string): { statusCode?: number; error?: string; lastUsed?: number } | null {
    let latestRecord: UsageRecord | null = null

    for (const record of this.usage.values()) {
      if (record.siteId === siteId) {
        if (!latestRecord || record.lastUsed > latestRecord.lastUsed) {
          latestRecord = record
        }
      }
    }

    if (!latestRecord) return null

    return {
      statusCode: latestRecord.lastStatusCode,
      error: latestRecord.lastError,
      lastUsed: latestRecord.lastUsed
    }
  }

  /**
   * Get usage statistics for a specific site
   */
  getSiteStats(siteId: string): UsageRecord[] {
    const stats: UsageRecord[] = []
    for (const record of this.usage.values()) {
      if (record.siteId === siteId) {
        stats.push({ ...record })
      }
    }
    return stats
  }

  /**
   * Get all usage statistics
   */
  getAllStats(): UsageRecord[] {
    return Array.from(this.usage.values()).map(r => ({ ...r }))
  }

  /**
   * Get summary statistics
   */
  getSummary(): {
    totalRequests: number
    totalSuccess: number
    totalErrors: number
    uniqueSites: number
    uniqueModels: number
  } {
    let totalRequests = 0
    let totalSuccess = 0
    let totalErrors = 0
    const sites = new Set<string>()
    const models = new Set<string>()

    for (const record of this.usage.values()) {
      totalRequests += record.requestCount
      totalSuccess += record.successCount
      totalErrors += record.errorCount
      sites.add(record.siteId)
      models.add(record.modelName)
    }

    return {
      totalRequests,
      totalSuccess,
      totalErrors,
      uniqueSites: sites.size,
      uniqueModels: models.size
    }
  }

  /**
   * Clear all usage statistics
   */
  clear(): void {
    this.usage.clear()
    this.saveToDisk()
    log.info('[UsageStore] Cleared all usage statistics')
  }

  /**
   * Clear error status for a site (reset lastStatusCode to 200 for all models)
   * Called when a test request succeeds to clear old error states
   */
  clearSiteErrorStatus(siteId: string): void {
    let cleared = false
    for (const [key, record] of this.usage.entries()) {
      if (record.siteId === siteId && record.lastStatusCode && record.lastStatusCode >= 400) {
        record.lastStatusCode = 200
        record.lastError = undefined
        this.usage.set(key, record)
        cleared = true
      }
    }
    if (cleared) {
      this.saveToDisk()
      log.info(`[UsageStore] Cleared error status for site "${siteId}"`)
    }
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf-8')
        const records: UsageRecord[] = JSON.parse(data)
        for (const record of records) {
          const key = `${record.siteId}:${record.modelName}`
          this.usage.set(key, record)
        }
        log.info(`[UsageStore] Loaded ${this.usage.size} usage records from disk`)
      }
    } catch (error) {
      log.warn('[UsageStore] Failed to load usage from disk:', error)
    }
  }

  private saveToDisk(): void {
    try {
      const records = Array.from(this.usage.values())
      fs.writeFileSync(this.storagePath, JSON.stringify(records, null, 2), 'utf-8')
    } catch (error) {
      log.error('[UsageStore] Failed to save usage to disk:', error)
    }
  }
}

export const usageStore = new UsageStore()
