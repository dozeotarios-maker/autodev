import { describe, it, expect } from 'vitest'
import { partitionFiles, LaneAssignment } from '../../src/lanes/partitioner.js'

describe('M4: file-DAG partitioner', () => {
  it('assigns non-conflicting files to separate lanes', () => {
    const fileSets = [
      ['src/auth.ts', 'src/login.ts'],
      ['src/db.ts', 'src/models.ts'],
      ['src/routes.ts'],
    ]
    const lanes = partitionFiles(fileSets)
    const allFiles = lanes.flatMap((l: LaneAssignment) => l.files)
    const unique = new Set(allFiles)
    expect(allFiles.length).toBe(unique.size)
  })

  it('caps at 5 lanes maximum', () => {
    const fileSets = Array.from({ length: 10 }, (_, i) => [`src/file${i}.ts`])
    const lanes = partitionFiles(fileSets)
    expect(lanes.length).toBeLessThanOrEqual(5)
  })

  it('returns at least 1 lane for any input', () => {
    const lanes = partitionFiles([['src/a.ts']])
    expect(lanes.length).toBeGreaterThanOrEqual(1)
  })

  it('merges conflicting file-sets into same lane', () => {
    const fileSets = [
      ['src/shared.ts', 'src/auth.ts'],
      ['src/shared.ts', 'src/db.ts'],
    ]
    const lanes = partitionFiles(fileSets)
    const lanesWithShared = lanes.filter((l: LaneAssignment) => l.files.includes('src/shared.ts'))
    expect(lanesWithShared).toHaveLength(1)
  })

  it('returns lane IDs as unique strings', () => {
    const fileSets = [['src/a.ts'], ['src/b.ts']]
    const lanes = partitionFiles(fileSets)
    const ids = lanes.map((l: LaneAssignment) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('each lane has a non-empty files array', () => {
    const fileSets = [['src/x.ts', 'src/y.ts'], ['src/z.ts']]
    const lanes = partitionFiles(fileSets)
    for (const lane of lanes) {
      expect(lane.files.length).toBeGreaterThan(0)
    }
  })
})
