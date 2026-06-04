import { getMainLogger, getSiteNetworkLogger } from '../logger'
import {
  getDataPath,
  atomicWriteJsonSync,
  safeReadJsonSync,
  migrateFile
} from './storage'

const log = getMainLogger()

export interface CapturedRequest {
  id: string
  timestamp: number
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  contentType: string | null
  isRecommended?: boolean  // True if matches captureRules pattern
  // Response data (captured via CDP)
  response?: {
    status: number
    statusText: string
    headers: Record<string, string>
    body: string | null
    mimeType: string | null
  }
}

export interface CapturedWebSocket {
  id: string
  timestamp: number
  url: string
  direction: 'sent' | 'received'
  data: string
  opcode: number  // 1=text, 2=binary
}

export interface WebSocketConnection {
  id: string
  url: string
  createdAt: number
  messages: CapturedWebSocket[]
}

/**
 * SSE (Server-Sent Events) stream data
 */
export interface SSEStream {
  id: string
  requestId: string
  url: string
  createdAt: number
  endedAt: number | null
  status: 'active' | 'ended' | 'error'
  chunks: SSEChunk[]
}

export interface SSEChunk {
  id: string
  timestamp: number
  data: string
}

/**
 * Serializable data structure for persistence
 */
interface RequestStoreData {
  requests: Record<string, CapturedRequest[]>
  // WebSocket data is not persisted (too transient)
}

/**
 * Store for captured HTTP requests per site
 * Used to let users select which request contains credentials
 *
 * Improvements:
 * - Persists requests to disk for survival across app restarts
 * - Uses stable userData directory
 * - Atomic writes prevent data corruption
 */
class RequestStore {
  // Map<siteId, CapturedRequest[]>
  private requests: Map<string, CapturedRequest[]> = new Map()
  // Map<siteId, Map<wsUrl, WebSocketConnection>>
  private websockets: Map<string, Map<string, WebSocketConnection>> = new Map()
  // Map<siteId, Map<requestId, SSEStream>>
  private sseStreams: Map<string, Map<string, SSEStream>> = new Map()
  // Pending body data: Map<siteId, Map<url, body>>
  private pendingBodies: Map<string, Map<string, string>> = new Map()
  private maxRequestsPerSite = 500
  private maxWsMessagesPerConnection = 200
  private maxSSEChunksPerStream = 500
  private storagePath: string
  private saveTimeout: NodeJS.Timeout | null = null
  private saveDebounceMs = 2000 // Debounce saves to avoid excessive disk writes

  constructor() {
    // Migrate from legacy location if needed
    migrateFile('requests.json')

    // Use stable data path
    this.storagePath = getDataPath('requests.json')
    this.loadFromDisk()
  }

  /**
   * Add a captured request for a site
   */
  addRequest(siteId: string, request: Omit<CapturedRequest, 'id' | 'timestamp'>): void {
    if (!this.requests.has(siteId)) {
      this.requests.set(siteId, [])
    }

    const requests = this.requests.get(siteId)!

    // Check if there's a pending body for this URL
    let body = request.body
    const pendingSite = this.pendingBodies.get(siteId)
    if (pendingSite?.has(request.url)) {
      body = pendingSite.get(request.url)!
      pendingSite.delete(request.url)
      log.debug(`Merged pending body for: ${request.url}`)
    }

    const captured: CapturedRequest = {
      ...request,
      body,
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now()
    }

    requests.push(captured)

    // Limit stored requests, but preserve recommended ones
    if (requests.length > this.maxRequestsPerSite) {
      // Find the first non-recommended request to remove
      const indexToRemove = requests.findIndex(r => !r.isRecommended)
      if (indexToRemove >= 0) {
        requests.splice(indexToRemove, 1)
      } else {
        // All requests are recommended, remove the oldest one
        requests.shift()
      }
    }

    // Log full request JSON to site-specific network log
    const siteLog = getSiteNetworkLogger(siteId)
    siteLog.debug(`[REQUEST] ${JSON.stringify(captured, null, 2)}`)

    // Debounced save to disk
    this.scheduleSave()
  }

