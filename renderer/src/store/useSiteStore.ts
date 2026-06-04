import { create } from 'zustand'
import type { SiteInfo, SiteConfig } from '@/types'

interface SiteStore {
  // 状态
  sites: SiteInfo[]
  loading: boolean
  error: string | null

  // 操作
  setSites: (sites: SiteInfo[]) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void

  // API 操作
  fetchSites: () => Promise<void>
  addSite: (site: SiteConfig) => Promise<boolean>
  removeSite: (id: string) => Promise<boolean>
  openSite: (siteId: string) => Promise<boolean>
  closeSite: (siteId: string) => Promise<boolean>
  refreshCredentials: (siteId: string) => Promise<boolean>
  clearCredentials: (siteId: string) => Promise<boolean>
  toggleSiteEnabled: (siteId: string) => Promise<boolean>
}

const getApi = () => window.electronAPI

export const useSiteStore = create<SiteStore>((set, get) => ({
  // 初始状态
  sites: [],
  loading: false,
  error: null,

  // 基础 setter
  setSites: (sites) => set({ sites }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  // 获取所有站点
  fetchSites: async () => {
    const api = getApi()
    if (!api) return

    set({ loading: true, error: null })
    try {
      const sites = await api.getAllSites()
      set({ sites, loading: false })
    } catch (err) {
      set({ error: 'Failed to load sites', loading: false })
    }
  },

  // 添加站点
  addSite: async (site) => {
    const api = getApi()
    if (!api) return false

    try {
      const result = await api.addSite(site)
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // 删除站点
  removeSite: async (id) => {
    const api = getApi()
    if (!api) return false

    try {
      const result = await api.removeSite(id)
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // 打开站点窗口
  openSite: async (siteId) => {
    const api = getApi()
    if (!api) return false

    try {
      const result = await api.openSite(siteId)
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // 关闭站点窗口
  closeSite: async (siteId) => {
    const api = getApi()
    if (!api) return false

    try {
      const result = await api.closeSite(siteId)
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // 刷新凭据
  refreshCredentials: async (siteId) => {
    const api = getApi()
    if (!api) return false

    try {
      const result = await api.refreshCredentials(siteId)
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // 清除凭据
  clearCredentials: async (siteId) => {
    const api = getApi()
    if (!api) return false

    try {
      const result = await api.clearCredentials(siteId)
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  },

  // 切换站点启用状态
  toggleSiteEnabled: async (siteId) => {
    const api = getApi()
    if (!api) return false

    const site = get().sites.find(s => s.id === siteId)
    if (!site) return false

    try {
      const result = await api.updateSite(siteId, { enabled: !site.enabled })
      if (result.success) {
        await get().fetchSites()
        return true
      }
      return false
    } catch {
      return false
    }
  }
}))
