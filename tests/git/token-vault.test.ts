// M5 token-vault test — D1 test-first
// G24: credential structural isolation — token injected at exec boundary, NEVER in model context
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

import { TokenVaultImpl } from '../../src/git/token-vault.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-vault-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('M5: TokenVault — G24 credential isolation', () => {
  it('stores and retrieves a token for a project', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await vault.storeToken('proj-a', 'ghp_supersecret123')
    const token = await vault.getToken('proj-a')
    expect(token).toBe('ghp_supersecret123')
  })

  it('hasToken returns true for known project, false for unknown', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await vault.storeToken('proj-b', 'tok123')
    expect(await vault.hasToken('proj-b')).toBe(true)
    expect(await vault.hasToken('proj-unknown')).toBe(false)
  })

  it('revokeToken removes the token', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await vault.storeToken('proj-c', 'tok456')
    await vault.revokeToken('proj-c')
    expect(await vault.hasToken('proj-c')).toBe(false)
    await expect(vault.getToken('proj-c')).rejects.toThrow(/not found/)
  })

  it('getToken throws for unknown project', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await expect(vault.getToken('no-such-project')).rejects.toThrow(/not found/)
  })

  // G24: token NEVER appears in model context — the vault file must NOT be
  // in a path that the model context scanner would expose, and the vault
  // object's public API must not leak the raw token via toString/toJSON/inspect.
  it('G24: vault object does not leak token via toString or JSON.stringify', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await vault.storeToken('proj-d', 'SUPER_SECRET_TOKEN')

    const str = String(vault)
    expect(str).not.toContain('SUPER_SECRET_TOKEN')

    const json = JSON.stringify(vault)
    expect(json).not.toContain('SUPER_SECRET_TOKEN')
  })

  // G24: token retrieved from vault must be injected at exec boundary only
  // Test: the vault's injectIntoEnv method adds the token to an env object
  // without returning the raw token string to the caller
  it('G24: injectIntoEnv injects token into env map at exec boundary', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await vault.storeToken('proj-e', 'ghp_boundary_token')

    const env: Record<string, string> = {}
    await vault.injectIntoEnv('proj-e', env, 'GH_TOKEN')

    // env now has the token under the key — this is the exec boundary injection
    expect(env['GH_TOKEN']).toBe('ghp_boundary_token')
  })

  it('G24: vault file is stored encrypted/encoded, not as plain-text token', async () => {
    const vault = new TokenVaultImpl(tmpDir)
    await vault.storeToken('proj-f', 'plaintext_secret_value')

    // Read the raw vault file — should NOT contain the raw token in plaintext
    const vaultFile = path.join(tmpDir, 'vault.json')
    const raw = await fs.readFile(vaultFile, 'utf-8')
    expect(raw).not.toContain('plaintext_secret_value')
  })
})
