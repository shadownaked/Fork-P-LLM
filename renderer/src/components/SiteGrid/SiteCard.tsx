import { useState } from 'react'
import type { SiteInfo } from '@/types'
import { useSiteStore } from '@/store/useSiteStore'
import { useUIStore } from '@/store/useUIStore'
import { formatTime, copyToClipboard } from '@/utils/format'
import { getElectronAPI } from '@/hooks/useElectronAPI'

const API_PORT = 8080
const TEST_TIMEOUT = 30000

interface SiteCardProps {
  site: SiteInfo
}

export function SiteCard({ site }: SiteCardProps) {
  const [testResult, setTestResult] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error'
    message: string
  }>({ status: 'idle', message: '' })

  const { openSite, removeSite, refreshCredentials, clearCredentials, fetchSites, toggleSiteEnabled } = useSiteStore()
  const { showToast, openRequestModal } = useUIStore()

  // 状态徽章
  const getStatusBadge = () => {
    if (!site.enabled) {
      return <span className="status-badge status-disabled">Disabled</span>
    }
    if (site.isWindowOpen) {
      return <span className="status-badge status-active">Window Open</span>
    }
    // Check last request status - show error if last request failed
    if (site.lastRequestStatus?.statusCode && site.lastRequestStatus.statusCode >= 400) {
      return <span className="status-badge status-error">Error {site.lastRequestStatus.statusCode}</span>
    }
    // Ready 需要同时有凭据和可用模型
    if (site.hasCredentials && site.models && site.models.length > 0) {
      return <span className="status-badge status-ready">Ready</span>
    }
    if (site.hasCredentials) {
      return <span className="status-badge status-warning">No Models</span>
    }
    return <span className="status-badge status-inactive">No Credentials</span>
  }

  // 切换启用状态
  const handleToggleEnabled = async () => {
    const success = await toggleSiteEnabled(site.id)
    if (success) {
      showToast(site.enabled ? 'Site disabled' : 'Site enabled')
    } else {
      showToast('Failed to toggle site', 'error')
    }
  }

  // 打开站点
  const handleOpen = async () => {
    const success = await openSite(site.id)
    if (!success) {
      showToast('Failed to open site', 'error')
    }
  }

  // 刷新凭据
  const handleRefresh = async () => {
    const success = await refreshCredentials(site.id)
    if (success) {
      showToast('Credentials refreshed')
    } else {
      showToast('Failed to refresh', 'error')
    }
  }

  // 清除凭据
  const handleClear = async () => {
    const success = await clearCredentials(site.id)
    if (success) {
      showToast('Credentials cleared')
    } else {
      showToast('Failed to clear', 'error')
    }
  }

  // 删除站点
  const handleDelete = async () => {
    if (!confirm(`Delete "${site.name}"? This cannot be undone.`)) return

    const success = await removeSite(site.id)
    if (success) {
      showToast(`${site.name} deleted`)
    } else {
      showToast('Failed to delete', 'error')
    }
  }

  // 查看请求
  const handleShowRequests = () => {
    openRequestModal(site.id, site.name)
  }

  // 复制 Model Name (用于 API 调用)
  const handleCopyModel = async (modelName: string) => {
    const success = await copyToClipboard(modelName)
    if (success) {
      showToast('Model name copied!')
    }
  }

  // 测试 API (使用 modelName 而非 modelId)
  const handleTestApi = async (modelName: string) => {
    setTestResult({ status: 'loading', message: 'Testing...' })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT)

    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,  // 使用 modelName 而非 modelId
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        setTestResult({ status: 'success', message: 'API working!' })
        // Clear any previous error status for this site
        await getElectronAPI().clearSiteErrorStatus(site.id)
        // 刷新站点列表以获取最新状态
        fetchSites()
      } else {
        const error = await response.text()
        setTestResult({
          status: 'error',
          message: `Error ${response.status}: ${error.substring(0, 100)}`
        })
      }
    } catch (err) {
      clearTimeout(timeoutId)
      const message = err instanceof Error && err.name === 'AbortError'
        ? 'Request timeout'
        : 'Connection failed'
      setTestResult({ status: 'error', message })
    }

    // 5秒后清除结果
    setTimeout(() => setTestResult({ status: 'idle', message: '' }), 5000)
  }

  return (
    <div className={`site-card ${!site.enabled ? 'site-card-disabled' : ''}`}>
      <div className="card-header">
        <div className="site-info">
          <h3 className="site-name">{site.name}</h3>
          <span className="site-url">{site.targetUrl}</span>
        </div>
        <div className="header-actions">
          <label className="toggle-switch" title={site.enabled ? 'Disable site' : 'Enable site'}>
            <input
              type="checkbox"
              checked={site.enabled}
              onChange={handleToggleEnabled}
            />
            <span className="toggle-slider"></span>
          </label>
          {getStatusBadge()}
        </div>
      </div>

      <div className="card-body">
        {/* 模型列表 */}
        <div className="models-section">
          <h4>Available Models</h4>
          {site.models && site.models.length > 0 ? (
            <div className="model-list">
              {site.models.map((model) => (
                <div key={model.modelId} className="model-item">
                  <span className="model-name">{model.displayName || model.modelName}</span>
                  <div className="model-actions">
                    <button
                      className="btn-icon"
                      title="Copy Model Name"
                      onClick={() => handleCopyModel(model.modelName)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleTestApi(model.modelName)}
                      disabled={testResult.status === 'loading'}
                    >
                      Test
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="no-models">No models available. Capture credentials first.</p>
          )}
        </div>

        {/* 凭据信息 */}
        <div className="credentials-info">
          <span className="credentials-label">Credentials:</span>
          <span className="credentials-time">
            {site.hasCredentials ? `Captured ${formatTime(site.capturedAt)}` : 'Not captured'}
          </span>
        </div>
      </div>

      <div className="card-footer">
        <div className="action-group">
          <button className="btn btn-secondary" onClick={handleOpen}>
            {site.isWindowOpen ? 'Focus' : 'Open'}
          </button>
          <button className="btn btn-ghost" onClick={handleShowRequests}>
            Requests
          </button>
        </div>
        <div className="action-group">
          <button className="btn btn-ghost" onClick={handleRefresh} disabled={!site.hasCredentials}>
            Refresh
          </button>
          <button className="btn btn-ghost" onClick={handleClear} disabled={!site.hasCredentials}>
            Clear
          </button>
          <button className="btn btn-danger btn-icon" onClick={handleDelete} title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
          </button>
        </div>
      </div>

      {/* 测试结果 */}
      {testResult.status !== 'idle' && (
        <div className={`test-result test-${testResult.status}`}>
          {testResult.status === 'loading' && (
            <span className="spinner"></span>
          )}
          <span>{testResult.message}</span>
        </div>
      )}
    </div>
  )
}
