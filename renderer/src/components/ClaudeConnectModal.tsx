import { useEffect } from 'react'
import type { SiteInfo, AuthorizedTool, ConnectTarget } from '@/types'

interface ClaudeConnectModalProps {
  open: boolean
  onClose: () => void
  onSelect: (target: ConnectTarget) => void
  sites: SiteInfo[]
  tools: AuthorizedTool[]
}

/**
 * Claude Code 连接选择器弹框
 * 允许用户选择要使用的 Site 或 Tool
 */
export function ClaudeConnectModal({
  open,
  onClose,
  onSelect,
  sites,
  tools
}: ClaudeConnectModalProps) {
  // 过滤可用的 Sites (enabled && hasCredentials)
  const availableSites = sites.filter(s => s.enabled && s.hasCredentials)

  // 过滤可用的 Tools (enabled)
  const availableTools = tools.filter(t => t.enabled)

  const hasAvailableOptions = availableSites.length > 0 || availableTools.length > 0

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const handleSelectSite = (site: SiteInfo) => {
    // 选择第一个可用模型用于测试
    const model = site.models?.[0]?.modelName || 'claude-3-haiku-20240307'
    onSelect({
      type: 'site',
      id: site.id,
      name: site.name,
      model
    })
  }

  const handleSelectTool = (tool: AuthorizedTool) => {
    // 选择第一个可用模型用于测试
    const model = tool.models?.[0]?.id || 'claude-3-haiku-20240307'
    onSelect({
      type: 'tool',
      id: tool.provider,
      name: tool.displayName,
      model
    })
  }

  if (!open) return null

  return (
    <div className="modal-overlay show" onClick={handleOverlayClick}>
      <div className="modal claude-connect-modal">
        <div className="modal-header">
          <h2>Select Connection Target</h2>
          <button className="btn-icon modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {!hasAvailableOptions ? (
            <div className="connect-empty-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
              <p>No available Sites or Tools</p>
              <span className="connect-empty-hint">
                Please add a Site and capture credentials, or authorize an OAuth Tool first.
              </span>
            </div>
          ) : (
            <>
              {/* Sites 区域 */}
              {availableSites.length > 0 && (
                <div className="connect-section">
                  <h3 className="connect-section-title">Sites</h3>
                  <div className="connect-list">
                    {availableSites.map(site => (
                      <button
                        key={site.id}
                        className="connect-item"
                        onClick={() => handleSelectSite(site)}
                      >
                        <div className="connect-item-icon">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="2" y1="12" x2="22" y2="12"></line>
                            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
                          </svg>
                        </div>
                        <div className="connect-item-info">
                          <span className="connect-item-name">{site.name}</span>
                          <span className="connect-item-detail">
                            {site.models?.length || 0} models available
                          </span>
                        </div>
                        <span className="connect-item-badge status-ready">Ready</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Tools 区域 */}
              {availableTools.length > 0 && (
                <div className="connect-section">
                  <h3 className="connect-section-title">OAuth Tools</h3>
                  <div className="connect-list">
                    {availableTools.map(tool => (
                      <button
                        key={tool.provider}
                        className="connect-item"
                        onClick={() => handleSelectTool(tool)}
                      >
                        <div className="connect-item-icon">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                            <path d="M2 17l10 5 10-5"></path>
                            <path d="M2 12l10 5 10-5"></path>
                          </svg>
                        </div>
                        <div className="connect-item-info">
                          <span className="connect-item-name">{tool.displayName}</span>
                          <span className="connect-item-detail">
                            {tool.email || `${tool.models.length} models`}
                          </span>
                        </div>
                        <span className="connect-item-badge status-ready">Authorized</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
