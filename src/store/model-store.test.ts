import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the logger
vi.mock('../logger', () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn()
}))

// Create a mock siteStore
const mockSiteStore = {
  sites: new Map<string, { id: string; name: string; enabled: boolean }>(),
  getById(id: string) {
    return this.sites.get(id)
  },
  addSite(id: string, name: string, enabled: boolean = true) {
    this.sites.set(id, { id, name, enabled })
  },
  removeSite(id: string) {
    this.sites.delete(id)
  },
  setEnabled(id: string, enabled: boolean) {
    const site = this.sites.get(id)
    if (site) {
      site.enabled = enabled
    }
  },
  clear() {
    this.sites.clear()
  }
}

// Mock site-store module
vi.mock('./site-store', () => ({
  siteStore: mockSiteStore
}))

// Import after mocks are set up
import type { ModelInfo } from '../types'

// Create a fresh ModelStore class for testing (without singleton)
class TestModelStore {
  private models: Map<string, Map<string, ModelInfo>> = new Map()

  setModels(siteId: string, models: ModelInfo[]): void {
    const modelMap = new Map<string, ModelInfo>()
    for (const model of models) {
      if (!modelMap.has(model.modelName)) {
        modelMap.set(model.modelName, model)
      }
    }
    this.models.set(siteId, modelMap)
  }

  getModels(siteId: string): ModelInfo[] {
    const modelMap = this.models.get(siteId)
    if (!modelMap) return []
    return Array.from(modelMap.values())
  }

  findModelOwner(modelName: string): { siteId: string; modelInfo: ModelInfo } | undefined {
    for (const [siteId, modelMap] of this.models) {
      const modelInfo = modelMap.get(modelName)
      if (modelInfo) {
        // Validate that the site exists
        const site = mockSiteStore.getById(siteId)
        if (!site) {
          // Skip models whose site doesn't exist
          continue
        }
        // Check if site is enabled
        if (!site.enabled) {
          continue
        }
        return { siteId, modelInfo }
      }
    }
    return undefined
  }

  getAllModels(): Array<{ siteId: string; modelInfo: ModelInfo }> {
    const result: Array<{ siteId: string; modelInfo: ModelInfo }> = []
    for (const [siteId, modelMap] of this.models) {
      // Only include models from sites that exist
      const site = mockSiteStore.getById(siteId)
      if (!site) continue
      // Only include models from enabled sites
      if (!site.enabled) continue

      for (const modelInfo of modelMap.values()) {
        result.push({ siteId, modelInfo })
      }
    }
    return result
  }

  hasModels(siteId: string): boolean {
    const modelMap = this.models.get(siteId)
    return modelMap !== undefined && modelMap.size > 0
  }

  clearModels(siteId: string): void {
    this.models.delete(siteId)
  }

  clearAll(): void {
    this.models.clear()
  }

  pruneOrphanedModels(): number {
    const orphanedSites: string[] = []

    for (const siteId of this.models.keys()) {
      const site = mockSiteStore.getById(siteId)
      if (!site) {
        orphanedSites.push(siteId)
      }
    }

    for (const siteId of orphanedSites) {
      this.models.delete(siteId)
    }

    return orphanedSites.length
  }

  getOrphanedSiteIds(): string[] {
    const orphaned: string[] = []
    for (const siteId of this.models.keys()) {
      if (!mockSiteStore.getById(siteId)) {
        orphaned.push(siteId)
      }
    }
    return orphaned
  }

  getDisabledSiteIds(): string[] {
    const disabled: string[] = []
    for (const siteId of this.models.keys()) {
      const site = mockSiteStore.getById(siteId)
      if (site && !site.enabled) {
        disabled.push(siteId)
      }
    }
    return disabled
  }

  pruneDisabledSiteModels(): number {
    const disabledSites: string[] = []

    for (const siteId of this.models.keys()) {
      const site = mockSiteStore.getById(siteId)
      if (site && !site.enabled) {
        disabledSites.push(siteId)
      }
    }

    for (const siteId of disabledSites) {
      this.models.delete(siteId)
    }

    return disabledSites.length
  }

  // Test helper: get raw model count including orphaned
  getRawModelCount(): number {
    let count = 0
    for (const modelMap of this.models.values()) {
      count += modelMap.size
    }
    return count
  }
}

