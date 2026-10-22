/**
 * Vega-Lite compiler conformance: for each .vl.json corpus entry, compile with
 * @aster/vl (ours), render with @aster/core, and compare the canonicalized SVG
 * against real vega rendering of vega-lite.compile's output (the oracle).
 *
 * Usage: npx tsx src/run-vl.ts [filter]
 *
 * Checks per entry (audit C39):
 *  1. @aster/vl compiles a DEEP-FROZEN copy of the spec (compile must never
 *     mutate its input — C73) and the emitted Vega must survive JSON round-trip.
 *  2. The emitted Vega is rendered through REAL vega; any vega error or
 *     warning fails the entry (Aster's own runtime is lenient, so rendering it
 *     only through Aster hid invalid Vega — C71). Messages that vega-lite's
 *     own output also triggers (data-dependent noise) are not counted.
 *  3. Real vega's rendering of OUR Vega must equal its rendering of
 *     vega-lite's output (canonicalized SVG): the emitted spec means the same
 *     thing as the reference in the engine that defines the semantics.
 *  4. (corpus/ only) Aster's rendering of our Vega must equal that reference.
 *
 * corpus/        -> checks 1-4.
 * corpus-vega-only/ -> checks 1-3. These specs compile to a Vega that Aster's
 *     runtime cannot yet render even from vega-lite's own output (see the README
 *     there for the per-case reason), so check 4 would fail on the REFERENCE,
 *     not on @aster/vl. They are still held to checks 1-3 in real vega.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
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
const DIRS: Array<{ dir: string; aster: boolean }> = [
  { dir: join(THIS_DIR, '..', 'corpus'), aster: true },
  { dir: join(THIS_DIR, '..', 'corpus-vega-only'), aster: false },
]

type Outcome = { kind: 'pass' } | { kind: 'fail' | 'error'; lines: string[] }

/** The multiset diff of two canonical SVGs, as printable lines. */
function multisetLines(o: { records: string[] }, u: { records: string[] }, diffs: unknown[]): string[] {
  const lines: string[] = []
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
  if (o.records.length !== u.records.length) lines.push(`[count] oracle=${o.records.length} ours=${u.records.length}`)
  for (const r of onlyOracle.slice(0, 6)) lines.push(`oracle-only: ${r.slice(0, 200)}`)
  for (const r of onlyOurs.slice(0, 6)) lines.push(`ours-only:   ${r.slice(0, 200)}`)
  if (!onlyOracle.length && !onlyOurs.length) for (const d of diffs.slice(0, 3)) lines.push(String(d).slice(0, 200))
  return lines
}

async function runCase(spec: Record<string, unknown>, aster: boolean): Promise<Outcome> {
  try {
    const oracleVg = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(spec).spec
    const before = JSON.stringify(spec)
    const ourVg = compileOurs(deepFreeze(JSON.parse(before)))
    const ourPlain = (): Record<string, unknown> => JSON.parse(JSON.stringify(ourVg))
    const [oracleSvg, checked, oracleChecked] = await Promise.all([
      renderWithVega(oracleVg),
      renderWithVegaChecked(ourPlain()),
      renderWithVegaChecked(oracleVg),
    ])
    const inherited = new Set([...oracleChecked.errors, ...oracleChecked.warnings])
    const bad = [
      ...checked.errors.filter((e) => !inherited.has(e)).map((e) => `error: ${e}`),
      ...checked.warnings.filter((w) => !inherited.has(w)).map((w) => `warn: ${w}`),
    ]
    if (bad.length) return { kind: 'error', lines: bad.slice(0, 4).map((m) => m.slice(0, 220)) }
    const o = canonicalizeSvg(oracleSvg)
    const vegaDiffs = checked.svg ? diffCanonical(o, canonicalizeSvg(checked.svg)) : ['no svg']
    if (vegaDiffs.length) {
      return { kind: 'fail', lines: [`real vega on our Vega differs from vega-lite's: ${String(vegaDiffs[0]).slice(0, 200)}`] }
    }
    if (!aster) return { kind: 'pass' }
    const ourSvg = renderSpec((await loadSpecData(ourPlain() as never)) as never)
    const u = canonicalizeSvg(ourSvg as string)
    const diffs = diffCanonical(o, u)
    if (diffs.length === 0) return { kind: 'pass' }
    return { kind: 'fail', lines: multisetLines(o, u, diffs) }
  } catch (err) {
    return { kind: 'error', lines: [`${err instanceof Error ? err.message.split('\n')[0] : String(err)}`.slice(0, 220)] }
  }
}

async function main(): Promise<boolean> {
  const filter = process.argv[2]
  let passed = 0
  let failed = 0
  let errored = 0
  const failures: string[] = []

  for (const { dir, aster } of DIRS) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter((f) => f.endsWith('.vl.json')).sort()
    for (const f of files) {
      const name = f.replace(/\.vl\.json$/, '')
      if (filter && !name.includes(filter)) continue
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      // Unwrap only true wrapper docs ({ spec: ... } without a $schema of its own);
      // VL repeat/facet specs carry a nested `spec` child we must NOT unwrap.
      const spec = doc.$schema ? doc : (doc.spec ?? doc)
      const r = await runCase(spec, aster)
      const tag = aster ? '' : ' [vega-only]'
      if (r.kind === 'pass') {
        passed++
        console.log(`PASS  ${name}${tag}`)
      } else {
        if (r.kind === 'fail') failed++
        else errored++
        failures.push(name)
        console.log(`${r.kind === 'fail' ? 'FAIL ' : 'ERROR'} ${name}${tag}`)
        for (const l of r.lines) console.log(`      ${l}`)
      }
    }
  }

  console.log(`\n[vl-conformance] ${passed} passed, ${failed} failed, ${errored} errored / ${passed + failed + errored}`)
  if (failures.length) console.log(`[vl-conformance] failing: ${failures.join(', ')}`)
  return failed === 0 && errored === 0
}

const ok = await main()
process.exit(ok ? 0 : 1)
