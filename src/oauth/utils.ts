/**
 * OAuth Utility Functions
 *
 * Provides common utilities for OAuth flows:
 * - State generation for CSRF protection
 * - PKCE code_verifier and code_challenge generation
 * - URL building for authorization requests
 * - Token exchange and refresh operations
 */

import * as crypto from 'node:crypto'
import * as https from 'node:https'
import type { OAuthProviderConfig, OAuthToken } from '../types'

// Lazy logger to avoid Electron dependency in tests
type LogFn = (...args: unknown[]) => void
interface Logger {
  info: LogFn
  error: LogFn
  debug: LogFn
}

let _log: Logger | null = null

function getLog(): Logger {
  if (!_log) {
    try {
      // Dynamic import to avoid issues in test environment
      const { getMainLogger } = require('../logger')
      _log = getMainLogger()
    } catch {
      // Fallback for test environment: silent logger (no console output)
      _log = {
        info: () => {},
        error: () => {},
        debug: () => {}
      }
    }
  }
  return _log!
}

// ============================================================================
// Random Generation
// ============================================================================

/**
 * Generate a cryptographically secure random string
 * Used for state parameter and code_verifier
 */
export function generateRandomString(length: number = 32): string {
  const bytes = crypto.randomBytes(length)
  return bytes.toString('base64url')
}

/**
 * Generate a unique state parameter for OAuth CSRF protection
 * Returns a 32-character random string
 */
export function generateState(): string {
  return generateRandomString(32)
}

// ============================================================================
// PKCE (Proof Key for Code Exchange)
// ============================================================================

/**
 * Generate PKCE code_verifier and code_challenge
 *
 * code_verifier: A cryptographically random string (43-128 chars)
 * code_challenge: Base64URL-encoded SHA256 hash of code_verifier
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  // Generate 32 random bytes -> 43 character base64url string
  const codeVerifier = generateRandomString(32)

  // SHA256 hash of code_verifier, then base64url encode
  const hash = crypto.createHash('sha256').update(codeVerifier).digest()
  const codeChallenge = hash.toString('base64url')

  return { codeVerifier, codeChallenge }
}

// ============================================================================
// URL Building
// ============================================================================

/**
 * Build OAuth authorization URL with all required parameters
 */
export function buildAuthUrl(
  config: OAuthProviderConfig,
  state: string,
  extraParams?: Record<string, string>
): string {
  const url = new URL(config.authUrl)

  // Standard OAuth parameters
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)

  // Scopes
  if (config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(' '))
  }

  // Extra parameters (e.g., PKCE challenge, prompt, etc.)
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      url.searchParams.set(key, value)
    }
  }

  return url.toString()
}

// ============================================================================
// HTTP Request Helpers
// ============================================================================

interface HttpResponse {
  status: number
  data: string
}

/**
 * Make an HTTPS POST request with form-urlencoded body
 */
async function httpsPost(
  url: string,
  body: Record<string, string>,
  headers?: Record<string, string>
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url)
    const bodyStr = new URLSearchParams(body).toString()

    const options: https.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
        Accept: 'application/json',
        ...headers
      }
    }

    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, data })
      })
    })

    req.on('error', reject)
    req.setTimeout(30000, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.write(bodyStr)
    req.end()
  })
}

// ============================================================================
// Token Operations
// ============================================================================

/**
 * Exchange authorization code for tokens (standard OAuth2 flow)
 */
export async function exchangeCodeForToken(
  config: OAuthProviderConfig,
  code: string
): Promise<OAuthToken> {
  getLog().info(`[OAuth] Exchanging code for token at ${config.tokenUrl}`)

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri
  }

  // Add client_secret if provided (required for some providers like Google)
  if (config.clientSecret) {
    body.client_secret = config.clientSecret
  }

  const response = await httpsPost(config.tokenUrl, body)

  if (response.status !== 200) {
    getLog().error(`[OAuth] Token exchange failed: ${response.status} ${response.data}`)
    throw new Error(`Token exchange failed: ${response.status}`)
  }

  return parseTokenResponse(response.data)
}

/**
 * Exchange authorization code for tokens using PKCE
 */
export async function exchangeCodeForTokenPKCE(
  config: OAuthProviderConfig,
  code: string,
  codeVerifier: string
): Promise<OAuthToken> {
  getLog().info(`[OAuth] Exchanging code for token (PKCE) at ${config.tokenUrl}`)

  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_verifier: codeVerifier
  }

  const response = await httpsPost(config.tokenUrl, body)

  if (response.status !== 200) {
    getLog().error(`[OAuth] Token exchange (PKCE) failed: ${response.status} ${response.data}`)
    throw new Error(`Token exchange failed: ${response.status}`)
  }

  return parseTokenResponse(response.data)
}

/**
 * Refresh access token using refresh_token
 */
export async function refreshAccessToken(
  config: OAuthProviderConfig,
  refreshToken: string
): Promise<OAuthToken> {
  getLog().info(`[OAuth] Refreshing token at ${config.tokenUrl}`)

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId
  }

  // Add client_secret if provided
  if (config.clientSecret) {
    body.client_secret = config.clientSecret
  }

  const response = await httpsPost(config.tokenUrl, body)

  if (response.status !== 200) {
    getLog().error(`[OAuth] Token refresh failed: ${response.status} ${response.data}`)
    throw new Error(`Token refresh failed: ${response.status}`)
  }

  return parseTokenResponse(response.data)
}

// ============================================================================
// Device Code Flow
// ============================================================================

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

/**
 * Initiate device code flow
 */
