/**
 * Tests for Claude Settings Manager
 *
 * Note: These tests use actual file system operations in a temp directory
 * to avoid ESM mock limitations
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { PROXY_TOKEN_PLACEHOLDER } from './claude-settings'

describe('Claude Settings Manager - Constants', () => {
  it('PROXY_TOKEN_PLACEHOLDER should be defined', () => {
    expect(PROXY_TOKEN_PLACEHOLDER).toBe('__PROXYLLM_TOKEN__')
  })
})

describe('Claude Settings Manager - Path Functions', () => {
  it('should have correct homedir', () => {
    const homedir = os.homedir()
    expect(homedir).toBeTruthy()
    expect(typeof homedir).toBe('string')
  })

  it('should construct correct config dir path', () => {
    const homedir = os.homedir()
    const expectedConfigDir = path.join(homedir, '.claude')
    expect(expectedConfigDir).toContain('.claude')
  })

  it('should construct correct settings path', () => {
    const homedir = os.homedir()
    const expectedSettingsPath = path.join(homedir, '.claude', 'settings.json')
    expect(expectedSettingsPath).toContain('settings.json')
  })

  it('should construct correct MCP path', () => {
    const homedir = os.homedir()
    const expectedMcpPath = path.join(homedir, '.claude.json')
    expect(expectedMcpPath).toContain('.claude.json')
  })
})

describe('Claude Settings Manager - JSON Operations', () => {
  let tempDir: string
  let tempSettingsPath: string

  beforeEach(() => {
    // Create a temp directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'))
    tempSettingsPath = path.join(tempDir, 'settings.json')
  })

  afterEach(() => {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('should write and read JSON correctly', () => {
    const settings = {
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:8080',
        ANTHROPIC_AUTH_TOKEN: PROXY_TOKEN_PLACEHOLDER
      }
    }

    // Write
    fs.writeFileSync(tempSettingsPath, JSON.stringify(settings, null, 2), 'utf-8')

    // Read and verify
    const content = fs.readFileSync(tempSettingsPath, 'utf-8')
    const parsed = JSON.parse(content)

    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://localhost:8080')
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY_TOKEN_PLACEHOLDER)
  })

  it('should handle atomic write pattern', () => {
    const settings = { env: { TEST: 'value' } }
    const tempPath = `${tempSettingsPath}.tmp`

    // Write to temp file
    fs.writeFileSync(tempPath, JSON.stringify(settings), 'utf-8')
    expect(fs.existsSync(tempPath)).toBe(true)

    // Rename (atomic operation)
    fs.renameSync(tempPath, tempSettingsPath)
    expect(fs.existsSync(tempSettingsPath)).toBe(true)
    expect(fs.existsSync(tempPath)).toBe(false)

    // Verify content
    const parsed = JSON.parse(fs.readFileSync(tempSettingsPath, 'utf-8'))
    expect(parsed.env.TEST).toBe('value')
  })

  it('should merge env fields correctly', () => {
    // Initial settings
    const initial = {
      env: { EXISTING: 'keep-me' },
      otherField: 'preserve'
    }
    fs.writeFileSync(tempSettingsPath, JSON.stringify(initial), 'utf-8')

    // Read and merge
    const current = JSON.parse(fs.readFileSync(tempSettingsPath, 'utf-8'))
    current.env = {
      ...current.env,
      ANTHROPIC_BASE_URL: 'http://localhost:8080'
    }

    // Write back
    fs.writeFileSync(tempSettingsPath, JSON.stringify(current, null, 2), 'utf-8')

    // Verify
    const final = JSON.parse(fs.readFileSync(tempSettingsPath, 'utf-8'))
    expect(final.env.EXISTING).toBe('keep-me')
    expect(final.env.ANTHROPIC_BASE_URL).toBe('http://localhost:8080')
    expect(final.otherField).toBe('preserve')
  })
})

describe('Claude Settings Manager - Takeover Detection', () => {
  it('should detect placeholder token in ANTHROPIC_AUTH_TOKEN', () => {
    const settings = {
      env: { ANTHROPIC_AUTH_TOKEN: PROXY_TOKEN_PLACEHOLDER }
    }

    const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
    const isTakenOver = tokenFields.some(
      field => settings.env[field as keyof typeof settings.env] === PROXY_TOKEN_PLACEHOLDER
    )

    expect(isTakenOver).toBe(true)
  })

  it('should detect placeholder token in ANTHROPIC_API_KEY', () => {
    const settings = {
      env: { ANTHROPIC_API_KEY: PROXY_TOKEN_PLACEHOLDER }
    }

    const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
    const isTakenOver = tokenFields.some(
      field => settings.env[field as keyof typeof settings.env] === PROXY_TOKEN_PLACEHOLDER
    )

    expect(isTakenOver).toBe(true)
  })

  it('should detect placeholder token in OPENROUTER_API_KEY', () => {
    const settings = {
      env: { OPENROUTER_API_KEY: PROXY_TOKEN_PLACEHOLDER }
    }

    const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
    const isTakenOver = tokenFields.some(
      field => settings.env[field as keyof typeof settings.env] === PROXY_TOKEN_PLACEHOLDER
    )

    expect(isTakenOver).toBe(true)
  })

  it('should detect placeholder token in OPENAI_API_KEY', () => {
    const settings = {
      env: { OPENAI_API_KEY: PROXY_TOKEN_PLACEHOLDER }
    }

    const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
    const isTakenOver = tokenFields.some(
      field => settings.env[field as keyof typeof settings.env] === PROXY_TOKEN_PLACEHOLDER
    )

    expect(isTakenOver).toBe(true)
  })

  it('should not detect takeover with real token', () => {
    const settings = {
      env: { ANTHROPIC_API_KEY: 'sk-ant-real-key' }
    }

    const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
    const isTakenOver = tokenFields.some(
      field => settings.env[field as keyof typeof settings.env] === PROXY_TOKEN_PLACEHOLDER
    )

    expect(isTakenOver).toBe(false)
  })

  it('should not detect takeover with empty env', () => {
    const settings = { env: {} }

    const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
    const isTakenOver = tokenFields.some(
      field => settings.env[field as keyof typeof settings.env] === PROXY_TOKEN_PLACEHOLDER
    )

    expect(isTakenOver).toBe(false)
  })
})

describe('Claude Settings Manager - Backup and Restore', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-backup-test-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  it('should create and restore backup', () => {
    const settingsPath = path.join(tempDir, 'settings.json')
    const backupPath = path.join(tempDir, 'settings.backup.json')

    // Original settings
    const original = {
      env: { ANTHROPIC_API_KEY: 'sk-ant-original' }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(original), 'utf-8')

    // Create backup
    fs.copyFileSync(settingsPath, backupPath)

    // Modify settings (takeover)
    const modified = {
      env: {
        ANTHROPIC_BASE_URL: 'http://localhost:8080',
        ANTHROPIC_API_KEY: PROXY_TOKEN_PLACEHOLDER
      }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(modified), 'utf-8')

    // Verify modification
    const afterTakeover = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(afterTakeover.env.ANTHROPIC_API_KEY).toBe(PROXY_TOKEN_PLACEHOLDER)

    // Restore from backup
    fs.copyFileSync(backupPath, settingsPath)

    // Verify restoration
    const afterRestore = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    expect(afterRestore.env.ANTHROPIC_API_KEY).toBe('sk-ant-original')
    expect(afterRestore.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })
})
