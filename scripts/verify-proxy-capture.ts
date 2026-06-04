#!/usr/bin/env npx ts-node
/**
 * Proxy Capture Verification Script
 *
 * This script analyzes the captured requests in data/requests.json
 * and reports statistics about capture quality.
 *
 * Usage:
 *   npx ts-node scripts/verify-proxy-capture.ts
 *   # or
 *   npm run verify-capture
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

interface CapturedRequest {
  id: string
  timestamp: number
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  contentType: string | null
  response?: {
    status: number
    statusText: string
    headers: Record<string, string>
    body: string | null
    mimeType: string | null
  }
}

interface RequestsData {
  requests: Record<string, CapturedRequest[]>
}

function analyzeRequests(dataPath: string): void {
  console.log('='.repeat(60))
  console.log('Proxy Capture Verification Report')
  console.log('='.repeat(60))
  console.log()

  if (!fs.existsSync(dataPath)) {
    console.error(`Error: File not found: ${dataPath}`)
    console.log('\nTo generate capture data:')
    console.log('1. Start the application: npm start')
    console.log('2. Enable proxy capture in the Proxy menu')
    console.log('3. Open a site and browse around')
    console.log('4. Run this script again')
    process.exit(1)
  }

  const data: RequestsData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'))

  for (const [siteId, requests] of Object.entries(data.requests)) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Site: ${siteId}`)
    console.log('─'.repeat(60))

    const stats = {
      total: requests.length,
      withResponse: 0,
      withResponseBody: 0,
      withRequestBody: 0,
      byMethod: {} as Record<string, number>,
      byStatus: {} as Record<number, number>,
      byContentType: {} as Record<string, number>,
      compressed: {
        gzip: 0,
        br: 0,
        deflate: 0,
        none: 0
      },
      decompressedSuccessfully: 0
    }

    for (const req of requests) {
      // Method stats
      stats.byMethod[req.method] = (stats.byMethod[req.method] || 0) + 1

      // Request body
      if (req.body) {
        stats.withRequestBody++
      }

      // Response stats
      if (req.response) {
        stats.withResponse++

        // Status code
        stats.byStatus[req.response.status] = (stats.byStatus[req.response.status] || 0) + 1

        // Content type
        const ct = req.response.mimeType?.split(';')[0] || 'unknown'
        stats.byContentType[ct] = (stats.byContentType[ct] || 0) + 1

        // Compression
        const encoding = req.response.headers['content-encoding']?.toLowerCase()
        if (encoding === 'gzip') stats.compressed.gzip++
        else if (encoding === 'br') stats.compressed.br++
        else if (encoding === 'deflate') stats.compressed.deflate++
        else stats.compressed.none++

        // Response body
        if (req.response.body) {
          stats.withResponseBody++
          // If it was compressed but we have body, decompression worked
          if (encoding) {
            stats.decompressedSuccessfully++
          }
        }
      }
    }

    // Print stats
    console.log(`\nTotal Requests: ${stats.total}`)
    console.log(`With Response: ${stats.withResponse} (${percent(stats.withResponse, stats.total)})`)
    console.log(`With Response Body: ${stats.withResponseBody} (${percent(stats.withResponseBody, stats.withResponse)})`)
    console.log(`With Request Body: ${stats.withRequestBody} (${percent(stats.withRequestBody, stats.total)})`)

    console.log('\nBy Method:')
    for (const [method, count] of Object.entries(stats.byMethod).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${method}: ${count}`)
    }

    console.log('\nBy Status Code:')
    for (const [status, count] of Object.entries(stats.byStatus).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      console.log(`  ${status}: ${count}`)
    }

    console.log('\nBy Content Type (top 10):')
    const sortedCT = Object.entries(stats.byContentType).sort((a, b) => b[1] - a[1]).slice(0, 10)
    for (const [ct, count] of sortedCT) {
      console.log(`  ${ct}: ${count}`)
    }

    console.log('\nCompression:')
    console.log(`  gzip: ${stats.compressed.gzip}`)
    console.log(`  br (brotli): ${stats.compressed.br}`)
    console.log(`  deflate: ${stats.compressed.deflate}`)
    console.log(`  uncompressed: ${stats.compressed.none}`)

    const totalCompressed = stats.compressed.gzip + stats.compressed.br + stats.compressed.deflate
    if (totalCompressed > 0) {
      console.log(`\nDecompression Success Rate: ${stats.decompressedSuccessfully}/${totalCompressed} (${percent(stats.decompressedSuccessfully, totalCompressed)})`)
    }

    // Sample responses with body
    console.log('\nSample Responses with Body:')
    const samplesWithBody = requests
      .filter(r => r.response?.body)
      .slice(0, 5)

    if (samplesWithBody.length === 0) {
      console.log('  (none captured)')
    } else {
      for (const req of samplesWithBody) {
        const body = req.response!.body!
        const preview = body.length > 100 ? body.substring(0, 100) + '...' : body
        console.log(`  ${req.method} ${truncateUrl(req.url, 60)}`)
        console.log(`    Status: ${req.response!.status}`)
        console.log(`    Body: ${preview.replace(/\n/g, '\\n')}`)
        console.log()
      }
    }

    // Check for issues
    console.log('\nPotential Issues:')
    const issues: string[] = []

    if (stats.withResponse === 0) {
      issues.push('No responses captured - proxy may not be working')
    }

    if (stats.withResponse > 0 && stats.withResponseBody === 0) {
      issues.push('Responses captured but no bodies - decompression may be failing')
    }

    const compressedWithoutBody = totalCompressed - stats.decompressedSuccessfully
    if (compressedWithoutBody > 0) {
      issues.push(`${compressedWithoutBody} compressed responses failed to decompress`)
    }

    if (issues.length === 0) {
      console.log('  None detected - capture appears healthy!')
    } else {
      for (const issue of issues) {
        console.log(`  ⚠️  ${issue}`)
      }
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log('Verification Complete')
  console.log('='.repeat(60))
}

function percent(value: number, total: number): string {
  if (total === 0) return '0%'
  return `${Math.round((value / total) * 100)}%`
}

function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url
  return url.substring(0, maxLen - 3) + '...'
}

// Run
const dataPath = path.join(__dirname, '..', 'data', 'requests.json')
analyzeRequests(dataPath)
