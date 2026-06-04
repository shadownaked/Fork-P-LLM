import type { OAuthProviderType } from '../types'
import { getMainLogger } from '../logger'
import {
  getDataPath,
  atomicWriteJsonSync,
  safeReadJsonSync
} from './storage'

const log = getMainLogger()

/**
 * Tool settings structure
 */
interface ToolSettings {
  enabled: boolean
}

/**
 * Stored tool settings structure
 */
interface StoredToolSettings {
  [provider: string]: ToolSettings
}

/**
 * Tool settings store for OAuth tools
 * Stores enabled/disabled state per OAuth provider
 */
class ToolSettingsStore {
  private settings: Map<OAuthProviderType, ToolSettings> = new Map()
  private storagePath: string

  constructor() {
    this.storagePath = getDataPath('tool-settings.json')
    this.loadFromDisk()
  }

  /**
   * Check if a tool is enabled
   * Returns true by default if not explicitly disabled
   */
  isEnabled(provider: OAuthProviderType): boolean {
    const settings = this.settings.get(provider)
    return settings?.enabled !== false
  }

  /**
   * Set enabled state for a tool
   */
  setEnabled(provider: OAuthProviderType, enabled: boolean): void {
    const existing = this.settings.get(provider) || { enabled: true }
    this.settings.set(provider, { ...existing, enabled })
    this.saveToDisk()
    log.info(`Tool ${provider} ${enabled ? 'enabled' : 'disabled'}`)
  }

  /**
   * Toggle enabled state for a tool
   */
  toggleEnabled(provider: OAuthProviderType): boolean {
    const currentEnabled = this.isEnabled(provider)
    this.setEnabled(provider, !currentEnabled)
    return !currentEnabled
  }

  /**
   * Get all tool settings
   */
  getAllSettings(): Map<OAuthProviderType, ToolSettings> {
    return new Map(this.settings)
  }

  private loadFromDisk(): void {
    const result = safeReadJsonSync<StoredToolSettings>(this.storagePath)

    if (result.success && result.data) {
      for (const [provider, settings] of Object.entries(result.data)) {
        this.settings.set(provider as OAuthProviderType, settings)
      }
      log.info(`Loaded ${this.settings.size} tool settings from disk`)
    } else if (result.error && result.error.code !== 'FILE_NOT_FOUND') {
      log.warn(`Failed to load tool settings: ${result.error.message}`)
    }
  }

  private saveToDisk(): void {
    try {
      const toStore: StoredToolSettings = {}
      for (const [provider, settings] of this.settings) {
        toStore[provider] = settings
      }

      atomicWriteJsonSync(this.storagePath, toStore)
    } catch (error) {
      log.error('Failed to save tool settings to disk:', error)
    }
  }
}

export const toolSettingsStore = new ToolSettingsStore()
