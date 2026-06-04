import { useState } from 'react'
import type { AuthorizedTool, OAuthProviderType } from '@/types'
import { useUIStore } from '@/store/useUIStore'
import { copyToClipboard } from '@/utils/format'

const API_PORT = 8080
const TEST_TIMEOUT = 30000

interface ToolCardProps {
  tool: AuthorizedTool
  onLogout: (provider: OAuthProviderType) => void
  onToggleEnabled: (provider: OAuthProviderType) => void
}

export function ToolCard({ tool, onLogout, onToggleEnabled }: ToolCardProps) {
  const [testResult, setTestResult] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error'
    message: string
  }>({ status: 'idle', message: '' })
  const [expandedModels, setExpandedModels] = useState(false)

  const { showToast } = useUIStore()

  // Provider icon based on type
  const getProviderIcon = () => {
    switch (tool.provider) {
      case 'gemini':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        )
      case 'codex':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
          </svg>
        )
      case 'qwen':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10" />
          </svg>
        )
      default:
        return null
    }
  }

  // Copy model ID
  const handleCopyModel = async (modelId: string) => {
    const success = await copyToClipboard(modelId)
    if (success) {
      showToast('Model ID copied!')
    }
  }

  // Test API
  const handleTestApi = async (modelId: string) => {
    setTestResult({ status: 'loading', message: 'Testing...' })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT)

    try {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Hi' }],
          max_tokens: 5
        }),
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (response.ok) {
        setTestResult({ status: 'success', message: 'API working!' })
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

    setTimeout(() => setTestResult({ status: 'idle', message: '' }), 5000)
  }

  // Handle toggle enabled
  const handleToggleEnabled = () => {
    onToggleEnabled(tool.provider)
  }

  // Handle logout
  const handleLogout = () => {
    if (confirm(`Logout from ${tool.displayName}?`)) {
      onLogout(tool.provider)
    }
  }

  // Format expiry time
  const formatExpiry = () => {
    if (!tool.expiresAt) return null
    const now = Date.now()
    const diff = tool.expiresAt - now
    if (diff <= 0) return 'Expired'
    const hours = Math.floor(diff / (1000 * 60 * 60))
    if (hours > 24) return `${Math.floor(hours / 24)}d remaining`
    return `${hours}h remaining`
  }

  const displayedModels = expandedModels ? tool.models : tool.models.slice(0, 3)
  const hasMoreModels = tool.models.length > 3

  // Get status badge
  const getStatusBadge = () => {
    if (!tool.enabled) {
      return <span className="status-badge status-disabled">Disabled</span>
    }
    return <span className="status-badge status-ready">Authorized</span>
  }

  return (
    <div className={`tool-card ${!tool.enabled ? 'tool-card-disabled' : ''}`}>
      <div className="card-header">
        <div className="tool-info">
          <div className="tool-icon">{getProviderIcon()}</div>
          <div className="tool-details">
            <h3 className="tool-name">{tool.displayName}</h3>
            {tool.email && <span className="tool-email">{tool.email}</span>}
          </div>
        </div>
        <div className="header-actions">
          <label className="toggle-switch" title={tool.enabled ? 'Disable tool' : 'Enable tool'}>
            <input
              type="checkbox"
              checked={tool.enabled}
              onChange={handleToggleEnabled}
            />
            <span className="toggle-slider"></span>
          </label>
          {getStatusBadge()}
        </div>
      </div>

      <div className="card-body">
        {/* Model list */}
        <div className="models-section">
          <h4>Available Models ({tool.models.length})</h4>
          <div className="model-list">
            {displayedModels.map((model) => (
              <div key={model.id} className="model-item">
                <div className="model-info">
                  <span className="model-name">{model.name}</span>
                  <span className="model-id">{model.id}</span>
                </div>
                <div className="model-actions">
                  <button
                    className="btn-icon"
                    title="Copy Model ID"
                    onClick={() => handleCopyModel(model.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleTestApi(model.id)}
                    disabled={testResult.status === 'loading'}
                  >
                    Test
                  </button>
                </div>
              </div>
            ))}
          </div>
          {hasMoreModels && (
            <button
              className="btn btn-ghost btn-sm expand-btn"
              onClick={() => setExpandedModels(!expandedModels)}
            >
              {expandedModels ? 'Show less' : `Show ${tool.models.length - 3} more`}
            </button>
          )}
        </div>

        {/* Token info */}
        {formatExpiry() && (
          <div className="token-info">
            <span className="token-expiry">{formatExpiry()}</span>
          </div>
        )}
      </div>

      <div className="card-footer">
        <div className="action-group">
          <button className="btn btn-danger btn-sm" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </div>

      {/* Test result */}
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
