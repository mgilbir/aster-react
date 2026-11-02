// @vitest-environment node
/**
 * The title of a ranged channel against vega-lite 6.4.3: a channel and its second channel (x and x2, y and y2, theta and theta2,
 * radius and radius2) are one guide with one title. Same field: one title. Different fields: both, joined. An explicit title on
 * either (or an axis title) is what it says; a title that is switched off switches the other off. Layers that share the guide
 * merge their titles the same way.
 *
 * Both compiled specs run through the same vega; the titles they draw (axis and legend), the descriptions and tooltips they compute and
 * the guides' own `title` property must be the same.
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { TIME_DATA, silent } from './vl-time-helpers.js'

type Obj = Record<string, unknown>
const UNSUPPORTED = /encoding channel "(?:theta2|radius2)" is valid Vega-Lite but is not supported/

/** The definitions a ranged channel can take: a field alone, with a title, with a switched-off title, aggregated, binned, in a time unit. */
const DEFS: Array<[string, Obj]> = [
  ['v', { field: 'v', type: 'quantitative' }],
  ['v, title', { field: 'v', type: 'quantitative', title: 'Mine' }],
  ['v, other title', { field: 'v', type: 'quantitative', title: 'Other' }],
  ['v, title null', { field: 'v', type: 'quantitative', title: null }],
  ['v, title empty', { field: 'v', type: 'quantitative', title: '' }],
  ['v, title list', { field: 'v', type: 'quantitative', title: ['One', 'Two'] }],
  ['k', { field: 'k', type: 'quantitative' }],
  ['k, title', { field: 'k', type: 'quantitative', title: 'Mine' }],
  ['sum v', { field: 'v', type: 'quantitative', aggregate: 'sum' }],
  ['mean v', { field: 'v', type: 'quantitative', aggregate: 'mean' }],
  ['mean k', { field: 'k', type: 'quantitative', aggregate: 'mean' }],
  ['count', { aggregate: 'count', type: 'quantitative' }],
  ['t month', { field: 't', type: 'temporal', timeUnit: 'month' }],
  ['t month, again', { field: 't', type: 'temporal', timeUnit: 'month', axis: null }],
  ['t month, as an object', { field: 't', type: 'temporal', timeUnit: { unit: 'month' } }],
  ['t utcmonth', { field: 't', type: 'temporal', timeUnit: 'utcmonth' }],
  ['t year', { field: 't', type: 'temporal', timeUnit: 'year' }],
  ['t', { field: 't', type: 'temporal' }],
  ['v, bin true and its default', { field: 'v', bin: { maxbins: 10 }, type: 'quantitative' }],
  ['v binned', { field: 'v', bin: true, type: 'quantitative' }],
  ['v, bin maxbins', { field: 'v', bin: { maxbins: 4 }, type: 'quantitative' }],
]
/** A second channel takes a field of the same kind as the first: a number with a number, a time with a time. */
const fits = (d1: Obj, d2: Obj): boolean => d1.type === d2.type

/** What the pair of channels sits in. */
const PAIRS: Array<[string, string, (a: Obj, b: Obj) => Obj]> = [
  ['x', 'x2', (a, b) => ({ mark: 'bar', encoding: { x: a, x2: b, y: { field: 'k', type: 'ordinal' } } })],
  ['y', 'y2', (a, b) => ({ mark: 'bar', encoding: { y: a, y2: b, x: { field: 'k', type: 'ordinal' } } })],
  ['y', 'y2', (a, b) => ({ mark: 'area', encoding: { y: a, y2: b, x: { field: 't', type: 'temporal' } } })],
  ['x', 'x2', (a, b) => ({ mark: 'rule', encoding: { x: a, x2: b, y: { field: 'k', type: 'ordinal' }, color: { value: 'red' } } })],
  ['theta', 'theta2', (a, b) => ({ mark: 'arc', encoding: { theta: a, theta2: b } })],
  ['radius', 'radius2', (a, b) => ({ mark: 'arc', encoding: { radius: a, radius2: b, theta: { field: 'k', type: 'quantitative' } } })],
]

