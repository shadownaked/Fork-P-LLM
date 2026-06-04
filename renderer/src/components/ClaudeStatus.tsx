import { useState, useEffect, useCallback } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { useSiteStore } from '@/store/useSiteStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { ClaudeConnectModal } from './ClaudeConnectModal'
import type { ClaudeTakeoverStatus, ConnectTarget, AuthorizedTool } from '@/types'

type ConnectionState = 'disconnected' | 'connecting' | 'testing' | 'connected' | 'error'

/**
 * Claude Code 接管状态组件
 * 显示当前接管状态，提供一键接管/恢复功能
 * 支持 Site/Tool 选择和 API 测试验证
 */
export function ClaudeStatus() {
  const [status, setStatus] = useState<ClaudeTakeoverStatus | null>(null)
  const [isInstalled, setIsInstalled] = useState<boolean | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected')
  const [selectedTarget, setSelectedTarget] = useState<ConnectTarget | null>(null)
  const [showSelectModal, setShowSelectModal] = useState(false)
  const [tools, setTools] = useState<AuthorizedTool[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const showToast = useUIStore((state) => state.showToast)
  const sites = useSiteStore((state) => state.sites)

  // 获取状态
  const fetchStatus = useCallback(async () => {
    try {
      const api = getElectronAPI()
      const [installed, takeoverStatus, savedTarget, authorizedTools] = await Promise.all([
        api.claudeIsInstalled(),
        api.claudeTakeoverStatus(),
        api.claudeGetSelectedTarget(),
        api.getAuthorizedTools()
      ])
      setIsInstalled(installed)
      setStatus(takeoverStatus)
      setSelectedTarget(savedTarget)
      setTools(authorizedTools)

      // 根据 takeover 状态更新 connection state
      if (takeoverStatus.isTakenOver) {
        // 如果已接管但没有 selectedTarget，可能是之前的遗留状态
        if (savedTarget) {
          setConnectionState('connected')
        } else {
          setConnectionState('connected')
        }
      } else {
        setConnectionState('disconnected')
        setErrorMessage(null)
      }
    } catch (err) {
      console.error('Failed to fetch Claude status:', err)
    }
  }, [])

  // 初始化获取状态
  useEffect(() => {
    fetchStatus()
  }, [fetchStatus])

  // 处理 Connect 按钮点击 - 打开选择框
  const handleConnectClick = () => {
    setShowSelectModal(true)
  }

  // 处理选择 Site/Tool
  const handleSelectTarget = async (target: ConnectTarget) => {
    setShowSelectModal(false)
    setSelectedTarget(target)
    setConnectionState('connecting')
    setErrorMessage(null)

    try {
      const api = getElectronAPI()

      // 1. 执行 takeover
      const result = await api.claudeTakeover()
      if (!result.success) {
        throw new Error('Failed to takeover Claude Code')
      }

      // 2. 保存选择的 target
      await api.claudeSetSelectedTarget(target)

      // 3. 开始 API 测试
      setConnectionState('testing')
      showToast(`Testing API with ${target.name}...`, 'info')

      const testResult = await api.claudeTestApi(target.model || 'claude-3-haiku-20240307')

      if (testResult.success) {
        // 测试成功
        setConnectionState('connected')
        showToast(`Connected to ${target.name}! (${testResult.responseTimeMs}ms)`, 'success')
        await fetchStatus()
      } else {
        // 测试失败，自动 restore
        setConnectionState('error')
        setErrorMessage(testResult.error || 'API test failed')
        showToast(`API test failed: ${testResult.error}`, 'error')

        // 自动恢复
        await api.claudeRestore()
        await api.claudeSetSelectedTarget(null)
        setSelectedTarget(null)

        // 延迟后恢复到 disconnected 状态
        setTimeout(() => {
          setConnectionState('disconnected')
          setErrorMessage(null)
        }, 3000)
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      setConnectionState('error')
      setErrorMessage(errorMsg)
      showToast(`Connection failed: ${errorMsg}`, 'error')

      // 尝试恢复
      try {
        const api = getElectronAPI()
        await api.claudeRestore()
        await api.claudeSetSelectedTarget(null)
        setSelectedTarget(null)
      } catch {
        // ignore
      }

      setTimeout(() => {
        setConnectionState('disconnected')
        setErrorMessage(null)
      }, 3000)
    }
  }

  // 恢复 Claude Code
  const handleRestore = async () => {
    setConnectionState('connecting')
    try {
      const api = getElectronAPI()
      const result = await api.claudeRestore()
      if (result.success) {
        await api.claudeSetSelectedTarget(null)
        setSelectedTarget(null)
        showToast('Claude Code restored!', 'success')
        setConnectionState('disconnected')
        await fetchStatus()
      } else {
        showToast('Failed to restore', 'error')
        setConnectionState('connected')
      }
    } catch (err) {
      showToast('Failed to restore Claude Code', 'error')
      setConnectionState('connected')
    }
  }

  // 渲染状态徽章
  const renderStatusBadge = () => {
    switch (connectionState) {
      case 'connecting':
        return <span className="status-badge status-warning">Connecting...</span>
      case 'testing':
        return <span className="status-badge status-warning">Testing API...</span>
      case 'connected':
        return <span className="status-badge status-ready">Connected</span>
      case 'error':
        return <span className="status-badge status-error">Error</span>
      default:
        return <span className="status-badge status-inactive">Disconnected</span>
    }
  }

  // Claude 未安装
  if (isInstalled === false) {
    return (
      <div className="claude-status claude-status-not-installed" title="Claude Code not installed">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
        <span className="claude-status-text">Claude Code</span>
        <span className="status-badge status-inactive">Not Installed</span>
      </div>
    )
  }

  // 加载中
  if (status === null) {
    return (
      <div className="claude-status">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
        <span className="claude-status-text">Claude Code</span>
        <span className="status-badge">Loading...</span>
      </div>
    )
  }

  // 已连接状态
  if (connectionState === 'connected' || connectionState === 'testing') {
    return (
      <>
        <div className="claude-status claude-status-active">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
            <path d="M2 17l10 5 10-5"></path>
            <path d="M2 12l10 5 10-5"></path>
          </svg>
          <span className="claude-status-text">Claude Code</span>
          {selectedTarget && (
            <span className="claude-target-name" title={`Connected to ${selectedTarget.name}`}>
              → {selectedTarget.name}
            </span>
          )}
          {renderStatusBadge()}
          <button
            className="btn btn-ghost btn-sm"
            onClick={handleRestore}
            disabled={connectionState === 'testing'}
            title="Disconnect from proxy"
          >
            Disconnect
          </button>
        </div>
      </>
    )
  }

  // 错误状态
  if (connectionState === 'error') {
    return (
      <div className="claude-status claude-status-error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
        <span className="claude-status-text">Claude Code</span>
        {renderStatusBadge()}
        <span className="claude-error-hint" title={errorMessage || ''}>
          {errorMessage?.slice(0, 30)}...
        </span>
      </div>
    )
  }

  // 连接中状态
  if (connectionState === 'connecting') {
    return (
      <div className="claude-status">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
        <span className="claude-status-text">Claude Code</span>
        {renderStatusBadge()}
      </div>
    )
  }

  // 未连接状态
  return (
    <>
      <div className="claude-status">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
          <path d="M2 17l10 5 10-5"></path>
          <path d="M2 12l10 5 10-5"></path>
        </svg>
        <span className="claude-status-text">Claude Code</span>
        {renderStatusBadge()}
        <button
          className="btn btn-primary btn-sm"
          onClick={handleConnectClick}
          title="Connect Claude Code to this proxy"
        >
          Connect
        </button>
      </div>

      <ClaudeConnectModal
        open={showSelectModal}
        onClose={() => setShowSelectModal(false)}
        onSelect={handleSelectTarget}
        sites={sites}
        tools={tools}
      />
    </>
  )
}
