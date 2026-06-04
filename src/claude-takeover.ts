/**
 * Claude Code Takeover Manager
 *
 * 管理 Claude Code 的代理接管与恢复：
 * - 接管：将 Claude Code 的 ANTHROPIC_BASE_URL 指向本地代理
 * - 恢复：回滚到接管前的配置
 * - 备份：接管前自动备份原配置
 *
 * 设计原则：
 * 1. 只修改 env 字段，不破坏其他配置
 * 2. 必须可恢复，任何时候都能回滚
 * 3. 使用占位符 Token，代理端注入真实 Token
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  readClaudeSettings,
  writeClaudeSettings,
  getClaudeConfigDir,
  setClaudeOnboardingCompleted,
  isProxyTakeover,
  PROXY_TOKEN_PLACEHOLDER,
  type ClaudeSettings,
  type ClaudeEnv
} from './claude-settings'

// Lazy logger to avoid Electron dependency in non-Electron environments
type LogFn = (...args: unknown[]) => void
interface Logger {
  info: LogFn
  warn: LogFn
  error: LogFn
}

let _log: Logger | null = null

function getLog(): Logger {
  if (!_log) {
    try {
      // Dynamic import to avoid issues in non-Electron environment
      const { getMainLogger } = require('./logger')
      _log = getMainLogger()
    } catch {
      // Fallback: silent logger (no console output in production)
      _log = {
        info: () => {},
        warn: () => {},
        error: () => {}
      }
    }
  }
  return _log!
}

// Proxy object to lazily access logger
const log = {
  info: (msg: string, ...args: unknown[]) => getLog().info(`[ClaudeTakeover] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => getLog().warn(`[ClaudeTakeover] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => getLog().error(`[ClaudeTakeover] ${msg}`, ...args)
}

// 备份文件名
const BACKUP_FILENAME = 'settings.backup.json'

// 接管状态
export interface TakeoverStatus {
  isTakenOver: boolean
  proxyUrl: string | null
  hasBackup: boolean
  backupPath: string | null
}

/**
 * 获取备份文件路径
 */
function getBackupPath(): string {
  return path.join(getClaudeConfigDir(), BACKUP_FILENAME)
}

/**
 * 备份当前 Claude settings
 */
function backupSettings(settings: ClaudeSettings): boolean {
  const backupPath = getBackupPath()

  try {
    const content = JSON.stringify(settings, null, 2)
    fs.writeFileSync(backupPath, content, 'utf-8')
    log.info(`[ClaudeTakeover] Settings backed up to: ${backupPath}`)
    return true
  } catch (error) {
    const err = error as Error
    log.error(`[ClaudeTakeover] Failed to backup settings: ${err.message}`)
    return false
  }
}

/**
 * 读取备份的 settings
 */
function readBackup(): ClaudeSettings | null {
  const backupPath = getBackupPath()

  try {
    if (!fs.existsSync(backupPath)) {
      return null
    }

    const content = fs.readFileSync(backupPath, 'utf-8')
    return JSON.parse(content) as ClaudeSettings
  } catch (error) {
    const err = error as Error
    log.error(`[ClaudeTakeover] Failed to read backup: ${err.message}`)
    return null
  }
}

/**
 * 删除备份文件
 */
function removeBackup(): void {
  const backupPath = getBackupPath()

  try {
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath)
      log.info(`[ClaudeTakeover] Backup removed: ${backupPath}`)
    }
  } catch (error) {
    const err = error as Error
    log.warn(`[ClaudeTakeover] Failed to remove backup: ${err.message}`)
  }
}

/**
 * 检查备份是否存在
 */
export function hasBackup(): boolean {
  return fs.existsSync(getBackupPath())
}

/**
 * 获取接管状态
 */
export function getTakeoverStatus(): TakeoverStatus {
  const settings = readClaudeSettings()
  const isTakenOver = isProxyTakeover()
  const backupPath = getBackupPath()

  return {
    isTakenOver,
    proxyUrl: isTakenOver ? (settings.env?.ANTHROPIC_BASE_URL || null) : null,
    hasBackup: fs.existsSync(backupPath),
    backupPath: fs.existsSync(backupPath) ? backupPath : null
  }
}

/**
 * 接管 Claude Code 配置
 *
 * @param proxyUrl 本地代理 URL，如 http://127.0.0.1:8080
 * @returns 是否成功
 */