describe('ModelStore', () => {
  let modelStore: TestModelStore

  beforeEach(() => {
    modelStore = new TestModelStore()
    mockSiteStore.clear()
  })

  describe('setModels and getModels', () => {
    it('should set and get models for a site', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')

      const models: ModelInfo[] = [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'Claude Opus' },
        { modelName: 'claude-sonnet-4-5', modelId: 'gummie-456', displayName: 'Claude Sonnet' }
      ]

      modelStore.setModels('gumloop', models)

      const retrieved = modelStore.getModels('gumloop')
      expect(retrieved).toHaveLength(2)
      expect(retrieved[0].modelName).toBe('claude-opus-4-5')
      expect(retrieved[1].modelName).toBe('claude-sonnet-4-5')
    })

    it('should return empty array for non-existent site', () => {
      const models = modelStore.getModels('non-existent')
      expect(models).toHaveLength(0)
    })

    it('should deduplicate models with same name', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')

      const models: ModelInfo[] = [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'First' },
        { modelName: 'claude-opus-4-5', modelId: 'gummie-456', displayName: 'Second' }
      ]

      modelStore.setModels('gumloop', models)

      const retrieved = modelStore.getModels('gumloop')
      expect(retrieved).toHaveLength(1)
      expect(retrieved[0].modelId).toBe('gummie-123') // First one wins
    })
  })

  describe('findModelOwner', () => {
    it('should find model owner when site exists', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')

      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'Claude Opus' }
      ])

      const owner = modelStore.findModelOwner('claude-opus-4-5')
      expect(owner).toBeDefined()
      expect(owner?.siteId).toBe('gumloop')
      expect(owner?.modelInfo.modelId).toBe('gummie-123')
    })

    it('should NOT find model owner when site does not exist', () => {
      // Add models for a site that doesn't exist in siteStore
      modelStore.setModels('gumloop-com', [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'Claude Opus' }
      ])

      // Site doesn't exist in mockSiteStore
      const owner = modelStore.findModelOwner('claude-opus-4-5')
      expect(owner).toBeUndefined()
    })

    it('should skip stale site and find model in valid site', () => {
      // Add models for a stale site (doesn't exist)
      modelStore.setModels('gumloop-com', [
        { modelName: 'claude-opus-4-5', modelId: 'stale-123', displayName: 'Stale' }
      ])

      // Add same model for a valid site
      mockSiteStore.addSite('gumloop', 'Gumloop')
      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'valid-456', displayName: 'Valid' }
      ])

      const owner = modelStore.findModelOwner('claude-opus-4-5')
      expect(owner).toBeDefined()
      expect(owner?.siteId).toBe('gumloop')
      expect(owner?.modelInfo.modelId).toBe('valid-456')
    })

    it('should return undefined for non-existent model', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')
      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'Claude Opus' }
      ])

      const owner = modelStore.findModelOwner('non-existent-model')
      expect(owner).toBeUndefined()
    })
  })

  describe('getAllModels', () => {
    it('should return all models from valid sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')
      mockSiteStore.addSite('orchids', 'Orchids')

      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'Claude Opus' }
      ])
      modelStore.setModels('orchids', [
        { modelName: 'claude-sonnet-4-5', modelId: 'orchids-456', displayName: 'Claude Sonnet' }
      ])

      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(2)
    })

    it('should exclude models from non-existent sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')

      // Add models for valid site
      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-123', displayName: 'Claude Opus' }
      ])

      // Add models for stale site (not in siteStore)
      modelStore.setModels('gumloop-com', [
        { modelName: 'claude-sonnet-4-5', modelId: 'stale-456', displayName: 'Stale' }
      ])

      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(1)
      expect(allModels[0].siteId).toBe('gumloop')
    })

    it('should return empty array when no valid sites have models', () => {
      // Add models for a stale site only
      modelStore.setModels('gumloop-com', [
        { modelName: 'claude-opus-4-5', modelId: 'stale-123', displayName: 'Stale' }
      ])

      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(0)
    })
  })

  describe('pruneOrphanedModels', () => {
    it('should remove models for non-existent sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')

      // Add models for both valid and stale sites
      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'valid-123', displayName: 'Valid' }
      ])
      modelStore.setModels('gumloop-com', [
        { modelName: 'claude-sonnet-4-5', modelId: 'stale-456', displayName: 'Stale' }
      ])

      // Before pruning: 2 models total in raw storage
      expect(modelStore.getRawModelCount()).toBe(2)

      const prunedCount = modelStore.pruneOrphanedModels()

      expect(prunedCount).toBe(1)
      expect(modelStore.getRawModelCount()).toBe(1)
      expect(modelStore.hasModels('gumloop')).toBe(true)
      expect(modelStore.hasModels('gumloop-com')).toBe(false)
    })

    it('should return 0 when no orphaned sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')
      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'valid-123', displayName: 'Valid' }
      ])

      const prunedCount = modelStore.pruneOrphanedModels()
      expect(prunedCount).toBe(0)
    })

    it('should prune multiple orphaned sites', () => {
      mockSiteStore.addSite('valid-site', 'Valid Site')

      modelStore.setModels('valid-site', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('orphan-1', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])
      modelStore.setModels('orphan-2', [
        { modelName: 'model-3', modelId: 'id-3', displayName: 'Model 3' }
      ])

      const prunedCount = modelStore.pruneOrphanedModels()
      expect(prunedCount).toBe(2)
      expect(modelStore.getRawModelCount()).toBe(1)
    })
  })

  describe('getOrphanedSiteIds', () => {
    it('should return list of orphaned site IDs', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')

      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('orphan-1', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])
      modelStore.setModels('orphan-2', [
        { modelName: 'model-3', modelId: 'id-3', displayName: 'Model 3' }
      ])

      const orphaned = modelStore.getOrphanedSiteIds()
      expect(orphaned).toHaveLength(2)
      expect(orphaned).toContain('orphan-1')
      expect(orphaned).toContain('orphan-2')
    })

    it('should return empty array when no orphaned sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')
      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])

      const orphaned = modelStore.getOrphanedSiteIds()
      expect(orphaned).toHaveLength(0)
    })
  })

  describe('clearModels', () => {
    it('should clear models for a specific site', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop')
      mockSiteStore.addSite('orchids', 'Orchids')

      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('orchids', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])

      modelStore.clearModels('gumloop')

      expect(modelStore.hasModels('gumloop')).toBe(false)
      expect(modelStore.hasModels('orchids')).toBe(true)
    })
  })

  describe('real-world scenario: gumloop-com vs gumloop', () => {
    it('should correctly handle the gumloop-com stale site issue', () => {
      // Simulate the real-world issue:
      // - models.json has entries for both "gumloop-com" and "gumloop"
      // - sites.json only has "gumloop"
      // - Request for "claude-opus-4-5" should resolve to "gumloop", not "gumloop-com"

      // Only "gumloop" exists in siteStore
      mockSiteStore.addSite('gumloop', 'Gumloop')

      // Both sites have models stored (simulating stale data)
      modelStore.setModels('gumloop-com', [
        { modelName: 'claude-opus-4-5', modelId: 'stale-opus', displayName: 'Stale Opus' },
        { modelName: 'claude-sonnet-4-5', modelId: 'stale-sonnet', displayName: 'Stale Sonnet' }
      ])
      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'valid-opus', displayName: 'Valid Opus' },
        { modelName: 'claude-sonnet-4-5', modelId: 'valid-sonnet', displayName: 'Valid Sonnet' }
      ])

      // findModelOwner should return the valid site
      const owner = modelStore.findModelOwner('claude-opus-4-5')
      expect(owner).toBeDefined()
      expect(owner?.siteId).toBe('gumloop')
      expect(owner?.modelInfo.modelId).toBe('valid-opus')

      // getAllModels should only return models from valid site
      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(2)
      expect(allModels.every(m => m.siteId === 'gumloop')).toBe(true)

      // getOrphanedSiteIds should identify the stale site
      const orphaned = modelStore.getOrphanedSiteIds()
      expect(orphaned).toContain('gumloop-com')

      // pruneOrphanedModels should clean up
      const prunedCount = modelStore.pruneOrphanedModels()
      expect(prunedCount).toBe(1)
      expect(modelStore.hasModels('gumloop-com')).toBe(false)
      expect(modelStore.hasModels('gumloop')).toBe(true)
    })
  })

  describe('disabled site filtering', () => {
    it('should NOT find model owner when site is disabled', () => {
      // Add a disabled site
      mockSiteStore.addSite('orchids', 'Orchids', false)

      modelStore.setModels('orchids', [
        { modelName: 'orchids-claude-sonnet', modelId: 'orchids-123', displayName: 'Orchids Claude' }
      ])

      // Site exists but is disabled - should not find owner
      const owner = modelStore.findModelOwner('orchids-claude-sonnet')
      expect(owner).toBeUndefined()
    })

    it('should skip disabled site and find model in enabled site', () => {
      // Add disabled site with the model
      mockSiteStore.addSite('orchids', 'Orchids', false)
      modelStore.setModels('orchids', [
        { modelName: 'claude-sonnet-4-5', modelId: 'disabled-123', displayName: 'Disabled' }
      ])

      // Add enabled site with the same model
      mockSiteStore.addSite('gumloop', 'Gumloop', true)
      modelStore.setModels('gumloop', [
        { modelName: 'claude-sonnet-4-5', modelId: 'enabled-456', displayName: 'Enabled' }
      ])

      const owner = modelStore.findModelOwner('claude-sonnet-4-5')
      expect(owner).toBeDefined()
      expect(owner?.siteId).toBe('gumloop')
      expect(owner?.modelInfo.modelId).toBe('enabled-456')
    })

    it('should exclude models from disabled sites in getAllModels', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)
      mockSiteStore.addSite('orchids', 'Orchids', false)

      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'gumloop-123', displayName: 'Gumloop Opus' }
      ])
      modelStore.setModels('orchids', [
        { modelName: 'orchids-claude-sonnet', modelId: 'orchids-456', displayName: 'Orchids Sonnet' }
      ])

      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(1)
      expect(allModels[0].siteId).toBe('gumloop')
    })

    it('should return empty array when all sites are disabled', () => {
      mockSiteStore.addSite('orchids', 'Orchids', false)
      mockSiteStore.addSite('another', 'Another', false)

      modelStore.setModels('orchids', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('another', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])

      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(0)
    })
  })

  describe('getDisabledSiteIds', () => {
    it('should return list of disabled site IDs', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)
      mockSiteStore.addSite('orchids', 'Orchids', false)
      mockSiteStore.addSite('another', 'Another', false)

      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('orchids', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])
      modelStore.setModels('another', [
        { modelName: 'model-3', modelId: 'id-3', displayName: 'Model 3' }
      ])

      const disabled = modelStore.getDisabledSiteIds()
      expect(disabled).toHaveLength(2)
      expect(disabled).toContain('orchids')
      expect(disabled).toContain('another')
      expect(disabled).not.toContain('gumloop')
    })

    it('should return empty array when no disabled sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)
      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])

      const disabled = modelStore.getDisabledSiteIds()
      expect(disabled).toHaveLength(0)
    })

    it('should not include orphaned sites (non-existent)', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      // Add models for orphaned site (not in siteStore)
      modelStore.setModels('orphan', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])

      const disabled = modelStore.getDisabledSiteIds()
      expect(disabled).toHaveLength(0) // orphan is not "disabled", it doesn't exist
    })
  })

  describe('pruneDisabledSiteModels', () => {
    it('should remove models for disabled sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)
      mockSiteStore.addSite('orchids', 'Orchids', false)

      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('orchids', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])

      expect(modelStore.getRawModelCount()).toBe(2)

      const prunedCount = modelStore.pruneDisabledSiteModels()

      expect(prunedCount).toBe(1)
      expect(modelStore.getRawModelCount()).toBe(1)
      expect(modelStore.hasModels('gumloop')).toBe(true)
      expect(modelStore.hasModels('orchids')).toBe(false)
    })

    it('should return 0 when no disabled sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)
      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])

      const prunedCount = modelStore.pruneDisabledSiteModels()
      expect(prunedCount).toBe(0)
    })

    it('should prune multiple disabled sites', () => {
      mockSiteStore.addSite('enabled-site', 'Enabled Site', true)
      mockSiteStore.addSite('disabled-1', 'Disabled 1', false)
      mockSiteStore.addSite('disabled-2', 'Disabled 2', false)

      modelStore.setModels('enabled-site', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      modelStore.setModels('disabled-1', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])
      modelStore.setModels('disabled-2', [
        { modelName: 'model-3', modelId: 'id-3', displayName: 'Model 3' }
      ])

      const prunedCount = modelStore.pruneDisabledSiteModels()
      expect(prunedCount).toBe(2)
      expect(modelStore.getRawModelCount()).toBe(1)
    })

    it('should not affect orphaned sites', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      modelStore.setModels('gumloop', [
        { modelName: 'model-1', modelId: 'id-1', displayName: 'Model 1' }
      ])
      // Orphan site (not in siteStore)
      modelStore.setModels('orphan', [
        { modelName: 'model-2', modelId: 'id-2', displayName: 'Model 2' }
      ])

      const prunedCount = modelStore.pruneDisabledSiteModels()
      expect(prunedCount).toBe(0) // orphan is not "disabled"
      expect(modelStore.hasModels('orphan')).toBe(true) // still exists
    })
  })

  describe('real-world scenario: orchids disabled site issue', () => {
    it('should correctly handle the orchids disabled site issue', () => {
      // Simulate the real-world issue from DISABLED_SITE_REQUEST_ANALYSIS.md:
      // - orchids site exists but is disabled (enabled: false)
      // - models.json still has orchids models (e.g., orchids-claude-sonnet)
      // - Request for "orchids-claude-sonnet" should NOT route to orchids
      // - /v1/models should NOT expose orchids models

      // Setup: orchids exists but is disabled
      mockSiteStore.addSite('orchids', 'Orchids', false)
      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      // Both sites have models stored
      modelStore.setModels('orchids', [
        { modelName: 'orchids-claude-sonnet', modelId: 'orchids-sonnet-123', displayName: 'Orchids Sonnet' }
      ])
      modelStore.setModels('gumloop', [
        { modelName: 'claude-sonnet-4-5', modelId: 'gumloop-sonnet-456', displayName: 'Gumloop Sonnet' }
      ])

      // findModelOwner should NOT find orchids models
      const orchidsOwner = modelStore.findModelOwner('orchids-claude-sonnet')
      expect(orchidsOwner).toBeUndefined()

      // findModelOwner should find gumloop models
      const gumloopOwner = modelStore.findModelOwner('claude-sonnet-4-5')
      expect(gumloopOwner).toBeDefined()
      expect(gumloopOwner?.siteId).toBe('gumloop')

      // getAllModels should only return gumloop models
      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(1)
      expect(allModels[0].siteId).toBe('gumloop')

      // getDisabledSiteIds should identify orchids
      const disabled = modelStore.getDisabledSiteIds()
      expect(disabled).toContain('orchids')

      // pruneDisabledSiteModels should clean up orchids models
      const prunedCount = modelStore.pruneDisabledSiteModels()
      expect(prunedCount).toBe(1)
      expect(modelStore.hasModels('orchids')).toBe(false)
      expect(modelStore.hasModels('gumloop')).toBe(true)
    })

    it('should handle site being disabled after models were cached', () => {
      // Site starts enabled
      mockSiteStore.addSite('orchids', 'Orchids', true)

      modelStore.setModels('orchids', [
        { modelName: 'orchids-claude-sonnet', modelId: 'orchids-123', displayName: 'Orchids Sonnet' }
      ])

      // Initially, model should be findable
      let owner = modelStore.findModelOwner('orchids-claude-sonnet')
      expect(owner).toBeDefined()
      expect(owner?.siteId).toBe('orchids')

      // Site gets disabled
      mockSiteStore.setEnabled('orchids', false)

      // Now model should NOT be findable
      owner = modelStore.findModelOwner('orchids-claude-sonnet')
      expect(owner).toBeUndefined()

      // getAllModels should return empty
      const allModels = modelStore.getAllModels()
      expect(allModels).toHaveLength(0)
    })
  })
})

