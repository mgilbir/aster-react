// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import '@aster-charts/core/transforms'
import { createChartStream } from '@aster-charts/core'
import './vl'
import { forEachVariant } from './testing/variants'
import type { ChartHandle } from './chart-types'
import { normalizeChartSpec } from './spec'
import { useChart } from './useChart'
import { renderChartToStaticMarkup } from './ssr'
import { handleChartWorkerRequest } from './worker-impl'

// A spec's rows belong to the caller. The Vega-Lite compiler hands the user's own row arrays and objects through to the Vega
// spec it makes (it copies the spec's structure, not its data), so nothing downstream may write to them: not the compile,
// not an evaluation, an incremental update, a transform, a selection, a `modify`, a stream, the worker path or SSR.
// Every spec here is deep-frozen (ES modules are strict, so a write throws); what renders must also be what an unfrozen copy
// of the same spec renders, and nothing may be reported to the logger.

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const rows = (n: number, seed = 1): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({
  k: `k${i % 4}`, g: i % 3 === 0 ? 'a' : 'b', x: (i * 7 + seed) % 23, y: (i * 13 + seed) % 17, t: `2024-0${1 + (i % 9)}-1${i % 10}`,
  on: i % 5 === 0, nested: { v: i }, list: [i, i + 1],
}))

const VL = 'https://vega.github.io/schema/vega-lite/v6.json'
const xy = { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } }

/** Vega-Lite specs over the same rows, between them every transform family, composition and selection kind. */
const vlSpecs = (data: Array<Record<string, unknown>>): Record<string, Record<string, unknown>> => ({
  pointSelection: {
    $schema: VL, data: { name: 'table', values: data }, width: 120, height: 80,
    params: [{ name: 'pick', select: { type: 'point', fields: ['k'] } }],
    mark: { type: 'point', size: 80 },
    encoding: { ...xy, color: { condition: { param: 'pick', field: 'k', type: 'nominal' }, value: 'gray' } },
  },
  nearestHover: {
    $schema: VL, data: { values: data }, width: 120, height: 80,
    layer: [
      { mark: { type: 'area', interpolate: 'step-after', opacity: 0.2 }, encoding: { x: xy.x, y: { aggregate: 'mean', field: 'y', type: 'quantitative' }, color: { field: 'g', type: 'nominal' } } },
      { transform: [{ filter: 'datum.on' }], mark: 'rule', encoding: { x: xy.x, y: xy.y } },
      {
        transform: [{ pivot: 'g', value: 'y', groupby: ['x'] }, { window: [{ op: 'min', field: 'a', as: 'a' }], sort: [{ field: 'x' }], frame: [null, 0] }],
        mark: 'rule',
        encoding: { x: xy.x, opacity: { condition: { value: 0.3, param: 'hover', empty: false }, value: 0 }, tooltip: [{ field: 'x', type: 'quantitative' }, { field: 'a', type: 'quantitative', format: '.2f' }] },
        params: [{ name: 'hover', select: { type: 'point', fields: ['x'], nearest: true, on: 'pointermove', clear: 'pointerout' } }],
      },
    ],
  },
  transforms: {
    $schema: VL, data: { values: data }, width: 120, height: 80,
    transform: [
      { calculate: 'datum.x * 2 + datum.nested.v', as: 'x2' },
      { filter: 'datum.y > 1' },
      { joinaggregate: [{ op: 'mean', field: 'y', as: 'my' }], groupby: ['k'] },
      { window: [{ op: 'rank', as: 'r' }], sort: [{ field: 'x' }], groupby: ['g'] },
      { fold: ['x', 'y'], as: ['key', 'val'] },
      { timeUnit: 'month', field: 't', as: 'm' },
      { bin: true, field: 'val', as: 'bv' },
      { impute: 'val', key: 'x2', groupby: ['key'], value: 0 },
      { flatten: ['list'], as: ['item'] },
      { lookup: 'k', from: { data: { name: 'other' }, key: 'k', fields: ['label'] } },
    ],
    datasets: { other: [{ k: 'k0', label: 'zero' }, { k: 'k1', label: 'one' }] },
    mark: 'bar',
    encoding: { x: { field: 'key', type: 'nominal' }, y: { aggregate: 'sum', field: 'val', type: 'quantitative', stack: 'zero' }, color: { field: 'g', type: 'nominal' } },
  },
  stats: {
    $schema: VL, data: { values: data }, width: 120, height: 80,
    layer: [
      { transform: [{ density: 'y', groupby: ['g'] }], mark: 'line', encoding: { x: { field: 'value', type: 'quantitative' }, y: { field: 'density', type: 'quantitative' } } },
      { transform: [{ regression: 'y', on: 'x' }], mark: 'line', encoding: xy },
      { transform: [{ loess: 'y', on: 'x' }], mark: 'line', encoding: xy },
      { transform: [{ quantile: 'y', step: 0.25 }], mark: 'point', encoding: { x: { field: 'prob', type: 'quantitative' }, y: { field: 'value', type: 'quantitative' } } },
    ],
  },
  composite: { $schema: VL, data: { values: data }, mark: 'boxplot', encoding: { x: { field: 'k', type: 'nominal' }, y: xy.y } },
  facetConcatRepeat: {
    $schema: VL,
    vconcat: [
      { data: { values: data }, facet: { field: 'g', type: 'nominal' }, spec: { mark: 'point', encoding: xy, width: 60, height: 40 } },
      { data: { values: data }, repeat: ['x', 'y'], spec: { mark: 'bar', width: 60, height: 40, encoding: { x: { field: { repeat: 'repeat' }, bin: true, type: 'quantitative' }, y: { aggregate: 'count', type: 'quantitative' } } } },
      { data: { values: data }, mark: { type: 'tick' }, encoding: { x: xy.x }, width: 60 },
    ],
  },
})

