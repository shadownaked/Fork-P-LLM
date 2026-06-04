/**
 * Storage utilities for atomic writes and stable data directory
 *
 * Key features:
 * 1. Uses Electron's app.getPath('userData') for stable data directory
 * 2. Atomic writes via temp file + rename to prevent corruption
 * 3. Automatic migration from legacy data directory
 * 4. Type-safe JSON read/write operations
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { app } from 'electron'

// ============================================================================
// Data Directory Management
// ============================================================================

/**
 * Get the stable user data directory
 * - In packaged app: Uses Electron's userData path (e.g., ~/Library/Application Support/proxyllm)
 * - In development: Uses process.cwd()/data for easier debugging
 */
export function getDataDir(): string {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'data')
  }
  return path.join(process.cwd(), 'data')
}

/**
 * Get the legacy data directory (for migration)
 */
export function getLegacyDataDir(): string {
  return path.join(process.cwd(), 'data')
}

/**
 * Ensure a directory exists, creating it recursively if needed
 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

/**
 * Get the full path for a data file
 */
export function getDataPath(filename: string): string {
  const dataDir = getDataDir()
  ensureDir(dataDir)
  return path.join(dataDir, filename)
}

// ============================================================================
// Atomic Write Operations
// ============================================================================

/**
 * Generate a unique temporary filename
 */
function getTempPath(targetPath: string): string {
  const dir = path.dirname(targetPath)
  const ext = path.extname(targetPath)
  const base = path.basename(targetPath, ext)
  const random = crypto.randomBytes(6).toString('hex')
  return path.join(dir, `${base}.${random}.tmp${ext}`)
}

/**
 * Atomically write data to a file
 *
 * Process:
 * 1. Write to temporary file
 * 2. Sync to disk (fsync)
 * 3. Rename temp file to target (atomic on POSIX)
 *
 * This prevents data corruption from:
 * - Process crashes during write
 * - Power failures
 * - Disk full conditions (fails early at temp file)
 */
export function atomicWriteSync(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath)
  ensureDir(dir)

  const tempPath = getTempPath(filePath)

  try {
    // Write to temp file
    const fd = fs.openSync(tempPath, 'w')
    try {
      if (typeof data === 'string') {
        fs.writeSync(fd, data)
      } else {
        fs.writeSync(fd, data, 0, data.length, 0)
      }
      fs.fsyncSync(fd) // Ensure data is flushed to disk
    } finally {
      fs.closeSync(fd)
    }

    // Atomic rename
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

/**
 * Atomically write JSON data to a file
 */
export function atomicWriteJsonSync<T>(filePath: string, data: T, pretty = true): void {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  atomicWriteSync(filePath, json)
}

/**
 * Async version of atomic write
 */
export async function atomicWrite(filePath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath)
  ensureDir(dir)

  const tempPath = getTempPath(filePath)

  try {
    // Write to temp file
    await fs.promises.writeFile(tempPath, data)

    // Atomic rename
    await fs.promises.rename(tempPath, filePath)
  } catch (error) {
    // Clean up temp file on error
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath)
      }
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

/**
 * Async version of atomic JSON write
 */
export async function atomicWriteJson<T>(filePath: string, data: T, pretty = true): Promise<void> {
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  await atomicWrite(filePath, json)
}

// ============================================================================
// Safe Read Operations
// ============================================================================

/**
 * Result of a safe read operation
 */
export interface ReadResult<T> {
  success: boolean
  data: T | null
  error?: {
    code: string
    message: string
    path: string
  }
}

/**
 * Safely read a JSON file
 * Returns a result object instead of throwing
 */
export function safeReadJsonSync<T>(filePath: string): ReadResult<T> {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        data: null,
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File not found: ${filePath}`,
          path: filePath
        }
      }
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const data = JSON.parse(content) as T

    return {
      success: true,
      data
    }
  } catch (error) {
    const err = error as Error & { code?: string }
    return {
      success: false,
      data: null,
      error: {
        code: err.code || 'READ_ERROR',
        message: err.message,
        path: filePath
      }
    }
  }
}

/**
 * Async version of safe JSON read
 */
export async function safeReadJson<T>(filePath: string): Promise<ReadResult<T>> {
  try {
    const exists = await fs.promises.access(filePath).then(() => true).catch(() => false)
    if (!exists) {
      return {
        success: false,
        data: null,
        error: {
          code: 'FILE_NOT_FOUND',
          message: `File not found: ${filePath}`,
          path: filePath
        }
      }
    }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    const data = JSON.parse(content) as T

    return {
      success: true,
      data
    }
  } catch (error) {
    const err = error as Error & { code?: string }
    return {
      success: false,
      data: null,
      error: {
        code: err.code || 'READ_ERROR',
        message: err.message,
        path: filePath
      }
    }
  }
}

// ============================================================================
// Migration Utilities
// ============================================================================

/**
 * Migrate a file from legacy location to new location
 * Only migrates if source exists and destination doesn't
 */
export function migrateFile(filename: string): boolean {
  const legacyPath = path.join(getLegacyDataDir(), filename)
  const newPath = getDataPath(filename)

  // Skip if already migrated or no legacy file
  if (!fs.existsSync(legacyPath) || fs.existsSync(newPath)) {
    return false
  }

  try {
    // Copy file to new location
    const content = fs.readFileSync(legacyPath)
    atomicWriteSync(newPath, content)

    // Remove legacy file after successful copy
    fs.unlinkSync(legacyPath)

    return true
  } catch {
    return false
  }
}

/**
 * Migrate all data files from legacy location
 */
export function migrateAllDataFiles(): { migrated: string[]; errors: string[] } {
  const migrated: string[] = []
  const errors: string[] = []

  const dataFiles = ['credentials.json', 'sites.json', 'models.json', 'usage.json', 'requests.json']

  for (const filename of dataFiles) {
    try {
      if (migrateFile(filename)) {
        migrated.push(filename)
      }
    } catch (error) {
      errors.push(`${filename}: ${(error as Error).message}`)
    }
  }

  return { migrated, errors }
}

// ============================================================================
// Backup Utilities
// ============================================================================

/**
 * Create a backup of a file before modification
 */
export function createBackup(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(dir, 'backups', `${base}.${timestamp}${ext}`)

  try {
    ensureDir(path.dirname(backupPath))
    fs.copyFileSync(filePath, backupPath)
    return backupPath
  } catch {
    return null
  }
}

/**
 * Clean up old backups, keeping only the most recent N
 */
export function cleanupBackups(filePath: string, keepCount = 5): void {
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  const backupDir = path.join(dir, 'backups')

  if (!fs.existsSync(backupDir)) {
    return
  }

  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(base) && f.endsWith(ext))
      .map(f => ({
        name: f,
        path: path.join(backupDir, f),
        mtime: fs.statSync(path.join(backupDir, f)).mtime.getTime()
      }))
      .sort((a, b) => b.mtime - a.mtime)

    // Remove old backups
    for (const file of files.slice(keepCount)) {
      fs.unlinkSync(file.path)
    }
  } catch {
    // Ignore cleanup errors
  }
}
