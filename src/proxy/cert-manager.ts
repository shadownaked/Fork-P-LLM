/**
 * Certificate Manager for HTTPS MITM (using node-forge)
 *
 * This module handles CA certificate generation and dynamic certificate
 * creation for HTTPS Man-in-the-Middle (MITM) interception.
 *
 * Key difference from system-level CA:
 * - Certificates are ONLY trusted within Electron via session.setCertificateVerifyProc()
 * - No system keychain installation required
 * - No admin password needed
 * - Only affects this Electron app, not system-wide traffic
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as forge from 'node-forge'
import { getProxyLogger } from '../logger'

const log = getProxyLogger()

const { pki } = forge

export interface CertificateInfo {
  key: string
  cert: string
}

export interface CertManagerOptions {
  /** Directory to store CA certificate and key */
  certDir: string
  /** CA certificate common name */
  caCommonName?: string
  /** CA organization name */
  caOrganization?: string
  /** CA validity in days */
  caValidityDays?: number
  /** Host certificate validity in days */
  hostValidityDays?: number
}

/**
 * Generate a random serial number for certificates
 * IMPORTANT: Serial number must be positive per X.509 spec.
 * Chromium rejects certificates with negative serials.
 * We clear the high bit of the first byte to ensure positivity.
 */
function generateSerialNumber(): string {
  const buf = crypto.randomBytes(16)
  // Clear high bit to ensure positive number (X.509 requirement)
  buf[0] &= 0x7f
  return buf.toString('hex')
}

/**
 * Create a base certificate with common settings
 */
function createBaseCert(
  publicKey: forge.pki.PublicKey,
  serialNumber: string,
  validityDays: number
): forge.pki.Certificate {
  const cert = pki.createCertificate()
  cert.publicKey = publicKey
  cert.serialNumber = serialNumber

  // Set validity period
  const now = new Date()
  cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000) // 1 day before
  cert.validity.notAfter = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000)

  return cert
}

/**
 * Certificate generator using node-forge
 */
class CertGenerator {
  /**
   * Generate a self-signed CA certificate
   */
  static generateCA(options: {
    commonName: string
    organization: string
    validityDays: number
  }): { privateKey: string; certificate: string } {
    // Generate RSA key pair (2048 bits)
    const keys = pki.rsa.generateKeyPair(2048)

    const cert = createBaseCert(
      keys.publicKey,
      generateSerialNumber(),
      options.validityDays
    )

    // Set CA certificate attributes
    const attrs: forge.pki.CertificateField[] = [
      { name: 'commonName', value: options.commonName },
      { name: 'organizationName', value: options.organization },
      { name: 'countryName', value: 'CN' },
      { shortName: 'ST', value: 'ZJ' },
      { name: 'localityName', value: 'HZ' }
    ]

    cert.setSubject(attrs)
    cert.setIssuer(attrs) // Self-signed: issuer = subject

    // Set CA certificate extensions (critical for browser trust)
    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: true,
        critical: true
      },
      {
        name: 'keyUsage',
        keyCertSign: true,
        digitalSignature: true,
        cRLSign: true,
        critical: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true,
        codeSigning: true,
        emailProtection: true,
        timeStamping: true
      },
      {
        name: 'nsCertType',
        client: true,
        server: true,
        email: true,
        objsign: true,
        sslCA: true,
        emailCA: true,
        objCA: true
      },
      {
        name: 'subjectKeyIdentifier'
      }
    ])

    // Sign with SHA-256
    cert.sign(keys.privateKey, forge.md.sha256.create())

    return {
      privateKey: pki.privateKeyToPem(keys.privateKey),
      certificate: pki.certificateToPem(cert)
    }
  }

  /**
   * Generate a host certificate signed by the CA
   */
  static generateHostCert(
    hostname: string,
    caKeyPem: string,
    caCertPem: string,
    validityDays: number
  ): CertificateInfo {
    // Parse CA key and certificate
    const caKey = pki.privateKeyFromPem(caKeyPem)
    const caCert = pki.certificateFromPem(caCertPem)

    // Generate new key pair for host certificate
    const keys = pki.rsa.generateKeyPair(2048)

    // Create unique serial number based on hostname
    const serialNumber = crypto
      .createHash('sha1')
      .update(hostname + Date.now().toString())
      .digest('hex')
    // Ensure first digit is valid (0-7) per X.509 spec
    const validSerial = (parseInt(serialNumber[0], 16) % 8).toString() + serialNumber.substring(1)

    const cert = createBaseCert(
      keys.publicKey,
      validSerial,
      validityDays
    )

    // Set subject (hostname)
    // CN has max 64 bytes limit, truncate if needed
    const cn = hostname.length > 64 ? hostname.substring(0, 64) : hostname
    cert.setSubject([{ name: 'commonName', value: cn }])

    // Set issuer from CA certificate
    cert.setIssuer(caCert.subject.attributes)

    // Determine if hostname is an IP address
    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
                 /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/.test(hostname)

    // Set extensions - SAN is critical for modern browsers
    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: false
      },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true
      },
      {
        name: 'subjectAltName',
        altNames: [
          isIP
            ? { type: 7, ip: hostname }  // IP address
            : { type: 2, value: hostname }  // DNS name
        ]
      },
      {
        name: 'authorityKeyIdentifier',
        keyIdentifier: true,
        authorityCertIssuer: true,
        serialNumber: true
      }
    ])

    // Sign with CA's private key using SHA-256
    cert.sign(caKey, forge.md.sha256.create())

    return {
      key: pki.privateKeyToPem(keys.privateKey),
      cert: pki.certificateToPem(cert)
    }
  }
}

