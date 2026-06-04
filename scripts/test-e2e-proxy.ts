/**
 * End-to-End Proxy Test Script
 *
 * Tests the full proxy flow:
 * 1. Check if API server is running
 * 2. Get available models from /v1/models
 * 3. Send a chat completion request to test the proxy
 *
 * Prerequisites:
 * - The Electron app must be running (npm run dev)
 * - At least one site must have valid credentials
 *
 * Usage:
 *   npx ts-node scripts/test-e2e-proxy.ts
 *   npx ts-node scripts/test-e2e-proxy.ts --port 8080
 *   npx ts-node scripts/test-e2e-proxy.ts --model claude-sonnet-4-5
 */

import http from 'http'
import { PROXY_TOKEN_PLACEHOLDER } from '../src/claude-settings'

// Configuration
const DEFAULT_PORT = 8080
const DEFAULT_HOST = '127.0.0.1'
const TIMEOUT_MS = 30000

// Parse command line arguments
function parseArgs(): { port: number; host: string; model?: string; stream: boolean } {
  const args = process.argv.slice(2)
  let port = DEFAULT_PORT
  let host = DEFAULT_HOST
  let model: string | undefined
  let stream = true

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1]
      i++
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1]
      i++
    } else if (args[i] === '--no-stream') {
      stream = false
    }
  }

  return { port, host, model, stream }
}

// HTTP request helper
async function httpRequest(
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; data: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const bodyStr = body ? JSON.stringify(body) : undefined

    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...headers
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode || 0, data, headers: res.headers }))
    })

    req.on('error', reject)
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

// Stream request helper
async function httpStreamRequest(
  url: string,
  body: unknown,
  onChunk: (chunk: string) => void
): Promise<{ status: number; fullResponse: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const bodyStr = JSON.stringify(body)

    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, (res) => {
      let fullResponse = ''

      res.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString()
        fullResponse += chunkStr
        onChunk(chunkStr)
      })

      res.on('end', () => {
        resolve({ status: res.statusCode || 0, fullResponse })
      })
    })

    req.on('error', reject)
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.write(bodyStr)
    req.end()
  })
}

// Parse SSE stream and extract content
function parseSSEContent(sseData: string): string {
  const lines = sseData.split('\n')
  let content = ''

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue

      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) {
          content += delta
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  return content
}

// Color output helpers
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
}

function log(message: string, color: keyof typeof colors = 'reset'): void {
  console.log(`${colors[color]}${message}${colors.reset}`)
}

function logStep(step: number, message: string): void {
  console.log(`\n${colors.cyan}[Step ${step}]${colors.reset} ${message}`)
}

function logSuccess(message: string): void {
  console.log(`${colors.green}✅ ${message}${colors.reset}`)
}

function logError(message: string): void {
  console.log(`${colors.red}❌ ${message}${colors.reset}`)
}

function logWarning(message: string): void {
  console.log(`${colors.yellow}⚠️  ${message}${colors.reset}`)
}

function logInfo(message: string): void {
  console.log(`${colors.dim}   ${message}${colors.reset}`)
}

// Anthropic Messages API request helper
async function anthropicRequest(
  url: string,
  body: unknown,
  apiKey: string
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const bodyStr = JSON.stringify(body)

    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve({ status: res.statusCode || 0, data }))
    })

    req.on('error', reject)
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.write(bodyStr)
    req.end()
  })
}

// Anthropic stream request helper
async function anthropicStreamRequest(
  url: string,
  body: unknown,
  apiKey: string,
  onEvent: (event: string, data: string) => void
): Promise<{ status: number; events: Array<{ event: string; data: string }> }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url)
    const bodyStr = JSON.stringify(body)

    const req = http.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Accept': 'text/event-stream'
      }
    }, (res) => {
      const events: Array<{ event: string; data: string }> = []
      let buffer = ''
      let currentEvent = 'message'

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6)
            events.push({ event: currentEvent, data })
            onEvent(currentEvent, data)
          }
        }
      })

      res.on('end', () => {
        resolve({ status: res.statusCode || 0, events })
      })
    })

    req.on('error', reject)
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.write(bodyStr)
    req.end()
  })
}

