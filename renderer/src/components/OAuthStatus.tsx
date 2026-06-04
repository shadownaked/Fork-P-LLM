import { useState, useEffect } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import type { OAuthCredentialInfo } from '@/types'

/**
 * OAuth 登录状态组件
 * 显示添加工具授权按钮，已授权的工具在 ToolGrid 中显示
 */
export function OAuthStatus() {
  const [credentials, setCredentials] = useState<OAuthCredentialInfo[]>([])
  const [loading, setLoading] = useState(false)
  const openOAuthModal = useUIStore((state) => state.openOAuthModal)

  const handleClick = () => {
    openOAuthModal()
  }

  // 初始化获取状态
  useEffect(() => {
    const fetchCredentials = async () => {
      try {
        setLoading(true)
        const api = getElectronAPI()
        const creds = await api.oauthGetCredentials()
        setCredentials(creds)
      } catch (err) {
        console.error('Failed to fetch OAuth credentials:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchCredentials()
    // Refresh every 30 seconds
    const interval = setInterval(fetchCredentials, 30000)
    return () => clearInterval(interval)
  }, [])

  // 已登录的账号数量
  const loggedInCount = credentials.filter(c => c.hasCredential).length
  // 未登录的提供商数量
  const notLoggedInCount = credentials.filter(c => !c.hasCredential).length

  return (
    <div className="oauth-status">
      <button
        className={`oauth-status-btn ${loggedInCount > 0 ? 'oauth-status-active' : ''}`}
        onClick={handleClick}
        disabled={loading}
        title={notLoggedInCount > 0 ? `Add Tool Auth (${notLoggedInCount} available)` : 'All tools authorized'}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="16"></line>
          <line x1="8" y1="12" x2="16" y2="12"></line>
        </svg>
        <span className="oauth-status-text">Add Tool</span>
        {notLoggedInCount > 0 && (
          <span className="oauth-status-badge">{notLoggedInCount}</span>
        )}
      </button>
    </div>
  )
}
