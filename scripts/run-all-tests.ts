#!/usr/bin/env npx ts-node
/**
 * 一键测试脚本 - 运行所有测试并输出完整日志
 *
 * 包含:
 * 1. TypeScript 编译检查
 * 2. 单元测试 (vitest)
 * 3. API 服务器端点测试
 * 4. E2E 反代功能测试 (所有站点)
 *
 * Usage: npm run test:all
 *    或: npx ts-node scripts/run-all-tests.ts
 */

import { spawn, ChildProcess } from 'child_process'
import http from 'http'
import * as path from 'path'

// ============================================================================
// 配置
// ============================================================================

const CONFIG = {
  proxyHost: '127.0.0.1',
  proxyPort: 8080,
  proxyUrl: 'http://127.0.0.1:8080',
  startupTimeout: 15000,      // 等待服务器启动的超时时间
  requestTimeout: 60000,      // 单个请求的超时时间
  testPrompt: 'Say "Hello, test passed!" and nothing else.',
}

// ============================================================================
// 工具函数
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

function log(message: string, color: string = colors.reset): void {
  const timestamp = new Date().toISOString().substring(11, 23)
  console.log(`${colors.dim}[${timestamp}]${colors.reset} ${color}${message}${colors.reset}`)
}

function logSection(title: string): void {
  console.log('')
  console.log(colors.cyan + '═'.repeat(70) + colors.reset)
  console.log(colors.cyan + colors.bright + ` ${title}` + colors.reset)
  console.log(colors.cyan + '═'.repeat(70) + colors.reset)
  console.log('')
}

function logSubSection(title: string): void {
  console.log('')
  console.log(colors.blue + '─'.repeat(50) + colors.reset)
  console.log(colors.blue + ` ${title}` + colors.reset)
  console.log(colors.blue + '─'.repeat(50) + colors.reset)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ============================================================================
// HTTP 请求工具
// ============================================================================

interface HttpResponse {
  status: number
  data: string
  headers: http.IncomingHttpHeaders
  duration: number
}

async function httpRequest(
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<HttpResponse> {
  const startTime = Date.now()

  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, CONFIG.proxyUrl)
    const bodyStr = body ? JSON.stringify(body) : undefined

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
        ...headers
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        data,
        headers: res.headers,
        duration: Date.now() - startTime
      }))
    })

    req.on('error', reject)
    req.setTimeout(CONFIG.requestTimeout, () => {
      req.destroy()
      reject(new Error(`Request timeout after ${CONFIG.requestTimeout}ms`))
    })

    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// ============================================================================
// 测试结果收集
// ============================================================================

interface TestResult {
  name: string
  category: string
  success: boolean
  duration: number
  error?: string
  details?: string
}

const testResults: TestResult[] = []

function recordTest(result: TestResult): void {
  testResults.push(result)
  const icon = result.success ? colors.green + '✓' : colors.red + '✗'
  const durationStr = `${result.duration}ms`
  console.log(`  ${icon} ${colors.reset}${result.name} ${colors.dim}(${durationStr})${colors.reset}`)
  if (result.details) {
    console.log(`    ${colors.dim}${result.details}${colors.reset}`)
  }
  if (!result.success && result.error) {
    console.log(`    ${colors.red}Error: ${result.error}${colors.reset}`)
  }
}

// ============================================================================
// 1. TypeScript 编译测试
// ============================================================================

