import * as fs from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// Configuration for log rotation
const LOG_CONFIG = {
  maxArchiveSessions: 5,    // Keep last 5 archived sessions
  maxLogSizeBytes: 100 * 1024 * 1024,  // 100MB per file
}

// Directory names
const CURRENT_DIR = 'current'
const ARCHIVE_DIR = 'archive'

// Get logs directory path
function getLogsDir(): string {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(process.cwd(), 'logs')
}

/**
 * Rotate logs directory on startup
 * Move current/ to archive/{timestamp}/, then clean old archives
 */
export function rotateLogsDir(): void {
  const logsDir = getLogsDir()
  const currentDir = path.join(logsDir, CURRENT_DIR)
  const archiveDir = path.join(logsDir, ARCHIVE_DIR)

  // Ensure directories exist
  fs.mkdirSync(archiveDir, { recursive: true })

  try {
    // If current/ exists and has content, move it to archive/
    if (fs.existsSync(currentDir)) {
      const entries = fs.readdirSync(currentDir)
      if (entries.length > 0) {
        // Create timestamp-based archive name
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const archiveName = `session-${timestamp}`
        const archivePath = path.join(archiveDir, archiveName)

        fs.renameSync(currentDir, archivePath)
      } else {
        // Empty directory, just remove it
        fs.rmSync(currentDir, { recursive: true, force: true })
      }
    }

    // Clean old archives beyond the limit
    const entries = fs.readdirSync(archiveDir, { withFileTypes: true })
    const sessionDirs = entries
      .filter(e => e.isDirectory() && /^session-/.test(e.name))
      .map(e => ({
        name: e.name,
        path: path.join(archiveDir, e.name),
        mtime: fs.statSync(path.join(archiveDir, e.name)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime) // Newest first

    // Remove old sessions beyond the limit
    const toRemove = sessionDirs.slice(LOG_CONFIG.maxArchiveSessions)
    for (const dir of toRemove) {
      fs.rmSync(dir.path, { recursive: true, force: true })
    }
  } catch {
    // If rotation fails, just continue - logging shouldn't break the app
  }

  // Create fresh current/ directory
  fs.mkdirSync(currentDir, { recursive: true })
}

/**
 * @deprecated Use rotateLogsDir() instead
 * Kept for backward compatibility
 */
export function clearLogsDir(): void {
  rotateLogsDir()
}

/**
 * Sensitive data patterns to redact from logs
 * These patterns match common auth tokens, API keys, and credentials
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // JWT tokens (Bearer token format)
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Authorization header values
  /(?<=Authorization[:\s]*)[^\s,;'"}\]]+/gi,
  // API keys in various formats
  /(?<=api[_-]?key[=:\s]*)[^\s&"']+/gi,
  /(?<=x-api-key[:\s]*)[^\s,;'"}\]]+/gi,
  // Session tokens
  /(?<=session[_-]?id[=:\s]*)[^\s&"']+/gi,
  // Token values (but not [TokenRefresh] or similar log prefixes)
  /(?<=token[=:]\s*)[^\s&"'\]]+/gi,
  // Cookie values (redact entire cookie)
  /(?<=Cookie[:\s]*)[^\n]+/gi,
]

/**
 * Redact sensitive information from log messages
 * Replaces matches with [REDACTED] to prevent credential leakage
 */
function redactSensitive(message: string): string {
  let result = message

  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0
    result = result.replace(pattern, '[REDACTED]')
  }

  return result
}

class Logger {
  private logFile: string
  private stream: fs.WriteStream | null = null
  private name: string
  private bytesWritten: number = 0

  constructor(name: string, filename: string, subDir?: string) {
    this.name = name
    const logsDir = getLogsDir()

    // All logs go to logs/current/
    const baseDir = path.join(logsDir, CURRENT_DIR)
    const targetDir = subDir ? path.join(baseDir, subDir) : baseDir

    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true })
    }

    this.logFile = path.join(targetDir, filename)
    this.initStream()
  }

  private initStream(): void {
    this.stream = fs.createWriteStream(this.logFile, { flags: 'a' })
    this.stream.on('error', (err) => {
      console.error(`[Logger] Failed to write to ${this.logFile}:`, err)
    })
  }

  private formatMessage(level: LogLevel, message: string, ...args: unknown[]): string {
    const timestamp = new Date().toISOString()
    const argsStr = args.length > 0
      ? ` ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
      : ''
    return `[${timestamp}] [${level.toUpperCase()}] [${this.name}] ${message}${argsStr}\n`
  }

  private write(level: LogLevel, message: string, ...args: unknown[]): void {
    // Redact sensitive information before logging
    const safeMessage = redactSensitive(message)
    const safeArgs = args.map(a => {
      if (typeof a === 'string') {
        return redactSensitive(a)
      } else if (typeof a === 'object' && a !== null) {
        return redactSensitive(JSON.stringify(a))
      }
      return a
    })

    const formatted = this.formatMessage(level, safeMessage, ...safeArgs)

    // Write to file (with error handling)
    if (this.stream && !this.stream.destroyed) {
      try {
        this.stream.write(formatted)
        this.bytesWritten += Buffer.byteLength(formatted)

        // Check if we need to rotate (file too large)
        if (this.bytesWritten > LOG_CONFIG.maxLogSizeBytes) {
          this.rotateLogFile()
        }
      } catch {
        // Ignore write errors during shutdown
      }
    }

    // Also output to console (with error handling for EPIPE)
    try {
      const consoleMethod = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : console.log
      consoleMethod(formatted.trim())
    } catch {
      // Ignore console errors during shutdown (EPIPE)
    }
  }

  /**
   * Rotate log file when it gets too large
   */
  private rotateLogFile(): void {
    try {
      // Close current stream
      if (this.stream) {
        this.stream.end()
      }

      // Rename current file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const ext = path.extname(this.logFile)
      const base = this.logFile.slice(0, -ext.length)
      const rotatedPath = `${base}.${timestamp}${ext}`

      if (fs.existsSync(this.logFile)) {
        fs.renameSync(this.logFile, rotatedPath)
      }

      // Reset counter and create new stream
      this.bytesWritten = 0
      this.initStream()
    } catch {
      // If rotation fails, just continue with current file
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, ...args)
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, ...args)
  }

  log(message: string, ...args: unknown[]): void {
    this.info(message, ...args)
  }

  close(): void {
    if (this.stream) {
      this.stream.end()
      this.stream = null
    }
  }
}

// Singleton loggers
let mainLogger: Logger | null = null
let renderLogger: Logger | null = null
let proxyLogger: Logger | null = null
const siteLoggers: Map<string, Logger> = new Map()

export function getMainLogger(): Logger {
  if (!mainLogger) {
    mainLogger = new Logger('Main', 'main.log')
  }
  return mainLogger
}

export function getRenderLogger(): Logger {
  if (!renderLogger) {
    renderLogger = new Logger('Render', 'render.log')
  }
  return renderLogger
}

export function getProxyLogger(): Logger {
  if (!proxyLogger) {
    proxyLogger = new Logger('Proxy', 'proxy.log')
  }
  return proxyLogger
}

// Get or create a network logger for a specific site
// Logs to: logs/current/web/{siteId}/network.log
export function getSiteNetworkLogger(siteId: string): Logger {
  const key = `network:${siteId}`
  if (!siteLoggers.has(key)) {
    const subDir = `web/${siteId}`
    siteLoggers.set(key, new Logger(`Network:${siteId}`, 'network.log', subDir))
  }
  return siteLoggers.get(key)!
}

// Get or create a proxy logger for a specific site
// Logs to: logs/current/web/{siteId}/proxy.log
export function getSiteProxyLogger(siteId: string): Logger {
  const key = `proxy:${siteId}`
  if (!siteLoggers.has(key)) {
    const subDir = `web/${siteId}`
    siteLoggers.set(key, new Logger(`Proxy:${siteId}`, 'proxy.log', subDir))
  }
  return siteLoggers.get(key)!
}

// Close all site loggers (call on app quit)
export function closeSiteLoggers(): void {
  for (const logger of siteLoggers.values()) {
    logger.close()
  }
  siteLoggers.clear()
}

export function createLogger(name: string, filename: string, subDir?: string): Logger {
  return new Logger(name, filename, subDir)
}

// Write renderer console log to file
export function logRendererMessage(level: string, message: string): void {
  const logger = getRenderLogger()
  switch (level) {
    case 'error':
      logger.error(message)
      break
    case 'warning':
      logger.warn(message)
      break
    case 'debug':
      logger.debug(message)
      break
    default:
      logger.info(message)
  }
}
