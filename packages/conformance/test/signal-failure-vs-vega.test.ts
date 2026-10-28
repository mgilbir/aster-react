// @vitest-environment node
/**
 * A top-level signal whose update expression throws stops vega's pass at that signal: it logs the error, the signals declared
 * after it never get a value, and nothing ranked after the signals (every dataset, scale, mark and guide) runs. Aster resolves
 * signals in rounds while its dependencies resolve and used to swallow the throw; it must tell "not resolvable yet" from "threw"
 * the way vega's topological order does.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec, evaluateChart, compileChart, datasetsOfScene } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const silent = { logger: { error: () => {}, warn: () => {} } } as never
const base = (): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 100,
  height: 50,
  padding: 5,
  signals: [{ name: 'a', value: 1 }, { name: 'c', value: {} }],
  data: [{ name: 't', values: [{ x: 1 }, { x: 2 }] }, { name: 'u', source: 't', transform: [{ type: 'formula', expr: 'datum.x * 2', as: 'k' }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 5], range: 'width' }],
  axes: [{ orient: 'bottom', scale: 'x' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { signal: 'a' } } } }],
})
const CASES: Record<string, (s: any) => void> = {
  'a signal that reads a member of nothing': (s) => { s.signals.push({ name: 'b', update: 'c.x.y' }) },
  'a throw, then a signal that reads an earlier one': (s) => { s.signals.push({ name: 'b', update: 'c.x.y' }, { name: 'd', update: 'a + 1' }) },
  'a throw in the first signal': (s) => { s.signals.unshift({ name: 'b', update: '[][0].y' }) },
  'a throw between signals that the marks read': (s) => {
    s.signals.push({ name: 'b', update: 'c.x.y' }, { name: 'd', update: 'a + 1' })
    s.marks[0].encode.update.y = { signal: 'd' }
  },
  'a throw, with a title and a legend': (s) => {
    s.signals.push({ name: 'b', update: 'c.x.y' })
    s.title = { text: 'T' }
    s.scales.push({ name: 'col', type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] })
    s.legends = [{ fill: 'col' }]
  },
  'a throw in a signal computed from another signal': (s) => { s.signals.push({ name: 'e', update: 'a * 2' }, { name: 'b', update: 'c.x.y + e' }) },
  'an init that throws': (s) => { s.signals.push({ name: 'b', init: 'c.x.y' }) },
  'a throw in the width signal': (s) => { delete s.width; s.signals.unshift({ name: 'width', update: '[][0].y' }) },
}

describe('a signal whose update throws stops the pass like it stops vega', () => {
  for (const [name, edit] of Object.entries(CASES)) {
    it(name, async () => {
      const spec = base()
      edit(spec)
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      expect(vega.errors.length, 'the case must make vega log an error').toBeGreaterThan(0)
      const errors: unknown[] = []
      const scene = evaluateChart(compileChart(JSON.parse(JSON.stringify(spec))), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never)
      expect(errors.length, 'the engine logs the failure').toBeGreaterThan(0)
      const mine = renderSpec(JSON.parse(JSON.stringify(spec)), silent) as string
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
      const all = datasetsOfScene(scene)
      const got: Record<string, unknown> = {}
      for (const d of spec.data) got[d.name] = JSON.parse(JSON.stringify(all.get(d.name) ?? null))
      expect(got).toEqual(vega.datasets)
    }, 30_000)
  }
  // A signal ranked after the datasets (it reads a signal declared after it) throws after them: the datasets,
  // the scales and the marks ran, and only the pass's post-run work (the layout that grows the padding) is lost.
  const LATE: Record<string, (s: any) => void> = {
    'a signal that reads a signal declared after it': (s) => { s.signals.unshift({ name: 'b', update: 'c.x.y' }) },
  }
  for (const [name, edit] of Object.entries(LATE)) {
    it(name, async () => {
      const spec = base()
      spec.marks[0].encode.update.y = { value: 3 }
      edit(spec)
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      expect(vega.errors.length, 'the case must make vega log an error').toBeGreaterThan(0)
      expect(vega.datasets.t, 'vega ran the datasets').not.toBeNull()
      const errors: unknown[] = []
      const scene = evaluateChart(compileChart(JSON.parse(JSON.stringify(spec))), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never)
      expect(errors.length, 'the engine logs the failure').toBeGreaterThan(0)
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(renderSpec(JSON.parse(JSON.stringify(spec)), silent) as string)).slice(0, 3)).toEqual([])
      expect(JSON.parse(JSON.stringify(datasetsOfScene(scene).get('t') ?? null))).toEqual(vega.datasets.t)
    }, 30_000)
  }
  it('the same signals without the throw draw the chart', async () => {
    const spec = base()
    spec.signals.push({ name: 'b', update: 'c.x' }, { name: 'd', update: 'a + 1' })
    const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
    expect(vega.errors).toEqual([])
    expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(renderSpec(JSON.parse(JSON.stringify(spec)), silent) as string)).slice(0, 3)).toEqual([])
  })
})
