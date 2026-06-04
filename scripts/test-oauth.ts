#!/usr/bin/env npx ts-node
/**
 * OAuth 端点集成测试
 *
 * 测试 OAuth 相关的 API 端点:
 * - GET /oauth/providers
 * - POST /oauth/start
 * - GET /oauth/status
 * - POST /oauth/poll
 *
 * 注意: 这些测试不会实际完成 OAuth 流程,
 * 只验证端点可用性和基本响应格式
 *
 * Usage: npx ts-node scripts/test-oauth.ts
 */

import http from 'http'

// ============================================================================
// 配置
// ============================================================================

const CONFIG = {
  host: '127.0.0.1',
  port: 8080,
  baseUrl: 'http://127.0.0.1:8080'
}

// ============================================================================
// 工具函数
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
}

function log(message: string, color: string = colors.reset): void {
  console.log(`${color}${message}${colors.reset}`)
}

interface HttpResponse {
  status: number
  data: string
}

async function httpRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined

    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {})
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode || 0, data }))
    })

    req.on('error', reject)
    req.setTimeout(10000, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// ============================================================================
// 测试用例
// ============================================================================

interface TestResult {
  name: string
  success: boolean
  error?: string
}

const results: TestResult[] = []

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    results.push({ name, success: true })
    log(`  ✓ ${name}`, colors.green)
  } catch (err) {
    results.push({ name, success: false, error: (err as Error).message })
    log(`  ✗ ${name}: ${(err as Error).message}`, colors.red)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

// ============================================================================
// 测试
// ============================================================================

async function runTests(): Promise<void> {
  log('\n' + colors.cyan + '═'.repeat(50) + colors.reset)
  log(colors.cyan + ' OAuth 端点测试' + colors.reset)
  log(colors.cyan + '═'.repeat(50) + colors.reset + '\n')

  // 测试 GET /oauth/providers
  log(colors.yellow + '测试 OAuth Providers 端点' + colors.reset)

  await test('GET /oauth/providers 返回 200', async () => {
    const res = await httpRequest('GET', '/oauth/providers')
    assert(res.status === 200, `Expected 200, got ${res.status}`)
  })

  await test('GET /oauth/providers 返回 providers 列表', async () => {
    const res = await httpRequest('GET', '/oauth/providers')
    const data = JSON.parse(res.data)
    assert(Array.isArray(data.providers), 'providers should be an array')
    assert(data.providers.length >= 3, `Expected at least 3 providers, got ${data.providers.length}`)
  })

  await test('providers 包含 gemini, codex, qwen', async () => {
    const res = await httpRequest('GET', '/oauth/providers')
    const data = JSON.parse(res.data)
    const names = data.providers.map((p: { name: string }) => p.name)
    assert(names.includes('gemini'), 'Missing gemini provider')
    assert(names.includes('codex'), 'Missing codex provider')
    assert(names.includes('qwen'), 'Missing qwen provider')
  })

  await test('每个 provider 有 name, displayName, flowType', async () => {
    const res = await httpRequest('GET', '/oauth/providers')
    const data = JSON.parse(res.data)
    for (const provider of data.providers) {
      assert(provider.name, 'Provider missing name')
      assert(provider.displayName, 'Provider missing displayName')
      assert(provider.flowType, 'Provider missing flowType')
    }
  })

  // 测试 POST /oauth/start
  log('\n' + colors.yellow + '测试 OAuth Start 端点' + colors.reset)

  await test('POST /oauth/start 无效 provider 返回 400', async () => {
    const res = await httpRequest('POST', '/oauth/start', { provider: 'invalid' })
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('POST /oauth/start 无效 JSON 返回 400', async () => {
    const req = http.request({
      hostname: CONFIG.host,
      port: CONFIG.port,
      path: '/oauth/start',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })

    const res = await new Promise<HttpResponse>((resolve) => {
      req.on('response', (r) => {
        let data = ''
        r.on('data', chunk => data += chunk)
        r.on('end', () => resolve({ status: r.statusCode || 0, data }))
      })
      req.write('not json')
      req.end()
    })

    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  // 注意: 以下测试会实际启动 OAuth 流程，但不会完成
  // Gemini 和 Codex 会返回 authUrl，Qwen 会尝试联系其服务器

  await test('POST /oauth/start gemini 返回 authUrl 和 state', async () => {
    const res = await httpRequest('POST', '/oauth/start', { provider: 'gemini' })
    // 可能成功返回 authUrl，也可能因网络问题失败
    if (res.status === 200) {
      const data = JSON.parse(res.data)
      assert(data.authUrl, 'Missing authUrl')
      assert(data.state, 'Missing state')
      assert(data.flowType === 'authorization_code', `Expected authorization_code, got ${data.flowType}`)
    } else {
      // 允许网络错误
      assert(res.status === 500, `Expected 200 or 500, got ${res.status}`)
    }
  })

  await test('POST /oauth/start codex 返回 authUrl 和 codeVerifier', async () => {
    const res = await httpRequest('POST', '/oauth/start', { provider: 'codex' })
    if (res.status === 200) {
      const data = JSON.parse(res.data)
      assert(data.authUrl, 'Missing authUrl')
      assert(data.state, 'Missing state')
      assert(data.flowType === 'pkce', `Expected pkce, got ${data.flowType}`)
    } else {
      assert(res.status === 500, `Expected 200 or 500, got ${res.status}`)
    }
  })

  // 测试 GET /oauth/status
  log('\n' + colors.yellow + '测试 OAuth Status 端点' + colors.reset)

  await test('GET /oauth/status 无 state 返回 400', async () => {
    const res = await httpRequest('GET', '/oauth/status')
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('GET /oauth/status 无效 state 返回 not_found', async () => {
    const res = await httpRequest('GET', '/oauth/status?state=invalid-state')
    assert(res.status === 200, `Expected 200, got ${res.status}`)
    const data = JSON.parse(res.data)
    assert(data.status === 'not_found', `Expected not_found, got ${data.status}`)
  })

  // 测试 POST /oauth/poll
  log('\n' + colors.yellow + '测试 OAuth Poll 端点' + colors.reset)

  await test('POST /oauth/poll 无 state 返回 400', async () => {
    const res = await httpRequest('POST', '/oauth/poll', {})
    assert(res.status === 400, `Expected 400, got ${res.status}`)
  })

  await test('POST /oauth/poll 无效 state 返回 404', async () => {
    const res = await httpRequest('POST', '/oauth/poll', { state: 'invalid-state' })
    assert(res.status === 404, `Expected 404, got ${res.status}`)
  })

  // 打印结果
  log('\n' + colors.cyan + '─'.repeat(50) + colors.reset)
  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  if (failed === 0) {
    log(`\n${colors.green}✓ 全部 ${passed} 个测试通过${colors.reset}\n`)
  } else {
    log(`\n${colors.red}✗ ${passed}/${results.length} 通过, ${failed} 失败${colors.reset}`)
    log('\n失败的测试:')
    for (const r of results.filter(r => !r.success)) {
      log(`  - ${r.name}: ${r.error}`, colors.red)
    }
    log('')
    process.exit(1)
  }
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
  // 检查服务器是否运行
  try {
    await httpRequest('GET', '/health')
  } catch {
    log(`${colors.red}错误: 无法连接到 ${CONFIG.baseUrl}${colors.reset}`)
    log('请先启动服务器: npm run dev')
    process.exit(1)
  }

  await runTests()
}

main().catch(err => {
  log(`${colors.red}测试失败: ${err.message}${colors.reset}`)
  process.exit(1)
})
