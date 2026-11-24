/**
 * Vega-Lite compiler conformance: for each .vl.json corpus entry, compile with
 * @aster-charts/vl (ours), render with @aster-charts/core, and compare the canonicalized SVG
 * against real vega rendering of vega-lite.compile's output (the oracle).
 *
 * Usage: npx tsx src/run-vl.ts [filter]
 *
 * Checks per entry:
 *  1. @aster-charts/vl compiles a DEEP-FROZEN copy of the spec (compile must never
 *     mutate its input) and the emitted Vega must survive JSON round-trip.
 *  2. The emitted Vega is rendered through REAL vega; any vega error or
 *     warning fails the entry (Aster's own runtime is lenient, so rendering it
 *     only through Aster hid invalid Vega). Messages that vega-lite's
 *     own output also triggers (data-dependent noise) are not counted, but are printed as a `note:` under the entry (an entry that draws
 *     from no data is also refused by `pnpm conformance`, which holds the entries drawing no item to corpus-no-items.json).
 *  3. Real vega's rendering of OUR Vega must equal its rendering of
 *     vega-lite's output (canonicalized SVG): the emitted spec means the same
 *     thing as the reference in the engine that defines the semantics.
 *  4. (corpus/ only) Aster's rendering of our Vega must equal that reference.
 *
 * corpus/        -> checks 1-4.
 * corpus-vega-only/ -> checks 1-3, and check 4 is run too: these specs compile to a Vega that Aster's runtime cannot yet
 *     render even from vega-lite's own output (see the README there), so each one is listed in the expected-differences
 *     table (scripts/lib/expected-differences.mjs), which requires check 4 to STILL differ: a case Aster now renders fails
 *     the gate until it moves to corpus/.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): `vega-checked` counts the entries held to checks 1-3, `compared` the
 * entries whose Aster rendering was compared with the reference (check 4); both have floors on a full run, and a filter that
 * matches nothing fails. Run after `pnpm build` (it compiles and renders through the packages' dist).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { renderSpec } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile as compileOurs } from '@aster-charts/vl'
import { renderWithVega, renderWithVegaChecked } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { plantSvg } from './gate-plant.js'
import { deepFreeze, forEngines } from './engines.js'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: GATE_FLAGS, args: '[filter]' })

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const DIRS: Array<{ dir: string; aster: boolean }> = [
  { dir: join(THIS_DIR, '..', 'corpus'), aster: true },
  { dir: join(THIS_DIR, '..', 'corpus-vega-only'), aster: false },
]

/** `vega` is the verdict of checks 1-3; `aster` that of check 4 (null: not reached, because checks 1-3 failed). */
type Outcome = { kind: 'pass'; notes?: string[] } | { kind: 'fail' | 'error'; lines: string[] }
interface CaseResult { vega: Outcome; aster: Outcome | null }

/** The warnings real vega raises on vega-lite's own output that say something about the data (a headless run cannot resolve `window` event sources: that one is noise). */
const dataNotes = (warnings: readonly string[]): string[] => [...new Set(warnings.filter((w) => !/^Can not resolve event source/.test(w)))].map((w) => w.slice(0, 160))

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

/** The first place two lists of strings differ, printable; null when they are equal. */
function firstDifference(oracle: readonly string[], ours: readonly string[]): string | null {
  if (oracle.length !== ours.length) return `${oracle.length} items with a tooltip in vega-lite's output, ${ours.length} in ours`
  const i = oracle.findIndex((t, k) => t !== ours[k])
  return i < 0 ? null : `vega-lite: ${oracle[i]!.slice(0, 160)}  |  ours: ${ours[i]!.slice(0, 160)}`
}

