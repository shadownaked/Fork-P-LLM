import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ModelInfo } from '../types'
import { getMainLogger } from '../logger'
// Note: siteStore is imported lazily to avoid circular dependency
import type { SiteConfig } from '../types'
import {
  detectModelType,
  areModelsCompatible,
  type ClaudeModelType
} from '../utils/model-normalizer'

const log = getMainLogger()

// Lazy getter for siteStore to avoid circular dependency at module load time
let _siteStore: { getById: (id: string) => SiteConfig | undefined } | null = null
function getSiteStore(): { getById: (id: string) => SiteConfig | undefined } {
  if (!_siteStore) {
    // Dynamic import to break circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _siteStore = require('./site-store').siteStore
  }
  return _siteStore!
}

interface StoredModels {
  [siteId: string]: ModelInfo[]
}

/**
 * Model Store - manages dynamic model information per site
 *
 * Stores mapping of model names to internal IDs (e.g., gummie_id for Gumloop)
 * Allows one site to expose multiple models via /v1/models
 * Persists to disk for restoration after restart
 */
class ModelStore {
  // siteId -> modelName -> ModelInfo
  private models: Map<string, Map<string, ModelInfo>> = new Map()
  private storagePath: string

  constructor() {
    this.storagePath = path.join(process.cwd(), 'data', 'models.json')
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
   * Set models for a site (replaces existing)
   */
  setModels(siteId: string, models: ModelInfo[]): void {
    const modelMap = new Map<string, ModelInfo>()

    for (const model of models) {
      // Only keep the first model with each name
      if (!modelMap.has(model.modelName)) {
        modelMap.set(model.modelName, model)
      }
    }

    this.models.set(siteId, modelMap)
    this.saveToDisk()
    log.info(`[ModelStore] Set ${modelMap.size} models for site "${siteId}"`)
  }

  /**
   * Get all models for a site
   */
  getModels(siteId: string): ModelInfo[] {
    const modelMap = this.models.get(siteId)
    if (!modelMap) {
      return []
    }
    return Array.from(modelMap.values())
  }

  /**
   * Get model info by model name for a site
   */
  getModel(siteId: string, modelName: string): ModelInfo | undefined {
    return this.models.get(siteId)?.get(modelName)
  }

  /**
   * Find which site owns a model name
   * Returns { siteId, modelInfo } or undefined
   *
   * IMPORTANT: Only returns models whose site exists AND is enabled in siteStore.
   * This prevents stale model entries from shadowing active sites,
   * and prevents routing to disabled sites.
   */
  findModelOwner(modelName: string): { siteId: string; modelInfo: ModelInfo } | undefined {
    const siteStore = getSiteStore()

    // First pass: find model with valid and enabled site
    for (const [siteId, modelMap] of this.models) {
      const modelInfo = modelMap.get(modelName)
      if (modelInfo) {
        // Validate that the site exists
        const site = siteStore.getById(siteId)
        if (!site) {
          // Log warning for stale model entry
          log.warn(`[ModelStore] Model "${modelName}" belongs to non-existent site "${siteId}", skipping`)
          continue
        }
        // Check if site is enabled
        if (!site.enabled) {
          log.debug(`[ModelStore] Model "${modelName}" belongs to disabled site "${siteId}", skipping`)
          continue
        }
        return { siteId, modelInfo }
      }
    }
    return undefined
  }

  /**
   * Get all models across all sites
   *
   * IMPORTANT: Only returns models whose site exists AND is enabled in siteStore.
   * This prevents the "available models" list from including models
   * that cannot actually be served (disabled or non-existent sites).
   */
  getAllModels(): Array<{ siteId: string; modelInfo: ModelInfo }> {
    const siteStore = getSiteStore()
    const result: Array<{ siteId: string; modelInfo: ModelInfo }> = []

    for (const [siteId, modelMap] of this.models) {
      // Only include models from sites that exist
      const site = siteStore.getById(siteId)
      if (!site) {
        log.debug(`[ModelStore] Skipping models for non-existent site "${siteId}" in getAllModels()`)
        continue
      }
      // Only include models from enabled sites
      if (!site.enabled) {
        log.debug(`[ModelStore] Skipping models for disabled site "${siteId}" in getAllModels()`)
        continue
      }

      for (const modelInfo of modelMap.values()) {
        result.push({ siteId, modelInfo })
      }
    }
    return result
  }

  /**
   * Check if a site has any models
   */
  hasModels(siteId: string): boolean {
    const modelMap = this.models.get(siteId)
    return modelMap !== undefined && modelMap.size > 0
  }

  /**
   * Clear models for a site
   */
  clearModels(siteId: string): void {
    this.models.delete(siteId)
    this.saveToDisk()
    log.info(`[ModelStore] Cleared models for site "${siteId}"`)
  }

  /**
   * Clear all models
   */
  clearAll(): void {
    this.models.clear()
    this.saveToDisk()
    log.info('[ModelStore] Cleared all models')
  }

  /**
   * Prune models belonging to sites that no longer exist
   * This removes stale entries from disk storage and memory
   *
   * Call this during startup after siteStore is fully loaded,
   * or when sites are removed.
   *
   * @returns Number of site entries pruned
   */
  pruneOrphanedModels(): number {
    const siteStore = getSiteStore()
    const orphanedSites: string[] = []

    for (const siteId of this.models.keys()) {
      const site = siteStore.getById(siteId)
      if (!site) {
        orphanedSites.push(siteId)
      }
    }

    if (orphanedSites.length > 0) {
      for (const siteId of orphanedSites) {
        const modelCount = this.models.get(siteId)?.size || 0
        this.models.delete(siteId)
        log.info(`[ModelStore] Pruned ${modelCount} orphaned models for non-existent site "${siteId}"`)
      }
      this.saveToDisk()
      log.info(`[ModelStore] Pruned models for ${orphanedSites.length} orphaned sites: ${orphanedSites.join(', ')}`)
    }

    return orphanedSites.length
  }

  /**
   * Get list of site IDs that have models stored but don't exist in siteStore
   * Useful for diagnostics
   */
  getOrphanedSiteIds(): string[] {
    const siteStore = getSiteStore()
    const orphaned: string[] = []

    for (const siteId of this.models.keys()) {
      if (!siteStore.getById(siteId)) {
        orphaned.push(siteId)
      }
    }

    return orphaned
  }

  /**
   * Get list of site IDs that have models stored but are disabled
   * Useful for diagnostics
   */
  getDisabledSiteIds(): string[] {
    const siteStore = getSiteStore()
    const disabled: string[] = []

    for (const siteId of this.models.keys()) {
      const site = siteStore.getById(siteId)
      if (site && !site.enabled) {
        disabled.push(siteId)
      }
    }

    return disabled
  }

  /**
   * Prune models belonging to disabled sites
   * This removes model entries from disk storage and memory for disabled sites
   *
   * Call this when sites are disabled, or during startup to clean up.
   *
   * @returns Number of site entries pruned
   */
  pruneDisabledSiteModels(): number {
    const siteStore = getSiteStore()
    const disabledSites: string[] = []

    for (const siteId of this.models.keys()) {
      const site = siteStore.getById(siteId)
      if (site && !site.enabled) {
        disabledSites.push(siteId)
      }
    }

    if (disabledSites.length > 0) {
      for (const siteId of disabledSites) {
        const modelCount = this.models.get(siteId)?.size || 0
        this.models.delete(siteId)
        log.info(`[ModelStore] Pruned ${modelCount} models for disabled site "${siteId}"`)
      }
      this.saveToDisk()
      log.info(`[ModelStore] Pruned models for ${disabledSites.length} disabled sites: ${disabledSites.join(', ')}`)
    }

    return disabledSites.length
  }

  /**
   * Find a model by type (haiku/sonnet/opus)
   *
   * This method supports Claude Code compatibility by matching model types
   * rather than exact names. For example, a request for 'claude-sonnet-4-20250514'
   * can be matched to 'claude-sonnet-4-5' because both are 'sonnet' type.
   *
   * @param modelType The model type to search for
   * @param checkCredentials Optional callback to verify credentials are valid
   * @returns First matching model with valid credentials, or undefined
   */
  findModelByType(
    modelType: ClaudeModelType,
    checkCredentials?: (siteId: string) => boolean
  ): { siteId: string; modelInfo: ModelInfo } | undefined {
    const siteStore = getSiteStore()

    for (const [siteId, modelMap] of this.models) {
      // Validate site exists and is enabled
      const site = siteStore.getById(siteId)
      if (!site || !site.enabled) {
        continue
      }

      // Check credentials if callback provided
      if (checkCredentials && !checkCredentials(siteId)) {
        continue
      }

      // Search for matching model type
      for (const modelInfo of modelMap.values()) {
        const detectedType = detectModelType(modelInfo.modelName)
        if (detectedType === modelType) {
          log.debug(`[ModelStore] Found ${modelType} model: ${modelInfo.modelName} in site ${siteId}`)
          return { siteId, modelInfo }
        }
      }
    }

    return undefined
  }

  /**
   * Find a compatible model for the requested model name
   *
   * Search order:
   * 1. Exact name match
   * 2. Type-based match (same haiku/sonnet/opus type)
   *
   * @param requestedModel The model name requested
   * @param checkCredentials Optional callback to verify credentials are valid
   * @returns Matching model info, or undefined
   */
  findCompatibleModel(
    requestedModel: string,
    checkCredentials?: (siteId: string) => boolean
  ): { siteId: string; modelInfo: ModelInfo } | undefined {
    // First, try exact match
    const exactMatch = this.findModelOwner(requestedModel)
    if (exactMatch) {
      if (!checkCredentials || checkCredentials(exactMatch.siteId)) {
        return exactMatch
      }
    }

    // Second, try type-based match
    const requestedType = detectModelType(requestedModel)
    if (requestedType) {
      const typeMatch = this.findModelByType(requestedType, checkCredentials)
      if (typeMatch) {
        log.info(`[ModelStore] Model "${requestedModel}" matched by type "${requestedType}" to "${typeMatch.modelInfo.modelName}"`)
        return typeMatch
      }
    }

    return undefined
  }

  /**
   * Check if any model of the given type is available
   *
   * @param modelType The model type to check
   * @param checkCredentials Optional callback to verify credentials
   * @returns true if at least one model of this type is available
   */
  hasModelOfType(
    modelType: ClaudeModelType,
    checkCredentials?: (siteId: string) => boolean
  ): boolean {
    return this.findModelByType(modelType, checkCredentials) !== undefined
  }

  /**
   * Get all available model types
   *
   * @param checkCredentials Optional callback to verify credentials
   * @returns Array of available model types
   */
  getAvailableModelTypes(checkCredentials?: (siteId: string) => boolean): ClaudeModelType[] {
    const types = new Set<ClaudeModelType>()
    const siteStore = getSiteStore()

    for (const [siteId, modelMap] of this.models) {
      const site = siteStore.getById(siteId)
      if (!site || !site.enabled) continue
      if (checkCredentials && !checkCredentials(siteId)) continue

      for (const modelInfo of modelMap.values()) {
        const type = detectModelType(modelInfo.modelName)
        if (type) {
          types.add(type)
        }
      }
    }

    return Array.from(types)
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.storagePath)) {
        const data = fs.readFileSync(this.storagePath, 'utf-8')
        const stored: StoredModels = JSON.parse(data)
        for (const [siteId, models] of Object.entries(stored)) {
          const modelMap = new Map<string, ModelInfo>()
          for (const model of models) {
            modelMap.set(model.modelName, model)
          }
          this.models.set(siteId, modelMap)
        }
        const totalModels = Array.from(this.models.values()).reduce((sum, m) => sum + m.size, 0)
        log.info(`[ModelStore] Loaded ${totalModels} models for ${this.models.size} sites from disk`)
      }
    } catch (error) {
      log.warn('[ModelStore] Failed to load models from disk:', error)
    }
  }

  private saveToDisk(): void {
    try {
      const toStore: StoredModels = {}
      for (const [siteId, modelMap] of this.models) {
        toStore[siteId] = Array.from(modelMap.values())
      }
      fs.writeFileSync(this.storagePath, JSON.stringify(toStore, null, 2), 'utf-8')
    } catch (error) {
      log.error('[ModelStore] Failed to save models to disk:', error)
    }
  }
}

export const modelStore = new ModelStore()