  /**
   * Get all captured requests for a site
   */
  getRequests(siteId: string): CapturedRequest[] {
    return this.requests.get(siteId) || []
  }

  /**
   * Get a specific request by ID
   */
  getRequestById(siteId: string, requestId: string): CapturedRequest | null {
    const requests = this.requests.get(siteId) || []
    return requests.find(r => r.id === requestId) || null
  }

  /**
   * Clear all requests for a site
   */
  clearRequests(siteId: string): void {
    this.requests.delete(siteId)
    this.scheduleSave()
    log.info(`Cleared requests for site: ${siteId}`)
  }

  /**
   * Clear all requests
   */
  clearAll(): void {
    this.requests.clear()
    this.scheduleSave()
    log.info('Cleared all captured requests')
  }

  /**
   * Update the body of a recently stored request (matched by URL)
   * Used when body data arrives separately from headers
   * If no matching request found, stores body for later merge
   */
  updateRequestBody(siteId: string, url: string, body: string): void {
    const requests = this.requests.get(siteId)

    // Try to find and update existing request
    if (requests) {
      // Find the most recent request with this URL that has no body
      for (let i = requests.length - 1; i >= 0; i--) {
        if (requests[i].url === url && !requests[i].body) {
          requests[i].body = body
          log.debug(`Updated request body for: ${url}`)
          return
        }
      }
    }

    // No matching request found - store body for later merge
    if (!this.pendingBodies.has(siteId)) {
      this.pendingBodies.set(siteId, new Map())
    }
    this.pendingBodies.get(siteId)!.set(url, body)
    log.debug(`Stored pending body for: ${url}`)
  }

  /**
   * Update response data for a request (matched by URL)
   * Used when response data arrives via CDP
   */
  updateRequestResponse(
    siteId: string,
    url: string,
    response: {
      status: number
      statusText: string
      headers: Record<string, string>
      body: string | null
      mimeType: string | null
    }
  ): void {
    const requests = this.requests.get(siteId)
    if (!requests) return

    // Find the most recent request with this URL
    for (let i = requests.length - 1; i >= 0; i--) {
      if (requests[i].url === url) {
        requests[i].response = response
        this.scheduleSave()
        // Log full response JSON to site-specific network log
        const siteLog = getSiteNetworkLogger(siteId)
        siteLog.debug(`[RESPONSE] ${JSON.stringify({ url, response }, null, 2)}`)
        return
      }
    }
    log.debug(`No matching request found for response: ${url}`)
  }

  /**
   * Get summary of requests (for UI display)
   * Filters out static resources and returns only API-like requests
   * Recommended requests (matching captureRules) are sorted to the top
   */
  getRequestSummary(siteId: string): Array<{
    id: string
    timestamp: number
    method: string
    url: string
    hasBody: boolean
    contentType: string | null
    isRecommended: boolean
  }> {
    const requests = this.requests.get(siteId) || []

    // Filter out static resources
    const staticExtensions = ['.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.woff', '.woff2', '.ttf', '.ico']
    const staticDomains = ['googletagmanager.com', 'google-analytics.com', 'facebook.com', 'bing.com', 'doubleclick.net']

    const filtered = requests
      .filter(r => {
        const urlLower = r.url.toLowerCase()
        // Exclude static files
        if (staticExtensions.some(ext => urlLower.includes(ext))) return false
        // Exclude tracking domains
        if (staticDomains.some(domain => urlLower.includes(domain))) return false
        return true
      })
      .map(r => ({
        id: r.id,
        timestamp: r.timestamp,
        method: r.method,
        url: r.url,
        hasBody: !!r.body,
        contentType: r.contentType,
        isRecommended: r.isRecommended || false
      }))
      .reverse() // Most recent first

    // Sort: recommended requests first, then by timestamp (most recent first)
    return filtered.sort((a, b) => {
      if (a.isRecommended && !b.isRecommended) return -1
      if (!a.isRecommended && b.isRecommended) return 1
      return b.timestamp - a.timestamp
    })
  }

