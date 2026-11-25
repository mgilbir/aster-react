/**
 * Static path of the gallery gate: real vega vs Aster's `renderSpec`, canonical SVG compared exactly.
 *
 *   vega spec:  oracle = vega.parse + View (renderer none) .toSVG()      ours = loadSpecData + renderSpec
 *   VL spec:    oracle = vega-lite.compile -> vega                         ours = @aster-charts/vl compile -> loadSpecData + renderSpec
 *
 * Data comes from the pinned vega-datasets through one offline `fetch` handed to BOTH engines.
 * A spec whose ORACLE is not a function of its inputs (random(), timers, now()) or whose oracle fails is
 * `unverifiable`, never `pass`: the reason is part of the outcome and is printed.
 */
import * as vl from 'vega-lite'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { renderSpec } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile as compileOurs } from '@aster-charts/vl'
import { canonicalizeSvg, diffCanonical } from '../normalize.js'
import { summarizeDiffs } from './diffs.js'
import { logged, settle, stray, vegaSvg, warned } from './oracle.js'
import { seededRandom, withFrozenClock, withOracleRandom } from './seeded.js'
import { BASE_URL, fileFetch, needsCanvas, readSpec, trunc, type GallerySpec, type Outcome } from './lib.js'
import { forEngines } from '../engines.js'

