// M4: file-DAG partitioner — no two lanes write same file, cap 5.
// Merges conflicting file-sets into the same lane.

export interface LaneAssignment {
  id: string
  files: string[]
}

export function partitionFiles(fileSets: string[][]): LaneAssignment[] {
  const MAX_LANES = 5

  // Union-Find to merge conflicting sets that share a file.
  const parent = new Map<number, number>()
  const find = (i: number): number => {
    if (!parent.has(i)) parent.set(i, i)
    if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!))
    return parent.get(i)!
  }
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Map each file to the first set-index that claims it.
  const fileToSet = new Map<string, number>()
  for (let i = 0; i < fileSets.length; i++) {
    for (const f of fileSets[i]) {
      if (fileToSet.has(f)) {
        union(i, fileToSet.get(f)!)
      } else {
        fileToSet.set(f, i)
      }
    }
  }

  // Group set-indices by root.
  const groups = new Map<number, Set<string>>()
  for (let i = 0; i < fileSets.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, new Set())
    for (const f of fileSets[i]) groups.get(root)!.add(f)
  }

  // Convert to lane assignments, capped at MAX_LANES.
  let lanes: LaneAssignment[] = []
  let laneIdx = 0
  for (const [, files] of groups) {
    if (laneIdx >= MAX_LANES) {
      // Overflow: fold into the last lane (cap enforcement).
      for (const f of files) lanes[MAX_LANES - 1].files.push(f)
    } else {
      lanes.push({ id: `lane-${laneIdx + 1}`, files: [...files] })
      laneIdx++
    }
  }

  // Edge case: empty input → one empty-ish lane won't happen, but guard.
  if (lanes.length === 0 && fileSets.length > 0) {
    lanes = [{ id: 'lane-1', files: fileSets.flat() }]
  }

  return lanes
}
