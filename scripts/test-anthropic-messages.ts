#!/usr/bin/env npx ts-node
/**
 * Claude /v1/messages 端点测试脚本
 *
 * 测试反代服务的 Anthropic Messages API 端点是否正常工作
 *
 * 使用方式:
 *   npx ts-node scripts/test-anthropic-messages.ts
 *
 * 环境变量:
 *   PROXY_HOST - 代理服务器地址 (默认: 127.0.0.1)
 *   PROXY_PORT - 代理服务器端口 (默认: 8080)
 *   ANTHROPIC_API_KEY - Anthropic API Key (测试直接转发时需要)
 */

import * as http from 'http'

// 配置
const PROXY_HOST = process.env.PROXY_HOST || '127.0.0.1'
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10)
const API_KEY = process.env.ANTHROPIC_API_KEY || 'test-api-key'
const BASE_URL = `http://${PROXY_HOST}:${PROXY_PORT}`

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}

function log(color: keyof typeof colors, ...args: unknown[]): void {
  console.log(colors[color], ...args, colors.reset)
}

// HTTP 请求封装
async function httpRequest(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: data,
        })
      })
    })

    req.on('error', reject)

    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

// 流式请求
async function streamRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  onEvent?: (event: string, data: string) => void
): Promise<{ status: number; events: Array<{ event: string; data: string }> }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      hostname: PROXY_HOST,
      port: PROXY_PORT,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...headers,
      },
    }

    const events: Array<{ event: string; data: string }> = []
    let buffer = ''

    const req = http.request(options, (res) => {
      res.on('data', (chunk) => {
        buffer += chunk.toString()

        // 解析 SSE 事件
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        let currentEvent = 'message'
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6)
            events.push({ event: currentEvent, data })
            if (onEvent) {
              onEvent(currentEvent, data)
            }
          }
        }
      })

      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          events,
        })
      })
    })

    req.on('error', reject)
    req.write(JSON.stringify(body))
    req.end()
  })
}

// 测试用例
interface TestResult {
  name: string
  passed: boolean
  message: string
  duration: number
}

const results: TestResult[] = []

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  const start = Date.now()
  log('cyan', `\n▶ 测试: ${name}`)

  try {
    await testFn()
    const duration = Date.now() - start
    results.push({ name, passed: true, message: 'OK', duration })
    log('green', `  ✓ 通过 (${duration}ms)`)
  } catch (error) {
    const duration = Date.now() - start
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, passed: false, message, duration })
    log('red', `  ✗ 失败: ${message}`)
  }
}

