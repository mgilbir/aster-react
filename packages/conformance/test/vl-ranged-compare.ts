/**
 * The comparison the ranged-channel, scale-type and polar differentials share: one Vega-Lite spec compiled by vega-lite 6.4.3 and by
 * @aster/vl, both run through the same vega in this process. What must be the same is what a reader sees and what the scales decide:
 *
 *   - the compiled scales (type, domain, range and every property), the name of the data a domain reads aside: Aster may name its
 *     datasets differently, the rows they hold are compared below;
 *   - the scales as they run: type, domain, range;
 *   - the axes as they run: where every tick and label sits and what the label says;
 *   - the rows the mark draws (of a view with one mark);
 *   - the SVG.
 *
 * A spec only vega-lite refuses may be refused or not; one only Aster refuses is a difference.
 */
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { silent } from './vl-time-helpers.js'

type Obj = Record<string, unknown>

const canon = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(canon) : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon((x as Obj)[k])])) : x

/**
 * A domain as the fields it unions, in order and without repeats: which data set a reference reads is not what the domain is (a layer
 * that repeats another's steps may read a data set of its own, with the same rows), and the same field twice is the field once.
 */
function fieldsOfDomain(domain: unknown): unknown {
  if (domain === null || typeof domain !== 'object' || Array.isArray(domain)) return domain
  const d = domain as Obj
  const entries: unknown[] = Array.isArray(d.fields) ? d.fields : typeof d.field === 'string' ? [d.field] : []
  if (entries.length === 0) return domain
  const named = entries.map((e) => (e !== null && typeof e === 'object' && !Array.isArray(e) && typeof (e as Obj).field === 'string' && Object.keys(e as Obj).every((k) => k === 'field' || k === 'data') ? (e as Obj).field : e))
  const unique = [...new Map(named.map((e) => [JSON.stringify(e), e])).values()]
  const { fields: _f, field: _g, data: _d, ...rest } = d
  void _f; void _g; void _d
  return { ...rest, ...(unique.length === 1 ? { field: unique[0] } : { fields: unique }) }
}

/** Scales as compiled, with the domains reduced to the fields they union (and an absent list the same as an empty one). */
export function scalesOf(vg: Obj): string {
  const scales = ((vg.scales as Obj[] | undefined) ?? []).map((sc) => ({ ...sc, ...(sc.domain !== undefined ? { domain: fieldsOfDomain(sc.domain) } : {}) }))
  return JSON.stringify(canon(JSON.parse(JSON.stringify(scales, (k, v) => (k === 'data' && typeof v === 'string' ? undefined : v)))))
}

function* marksOf(ms: any[] | undefined): Generator<any> {
  for (const m of ms ?? []) {
    yield m
    yield* marksOf(m.marks)
  }
}

interface Run {
  scales: string
  axes: string
  rows: string
  svg: string
}

async function run(vg: Obj): Promise<Run> {
  const view = new vega.View(vega.parse(JSON.parse(JSON.stringify(vg))), { renderer: 'none' })
  await view.runAsync()
  const names = ((vg.scales as Obj[] | undefined) ?? []).map((s) => String(s.name))
  const scales = names.map((n) => {
    const s = view.scale(n) as any
    const dom = s.domain()
    return `${n}:${s.type}:${JSON.stringify(dom, (_k, v) => (v instanceof Date ? v.toISOString() : v))}:${JSON.stringify(s.range())}`
  })
  // every axis item the scene holds: ticks, labels and gridlines, in order, with their place and text
  const axes: string[] = []
  const walk = (node: any, role: string): void => {
    if (node === null || typeof node !== 'object') return
    for (const item of node.items ?? []) {
      if (/^axis-(tick|label|grid)$/.test(role)) axes.push(`${role}@${item.x},${item.y}${item.text !== undefined ? `=${JSON.stringify(item.text)}` : ''}`)
      walk(item, role)
    }
    for (const sub of node.marks ?? []) walk(sub, sub.role ?? role)
  }
  walk(view.scenegraph().root, 'root')
  // (layers may share one data set and add to it what each needs: the rows of one view are compared, those of a layered one are not)
  const reading = [...marksOf(vg.marks as any[] | undefined)].filter((m) => typeof m.from?.data === 'string')
  const first = reading.length === 1 ? reading[0] : undefined
  // (a mark drawn per group, a line split by a field, reads a data set only its group holds: its rows are not asked for)
  let rows = ''
  try { rows = first ? JSON.stringify(canon(view.data(first.from.data as string).map((r: any) => JSON.parse(JSON.stringify(r))))) : '' } catch { rows = '' }
  // (vega numbers its gradients across the whole process: the same picture drawn second has other numbers)
  const ids = new Map<string, number>()
  const svg = (await view.toSVG()).replace(/gradient_\d+/g, (id) => `gradient_${ids.get(id) ?? ids.set(id, ids.size).get(id)}`)
  return { scales: scales.join('\n'), axes: axes.join('\n'), rows, svg }
}

/** What `differences` found, and whether there was anything to compare (vega-lite compiled and ran the spec). */
export interface Outcome {
  why: string
  compared: boolean
}

/** The first thing that differs between vega-lite's compile of `spec` and Aster's, or '' when nothing does. */
export async function differences(spec: Obj): Promise<Outcome> {
  // (a long loop gives the worker's event loop a turn, so vitest's reporting is not starved)
  await new Promise((resolve) => setImmediate(resolve))
  let theirs: Obj | undefined
  let ours: Obj | undefined
  let refusal = ''
  try { theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec } catch { theirs = undefined }
  try { ours = compile(JSON.parse(JSON.stringify(spec)) as never) as Obj } catch (e) { ours = undefined; refusal = String(e).slice(0, 160) }
  const no = (why: string): Outcome => ({ why, compared: true })
  if (theirs === undefined) return { why: '', compared: false }
  if (ours === undefined) return no(`refused by aster only: ${refusal}`)
  if (scalesOf(ours) !== scalesOf(theirs)) return no(`compiled scales: expected ${scalesOf(theirs)} got ${scalesOf(ours)}`)
  let a: Run
  let b: Run
  try { a = await run(theirs) } catch { return { why: '', compared: false } } // (vega-lite wrote a spec vega itself cannot run: nothing to compare)
  try { b = await run(ours) } catch (e) { return no(`aster's spec does not run: ${String(e).slice(0, 160)}`) }
  for (const k of ['scales', 'axes', 'rows', 'svg'] as const) {
    if (a[k] !== b[k]) {
      const x = a[k].split(k === 'svg' ? '><' : '\n')
      const y = b[k].split(k === 'svg' ? '><' : '\n')
      const i = x.findIndex((s, j) => s !== y[j])
      return no(`${k}: expected ${(x[i] ?? '(nothing)').slice(0, 220)} got ${(y[i] ?? '(nothing)').slice(0, 220)}`)
    }
  }
  return { why: '', compared: true }
}

/**
 * Run `differences` over named specs and collect the ones that differ. A space of which vega-lite compiles and runs less than
 * `minShare` compares nothing worth the name: that is a difference too.
 */
export async function collect(cases: Iterable<[string, Obj]>, minShare = 0.5): Promise<string[]> {
  const bad: string[] = []
  let total = 0
  let compared = 0
  for (const [name, spec] of cases) {
    const out = await differences(spec)
    total++
    if (out.compared) compared++
    if (out.why) bad.push(`${name}: ${out.why}`)
  }
  if (compared < total * minShare) bad.unshift(`only ${compared} of ${total} cases were compiled and run by vega-lite: the space compares nothing`)
  return bad
}
