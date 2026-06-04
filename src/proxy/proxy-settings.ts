/**
 * Proxy Settings Manager (Simplified - Electron Local Trust)
 *
 * Manages proxy server settings:
 * - Proxy enable/disable toggle
 * - Persistent settings storage
 *
 * NO system keychain operations - certificates are trusted via
 * Electron's session.setCertificateVerifyProc() API only.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { app, shell } from 'electron'
import { getMainLogger } from '../logger'

const log = getMainLogger()

export interface ProxySettings {
  /** Whether proxy capture is enabled */
  enabled: boolean
}

export interface ProxyStatus {
  /** Whether proxy capture is enabled */
  enabled: boolean
  /** Whether CA certificate file exists */
  caExists: boolean
  /** Path to CA certificate file */
  certPath: string
}

/**
 * Get the path to store proxy settings
 */
function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'proxy-settings.json')
}

/**
 * Get the CA certificate path
 */
export function getCACertPath(): string {
  return path.join(app.getPath('userData'), 'certs', 'ca.crt')
}

/**
 * Load proxy settings from disk
 */
export function loadProxySettings(): ProxySettings {
  const defaultSettings: ProxySettings = {
    enabled: true  // Default to enabled for proxy capture
  }

  try {
    const settingsPath = getSettingsPath()
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf-8')
      const saved = JSON.parse(data)
      return { ...defaultSettings, ...saved }
    }
  } catch (err) {
    log.warn('[ProxySettings] Failed to load settings:', err)
  }

  return defaultSettings
}

/**
 * Save proxy settings to disk
 */
export function saveProxySettings(settings: ProxySettings): void {
  try {
    const settingsPath = getSettingsPath()
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    log.info('[ProxySettings] Settings saved')
  } catch (err) {
    log.error('[ProxySettings] Failed to save settings:', err)
  }
}

/**
 * Check if CA certificate exists
 */
export function caCertExists(): boolean {
  return fs.existsSync(getCACertPath())
}

/**
 * Open the CA certificate in Finder/Explorer
 * (For users who want to manually inspect or export it)
 */
export function revealCACert(): void {
  const certPath = getCACertPath()
  if (fs.existsSync(certPath)) {
    shell.showItemInFolder(certPath)
  }
}

/**
 * Get current proxy status
 */
export function getProxyStatus(): ProxyStatus {
  const settings = loadProxySettings()
  return {
    enabled: settings.enabled,
    caExists: caCertExists(),
    certPath: getCACertPath()
  }
}

/**
 * Enable proxy capture
 */
export function enableProxy(): void {
  const settings = loadProxySettings()
  settings.enabled = true
  saveProxySettings(settings)
  log.info('[ProxySettings] Proxy capture enabled')
}

/**
 * Disable proxy capture
 */
export function disableProxy(): void {
  const settings = loadProxySettings()
  settings.enabled = false
  saveProxySettings(settings)
  log.info('[ProxySettings] Proxy capture disabled')
}

/**
 * Toggle proxy capture
 */
export function toggleProxy(): boolean {
  const settings = loadProxySettings()
  settings.enabled = !settings.enabled
  saveProxySettings(settings)
  log.info(`[ProxySettings] Proxy capture ${settings.enabled ? 'enabled' : 'disabled'}`)
  return settings.enabled
}

/**
 * Check if proxy should be used for a new window
 * Now simply checks if proxy is enabled (no CA trust check needed)
 */
export function shouldUseProxy(): boolean {
  const settings = loadProxySettings()
  return settings.enabled
}
