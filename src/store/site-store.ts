import type { SiteConfig } from '../types'
import { getMainLogger } from '../logger'
import {
  getDataPath,
  atomicWriteJsonSync,
  safeReadJsonSync,
  migrateFile
} from './storage'

const log = getMainLogger()

/**
 * Site configuration store with persistence
 * Manages site configurations for multi-site support
 *
 * Sites are user-configured, not hardcoded.
 * Users add sites through the UI or by editing sites.json directly.
 */
class SiteStore {
  private sites: SiteConfig[] = []
  private storagePath: string

  constructor() {
    // Migrate from legacy location if needed
    migrateFile('sites.json')

    // Use stable data path
    this.storagePath = getDataPath('sites.json')
    this.loadFromDisk()
  }

  /**
   * Get all site configurations
   */
  getAll(): SiteConfig[] {
    return [...this.sites]
  }

  /**
   * Get site configuration by ID
   */
  getById(id: string): SiteConfig | undefined {
    return this.sites.find(s => s.id === id)
  }

  /**
   * Get all enabled site configurations
   */
  getEnabled(): SiteConfig[] {
    return this.sites.filter(s => s.enabled)
  }

  /**
   * Find site by URL pattern match
   */
  findByUrl(url: string): SiteConfig | undefined {
    for (const site of this.getEnabled()) {
      for (const rule of site.captureRules) {
        if (this.matchUrlPattern(url, rule.urlPattern)) {
          return site
        }
      }
    }
    return undefined
  }

  /**
   * Add a new site configuration
   */
  add(site: SiteConfig): void {
    if (this.sites.some(s => s.id === site.id)) {
      log.warn(`Site with id "${site.id}" already exists`)
      return
    }
    this.sites.push(site)
    this.saveToDisk()
    log.info(`Site added: ${site.id}`)
  }

  /**
   * Update an existing site configuration
   */
  update(id: string, updates: Partial<SiteConfig>): void {
    const index = this.sites.findIndex(s => s.id === id)
    if (index >= 0) {
      this.sites[index] = { ...this.sites[index], ...updates }
      this.saveToDisk()
      log.info(`Site updated: ${id}`)
    } else {
      log.warn(`Site not found: ${id}`)
    }
  }

  /**
   * Remove a site configuration
   */
  remove(id: string): void {
    this.sites = this.sites.filter(s => s.id !== id)
    this.saveToDisk()
    log.info(`Site removed: ${id}`)
  }

  /**
   * Clear all sites
   */
  clear(): void {
    this.sites = []
    this.saveToDisk()
    log.info('All sites cleared')
  }

  private matchUrlPattern(url: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
    const regex = new RegExp(regexPattern)
    return regex.test(url)
  }

  private loadFromDisk(): void {
    const result = safeReadJsonSync<SiteConfig[]>(this.storagePath)

    if (result.success && result.data) {
      this.sites = result.data
      log.info(`Loaded ${this.sites.length} sites from disk`)
    } else if (result.error && result.error.code !== 'FILE_NOT_FOUND') {
      log.warn(`Failed to load sites: ${result.error.message}`)
      this.sites = []
    } else {
      // File not found, start with empty list
      this.sites = []
      log.info('No sites configured yet')
    }
  }

  private saveToDisk(): void {
    try {
      // Atomic write to prevent corruption
      atomicWriteJsonSync(this.storagePath, this.sites)
    } catch (error) {
      log.error('Failed to save sites to disk:', error)
    }
  }
}

export const siteStore = new SiteStore()
