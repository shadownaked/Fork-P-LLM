import * as fs from 'node:fs'
import * as path from 'node:path'
import { getMainLogger } from './logger'

const log = getMainLogger()

type ConfigChangeCallback = () => void

/**
 * ConfigWatcher - watches configuration files for changes and triggers reload
 *
 * Features:
 * - Debounced change detection (avoids multiple triggers for rapid saves)
 * - Graceful error handling
 * - Support for multiple watched files
 */
export class ConfigWatcher {
  private watchers: Map<string, fs.FSWatcher> = new Map()
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private debounceMs: number

  constructor(debounceMs: number = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Watch a file for changes
   * @param filePath - Path to the file to watch
   * @param onChange - Callback to invoke when file changes
   */
  watch(filePath: string, onChange: ConfigChangeCallback): void {
    const absolutePath = path.resolve(filePath)

    // Don't watch the same file twice
    if (this.watchers.has(absolutePath)) {
      log.warn(`[ConfigWatcher] Already watching: ${absolutePath}`)
      return
    }

    // Check if file exists
    if (!fs.existsSync(absolutePath)) {
      log.warn(`[ConfigWatcher] File does not exist: ${absolutePath}`)
      return
    }

    try {
      const watcher = fs.watch(absolutePath, { persistent: false }, (event) => {
        if (event === 'change') {
          this.handleChange(absolutePath, onChange)
        }
      })

      watcher.on('error', (err) => {
        log.error(`[ConfigWatcher] Error watching ${absolutePath}:`, err)
        this.unwatch(absolutePath)
      })

      this.watchers.set(absolutePath, watcher)
      log.info(`[ConfigWatcher] Watching: ${absolutePath}`)
    } catch (err) {
      log.error(`[ConfigWatcher] Failed to watch ${absolutePath}:`, err)
    }
  }

  /**
   * Handle file change with debouncing
   */
  private handleChange(filePath: string, onChange: ConfigChangeCallback): void {
    // Clear existing timer
    const existingTimer = this.debounceTimers.get(filePath)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      log.info(`[ConfigWatcher] File changed: ${filePath}`)
      this.debounceTimers.delete(filePath)

      try {
        onChange()
      } catch (err) {
        log.error(`[ConfigWatcher] Error in change callback for ${filePath}:`, err)
      }
    }, this.debounceMs)

    this.debounceTimers.set(filePath, timer)
  }

  /**
   * Stop watching a specific file
   */
  unwatch(filePath: string): void {
    const absolutePath = path.resolve(filePath)
    const watcher = this.watchers.get(absolutePath)

    if (watcher) {
      watcher.close()
      this.watchers.delete(absolutePath)
      log.info(`[ConfigWatcher] Stopped watching: ${absolutePath}`)
    }

    // Clear any pending debounce timer
    const timer = this.debounceTimers.get(absolutePath)
    if (timer) {
      clearTimeout(timer)
      this.debounceTimers.delete(absolutePath)
    }
  }

  /**
   * Stop watching all files
   */
  close(): void {
    for (const [filePath, watcher] of this.watchers) {
      watcher.close()
      log.info(`[ConfigWatcher] Stopped watching: ${filePath}`)
    }
    this.watchers.clear()

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    log.info('[ConfigWatcher] All watchers closed')
  }

  /**
   * Get list of watched files
   */
  getWatchedFiles(): string[] {
    return Array.from(this.watchers.keys())
  }
}