  /**
   * Add a WebSocket connection
   */
  addWebSocketConnection(siteId: string, url: string): void {
    if (!this.websockets.has(siteId)) {
      this.websockets.set(siteId, new Map())
    }
    const siteWs = this.websockets.get(siteId)!

    if (!siteWs.has(url)) {
      siteWs.set(url, {
        id: `ws-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        url,
        createdAt: Date.now(),
        messages: []
      })
      const siteLog = getSiteNetworkLogger(siteId)
      siteLog.info(`[WebSocket] New connection: ${url}`)
    }
  }

  /**
   * Add a WebSocket message
   */
  addWebSocketMessage(
    siteId: string,
    url: string,
    direction: 'sent' | 'received',
    data: string,
    opcode: number = 1
  ): void {
    this.addWebSocketConnection(siteId, url)

    const siteWs = this.websockets.get(siteId)!
    const connection = siteWs.get(url)!

    const message: CapturedWebSocket = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      url,
      direction,
      data,
      opcode
    }

    connection.messages.push(message)

    // Limit stored messages
    if (connection.messages.length > this.maxWsMessagesPerConnection) {
      connection.messages.shift()
    }

    // Log the message to site-specific network log (truncate if too long)
    const siteLog = getSiteNetworkLogger(siteId)
    const preview = data.length > 2000 ? `${data.substring(0, 2000)}...` : data
    siteLog.info(`[WebSocket] ${direction.toUpperCase()} ${url}`)
    siteLog.info(`[WebSocket] Data: ${preview}`)
  }

  /**
   * Get all WebSocket connections for a site
   */
  getWebSocketConnections(siteId: string): WebSocketConnection[] {
    const siteWs = this.websockets.get(siteId)
    if (!siteWs) return []
    return Array.from(siteWs.values())
  }

  /**
   * Get WebSocket messages for a specific connection
   */
  getWebSocketMessages(siteId: string, url: string): CapturedWebSocket[] {
    const siteWs = this.websockets.get(siteId)
    if (!siteWs) return []
    const connection = siteWs.get(url)
    return connection?.messages || []
  }

  /**
   * Clear WebSocket data for a site
   */
  clearWebSockets(siteId: string): void {
    this.websockets.delete(siteId)
    log.info(`Cleared WebSocket data for site: ${siteId}`)
  }

  /**
   * Get WebSocket summary for UI display
   */
  getWebSocketSummary(siteId: string): Array<{
    id: string
    url: string
    createdAt: number
    messageCount: number
    lastMessage: CapturedWebSocket | null
  }> {
    const connections = this.getWebSocketConnections(siteId)
    return connections.map(conn => ({
      id: conn.id,
      url: conn.url,
      createdAt: conn.createdAt,
      messageCount: conn.messages.length,
      lastMessage: conn.messages.length > 0 ? conn.messages[conn.messages.length - 1] : null
    }))
  }

  // ===========================================================================
  // SSE (Server-Sent Events) methods
  // ===========================================================================

  /**
   * Start tracking a new SSE stream
   */
  startSSEStream(siteId: string, requestId: string, url: string): void {
    if (!this.sseStreams.has(siteId)) {
      this.sseStreams.set(siteId, new Map())
    }
    const siteSSE = this.sseStreams.get(siteId)!

    const stream: SSEStream = {
      id: `sse-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      requestId,
      url,
      createdAt: Date.now(),
      endedAt: null,
      status: 'active',
      chunks: []
    }

    siteSSE.set(requestId, stream)
    const siteLog = getSiteNetworkLogger(siteId)
    siteLog.info(`[SSE] Stream started: ${url}`)
  }

  /**
   * Add a chunk to an SSE stream
   */
  addSSEChunk(siteId: string, requestId: string, data: string): void {
    const siteSSE = this.sseStreams.get(siteId)
    if (!siteSSE) return

    const stream = siteSSE.get(requestId)
    if (!stream) return

    const chunk: SSEChunk = {
      id: `chunk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      data
    }

    stream.chunks.push(chunk)

    // Limit stored chunks
    if (stream.chunks.length > this.maxSSEChunksPerStream) {
      stream.chunks.shift()
    }

    // Log to site-specific network log (truncate if too long)
    const siteLog = getSiteNetworkLogger(siteId)
    const preview = data.length > 500 ? `${data.substring(0, 500)}...` : data
    siteLog.debug(`[SSE] Chunk received: ${preview}`)
  }

  /**
   * End an SSE stream
   */
  endSSEStream(siteId: string, requestId: string, error?: boolean): void {
    const siteSSE = this.sseStreams.get(siteId)
    if (!siteSSE) return

    const stream = siteSSE.get(requestId)
    if (!stream) return

    stream.endedAt = Date.now()
    stream.status = error ? 'error' : 'ended'

    const siteLog = getSiteNetworkLogger(siteId)
    siteLog.info(`[SSE] Stream ${error ? 'error' : 'ended'}: ${stream.url} (${stream.chunks.length} chunks)`)
  }

  /**
   * Get SSE stream by request ID
   */
  getSSEStream(siteId: string, requestId: string): SSEStream | null {
    const siteSSE = this.sseStreams.get(siteId)
    if (!siteSSE) return null
    return siteSSE.get(requestId) || null
  }

  /**
   * Get all SSE streams for a site
   */
  getSSEStreams(siteId: string): SSEStream[] {
    const siteSSE = this.sseStreams.get(siteId)
    if (!siteSSE) return []
    return Array.from(siteSSE.values())
  }

  /**
   * Get SSE summary for UI display
   */
  getSSESummary(siteId: string): Array<{
    id: string
    requestId: string
    url: string
    createdAt: number
    endedAt: number | null
    status: 'active' | 'ended' | 'error'
    chunkCount: number
  }> {
    const streams = this.getSSEStreams(siteId)
    return streams.map(stream => ({
      id: stream.id,
      requestId: stream.requestId,
      url: stream.url,
      createdAt: stream.createdAt,
      endedAt: stream.endedAt,
      status: stream.status,
      chunkCount: stream.chunks.length
    }))
  }

  /**
   * Clear SSE data for a site
   */
  clearSSEStreams(siteId: string): void {
    this.sseStreams.delete(siteId)
    log.info(`Cleared SSE data for site: ${siteId}`)
  }

  /**
   * Schedule a debounced save to disk
   * Prevents excessive disk writes when many requests come in rapidly
   */
  private scheduleSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
    }
    this.saveTimeout = setTimeout(() => {
      this.saveToDisk()
      this.saveTimeout = null
    }, this.saveDebounceMs)
  }

  /**
   * Load requests from disk
   */
  private loadFromDisk(): void {
    const result = safeReadJsonSync<RequestStoreData>(this.storagePath)

    if (result.success && result.data) {
      // Convert plain object back to Map
      this.requests = new Map(Object.entries(result.data.requests))
      const totalRequests = Array.from(this.requests.values()).reduce((sum, arr) => sum + arr.length, 0)
      log.info(`Loaded ${totalRequests} requests for ${this.requests.size} sites from disk`)
    } else if (result.error && result.error.code !== 'FILE_NOT_FOUND') {
      log.warn(`Failed to load requests: ${result.error.message}`)
    }
  }

  /**
   * Save requests to disk
   */
  private saveToDisk(): void {
    try {
      // Convert Map to plain object for JSON serialization
      const data: RequestStoreData = {
        requests: Object.fromEntries(this.requests)
      }
      atomicWriteJsonSync(this.storagePath, data)
      log.debug('Saved requests to disk')
    } catch (error) {
      log.error('Failed to save requests to disk:', error)
    }
  }

  /**
   * Force immediate save (call before app quit)
   */
  saveNow(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout)
      this.saveTimeout = null
    }
    this.saveToDisk()
  }
}

export const requestStore = new RequestStore()
