/**
 * Schema-sweep runner (ported from the Go aster project's sweep tests).
 *
 * For every (property, value) pair Vega's own schema declares, render one small
 * chart through upstream vega (oracle) and through @aster-charts/core, and compare the
 * SVG. A value upstream refuses is still a case: "both refuse" is agreement.
 *
 * Usage: npx tsx src/run-sweep.ts <sweep-name> --floor N --min-ok N --max-node-error N [--max-retained N] [--filter substr] [--vega-check]
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
 *
 * Every generated case carries its chart as `spec` (an object) or `specText` (JSON text, for a chart with a value JSON.stringify
 * cannot write, a negative zero); a case with neither fails the run before anything is rendered.
 *
 * --vega-check (Vega-Lite cases only): additionally render the Vega that @aster-charts/vl EMITS through REAL
 * vega; a case where real vega errors, warns (beyond what vega-lite's own output raises) or renders
 * something different from vega-lite's output counts as 'vega-differ' and fails the run. Aster's runtime
 * is lenient, so without this flag an invalid emitted spec can still look "ok".
 */
import { mkdtempSync, readdirSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { renderSpec, renderSceneToSvg } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile as compileVL, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked, settleWithin, type CheckedRender } from './render-vega.js'
import { withOracleRandom } from './gallery/seeded.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { deepFreeze, forEngines } from './engines.js'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url, flags: { floor: 'value', 'min-ok': 'value', 'max-node-error': 'value', 'max-retained': 'value', filter: 'value', 'vega-check': 'bool' }, args: '<sweep-name>' })

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
  /** The chart. A generator that must carry a value JSON has no spelling for -- a negative zero -- emits `specText` instead. */
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
  retained: number
  bothRefused: number
  nodeError: number
  engineError: number
  differ: number
  nondeterministic: number
  vegaDiffer: number
  failNames: string[]
}

/** What a sweep generator yields: the chart as an object (`spec`) or as JSON text (`specText`, parsed here so `-0` survives). */
type GeneratedCase = Omit<SweepCase, 'spec'> & { spec?: unknown; specText?: unknown }

/**
 * Give every generated case its `spec` object. A case that has neither a spec object nor JSON text that parses to one cannot be
 * rendered, and a case that cannot be rendered by either side reads as "both refused", which is agreement: a sweep whose cases
 * all lack a spec would pass while checking nothing. They are returned by name so the run can fail on them instead.
 */