async function drawn(vg: unknown): Promise<string[]> {
  const view = new vega.View(vega.parse(JSON.parse(JSON.stringify(vg))), { renderer: 'none' })
  await view.runAsync()
  const out: string[] = []
  // the titles on the page (not the tick labels: how a domain is made is not what is compared here), and the descriptions and tooltips
  const walk = (node: any, role: string): void => {
    if (node === null || typeof node !== 'object') return
    for (const item of node.items ?? []) {
      if (/-title$/.test(role) && item.text != null) out.push(`${role}=${JSON.stringify(item.text)}`)
      for (const key of ['tooltip', 'description']) if (item[key] != null) out.push(`${key}=${JSON.stringify(item[key])}`)
      walk(item, role)
    }
    for (const sub of node.marks ?? []) walk(sub, sub.role ?? role)
  }
  walk(view.scenegraph().root, 'root')
  return out
}

/** The `title` property of every axis and legend in a compiled spec, in order. */
const guideTitles = (vg: any): unknown[] => {
  const out: unknown[] = []
  const walk = (n: any): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    for (const g of [...(n.axes ?? []), ...(n.legends ?? [])]) out.push(g.title)
    Object.values(n).forEach(walk)
  }
  walk(vg)
  return out
}

/** Compile both ways. A spec only vega-lite refuses must be refused here, and the other way round. */
async function same(spec: Obj): Promise<string> {
  let theirs: any, ours: any
  try { theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec } catch { theirs = undefined }
  let refusal = ''
  try { ours = compile(JSON.parse(JSON.stringify(spec)) as never) } catch (e) { ours = undefined; refusal = String(e) }
  // (theta2 and radius2 are valid Vega-Lite that @aster/vl says outright it does not support: there is no title to compare)
  if (ours === undefined && theirs !== undefined && UNSUPPORTED.test(refusal)) return ''
  if (theirs === undefined || ours === undefined) return theirs === ours ? '' : `refused by ${theirs === undefined ? 'vega-lite' : 'aster'} only`
  const titles = [JSON.stringify(guideTitles(ours)), JSON.stringify(guideTitles(theirs))]
  if (titles[0] !== titles[1]) return `guide titles: expected ${titles[1]} got ${titles[0]}`
  const a = await drawn(theirs)
  const b = await drawn(ours)
  const i = a.findIndex((s, k) => s !== b[k])
  return JSON.stringify(a) === JSON.stringify(b) ? '' : `drawn: expected ${a[i] ?? '(nothing)'} got ${b[i] ?? '(nothing)'}`
}

const unit = (body: Obj, extra: Obj = {}): Obj => ({ data: { values: TIME_DATA }, ...body, ...extra })

