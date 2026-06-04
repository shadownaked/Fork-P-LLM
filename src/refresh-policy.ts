import type { Credentials, SiteConfig } from './types'

export type RefreshReason = 'jwt-expiring' | 'expiresAt-expiring' | 'age-exceeded'

export interface RefreshPolicy {
  enabled: boolean
  intervalMs: number
  thresholdMs: number
}

const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6h
const DEFAULT_REFRESH_THRESHOLD_MS = 5 * 60 * 1000 // 5m

export function resolveRefreshPolicy(site: SiteConfig | null | undefined): RefreshPolicy {
  const refresh = site?.refresh
  return {
    enabled: refresh?.enabled ?? true,
    intervalMs: refresh?.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    thresholdMs: refresh?.thresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS
  }
}

export function shouldRefreshCredentials(
  credentials: Credentials,
  policy: RefreshPolicy,
  now = Date.now()
): { shouldRefresh: boolean; reason?: RefreshReason } {
  if (!policy.enabled) return { shouldRefresh: false }

  if (!credentials.authorization && !credentials.sessionId) {
    return { shouldRefresh: false }
  }

  const tokenExpiryMs = getJwtExpiryMs(credentials.authorization)
  if (tokenExpiryMs !== null && tokenExpiryMs - now <= policy.thresholdMs) {
    return { shouldRefresh: true, reason: 'jwt-expiring' }
  }

  if (credentials.expiresAt && credentials.expiresAt - now <= policy.thresholdMs) {
    return { shouldRefresh: true, reason: 'expiresAt-expiring' }
  }

  if (credentials.capturedAt && now - credentials.capturedAt >= policy.intervalMs) {
    return { shouldRefresh: true, reason: 'age-exceeded' }
  }

  return { shouldRefresh: false }
}

function getJwtExpiryMs(token: string | null): number | null {
  if (!token) return null

  const jwt = token.startsWith('Bearer ') ? token.substring(7) : token
  const parts = jwt.split('.')
  if (parts.length !== 3) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    if (!payload.exp) return null
    return payload.exp * 1000
  } catch {
    return null
  }
}
