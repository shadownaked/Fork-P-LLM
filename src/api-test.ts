/**
 * API Test Module
 *
 * 用于测试 Claude Code 格式的 API 请求是否可用
 * 使用 Anthropic 原生格式 (/v1/messages + x-api-key)
 * 流式请求，只需收到首个 chunk 即判定成功
 */

import http from 'node:http'
import { getMainLogger } from './logger'
import { PROXY_TOKEN_PLACEHOLDER } from './claude-settings'

const log = getMainLogger()

export interface ApiTestResult {
  success: boolean
  responseTimeMs?: number
  error?: string
  httpStatus?: number
}

export interface ApiTestOptions {
  timeout?: number  // 超时时间，默认 30000ms
  model?: string    // 测试模型，默认 claude-3-haiku-20240307
}

const DEFAULT_TIMEOUT = 30000
const DEFAULT_MODEL = 'claude-3-haiku-20240307'

/**
 * 测试 Claude API 是否可用
 * 使用 Anthropic 原生格式发送流式请求
 *
 * @param proxyUrl 代理服务 URL，如 http://127.0.0.1:8080
 * @param options 测试选项
 */
export function testClaudeApi(
  proxyUrl: string,
  options: ApiTestOptions = {}
): Promise<ApiTestResult> {
  const timeout = options.timeout || DEFAULT_TIMEOUT
  const model = options.model || DEFAULT_MODEL

  return new Promise((resolve) => {
    const startTime = Date.now()

    // 解析 URL
    let url: URL
    try {
      url = new URL(proxyUrl)
    } catch {
      resolve({ success: false, error: 'Invalid proxy URL' })
      return
    }

    // 构建请求路径
    const basePath = url.pathname.replace(/\/$/, '')
    const messagesPath = basePath.endsWith('/v1')
      ? `${basePath}/messages`
      : `${basePath}/v1/messages`

    // 构建请求体 (Anthropic 格式)
    const requestBody = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true
    })

    const requestOptions: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: messagesPath,
      method: 'POST',
      timeout,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
        'x-api-key': PROXY_TOKEN_PLACEHOLDER,  // 使用占位符，代理会识别并注入真实凭证
        'anthropic-version': '2023-06-01'
      }
    }

    log.info(`[ApiTest] Testing API at ${url.hostname}:${url.port}${messagesPath} with model ${model}`)

    const req = http.request(requestOptions, (res) => {
      const responseTimeMs = Date.now() - startTime
      const httpStatus = res.statusCode

      // 检查 HTTP 状态
      if (!httpStatus || httpStatus >= 400) {
        let errorBody = ''
        res.on('data', (chunk) => {
          errorBody += chunk.toString()
        })
        res.on('end', () => {
          log.error(`[ApiTest] HTTP ${httpStatus}: ${errorBody}`)
          resolve({
            success: false,
            responseTimeMs,
            httpStatus,
            error: `HTTP ${httpStatus}: ${errorBody.slice(0, 200)}`
          })
        })
        return
      }

      // 流式响应：只需收到首个 chunk 即判定成功
      let receivedFirstChunk = false

      res.on('data', (chunk) => {
        if (!receivedFirstChunk) {
          receivedFirstChunk = true
          log.info(`[ApiTest] Received first chunk in ${responseTimeMs}ms`)

          // 立即销毁连接，不需要继续接收
          res.destroy()

          resolve({
            success: true,
            responseTimeMs,
            httpStatus
          })
        }
      })

      res.on('end', () => {
        if (!receivedFirstChunk) {
          log.warn(`[ApiTest] No data received`)
          resolve({
            success: false,
            responseTimeMs,
            httpStatus,
            error: 'No data received from API'
          })
        }
      })

      res.on('error', (err) => {
        if (!receivedFirstChunk) {
          log.error(`[ApiTest] Response error: ${err.message}`)
          resolve({
            success: false,
            responseTimeMs,
            httpStatus,
            error: `Response error: ${err.message}`
          })
        }
      })
    })

    req.on('timeout', () => {
      log.error(`[ApiTest] Request timeout after ${timeout}ms`)
      req.destroy()
      resolve({
        success: false,
        responseTimeMs: Date.now() - startTime,
        error: `Request timeout after ${timeout}ms`
      })
    })

    req.on('error', (err) => {
      log.error(`[ApiTest] Request error: ${err.message}`)
      resolve({
        success: false,
        responseTimeMs: Date.now() - startTime,
        error: `Request error: ${err.message}`
      })
    })

    req.write(requestBody)
    req.end()
  })
}