describe('a ranged channel has the title vega-lite gives it', () => {
  PAIRS.forEach(([c1, c2, make], p) => {
    it(`${c1} and ${c2} (${p}): every pair of definitions`, async () => {
      const bad: string[] = []
      for (const [n1, d1] of DEFS) {
        for (const [n2, d2] of DEFS) {
          if (!fits(d1, d2)) continue
          const why = await same(unit(make(d1, d2)))
          if (why) bad.push(`${n1} + ${n2}: ${why}`)
        }
      }
      expect(bad.slice(0, 10), `${bad.length} pairs differ`).toEqual([])
    }, 120_000)
  })

  it('an axis title wins', async () => {
    const bad: string[] = []
    for (const title of ['Axis', null, '', ['A', 'B']]) {
      for (const [n1, d1] of DEFS.slice(0, 8)) {
        for (const [n2, d2] of DEFS.slice(0, 8)) {
          if (!fits(d1, d2)) continue
          const spec = unit({ mark: 'bar', encoding: { x: { ...d1, axis: { title } }, x2: d2, y: { field: 'k', type: 'ordinal' } } })
          const why = await same(spec)
          if (why) bad.push(`${JSON.stringify(title)} ${n1} + ${n2}: ${why}`)
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([])
  }, 300_000)

  it('layers that share the guide merge their titles', async () => {
    const bad: string[] = []
    const one = (a: Obj, b: Obj | undefined): Obj => ({ mark: 'bar', encoding: { x: a, ...(b ? { x2: b } : {}), y: { field: 'k', type: 'ordinal' } } })
    const sample = DEFS.filter(([n]) => ['v', 'v, title', 'v, title null', 'k', 'sum v', 'mean v', 't month'].includes(n))
    for (const [n1, d1] of sample) {
      for (const [n2, d2] of sample) {
        for (const [n3, d3] of sample) {
          if (!fits(d1, d2) || !fits(d1, d3)) continue
          for (const [shape, layers] of [
            ['ranged + ranged', [one(d1, d2), one(d1, d3)]],
            ['ranged + plain', [one(d1, d2), one(d3, undefined)]],
            ['plain + ranged', [one(d3, undefined), one(d1, d2)]],
          ] as Array<[string, Obj[]]>) {
            const why = await same({ data: { values: TIME_DATA }, layer: layers })
            if (why) bad.push(`${shape}: ${n1} + ${n2} / ${n3}: ${why}`)
          }
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([])
  }, 300_000)

  it('layers that share a y axis merge their titles', async () => {
    const bad: string[] = []
    const one = (a: Obj, b: Obj | undefined): Obj => ({ mark: 'bar', encoding: { y: a, ...(b ? { y2: b } : {}), x: { field: 'k', type: 'ordinal' } } })
    const sample = DEFS.filter(([n]) => ['v', 'v, title', 'v, other title', 'v, title null', 'k', 'sum v', 't month'].includes(n))
    for (const [n1, d1] of sample) {
      for (const [n2, d2] of sample) {
        for (const [n3, d3] of sample) {
          if (!fits(d1, d2) || !fits(d1, d3)) continue
          const why = await same({ data: { values: TIME_DATA }, layer: [one(d1, d2), one(d3, undefined)] })
          if (why) bad.push(`${n1}+${n2} / ${n3}: ${why}`)
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([])
  }, 300_000)

  it('a layer with a datum on the axis adds no field to its title', async () => {
    const bad: string[] = []
    const sample = DEFS.filter(([n]) => ['v', 'v, title', 'v, title null', 'mean v', 'count'].includes(n))
    for (const [n1, d1] of sample) {
      for (const [n2, d2] of sample) {
        for (const datum of [{ datum: 5 }, { datum: 5, title: 'Level' }, { datum: 5, title: null }, { datum: 5, axis: { title: 'Ax' } }] as Obj[]) {
          for (const order of [0, 1]) {
            const ranged: Obj = { mark: 'bar', encoding: { x: d1, x2: d2, y: { field: 'k', type: 'ordinal' } } }
            const rule: Obj = { mark: 'rule', encoding: { x: { ...datum, type: 'quantitative' } } }
            const why = await same({ data: { values: TIME_DATA }, layer: order ? [rule, ranged] : [ranged, rule] })
            if (why) bad.push(`${n1}+${n2} with ${JSON.stringify(datum)} (${order}): ${why}`)
          }
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([])
  }, 300_000)

  it('nested layers merge among themselves first', async () => {
    const bad: string[] = []
    const one = (a: Obj, b: Obj | undefined): Obj => ({ mark: 'bar', encoding: { x: a, ...(b ? { x2: b } : {}), y: { field: 'k', type: 'ordinal' } } })
    const sample = DEFS.filter(([n]) => ['v', 'v, title', 'v, other title', 'v, title null', 'k', 'mean v'].includes(n))
    for (const [n1, d1] of sample) {
      for (const [n2, d2] of sample) {
        for (const [n3, d3] of sample) {
          for (const [n4, d4] of sample) {
            const why = await same({ data: { values: TIME_DATA }, layer: [one(d1, d2), { layer: [one(d3, undefined), one(d4, d3)] }] })
            if (why) bad.push(`${n1}+${n2} / (${n3} / ${n4}+${n3}): ${why}`)
            const why2 = await same({ data: { values: TIME_DATA }, layer: [{ layer: [one(d1, undefined), one(d2, undefined)] }, one(d3, d4)] })
            if (why2) bad.push(`(${n1} / ${n2}) / ${n3}+${n4}: ${why2}`)
          }
        }
      }
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([])
  }, 300_000)

  it('shared encodings over a layered range', async () => {
    const bad: string[] = []
    for (const [n1, d1] of DEFS) {
      for (const [n2, d2] of DEFS.slice(0, 6)) {
        if (!fits(d1, d2)) continue
        const why = await same({ data: { values: TIME_DATA }, encoding: { x: d1, x2: d2, y: { field: 'k', type: 'ordinal' } }, layer: [{ mark: 'bar' }, { mark: 'rule' }] })
        if (why) bad.push(`${n1} + ${n2}: ${why}`)
      }
    }
    expect(bad.slice(0, 10), `${bad.length} differ`).toEqual([])
  }, 300_000)
})
