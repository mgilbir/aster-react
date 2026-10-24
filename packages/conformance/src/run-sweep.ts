/**
 * Schema-sweep runner (R8.4, ported from the Go aster project's sweep tests).
 *
 * For every (property, value) pair Vega's own schema declares, render one small
 * chart through upstream vega (oracle) and through @aster/core, and compare the
 * SVG. A value upstream refuses is still a case: "both refuse" is agreement.
 *
 * Usage: npx tsx src/run-sweep.ts <sweep-name> --floor N --min-ok N --max-node-error N [--filter substr]
 *   sweeps: vega-schema | vega-lite-schema | values | signals
 *
 * The run only passes when ALL of these hold (a vacuous run must never pass):
 *   - at least one case ran (a typo'd --filter runs zero and fails);
 *   - generated cases >= --floor (the schema walk did not silently shrink);
 *   - ok comparisons >= --min-ok (the comparisons did not all quietly degrade
 *     into "both refused"); not enforced with --filter, which runs a subset;
 *   - node-errors <= --max-node-error. A node-error is a case the ORACLE
 *     crashes on while Aster renders it; each is an upstream defect, so the
 *     count is a ceiling that can only be lowered, never a name allow-list;
 *   - zero differ and zero engine-error (Aster crashes are never reclassified).
 * --floor/--min-ok/--max-node-error are required unless --filter is given.
 */
import { mkdtempSync, readdirSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile as compileVL } from '@aster/vl'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const require = createRequire(import.meta.url)

/** Build a shim node_modules dir symlinking every package the sweep reads. */
function makeNodeModules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aster-sweep-'))
  mkdirSync(join(dir, 'node_modules'))
  const base = dirname(require.resolve('vega')) // .../vega/build
  const stores = [
    join(base, '..', '..'), // vega@x.y.z/node_modules (vega, vega-scenegraph, vega-projection)
    join(dirname(require.resolve('vega-lite')), '..', '..'), // vega-lite@x/node_modules
  ]
  const seen = new Set<string>()
  for (const store of stores) {
    let entries: string[] = []
    try {
      entries = readdirSync(store)
    } catch {
      continue
    }
    for (const name of entries) {
      if (seen.has(name) || name.startsWith('.')) continue
      seen.add(name)
      try {
        symlinkSync(join(store, name), join(dir, 'node_modules', name), 'dir')
      } catch {
        /* already linked */
      }
    }
  }
  return join(dir, 'node_modules')
}

interface SweepCase {
  name: string
  family: string
  property: string
  spec: Record<string, unknown>
  writes?: Array<{ name: string; value: unknown }>
  lite?: boolean
  /**
   * Test fixtures only: render this spec through Aster INSTEAD of `spec`, so a
   * fixture can produce a deterministic oracle/engine difference without
   * depending on whichever renderer defect happens to exist today.
   */
  ourSpec?: Record<string, unknown>
}

interface Status {
  ok: number
  bothRefused: number
  nodeError: number
  engineError: number
  differ: number
  nondeterministic: number
  failNames: string[]
}

/**
 * The ci0/ci1 bootstrap aggregates call Math.random inside vega-statistics, so
 * two renders of the same oracle spec differ. Only a *comparison difference* on
 * such a case may be reclassified, and only after the oracle is shown to
 * disagree with itself (see `oracleIsNondeterministic`). An Aster error is
 * never reclassified: a crash is a crash.
 */
function isBootstrapCase(c: SweepCase): boolean {
  return /-aggregate-ci[01]$/.test(c.name)
}

/** Render the oracle once. Throws on an oracle error. */
async function renderOracle(vgSpec: Record<string, unknown>, writes: SweepCase['writes']): Promise<string> {
  const runtime = vega.parse(vgSpec as never)
  const view = new (vega as any).View(runtime, { renderer: 'none' })
  try {
    await view.runAsync()
    let svg: string = await view.toSVG()
    // signals sweep: write the requested signals and re-render
    for (const w of writes ?? []) {
      view.signal(w.name, w.value)
      await view.runAsync()
    }
    if (writes?.length) svg = await view.toSVG()
    return svg
  } finally {
    view.finalize()
  }
}