export async function initiateDeviceFlow(
  deviceCodeUrl: string,
  clientId: string,
  scopes: string[],
  codeChallenge?: string
): Promise<DeviceCodeResponse> {
  getLog().info(`[OAuth] Initiating device flow at ${deviceCodeUrl}`)

  const body: Record<string, string> = {
    client_id: clientId,
    scope: scopes.join(' ')
  }

  // Add PKCE challenge if provided (some providers like Qwen use PKCE with device flow)
  if (codeChallenge) {
    body.code_challenge = codeChallenge
    body.code_challenge_method = 'S256'
  }

  const response = await httpsPost(deviceCodeUrl, body)

  if (response.status !== 200) {
    getLog().error(`[OAuth] Device flow initiation failed: ${response.status} ${response.data}`)
    throw new Error(`Device flow initiation failed: ${response.status}`)
  }

  return JSON.parse(response.data)
}

/**
 * Poll for device token
 * Returns token if authorized, throws if pending/error
 */
export async function pollDeviceToken(
  tokenUrl: string,
  clientId: string,
  deviceCode: string,
  codeVerifier?: string
): Promise<OAuthToken> {
  const body: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode
  }

  // Add code_verifier if using PKCE
  if (codeVerifier) {
    body.code_verifier = codeVerifier
  }

  const response = await httpsPost(tokenUrl, body)

  // Handle pending/slow_down responses
  if (response.status === 400) {
    const error = JSON.parse(response.data)
    if (error.error === 'authorization_pending' || error.error === 'slow_down') {
      throw new Error(error.error)
    }
    throw new Error(`Device token poll failed: ${error.error_description || error.error}`)
  }

  if (response.status !== 200) {
    getLog().error(`[OAuth] Device token poll failed: ${response.status} ${response.data}`)
    throw new Error(`Device token poll failed: ${response.status}`)
  }

  return parseTokenResponse(response.data)
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse OAuth token response into OAuthToken structure
 */
export function parseTokenResponse(responseData: string): OAuthToken {
  const data = JSON.parse(responseData)

  // Calculate expiration time
  let expiresAt: number | null = null
  if (data.expires_in) {
    expiresAt = Date.now() + data.expires_in * 1000
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    idToken: data.id_token || null,
    tokenType: data.token_type || 'Bearer',
    expiresAt,
    scope: data.scope || null
  }
}

/**
 * Check if an OAuth token is expired
 * Returns true if expired or will expire within buffer time
 */
export function isOAuthTokenExpired(token: OAuthToken, bufferMs: number = 60000): boolean {
  if (!token.expiresAt) {
    return false // No expiration info, assume valid
  }
  return Date.now() + bufferMs >= token.expiresAt
}

/**
 * Extract email from ID token (JWT)
 * Returns null if not present or invalid
 */
export function extractEmailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null

  try {
    // JWT format: header.payload.signature
    const parts = idToken.split('.')
    if (parts.length !== 3) return null

    // Decode payload (base64url)
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    return payload.email || null
  } catch {
    return null
  }
}

// ============================================================================
// GCP Project Discovery
// ============================================================================

export interface GCPProject {
  projectId: string
  name: string
  projectNumber: string
  lifecycleState: string
}

/**
 * Fetch list of GCP projects accessible by the user
 * Uses Cloud Resource Manager API
 */
export async function fetchGCPProjects(accessToken: string): Promise<GCPProject[]> {
  getLog().info('[OAuth] Fetching GCP projects')

  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: 'cloudresourcemanager.googleapis.com',
      port: 443,
      path: '/v1/projects',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    }

    const req = https.request(options, res => {
      let data = ''
      res.on('data', chunk => {
        data += chunk
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          getLog().error(`[OAuth] Failed to fetch GCP projects: ${res.statusCode} ${data}`)
          resolve([]) // Return empty array on error
          return
        }

        try {
          const response = JSON.parse(data)
          const projects: GCPProject[] = (response.projects || [])
            .filter((p: { lifecycleState: string }) => p.lifecycleState === 'ACTIVE')
            .map((p: { projectId: string; name: string; projectNumber: string; lifecycleState: string }) => ({
              projectId: p.projectId,
              name: p.name,
              projectNumber: p.projectNumber,
              lifecycleState: p.lifecycleState
            }))

          getLog().info(`[OAuth] Found ${projects.length} active GCP projects`)
          resolve(projects)
        } catch (e) {
          getLog().error(`[OAuth] Failed to parse GCP projects response: ${e}`)
          resolve([])
        }
      })
    })

    req.on('error', err => {
      getLog().error(`[OAuth] GCP projects request error: ${err}`)
      resolve([])
    })

    req.setTimeout(30000, () => {
      req.destroy()
      resolve([])
    })

    req.end()
  })
}

/**
 * Select the best GCP project for Gemini CLI
 * Prefers projects with 'gemini' or 'ai' in the name, otherwise returns first one
 */
export function selectBestGCPProject(projects: GCPProject[]): string | null {
  if (projects.length === 0) return null

  // Try to find a project with 'gemini' or 'ai' in the name
  const preferred = projects.find(p =>
    p.name.toLowerCase().includes('gemini') ||
    p.name.toLowerCase().includes('ai') ||
    p.projectId.toLowerCase().includes('gemini') ||
    p.projectId.toLowerCase().includes('ai')
  )

  if (preferred) {
    getLog().info(`[OAuth] Selected preferred GCP project: ${preferred.projectId}`)
    return preferred.projectId
  }

  // Return first project
  getLog().info(`[OAuth] Selected first GCP project: ${projects[0].projectId}`)
  return projects[0].projectId
}