/** Static hints for WHY an oracle is not deterministic (the decision itself is made by rendering twice). */
function nondeterminismHint(spec: Record<string, unknown>): string {
  const t = JSON.stringify(spec)
  const hints: string[] = []
  if (/\brandom\(|\brandomNormal\(|\brandomUniform\(|\bsample\b|"type":\s*"sample"/.test(t)) hints.push('random')
  if (/"timer"|\bnow\(\)|\btime\(\)/.test(t)) hints.push('timer/now')
  return hints.join('+') || 'unknown'
}

/**
 * Why the document the oracle drew cannot be compared, or null. A transform that draws into a canvas fails in Node, which has none,
 * and a data file its loader could not load (a `Loading failed` warning: the chart is drawn without it) means the document is not
 * the one the spec describes, so nothing can pass against it. An error vega logs for any other reason is the SPEC's doing (a
 * projection type its registry lacks, a formula that throws): it is compared (`loggedErrorsDiffer`), not excused.
 */
export function oracleProblem(errors: readonly string[], warnings: readonly string[]): { reason: string; first: string } | null {
  const noCanvas = errors.find(needsCanvas)
  if (noCanvas !== undefined) return { reason: 'oracle-needs-canvas (Node has none)', first: noCanvas.split('\n')[0]! }
  const notLoaded = warnings.find((w) => w.startsWith('Loading failed'))
  if (notLoaded !== undefined) return { reason: 'oracle-load-failed', first: notLoaded }
  return null
}

/** The message of each error: the first line (vega's oracle logger takes the stack, which opens with the error's name; Aster's is given the message). */
const messageLines = (errors: readonly string[]): string[] => errors.map((e) => e.split('\n')[0]!.replace(/^[A-Za-z]*Error: /, ''))

/**
 * What differs between the errors the oracle logged and the ones Aster logged for the same spec, or null when they are the same
 * (in order). A spec that makes vega log is compared on BOTH the document and the errors: Aster drawing the same document and
 * saying nothing, or saying something else, is a failure, not a pass.
 */
export function loggedErrorsDiffer(oracleErrors: readonly string[], asterErrors: readonly string[]): string | null {
  const want = messageLines(oracleErrors)
  const got = messageLines(asterErrors)
  if (want.length === got.length && want.every((w, i) => w === got[i])) return null
  return `logged errors: vega ${JSON.stringify(want.slice(0, 3))}, aster ${JSON.stringify(got.slice(0, 3))}`
}

export async function runStatic(g: GallerySpec): Promise<Outcome> {
  const t0 = Date.now()
  const done = (o: Omit<Outcome, 'id' | 'ms'>): Outcome => ({ id: g.id, ms: Date.now() - t0, ...o })
  // each engine its own copy of the spec, taken before either runs (vega writes onto the rows it ingests), and every oracle render
  // its own copy of the oracle's Vega (the second render, which checks the oracle is deterministic, must not read the first's writes)
  const [oracleSrc, asterSrc] = forEngines(readSpec(g), (oracle, aster) => [oracle, aster] as const)
  let oracleSpec: Record<string, unknown>
  let oracleSvg: string
  let oracleErrors: string[] = []
  stray.length = 0
  logged.length = 0
  warned.length = 0
  try {
    oracleSpec = g.kind === 'vl' ? (vl.compile(oracleSrc as never).spec as unknown as Record<string, unknown>) : oracleSrc
    oracleSvg = await withFrozenClock(() => withOracleRandom(() => vegaSvg(structuredClone(oracleSpec))))
    await settle()
    if (stray.length) throw new Error(stray[0])
    // a transform that draws into a canvas (heatmap, label, wordcloud) fails in Node, which has none: vega logs the error and carries
    // on without its output, so the document it renders is not the one the spec describes (the react path, in Chromium, compares them)
    const problem = oracleProblem(logged, warned)
    if (problem !== null) return done({ status: 'unverifiable', reason: problem.reason, first: trunc(problem.first) })
    oracleErrors = [...logged]
  } catch (e) {
    // a view that failed mid-run still has a redraw queued that throws a moment later; let it fire here, not inside the next spec
    await new Promise((r) => setTimeout(r, 60))
    stray.length = 0
    const noCanvas = logged.find(needsCanvas)
    if (noCanvas !== undefined) return done({ status: 'unverifiable', reason: 'oracle-needs-canvas (Node has none)', first: trunc(noCanvas.split('\n')[0]!) })
    return done({ status: 'unverifiable', reason: 'oracle-error', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
  let oracle
  try {
    oracle = canonicalizeSvg(oracleSvg)
    // an oracle that is not a pure function of its inputs cannot be compared exactly
    const again = canonicalizeSvg(await withFrozenClock(() => withOracleRandom(() => vegaSvg(structuredClone(oracleSpec)))))
    await settle()
    if (stray.length) throw new Error(stray[0])
    const self = diffCanonical(oracle, again)
    if (self.length) return done({ status: 'unverifiable', reason: `oracle-nondeterministic (${nondeterminismHint(asterSrc)})`, first: trunc(self[0]!) })
  } catch (e) {
    return done({ status: 'unverifiable', reason: 'oracle-canonicalize-error', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
  let ourSvg: string
  const asterErrors: string[] = []
  const logger = { error: (...a: unknown[]) => { asterErrors.push(a.map((x) => (x as Error)?.message ?? String(x)).join(' ')) }, warn: () => {} }
  try {
    const ourVg = g.kind === 'vl' ? (compileOurs(asterSrc as never) as Record<string, unknown>) : asterSrc
    const loaded = await loadSpecData(ourVg as never, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })
    // (the host's counterpart of the oracle loader's baseURL: relative image urls resolve against it)
    ourSvg = withFrozenClock(() => renderSpec(loaded as never, { urlPolicy: { baseURL: BASE_URL }, random: seededRandom(), logger } as never)) as string
    await settle()
    if (stray.length) throw new Error(stray[0])
  } catch (e) {
    return done({ status: 'error', reason: 'aster-threw', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
  try {
    const diffs = diffCanonical(oracle, canonicalizeSvg(ourSvg))
    const errorsDiffer = loggedErrorsDiffer(oracleErrors, asterErrors)
    if (errorsDiffer !== null) diffs.push(errorsDiffer)
    return diffs.length === 0 ? done({ status: 'pass' }) : done({ status: 'fail', ...summarizeDiffs(diffs) })
  } catch (e) {
    return done({ status: 'error', reason: 'aster-svg-not-canonicalizable', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
}