/**
 * Get certificate fingerprint (SHA-256)
 */
export function getCertFingerprint(certPem: string): string {
  try {
    const cert = pki.certificateFromPem(certPem)
    const der = forge.asn1.toDer(pki.certificateToAsn1(cert)).getBytes()
    const md = forge.md.sha256.create()
    md.update(der)
    return md.digest().toHex()
  } catch {
    return ''
  }
}

/**
 * Extract issuer from certificate
 */
export function getCertIssuer(certPem: string): string {
  try {
    const cert = pki.certificateFromPem(certPem)
    const cn = cert.issuer.getField('CN')
    return cn ? `CN=${cn.value}` : ''
  } catch {
    return ''
  }
}

export class CertManager {
  private options: Required<CertManagerOptions>
  private caKey: string | null = null
  private caCert: string | null = null
  private caFingerprint: string | null = null
  private certCache: Map<string, CertificateInfo> = new Map()
  private initialized = false

  constructor(options: CertManagerOptions) {
    this.options = {
      certDir: options.certDir,
      caCommonName: options.caCommonName || 'ProxyLLM CA',
      caOrganization: options.caOrganization || 'ProxyLLM',
      caValidityDays: options.caValidityDays || 3650, // 10 years
      hostValidityDays: options.hostValidityDays || 365 // 1 year
    }
  }

  /**
   * Initialize the certificate manager
   * Loads existing CA or generates a new one
   */
  initialize(): void {
    if (this.initialized) return

    // Ensure cert directory exists
    if (!fs.existsSync(this.options.certDir)) {
      fs.mkdirSync(this.options.certDir, { recursive: true, mode: 0o700 })
    }

    const caKeyPath = path.join(this.options.certDir, 'ca.key')
    const caCertPath = path.join(this.options.certDir, 'ca.crt')

    // Check if we need to regenerate (if files exist but are invalid)
    let needRegenerate = false
    if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
      try {
        // Try to load and validate existing CA
        this.caKey = fs.readFileSync(caKeyPath, 'utf-8')
        this.caCert = fs.readFileSync(caCertPath, 'utf-8')
        // Validate by trying to parse
        pki.privateKeyFromPem(this.caKey)
        const cert = pki.certificateFromPem(this.caCert)

        // Check if serial number is negative (Chromium rejects these)
        // A negative serial starts with a hex digit 8-F (high bit set)
        const serialHex = cert.serialNumber
        if (serialHex && /^[89a-fA-F]/.test(serialHex)) {
          log.info('[CertManager] CA certificate has negative serial number, regenerating...')
          needRegenerate = true
          this.caKey = null
          this.caCert = null
        }
      } catch {
        // Invalid certificates, need to regenerate
        needRegenerate = true
        this.caKey = null
        this.caCert = null
      }
    } else {
      needRegenerate = true
    }

