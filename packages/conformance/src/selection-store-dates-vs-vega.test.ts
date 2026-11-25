// @vitest-environment jsdom
/**
 * A tuple a handler writes into a selection store holds numbers where it was given Dates, once a dataset's filter tests that store
 * (vega-selections `selectionTest` rewrites the tuple in place, and a signal that holds it shows it); a store nothing tests keeps
 * its Dates; a dataset with no row to test leaves them too. Which values are rewritten is decided by the tests the filter makes:
 * `testPoint` turns a field's values into numbers, then tests the field, and stops at the first that fails, so the fields after it
 * are Dates still; a union stops at the first tuple that matches, so a later tuple is not reached by that row. Real vega against the
 * event loop, over generated tuples (1-4 fields, enumerated and range, a list of values or one per field), one or two tuples, rows
 * that pass a generated prefix of the fields, and filters of several shapes (a dataset drawn from a filtered one, a filter after a
 * transform, a conditional expression that tests only some rows).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, type VgSpec } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { bindSceneSignals } from '@aster-charts/core/signals'
import '@aster-charts/core/addons'

function rng(seed: number): () => number {
  let a = seed | 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

interface Shape {
  filter: 'none' | 'formula-reads-count' | 'tests-store' | 'tests-other-store' | 'chain' | 'after-transform' | 'conditional' | 'two-datasets'
  list: boolean
  emptyRows: boolean
  fields: number
  /** per field: an enumerated value, or a range */
  types: Array<'E' | 'R'>
  tuples: number
  /** how many of a row's fields hold the tuple's value (the others hold something else) */
  prefixes: number[]
}

/** The `values` of tuple `k`: a date (or a range of two) per field, in milliseconds. */
const tupleMs = (s: Shape, k: number, ms: number[]): number[][] => ms.map((m, i) => (s.types[i] === 'R' ? [m + k, m + k + 1_000_000] : [m + k]))

const specOf = (s: Shape, ms: number[], driven: boolean): VgSpec => {
  const tupleDef = (k: number): string => {
    const per = tupleMs(s, k, ms).map((m, i) => (s.types[i] === 'R' ? `[datetime(${m[0]}), datetime(${m[1]})]` : `datetime(${m[0]})`))
    return s.list ? `{unit: '', fields: ${JSON.stringify([{ type: 'E', field: 'a' }])}, values: [[${per.join(', ')}]]}`
      : `{unit: '', fields: ${JSON.stringify(ms.map((_, i) => ({ type: s.types[i], field: `f${i}` })))}, values: [${per.join(', ')}]}`
  }
  const field = (i: number): string => (s.list ? 'a' : `f${i}`)
  const test = "vlSelectionTest('st', datum)"
  const transform = s.filter === 'tests-store' ? [{ type: 'filter', expr: `!length(data('st')) || ${test}` }]
    : s.filter === 'tests-other-store' ? [{ type: 'filter', expr: "!length(data('other')) || vlSelectionTest('other', datum)" }]
    : s.filter === 'formula-reads-count' ? [{ type: 'formula', as: 'n', expr: "length(data('st'))" }]
    : s.filter === 'after-transform' ? [{ type: 'filter', expr: 'datum.keep' }, { type: 'filter', expr: test }]
    : s.filter === 'conditional' ? [{ type: 'filter', expr: `datum.keep ? ${test} : true` }]
    : s.filter === 'two-datasets' || s.filter === 'chain' ? [{ type: 'filter', expr: test }] : []
  const rows = s.emptyRows ? [] : s.prefixes.map((pass, r) => ({
    ...Object.fromEntries(ms.map((m, i) => [field(i), i < pass ? m : -1 - r])),
    keep: r % 2 === 0,
  }))
  // (a range field holds the tuple's low end when it passes: inside the range)
  const data: Array<Record<string, unknown>> = [
    { name: 'st' }, { name: 'other' },
    { name: 't', values: rows },
    s.filter === 'chain'
      ? { name: 'd0', source: 't', transform: [{ type: 'filter', expr: 'datum.keep' }] }
      : { name: 'd', source: 't', transform },
  ]
  if (s.filter === 'chain') data.push({ name: 'd', source: 'd0', transform })
  if (s.filter === 'two-datasets') data.push({ name: 'd2', source: 't', transform: [{ type: 'filter', expr: `datum.keep ? true : ${test}` }] })
  const tuples = Array.from({ length: s.tuples }, (_, k) => tupleDef(k))
  return {
    width: 50, height: 50, autosize: 'none',
    signals: [
      { name: 'go', value: 0, ...(driven ? { on: [{ events: 'click', update: 'go + 1' }] } : {}) },
      ...tuples.map((t, k) => ({ name: `tup${k}`, init: t })),
      { name: 'mod', on: [{ events: { signal: 'go' }, update: `modify('st', ${s.tuples > 1 ? `go === 1 ? tup0 : tup1` : 'tup0'}${s.tuples > 1 ? '' : ', true'})`, force: true }] },
    ],
    data,
    marks: [{ type: 'rect', from: { data: 'd' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 5 }, height: { value: 5 } } } }],
  } as unknown as VgSpec
}