forEachVariant(['svg'], (Chart, variant) => describe('every path leaves a deep-frozen spec\'s rows alone', () => {
  afterEach(() => { document.body.innerHTML = '' })

  for (const name of Object.keys(vlSpecs([]))) {
    variant.it(['signals'], `${name}: <Chart> renders, updates and handles events on a frozen Vega-Lite spec as on an unfrozen copy`, () => {
      const errors: unknown[] = []
      const logger = { error: (...a: unknown[]) => { errors.push(a) }, warn: () => {} }
      const onError = (e: Error): void => { errors.push(e) }
      type Run = { html: () => string; root: ReturnType<typeof createRoot>; container: HTMLElement; ref: React.RefObject<ChartHandle | null> }
      const mount = (spec: Record<string, unknown>): Run => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const ref = React.createRef<ChartHandle>()
        act(() => { root.render(<Chart ref={ref} spec={spec as never} width={160} height={120} logger={logger} onError={onError} />) })
        return { html: () => container.innerHTML, root, container, ref }
      }
      /** Where each symbol mark is drawn, in client coordinates: a click there is a click on that mark (the hit index decides by position). */
      const markPoints = (run: Run): Array<[number, number]> => {
        const pad = run.ref.current!.getScene()!.padding!
        const out: Array<[number, number]> = []
        for (const path of Array.from(run.container.querySelectorAll('g.role-mark path'))) {
          const m = /^translate\(([-\d.e]+),([-\d.e]+)\)$/.exec(path.getAttribute('transform') ?? '')
          if (m) out.push([Number(m[1]) + pad.left, Number(m[2]) + pad.top])
        }
        return out
      }
      const steps: Array<(spec: Record<string, unknown>) => Record<string, unknown>> = [
        () => vlSpecs(rows(24))[name]!,
        // new rows, same structure (the incremental path), then more rows (an append), then fewer
        () => vlSpecs(rows(24, 2))[name]!,
        () => vlSpecs(rows(30, 2))[name]!,
        () => vlSpecs(rows(10, 3))[name]!,
      ]
      const frozenRun = mount(deepFreeze(steps[0]!({})))
      const plainRun = mount(copy(steps[0]!({})))
      expect(frozenRun.html()).toBe(plainRun.html())
      let clickedSomething = false
      let hoverChangedSomething = false
      for (const step of steps.slice(1)) {
        const next = step({})
        act(() => { frozenRun.root.render(<Chart ref={frozenRun.ref} spec={deepFreeze(copy(next)) as never} width={160} height={120} logger={logger} onError={onError} />) })
        act(() => { plainRun.root.render(<Chart ref={plainRun.ref} spec={copy(next) as never} width={160} height={120} logger={logger} onError={onError} />) })
        expect(frozenRun.html()).toBe(plainRun.html())
        // events: a click on each of the first marks, at the mark's own coordinates (point selections toggle with the shift key),
        // pointer moves across the view (nearest selections)
        const afterClicks: string[] = []
        const afterMoves: string[] = []
        for (const run of [frozenRun, plainRun]) {
          const svg = run.container.querySelector('svg')!
          const beforeClicks = run.html()
          for (const [x, y] of markPoints(run).slice(0, 6)) {
            act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, shiftKey: true })) })
          }
          afterClicks.push(run.html())
          if (run.html() !== beforeClicks) clickedSomething = true
          const beforeMoves = run.html()
          for (const x of [5, 40, 80, 120]) act(() => { svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 30 })) })
          afterMoves.push(run.html())
          if (run.html() !== beforeMoves) hoverChangedSomething = true
          act(() => { svg.dispatchEvent(new PointerEvent('pointerout', { bubbles: true })) })
        }
        expect(afterClicks[0]).toBe(afterClicks[1])
        expect(afterMoves[0]).toBe(afterMoves[1])
        expect(frozenRun.html()).toBe(plainRun.html())
      }
      // the events did something: a comparison of two DOMs that never changed would hold for any implementation
      if (name === 'pointSelection') expect(clickedSomething, 'the clicks toggled a point selection').toBe(true)
      if (name === 'nearestHover') expect(hoverChangedSomething, 'the pointer moves moved the nearest selection').toBe(true)
      expect(errors).toEqual([])
      expect(frozenRun.container.querySelector('svg')).not.toBeNull()
      act(() => { frozenRun.root.unmount(); plainRun.root.unmount() })
    })
  }

  variant.it(['signals'], 'a frozen named dataset takes `data` overrides and `dataChanges` changesets', () => {
    const errors: unknown[] = []
    const onError = (e: Error): void => { errors.push(e) }
    const logger = { error: (...a: unknown[]) => { errors.push(a) }, warn: () => {} }
    const spec = deepFreeze(vlSpecs(rows(12)).pointSelection!)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const table = deepFreeze(rows(12, 5))
    act(() => { root.render(<Chart spec={spec as never} data={{ table }} width={160} height={120} logger={logger} onError={onError} />) })
    const edited = deepFreeze(table.map((r, i) => (i === 3 ? { ...r, x: 99 } : r)))
    act(() => { root.render(<Chart spec={spec as never} data={{ table: edited }} dataChanges={{ table: [3] }} width={160} height={120} logger={logger} onError={onError} />) })
    expect(errors).toEqual([])
    expect(container.querySelectorAll('g.role-mark path').length).toBeGreaterThan(0)
    act(() => { root.unmount() })
  })

  variant.it(['signals'], 'a Vega spec\'s frozen inline rows survive a `modify` from an event handler', () => {
    const errors: unknown[] = []
    const logger = { error: (...a: unknown[]) => { errors.push(a) }, warn: () => {} }
    const spec = deepFreeze({
      $schema: 'https://vega.github.io/schema/vega/v6.json', width: 100, height: 60, padding: 0, autosize: 'none',
      data: [{ name: 't', values: [{ a: 1, n: 0 }, { a: 2, n: 0 }] }],
      signals: [{ name: 'bump', value: 0, on: [{ events: 'click', update: 'modify("t", null, null, null, data("t")[0], {"n": 7})' }] }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { signal: 'datum.a * 10' }, y: { value: 0 }, width: { signal: 'datum.n + 1' }, height: { value: 5 }, fill: { value: 'steelblue' } } } }],
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart spec={spec as never} width={100} height={60} logger={logger} />) })
    act(() => { container.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(errors).toEqual([])
    expect(spec.data[0]!.values).toEqual([{ a: 1, n: 0 }, { a: 2, n: 0 }])
    expect(container.querySelector('path, rect.mark, g.role-mark')).not.toBeNull()
    act(() => { root.unmount() })
  })
}))

