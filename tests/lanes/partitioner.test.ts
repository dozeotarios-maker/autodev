import { describe, it, expect } from 'vitest'
import { partitionFiles, LaneAssignment } from '../../src/lanes/partitioner.js'
import { tierSizing } from '../../src/engine/complexity.js'

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

describe('S2.5: partitionFiles maxLanes param', () => {
  it('XS tier laneCap=1 → at most 1 lane', () => {
    const sizing = tierSizing('XS')
    const fileSets = Array.from({ length: 8 }, (_, i) => [`src/file${i}.ts`])
    const lanes = partitionFiles(fileSets, sizing.laneCap)
    expect(lanes.length).toBeLessThanOrEqual(1)
    expect(sizing.laneCap).toBe(1)
  })

  it('S tier laneCap=2 → at most 2 lanes', () => {
    const sizing = tierSizing('S')
    const fileSets = Array.from({ length: 8 }, (_, i) => [`src/file${i}.ts`])
    const lanes = partitionFiles(fileSets, sizing.laneCap)
    expect(lanes.length).toBeLessThanOrEqual(2)
    expect(sizing.laneCap).toBe(2)
  })

  it('XL tier laneCap=5 → at most 5 lanes (same as default)', () => {
    const sizing = tierSizing('XL')
    const fileSets = Array.from({ length: 10 }, (_, i) => [`src/file${i}.ts`])
    const lanes = partitionFiles(fileSets, sizing.laneCap)
    expect(lanes.length).toBeLessThanOrEqual(5)
    expect(sizing.laneCap).toBe(5)
  })

  it('default maxLanes=5 (no arg) keeps existing behavior', () => {
    const fileSets = Array.from({ length: 10 }, (_, i) => [`src/file${i}.ts`])
    const lanes = partitionFiles(fileSets) // no maxLanes arg
    expect(lanes.length).toBeLessThanOrEqual(5)
  })
})
