import { useEffect, useState, useCallback } from 'react'
import type { AuthorizedTool, OAuthProviderType } from '@/types'
import { ToolCard } from './ToolCard'
import { useUIStore } from '@/store/useUIStore'

export function ToolGrid() {
  const [tools, setTools] = useState<AuthorizedTool[]>([])
  const [loading, setLoading] = useState(true)
  const { showToast, toolsRefreshTrigger } = useUIStore()

  const fetchTools = useCallback(async () => {
    try {
      const authorizedTools = await window.electronAPI?.getAuthorizedTools()
      setTools(authorizedTools || [])
    } catch (err) {
      console.error('Failed to fetch authorized tools:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTools()
    // Refresh every 30 seconds to update token status
    const interval = setInterval(fetchTools, 30000)
    return () => clearInterval(interval)
  }, [fetchTools])

  // Refresh when toolsRefreshTrigger changes (e.g., after OAuth login)
  useEffect(() => {
    if (toolsRefreshTrigger > 0) {
      fetchTools()
    }
  }, [toolsRefreshTrigger, fetchTools])

  const handleLogout = async (provider: OAuthProviderType) => {
    try {
      const result = await window.electronAPI?.oauthLogout(provider)
      if (result?.success) {
        showToast(`Logged out from ${provider}`)
        fetchTools()
      } else {
        showToast('Logout failed', 'error')
      }
    } catch (err) {
      console.error('Logout error:', err)
      showToast('Logout failed', 'error')
    }
  }

  const handleToggleEnabled = async (provider: OAuthProviderType) => {
    try {
      const result = await window.electronAPI?.toggleToolEnabled(provider)
      if (result?.success) {
        showToast(result.enabled ? `${provider} enabled` : `${provider} disabled`)
        fetchTools()
      } else {
        showToast('Failed to toggle tool', 'error')
      }
    } catch (err) {
      console.error('Toggle enabled error:', err)
      showToast('Failed to toggle tool', 'error')
    }
  }

  if (loading) {
    return null
  }

  if (tools.length === 0) {
    return null
  }

  return (
    <div className="tool-grid-section">
      <div className="tool-grid">
        {tools.map((tool) => (
          <ToolCard
            key={tool.provider}
            tool={tool}
            onLogout={handleLogout}
            onToggleEnabled={handleToggleEnabled}
          />
        ))}
      </div>
    </div>
  )
}
