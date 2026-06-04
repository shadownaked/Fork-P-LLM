/**
 * HTTP/HTTPS Proxy Server for traffic capture
 *
 * This module implements a proxy server that can intercept and capture
 * all HTTP/HTTPS traffic, including SSE (Server-Sent Events) streams.
 *
 * Key features:
 * - HTTP request/response capture
 * - HTTPS MITM (Man-in-the-Middle) decryption via dynamic certificates
 * - Real-time SSE stream capture
 * - WebSocket upgrade support
 * - Response decompression (gzip, br, deflate)
 */

import * as http from 'node:http'
import * as https from 'node:https'
import * as dns from 'node:dns'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'
import { URL } from 'node:url'
import type { CertManager } from './cert-manager'

export interface ProxyOptions {
  port: number
  host?: string
  certManager?: CertManager
  onRequest?: (req: CapturedRequest) => void
  onResponse?: (req: CapturedRequest, res: CapturedResponse) => void
  onSSEChunk?: (req: CapturedRequest, chunk: string) => void
  onError?: (error: Error, context: string) => void
  onConnect?: (hostname: string, port: number) => void
  /**
   * Custom DNS servers to use for resolving hostnames.
   * If not provided, uses public DNS servers (8.8.8.8, 1.1.1.1) to bypass
   * potentially poisoned system resolver.
   */
  dnsServers?: string[]
}

export interface CapturedRequest {
  id: string
  method: string
  url: string
  headers: Record<string, string>
  body: Buffer | null
  timestamp: number
}

export interface CapturedResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: Buffer | null
  isSSE: boolean
}

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
}

/**
 * Convert IncomingHttpHeaders to a simple Record<string, string>
 */
function normalizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = Array.isArray(value) ? value.join(', ') : value
    }
  }
  return result
}

/**
 * Decompress response body based on content-encoding
 * Supports: gzip, deflate, br (brotli)
 */
