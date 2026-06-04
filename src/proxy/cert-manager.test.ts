/**
 * Unit tests for CertManager (Electron Local Trust)
 *
 * These tests verify:
 * 1. CA certificate generation
 * 2. Host certificate generation
 * 3. Certificate caching
 * 4. Error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { CertManager, getCertFingerprint, getCertIssuer } from './cert-manager'

describe('CertManager', () => {
  let testDir: string
  let certManager: CertManager

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-test-'))
    certManager = new CertManager({
      certDir: testDir,
      caCommonName: 'Test CA',
      caOrganization: 'Test Org',
      caValidityDays: 30,
      hostValidityDays: 7
    })
  })

  afterEach(() => {
    // Clean up temporary directory
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  describe('initialize()', () => {
    it('should create CA certificate and key files', () => {
      certManager.initialize()

      const caKeyPath = path.join(testDir, 'ca.key')
      const caCertPath = path.join(testDir, 'ca.crt')

      expect(fs.existsSync(caKeyPath)).toBe(true)
      expect(fs.existsSync(caCertPath)).toBe(true)
    })

    it('should generate valid PEM format certificates', () => {
      certManager.initialize()

      const caCert = certManager.getCACertificate()
      expect(caCert).toContain('-----BEGIN CERTIFICATE-----')
      expect(caCert).toContain('-----END CERTIFICATE-----')
    })

    it('should reuse existing CA on subsequent initializations', () => {
      certManager.initialize()
      const firstFingerprint = certManager.getCAFingerprint()

      // Create new instance with same directory
      const certManager2 = new CertManager({ certDir: testDir })
      certManager2.initialize()
      const secondFingerprint = certManager2.getCAFingerprint()

      expect(firstFingerprint).toBe(secondFingerprint)
    })

    it('should be idempotent (multiple calls do nothing)', () => {
      certManager.initialize()
      const fingerprint1 = certManager.getCAFingerprint()

      certManager.initialize()
      const fingerprint2 = certManager.getCAFingerprint()

      expect(fingerprint1).toBe(fingerprint2)
    })

    it('should set initialized flag', () => {
      expect(certManager.isInitialized()).toBe(false)
      certManager.initialize()
      expect(certManager.isInitialized()).toBe(true)
    })
  })

  describe('getCertForHost()', () => {
    beforeEach(() => {
      certManager.initialize()
    })

    it('should generate certificate for hostname', () => {
      const cert = certManager.getCertForHost('example.com')

      expect(cert.key).toContain('-----BEGIN PRIVATE KEY-----')
      expect(cert.cert).toContain('-----BEGIN CERTIFICATE-----')
    })

    it('should cache certificates for same hostname', () => {
      const cert1 = certManager.getCertForHost('example.com')
      const cert2 = certManager.getCertForHost('example.com')

      // Should be the exact same object (cached)
      expect(cert1).toBe(cert2)
    })

    it('should generate different certificates for different hostnames', () => {
      const cert1 = certManager.getCertForHost('example.com')
      const cert2 = certManager.getCertForHost('other.com')

      expect(cert1.cert).not.toBe(cert2.cert)
    })

    it('should normalize hostname (lowercase)', () => {
      const cert1 = certManager.getCertForHost('Example.COM')
      const cert2 = certManager.getCertForHost('example.com')

      expect(cert1).toBe(cert2)
    })

    it('should handle IP addresses', () => {
      const cert = certManager.getCertForHost('127.0.0.1')

      expect(cert.key).toContain('-----BEGIN PRIVATE KEY-----')
      expect(cert.cert).toContain('-----BEGIN CERTIFICATE-----')
    })

    it('should throw error for invalid hostname', () => {
      expect(() => certManager.getCertForHost('')).toThrow('Invalid hostname')
      expect(() => certManager.getCertForHost(null as any)).toThrow('Invalid hostname')
    })

    it('should throw error if not initialized', () => {
      const uninitializedManager = new CertManager({ certDir: testDir })
      expect(() => uninitializedManager.getCertForHost('example.com')).toThrow('not initialized')
    })
  })

  describe('getCAFingerprint()', () => {
    it('should return SHA256 fingerprint', () => {
      certManager.initialize()
      const fingerprint = certManager.getCAFingerprint()

      // SHA256 fingerprint is 64 hex characters
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should throw error if not initialized', () => {
      expect(() => certManager.getCAFingerprint()).toThrow('not initialized')
    })
  })

  describe('isCertFromOurCA()', () => {
    beforeEach(() => {
      certManager.initialize()
    })

    it('should return true for certificates signed by our CA', () => {
      const hostCert = certManager.getCertForHost('example.com')
      const result = certManager.isCertFromOurCA(hostCert.cert)

      expect(result).toBe(true)
    })

    it('should return false if not initialized', () => {
      const uninitializedManager = new CertManager({ certDir: testDir })
      expect(uninitializedManager.isCertFromOurCA('some cert')).toBe(false)
    })
  })

  describe('clearCache()', () => {
    beforeEach(() => {
      certManager.initialize()
    })

    it('should clear certificate cache', () => {
      certManager.getCertForHost('example.com')
      expect(certManager.getCacheStats().size).toBe(1)

      certManager.clearCache()
      expect(certManager.getCacheStats().size).toBe(0)
    })

    it('should generate new certificate after cache clear', () => {
      const cert1 = certManager.getCertForHost('example.com')
      certManager.clearCache()
      const cert2 = certManager.getCertForHost('example.com')

      // Should be different objects (regenerated)
      expect(cert1).not.toBe(cert2)
    })
  })

  describe('getCacheStats()', () => {
    beforeEach(() => {
      certManager.initialize()
    })

    it('should return cache statistics', () => {
      certManager.getCertForHost('example.com')
      certManager.getCertForHost('other.com')

      const stats = certManager.getCacheStats()
      expect(stats.size).toBe(2)
      expect(stats.hosts).toContain('example.com')
      expect(stats.hosts).toContain('other.com')
    })
  })
})

describe('getCertFingerprint()', () => {
  let testDir: string
  let certManager: CertManager

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-test-'))
    certManager = new CertManager({ certDir: testDir })
    certManager.initialize()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('should extract SHA256 fingerprint from certificate', () => {
    const caCert = certManager.getCACertificate()
    const fingerprint = getCertFingerprint(caCert)

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  it('should throw error for invalid certificate', () => {
    expect(() => getCertFingerprint('invalid cert')).toThrow()
  })
})

describe('getCertIssuer()', () => {
  let testDir: string
  let certManager: CertManager

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-test-'))
    certManager = new CertManager({
      certDir: testDir,
      caCommonName: 'Test CA'
    })
    certManager.initialize()
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('should extract issuer from certificate', () => {
    const hostCert = certManager.getCertForHost('example.com')
    const issuer = getCertIssuer(hostCert.cert)

    expect(issuer).toContain('Test CA')
  })

  it('should return empty string for invalid certificate', () => {
    const issuer = getCertIssuer('invalid cert')
    expect(issuer).toBe('')
  })
})
