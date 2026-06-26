// Live Letta round-trip probe — not a vitest test; run with: npx tsx scripts/letta-roundtrip.ts
import { LettaAdapter } from '../src/memory/letta-adapter.js'

const store = new LettaAdapter({ mock: false })
const runId = `test-roundtrip-${Date.now()}`
const lesson = 'Prior convention: always use kebab-case for file names in this repo'

try {
  const health = await store.healthCheck()
  console.log('healthCheck:', JSON.stringify(health))

  await store.store(runId, lesson, { tier: 'M', outcome: 'test' })
  console.log('store: OK')

  const store2 = new LettaAdapter({ mock: false })
  const hits = await store2.recall('kebab-case file names', 3)
  console.log('recall hits:', hits.length)
  if (hits.length > 0) {
    console.log('first hit value:', hits[0].value.slice(0, 100))
    const found = hits.some(h => h.value.includes('kebab-case'))
    console.log('round-trip:', found ? 'PASS' : 'stored value not in top-3 hits')
  } else {
    console.log('round-trip: 0 hits returned (vector search may need indexing time)')
  }
} catch (e) {
  console.error('ERROR:', e instanceof Error ? e.message : String(e))
}