export function takeoverClaude(proxyUrl: string): boolean {
  log.info(`[ClaudeTakeover] Taking over Claude Code with proxy: ${proxyUrl}`)

  // 检查是否已经被接管
  if (isProxyTakeover()) {
    log.warn(`[ClaudeTakeover] Already taken over, updating proxy URL`)
  }

  // 读取当前配置
  const settings = readClaudeSettings()

  // 备份原配置（如果没有备份）
  if (!hasBackup()) {
    if (!backupSettings(settings)) {
      log.error(`[ClaudeTakeover] Failed to backup, aborting takeover`)
      return false
    }
  }

  // 构建新的 env
  const newEnv: ClaudeEnv = {
    ...settings.env,
    ANTHROPIC_BASE_URL: proxyUrl
  }

  // 替换所有已存在的 Token 字段（避免新增字段导致用户困惑）
  const tokenFields: (keyof ClaudeEnv)[] = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY'
  ]
  let replacedAny = false
  for (const field of tokenFields) {
    if (settings.env && Object.prototype.hasOwnProperty.call(settings.env, field)) {
      newEnv[field] = PROXY_TOKEN_PLACEHOLDER
      replacedAny = true
    }
  }

  // 如果没有任何 Token 字段，插入默认占位符避免 Claude Code 报警告
  if (!replacedAny) {
    newEnv.ANTHROPIC_AUTH_TOKEN = PROXY_TOKEN_PLACEHOLDER
  }

  // 写入新配置
  const newSettings: ClaudeSettings = {
    ...settings,
    env: newEnv
  }

  if (!writeClaudeSettings(newSettings)) {
    log.error(`[ClaudeTakeover] Failed to write settings`)
    return false
  }

  if (!setClaudeOnboardingCompleted()) {
    log.warn('[ClaudeTakeover] Failed to mark onboarding as completed')
  }

  log.info(`[ClaudeTakeover] Takeover successful`)
  return true
}

/**
 * 恢复 Claude Code 配置
 *
 * 恢复策略：
 * 1. 优先使用备份恢复
 * 2. 如果没有备份，清理占位符字段
 *
 * @returns 是否成功
 */
export function restoreClaude(): boolean {
  log.info(`[ClaudeTakeover] Restoring Claude Code settings`)

  // 检查是否被接管
  if (!isProxyTakeover()) {
    log.info(`[ClaudeTakeover] Not taken over, nothing to restore`)
    return true
  }

  // 尝试从备份恢复
  const backup = readBackup()
  if (backup) {
    if (writeClaudeSettings(backup)) {
      removeBackup()
      log.info(`[ClaudeTakeover] Restored from backup`)
      return true
    }
    log.error(`[ClaudeTakeover] Failed to restore from backup`)
    // 继续尝试清理方式
  }

  // 没有备份或恢复失败，尝试清理占位符
  log.info(`[ClaudeTakeover] No backup, cleaning up placeholders`)
  return cleanupTakeover()
}

/**
 * 清理接管占位符
 * 删除 ANTHROPIC_BASE_URL 和占位符 Token
 */
function cleanupTakeover(): boolean {
  const settings = readClaudeSettings()

  if (!settings.env) {
    return true
  }

  const newEnv: ClaudeEnv = { ...settings.env }

  // 删除代理 URL
  delete newEnv.ANTHROPIC_BASE_URL

  // 清理占位符 Token
  const tokenFields: (keyof ClaudeEnv)[] = [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY'
  ]
  for (const field of tokenFields) {
    if (newEnv[field] === PROXY_TOKEN_PLACEHOLDER) {
      delete newEnv[field]
    }
  }

  // 如果 env 为空，删除整个 env 字段
  const newSettings: ClaudeSettings = { ...settings }
  if (Object.keys(newEnv).length === 0) {
    delete newSettings.env
  } else {
    newSettings.env = newEnv
  }

  if (!writeClaudeSettings(newSettings)) {
    log.error(`[ClaudeTakeover] Failed to cleanup`)
    return false
  }

  // 清理备份
  removeBackup()

  log.info(`[ClaudeTakeover] Cleanup successful`)
  return true
}

/**
 * 强制清理（用于异常恢复）
 * 无论当前状态如何，都尝试清理接管痕迹
 */
export function forceCleanup(): boolean {
  log.info(`[ClaudeTakeover] Force cleanup`)

  // 先尝试从备份恢复
  const backup = readBackup()
  if (backup) {
    if (writeClaudeSettings(backup)) {
      removeBackup()
      log.info(`[ClaudeTakeover] Force restored from backup`)
      return true
    }
  }

  // 清理占位符
  return cleanupTakeover()
}
