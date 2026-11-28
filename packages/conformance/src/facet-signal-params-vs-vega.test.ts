/**
 * A facet's parameters given as signals (C126): vega-parser reads `groupby` (keyRef), `field` (fieldRef) and the facet aggregate's
 * `fields`, `ops`, `as` and `cross` as signal references. They were accepted and ignored (one cell for `groupby: {signal}`). The
 * same specs, with the signals set to several values, go to a vega View and to Aster: the facet cells (their data) must agree.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'

type Spec = Record<string, unknown>
const DATA = [{ name: 't', values: [{ a: 'x', b: 1, c: 'p' }, { a: 'y', b: 2, c: 'q' }, { a: 'x', b: 3, c: 'q' }, { a: 'z', b: 4, c: 'p' }] }]
const mk = (facet: Spec, signals: Spec[]): Spec => ({
  width: 100, height: 100, signals, data: DATA,
  marks: [{ type: 'group', name: 'cell', from: { facet: { name: 'f', data: 't', ...facet } }, marks: [{ type: 'text', from: { data: 'f' }, encode: { update: { text: { field: 'a' } } } }] }],
})

async function vegaCells(spec: Spec): Promise<unknown[]> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const cell = (view.scenegraph() as unknown as { root: { items: Array<{ items: Array<{ name?: string; items: Array<{ datum: Spec; items: Array<{ items: unknown[] }> }> }> }> } }).root.items[0]!.items.find((m) => m.name === 'cell')!
    // (as data: vega's tuple id symbol is its own bookkeeping)
    return cell.items.map((g) => ({ datum: JSON.parse(JSON.stringify(g.datum)), rows: g.items[0]?.items.length ?? 0 }))
  } finally {
    view.finalize()
  }
}

function asterCells(spec: Spec): unknown[] {
  const scene = evaluateChart(compileChart(structuredClone(spec) as never))
  const out: unknown[] = []
  const walk = (n: Record<string, unknown>): void => {
    if (n.marktype === 'group' && n.name === 'cell' && n._scope) {
      const texts = (n.items as Array<Record<string, unknown>>).find((m) => m.marktype === 'text')
      out.push({ datum: JSON.parse(JSON.stringify(n.datum)), rows: ((texts?.items as unknown[]) ?? []).length })
    }
    for (const c of (n.items as Array<Record<string, unknown>> | undefined) ?? []) if (c && typeof c === 'object') walk(c)
  }
  for (const r of (scene as unknown as { items: Array<Record<string, unknown>> }).items) walk(r)
  return out
}

const CASES: Array<[string, Spec, Array<Record<string, unknown>>]> = [
  ['groupby: {signal}', { groupby: { signal: 'g' } }, [{ g: 'a' }, { g: 'c' }]],
  ['groupby: [{signal}]', { groupby: [{ signal: 'g' }] }, [{ g: 'a' }, { g: 'c' }]],
  ['groupby: [name, {signal}]', { groupby: ['a', { signal: 'g' }] }, [{ g: 'c' }, { g: 'b' }]],
  ['aggregate.fields: {signal}', { groupby: ['a'], aggregate: { fields: { signal: 'fs' }, ops: ['sum'], as: ['s'] } }, [{ fs: ['b'] }]],
  ['aggregate.fields: [{signal}]', { groupby: ['a'], aggregate: { fields: [{ signal: 'f1' }], ops: ['max'], as: ['m'] } }, [{ f1: 'b' }]],
  ['aggregate.ops: {signal}', { groupby: ['a'], aggregate: { fields: ['b'], ops: { signal: 'os' }, as: ['s'] } }, [{ os: ['sum'] }, { os: ['min'] }]],
  ['aggregate.as: {signal}', { groupby: ['a'], aggregate: { fields: ['b'], ops: ['sum'], as: { signal: 'names' } } }, [{ names: ['total'] }]],
  ['aggregate.cross: {signal}', { groupby: ['a', 'c'], aggregate: { cross: { signal: 'cx' } } }, [{ cx: true }, { cx: false }]],
]

describe('facet parameters given as signals are read as vega reads them (C126)', () => {
  for (const [label, facet, values] of CASES) {
    it(label, async () => {
      for (const v of values) {
        const signals = Object.entries(v).map(([name, value]) => ({ name, value }))
        const spec = mk(facet, signals)
        expect(asterCells(spec), JSON.stringify(v)).toEqual(await vegaCells(spec))
      }
    })
  }
})