/** True when two oracle renders of the same spec canonicalize differently. */
async function oracleIsNondeterministic(vgSpec: Record<string, unknown>, writes: SweepCase['writes'], first: string): Promise<boolean> {
  try {
    const again = await renderOracle(vgSpec, writes)
    return diffCanonical(canonicalizeSvg(first), canonicalizeSvg(again)).length > 0
  } catch {
    return false // cannot show nondeterminism => treat as a real difference
  }
}

async function runOneCase(c: SweepCase, nodeModules: string): Promise<'ok' | 'both-refused' | 'node-error' | 'engine-error' | 'differ' | 'nondeterministic'> {
  // Vega-Lite cases compare the compiled Vega: upstream vl.compile vs
  // @aster/vl, each rendered through its own engine (a VL defect lives in
  // the spec it emits — see the sweep's header note).
  let vgSpec = c.spec as Record<string, unknown>
  let ourVgSpec = (c.ourSpec ?? c.spec) as Record<string, unknown>
  if (c.lite) {
    try {
      vgSpec = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(c.spec).spec
    } catch (e) {
      // upstream refuses to compile: an agreement only if we refuse too
      try {
        compileVL(c.spec as never)
        console.error(`  [node-error] ${c.name}: ${(e as Error).message.split('\n')[0]}`)
        return 'node-error'
      } catch {
        return 'both-refused'
      }
    }
    try {
      ourVgSpec = compileVL(c.spec as never) as unknown as Record<string, unknown>
    } catch (e) {
      console.error(`  [engine-error] ${c.name}: ${(e as Error).message.split('\n')[0]}`)
      return 'engine-error'
    }
  }
  let oracleSvg: string | null = null
  let oracleErr = ''
  try {
    oracleSvg = await renderOracle(vgSpec, c.writes)
  } catch (e) {
    oracleErr = (e as Error).message
  }

  let ourSvg: string | null = null
  let ourErr = ''
  try {
    const loaded = await loadSpecData(ourVgSpec as never, TRUSTED_LOAD_OPTIONS)
    ourSvg = renderSpec(loaded as never)
  } catch (e) {
    ourErr = (e as Error).message
  }

  if (ourErr && oracleErr) return 'both-refused'
  if (ourErr) {
    console.error(`  [engine-error] ${c.name}: ${ourErr.split('\n')[0]}`)
    return 'engine-error'
  }
  if (oracleErr) {
    console.error(`  [node-error] ${c.name}: ${oracleErr.split('\n')[0]}`)
    return 'node-error'
  }
  // A document the canonicalizer cannot judge (an unsupported element, an
  // unparseable transform...) is never "ok": it counts as a difference with the
  // reason attached, so the strict oracle cannot be bypassed by exotic output.
  let diffs: string[]
  try {
    diffs = diffCanonical(canonicalizeSvg(oracleSvg!), canonicalizeSvg(ourSvg!))
  } catch (e) {
    console.error(`  [differ] ${c.name} (${c.family}.${c.property}): canonicalizer cannot judge: ${(e as Error).message}`)
    return 'differ'
  }
  if (diffs.length === 0) return 'ok'
  if (isBootstrapCase(c) && (await oracleIsNondeterministic(vgSpec, c.writes, oracleSvg!))) return 'nondeterministic'
  console.error(`  [differ] ${c.name} (${c.family}.${c.property}): ${diffs[0]}`)
  return 'differ'
}

function usage(msg: string): never {
  console.error(`run-sweep: ${msg}`)
  console.error('usage: run-sweep.ts <sweep> --floor N --min-ok N --max-node-error N [--filter substr]')
  process.exit(2)
}

