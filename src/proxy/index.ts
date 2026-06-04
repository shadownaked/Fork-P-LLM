/**
 * Proxy module exports
 *
 * This module provides HTTP/HTTPS proxy functionality for traffic capture.
 *
 * Key feature: Electron Local Trust
 * - Certificates are trusted via session.setCertificateVerifyProc()
 * - No system keychain installation required
 * - Only affects Electron windows, not system traffic
 */

export { ProxyServer } from './proxy-server'
export type {
  ProxyOptions,
  CapturedRequest,
  CapturedResponse
} from './proxy-server'

export { CertManager, getCertFingerprint, getCertIssuer } from './cert-manager'
export type {
  CertificateInfo,
  CertManagerOptions
} from './cert-manager'

export {
  loadProxySettings,
  saveProxySettings,
  getCACertPath,
  caCertExists,
  revealCACert,
  getProxyStatus,
  enableProxy,
  disableProxy,
  toggleProxy,
  shouldUseProxy
} from './proxy-settings'
export type { ProxySettings, ProxyStatus } from './proxy-settings'