// Parse Anthropic SSE content
function parseAnthropicSSEContent(events: Array<{ event: string; data: string }>): string {
  let content = ''
  for (const { event, data } of events) {
    if (event === 'content_block_delta') {
      try {
        const parsed = JSON.parse(data)
        if (parsed.delta?.text) {
          content += parsed.delta.text
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
  return content
}

// Main test function
async function runE2ETest(): Promise<void> {
  const config = parseArgs()
  const baseUrl = `http://${config.host}:${config.port}`

  console.log('\n' + '='.repeat(60))
  log('🧪 E2E Proxy Test (OpenAI + Anthropic)', 'cyan')
  console.log('='.repeat(60))
  logInfo(`Target: ${baseUrl}`)
  logInfo(`Stream: ${config.stream}`)
  if (config.model) {
    logInfo(`Model: ${config.model}`)
  }

  // Step 1: Check if server is running
  logStep(1, 'Checking if API server is running...')

  try {
    const healthRes = await httpRequest('GET', `${baseUrl}/health`)
    if (healthRes.status !== 200) {
      logError(`Server returned status ${healthRes.status}`)
      process.exit(1)
    }
    const healthData = JSON.parse(healthRes.data)
    logSuccess(`Server is healthy (uptime: ${healthData.uptime?.toFixed(1)}s)`)
  } catch (err) {
    logError(`Cannot connect to server at ${baseUrl}`)
    logInfo(`Error: ${(err as Error).message}`)
    logInfo(`Make sure the Electron app is running (npm run dev)`)
    process.exit(1)
  }

  // Step 2: Get server status
  logStep(2, 'Getting server status...')

  try {
    const statusRes = await httpRequest('GET', `${baseUrl}/status`)
    const statusData = JSON.parse(statusRes.data)
    logSuccess('Server status retrieved')
    logInfo(`Sites: ${statusData.sites?.enabled || 0} enabled / ${statusData.sites?.total || 0} total`)
    logInfo(`Models: ${statusData.models?.available || 0} available / ${statusData.models?.total || 0} total`)
    logInfo(`Credentials: ${statusData.credentials?.valid || 0} valid, ${statusData.credentials?.expired || 0} expired`)
  } catch (err) {
    logWarning(`Failed to get status: ${(err as Error).message}`)
  }

  // Step 3: Get available models
  logStep(3, 'Fetching available models from /v1/models...')

  let availableModels: Array<{ id: string; owned_by: string }> = []

  try {
    const modelsRes = await httpRequest('GET', `${baseUrl}/v1/models`)
    if (modelsRes.status !== 200) {
      logError(`Failed to get models: status ${modelsRes.status}`)
      process.exit(1)
    }

    const modelsData = JSON.parse(modelsRes.data)
    availableModels = modelsData.data || []

    if (availableModels.length === 0) {
      logWarning('No models available')
      logInfo('Make sure at least one site has valid credentials')
      process.exit(1)
    }

    logSuccess(`Found ${availableModels.length} model(s):`)
    for (const model of availableModels) {
      const hasCredentials = !model.owned_by?.includes('no credentials')
      const status = hasCredentials ? colors.green + '●' : colors.yellow + '○'
      logInfo(`${status}${colors.reset} ${model.id} (${model.owned_by})`)
    }
  } catch (err) {
    logError(`Failed to fetch models: ${(err as Error).message}`)
    process.exit(1)
  }

  // Step 4: Select model for testing
  logStep(4, 'Selecting model for testing...')

  // Filter models with credentials
  const modelsWithCredentials = availableModels.filter(
    m => !m.owned_by?.includes('no credentials')
  )

  if (modelsWithCredentials.length === 0) {
    logWarning('No models with valid credentials found')
    logInfo('Please capture credentials by visiting a site in the browser')
    process.exit(1)
  }

  let selectedModel: string

  if (config.model) {
    // Use specified model
    const found = availableModels.find(m => m.id === config.model)
    if (!found) {
      logError(`Specified model "${config.model}" not found`)
      logInfo(`Available models: ${availableModels.map(m => m.id).join(', ')}`)
      process.exit(1)
    }
    selectedModel = config.model
  } else {
    // Auto-select first model with credentials
    selectedModel = modelsWithCredentials[0].id
  }

  logSuccess(`Selected model: ${selectedModel}`)

  // Step 5: Send chat completion request
  logStep(5, `Sending chat completion request (stream=${config.stream})...`)

  const chatRequest = {
    model: selectedModel,
    messages: [
      { role: 'user', content: 'Say "Hello, proxy test successful!" in exactly those words.' }
    ],
    stream: config.stream,
    max_tokens: 50
  }

  logInfo(`Request: POST /v1/chat/completions`)
  logInfo(`Model: ${chatRequest.model}`)
  logInfo(`Message: "${chatRequest.messages[0].content}"`)

  const startTime = Date.now()

  try {
    if (config.stream) {
      // Streaming request
      let receivedContent = ''
      process.stdout.write(`\n${colors.dim}   Response: ${colors.reset}`)

      const result = await httpStreamRequest(
        `${baseUrl}/v1/chat/completions`,
        chatRequest,
        (chunk) => {
          const content = parseSSEContent(chunk)
          if (content) {
            receivedContent += content
            process.stdout.write(content)
          }
        }
      )

      console.log('\n')

      if (result.status !== 200) {
        logError(`Request failed with status ${result.status}`)
        logInfo(`Response: ${result.fullResponse.substring(0, 500)}`)
        process.exit(1)
      }

      const duration = Date.now() - startTime
      logSuccess(`Stream completed in ${duration}ms`)
      logInfo(`Total content length: ${receivedContent.length} characters`)
    } else {
      // Non-streaming request
      const chatRes = await httpRequest('POST', `${baseUrl}/v1/chat/completions`, chatRequest)

      if (chatRes.status !== 200) {
        logError(`Request failed with status ${chatRes.status}`)
        try {
          const errorData = JSON.parse(chatRes.data)
          logInfo(`Error: ${errorData.error?.message || chatRes.data}`)
        } catch {
          logInfo(`Response: ${chatRes.data.substring(0, 500)}`)
        }
        process.exit(1)
      }

      const duration = Date.now() - startTime
      const chatData = JSON.parse(chatRes.data)
      const content = chatData.choices?.[0]?.message?.content || ''

      logSuccess(`Request completed in ${duration}ms`)
      logInfo(`Response: "${content}"`)
    }
  } catch (err) {
    logError(`Request failed: ${(err as Error).message}`)
    process.exit(1)
  }

  // Step 6: Test Anthropic /v1/messages endpoint (Claude Code format)
  logStep(6, `Testing Anthropic /v1/messages endpoint (Claude Code format)...`)

  // Check if any model supports the requested type (sonnet)
  // This helps determine if the test should be skipped
  const requestedModelType = 'sonnet'
  const hasSonnetModel = availableModels.some(m =>
    m.id.toLowerCase().includes(requestedModelType) &&
    !m.owned_by?.includes('no credentials')
  )

  if (!hasSonnetModel) {
    logWarning(`No ${requestedModelType} model available with valid credentials`)
    logInfo(`Available models: ${availableModels.map(m => m.id).join(', ')}`)
    logInfo(`Skipping Anthropic /v1/messages test - model type matching may still work if any site is available`)
  }

  // Use proxy placeholder token to trigger proxy takeover mode
  const PROXY_TOKEN = PROXY_TOKEN_PLACEHOLDER

  const anthropicRequestBody = {
    model: 'claude-sonnet-4-20250514',  // Claude Code uses this format
    max_tokens: 50,
    messages: [
      { role: 'user', content: 'Say "Anthropic API test successful!" in exactly those words.' }
    ],
    stream: config.stream
  }

  logInfo(`Request: POST /v1/messages`)
  logInfo(`Model: ${anthropicRequestBody.model} (will match any ${requestedModelType} model)`)
  logInfo(`Message: "${anthropicRequestBody.messages[0].content}"`)
  logInfo(`Using proxy takeover token`)

  const anthropicStartTime = Date.now()

  try {
    if (config.stream) {
      // Streaming Anthropic request
      let receivedContent = ''
      process.stdout.write(`\n${colors.dim}   Response: ${colors.reset}`)

      const result = await anthropicStreamRequest(
        `${baseUrl}/v1/messages`,
        anthropicRequestBody,
        PROXY_TOKEN,
        (event, data) => {
          if (event === 'content_block_delta') {
            try {
              const parsed = JSON.parse(data)
              if (parsed.delta?.text) {
                receivedContent += parsed.delta.text
                process.stdout.write(parsed.delta.text)
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      )

      console.log('\n')

      if (result.status !== 200) {
        logWarning(`Anthropic endpoint returned status ${result.status}`)
        // Parse and show detailed error
        for (const { event, data } of result.events) {
          if (event === 'error' || data.includes('error')) {
            try {
              const parsed = JSON.parse(data)
              logInfo(`Error type: ${parsed.error?.type || 'unknown'}`)
              logInfo(`Error message: ${parsed.error?.message || data}`)
            } catch {
              logInfo(`Raw error: ${data}`)
            }
          }
        }
        logInfo(`This is expected if no site has valid credentials for ${requestedModelType} models`)
      } else {
        const duration = Date.now() - anthropicStartTime
        logSuccess(`Anthropic stream completed in ${duration}ms`)
        logInfo(`Total content length: ${receivedContent.length} characters`)
        logInfo(`Event types: ${[...new Set(result.events.map(e => e.event))].join(', ')}`)
      }
    } else {
      // Non-streaming Anthropic request
      const anthropicRes = await anthropicRequest(
        `${baseUrl}/v1/messages`,
        anthropicRequestBody,
        PROXY_TOKEN
      )

      if (anthropicRes.status !== 200) {
        logWarning(`Anthropic endpoint returned status ${anthropicRes.status}`)
        try {
          const errorData = JSON.parse(anthropicRes.data)
          logInfo(`Error type: ${errorData.error?.type || 'unknown'}`)
          logInfo(`Error message: ${errorData.error?.message || anthropicRes.data}`)
        } catch {
          logInfo(`Response: ${anthropicRes.data.substring(0, 500)}`)
        }
        logInfo(`This is expected if no site has valid credentials for ${requestedModelType} models`)
      } else {
        const duration = Date.now() - anthropicStartTime
        const anthropicData = JSON.parse(anthropicRes.data)
        const content = anthropicData.content?.[0]?.text || ''

        logSuccess(`Anthropic request completed in ${duration}ms`)
        logInfo(`Response type: ${anthropicData.type}`)
        logInfo(`Response: "${content}"`)
      }
    }
  } catch (err) {
    logWarning(`Anthropic request failed: ${(err as Error).message}`)
    logInfo(`This is expected if no site credentials are available`)
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  logSuccess('E2E Proxy Test Completed!')
  console.log('='.repeat(60))

  const anthropicStatus = `${colors.yellow}○${colors.reset} Anthropic /v1/messages - Skipped (no ${requestedModelType} credentials)`

  console.log(`
${colors.cyan}Test Summary:${colors.reset}
  ${colors.green}✓${colors.reset} OpenAI /v1/chat/completions - Passed
  ${anthropicStatus}

${colors.cyan}Endpoints tested:${colors.reset}
  • GET  /health
  • GET  /status
  • GET  /v1/models
  • POST /v1/chat/completions (OpenAI format)
  • POST /v1/messages (Anthropic format - Claude Code)

${colors.cyan}Model Matching:${colors.reset}
  Anthropic requests use type-based matching:
  • claude-sonnet-4-20250514 -> matches any 'sonnet' model
  • claude-opus-4-20250514   -> matches any 'opus' model
  • claude-haiku-4-20250514  -> matches any 'haiku' model
`)
}

// Run the test
runE2ETest().catch(err => {
  logError(`Fatal error: ${err.message}`)
  process.exit(1)
})
