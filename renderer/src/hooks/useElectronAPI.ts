import type { ElectronAPI } from '@/types'

// Fallback API for development outside Electron
const fallbackAPI: ElectronAPI = {
  openTarget: async () => ({ success: false, error: 'Not in Electron' }),
  getCredentials: async () => ({ hasCredentials: false, sessionId: null }),
  onCredentials: () => {},
  getAllSites: async () => [],
  onSitesUpdate: () => {},
  refreshCredentials: async () => ({ success: false }),
  addSite: async () => ({ success: false }),
  updateSite: async () => ({ success: false }),
  removeSite: async () => ({ success: false }),
  clearCredentials: async () => ({ success: false }),
  clearSiteErrorStatus: async () => ({ success: false }),
  openSite: async () => ({ success: false }),
  closeSite: async () => ({ success: false }),
  getOpenWindows: async () => [],
  onSiteWindowClosed: () => {},
  getRequests: async () => [],
  getRequestDetail: async () => null,
  clearRequests: async () => ({ success: false }),
  selectRequestAsCredential: async () => ({ success: false }),
  // Claude Code takeover
  claudeTakeoverStatus: async () => ({
    isTakenOver: false,
    proxyUrl: null,
    hasBackup: false,
    backupPath: null
  }),
  claudeTakeover: async () => ({ success: false, error: 'Not in Electron' }),
  claudeRestore: async () => ({ success: false, error: 'Not in Electron' }),
  claudeForceCleanup: async () => ({ success: false, error: 'Not in Electron' }),
  claudeIsInstalled: async () => false,
  // Claude Code API testing and target management
  claudeTestApi: async () => ({ success: false, error: 'Not in Electron' }),
  claudeGetSelectedTarget: async () => null,
  claudeSetSelectedTarget: async () => {},
  // OAuth
  oauthGetProviders: async () => [],
  oauthStartAuth: async () => ({ authUrl: '', state: '', flowType: 'authorization_code' as const }),
  oauthGetStatus: async () => ({ status: 'not_found' as const }),
  oauthPoll: async () => ({ status: 'not_found' as const }),
  oauthGetCredentials: async () => [],
  oauthLogout: async () => ({ success: false }),
  // Authorized Tools
  getAuthorizedTools: async () => [],
  toggleToolEnabled: async () => ({ success: false, enabled: false }),
  // External links
  openExternal: async () => {}
}

export function useElectronAPI(): ElectronAPI {
  return window.electronAPI || fallbackAPI
}

export function getElectronAPI(): ElectronAPI {
  return window.electronAPI || fallbackAPI
}
