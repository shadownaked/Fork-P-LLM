/**
 * Claude Code Settings Manager
 *
 * 管理 Claude Code 的配置文件，支持：
 * - 路径解析（兼容旧版配置文件名）
 * - 安全读写（只修改 env 字段，不破坏其他配置）
 * - 原子写入（避免写入中断导致配置损坏）
 *
 * 配置文件位置：
 * - 主配置：~/.claude/settings.json（兼容 ~/.claude/claude.json）
 * - MCP 配置：~/.claude.json
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Lazy logger to avoid Electron dependency in non-Electron environments
type LogFn = (...args: unknown[]) => void
interface Logger {
  info: LogFn
  warn: LogFn
  error: LogFn
  debug: LogFn
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
        error: () => {},
        debug: () => {}
      }
    }
  }
  return _log!
}

// Proxy object to lazily access logger
const log = {
  info: (msg: string, ...args: unknown[]) => getLog().info(`[ClaudeSettings] ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => getLog().debug(`[ClaudeSettings] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => getLog().warn(`[ClaudeSettings] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => getLog().error(`[ClaudeSettings] ${msg}`, ...args)
}

// Claude Code 配置文件中的 env 字段类型
export interface ClaudeEnv {
  ANTHROPIC_BASE_URL?: string
  ANTHROPIC_AUTH_TOKEN?: string
  ANTHROPIC_API_KEY?: string
  OPENROUTER_API_KEY?: string
  OPENAI_API_KEY?: string
  [key: string]: string | undefined
}

// Claude Code settings.json 结构（只关心 env 字段，其他字段透传）
export interface ClaudeSettings {
  env?: ClaudeEnv
  [key: string]: unknown
}

// Claude Code MCP 配置结构（~/.claude.json）
export interface ClaudeMcpConfig {
  hasCompletedOnboarding?: boolean
  [key: string]: unknown
}

// 占位符 Token（用于接管时替换真实 Token）
export const PROXY_TOKEN_PLACEHOLDER = '__PROXYLLM_TOKEN__'

/**
 * 获取 Claude 配置目录路径
 * 默认：~/.claude
 */
export function getClaudeConfigDir(): string {
  return path.join(os.homedir(), '.claude')
}

/**
 * 获取 Claude settings.json 路径
 * 优先使用 settings.json，兼容旧版 claude.json
 */
export function getClaudeSettingsPath(): string {
  const configDir = getClaudeConfigDir()
  const settingsPath = path.join(configDir, 'settings.json')
  const legacyPath = path.join(configDir, 'claude.json')

  // 优先使用 settings.json
  if (fs.existsSync(settingsPath)) {
    return settingsPath
  }

  // 兼容旧版 claude.json
  if (fs.existsSync(legacyPath)) {
    return legacyPath
  }

  // 默认返回 settings.json（即使不存在）
  return settingsPath
}

/**
 * 获取 Claude MCP 配置路径
 * 位置：~/.claude.json（与 .claude 目录同级）
 */
export function getClaudeMcpPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

/**
 * 写入 Claude MCP 配置
 * 使用原子写入：先写临时文件，再重命名
 */
function writeClaudeMcpConfig(config: ClaudeMcpConfig): boolean {
  const mcpPath = getClaudeMcpPath()
  const tempPath = `${mcpPath}.tmp`

  try {
    const content = JSON.stringify(config, null, 2)
    fs.writeFileSync(tempPath, content, 'utf-8')
    fs.renameSync(tempPath, mcpPath)
    log.info(`[ClaudeSettings] MCP config written to: ${mcpPath}`)
    return true
  } catch (error) {
    const err = error as Error
    log.error(`[ClaudeSettings] Failed to write MCP config: ${err.message}`)
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
    } catch {
      // 忽略清理错误
    }
    return false
  }
}

/**
 * 跳过 Claude Code 初次安装确认
 * 在 ~/.claude.json 根对象写入 hasCompletedOnboarding=true
 */
