import { useState, useEffect, useRef } from 'react'
import { useUIStore } from '@/store/useUIStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import type { OAuthProviderInfo, OAuthCredentialInfo, OAuthProviderType } from '@/types'

/**
 * OAuth 登录弹窗
 * 只显示未授权的提供商，已授权的在 ToolGrid 中显示
 */
export function OAuthModal() {
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([])
  const [credentials, setCredentials] = useState<OAuthCredentialInfo[]>([])
  const [loading, setLoading] = useState<OAuthProviderType | null>(null)
  const [authState, setAuthState] = useState<{
    provider: OAuthProviderType
    state: string
    userCode?: string
    pollInterval?: number
  } | null>(null)

  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)

  const { oauthModalOpen, closeOAuthModal, showToast, triggerToolsRefresh } = useUIStore()

  // 获取提供商列表和凭据状态
  const fetchData = async () => {
    try {
      const api = getElectronAPI()
      const [provs, creds] = await Promise.all([
        api.oauthGetProviders(),
        api.oauthGetCredentials()
      ])
      setProviders(provs)
      setCredentials(creds)
    } catch (err) {
      console.error('Failed to fetch OAuth data:', err)
    }
  }

  // 打开弹窗时获取数据
  useEffect(() => {
    if (oauthModalOpen) {
      fetchData()
    } else {
      // 关闭时清理状态
      setAuthState(null)
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
        pollTimerRef.current = null
      }
    }
  }, [oauthModalOpen])

  // 清理轮询定时器
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }
    }
  }, [])

  // 开始登录
  const handleLogin = async (provider: OAuthProviderType) => {
    setLoading(provider)
    try {
      const api = getElectronAPI()
      const result = await api.oauthStartAuth(provider)

      if (result.flowType === 'device_code') {
        // Device Flow: 显示用户码并开始轮询
        setAuthState({
          provider,
          state: result.state,
          userCode: result.userCode,
          pollInterval: result.pollInterval
        })

        // 使用系统默认浏览器打开授权页面（而不是 Electron 内置浏览器）
        await api.openExternal(result.authUrl)

        // 开始轮询
        startPolling(result.state, result.pollInterval || 5000)
      } else {
        // Authorization Code / PKCE: 打开浏览器
        setAuthState({
          provider,
          state: result.state
        })

        // 使用系统默认浏览器打开授权页面（而不是 Electron 内置浏览器）
        await api.openExternal(result.authUrl)

        // 开始轮询状态
        startPolling(result.state, 2000)
      }
    } catch (err) {
      showToast(`Failed to start ${provider} login`, 'error')
      setLoading(null)
    }
  }

  // 轮询认证状态
  const startPolling = (state: string, interval: number) => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
    }

    const poll = async () => {
      try {
        const api = getElectronAPI()
        const status = await api.oauthPoll(state)

        if (status.status === 'completed') {
          // 认证成功
          clearInterval(pollTimerRef.current!)
          pollTimerRef.current = null
          setAuthState(null)
          setLoading(null)
          showToast(`Logged in to ${status.provider}${status.email ? ` as ${status.email}` : ''}`, 'success')
          // 触发 ToolGrid 刷新
          triggerToolsRefresh()
          // 关闭弹窗
          closeOAuthModal()
        } else if (status.status === 'error') {
          // 认证失败
          clearInterval(pollTimerRef.current!)
          pollTimerRef.current = null
          setAuthState(null)
          setLoading(null)
          showToast(status.error || 'Authentication failed', 'error')
        } else if (status.status === 'slow_down') {
          // 需要减慢轮询
          clearInterval(pollTimerRef.current!)
          pollTimerRef.current = setInterval(poll, interval * 2)
        }
        // pending/polling 状态继续轮询
      } catch (err) {
        console.error('Poll error:', err)
      }
    }

    pollTimerRef.current = setInterval(poll, interval)
  }

  // 取消登录
  const handleCancelAuth = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    setAuthState(null)
    setLoading(null)
  }

  // 获取凭据信息
  const getCredential = (provider: OAuthProviderType): OAuthCredentialInfo | undefined => {
    return credentials.find(c => c.provider === provider)
  }

  // 过滤未授权的提供商
  const unauthorizedProviders = providers.filter(p => {
    const cred = getCredential(p.name)
    return !cred?.hasCredential
  })

  if (!oauthModalOpen) return null

  return (
    <div className="modal-overlay show" onClick={closeOAuthModal}>
      <div className="modal oauth-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Tool Authorization</h2>
          <button className="modal-close" onClick={closeOAuthModal}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {authState ? (
            // 正在认证中
            <div className="oauth-auth-pending">
              <div className="oauth-auth-icon">
                {getProviderLogo(authState.provider)}
              </div>
              <h3>Authenticating with {getProviderDisplayName(authState.provider)}</h3>

              {authState.userCode ? (
                // Device Flow: 显示用户码
                <div className="oauth-device-code">
                  <p>Enter this code on the authorization page:</p>
                  <code className="oauth-user-code">{authState.userCode}</code>
                  <p className="oauth-hint">A browser window should have opened. If not, copy the code and visit the authorization URL.</p>
                </div>
              ) : (
                // Authorization Code: 等待回调
                <div className="oauth-waiting">
                  <div className="oauth-spinner"></div>
                  <p>Complete the authorization in your browser...</p>
                </div>
              )}

              <button className="btn btn-ghost" onClick={handleCancelAuth}>
                Cancel
              </button>
            </div>
          ) : unauthorizedProviders.length === 0 ? (
            // 所有提供商都已授权
            <div className="oauth-all-authorized">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                <polyline points="22 4 12 14.01 9 11.01"></polyline>
              </svg>
              <h3>All Tools Authorized</h3>
              <p>You have authorized all available CLI tools. Check the Authorized Tools section to manage them.</p>
              <button className="btn btn-primary" onClick={closeOAuthModal}>
                Done
              </button>
            </div>
          ) : (
            // 未授权的提供商列表
            <div className="oauth-providers">
              <p className="oauth-description">
                Login to CLI tools to use their APIs through this proxy. Already authorized tools are shown in the main view.
              </p>

              {unauthorizedProviders.map((provider) => {
                const isLoading = loading === provider.name

                return (
                  <div key={provider.name} className="oauth-provider-card">
                    <div className="oauth-provider-info">
                      <div className="oauth-provider-logo">
                        {getProviderLogo(provider.name)}
                      </div>
                      <div className="oauth-provider-details">
                        <h3>{provider.displayName}</h3>
                        <span className="oauth-flow-type">{getFlowTypeLabel(provider.flowType)}</span>
                      </div>
                    </div>

                    <div className="oauth-provider-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleLogin(provider.name)}
                        disabled={isLoading}
                      >
                        {isLoading ? 'Connecting...' : 'Authorize'}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// 获取提供商显示名称
function getProviderDisplayName(provider: OAuthProviderType): string {
  switch (provider) {
    case 'gemini':
      return 'Gemini CLI'
    case 'codex':
      return 'OpenAI Codex'
    case 'qwen':
      return 'Qwen Code'
    default:
      return provider
  }
}

// 获取流程类型标签
function getFlowTypeLabel(flowType: string): string {
  switch (flowType) {
    case 'authorization_code':
      return 'OAuth 2.0'
    case 'pkce':
      return 'OAuth 2.0 + PKCE'
    case 'device_code':
      return 'Device Flow'
    default:
      return flowType
  }
}

// 获取提供商 Logo
function getProviderLogo(provider: OAuthProviderType) {
  switch (provider) {
    case 'gemini':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      )
    case 'codex':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none"/>
          <path d="M12 6v12M6 12h12" stroke="currentColor" strokeWidth="2"/>
        </svg>
      )
    case 'qwen':
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" fill="none"/>
          <text x="12" y="16" textAnchor="middle" fontSize="10" fill="currentColor">Q</text>
        </svg>
      )
    default:
      return null
  }
}
