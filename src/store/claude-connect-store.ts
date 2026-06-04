/**
 * Claude Connect Store
 *
 * 持久化存储 Claude Code 连接状态
 * - 记录用户选择的 Site/Tool
 * - 下次启动时自动加载
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getDataPath, atomicWriteJsonSync, safeReadJsonSync } from './storage'
import { getMainLogger } from '../logger'

const log = getMainLogger()

const CONNECT_STATE_FILE = 'claude-connect.json'

// 连接目标类型
export interface ConnectTarget {
  type: 'site' | 'tool'
  id: string
  name: string
  model?: string  // 用于 API 测试的模型
}

// 存储的状态
interface ConnectState {
  selectedTarget: ConnectTarget | null
  lastConnectedAt: number | null
}

// 默认状态
const DEFAULT_STATE: ConnectState = {
  selectedTarget: null,
  lastConnectedAt: null
}

class ClaudeConnectStore {
  private state: ConnectState = { ...DEFAULT_STATE }
  private filePath: string

  constructor() {
    this.filePath = getDataPath(CONNECT_STATE_FILE)
    this.load()
  }

  /**
   * 加载状态
   */
  private load(): void {
    const result = safeReadJsonSync<ConnectState>(this.filePath)
    if (result.success && result.data) {
      this.state = result.data
    }
  }

  /**
   * 保存状态
   */
  private save(): void {
    try {
      atomicWriteJsonSync(this.filePath, this.state)
    } catch (error) {
      log.error('[ClaudeConnectStore] Failed to save state:', error)
    }
  }

  /**
   * 获取当前选中的目标
   */
  getSelectedTarget(): ConnectTarget | null {
    return this.state.selectedTarget
  }

  /**
   * 设置选中的目标
   */
  setSelectedTarget(target: ConnectTarget | null): void {
    this.state.selectedTarget = target
    this.state.lastConnectedAt = target ? Date.now() : null
    this.save()
  }

  /**
   * 清除选中状态
   */
  clear(): void {
    this.state = { ...DEFAULT_STATE }
    this.save()
  }

  /**
   * 获取上次连接时间
   */
  getLastConnectedAt(): number | null {
    return this.state.lastConnectedAt
  }
}

// 导出单例
export const claudeConnectStore = new ClaudeConnectStore()