export function setClaudeOnboardingCompleted(): boolean {
  const mcpPath = getClaudeMcpPath()
  let root: ClaudeMcpConfig = {}

  try {
    if (fs.existsSync(mcpPath)) {
      const content = fs.readFileSync(mcpPath, 'utf-8')
      const parsed = JSON.parse(content)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log.error(`[ClaudeSettings] MCP config root must be an object: ${mcpPath}`)
        return false
      }
      root = parsed as ClaudeMcpConfig
    }
  } catch (error) {
    const err = error as Error
    log.error(`[ClaudeSettings] Failed to read MCP config: ${err.message}`)
    return false
  }

  if (root.hasCompletedOnboarding === true) {
    return true
  }

  root.hasCompletedOnboarding = true
  return writeClaudeMcpConfig(root)
}

/**
 * 读取 Claude settings
 * 如果文件不存在或解析失败，返回空对象
 */
export function readClaudeSettings(): ClaudeSettings {
  const settingsPath = getClaudeSettingsPath()

  try {
    if (!fs.existsSync(settingsPath)) {
      log.info(`[ClaudeSettings] Settings file not found: ${settingsPath}`)
      return {}
    }

    const content = fs.readFileSync(settingsPath, 'utf-8')
    const settings = JSON.parse(content) as ClaudeSettings
    log.debug(`[ClaudeSettings] Read settings from: ${settingsPath}`)
    return settings
  } catch (error) {
    const err = error as Error
    log.error(`[ClaudeSettings] Failed to read settings: ${err.message}`)
    return {}
  }
}

/**
 * 写入 Claude settings
 * 使用原子写入：先写临时文件，再重命名
 */
export function writeClaudeSettings(settings: ClaudeSettings): boolean {
  const settingsPath = getClaudeSettingsPath()
  const configDir = getClaudeConfigDir()
  const tempPath = `${settingsPath}.tmp`

  try {
    // 确保配置目录存在
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
      log.info(`[ClaudeSettings] Created config directory: ${configDir}`)
    }

    // 原子写入：先写临时文件
    const content = JSON.stringify(settings, null, 2)
    fs.writeFileSync(tempPath, content, 'utf-8')

    // 重命名（原子操作）
    fs.renameSync(tempPath, settingsPath)
    log.info(`[ClaudeSettings] Settings written to: ${settingsPath}`)
    return true
  } catch (error) {
    const err = error as Error
    log.error(`[ClaudeSettings] Failed to write settings: ${err.message}`)

    // 清理临时文件
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
    } catch {
      // 忽略清理错误
    }

    return false
  }
}

/**
 * 更新 Claude settings 的 env 字段
 * 只修改 env，保留其他字段
 */
export function updateClaudeEnv(envUpdates: Partial<ClaudeEnv>): boolean {
  const settings = readClaudeSettings()

  // 合并 env 字段
  settings.env = {
    ...settings.env,
    ...envUpdates
  }

  return writeClaudeSettings(settings)
}

/**
 * 检查当前是否被代理接管
 * 通过检测 env 中是否存在占位符 Token 来判断
 */
export function isProxyTakeover(): boolean {
  const settings = readClaudeSettings()
  const env = settings.env || {}

  // 检查所有可能的 Token 字段
  const tokenFields = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY']
  for (const field of tokenFields) {
    if (env[field] === PROXY_TOKEN_PLACEHOLDER) {
      return true
    }
  }

  return false
}

/**
 * 获取当前代理 URL（如果已接管）
 */
export function getCurrentProxyUrl(): string | null {
  const settings = readClaudeSettings()
  return settings.env?.ANTHROPIC_BASE_URL || null
}

/**
 * 检查 Claude 配置目录是否存在
 * 用于判断用户是否安装了 Claude Code
 */
export function isClaudeInstalled(): boolean {
  const configDir = getClaudeConfigDir()
  return fs.existsSync(configDir)
}
