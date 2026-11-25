// @vitest-environment jsdom
/**
 * A tuple a handler writes into a selection store holds numbers where it was given Dates, once a dataset's filter tests that store
 * (vega-selections `selectionTest` rewrites the tuple in place, and a signal that holds the tuple shows it); a store nothing tests keeps
 * its Dates; a dataset with no row to test leaves them too. One field per tuple: vega leaves the values after the first field that fails
 * a test as Dates, which depends on the rows the filter meets and which the loop, that does not run the filter, does not follow. Real vega against the event loop, over generated tuples, with and without a filter reading the store.
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

interface Shape { filter: 'none' | 'formula-reads-count' | 'tests-store' | 'tests-other-store'; list: boolean; emptyRows: boolean; fields: number }

const specOf = (s: Shape, ms: number[], driven: boolean): VgSpec => {
  const values = ms.map((m) => `datetime(${m})`)
  const tupleValues = s.list ? `[[${values.join(', ')}]]` : `[${values.join(', ')}]`
  const fieldDefs = (s.list ? [{ type: 'E', field: 'a' }] : ms.map((_, i) => ({ type: 'E', field: `f${i}` })))
  const transform = s.filter === 'tests-store' ? [{ type: 'filter', expr: "!length(data('st')) || vlSelectionTest('st', datum)" }]
    : s.filter === 'tests-other-store' ? [{ type: 'filter', expr: "!length(data('other')) || vlSelectionTest('other', datum)" }]
    : s.filter === 'formula-reads-count' ? [{ type: 'formula', as: 'n', expr: "length(data('st'))" }] : []
  return {
    width: 50, height: 50, autosize: 'none',
    signals: [
      { name: 'go', value: 0, ...(driven ? { on: [{ events: 'click', update: 'go + 1' }] } : {}) },
      { name: 'tup', on: [{ events: { signal: 'go' }, update: `{unit: '', fields: ${JSON.stringify(fieldDefs)}, values: ${tupleValues}}`, force: true }] },
      { name: 'mod', on: [{ events: { signal: 'tup' }, update: "modify('st', tup, true)" }] },
    ],
    data: [
      { name: 'st' }, { name: 'other' },
      { name: 't', values: s.emptyRows ? [] : ms.map((_, i) => Object.fromEntries(fieldDefs.map((f) => [f.field, 1_000_000 * (i + 1)]))) },
      { name: 'd', source: 't', transform },
    ],
    marks: [{ type: 'rect', from: { data: 'd' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 5 }, height: { value: 5 } } } }],
  } as unknown as VgSpec
}

async function vegaTuple(spec: VgSpec): Promise<unknown> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  await view.runAsync()
  view.signal('go', 1)
  await view.runAsync()
  const tup = JSON.stringify(view.signal('tup'), (_k, v) => v)
  view.finalize()
  return JSON.parse(tup)
}

function asterTuple(spec: VgSpec): unknown {
  const chart = compileChart(structuredClone(spec))
  const scene = evaluateChart(chart, {})
  const el = renderSceneToDomElement(scene, document)
  document.body.appendChild(el)
  const seen: Record<string, unknown> = {}
  const b = bindSceneSignals(el, scene, {}, { onSignal: (n, v) => { seen[n] = v } })
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }))
  const out = JSON.parse(JSON.stringify(seen.tup))
  b.release()
  el.remove()
  return out
}

describe('a store tuple written by a handler: Dates become numbers iff a dataset filter tests the store (vega)', () => {
  it('agrees with vega over generated tuples and filters', async () => {
    const r = rng(2026)
    const filters: Shape['filter'][] = ['none', 'formula-reads-count', 'tests-store', 'tests-other-store']
    let numeric = 0
    let dated = 0
    for (let k = 0; k < 60; k++) {
      const shape: Shape = { filter: filters[k % 4]!, list: r() < 0.4, emptyRows: r() < 0.15, fields: 1 }
      const ms = Array.from({ length: shape.list ? 1 + Math.floor(r() * 3) : shape.fields }, () => Math.floor(r() * 2e12))
      const want = await vegaTuple(specOf(shape, ms, false))
      const got = asterTuple(specOf(shape, ms, true))
      expect(got, JSON.stringify(shape)).toEqual(want)
      const first = ((want as { values: unknown[] }).values[0])
      if (typeof first === 'number' || (Array.isArray(first) && typeof first[0] === 'number')) numeric++; else dated++
    }
    // both outcomes occurred: the comparison is not vacuous
    expect(numeric).toBeGreaterThan(5)
    expect(dated).toBeGreaterThan(5)
  }, 120_000)
})
