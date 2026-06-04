/**
 * Unit tests for proxy-settings (Simplified - Electron Local Trust)
 *
 * These tests verify:
 * 1. Settings persistence
 * 2. Proxy toggle functionality
 * 3. Status reporting
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Mock electron modules before importing proxy-settings
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') {
        return (global as any).__testUserDataDir || os.tmpdir()
      }
      return os.tmpdir()
    })
  },
  shell: {
    showItemInFolder: vi.fn()
  }
}))

// Mock logger
vi.mock('../logger', () => ({
  getMainLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

// Import after mocks are set up
import {
  loadProxySettings,
  saveProxySettings,
  getCACertPath,
  caCertExists,
  getProxyStatus,
  enableProxy,
  disableProxy,
  toggleProxy,
  shouldUseProxy
} from './proxy-settings'

describe('proxy-settings', () => {
  let testDir: string

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-settings-test-'))
    ;(global as any).__testUserDataDir = testDir
  })

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(testDir, { recursive: true, force: true })
    delete (global as any).__testUserDataDir
  })

  describe('loadProxySettings()', () => {
    it('should return default settings when no file exists', () => {
      const settings = loadProxySettings()

      expect(settings).toEqual({
        enabled: false
      })
    })

    it('should load saved settings from file', () => {
      const settingsPath = path.join(testDir, 'proxy-settings.json')
      fs.writeFileSync(settingsPath, JSON.stringify({ enabled: true }))

      const settings = loadProxySettings()
      expect(settings.enabled).toBe(true)
    })

    it('should handle corrupted settings file gracefully', () => {
      const settingsPath = path.join(testDir, 'proxy-settings.json')
      fs.writeFileSync(settingsPath, 'invalid json')

      const settings = loadProxySettings()
      expect(settings).toEqual({ enabled: false })
    })
  })

  describe('saveProxySettings()', () => {
    it('should save settings to file', () => {
      saveProxySettings({ enabled: true })

      const settingsPath = path.join(testDir, 'proxy-settings.json')
      const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      expect(saved.enabled).toBe(true)
    })
  })

  describe('getCACertPath()', () => {
    it('should return path in userData/certs directory', () => {
      const certPath = getCACertPath()

      expect(certPath).toContain('certs')
      expect(certPath).toContain('ca.crt')
    })
  })

  describe('caCertExists()', () => {
    it('should return false when CA cert does not exist', () => {
      expect(caCertExists()).toBe(false)
    })

    it('should return true when CA cert exists', () => {
      const certsDir = path.join(testDir, 'certs')
      fs.mkdirSync(certsDir, { recursive: true })
      fs.writeFileSync(path.join(certsDir, 'ca.crt'), 'test cert')

      expect(caCertExists()).toBe(true)
    })
  })

  describe('getProxyStatus()', () => {
    it('should return current proxy status', () => {
      const status = getProxyStatus()

      expect(status).toHaveProperty('enabled')
      expect(status).toHaveProperty('caExists')
      expect(status).toHaveProperty('certPath')
    })

    it('should reflect enabled state', () => {
      saveProxySettings({ enabled: true })
      const status = getProxyStatus()

      expect(status.enabled).toBe(true)
    })
  })

  describe('enableProxy()', () => {
    it('should enable proxy', () => {
      enableProxy()

      const settings = loadProxySettings()
      expect(settings.enabled).toBe(true)
    })
  })

  describe('disableProxy()', () => {
    it('should disable proxy', () => {
      saveProxySettings({ enabled: true })
      disableProxy()

      const settings = loadProxySettings()
      expect(settings.enabled).toBe(false)
    })
  })

  describe('toggleProxy()', () => {
    it('should toggle proxy from disabled to enabled', () => {
      saveProxySettings({ enabled: false })
      const result = toggleProxy()

      expect(result).toBe(true)
      expect(loadProxySettings().enabled).toBe(true)
    })

    it('should toggle proxy from enabled to disabled', () => {
      saveProxySettings({ enabled: true })
      const result = toggleProxy()

      expect(result).toBe(false)
      expect(loadProxySettings().enabled).toBe(false)
    })
  })

  describe('shouldUseProxy()', () => {
    it('should return false when proxy is disabled', () => {
      saveProxySettings({ enabled: false })
      expect(shouldUseProxy()).toBe(false)
    })

    it('should return true when proxy is enabled', () => {
      saveProxySettings({ enabled: true })
      expect(shouldUseProxy()).toBe(true)
    })
  })
})