async function runTypeScriptBuild(): Promise<boolean> {
  logSection('1. TypeScript 编译检查')

  const startTime = Date.now()

  return new Promise((resolve) => {
    const proc = spawn('npm', ['run', 'build'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => { stdout += data.toString() })
    proc.stderr?.on('data', (data) => { stderr += data.toString() })

    proc.on('close', (code) => {
      const duration = Date.now() - startTime
      const success = code === 0

      recordTest({
        name: 'TypeScript 编译',
        category: 'build',
        success,
        duration,
        error: success ? undefined : stderr || stdout,
        details: success ? '无编译错误' : undefined
      })

      resolve(success)
    })
  })
}

// ============================================================================
// 2. 单元测试
// ============================================================================

async function runUnitTests(): Promise<boolean> {
  logSection('2. 单元测试 (Vitest)')

  const startTime = Date.now()

  return new Promise((resolve) => {
    const proc = spawn('npm', ['run', 'test'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const text = data.toString()
      stdout += text
      // 实时输出测试进度
      if (text.includes('✓') || text.includes('✗')) {
        process.stdout.write(colors.dim + text + colors.reset)
      }
    })
    proc.stderr?.on('data', (data) => { stderr += data.toString() })

    proc.on('close', (code) => {
      const duration = Date.now() - startTime
      const success = code === 0

      // 解析测试数量
      const passMatch = stdout.match(/(\d+) passed/)
      const failMatch = stdout.match(/(\d+) failed/)
      const passed = passMatch ? parseInt(passMatch[1]) : 0
      const failed = failMatch ? parseInt(failMatch[1]) : 0

      recordTest({
        name: '单元测试',
        category: 'unit',
        success,
        duration,
        error: success ? undefined : stderr,
        details: `${passed} 通过, ${failed} 失败`
      })

      resolve(success)
    })
  })
}

// ============================================================================
// 3. 启动代理服务器
// ============================================================================

let serverProcess: ChildProcess | null = null

async function startProxyServer(): Promise<boolean> {
  logSection('3. 启动代理服务器')

  log('正在启动 Electron 应用...', colors.yellow)

  return new Promise((resolve) => {
    serverProcess = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false
    })

    let started = false
    const startTime = Date.now()

    const checkServer = async () => {
      try {
        const res = await httpRequest('GET', '/health')
        if (res.status === 200) {
          if (!started) {
            started = true
            const duration = Date.now() - startTime
            log(`服务器已启动 (${duration}ms)`, colors.green)
            recordTest({
              name: '代理服务器启动',
              category: 'server',
              success: true,
              duration,
              details: `监听 ${CONFIG.proxyUrl}`
            })
            resolve(true)
          }
        }
      } catch {
        // 服务器还未就绪，继续等待
      }
    }

    // 轮询检查服务器状态
    const interval = setInterval(checkServer, 500)

    // 超时处理
    setTimeout(() => {
      if (!started) {
        clearInterval(interval)
        log('服务器启动超时', colors.red)
        recordTest({
          name: '代理服务器启动',
          category: 'server',
          success: false,
          duration: CONFIG.startupTimeout,
          error: '启动超时'
        })
        resolve(false)
      }
    }, CONFIG.startupTimeout)

    // 监听服务器输出
    serverProcess.stdout?.on('data', (data) => {
      const text = data.toString()
      // 只显示关键日志
      if (text.includes('[INFO]') && (
        text.includes('API Server listening') ||
        text.includes('Loaded') ||
        text.includes('Registered')
      )) {
        log(text.trim(), colors.dim)
      }
    })

    serverProcess.stderr?.on('data', (data) => {
      const text = data.toString()
      if (text.includes('error') || text.includes('Error')) {
        log(text.trim(), colors.red)
      }
    })

    serverProcess.on('error', (err) => {
      if (!started) {
        clearInterval(interval)
        log(`服务器启动失败: ${err.message}`, colors.red)
        resolve(false)
      }
    })
  })
}

function stopProxyServer(): void {
  if (serverProcess) {
    log('正在停止代理服务器...', colors.yellow)
    serverProcess.kill('SIGTERM')
    serverProcess = null
  }
}

// ============================================================================
// 4. API 端点测试
// ============================================================================

