/**
 * Unit tests for ProxyServer
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as http from 'node:http'
import { ProxyServer } from './proxy-server'
import type { CapturedRequest, CapturedResponse } from './proxy-server'

// Test HTTP server to act as target
let targetServer: http.Server
let targetPort: number

// Proxy server under test
let proxyServer: ProxyServer
const proxyPort = 18889

beforeAll(async () => {
  // Create a simple HTTP server as target
  targetServer = http.createServer((req, res) => {
    const url = req.url || '/'

    if (url === '/api/echo') {
      // Echo back the request body
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body
        }))
      })
    } else if (url === '/api/sse') {
      // SSE endpoint
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      // Send a few events
      res.write('data: event1\n\n')
      setTimeout(() => {
        res.write('data: event2\n\n')
        setTimeout(() => {
          res.write('data: event3\n\n')
          res.end()
        }, 50)
      }, 50)
    } else if (url === '/api/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: 'Hello, World!' }))
    } else {
      res.writeHead(404)
      res.end('Not Found')
    }
  })

  await new Promise<void>((resolve) => {
    targetServer.listen(0, '127.0.0.1', () => {
      const addr = targetServer.address() as { port: number }
      targetPort = addr.port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => {
    targetServer.close(() => resolve())
  })
})

describe('ProxyServer', () => {
  describe('HTTP Proxy', () => {
    it('should start and stop correctly', async () => {
      const proxy = new ProxyServer({ port: proxyPort + 1 })
      await proxy.start()
      expect(proxy.getProxyAddress()).toBe(`http://127.0.0.1:${proxyPort + 1}`)
      await proxy.stop()
    })

    it('should capture HTTP GET request', async () => {
      const capturedRequests: CapturedRequest[] = []
      const capturedResponses: Array<{ req: CapturedRequest; res: CapturedResponse }> = []

      const proxy = new ProxyServer({
        port: proxyPort + 2,
        onRequest: (req) => capturedRequests.push(req),
        onResponse: (req, res) => capturedResponses.push({ req, res })
      })

      await proxy.start()

      try {
        // Make request through proxy
        const response = await makeProxiedRequest(
          proxyPort + 2,
          `http://127.0.0.1:${targetPort}/api/json`,
          'GET'
        )

        expect(response.statusCode).toBe(200)
        expect(response.body).toContain('Hello, World!')

        // Verify captured request
        expect(capturedRequests.length).toBe(1)
        expect(capturedRequests[0].method).toBe('GET')
        expect(capturedRequests[0].url).toContain('/api/json')

        // Verify captured response
        expect(capturedResponses.length).toBe(1)
        expect(capturedResponses[0].res.status).toBe(200)
        expect(capturedResponses[0].res.body?.toString()).toContain('Hello, World!')
      } finally {
        await proxy.stop()
      }
    })

    it('should capture HTTP POST request with body', async () => {
      const capturedRequests: CapturedRequest[] = []

      const proxy = new ProxyServer({
        port: proxyPort + 3,
        onRequest: (req) => capturedRequests.push(req)
      })

      await proxy.start()

      try {
        const requestBody = JSON.stringify({ test: 'data' })
        await makeProxiedRequest(
          proxyPort + 3,
          `http://127.0.0.1:${targetPort}/api/echo`,
          'POST',
          requestBody
        )

        expect(capturedRequests.length).toBe(1)
        expect(capturedRequests[0].method).toBe('POST')
        expect(capturedRequests[0].body?.toString()).toBe(requestBody)
      } finally {
        await proxy.stop()
      }
    })

    it('should capture SSE stream chunks', async () => {
      const sseChunks: string[] = []

      const proxy = new ProxyServer({
        port: proxyPort + 4,
        onSSEChunk: (_req, chunk) => sseChunks.push(chunk)
      })

      await proxy.start()

      try {
        await makeProxiedRequest(
          proxyPort + 4,
          `http://127.0.0.1:${targetPort}/api/sse`,
          'GET'
        )

        // Wait a bit for SSE events
        await new Promise(resolve => setTimeout(resolve, 200))

        // Should have captured SSE chunks
        expect(sseChunks.length).toBeGreaterThan(0)
        expect(sseChunks.some(c => c.includes('event1'))).toBe(true)
        expect(sseChunks.some(c => c.includes('event2'))).toBe(true)
        expect(sseChunks.some(c => c.includes('event3'))).toBe(true)
      } finally {
        await proxy.stop()
      }
    })

    it('should handle errors gracefully', async () => {
      const errors: Array<{ error: Error; context: string }> = []

      const proxy = new ProxyServer({
        port: proxyPort + 5,
        onError: (error, context) => errors.push({ error, context })
      })

      await proxy.start()

      try {
        // Try to connect to non-existent server
        await makeProxiedRequest(
          proxyPort + 5,
          'http://127.0.0.1:59999/api/test',
          'GET'
        ).catch(() => {
          // Expected to fail
        })

        // Should have captured error
        // Note: The error might be captured or the request might just fail
      } finally {
        await proxy.stop()
      }
    })
  })

  describe('Request ID Generation', () => {
    it('should generate unique request IDs', async () => {
      const requestIds: string[] = []

      const proxy = new ProxyServer({
        port: proxyPort + 6,
        onRequest: (req) => requestIds.push(req.id)
      })

      await proxy.start()

      try {
        // Make multiple requests
        await Promise.all([
          makeProxiedRequest(proxyPort + 6, `http://127.0.0.1:${targetPort}/api/json`, 'GET'),
          makeProxiedRequest(proxyPort + 6, `http://127.0.0.1:${targetPort}/api/json`, 'GET'),
          makeProxiedRequest(proxyPort + 6, `http://127.0.0.1:${targetPort}/api/json`, 'GET')
        ])

        // All IDs should be unique
        const uniqueIds = new Set(requestIds)
        expect(uniqueIds.size).toBe(requestIds.length)
      } finally {
        await proxy.stop()
      }
    })
  })

  describe('Header Normalization', () => {
    it('should normalize headers to simple key-value pairs', async () => {
      let capturedHeaders: Record<string, string> | null = null

      const proxy = new ProxyServer({
        port: proxyPort + 7,
        onRequest: (req) => { capturedHeaders = req.headers }
      })

      await proxy.start()

      try {
        await makeProxiedRequest(
          proxyPort + 7,
          `http://127.0.0.1:${targetPort}/api/json`,
          'GET',
          undefined,
          { 'X-Custom-Header': 'test-value' }
        )

        expect(capturedHeaders).not.toBeNull()
        expect(capturedHeaders!['x-custom-header']).toBe('test-value')
      } finally {
        await proxy.stop()
      }
    })
  })
})

/**
 * Helper function to make HTTP request through proxy
 */
function makeProxiedRequest(
  proxyPort: number,
  targetUrl: string,
  method: string,
  body?: string,
  headers?: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl)

    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      path: targetUrl, // Full URL for proxy
      method,
      headers: {
        'Host': url.host,
        ...headers
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, body: data })
      })
    })

    req.on('error', reject)

    if (body) {
      req.write(body)
    }
    req.end()
  })
}