const CLICKS = (s: Shape): number => s.tuples

async function vegaTuples(spec: VgSpec, shape: Shape): Promise<unknown> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  await view.runAsync()
  for (let c = 1; c <= CLICKS(shape); c++) {
    view.signal('go', c)
    await view.runAsync()
  }
  const out = JSON.parse(JSON.stringify(Array.from({ length: shape.tuples }, (_, k) => view.signal(`tup${k}`))))
  view.finalize()
  return out
}

function asterTuples(spec: VgSpec, shape: Shape): unknown {
  const chart = compileChart(structuredClone(spec))
  const scene = evaluateChart(chart, {})
  const el = renderSceneToDomElement(scene, document)
  document.body.appendChild(el)
  const b = bindSceneSignals(el, scene, {}, {})
  for (let c = 0; c < CLICKS(shape); c++) el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
  // (the tuples the handler wrote are the signals' objects: what a signal holding one shows)
  const params = (scene as unknown as { signalParams: Record<string, unknown> }).signalParams
  const out = JSON.parse(JSON.stringify(Array.from({ length: shape.tuples }, (_, k) => params[`tup${k}`])))
  b.release()
  el.remove()
  return out
}

describe('a store tuple written by a handler: its Dates become numbers as the filters that test the store make them (vega)', () => {
  it('agrees with vega over generated tuples, rows and filters', async () => {
    const r = rng(2026)
    const filters: Shape['filter'][] = ['none', 'formula-reads-count', 'tests-store', 'tests-other-store', 'chain', 'after-transform', 'conditional', 'two-datasets']
    let allNumeric = 0
    let someNumeric = 0
    let noneNumeric = 0
    for (let k = 0; k < 240; k++) {
      const list = r() < 0.2
      const fields = list ? 1 : 1 + Math.floor(r() * 4)
      const shape: Shape = {
        filter: filters[k % filters.length]!, list, emptyRows: r() < 0.1, fields,
        types: Array.from({ length: fields }, () => (r() < 0.3 ? 'R' : 'E')),
        tuples: r() < 0.4 ? 2 : 1,
        prefixes: Array.from({ length: 1 + Math.floor(r() * 4) }, () => Math.floor(r() * (fields + 1))),
      }
      const ms = Array.from({ length: fields }, () => Math.floor(r() * 2e12))
      const want = await vegaTuples(specOf(shape, ms, false), shape)
      const got = asterTuples(specOf(shape, ms, true), shape)
      expect(got, JSON.stringify(shape)).toEqual(want)
      // how much of the tuples vega rewrote: all of the values, some, none
      const flat = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(flat) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(flat) : [v])
      const values = (want as Array<{ values: unknown[] }>).flatMap((t) => t.values.flatMap(flat))
      const numbers = values.filter((v) => typeof v === 'number').length
      if (numbers === values.length) allNumeric++
      else if (numbers > 0) someNumeric++
      else noneNumeric++
    }
    // every outcome occurred, the partly rewritten tuples (the first failing field) among them: the comparison is not vacuous
    expect(allNumeric).toBeGreaterThan(10)
    expect(someNumeric).toBeGreaterThan(10)
    expect(noneNumeric).toBeGreaterThan(10)
  }, 240_000)
})