function decompressBody(body: Buffer, encoding: string | undefined): Buffer {
  if (!encoding || !body || body.length === 0) {
    return body
  }

  const enc = encoding.toLowerCase().trim()

  try {
    switch (enc) {
      case 'gzip':
        return zlib.gunzipSync(body)
      case 'deflate':
        return zlib.inflateSync(body)
      case 'br':
        return zlib.brotliDecompressSync(body)
      default:
        // Unknown encoding, return as-is
        return body
    }
  } catch (err) {
    // Decompression failed, return original body
    // This can happen with partial/corrupted data
    return body
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void

// Default public DNS servers to bypass potentially poisoned system resolver
const DEFAULT_DNS_SERVERS = ['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']

/**
 * Create a DNS lookup function that uses dns.Resolver instead of dns.lookup.
 * This bypasses the system resolver (getaddrinfo) which may be poisoned.
 *
 * dns.lookup() uses the OS resolver (affected by /etc/hosts, system DNS cache, etc.)
 * dns.resolve4/resolve6() directly queries DNS servers, bypassing system resolver
 */
function createDnsLookup(dnsServers?: string[]): (
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions,
  callback: LookupCallback
) => void {
  const resolver = new dns.Resolver()
  resolver.setServers(dnsServers ?? DEFAULT_DNS_SERVERS)

  return (
    hostname: string,
    options: dns.LookupOneOptions | dns.LookupAllOptions,
    callback: LookupCallback
  ): void => {
    const family = typeof options === 'object' ? options.family ?? 0 : 0

    // If specific family requested, resolve only that
    if (family === 4) {
      resolver.resolve4(hostname, (err, addresses) => {
        if (err || !addresses.length) {
          callback(err ?? new Error(`No IPv4 addresses for ${hostname}`), hostname, 4)
          return
        }
        callback(null, addresses[0], 4)
      })
      return
    }

    if (family === 6) {
      resolver.resolve6(hostname, (err, addresses) => {
        if (err || !addresses.length) {
          callback(err ?? new Error(`No IPv6 addresses for ${hostname}`), hostname, 6)
          return
        }
        callback(null, addresses[0], 6)
      })
      return
    }

    // Prefer IPv4, fallback to IPv6
    resolver.resolve4(hostname, (err4, addresses4) => {
      if (!err4 && addresses4.length > 0) {
        callback(null, addresses4[0], 4)
        return
      }

      // IPv4 failed, try IPv6
      resolver.resolve6(hostname, (err6, addresses6) => {
        if (!err6 && addresses6.length > 0) {
          callback(null, addresses6[0], 6)
          return
        }

        // Both failed, return the IPv4 error (more common)
        callback(err4 ?? err6 ?? new Error(`DNS resolution failed for ${hostname}`), hostname, 4)
      })
    })
  }
}

export class ProxyServer {
  private server: http.Server
  private options: ProxyOptions
  private isRunning = false
  private dnsLookup: ReturnType<typeof createDnsLookup>

  // Track active HTTPS MITM servers: Map<hostname:port, { server, port }>
  private mitmServers: Map<string, { server: https.Server; port: number }> = new Map()

  constructor(options: ProxyOptions) {
    this.options = options
    this.dnsLookup = createDnsLookup(options.dnsServers)
    this.server = http.createServer(this.handleRequest.bind(this))
    this.server.on('connect', this.handleConnect.bind(this))
    this.server.on('error', (err) => {
      this.options.onError?.(err, 'server')
    })
  }

  /**
   * Start the proxy server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isRunning) {
        resolve()
        return
      }

      const host = this.options.host || '127.0.0.1'
      this.server.listen(this.options.port, host, () => {
        this.isRunning = true
        resolve()
      })

      this.server.once('error', (err) => {
        reject(err)
      })
    })
  }

  /**
   * Stop the proxy server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isRunning) {
        resolve()
        return
      }

      // Close all MITM servers
      for (const { server } of this.mitmServers.values()) {
        server.close()
      }
      this.mitmServers.clear()

      this.server.close(() => {
        this.isRunning = false
        resolve()
      })
    })
  }

  /**
   * Get the proxy address for configuration
   */
  getProxyAddress(): string {
    const host = this.options.host || '127.0.0.1'
    return `http://${host}:${this.options.port}`
  }

  /**
   * Handle HTTP requests (non-CONNECT)
   */
  private handleRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse
  ): void {
    const requestId = generateRequestId()

    // Build full URL
    let fullUrl: string
    try {
      if (clientReq.url?.startsWith('http')) {
        fullUrl = clientReq.url
      } else {
        const host = clientReq.headers.host || 'localhost'
        fullUrl = `http://${host}${clientReq.url || '/'}`
      }
    } catch {
      this.sendError(clientRes, 400, 'Invalid URL')
      return
    }

    const capturedRequest: CapturedRequest = {
      id: requestId,
      method: clientReq.method || 'GET',
      url: fullUrl,
      headers: normalizeHeaders(clientReq.headers),
      body: null,
      timestamp: Date.now()
    }

    // Collect request body
    const bodyChunks: Buffer[] = []
    clientReq.on('data', (chunk: Buffer) => {
      bodyChunks.push(chunk)
    })

    clientReq.on('end', () => {
      if (bodyChunks.length > 0) {
        capturedRequest.body = Buffer.concat(bodyChunks)
      }

      // Notify listener
      this.options.onRequest?.(capturedRequest)

      // Forward request
      this.forwardRequest(capturedRequest, clientRes)
    })

    clientReq.on('error', (err) => {
      this.options.onError?.(err, `request:${fullUrl}`)
      this.sendError(clientRes, 502, 'Request Error')
    })
  }

  /**
   * Forward request to target server and capture response
   */
  private forwardRequest(
    capturedRequest: CapturedRequest,
    clientRes: http.ServerResponse
  ): void {
    let url: URL
    try {
      url = new URL(capturedRequest.url)
    } catch {
      this.sendError(clientRes, 400, 'Invalid URL')
      return
    }

    const isHttps = url.protocol === 'https:'
    const httpModule = isHttps ? https : http

    // Prepare request options
    const requestOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: capturedRequest.method,
      headers: { ...capturedRequest.headers } as http.OutgoingHttpHeaders
    }

    // Remove proxy-specific headers
    delete (requestOptions.headers as Record<string, unknown>)['proxy-connection']

    const proxyReq = httpModule.request({ ...requestOptions, lookup: this.dnsLookup }, (proxyRes) => {
      this.handleResponse(capturedRequest, proxyRes, clientRes)
    })

    proxyReq.on('error', (err) => {
      this.options.onError?.(err, `proxy:${capturedRequest.url}`)
      this.sendError(clientRes, 502, `Proxy Error: ${err.message}`)
    })

    // Forward request body
    if (capturedRequest.body) {
      proxyReq.write(capturedRequest.body)
    }
    proxyReq.end()
  }

  /**
   * Handle response from target server
   * Key: SSE streams are captured in real-time
   * Regular responses are decompressed before storing
   */
  private handleResponse(
    capturedRequest: CapturedRequest,
    proxyRes: http.IncomingMessage,
    clientRes: http.ServerResponse
  ): void {
    const contentType = proxyRes.headers['content-type'] || ''
    const contentEncoding = proxyRes.headers['content-encoding'] as string | undefined
    const isSSE = contentType.includes('text/event-stream')

    this.options.onError?.(new Error(`handleResponse: status=${proxyRes.statusCode}, contentType=${contentType}`), 'response-start')

    const capturedResponse: CapturedResponse = {
      status: proxyRes.statusCode || 200,
      statusText: proxyRes.statusMessage || '',
      headers: normalizeHeaders(proxyRes.headers),
      body: null,
      isSSE
    }

    // Forward response headers
    // Filter out problematic headers
    const headersToForward: Record<string, string | string[]> = {}
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value !== undefined && key.toLowerCase() !== 'transfer-encoding') {
        headersToForward[key] = value
      }
    }

    try {
      clientRes.writeHead(proxyRes.statusCode || 200, headersToForward)
    } catch (err) {
      this.options.onError?.(err as Error, `writeHead:${capturedRequest.url}`)
      proxyRes.destroy()
      return
    }

    if (isSSE) {
      // SSE: Stream data in real-time, capture each chunk
      proxyRes.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString('utf-8')
        this.options.onSSEChunk?.(capturedRequest, chunkStr)

        try {
          clientRes.write(chunk)
        } catch {
          // Client disconnected
        }
      })

      proxyRes.on('end', () => {
        this.options.onResponse?.(capturedRequest, capturedResponse)
        try {
          clientRes.end()
        } catch {
          // Client disconnected
        }
      })
    } else {
      // Regular response: Collect full body and decompress
      const responseChunks: Buffer[] = []

      proxyRes.on('data', (chunk: Buffer) => {
        responseChunks.push(chunk)
        try {
          clientRes.write(chunk)
        } catch {
          // Client disconnected
        }
      })

      proxyRes.on('end', () => {
        if (responseChunks.length > 0) {
          const rawBody = Buffer.concat(responseChunks)
          // Decompress the body for capture (client receives original compressed data)
          capturedResponse.body = decompressBody(rawBody, contentEncoding)
        }
        this.options.onResponse?.(capturedRequest, capturedResponse)
        try {
          clientRes.end()
        } catch {
          // Client disconnected
        }
      })
    }

    proxyRes.on('error', (err) => {
      this.options.onError?.(err, `response:${capturedRequest.url}`)
    })
  }

  /**
   * Handle HTTPS CONNECT requests
   *
   * Two modes:
   * 1. With CertManager: MITM decryption (can see HTTPS content)
   * 2. Without CertManager: Simple tunnel (encrypted, cannot see content)
   */
  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr, 10) || 443

    // Log CONNECT request for debugging
    this.options.onConnect?.(hostname, port)

    if (this.options.certManager) {
      // MITM mode: Decrypt HTTPS traffic
      this.handleConnectMITM(hostname, port, clientSocket, head)
    } else {
      // Tunnel mode: Just forward encrypted traffic
      this.handleConnectTunnel(hostname, port, clientSocket, head)
    }
  }

  /**
   * MITM mode: Create a local HTTPS server with dynamic certificate
   */
  private handleConnectMITM(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const certManager = this.options.certManager!
    const targetKey = `${hostname}:${port}`

    // Get or create MITM server for this host
    let mitmInfo = this.mitmServers.get(targetKey)

    if (!mitmInfo) {
      // Generate certificate for this hostname
      let key: string
      let cert: string
      try {
        const certInfo = certManager.getCertForHost(hostname)
        key = certInfo.key
        cert = certInfo.cert
      } catch (err) {
        // Certificate generation failed, fall back to tunnel mode
        this.options.onError?.(err as Error, `cert-gen:${hostname}`)
        this.handleConnectTunnel(hostname, port, clientSocket, head)
        return
      }

      // Create HTTPS server for MITM
      const mitmServer = https.createServer({ key, cert })

      // Handle requests on MITM server
      mitmServer.on('request', (req, res) => {
        this.handleMITMRequest(hostname, port, req, res)
      })

      // Handle WebSocket upgrade on MITM server
      mitmServer.on('upgrade', (req, socket: net.Socket, head) => {
        this.handleMITMUpgrade(hostname, port, req, socket, head)
      })

      // Listen on random port
      mitmServer.listen(0, '127.0.0.1', () => {
        const addr = mitmServer.address() as net.AddressInfo
        mitmInfo = { server: mitmServer, port: addr.port }
        this.mitmServers.set(targetKey, mitmInfo)

        // Connect client to MITM server
        this.connectToMITM(clientSocket, head, mitmInfo.port)
      })

      mitmServer.on('error', (err) => {
        this.options.onError?.(err, `mitm:${hostname}`)
        clientSocket.end()
      })
    } else {
      // MITM server already exists
      this.connectToMITM(clientSocket, head, mitmInfo.port)
    }
  }

  /**
   * Connect client socket to MITM server
   */
  private connectToMITM(
    clientSocket: net.Socket,
    head: Buffer,
    mitmPort: number
  ): void {
    const mitmSocket = net.connect(mitmPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) {
        mitmSocket.write(head)
      }
      mitmSocket.pipe(clientSocket)
      clientSocket.pipe(mitmSocket)
    })

    mitmSocket.on('error', () => {
      clientSocket.end()
    })

    clientSocket.on('error', () => {
      mitmSocket.end()
    })
  }

  /**
   * Handle decrypted HTTPS request from MITM server
   */
  private handleMITMRequest(
    hostname: string,
    port: number,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse
  ): void {
    const requestId = generateRequestId()
    const fullUrl = `https://${hostname}${port !== 443 ? `:${port}` : ''}${clientReq.url || '/'}`

    const capturedRequest: CapturedRequest = {
      id: requestId,
      method: clientReq.method || 'GET',
      url: fullUrl,
      headers: normalizeHeaders(clientReq.headers),
      body: null,
      timestamp: Date.now()
    }

    // Collect request body
    const bodyChunks: Buffer[] = []
    clientReq.on('data', (chunk: Buffer) => {
      bodyChunks.push(chunk)
    })

    clientReq.on('end', () => {
      if (bodyChunks.length > 0) {
        capturedRequest.body = Buffer.concat(bodyChunks)
      }

      this.options.onRequest?.(capturedRequest)

      // Forward to actual target
      this.forwardMITMRequest(hostname, port, capturedRequest, clientRes)
    })
  }

  /**
   * Handle WebSocket upgrade from MITM server
   * Forward the upgrade request to the actual target and pipe the connection
   */
  private handleMITMUpgrade(
    hostname: string,
    port: number,
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const fullUrl = `wss://${hostname}${port !== 443 ? `:${port}` : ''}${clientReq.url || '/'}`

    // Log WebSocket connection for debugging
    this.options.onRequest?.({
      id: generateRequestId(),
      method: 'WEBSOCKET',
      url: fullUrl,
      headers: normalizeHeaders(clientReq.headers),
      body: null,
      timestamp: Date.now()
    })

    // Create custom agent with direct connection (bypasses system proxy)
    const directAgent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      rejectUnauthorized: false
    })
    // Override createConnection to bypass system proxy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(directAgent as any).createConnection = (
      _opts: Record<string, unknown>,
      oncreate: (err: Error | null, socket: net.Socket) => void
    ) => {
      const socket = tls.connect({
        host: hostname,
        port: port,
        servername: hostname,
        rejectUnauthorized: false,
        lookup: this.dnsLookup
      } as tls.ConnectionOptions)
      socket.on('error', (err) => {
        oncreate?.(err, undefined as unknown as net.Socket)
      })
      socket.on('secureConnect', () => {
        oncreate?.(null, socket)
      })
      return socket
    }

    // Build upgrade request to target server
    const requestOptions: https.RequestOptions = {
      hostname,
      port,
      path: clientReq.url || '/',
      method: 'GET',
      headers: { ...clientReq.headers } as https.RequestOptions['headers'],
      rejectUnauthorized: false,
      // Use custom agent with direct connection
      agent: directAgent,
      // SNI hostname for TLS
      servername: hostname
    }

    // Fix host header
    ;(requestOptions.headers as Record<string, string>)['host'] = port === 443 ? hostname : `${hostname}:${port}`

    const proxyReq = https.request(requestOptions)

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Build the upgrade response to send back to client
      let response = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) {
          const headerValue = Array.isArray(value) ? value.join(', ') : value
          response += `${key}: ${headerValue}\r\n`
        }
      }
      response += '\r\n'

      // Send upgrade response to client
      clientSocket.write(response)

      // Forward any initial data from proxy
      if (proxyHead.length > 0) {
        clientSocket.write(proxyHead)
      }

      // Forward any initial data from client
      if (head.length > 0) {
        proxySocket.write(head)
      }

      // Pipe bidirectionally
      proxySocket.pipe(clientSocket)
      clientSocket.pipe(proxySocket)

      // Handle errors
      proxySocket.on('error', () => {
        clientSocket.end()
      })

      clientSocket.on('error', () => {
        proxySocket.end()
      })

      // Handle close
      proxySocket.on('close', () => {
        clientSocket.end()
      })

      clientSocket.on('close', () => {
        proxySocket.end()
      })
    })

    proxyReq.on('error', (err) => {
      this.options.onError?.(err, `ws-upgrade:${fullUrl}`)
      clientSocket.end()
    })

    // Handle case where server responds with non-upgrade response
    proxyReq.on('response', (proxyRes) => {
      // Server rejected the upgrade, forward the response
      let response = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) {
          const headerValue = Array.isArray(value) ? value.join(', ') : value
          response += `${key}: ${headerValue}\r\n`
        }
      }
      response += '\r\n'
      clientSocket.write(response)

      proxyRes.pipe(clientSocket)
    })

    proxyReq.end()
  }

  /**
   * Forward MITM request to actual HTTPS target
   */
  private forwardMITMRequest(
    hostname: string,
    port: number,
    capturedRequest: CapturedRequest,
    clientRes: http.ServerResponse
  ): void {
    const url = new URL(capturedRequest.url)

    // Filter out hop-by-hop headers that shouldn't be forwarded
    const hopByHopHeaders = new Set([
      'connection',
      'keep-alive',
      'proxy-authenticate',
      'proxy-authorization',
      'proxy-connection',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'host' // We'll set this manually
    ])

    const filteredHeaders: Record<string, string> = {}
    for (const [key, value] of Object.entries(capturedRequest.headers)) {
      if (!hopByHopHeaders.has(key.toLowerCase())) {
        filteredHeaders[key] = value
      }
    }

    // Create custom agent with direct connection (bypasses system proxy)
    const directAgent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
      rejectUnauthorized: false
    })
    // Override createConnection to bypass system proxy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(directAgent as any).createConnection = (
      opts: tls.ConnectionOptions,
      oncreate: (err: Error | null, socket?: net.Socket) => void
    ) => {
      this.options.onError?.(new Error(`createConnection called for ${hostname}:${port}`), 'mitm-create-conn')

      const socket = tls.connect({
        ...opts,
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: false,
        lookup: this.dnsLookup
      })

      this.options.onError?.(new Error(`tls.connect called, socket connecting=${socket.connecting}, pending=${socket.pending}`), 'mitm-tcp-created')

      // Set timeout after socket is created
      socket.setTimeout(10000)

      socket.on('connect', () => {
        this.options.onError?.(new Error(`TCP connected to ${hostname}:${port}`), 'mitm-tcp-connect')
      })
      socket.on('secureConnect', () => {
        oncreate?.(null, socket)
      })
      socket.on('error', (err) => {
        this.options.onError?.(err, `mitm-tcp-socket-error:${hostname}`)
        oncreate?.(err, undefined)
      })
      socket.on('timeout', () => {
        this.options.onError?.(new Error(`TCP socket timeout for ${hostname}`), 'mitm-tcp-timeout')
        socket.destroy(new Error('Connection timeout'))
      })
      socket.on('close', (hadError) => {
        this.options.onError?.(new Error(`TCP socket closed for ${hostname}, hadError=${hadError}`), 'mitm-tcp-close')
      })
      socket.on('lookup', (err, address, family, host) => {
        this.options.onError?.(new Error(`DNS lookup for ${host}: ${address} (family=${family}, err=${err})`), 'mitm-dns-lookup')
      })

      // Return the socket
      return socket
    }

    const requestOptions: https.RequestOptions = {
      hostname,
      port,
      path: url.pathname + url.search,
      method: capturedRequest.method,
      headers: filteredHeaders,
      // Don't verify certificate for target (we're proxying)
      rejectUnauthorized: false,
      // Add timeout to detect hanging requests
      timeout: 30000,
      // Use custom agent with direct connection
      agent: directAgent,
      // SNI hostname for TLS
      servername: hostname
    }

    // Set correct host header
    ;(requestOptions.headers as Record<string, string>)['host'] = port === 443 ? hostname : `${hostname}:${port}`

    this.options.onError?.(new Error(`Forwarding to ${hostname}:${port}${url.pathname}`), 'mitm-forward-start')
    this.options.onError?.(new Error(`Request options: ${JSON.stringify({ hostname, port, path: requestOptions.path, method: requestOptions.method })}`), 'mitm-forward-debug')

    const proxyReq = https.request(requestOptions, (proxyRes) => {
      this.options.onError?.(new Error(`Got response ${proxyRes.statusCode} from ${hostname}`), 'mitm-forward-response')
      this.handleResponse(capturedRequest, proxyRes, clientRes)
    })

    proxyReq.on('socket', (socket) => {
      this.options.onError?.(new Error(`Socket assigned for ${hostname}`), 'mitm-forward-socket')
      socket.on('connect', () => {
        this.options.onError?.(new Error(`Socket connected to ${hostname}`), 'mitm-forward-connected')
      })
      socket.on('secureConnect', () => {
        this.options.onError?.(new Error(`TLS handshake complete for ${hostname}`), 'mitm-forward-secure')
      })
    })

    proxyReq.on('timeout', () => {
      this.options.onError?.(new Error('Request timeout'), `mitm-forward-timeout:${capturedRequest.url}`)
      proxyReq.destroy()
      this.sendError(clientRes, 504, 'Gateway Timeout')
    })

    proxyReq.on('error', (err) => {
      this.options.onError?.(err, `mitm-forward:${capturedRequest.url}`)
      this.sendError(clientRes, 502, `Proxy Error: ${err.message}`)
    })

    if (capturedRequest.body) {
      proxyReq.write(capturedRequest.body)
    }
    proxyReq.end()
  }

  /**
   * Tunnel mode: Simple TCP tunnel without decryption
   */
  private handleConnectTunnel(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const serverSocket = net.connect(
      {
        host: hostname,
        port,
        lookup: this.dnsLookup
      },
      () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) {
          serverSocket.write(head)
        }
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
      }
    )

    serverSocket.on('error', () => {
      clientSocket.end()
    })

    clientSocket.on('error', () => {
      serverSocket.end()
    })
  }

  /**
   * Send error response
   */
  private sendError(res: http.ServerResponse, status: number, message: string): void {
    try {
      res.writeHead(status, { 'Content-Type': 'text/plain' })
      res.end(message)
    } catch {
      // Response already sent or client disconnected
    }
  }
}
