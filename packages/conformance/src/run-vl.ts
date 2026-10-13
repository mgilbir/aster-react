/**
 * Vega-Lite compiler conformance: for each .vl.json corpus entry, compile with
 * @aster/vl (ours), render with @aster/core, and compare the canonicalized SVG
 * against real vega rendering of vega-lite.compile's output (the oracle).
 *
 * Usage: npx tsx src/run-vl.ts [filter]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
import { compile as compileOurs } from '@aster/vl'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = join(THIS_DIR, '..', 'corpus')

async function main(): Promise<boolean> {
  const filter = process.argv[2]
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.vl.json')).sort()
  let passed = 0
  let failed = 0
  let errored = 0
  const failures: string[] = []

  for (const f of files) {
    const name = f.replace(/\.vl\.json$/, '')
    if (filter && !name.includes(filter)) continue
    const doc = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8'))
    const spec = doc.spec ?? doc
    try {
      const oracleVg = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(spec).spec
      const ourVg = compileOurs(spec)
      const [oracleSvg, ourSvg] = await Promise.all([
        renderWithVega(oracleVg),
        loadSpecData(ourVg as never).then((loaded) => renderSpec(loaded as never)),
      ])
      const o = canonicalizeSvg(oracleSvg)
      const u = canonicalizeSvg(ourSvg as string)
      const diffs = diffCanonical(o, u)
      if (diffs.length === 0) {
        passed++
        console.log(`PASS  ${name}`)
      } else {
        failed++
        failures.push(name)
        console.log(`FAIL  ${name}`)
        // multiset diff is far easier to act on than positional diffs
        const count = (arr: string[]) => {
          const m = new Map<string, number>()
          for (const r of arr) m.set(r, (m.get(r) ?? 0) + 1)
          return m
        }
        const oc = count(o.records)
        const uc = count(u.records)
        const onlyOracle: string[] = []
        const onlyOurs: string[] = []
        for (const [r, n] of oc) {
          const d = n - (uc.get(r) ?? 0)
          for (let i = 0; i < Math.min(d, 3); i++) onlyOracle.push(r)
        }
        for (const [r, n] of uc) {
          const d = n - (oc.get(r) ?? 0)
          for (let i = 0; i < Math.min(d, 3); i++) onlyOurs.push(r)
        }
        if (o.records.length !== u.records.length) console.log(`      [count] oracle=${o.records.length} ours=${u.records.length}`)
        for (const r of onlyOracle.slice(0, 6)) console.log(`      oracle-only: ${r.slice(0, 200)}`)
        for (const r of onlyOurs.slice(0, 6)) console.log(`      ours-only:   ${r.slice(0, 200)}`)
        if (!onlyOracle.length && !onlyOurs.length) for (const d of diffs.slice(0, 3)) console.log(`      ${String(d).slice(0, 200)}`)
      }
    } catch (err) {
      errored++
      failures.push(name)
      console.log(`ERROR ${name}`)
      console.log(`      ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`.slice(0, 220))
    }
  }

  console.log(`\n[vl-conformance] ${passed} passed, ${failed} failed, ${errored} errored / ${passed + failed + errored}`)
  if (failures.length) console.log(`[vl-conformance] failing: ${failures.join(', ')}`)
  return failed === 0 && errored === 0
}

const ok = await main()
process.exit(ok ? 0 : 1)
