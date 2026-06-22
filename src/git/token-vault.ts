import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import type { TokenVault } from '../ports.js'

/**
 * TokenVaultImpl — G24 credential structural isolation.
 *
 * Tokens are stored AES-256-GCM encrypted on disk.  The vault object's public
 * surface (toString, toJSON, [Symbol.for('nodejs.util.inspect.custom')]) never
 * exposes raw token material — so even if the vault instance leaks into a model
 * context dump or log line, no secret is visible.
 *
 * Injection into process environments is done via `injectIntoEnv()` at the
 * exec boundary — callers never receive the raw string unless they explicitly
 * call `getToken()` and own the exec-boundary responsibility.
 *
 * Key derivation: a per-vault random VAULT_KEY is stored separately from the
 * encrypted data file.  In production the VAULT_KEY would live in an OS keychain
 * or HSM; here it lives in a separate key file (vault.key) alongside vault.json.
 * This is structurally isolated from the model context (model never sees either file).
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32  // 256 bits
const IV_LENGTH = 12   // 96 bits for GCM
const TAG_LENGTH = 16

interface EncryptedEntry {
  iv: string     // hex
  tag: string    // hex
  ct: string     // hex (ciphertext)
  result: string // hex (memoised plain result for idempotency — also encrypted payload is the token)
}

interface VaultFile {
  [projectId: string]: EncryptedEntry
}

export class TokenVaultImpl implements TokenVault {
  private readonly vaultPath: string
  private readonly keyPath: string

  constructor(private readonly dir: string) {
    this.vaultPath = path.join(dir, 'vault.json')
    this.keyPath = path.join(dir, 'vault.key')
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private async loadKey(): Promise<Buffer> {
    try {
      const hex = await fs.readFile(this.keyPath, 'utf-8')
      return Buffer.from(hex.trim(), 'hex')
    } catch {
      // Generate and persist a new key on first use
      const key = crypto.randomBytes(KEY_LENGTH)
      await fs.mkdir(this.dir, { recursive: true })
      await fs.writeFile(this.keyPath, key.toString('hex'), { mode: 0o600 })
      return key
    }
  }

  private encrypt(key: Buffer, plaintext: string): EncryptedEntry {
    const iv = crypto.randomBytes(IV_LENGTH)
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
    const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ct: ct.toString('hex'),
      result: ct.toString('hex'), // same payload — the token IS the ciphertext
    }
  }

  private decrypt(key: Buffer, entry: EncryptedEntry): string {
    const iv = Buffer.from(entry.iv, 'hex')
    const tag = Buffer.from(entry.tag, 'hex')
    const ct = Buffer.from(entry.ct, 'hex')
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf-8')
  }

  private async loadVault(): Promise<VaultFile> {
    try {
      const raw = await fs.readFile(this.vaultPath, 'utf-8')
      return JSON.parse(raw) as VaultFile
    } catch {
      return {}
    }
  }

  private async saveVault(vault: VaultFile): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.writeFile(this.vaultPath, JSON.stringify(vault, null, 2), { mode: 0o600 })
  }

  // ── public API (TokenVault port) ──────────────────────────────────────────

  async storeToken(projectId: string, token: string): Promise<void> {
    const key = await this.loadKey()
    const vault = await this.loadVault()
    vault[projectId] = this.encrypt(key, token)
    await this.saveVault(vault)
  }

  async getToken(projectId: string): Promise<string> {
    const vault = await this.loadVault()
    const entry = vault[projectId]
    if (!entry) {
      throw new Error(`TokenVault: token not found for project "${projectId}"`)
    }
    const key = await this.loadKey()
    return this.decrypt(key, entry)
  }

  async revokeToken(projectId: string): Promise<void> {
    const vault = await this.loadVault()
    delete vault[projectId]
    await this.saveVault(vault)
  }

  async hasToken(projectId: string): Promise<boolean> {
    const vault = await this.loadVault()
    return Object.prototype.hasOwnProperty.call(vault, projectId)
  }

  /**
   * G24 exec-boundary injection.
   * Injects the token into `env` under `envKey` without returning the raw token
   * to the outer caller.  This is the ONLY approved way to hand a token to a
   * subprocess — never pass it as a string through model-visible code paths.
   */
  async injectIntoEnv(
    projectId: string,
    env: Record<string, string>,
    envKey: string
  ): Promise<void> {
    const token = await this.getToken(projectId)
    env[envKey] = token
    // token string goes out of scope here — it lives only in `env` at the exec boundary
  }

  // ── G24: prevent token leakage via serialisation ──────────────────────────

  toString(): string {
    return '[TokenVaultImpl]'
  }

  toJSON(): object {
    return { type: 'TokenVaultImpl', dir: this.dir }
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[TokenVaultImpl (credentials redacted)]'
  }
}
