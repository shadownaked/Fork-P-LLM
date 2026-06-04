/**
 * End-to-end proxy test script
 *
 * Tests the proxy server by sending requests to all configured sites
 * and verifying responses.
 *
 * Usage: npx ts-node scripts/test-proxy.ts
 *
 * Prerequisites:
 * - Proxy server must be running (npm start)
 * - Sites must have valid credentials captured
 */

import http from 'http'

const PROXY_URL = 'http://localhost:8080'

interface TestResult {
  site: string
  model: string
  success: boolean
  error?: string
  responseTime?: number
  contentLength?: number
  contentPreview?: string
}

async function fetchModels(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${PROXY_URL}/v1/models`, {
      method: 'GET'
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const models = json.data?.map((m: { id: string }) => m.id) || []
          resolve(models)
        } catch {
          reject(new Error(`Failed to parse models response: ${data}`))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function testChatCompletion(model: string, stream: boolean): Promise<TestResult> {
  const startTime = Date.now()

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Say "Hello, test passed!" and nothing else.' }],
      stream
    })

    const req = http.request(`${PROXY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const responseTime = Date.now() - startTime

        if (res.statusCode !== 200) {
          resolve({
            site: model,
            model,
            success: false,
            error: `HTTP ${res.statusCode}: ${data.substring(0, 200)}`,
            responseTime
          })
          return
        }

        let content = ''

        if (stream) {
          // Parse SSE format
          const lines = data.split('\n')
          for (const line of lines) {
            if (line.startsWith('data: ') && !line.includes('[DONE]')) {
              try {
                const json = JSON.parse(line.substring(6))
                if (json.choices?.[0]?.delta?.content) {
                  content += json.choices[0].delta.content
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
        } else {
          // Parse JSON response
          try {
            const json = JSON.parse(data)
            content = json.choices?.[0]?.message?.content || ''
          } catch {
            resolve({
              site: model,
              model,
              success: false,
              error: `Failed to parse response: ${data.substring(0, 200)}`,
              responseTime
            })
            return
          }
        }

        resolve({
          site: model,
          model,
          success: content.length > 0,
          responseTime,
          contentLength: content.length,
          contentPreview: content.substring(0, 100),
          error: content.length === 0 ? 'Empty response' : undefined
        })
      })
    })

    req.on('error', (err) => {
      resolve({
        site: model,
        model,
        success: false,
        error: err.message,
        responseTime: Date.now() - startTime
      })
    })

    // Timeout after 30 seconds
    req.setTimeout(30000, () => {
      req.destroy()
      resolve({
        site: model,
        model,
        success: false,
        error: 'Request timeout (30s)',
        responseTime: 30000
      })
    })

    req.write(body)
    req.end()
  })
}

async function runTests() {
  console.log('🔍 Fetching available models...\n')

  let models: string[]
  try {
    models = await fetchModels()
  } catch (err) {
    console.error('❌ Failed to fetch models. Is the proxy server running?')
    console.error(err)
    process.exit(1)
  }

  if (models.length === 0) {
    console.log('⚠️  No models available. Make sure you have captured credentials for at least one site.')
    process.exit(0)
  }

  console.log(`📋 Found ${models.length} model(s): ${models.join(', ')}\n`)

  const results: TestResult[] = []

  for (const model of models) {
    // Skip models without credentials
    if (model.includes('(no credentials)')) {
      console.log(`⏭️  Skipping ${model} (no credentials)\n`)
      continue
    }

    console.log(`🧪 Testing ${model}...`)

    // Test streaming
    console.log('   Testing stream mode...')
    const streamResult = await testChatCompletion(model, true)
    results.push({ ...streamResult, model: `${model} (stream)` })

    if (streamResult.success) {
      console.log(`   ✅ Stream: ${streamResult.responseTime}ms, ${streamResult.contentLength} chars`)
      console.log(`      Preview: "${streamResult.contentPreview}..."`)
    } else {
      console.log(`   ❌ Stream: ${streamResult.error}`)
    }

    // Test non-streaming
    console.log('   Testing non-stream mode...')
    const nonStreamResult = await testChatCompletion(model, false)
    results.push({ ...nonStreamResult, model: `${model} (non-stream)` })

    if (nonStreamResult.success) {
      console.log(`   ✅ Non-stream: ${nonStreamResult.responseTime}ms, ${nonStreamResult.contentLength} chars`)
      console.log(`      Preview: "${nonStreamResult.contentPreview}..."`)
    } else {
      console.log(`   ❌ Non-stream: ${nonStreamResult.error}`)
    }

    console.log('')
  }

  // Summary
  console.log('\n📊 Test Summary')
  console.log('═'.repeat(60))

  const passed = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success).length

  console.log(`✅ Passed: ${passed}`)
  console.log(`❌ Failed: ${failed}`)
  console.log(`📈 Total:  ${results.length}`)

  if (failed > 0) {
    console.log('\n❌ Failed tests:')
    for (const r of results.filter(r => !r.success)) {
      console.log(`   - ${r.model}: ${r.error}`)
    }
    process.exit(1)
  } else {
    console.log('\n🎉 All tests passed!')
    process.exit(0)
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