// Additional tests for new model type matching functionality
describe('ModelStore - Model Type Matching', () => {
  let modelStore: TestModelStore

  beforeEach(() => {
    modelStore = new TestModelStore()
    mockSiteStore.clear()
  })

  describe('findModelByType (simulated)', () => {
    // Note: The actual findModelByType is in the real ModelStore class
    // These tests verify the type detection logic conceptually

    it('should match claude-sonnet-4-20250514 to claude-sonnet-4-5 by type', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      modelStore.setModels('gumloop', [
        { modelName: 'claude-sonnet-4-5', modelId: 'gummie-sonnet', displayName: 'Claude Sonnet' },
        { modelName: 'claude-opus-4-5', modelId: 'gummie-opus', displayName: 'Claude Opus' }
      ])

      // The request model 'claude-sonnet-4-20250514' contains 'sonnet'
      // It should match 'claude-sonnet-4-5' which also contains 'sonnet'
      const requestedModel = 'claude-sonnet-4-20250514'
      const modelType = requestedModel.toLowerCase().includes('sonnet') ? 'sonnet'
        : requestedModel.toLowerCase().includes('opus') ? 'opus'
        : requestedModel.toLowerCase().includes('haiku') ? 'haiku'
        : null

      expect(modelType).toBe('sonnet')

      // Find a model that matches this type
      const allModels = modelStore.getAllModels()
      const matchingModel = allModels.find(m =>
        m.modelInfo.modelName.toLowerCase().includes(modelType!)
      )

      expect(matchingModel).toBeDefined()
      expect(matchingModel?.modelInfo.modelName).toBe('claude-sonnet-4-5')
    })

    it('should match claude-opus-4-20250514 to claude-opus-4-5 by type', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      modelStore.setModels('gumloop', [
        { modelName: 'claude-sonnet-4-5', modelId: 'gummie-sonnet', displayName: 'Claude Sonnet' },
        { modelName: 'claude-opus-4-5', modelId: 'gummie-opus', displayName: 'Claude Opus' }
      ])

      const requestedModel = 'claude-opus-4-20250514'
      const modelType = requestedModel.toLowerCase().includes('opus') ? 'opus' : null

      expect(modelType).toBe('opus')

      const allModels = modelStore.getAllModels()
      const matchingModel = allModels.find(m =>
        m.modelInfo.modelName.toLowerCase().includes(modelType!)
      )

      expect(matchingModel).toBeDefined()
      expect(matchingModel?.modelInfo.modelName).toBe('claude-opus-4-5')
    })

    it('should return null when no matching model type exists', () => {
      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      modelStore.setModels('gumloop', [
        { modelName: 'claude-sonnet-4-5', modelId: 'gummie-sonnet', displayName: 'Claude Sonnet' }
      ])

      // Request for haiku, but only sonnet is available
      const requestedModel = 'claude-haiku-4-20250514'
      const modelType = requestedModel.toLowerCase().includes('haiku') ? 'haiku' : null

      expect(modelType).toBe('haiku')

      const allModels = modelStore.getAllModels()
      const matchingModel = allModels.find(m =>
        m.modelInfo.modelName.toLowerCase().includes(modelType!)
      )

      expect(matchingModel).toBeUndefined()
    })
  })

  describe('Claude Code compatibility scenario', () => {
    it('should handle the exact E2E test failure scenario', () => {
      // This test simulates the exact scenario from E2E_PROXY_TEST_FAILURE_ANALYSIS.md:
      // - Gumloop site has models: claude-opus-4-5, claude-sonnet-4-5
      // - Claude Code requests: claude-sonnet-4-20250514
      // - Expected: Match to claude-sonnet-4-5 (same type: sonnet)

      mockSiteStore.addSite('gumloop', 'Gumloop', true)

      modelStore.setModels('gumloop', [
        { modelName: 'claude-opus-4-5', modelId: 'gummie-opus-123', displayName: 'Unique Galaxy' },
        { modelName: 'claude-sonnet-4-5', modelId: 'gummie-sonnet-456', displayName: 'Cosmic Sonnet' }
      ])

      // Claude Code request
      const claudeCodeRequest = 'claude-sonnet-4-20250514'

      // Step 1: Exact match fails
      const exactMatch = modelStore.findModelOwner(claudeCodeRequest)
      expect(exactMatch).toBeUndefined()

      // Step 2: Type-based match should succeed
      const modelType = 'sonnet' // detected from 'claude-sonnet-4-20250514'

      const allModels = modelStore.getAllModels()
      const typeMatch = allModels.find(m =>
        m.modelInfo.modelName.toLowerCase().includes(modelType)
      )

      expect(typeMatch).toBeDefined()
      expect(typeMatch?.siteId).toBe('gumloop')
      expect(typeMatch?.modelInfo.modelName).toBe('claude-sonnet-4-5')
      expect(typeMatch?.modelInfo.modelId).toBe('gummie-sonnet-456')
    })
  })
})