async function runApiEndpointTests(): Promise<boolean> {
  logSection('4. API 端点测试')

  let allPassed = true

  // 测试 /health
  logSubSection('健康检查')
  try {
    const res = await httpRequest('GET', '/health')
    const data = JSON.parse(res.data)
    const success = res.status === 200 && data.status === 'healthy'
    recordTest({
      name: 'GET /health',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? `uptime: ${data.uptime.toFixed(1)}s` : undefined,
      error: success ? undefined : `HTTP ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /health',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 /status
  logSubSection('系统状态')
  try {
    const res = await httpRequest('GET', '/status')
    const data = JSON.parse(res.data)
    const success = res.status === 200
    recordTest({
      name: 'GET /status',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? `站点: ${data.sites.total}, 模型: ${data.models.total}, 凭据: ${data.credentials.valid}` : undefined,
      error: success ? undefined : `HTTP ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /status',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 /v1/models
  logSubSection('模型列表')
  try {
    const res = await httpRequest('GET', '/v1/models')
    const data = JSON.parse(res.data)
    const success = res.status === 200 && data.object === 'list'
    const modelCount = data.data?.length || 0
    recordTest({
      name: 'GET /v1/models',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? `${modelCount} 个模型可用` : undefined,
      error: success ? undefined : `HTTP ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /v1/models',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 /debug/usage
  logSubSection('使用统计')
  try {
    const res = await httpRequest('GET', '/debug/usage')
    const data = JSON.parse(res.data)
    const success = res.status === 200 && data.summary !== undefined
    recordTest({
      name: 'GET /debug/usage',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? `总请求: ${data.summary.totalRequests}` : undefined,
      error: success ? undefined : `HTTP ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /debug/usage',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 CORS
  logSubSection('CORS 支持')
  try {
    const res = await httpRequest('OPTIONS', '/v1/models')
    const success = res.status === 204 && res.headers['access-control-allow-origin'] === '*'
    recordTest({
      name: 'OPTIONS /v1/models (CORS)',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? 'CORS 头正确' : undefined,
      error: success ? undefined : `HTTP ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'OPTIONS /v1/models (CORS)',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 404
  logSubSection('错误处理')
  try {
    const res = await httpRequest('GET', '/nonexistent')
    const success = res.status === 404
    recordTest({
      name: 'GET /nonexistent (404)',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? '正确返回 404' : undefined,
      error: success ? undefined : `期望 404, 得到 ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /nonexistent (404)',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // OAuth 端点测试
  logSubSection('OAuth 端点')

  // 测试 /oauth/providers
  try {
    const res = await httpRequest('GET', '/oauth/providers')
    const data = JSON.parse(res.data)
    const success = res.status === 200 && Array.isArray(data.providers) && data.providers.length >= 3
    recordTest({
      name: 'GET /oauth/providers',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? `${data.providers.length} 个 providers` : undefined,
      error: success ? undefined : `HTTP ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /oauth/providers',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 /oauth/start 无效 provider
  try {
    const res = await httpRequest('POST', '/oauth/start', { provider: 'invalid' })
    const success = res.status === 400
    recordTest({
      name: 'POST /oauth/start (无效 provider)',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? '正确返回 400' : undefined,
      error: success ? undefined : `期望 400, 得到 ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'POST /oauth/start (无效 provider)',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  // 测试 /oauth/status 无 state
  try {
    const res = await httpRequest('GET', '/oauth/status')
    const success = res.status === 400
    recordTest({
      name: 'GET /oauth/status (无 state)',
      category: 'api',
      success,
      duration: res.duration,
      details: success ? '正确返回 400' : undefined,
      error: success ? undefined : `期望 400, 得到 ${res.status}`
    })
    if (!success) allPassed = false
  } catch (err) {
    recordTest({
      name: 'GET /oauth/status (无 state)',
      category: 'api',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    allPassed = false
  }

  return allPassed
}

// ============================================================================
// 5. E2E 反代测试
// ============================================================================

interface ModelInfo {
  id: string
  owned_by: string
}

async function fetchAvailableModels(): Promise<ModelInfo[]> {
  const res = await httpRequest('GET', '/v1/models')
  const data = JSON.parse(res.data)
  return (data.data || []).filter((m: ModelInfo) => !m.owned_by.includes('no credentials'))
}

async function testChatCompletion(
  model: string,
  stream: boolean
): Promise<{ success: boolean; content: string; duration: number; error?: string }> {
  const startTime = Date.now()

  try {
    const res = await httpRequest('POST', '/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: CONFIG.testPrompt }],
      stream
    })

    const duration = Date.now() - startTime

    if (res.status !== 200) {
      return {
        success: false,
        content: '',
        duration,
        error: `HTTP ${res.status}: ${res.data.substring(0, 100)}`
      }
    }

    let content = ''

    if (stream) {
      // 解析 SSE 格式
      const lines = res.data.split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ') && !line.includes('[DONE]')) {
          try {
            const json = JSON.parse(line.substring(6))
            if (json.choices?.[0]?.delta?.content) {
              content += json.choices[0].delta.content
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } else {
      // 解析 JSON 响应
      const json = JSON.parse(res.data)
      content = json.choices?.[0]?.message?.content || ''
    }

    return {
      success: content.length > 0,
      content,
      duration,
      error: content.length === 0 ? '响应内容为空' : undefined
    }
  } catch (err) {
    return {
      success: false,
      content: '',
      duration: Date.now() - startTime,
      error: (err as Error).message
    }
  }
}

async function runE2EProxyTests(): Promise<boolean> {
  logSection('5. E2E 反代功能测试')

  let allPassed = true

  // 获取可用模型
  log('正在获取可用模型列表...', colors.yellow)
  let models: ModelInfo[]
  try {
    models = await fetchAvailableModels()
  } catch (err) {
    log(`获取模型列表失败: ${(err as Error).message}`, colors.red)
    recordTest({
      name: '获取模型列表',
      category: 'e2e',
      success: false,
      duration: 0,
      error: (err as Error).message
    })
    return false
  }

  if (models.length === 0) {
    log('没有可用的模型 (需要先捕获凭据)', colors.yellow)
    recordTest({
      name: '模型可用性检查',
      category: 'e2e',
      success: true,
      duration: 0,
      details: '无可用模型，跳过反代测试'
    })
    return true
  }

  log(`找到 ${models.length} 个可用模型`, colors.green)
  console.log('')

  // 按站点分组测试
  const modelsBySite = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const site = model.owned_by
    if (!modelsBySite.has(site)) {
      modelsBySite.set(site, [])
    }
    modelsBySite.get(site)!.push(model)
  }

  for (const [site, siteModels] of modelsBySite) {
    logSubSection(`站点: ${site}`)

    for (const model of siteModels) {
      console.log(`\n  ${colors.bright}模型: ${model.id}${colors.reset}`)

      // 测试流式响应
      const streamResult = await testChatCompletion(model.id, true)
      recordTest({
        name: `${model.id} (流式)`,
        category: 'e2e',
        success: streamResult.success,
        duration: streamResult.duration,
        details: streamResult.success
          ? `响应: "${streamResult.content.substring(0, 50)}${streamResult.content.length > 50 ? '...' : ''}"`
          : undefined,
        error: streamResult.error
      })
      if (!streamResult.success) allPassed = false

      // 等待一下避免请求过快
      await sleep(500)

      // 测试非流式响应
      const nonStreamResult = await testChatCompletion(model.id, false)
      recordTest({
        name: `${model.id} (非流式)`,
        category: 'e2e',
        success: nonStreamResult.success,
        duration: nonStreamResult.duration,
        details: nonStreamResult.success
          ? `响应: "${nonStreamResult.content.substring(0, 50)}${nonStreamResult.content.length > 50 ? '...' : ''}"`
          : undefined,
        error: nonStreamResult.error
      })
      if (!nonStreamResult.success) allPassed = false

      await sleep(500)
    }
  }

  return allPassed
}

// ============================================================================
// 6. 测试报告
// ============================================================================

function printTestReport(): void {
  logSection('测试报告')

  // 按类别分组
  const categories = new Map<string, TestResult[]>()
  for (const result of testResults) {
    if (!categories.has(result.category)) {
      categories.set(result.category, [])
    }
    categories.get(result.category)!.push(result)
  }

  const categoryNames: Record<string, string> = {
    build: '编译',
    unit: '单元测试',
    server: '服务器',
    api: 'API 端点',
    e2e: 'E2E 反代'
  }

  // 打印各类别统计
  console.log(colors.bright + '各类别统计:' + colors.reset)
  console.log('')

  let totalPassed = 0
  let totalFailed = 0

  for (const [category, results] of categories) {
    const passed = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success).length
    totalPassed += passed
    totalFailed += failed

    const icon = failed === 0 ? colors.green + '✓' : colors.red + '✗'
    const name = categoryNames[category] || category
    console.log(`  ${icon} ${colors.reset}${name}: ${passed}/${results.length} 通过`)
  }

  console.log('')
  console.log(colors.bright + '─'.repeat(40) + colors.reset)
  console.log('')

  // 总计
  const total = totalPassed + totalFailed
  const successRate = total > 0 ? Math.round((totalPassed / total) * 100) : 0

  if (totalFailed === 0) {
    console.log(colors.green + colors.bright + `  🎉 全部测试通过! (${totalPassed}/${total})` + colors.reset)
  } else {
    console.log(colors.red + colors.bright + `  ❌ 有测试失败 (${totalPassed}/${total}, ${successRate}% 通过率)` + colors.reset)
  }

  console.log('')

  // 打印失败的测试详情
  const failedTests = testResults.filter(r => !r.success)
  if (failedTests.length > 0) {
    console.log(colors.red + '失败的测试:' + colors.reset)
    for (const test of failedTests) {
      console.log(`  - ${test.name}: ${test.error}`)
    }
    console.log('')
  }

  // 打印使用统计
  console.log(colors.dim + '─'.repeat(40) + colors.reset)
  console.log('')
  const totalDuration = testResults.reduce((sum, r) => sum + r.duration, 0)
  console.log(colors.dim + `总耗时: ${(totalDuration / 1000).toFixed(2)}s` + colors.reset)
  console.log('')
}

// ============================================================================
// 主函数
// ============================================================================

async function main(): Promise<void> {
  console.log('')
  console.log(colors.cyan + colors.bright + '╔════════════════════════════════════════════════════════════════════╗' + colors.reset)
  console.log(colors.cyan + colors.bright + '║              LLM Proxy 一键测试脚本                                ║' + colors.reset)
  console.log(colors.cyan + colors.bright + '╚════════════════════════════════════════════════════════════════════╝' + colors.reset)
  console.log('')

  const startTime = Date.now()
  let exitCode = 0

  try {
    // 1. TypeScript 编译
    const buildSuccess = await runTypeScriptBuild()
    if (!buildSuccess) {
      log('编译失败，终止测试', colors.red)
      exitCode = 1
      return
    }

    // 2. 单元测试
    const unitSuccess = await runUnitTests()
    if (!unitSuccess) {
      log('单元测试失败', colors.red)
      exitCode = 1
      // 继续执行其他测试
    }

    // 3. 启动代理服务器
    const serverStarted = await startProxyServer()
    if (!serverStarted) {
      log('服务器启动失败，跳过集成测试', colors.red)
      exitCode = 1
      printTestReport()
      return
    }

    // 等待服务器完全就绪
    await sleep(2000)

    // 4. API 端点测试
    const apiSuccess = await runApiEndpointTests()
    if (!apiSuccess) {
      exitCode = 1
    }

    // 5. E2E 反代测试
    const e2eSuccess = await runE2EProxyTests()
    if (!e2eSuccess) {
      exitCode = 1
    }

  } catch (err) {
    log(`测试过程中发生错误: ${(err as Error).message}`, colors.red)
    exitCode = 1
  } finally {
    // 停止服务器
    stopProxyServer()

    // 打印报告
    printTestReport()

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(colors.dim + `总运行时间: ${totalTime}s` + colors.reset)
    console.log('')

    process.exit(exitCode)
  }
}

// 处理进程退出
process.on('SIGINT', () => {
  console.log('\n收到中断信号，正在清理...')
  stopProxyServer()
  process.exit(1)
})

process.on('SIGTERM', () => {
  stopProxyServer()
  process.exit(1)
})

// 运行
main()
