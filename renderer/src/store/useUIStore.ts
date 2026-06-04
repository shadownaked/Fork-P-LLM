import { create } from 'zustand'
import type { Toast, RequestSummary, RequestDetail } from '@/types'

interface RequestModalState {
  open: boolean
  siteId: string | null
  siteName: string
  selectedRequestId: string | null
  requests: RequestSummary[]
  requestDetail: RequestDetail | null
  loading: boolean
}

interface UIStore {
  // Toast 状态
  toasts: Toast[]
  showToast: (message: string, type?: Toast['type']) => void
  removeToast: (id: string) => void

  // Add Site Modal
  addSiteModalOpen: boolean
  openAddSiteModal: () => void
  closeAddSiteModal: () => void

  // OAuth Modal
  oauthModalOpen: boolean
  openOAuthModal: () => void
  closeOAuthModal: () => void

  // Tools refresh trigger - incremented when tools need to be refreshed
  toolsRefreshTrigger: number
  triggerToolsRefresh: () => void

  // Request Modal
  requestModal: RequestModalState
  openRequestModal: (siteId: string, siteName: string) => Promise<void>
  closeRequestModal: () => void
  loadRequests: () => Promise<void>
  selectRequest: (requestId: string) => Promise<void>
  clearAllRequests: () => Promise<void>
  useSelectedRequest: () => Promise<boolean>
}

const getApi = () => window.electronAPI

let toastIdCounter = 0

export const useUIStore = create<UIStore>((set, get) => ({
  // Toast 初始状态
  toasts: [],

  showToast: (message, type = 'success') => {
    const id = `toast-${++toastIdCounter}`
    const toast: Toast = { id, message, type }

    set((state) => ({ toasts: [...state.toasts, toast] }))

    // 3秒后自动移除
    setTimeout(() => {
      get().removeToast(id)
    }, 3000)
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id)
    }))
  },

  // Add Site Modal
  addSiteModalOpen: false,
  openAddSiteModal: () => set({ addSiteModalOpen: true }),
  closeAddSiteModal: () => set({ addSiteModalOpen: false }),

  // OAuth Modal
  oauthModalOpen: false,
  openOAuthModal: () => set({ oauthModalOpen: true }),
  closeOAuthModal: () => set({ oauthModalOpen: false }),

  // Tools refresh trigger
  toolsRefreshTrigger: 0,
  triggerToolsRefresh: () => set((state) => ({ toolsRefreshTrigger: state.toolsRefreshTrigger + 1 })),

  // Request Modal
  requestModal: {
    open: false,
    siteId: null,
    siteName: '',
    selectedRequestId: null,
    requests: [],
    requestDetail: null,
    loading: false
  },

  openRequestModal: async (siteId, siteName) => {
    set({
      requestModal: {
        open: true,
        siteId,
        siteName,
        selectedRequestId: null,
        requests: [],
        requestDetail: null,
        loading: true
      }
    })
    await get().loadRequests()
  },

  closeRequestModal: () => {
    set({
      requestModal: {
        open: false,
        siteId: null,
        siteName: '',
        selectedRequestId: null,
        requests: [],
        requestDetail: null,
        loading: false
      }
    })
  },

  loadRequests: async () => {
    const api = getApi()
    const { siteId } = get().requestModal
    if (!api || !siteId) return

    try {
      const requests = await api.getRequests(siteId)
      set((state) => ({
        requestModal: {
          ...state.requestModal,
          requests,
          loading: false
        }
      }))
    } catch {
      set((state) => ({
        requestModal: {
          ...state.requestModal,
          loading: false
        }
      }))
      get().showToast('Failed to load requests', 'error')
    }
  },

  selectRequest: async (requestId) => {
    const api = getApi()
    const { siteId } = get().requestModal
    if (!api || !siteId) return

    set((state) => ({
      requestModal: {
        ...state.requestModal,
        selectedRequestId: requestId
      }
    }))

    try {
      const detail = await api.getRequestDetail(siteId, requestId)
      set((state) => ({
        requestModal: {
          ...state.requestModal,
          requestDetail: detail
        }
      }))
    } catch {
      get().showToast('Failed to load request detail', 'error')
    }
  },

  clearAllRequests: async () => {
    const api = getApi()
    const { siteId } = get().requestModal
    if (!api || !siteId) return

    try {
      await api.clearRequests(siteId)
      await get().loadRequests()
      get().showToast('Requests cleared')
    } catch {
      get().showToast('Failed to clear requests', 'error')
    }
  },

  useSelectedRequest: async () => {
    const api = getApi()
    const { siteId, selectedRequestId } = get().requestModal
    if (!api || !siteId || !selectedRequestId) return false

    try {
      const result = await api.selectRequestAsCredential(siteId, selectedRequestId)
      if (result.success) {
        const message = result.authHeader
          ? `Credentials captured! Auth header: ${result.authHeader}`
          : (result.note || 'Request info stored')
        get().showToast(message)
        get().closeRequestModal()
        return true
      } else {
        get().showToast(`Failed: ${result.error}`, 'error')
        return false
      }
    } catch {
      get().showToast('Failed to use selected request', 'error')
      return false
    }
  }
}))
