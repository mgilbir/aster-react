/**
 * Vega-Lite compiler conformance: for each .vl.json corpus entry, compile with
 * @aster/vl (ours), render with @aster/core, and compare the canonicalized SVG
 * against real vega rendering of vega-lite.compile's output (the oracle).
 *
 * Usage: npx tsx src/run-vl.ts [filter]
 *
 * Three checks per entry (audit C39):
 *  1. @aster/vl compiles a DEEP-FROZEN copy of the spec (compile must never
 *     mutate its input — C73) and the emitted Vega must survive JSON round-trip.
 *  2. The emitted Vega is rendered through REAL vega; any vega error or
 *     warning fails the entry (Aster's own runtime is lenient, so rendering it
 *     only through Aster hid invalid Vega — C71).
 *  3. Aster's rendering of the emitted Vega must match real vega's rendering
 *     of vega-lite's own output (canonicalized SVG).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile as compileOurs } from '@aster/vl'
import { renderWithVega, renderWithVegaChecked } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

/** Recursively freeze so any in-place write by the compiler throws (ESM is strict). */
function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

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
    // Unwrap only true wrapper docs ({ spec: ... } without a $schema of its own);
    // VL repeat/facet specs carry a nested `spec` child we must NOT unwrap.
    const spec = doc.$schema ? doc : (doc.spec ?? doc)
    try {
      const oracleVg = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(spec).spec
      const before = JSON.stringify(spec)
      const ourVg = compileOurs(deepFreeze(JSON.parse(before)))
      const [oracleSvg, ourSvg, checked, oracleChecked] = await Promise.all([
        renderWithVega(oracleVg),
        loadSpecData(JSON.parse(JSON.stringify(ourVg)) as never, TRUSTED_LOAD_OPTIONS).then((loaded) => renderSpec(loaded as never)),
        renderWithVegaChecked(JSON.parse(JSON.stringify(ourVg))),
        renderWithVegaChecked(oracleVg),
      ])
      // A vega message that vega-lite's OWN output also triggers (e.g. an empty
      // outlier dataset's "Infinite extent") is data-dependent noise, not a
      // defect in what we emit; anything else is invalid Vega.
      const inherited = new Set([...oracleChecked.errors, ...oracleChecked.warnings])
      const bad = [
        ...checked.errors.filter((e) => !inherited.has(e)).map((e) => `error: ${e}`),
        ...checked.warnings.filter((w) => !inherited.has(w)).map((w) => `warn: ${w}`),
      ]
      if (bad.length) {
        errored++
        failures.push(name)
        console.log(`INVALID-VEGA ${name}`)
        for (const m of bad.slice(0, 4)) console.log(`      ${m}`.slice(0, 220))
        continue
      }
      // Real vega rendering OUR Vega must also equal vega-lite's output: this
      // catches output that is valid but means something different in real
      // vega than in Aster's (more lenient) runtime.
      const vegaDiffs = checked.svg ? diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(checked.svg)) : ['no svg']
      if (vegaDiffs.length) {
        failed++
        failures.push(name)
        console.log(`VEGA-DIFF ${name}`)
        console.log(`      real vega on our Vega differs from vega-lite's: ${String(vegaDiffs[0]).slice(0, 200)}`)
        continue
      }
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
