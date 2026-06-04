import { useEffect } from 'react'
import { useSiteStore } from '@/store/useSiteStore'
import { getElectronAPI } from '@/hooks/useElectronAPI'
import { Header } from '@/components/Header'
import { Toolbar } from '@/components/Toolbar'
import { SiteGrid } from '@/components/SiteGrid/SiteGrid'
import { AddSiteModal } from '@/components/Modal/AddSiteModal'
import { RequestModal } from '@/components/Modal/RequestModal'
import { OAuthModal } from '@/components/Modal/OAuthModal'
import { ToastContainer } from '@/components/Toast/ToastContainer'

const REFRESH_INTERVAL = 5000

export function App() {
  const fetchSites = useSiteStore((state) => state.fetchSites)

  // 初始加载和自动刷新
  useEffect(() => {
    fetchSites()

    const timer = setInterval(fetchSites, REFRESH_INTERVAL)
    return () => clearInterval(timer)
  }, [fetchSites])

  // 监听窗口关闭事件，立即刷新状态
  useEffect(() => {
    const api = getElectronAPI()
    api.onSiteWindowClosed(() => {
      // 窗口关闭时立即刷新站点列表
      fetchSites()
    })
  }, [fetchSites])

  return (
    <div className="app">
      <Header />
      <Toolbar />
      <SiteGrid />
      <AddSiteModal />
      <RequestModal />
      <OAuthModal />
      <ToastContainer />
    </div>
  )
}
