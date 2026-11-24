/**
 * The store-seeded path of the gallery gate (audit C264). The static and react paths draw the FIRST frame: every selection's store is
 * empty, so every datum passes its predicate, and the branch of a `{condition: {param}, value}` encoding that a selection exists to draw
 * (the grey of what is not selected) is never painted; a filter in the wrong place, or a test that reads the wrong field, gives the same
 * picture there. This path gives both engines a Vega-Lite spec whose stores are NOT empty - one tuple per `<param>_store`, made from
 * rows the oracle itself holds - and compares what each draws from scratch.
 *
 *   point selection   one value of each field it stores (the middle of the field's distinct values), or one row id;
 *   interval          the range between the quartiles of a continuous field, two of the values of a discrete one.
 *
 * A spec is `unverifiable` where the tuple cannot be made from the oracle's rows (a field no dataset holds), or where the seeded store
 * does not change what the oracle draws (the case compares nothing the first frame did not).
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
import { BASE_URL, fileFetch, readSpec, trunc, type GallerySpec, type Outcome } from './lib.js'
import { forEngines } from '../engines.js'
import { oracleProblem } from './static.js'

type Obj = Record<string, any>

/** A Vega-Lite spec whose compiled Vega has a selection store: the only ones this path has anything to seed. */
export function hasSelection(g: GallerySpec): boolean {
  if (g.kind !== 'vl' || !JSON.stringify(readSpec(g)).includes('"select"')) return false
  const [src] = forEngines(readSpec(g), (oracle) => [oracle] as const)
  try { return ((vl.compile(src as never).spec.data ?? []) as Obj[]).some((d) => /_store$/.test(d.name)) } catch { return false }
}

function allSignals(node: Obj, out: Obj[] = []): Obj[] {
  for (const s of node.signals ?? []) out.push(s)
  for (const m of node.marks ?? []) if (m.type === 'group') allSignals(m, out)
  return out
}

const finite = (v: unknown): number | undefined => {
  const n = v instanceof Date ? +v : typeof v === 'number' ? v : undefined
  return n !== undefined && Number.isFinite(n) ? n : undefined
}

/** The tuples of one store, from the rows the oracle holds; the reason it cannot be made, when it cannot. */
function tuplesFor(vg: Obj, store: string, rowsOf: (field: string) => unknown[]): { tuples: Obj[] } | { problem: string } {
  const p = store.replace(/_store$/, '')
  const sigs = allSignals(vg)
  // (a tuple's `unit` is the string the signal writes it under: the first such literal in its handlers)
  const units = sigs.filter((s) => s.name === `${p}_tuple`).map((s) => /unit: \\"([^"\\]*)\\"/.exec(JSON.stringify(s))?.[1]).filter((u): u is string => u !== undefined)
  const unit = units[0] ?? ''
  const fieldsSig = sigs.find((s) => s.name === `${p}_tuple_fields`)
  if (!fieldsSig) return { tuples: [{ unit, _vgsid_: 3 }, { unit, _vgsid_: 11 }] }
  const interval = sigs.some((s) => s.name === `${p}_x` || s.name === `${p}_y`)
  const values: unknown[] = []
  for (const f of fieldsSig.value as Array<{ field: string; type: string }>) {
    const rows = rowsOf(f.field)
    if (rows.length === 0) return { problem: `no dataset holds the field ${f.field}` }
    const nums = rows.map(finite).filter((n): n is number => n !== undefined).sort((a, b) => a - b)
    if (f.type === 'E' && !interval) {
      const distinct = [...new Set(rows.map((r) => (r instanceof Date ? +r : r)))].filter((x) => x !== null && x !== undefined)
      values.push(distinct[Math.floor(distinct.length / 2)])
    } else if (f.type === 'E') {
      const distinct = [...new Set(rows.map((r) => (r instanceof Date ? +r : r)))].filter((x) => x !== null && x !== undefined)
      values.push([distinct[Math.floor(distinct.length / 3)], distinct[Math.floor((2 * distinct.length) / 3)]])
    } else {
      if (nums.length < 2) return { problem: `the field ${f.field} has no range` }
      values.push([nums[Math.floor(nums.length / 4)], nums[Math.floor((3 * nums.length) / 4)]])
    }
  }
  return { tuples: [{ unit, fields: fieldsSig.value, values }] }
}