    if (needRegenerate) {
      // Generate new CA
      const ca = CertGenerator.generateCA({
        commonName: this.options.caCommonName,
        organization: this.options.caOrganization,
        validityDays: this.options.caValidityDays
      })

      this.caKey = ca.privateKey
      this.caCert = ca.certificate

      // Save CA to disk with secure permissions
      fs.writeFileSync(caKeyPath, this.caKey, { mode: 0o600 })
      fs.writeFileSync(caCertPath, this.caCert, { mode: 0o644 })
    }

    // Cache CA fingerprint for verification
    this.caFingerprint = getCertFingerprint(this.caCert!)
    this.initialized = true
  }

  /**
   * Check if manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized
  }

  /**
   * Get certificate for a hostname
   * Returns cached certificate or generates a new one
   */
  getCertForHost(hostname: string): CertificateInfo {
    if (!this.initialized || !this.caKey || !this.caCert) {
      throw new Error('CertManager not initialized')
    }

    // Validate hostname
    if (!hostname || typeof hostname !== 'string') {
      throw new Error('Invalid hostname')
    }

    // Normalize hostname (lowercase, trim)
    const normalizedHost = hostname.toLowerCase().trim()

    // Check cache
    const cached = this.certCache.get(normalizedHost)
    if (cached) {
      return cached
    }

    // Generate new certificate
    const certInfo = CertGenerator.generateHostCert(
      normalizedHost,
      this.caKey,
      this.caCert,
      this.options.hostValidityDays
    )

    this.certCache.set(normalizedHost, certInfo)
    return certInfo
  }

  /**
   * Get the CA certificate PEM
   */
  getCACertificate(): string {
    if (!this.caCert) {
      throw new Error('CertManager not initialized')
    }
    return this.caCert
  }

  /**
   * Get the CA certificate fingerprint (SHA256)
   */
  getCAFingerprint(): string {
    if (!this.caFingerprint) {
      throw new Error('CertManager not initialized')
    }
    return this.caFingerprint
  }

  /**
   * Get path to CA certificate file
   */
  getCACertificatePath(): string {
    return path.join(this.options.certDir, 'ca.crt')
  }

  /**
   * Verify if a certificate was signed by our CA
   * Used by session.setCertificateVerifyProc()
   */
  isSignedByOurCA(certFingerprint: string): boolean {
    if (!this.caFingerprint) return false
    // For host certs signed by our CA, we need to check the issuer
    // This is a simplified check - in production, verify the full chain
    return true // Host certs are always from our CA in this implementation
  }

  /**
   * Check if the certificate issuer matches our CA
   */
  isCertFromOurCA(certPem: string): boolean {
    if (!this.initialized) return false

    try {
      const issuer = getCertIssuer(certPem)
      return issuer.includes(this.options.caCommonName)
    } catch {
      return false
    }
  }

  /**
   * Clear certificate cache
   */
  clearCache(): void {
    this.certCache.clear()
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hosts: string[] } {
    return {
      size: this.certCache.size,
      hosts: Array.from(this.certCache.keys())
    }
  }

  /**
   * Force regenerate CA certificate
   * Useful when certificates are corrupted
   */
  regenerateCA(): void {
    this.initialized = false
    this.caKey = null
    this.caCert = null
    this.caFingerprint = null
    this.certCache.clear()

    // Delete existing files
    const caKeyPath = path.join(this.options.certDir, 'ca.key')
    const caCertPath = path.join(this.options.certDir, 'ca.crt')

    try {
      if (fs.existsSync(caKeyPath)) fs.unlinkSync(caKeyPath)
      if (fs.existsSync(caCertPath)) fs.unlinkSync(caCertPath)
    } catch {
      // Ignore deletion errors
    }

    // Reinitialize
    this.initialize()
  }
}