async function runCase(spec: Record<string, unknown>, plant: boolean): Promise<CaseResult> {
  let vegaOk = false
  try {
    // each compiler its own copy of the input (ours deep-frozen: compile must never write onto its input), and every render its
    // own copy of the Vega it renders (vega writes onto the rows it ingests)
    const [oracleVg, ourVg] = forEngines(spec, (oracle, aster) => [
      (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(oracle).spec,
      compileOurs(deepFreeze(aster) as never) as unknown as Record<string, unknown>,
    ] as const)
    const ourPlain = (): Record<string, unknown> => JSON.parse(JSON.stringify(ourVg))
    const [oracleSvg, checked, oracleChecked] = await Promise.all([
      renderWithVega(structuredClone(oracleVg)),
      renderWithVegaChecked(ourPlain()),
      renderWithVegaChecked(structuredClone(oracleVg)),
    ])
    const inherited = new Set([...oracleChecked.errors, ...oracleChecked.warnings])
    const bad = [
      ...checked.errors.filter((e) => !inherited.has(e)).map((e) => `error: ${e}`),
      ...checked.warnings.filter((w) => !inherited.has(w)).map((w) => `warn: ${w}`),
    ]
    if (bad.length) return { vega: { kind: 'error', lines: bad.slice(0, 4).map((m) => m.slice(0, 220)) }, aster: null }
    const o = canonicalizeSvg(oracleSvg)
    const vegaDiffs = checked.svg ? diffCanonical(o, canonicalizeSvg(checked.svg)) : ['no svg']
    if (vegaDiffs.length) {
      return { vega: { kind: 'fail', lines: [`real vega on our Vega differs from vega-lite's: ${String(vegaDiffs[0]).slice(0, 200)}`] }, aster: null }
    }
    // (neither SVG carries a tooltip, so the SVGs above cannot see one: the items' tooltips are compared on their own)
    const tipDiff = firstDifference(oracleChecked.tooltips, checked.tooltips)
    if (tipDiff) return { vega: { kind: 'fail', lines: [`real vega on our Vega gives different tooltips than on vega-lite's: ${tipDiff}`] }, aster: null }
    vegaOk = true
    const notes = dataNotes(oracleChecked.warnings)
    const ourSvg = renderSpec((await loadSpecData(ourPlain() as never, TRUSTED_LOAD_OPTIONS)) as never) as string
    const u = canonicalizeSvg(plant ? plantSvg(ourSvg) : ourSvg)
    const diffs = diffCanonical(o, u)
    return { vega: { kind: 'pass', notes }, aster: diffs.length === 0 ? { kind: 'pass' } : { kind: 'fail', lines: multisetLines(o, u, diffs) } }
  } catch (err) {
    const failed: Outcome = { kind: 'error', lines: [`${err instanceof Error ? err.message.split('\n')[0] : String(err)}`.slice(0, 220)] }
    return vegaOk ? { vega: { kind: 'pass' }, aster: failed } : { vega: failed, aster: null }
  }
}

async function main(gate: Gate, filter: string | undefined): Promise<void> {
  let passed = 0
  let failed = 0
  let errored = 0
  for (const { dir, aster } of DIRS) {
    if (!existsSync(dir)) throw new Error(`corpus directory not found: ${dir}`)
    const files = readdirSync(dir).filter((f) => f.endsWith('.vl.json')).sort()
    for (const f of files) {
      const name = f.replace(/\.vl\.json$/, '')
      if (filter && !name.includes(filter)) continue
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      // Unwrap only true wrapper docs ({ spec: ... } without a $schema of its own);
      // VL repeat/facet specs carry a nested `spec` child we must NOT unwrap.
      const spec = doc.$schema ? doc : (doc.spec ?? doc)
      const r = await runCase(spec, gate.plant)
      const tag = aster ? '' : ' [vega-only]'
      // checks 1-3 (the emitted Vega in real vega) are a failure in either directory
      if (r.vega.kind === 'pass') gate.count('vega-checked')
      else gate.problem(`${name}${tag}: ${r.vega.kind === 'fail' ? 'emitted Vega differs in real vega' : 'error'}: ${r.vega.lines[0] ?? ''}`)
      // check 4 (Aster's rendering); for corpus-vega-only the expected-differences table requires it to still differ
      if (r.aster === null) { /* not reached */ } else if (r.aster.kind === 'pass') gate.agree(name)
      else if (r.aster.kind === 'fail') gate.differ(name, r.aster.lines[0] ?? 'differs')
      else gate.error(name, r.aster.lines[0] ?? 'error')
      const ok = r.vega.kind === 'pass' && (r.aster === null || r.aster.kind === 'pass')
      if (ok) {
        passed++
        console.log(`PASS  ${name}${tag}`)
        // (a warning the oracle itself raises is subtracted from the check above: it is printed so that an entry that draws from no data is seen)
        for (const n of (r.vega.kind === 'pass' ? r.vega.notes ?? [] : [])) console.log(`      note: the oracle warns: ${n}`)
      } else {
        const bad = r.vega.kind !== 'pass' ? r.vega : r.aster!
        if (bad.kind === 'fail') failed++
        else errored++
        console.log(`${bad.kind === 'fail' ? 'FAIL ' : 'ERROR'} ${name}${tag}`)
        if (bad.kind !== 'pass') for (const l of bad.lines) console.log(`      ${l}`)
      }
    }
  }
  console.log(`\n[vl-conformance] ${passed} passed, ${failed} failed, ${errored} errored / ${passed + failed + errored}`)
}

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'))
await runGate({
  name: 'conformance-vl',
  counters: {
    compared: { floor: 683, what: "Vega-Lite entries whose Aster rendering was compared with real vega's (check 4)" },
    'vega-checked': { floor: 683, what: 'Vega-Lite entries whose emitted Vega real vega rendered like vega-lite\'s (checks 1-3)' },
  },
  partial: Boolean(filter),
  run: (gate) => main(gate, filter),
})