const seededCopy = (vg: Obj, tuples: Record<string, Obj[]>): Obj => {
  const c = structuredClone(vg)
  for (const d of c.data ?? []) if (tuples[d.name]) d.values = structuredClone(tuples[d.name])
  return c
}

export async function runSeeded(g: GallerySpec): Promise<Outcome> {
  const t0 = Date.now()
  const done = (o: Omit<Outcome, 'id' | 'ms'>): Outcome => ({ id: g.id, ms: Date.now() - t0, ...o })
  const [oracleSrc, asterSrc] = forEngines(readSpec(g), (oracle, aster) => [oracle, aster] as const)
  stray.length = 0
  logged.length = 0
  warned.length = 0
  try {
    const oracleSpec = vl.compile(oracleSrc as never).spec as unknown as Obj
    const ourSpec = compileOurs(asterSrc as never) as Obj
    const stores = (oracleSpec.data as Obj[]).filter((d) => /_store$/.test(d.name)).map((d) => d.name as string)
    if (stores.length === 0) return done({ status: 'unverifiable', reason: 'no selection store', first: '' })
    // the rows the oracle holds, to make the tuples from
    const held: Record<string, unknown[]> = {}
    const empty = await withFrozenClock(() => withOracleRandom(() => vegaSvg(structuredClone(oracleSpec), (view) => {
      for (const d of oracleSpec.data as Obj[]) if (!/_store$/.test(d.name)) held[d.name] = [...(view.data(d.name) ?? [])]
    })))
    await settle()
    if (stray.length) throw new Error(stray[0])
    const problem = oracleProblem(logged, warned)
    if (problem !== null) return done({ status: 'unverifiable', reason: problem.reason, first: trunc(problem.first) })
    const rowsOf = (field: string): unknown[] => {
      for (const rows of Object.values(held)) {
        const hit = rows.filter((r) => r !== null && typeof r === 'object' && field in (r as Obj)).map((r) => (r as Obj)[field])
        if (hit.length) return hit
      }
      return []
    }
    const tuples: Record<string, Obj[]> = {}
    for (const store of stores) {
      const made = tuplesFor(oracleSpec, store, rowsOf)
      if ('problem' in made) return done({ status: 'unverifiable', reason: 'tuple-not-made', first: trunc(made.problem) })
      tuples[store] = made.tuples
    }
    const oracleSvg = canonicalizeSvg(await withFrozenClock(() => withOracleRandom(() => vegaSvg(seededCopy(oracleSpec, tuples)))))
    await settle()
    if (stray.length) throw new Error(stray[0])
    if (logged.length) return done({ status: 'unverifiable', reason: 'oracle-logged-error-seeded', first: trunc(logged[0]!.split('\n')[0]!) })
    // (a seeding that leaves the oracle's picture as it was compares nothing the first frame did not)
    if (diffCanonical(canonicalizeSvg(empty), oracleSvg).length === 0) return done({ status: 'unverifiable', reason: 'seeding-inert', first: '' })
    let ourSvg: string
    try {
      const loaded = await loadSpecData(seededCopy(ourSpec, tuples) as never, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })
      ourSvg = withFrozenClock(() => renderSpec(loaded as never, { urlPolicy: { baseURL: BASE_URL }, random: seededRandom() })) as string
      await settle()
      if (stray.length) throw new Error(stray[0])
    } catch (e) {
      return done({ status: 'error', reason: 'aster-threw', first: trunc(e instanceof Error ? e.message : String(e)) })
    }
    const diffs = diffCanonical(oracleSvg, canonicalizeSvg(ourSvg))
    return diffs.length === 0 ? done({ status: 'pass' }) : done({ status: 'fail', ...summarizeDiffs(diffs) })
  } catch (e) {
    await new Promise((r) => setTimeout(r, 60))
    stray.length = 0
    return done({ status: 'unverifiable', reason: 'oracle-error', first: trunc(e instanceof Error ? e.message : String(e)) })
  }
}