describe('the paths outside <Chart> leave a deep-frozen spec\'s rows alone', () => {
  it('the headless hook, SSR, the worker handler and a stream read frozen rows without writing them', () => {
    const errors: unknown[] = []
    for (const [name, spec] of Object.entries(vlSpecs(rows(16)))) {
      const frozen = deepFreeze(copy(spec))
      const ssr = renderChartToStaticMarkup(frozen as never)
      expect(ssr, name).toBe(renderChartToStaticMarkup(copy(spec) as never))
      const res = handleChartWorkerRequest({ id: 1, spec: frozen as never, input: { width: 160, height: 120 } })
      expect('error' in res ? res.error : undefined, name).toBeUndefined()
      // a stream over the compiled spec: snapshots and appends of frozen rows
      const compiled = normalizeChartSpec(frozen as never)
      const stream = createChartStream(compiled)
      const dataName = (compiled.data as Array<{ name: string; values?: unknown }>).find((d) => Array.isArray(d.values))?.name
      if (dataName) {
        stream.push({ append: { [dataName]: deepFreeze(rows(4, 9)) } })
        expect(stream.flush(), name).not.toBeNull()
        stream.push({ data: { [dataName]: deepFreeze(rows(8, 4)) } })
        expect(stream.flush(), name).not.toBeNull()
      }
      stream.close()
      function Probe(): React.ReactElement {
        const { error } = useChart(frozen as never)
        if (error) errors.push([name, error])
        return <div />
      }
      const container = document.createElement('div')
      const root = createRoot(container)
      act(() => { root.render(<Probe />) })
      act(() => { root.unmount() })
    }
    expect(errors).toEqual([])
  })
})
