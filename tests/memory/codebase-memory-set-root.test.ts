// Re-root coverage: CodebaseMemoryAdapter.setRepoRoot must reset the cached
// indexed state so a later ensureIndexed() indexes the NEW dir, not the old one.

import { describe, it, expect } from 'vitest'
import { CodebaseMemoryAdapter } from '../../src/memory/codebase-memory-adapter.js'

describe('CodebaseMemoryAdapter.setRepoRoot', () => {
  it('updates repoRoot and resets the cached project name', () => {
    const adapter = new CodebaseMemoryAdapter({ mock: true, repoRoot: '/old/root' })
    // Force a cached projectName to simulate "already indexed old dir"
    ;(adapter as unknown as { projectName: string | null }).projectName = 'old-root'

    adapter.setRepoRoot('/new/root')

    expect((adapter as unknown as { repoRoot: string }).repoRoot).toBe('/new/root')
    // Cached index name must be cleared so ensureIndexed re-indexes the new dir
    expect((adapter as unknown as { projectName: string | null }).projectName).toBeNull()
  })

  it('is a no-op-safe call that does not throw in mock mode', () => {
    const adapter = new CodebaseMemoryAdapter({ mock: true })
    expect(() => adapter.setRepoRoot('/another/dir')).not.toThrow()
    expect((adapter as unknown as { repoRoot: string }).repoRoot).toBe('/another/dir')
  })
})