// 断言工具
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`)
  }
}

// ============ 测试用例 ============

async function testHealthEndpoint(): Promise<void> {
  const res = await httpRequest('GET', '/health')
  assertEqual(res.status, 200, 'Health check status')

  const body = JSON.parse(res.body)
  assertEqual(body.status, 'healthy', 'Health status')
  assert(typeof body.uptime === 'number', 'Uptime should be a number')
}

async function testStatusEndpoint(): Promise<void> {
  const res = await httpRequest('GET', '/status')
  assertEqual(res.status, 200, 'Status check status')

  const body = JSON.parse(res.body)
  assert(body.sites !== undefined, 'Should have sites field')
  assert(body.models !== undefined, 'Should have models field')
  assert(body.credentials !== undefined, 'Should have credentials field')
}

async function testModelsEndpoint(): Promise<void> {
  const res = await httpRequest('GET', '/v1/models')
  assertEqual(res.status, 200, 'Models endpoint status')

  const body = JSON.parse(res.body)
  assertEqual(body.object, 'list', 'Should return list object')
  assert(Array.isArray(body.data), 'Should have data array')
}

async function testMessagesEndpointNoAuth(): Promise<void> {
  // 测试无认证请求
  const res = await httpRequest('POST', '/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Hello' }],
  })

  // 应该返回 401 认证错误
  assertEqual(res.status, 401, 'Should return 401 without auth')

  const body = JSON.parse(res.body)
  assertEqual(body.type, 'error', 'Should return error type')
  assertEqual(body.error.type, 'authentication_error', 'Should be authentication error')
}

async function testMessagesEndpointInvalidJson(): Promise<void> {
  const options: http.RequestOptions = {
    hostname: PROXY_HOST,
    port: PROXY_PORT,
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
  }

  const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }))
    })
    req.on('error', reject)
    req.write('invalid json {{{')
    req.end()
  })

  assertEqual(result.status, 400, 'Should return 400 for invalid JSON')
}

async function testMessagesEndpointWithApiKey(): Promise<void> {
  // 测试带 x-api-key 的请求
  const res = await httpRequest(
    'POST',
    '/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
      stream: false,
    },
    {
      'x-api-key': API_KEY,
    }
  )

  // 如果 API Key 有效，应该返回 200
  // 如果无效，应该返回上游错误
  log('blue', `    响应状态: ${res.status}`)

  if (res.status === 200) {
    const body = JSON.parse(res.body)
    assert(body.content !== undefined, 'Should have content field')
    assertEqual(body.type, 'message', 'Should be message type')
    log('blue', `    模型响应: ${body.content[0]?.text?.substring(0, 50)}...`)
  } else {
    // 上游错误也是预期的（如果 API Key 无效）
    log('yellow', `    上游错误: ${res.body.substring(0, 100)}...`)
  }

  // 只要不是 5xx 服务器错误就算通过
  assert(res.status < 500, 'Should not return 5xx error')
}

async function testMessagesEndpointWithBearerAuth(): Promise<void> {
  // 测试带 Authorization Bearer 的请求
  const res = await httpRequest(
    'POST',
    '/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say "test" and nothing else.' }],
      stream: false,
    },
    {
      Authorization: `Bearer ${API_KEY}`,
    }
  )

  log('blue', `    响应状态: ${res.status}`)
  assert(res.status < 500, 'Should not return 5xx error')
}

async function testMessagesStreamEndpoint(): Promise<void> {
  // 测试流式请求
  log('blue', '    发送流式请求...')

  const eventTypes: string[] = []

  const res = await streamRequest(
    '/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      stream: true,
    },
    {
      'x-api-key': API_KEY,
    },
    (event, data) => {
      eventTypes.push(event)
      if (event === 'content_block_delta') {
        try {
          const parsed = JSON.parse(data)
          if (parsed.delta?.text) {
            process.stdout.write(parsed.delta.text)
          }
        } catch {
          // ignore parse errors
        }
      }
    }
  )

  console.log() // 换行

  log('blue', `    响应状态: ${res.status}`)
  log('blue', `    收到 ${res.events.length} 个事件`)
  log('blue', `    事件类型: ${[...new Set(eventTypes)].join(', ')}`)

  if (res.status === 200) {
    // 验证 SSE 事件格式
    assert(res.events.length > 0, 'Should receive SSE events')

    // 检查是否有 message_start 和 message_stop 事件
    const hasMessageStart = eventTypes.includes('message_start')
    const hasMessageStop = eventTypes.includes('message_stop')

    log(
      'blue',
      `    message_start: ${hasMessageStart}, message_stop: ${hasMessageStop}`
    )
  }

  assert(res.status < 500, 'Should not return 5xx error')
}

async function testProxyTakeoverMode(): Promise<void> {
  // 测试代理接管模式 (使用占位符 token)
  const PROXY_TOKEN_PLACEHOLDER = 'PROXY_MANAGED_TOKEN'

  const res = await httpRequest(
    'POST',
    '/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Hello' }],
    },
    {
      'x-api-key': PROXY_TOKEN_PLACEHOLDER,
    }
  )

  log('blue', `    代理接管模式响应状态: ${res.status}`)

  // 如果没有配置 anthropic 站点，应该返回 401
  // 如果配置了，应该正常工作
  if (res.status === 401) {
    const body = JSON.parse(res.body)
    log('yellow', `    预期行为: 无配置站点时返回认证错误`)
    assertEqual(body.error.type, 'authentication_error', 'Should be auth error')
  } else {
    log('green', `    代理接管模式正常工作`)
  }

  // 不应该返回 5xx 错误
  assert(res.status < 500, 'Should not return 5xx error')
}

async function testChatCompletionsEndpoint(): Promise<void> {
  // 测试 OpenAI 格式端点作为对比
  const res = await httpRequest(
    'POST',
    '/v1/chat/completions',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say "test"' }],
    },
    {
      Authorization: `Bearer ${API_KEY}`,
    }
  )

  log('blue', `    OpenAI 格式端点响应状态: ${res.status}`)

  // 应该返回 OpenAI 格式响应
  if (res.status === 200) {
    const body = JSON.parse(res.body)
    assert(body.choices !== undefined, 'Should have choices field')
    assertEqual(body.object, 'chat.completion', 'Should be chat.completion object')
  }
}

// ============ 主函数 ============

async function main(): Promise<void> {
  console.log('=' .repeat(60))
  log('cyan', '🧪 Claude /v1/messages 端点测试')
  console.log('=' .repeat(60))
  log('blue', `目标服务器: ${BASE_URL}`)
  log('blue', `API Key: ${API_KEY.substring(0, 10)}...`)
  console.log()

  // 首先检查服务是否运行
  try {
    await httpRequest('GET', '/health')
    log('green', '✓ 代理服务正在运行')
  } catch (error) {
    log('red', `✗ 无法连接到代理服务: ${error}`)
    log('yellow', '请先启动代理服务: npm run dev')
    process.exit(1)
  }

  // 运行测试
  await runTest('健康检查端点', testHealthEndpoint)
  await runTest('状态检查端点', testStatusEndpoint)
  await runTest('模型列表端点', testModelsEndpoint)
  await runTest('无认证请求 (应返回401)', testMessagesEndpointNoAuth)
  await runTest('无效 JSON 请求', testMessagesEndpointInvalidJson)
  await runTest('x-api-key 认证', testMessagesEndpointWithApiKey)
  await runTest('Bearer Token 认证', testMessagesEndpointWithBearerAuth)
  await runTest('流式请求', testMessagesStreamEndpoint)
  await runTest('代理接管模式', testProxyTakeoverMode)
  await runTest('OpenAI 格式端点对比', testChatCompletionsEndpoint)

  // 输出测试报告
  console.log('\n' + '=' .repeat(60))
  log('cyan', '📊 测试报告')
  console.log('=' .repeat(60))

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0)

  for (const result of results) {
    const icon = result.passed ? '✓' : '✗'
    const color = result.passed ? 'green' : 'red'
    log(color, `  ${icon} ${result.name} (${result.duration}ms)`)
    if (!result.passed) {
      log('red', `    └─ ${result.message}`)
    }
  }

  console.log()
  log('blue', `总计: ${results.length} 个测试`)
  log('green', `通过: ${passed}`)
  if (failed > 0) {
    log('red', `失败: ${failed}`)
  }
  log('blue', `耗时: ${totalDuration}ms`)

  // 退出码
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  log('red', '测试运行失败:', error)
  process.exit(1)
})