function resolveSpecs(generated: GeneratedCase[]): { cases: SweepCase[]; unusable: string[] } {
  const cases: SweepCase[] = []
  const unusable: string[] = []
  for (const g of generated) {
    let spec: unknown = g.spec
    if (spec === undefined && typeof g.specText === 'string') {
      try {
        spec = JSON.parse(g.specText)
      } catch {
        spec = undefined
      }
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) unusable.push(String(g.name))
    else cases.push({ ...g, spec: spec as Record<string, unknown> })
  }
  return { cases, unusable }
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

/**
 * Render the oracle once. Throws on an oracle error.
 * Every render parses a copy of its own: vega writes onto the rows it ingests, so a second render of `vgSpec` (the
 * nondeterminism check, the fresh render of a signals case) would otherwise read the first one's answers.
 */
async function renderOracle(vgSpec: Record<string, unknown>, writes: SweepCase['writes'], logged?: string[]): Promise<string> {
  const runtime = vega.parse(structuredClone(vgSpec) as never)
  const view = new (vega as any).View(runtime, { renderer: 'none' })
  // (what the view logs as an error is kept, not printed: when the render then crashes, the case is judged by what was logged)
  if (logged) view.logger(collectingLogger(logged))
  try {
    await settleWithin(view.runAsync(), 'the oracle (vega runAsync)')
    let svg: string = await settleWithin(view.toSVG() as Promise<string>, 'the oracle (vega toSVG)')
    // signals sweep: write the requested signals and re-render
    for (const w of writes ?? []) {
      view.signal(w.name, w.value)
      await settleWithin(view.runAsync(), 'the oracle (vega runAsync after a signal write)')
    }
    if (writes?.length) svg = await settleWithin(view.toSVG() as Promise<string>, 'the oracle (vega toSVG)')
    return svg
  } finally {
    view.finalize()
  }
}

/** A vega logger that keeps the messages it is given as errors, in `into`, and prints nothing. */
function collectingLogger(into: string[]): unknown {
  const logger = {
    level: () => 2,
    error: (...a: unknown[]) => { into.push(errorMessage(a)); return logger },
    warn: () => logger,
    info: () => logger,
    debug: () => logger,
  }
  return logger
}

/** The message of what a logger was given: the first line, without the error's name (vega logs the Error, Aster the message). */
const errorMessage = (a: readonly unknown[]): string => a.map((x) => (x as Error)?.message ?? String(x)).join(' ').split('\n')[0]!.replace(/^[A-Za-z]*Error: /, '')

/**
 * Whether the two engines refused the spec for the same reason: vega logged errors and then failed to draw (a view whose scale could
 * not be made crashes its renderer later), and Aster logged the same errors, in the same order, and drew what it could. That is
 * an agreement about the spec, not an oracle crash nobody can explain: the engines say the same of it.
 */
export function refusedForTheSameReason(oracleLogged: readonly string[], asterLogged: readonly string[]): boolean {
  return oracleLogged.length > 0 && oracleLogged.length === asterLogged.length && oracleLogged.every((m, i) => m === asterLogged[i])
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

/**
 * The oracle's FRESH answer to a signals-sweep write: a new view whose signal starts at the written
 * value (no earlier run to retain anything from). Null when that cannot be built or errors.
 */
async function renderOracleFresh(vgSpec: Record<string, unknown>, writes: NonNullable<SweepCase['writes']>): Promise<string | null> {
  const spec = structuredClone(vgSpec) as { signals?: Array<Record<string, unknown>> }
  for (const w of writes) {
    const def = spec.signals?.find((s) => s.name === w.name)
    if (!def) return null
    def.value = w.value
    delete def.init
    delete def.update
  }
  try {
    return await renderOracle(spec as Record<string, unknown>, undefined)
  } catch {
    return null
  }
}

/** --vega-check: also render the Vega @aster-charts/vl EMITS through real vega (see the header). */
let vegaCheck = false

/**
 * `serial`: the case runs alone (nothing else draws random numbers meanwhile), so the --vega-check renders of a bootstrap case
 * can each draw from the same seeded stream and be compared exactly (see the pool in `main`).
 */
async function runOneCase(c: SweepCase, serial = false): Promise<'ok' | 'retained' | 'both-refused' | 'node-error' | 'engine-error' | 'differ' | 'nondeterministic' | 'vega-differ'> {
  // Each engine is handed a copy of its own, taken before either runs (engines.ts): vega writes its transforms' answers onto
  // the rows it ingests, and an Aster handed those rows would agree with the oracle without running a transform at all.
  // `vgSpec` is the oracle's source, never rendered itself (renderOracle copies it for every render).
  // Vega-Lite cases compare the compiled Vega: upstream vl.compile vs
  // @aster-charts/vl, each rendered through its own engine (a VL defect lives in
  // the spec it emits — see the sweep's header note).
  let [vgSpec, ourVgSpec] = forEngines(c.spec, (oracle, aster) => [oracle, c.ourSpec !== undefined ? forEngines(c.ourSpec, (_, ours) => ours) : aster])
  if (c.lite) {
    const ourVl = ourVgSpec
    try {
      vgSpec = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(vgSpec).spec
    } catch (e) {
      // upstream refuses to compile: an agreement only if we refuse too
      try {
        compileVL(ourVl as never)
        console.error(`  [node-error] ${c.name}: ${(e as Error).message.split('\n')[0]}`)
        return 'node-error'
      } catch {
        return 'both-refused'
      }
    }
    try {
      ourVgSpec = compileVL(ourVl as never) as unknown as Record<string, unknown>
    } catch (e) {
      // A refusal (a VLCompileError) of a spec whose vega-lite chart Vega cannot run is the agreement DECISIONS Q9 asks for: vega-lite
      // compiled a chart that is wrong, and the compiler would not draw it. Any other refusal, or one of a chart Vega does run, is an
      // engine error.
      if (e instanceof VLCompileError) {
        try {
          await renderOracle(vgSpec, c.writes, [])
        } catch {
          return 'both-refused'
        }
      }
      console.error(`  [engine-error] ${c.name}: ${(e as Error).message.split('\n')[0]}`)
      return 'engine-error'
    }
  }
  let oracleSvg: string | null = null
  let oracleErr = ''
  const oracleLogged: string[] = []
  try {
    oracleSvg = await renderOracle(vgSpec, c.writes, oracleLogged)
  } catch (e) {
    oracleErr = (e as Error).message
  }

  let ourSvg: string | null = null
  let ourErr = ''
  const ourLogged: string[] = []
  const logger = { error: (...a: unknown[]) => { ourLogged.push(errorMessage(a)) }, warn: () => {} }
  try {
    const loaded = await settleWithin(loadSpecData(ourVgSpec as never, TRUSTED_LOAD_OPTIONS), "Aster's data load")
    if (c.writes?.length) {
      // signals sweep: the engine does what the oracle does -- draw, write the
      // signals into the running chart, draw again (an incremental session, so
      // retained state across the write is compared too).
      const session = createChartSession()
      session.evaluate(loaded as never, { logger } as never)
      const input = { signals: Object.fromEntries(c.writes.map((w) => [w.name, w.value])), logger }
      ourSvg = renderSceneToSvg(session.evaluate(loaded as never, input as never))
    } else {
      ourSvg = renderSpec(loaded as never, { logger } as never)
    }
  } catch (e) {
    ourErr = (e as Error).message
  }

  if (ourErr && oracleErr) return 'both-refused'
  if (ourErr) {
    console.error(`  [engine-error] ${c.name}: ${ourErr.split('\n')[0]}`)
    return 'engine-error'
  }
  if (oracleErr) {
    // vega logged an error and went on, and its renderer then crashed on what the failed step left: the case is vega's own refusal,
    // and Aster's agreement with it is the same error logged (a scheme word the pinned vega does not know, an interval `nice` on a
    // scale that takes none). An oracle that crashed with nothing logged, or with something Aster did not say, is a node error.
    if (refusedForTheSameReason(oracleLogged, ourLogged)) return 'both-refused'
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
    // When the ORACLE's own document is the one that cannot be judged (vega wrote `rotate(sideways)` for a label
    // angle that is a word: not an SVG transform at all) there is nothing to compare against: that is an oracle-side
    // failure, counted with the node errors and held to their ceiling -- not a difference in the engine. A document of
    // ours the canonicalizer refuses is still a difference.
    let oracleJudgeable = true
    try { canonicalizeSvg(oracleSvg!) } catch { oracleJudgeable = false }
    if (!oracleJudgeable) {
      console.error(`  [node-error] ${c.name}: the oracle's own document cannot be judged: ${(e as Error).message}`)
      return 'node-error'
    }
    console.error(`  [differ] ${c.name} (${c.family}.${c.property}): canonicalizer cannot judge: ${(e as Error).message}`)
    return 'differ'
  }
  if (diffs.length === 0 && vegaCheck && c.lite) {
    // Aster's runtime is lenient: an emitted spec real vega rejects, warns about (beyond what
    // vega-lite's own output raises) or renders differently must not count as ok.
    // A bootstrap case (ci0/ci1 draw random numbers) runs alone, each render drawing from the same seeded stream: the two
    // renders of real vega are then a function of their specs and compare exactly, as every other case's do.
    const bootstrap = isBootstrapCase(c)
    if (bootstrap && !serial) throw new Error(`${c.name}: a bootstrap case is --vega-checked only when it runs alone`)
    const render = (spec: Record<string, unknown>): Promise<CheckedRender> => (bootstrap ? withOracleRandom(() => renderWithVegaChecked(spec)) : renderWithVegaChecked(spec))
    const [checked, oracleChecked] = bootstrap
      ? [await render(structuredClone(ourVgSpec)), await render(structuredClone(vgSpec))]
      : await Promise.all([render(structuredClone(ourVgSpec)), render(structuredClone(vgSpec))])
    const inherited = new Set([...oracleChecked.errors, ...oracleChecked.warnings])
    const bad = [...checked.errors, ...checked.warnings].filter((m) => !inherited.has(m))
    if (bad.length) {
      console.error(`  [vega-differ] ${c.name}: real vega: ${bad[0]!.split('\n')[0]}`)
      return 'vega-differ'
    }
    let vd: string[]
    try { vd = diffCanonical(canonicalizeSvg(oracleSvg!), canonicalizeSvg(checked.svg)) } catch (e) { vd = [(e as Error).message] }
    if (vd.length) {
      console.error(`  [vega-differ] ${c.name}: ${String(vd[0]).slice(0, 160)}`)
      return 'vega-differ'
    }
  }
  if (diffs.length === 0) return 'ok'
  if (c.writes?.length) {
    // The engine is a pure function of (spec, data, signals): a session that writes a signal
    // renders exactly what a fresh chart with that value renders (incremental === fresh, the
    // stack's invariant). Vega's own incremental run is not: it retains the view size (autosize
    // runs once, and again only when width/height/padding/autosize change) and other dataflow
    // state, so its second render can differ from ITS OWN fresh render of the same signals.
    // Such a case is 'retained' when the engine equals vega's fresh render and vega's second
    // render does not; the count is a ceiling (--max-retained) that can only be lowered.
    const fresh = await renderOracleFresh(vgSpec, c.writes)
    if (fresh !== null) {
      try {
        if (diffCanonical(canonicalizeSvg(fresh), canonicalizeSvg(ourSvg!)).length === 0) return 'retained'
      } catch { /* the canonicalizer cannot judge: a difference */ }
    }
  }
  if (isBootstrapCase(c) && (await oracleIsNondeterministic(vgSpec, c.writes, oracleSvg!))) return 'nondeterministic'
  // a structure divergence says nothing in its first line: show the lines that differ
  const detail = diffs[0]!.startsWith('structure:') ? diffs.filter((d) => /^structure: [-+] /.test(d)).map((d) => d.slice(0, 260)).join(' | ') : ''
  console.error(`  [differ] ${c.name} (${c.family}.${c.property}): ${diffs[0]}${detail ? ` -- ${detail}` : ''}`)
  return 'differ'
}

function usage(msg: string): never {
  console.error(`run-sweep: ${msg}`)
  console.error('usage: run-sweep.ts <sweep> --floor N --min-ok N --max-node-error N [--filter substr] [--vega-check]')
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
  const maxRetained = intFlag(args, '--max-retained')
  vegaCheck = args.includes('--vega-check')
  if (!filter) {
    for (const [name, v] of [['--floor', floor], ['--min-ok', minOk], ['--max-node-error', maxNodeError]] as const) {
      if (v === undefined) usage(`${name} is required (a sweep with no floor can pass while checking nothing)`)
    }
  }

  const nodeModules = makeNodeModules()
  try {
    const { generate } = await import(`./sweeps/${sweepName}.mjs`)
    const ctx = { vega, vl, require, nodeModules }
    const generated = (generate as (ctx: unknown) => { cases: GeneratedCase[]; skips: Array<{ family: string; property: string; reason: string }> })(ctx)
    const resolved = resolveSpecs(generated.cases)
    if (resolved.unusable.length > 0) {
      console.error(`[${sweepName}] ${resolved.unusable.length} of ${generated.cases.length} generated case(s) have no usable spec (neither a \`spec\` object nor \`specText\` JSON that parses to an object), e.g. ${resolved.unusable.slice(0, 5).join(', ')}`)
      console.error(`[${sweepName}] FAIL`)
      process.exitCode = 1
      return
    }
    // (the cases are the source both engines copy from: frozen, a path that handed one to an engine directly would fail at
    // vega's first write instead of sharing it)
    const out = { cases: deepFreeze(resolved.cases), skips: generated.skips }
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

    const status: Status = { ok: 0, retained: 0, bothRefused: 0, nodeError: 0, engineError: 0, differ: 0, nondeterministic: 0, vegaDiffer: 0, failNames: [] }
    const CONCURRENCY = 8
    // (with --vega-check, the bootstrap cases run after the pool, one at a time: see runOneCase's `serial`)
    const deferred = vegaCheck ? all.filter((c) => c.lite && isBootstrapCase(c)) : []
    const pooled = deferred.length ? all.filter((c) => !deferred.includes(c)) : all
    const tally = (c: SweepCase, r: Awaited<ReturnType<typeof runOneCase>>): void => {
      if (r === 'ok') status.ok++
      else if (r === 'retained') status.retained++
      else if (r === 'both-refused') status.bothRefused++
      else if (r === 'nondeterministic') status.nondeterministic++
      else { status[r === 'vega-differ' ? 'vegaDiffer' : r === 'node-error' ? 'nodeError' : r === 'engine-error' ? 'engineError' : 'differ']++; status.failNames.push(c.name) }
    }
    let idx = 0
    const workers: Promise<void>[] = []
    for (let w = 0; w < CONCURRENCY; w++) {
      workers.push(
        (async () => {
          while (true) {
            const i = idx++
            if (i >= pooled.length) break
            tally(pooled[i]!, await runOneCase(pooled[i]!))
          }
        })(),
      )
    }
    await Promise.all(workers)
    for (const c of deferred) tally(c, await runOneCase(c, true))

    const total = all.length
    console.log(`[${sweepName}] results: ${status.ok} ok, ${status.retained} retained, ${status.bothRefused} both-refused, ${status.nodeError} node-error, ${status.engineError} engine-error, ${status.differ} differ, ${status.nondeterministic} nondeterministic${vegaCheck ? `, ${status.vegaDiffer} vega-differ` : ''} / ${total}`)
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
    if (status.differ + status.engineError + status.vegaDiffer > 0) {
      problems.push(`${status.differ + status.engineError + status.vegaDiffer} differ/engine-error/vega-differ case(s)`)
    }
    if (!filter && minOk !== undefined && status.ok < minOk) {
      problems.push(`OK FLOOR FAILED: ${status.ok} ok < --min-ok ${minOk}`)
    }
    if (maxNodeError !== undefined && status.nodeError > maxNodeError) {
      problems.push(`NODE-ERROR CEILING EXCEEDED: ${status.nodeError} > --max-node-error ${maxNodeError} (oracle-side crashes grew)`)
    }
    if (maxRetained !== undefined && status.retained > maxRetained) {
      problems.push(`RETAINED CEILING EXCEEDED: ${status.retained} > --max-retained ${maxRetained} (cases where vega's incremental run differs from its fresh run grew)`)
    } else if (maxRetained === undefined && status.retained > 0) {
      problems.push(`${status.retained} retained case(s) but no --max-retained ceiling given`)
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
