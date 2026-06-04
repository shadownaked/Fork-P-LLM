import { useUIStore } from '@/store/useUIStore'
import { copyToClipboard } from '@/utils/format'
import { ClaudeStatus } from './ClaudeStatus'

const API_PORT = 8080

export function Header() {
  const showToast = useUIStore((state) => state.showToast)
  const endpoint = `http://localhost:${API_PORT}/v1/chat/completions`

  const handleCopy = async () => {
    const success = await copyToClipboard(endpoint)
    if (success) {
      showToast('API endpoint copied!')
    } else {
      showToast('Failed to copy', 'error')
    }
  }

  return (
    <header className="header">
      <div className="header-left">
        <h1 className="logo">
          <span className="logo-icon">&#9670;</span>
          LLM Proxy
        </h1>
        <span className="version">v1.0</span>
      </div>
      <div className="header-right">
        <ClaudeStatus />
        <div className="api-endpoint" id="apiEndpoint">
          <span className="endpoint-label">API Endpoint</span>
          <code className="endpoint-url">{endpoint}</code>
          <button className="btn-icon" onClick={handleCopy} title="Copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
          </button>
        </div>
      </div>
    </header>
  )
}
