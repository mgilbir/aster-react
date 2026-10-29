/**
 * Static path of the gallery gate: real vega vs Aster's `renderSpec`, canonical SVG compared exactly.
 *
 *   vega spec:  oracle = vega.parse + View (renderer none) .toSVG()      ours = loadSpecData + renderSpec
 *   VL spec:    oracle = vega-lite.compile -> vega                         ours = @aster/vl compile -> loadSpecData + renderSpec
 *
 * Data comes from the pinned vega-datasets through one offline `fetch` handed to BOTH engines.
 * A spec whose ORACLE is not a function of its inputs (random(), timers, now()) or whose oracle fails is
 * `unverifiable`, never `pass`: the reason is part of the outcome and is printed.
 */
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile as compileOurs } from '@aster/vl'
import { canonicalizeSvg, diffCanonical } from '../normalize.js'
import { summarizeDiffs } from './diffs.js'
import { logged, settle, stray, vegaSvg } from './oracle.js'
import { seededRandom, withFrozenClock, withOracleRandom } from './seeded.js'
import { BASE_URL, fileFetch, readSpec, trunc, type GallerySpec, type Outcome } from './lib.js'

/** Static hints for WHY an oracle is not deterministic (the decision itself is made by rendering twice). */
function nondeterminismHint(spec: Record<string, unknown>): string {
  const t = JSON.stringify(spec)
  const hints: string[] = []
  if (/\brandom\(|\brandomNormal\(|\brandomUniform\(|\bsample\b|"type":\s*"sample"/.test(t)) hints.push('random')
  if (/"timer"|\bnow\(\)|\btime\(\)/.test(t)) hints.push('timer/now')
  return hints.join('+') || 'unknown'
}

export async function runStatic(g: GallerySpec): Promise<Outcome> {
  const t0 = Date.now()
  const done = (o: Omit<Outcome, 'id' | 'ms'>): Outcome => ({ id: g.id, ms: Date.now() - t0, ...o })
  const src = readSpec(g)
  let oracleSpec: Record<string, unknown>
  let oracleSvg: string
  stray.length = 0
  logged.length = 0
  try {
    oracleSpec = g.kind === 'vl' ? (vl.compile(src as never).spec as unknown as Record<string, unknown>) : src
    oracleSvg = await withFrozenClock(() => withOracleRandom(() => vegaSvg(oracleSpec)))
    await settle()
    if (stray.length) throw new Error(stray[0])
    // a transform that draws into a canvas (heatmap, label, wordcloud) fails in Node, which has none: vega logs the error and carries
    // on without its output, so the document it renders is not the one the spec describes (the react path, in Chromium, compares them)
    const noCanvas = logged.find((m) => /getContext|canvas/i.test(m))
    if (noCanvas !== undefined) return done({ status: 'unverifiable', reason: 'oracle-needs-canvas (Node has none)', first: trunc(noCanvas.split('\n')[0]!) })
  } catch (e) {
    // a view that failed mid-run still has a redraw queued that throws a moment later; let it fire here, not inside the next spec
    await new Promise((r) => setTimeout(r, 60))
    stray.length = 0
    const noCanvas = logged.find((m) => /getContext|canvas/i.test(m))
    if (noCanvas !== undefined) return done({ status: 'unverifiable', reason: 'oracle-needs-canvas (Node has none)', first: trunc(noCanvas.split('\n')[0]!) })
    return done({ status: 'unverifiable', reason: 'oracle-error', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
  let oracle
  try {
    oracle = canonicalizeSvg(oracleSvg)
    // an oracle that is not a pure function of its inputs cannot be compared exactly
    const again = canonicalizeSvg(await withFrozenClock(() => withOracleRandom(() => vegaSvg(oracleSpec))))
    await settle()
    if (stray.length) throw new Error(stray[0])
    const self = diffCanonical(oracle, again)
    if (self.length) return done({ status: 'unverifiable', reason: `oracle-nondeterministic (${nondeterminismHint(src)})`, first: trunc(self[0]!) })
  } catch (e) {
    return done({ status: 'unverifiable', reason: 'oracle-canonicalize-error', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
  let ourSvg: string
  try {
    const ourVg = g.kind === 'vl' ? (compileOurs(JSON.parse(JSON.stringify(src))) as Record<string, unknown>) : src
    const loaded = await loadSpecData(JSON.parse(JSON.stringify(ourVg)) as never, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })
    // (the host's counterpart of the oracle loader's baseURL: relative image urls resolve against it)
    ourSvg = withFrozenClock(() => renderSpec(loaded as never, { urlPolicy: { baseURL: BASE_URL }, random: seededRandom() })) as string
    await settle()
    if (stray.length) throw new Error(stray[0])
  } catch (e) {
    return done({ status: 'error', reason: 'aster-threw', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
  try {
    const diffs = diffCanonical(oracle, canonicalizeSvg(ourSvg))
    return diffs.length === 0 ? done({ status: 'pass' }) : done({ status: 'fail', ...summarizeDiffs(diffs) })
  } catch (e) {
    return done({ status: 'error', reason: 'aster-svg-not-canonicalizable', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
}