/** A non-negative integer flag, or undefined when absent. Rejects NaN (NaN compares false against everything). */
function intFlag(args: string[], name: string): number | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const raw = args[i + 1]
  const n = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(n) || n < 0) usage(`${name} needs a non-negative integer, got ${JSON.stringify(raw)}`)
  return n
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const sweepName = args[0] ?? 'vega-schema'
  const filterIdx = args.indexOf('--filter')
  const filter = filterIdx >= 0 ? (args[filterIdx + 1] ?? '') : ''
  if (filterIdx >= 0 && !filter) usage('--filter needs a non-empty substring')
  const floor = intFlag(args, '--floor')
  const minOk = intFlag(args, '--min-ok')
  const maxNodeError = intFlag(args, '--max-node-error')
  if (!filter) {
    for (const [name, v] of [['--floor', floor], ['--min-ok', minOk], ['--max-node-error', maxNodeError]] as const) {
      if (v === undefined) usage(`${name} is required (a sweep with no floor can pass while checking nothing)`)
    }
  }

  const nodeModules = makeNodeModules()
  try {
    const { generate } = await import(`./sweeps/${sweepName}.mjs`)
    const ctx = { vega, vl, require, nodeModules }
    const out = (generate as (ctx: unknown) => { cases: SweepCase[]; skips: Array<{ family: string; property: string; reason: string }> })(ctx)
    const all = out.cases.filter((c) => !filter || c.name.includes(filter))
    console.log(`[${sweepName}] ${out.cases.length} cases generated, ${out.skips.length} properties skipped; running ${all.length}`)
    const problems: string[] = []
    if (floor !== undefined && out.cases.length < floor) {
      problems.push(`FLOOR FAILED: generated ${out.cases.length} < floor ${floor}`)
    }
    if (all.length === 0) {
      problems.push(`NO CASES RAN (filter ${JSON.stringify(filter)} matched none of ${out.cases.length} generated)`)
    }
    console.log(`[${sweepName}] ${out.skips.length} skipped properties (declared but not enumerable)`)

    const status: Status = { ok: 0, bothRefused: 0, nodeError: 0, engineError: 0, differ: 0, nondeterministic: 0, failNames: [] }
    const CONCURRENCY = 8
    let idx = 0
    const workers: Promise<void>[] = []
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = idx++
            if (i >= all.length) break
            const r = await runOneCase(all[i]!, nodeModules)
            if (r === 'ok') status.ok++
            else if (r === 'both-refused') status.bothRefused++
            else if (r === 'nondeterministic') status.nondeterministic++
            else if (r === 'node-error') { status.nodeError++; status.failNames.push(all[i]!.name) }
            else if (r === 'engine-error') { status.engineError++; status.failNames.push(all[i]!.name) }
            else { status.differ++; status.failNames.push(all[i]!.name) }
          }
        })(),
      )
    }
    await Promise.all(workers)

    const total = all.length
    console.log(`[${sweepName}] results: ${status.ok} ok, ${status.bothRefused} both-refused, ${status.nodeError} node-error, ${status.engineError} engine-error, ${status.differ} differ, ${status.nondeterministic} nondeterministic / ${total}`)
    // Per-family scoreboard
    const fams = new Map<string, { ok: number; fail: number }>()
    for (const c of out.cases) {
      if (filter && !c.name.includes(filter)) continue
      const f = fams.get(c.family) ?? { ok: 0, fail: 0 }
      fams.set(c.family, f)
    }
    for (const c of all) {
      const f = fams.get(c.family)!
      if (status.failNames.includes(c.name)) f.fail++
      else f.ok++
    }
    console.log(`[${sweepName}] family scoreboard (ok/fail):`)
    for (const [f, s] of [...fams.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${f.padEnd(28)} ${s.ok}\t${s.fail}`)
    }
    if (status.differ + status.engineError > 0) {
      problems.push(`${status.differ + status.engineError} differ/engine-error case(s)`)
    }
    if (!filter && minOk !== undefined && status.ok < minOk) {
      problems.push(`OK FLOOR FAILED: ${status.ok} ok < --min-ok ${minOk}`)
    }
    if (maxNodeError !== undefined && status.nodeError > maxNodeError) {
      problems.push(`NODE-ERROR CEILING EXCEEDED: ${status.nodeError} > --max-node-error ${maxNodeError} (oracle-side crashes grew)`)
    }
    if (status.failNames.length > 0) {
      console.error(`[${sweepName}] non-ok cases (differ/engine-error/node-error), ${status.failNames.length}:`)
      for (const n of status.failNames.slice(0, 40)) console.error(' ', n)
      if (status.failNames.length > 40) console.error(`  ... and ${status.failNames.length - 40} more`)
    }
    if (problems.length > 0) {
      for (const pr of problems) console.error(`[${sweepName}] ${pr}`)
      console.error(`[${sweepName}] FAIL`)
      process.exitCode = 1
    } else {
      console.log(`[${sweepName}] PASS`)
    }
  } finally {
    rmSync(nodeModules, { recursive: true, force: true })
  }
}

await main()
