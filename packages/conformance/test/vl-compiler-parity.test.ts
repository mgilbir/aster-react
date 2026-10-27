// @vitest-environment node
/**
 * @aster/vl against vega-lite 6.4.3, one compiler rule at a time (the gallery-conformance lane for the compiler).
 *
 * Every case is a small inline Vega-Lite spec. Both compilers' output is rendered by REAL vega and the canonical SVGs are
 * compared exactly; the size / layout part of the compiled Vega (root width / height, size signals, the positional scales'
 * ranges and paddings) is also compared structurally, so a defect shows what differs and not only that the render does.
 * The cases come from the official galleries (the example named in the group), cut down to inline data.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const DATA = {
  values: [
    { c: 'A', g: 'p', x: 1, y: 2, v: 5, t: '2001-01-01' },
    { c: 'B', g: 'q', x: 2, y: 4, v: 9, t: '2002-01-01' },
    { c: 'A', g: 'q', x: 3, y: 3, v: 2, t: '2003-01-01' },
    { c: 'C', g: 'p', x: 4, y: 6, v: 7, t: '2004-01-01' },
    { c: 'B', g: 'p', x: 5, y: 5, v: 4, t: '2005-01-01' },
    { c: 'C', g: 'q', x: 6, y: 8, v: 6, t: '2006-01-01' },
  ],
}
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })
const t = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'temporal', ...extra })

type Case = [string, Record<string, any>]
const GROUPS: Record<string, Case[]> = {
  // layoutsize/parse.ts defaultUnitSize: a view without a scale on a dimension takes the DISCRETE size (the step, 20), not 300
  '1D views and view-config sizes (bar_1d, point_1d, bar_1d_step_config)': [
    ['1D bar over x', { data: DATA, mark: 'bar', encoding: { x: q('v') } }],
    ['1D bar over y', { data: DATA, mark: 'bar', encoding: { y: q('v') } }],
    ['1D point over x', { data: DATA, mark: 'point', encoding: { x: q('v') } }],
    ['1D tick over y', { data: DATA, mark: 'tick', encoding: { y: q('v') } }],
    ['1D bar with config.view.step', { data: DATA, config: { view: { step: 15 } }, mark: 'bar', encoding: { y: q('v') } }],
    ['1D point with config.view.discreteWidth as a step', { data: DATA, config: { view: { discreteWidth: { step: 11 } } }, mark: 'point', encoding: { y: q('v') } }],
    ['1D point with config.view.discreteWidth as a number', { data: DATA, config: { view: { discreteWidth: 77 } }, mark: 'point', encoding: { y: q('v') } }],
    ['1D bar with an explicit width', { data: DATA, width: 120, mark: 'bar', encoding: { y: q('v') } }],
    ['continuous x and y use config.view.continuousWidth / continuousHeight', { data: DATA, config: { view: { continuousWidth: 150, continuousHeight: 90 } }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['discrete x uses config.view.step', { data: DATA, config: { view: { step: 31 } }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }],
    ['discrete x with config.view.discreteWidth as a number', { data: DATA, config: { view: { discreteWidth: 140 } }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }],
    ['vertical bar with only a temporal x (bar_1d_temporal)', { data: DATA, mark: { type: 'bar', orient: 'vertical' }, encoding: { x: t('t') } }],
    ['horizontal bar with only a quantitative y (bar_1d_dimension_only)', { data: DATA, mark: { type: 'bar', orient: 'horizontal' }, encoding: { y: q('v') } }],
    ['vertical bar with only a nominal x', { data: DATA, mark: 'bar', encoding: { x: n('c') } }],
    ['bar with config.scale.barBandPaddingInner and only a temporal x', { data: DATA, config: { scale: { barBandPaddingInner: 0.3 } }, mark: { type: 'bar', orient: 'vertical' }, encoding: { x: t('t') } }],
    ['bar with config.scale.bandPaddingInner and no position', { data: DATA, config: { scale: { bandPaddingInner: 0.4 } }, mark: { type: 'bar', orient: 'vertical' }, encoding: { color: n('c') } }],
    ['layered 1D bar and text', { data: DATA, layer: [{ mark: 'bar', encoding: { y: q('v') } }, { mark: 'text', encoding: { y: q('v'), text: q('v') } }] }],
  ],
  // scale/range.ts getPositionStep / getOffsetStep: the step belongs to the OFFSET scale when its channel is discrete
  'xOffset / yOffset steps (bar_grouped, bar_grouped_horizontal, bar_grouped_step_for_offset)': [
    ['grouped bars', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['grouped bars, horizontal', { data: DATA, mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }), yOffset: n('g'), color: n('g') } }],
    ['grouped bars with width.step (for the offset)', { data: DATA, width: { step: 24 }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['grouped bars with width.step for the position', { data: DATA, width: { step: 40, for: 'position' }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['grouped bars with config.view.step', { data: DATA, config: { view: { step: 12 } }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['grouped bars with a fixed width', { data: DATA, width: 200, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['grouped bars with an explicit scale padding', { data: DATA, mark: 'bar', encoding: { x: n('c', { scale: { paddingInner: 0.4 } }), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['stacked and grouped bars', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['layered grouped bars and text', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v'), xOffset: n('g'), color: n('g') } }, { mark: 'text', encoding: { x: n('c'), y: q('v'), xOffset: n('g'), text: q('v') } }] }],
  ],
  // layoutsize/assemble.ts sizeExpr: bandspace(n, paddingInner, paddingOuter) where a POINT scale has paddingInner = 1
  'step signals of a point scale (argmin_spaces, circle_flatten, circle_scale_quantile)': [
    ['point mark over a nominal y', { data: DATA, mark: 'point', encoding: { x: q('x'), y: n('c') } }],
    ['point mark over a nominal x', { data: DATA, mark: 'point', encoding: { x: n('c'), y: q('y') } }],
    ['point mark, explicit scale padding', { data: DATA, mark: 'point', encoding: { x: q('x'), y: n('c', { scale: { padding: 0.2 } }) } }],
    ['point mark, explicit paddingOuter', { data: DATA, mark: 'point', encoding: { x: q('x'), y: n('c', { scale: { paddingOuter: 0.1 } }) } }],
    ['point mark, config.scale.pointPadding', { data: DATA, config: { scale: { pointPadding: 0.3 } }, mark: 'point', encoding: { x: q('x'), y: n('c') } }],
    ['line over an ordinal x with width.step', { data: DATA, width: { step: 33 }, mark: 'line', encoding: { x: { field: 'c', type: 'ordinal' }, y: q('y') } }],
    ['circle with a quantile colour and a nominal y', { data: DATA, mark: 'circle', encoding: { x: q('x'), y: n('c'), color: q('v', { scale: { type: 'quantile' } }) } }],
  ],
  // data/parse.ts: the user's transforms run BEFORE bin (the extent is of the filtered rows); valueref.ts midPoint: a binned field
  // on a point-positioned mark sits at the middle of its bin; scale/range.ts getBinStepSignal: bins set the size range's step
  'binned fields on point marks, bin after transform (circle_binned, hconcat_weather)': [
    ['filter then bin', { data: DATA, transform: [{ filter: 'datum.x > 2' }], mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } }],
    ['calculate then bin', { data: DATA, transform: [{ calculate: 'datum.x * 10', as: 'x10' }], mark: 'bar', encoding: { x: q('x10', { bin: true }), y: { aggregate: 'count' } } }],
    ['filter then bin in an hconcat', { data: DATA, transform: [{ filter: 'datum.x > 2' }], hconcat: [{ mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } }, { mark: 'point', encoding: { x: q('x', { bin: true }), y: q('y', { bin: true }), size: { aggregate: 'count' } } }] }],
    ['binned circle with a count size', { data: DATA, mark: 'circle', encoding: { x: q('x', { bin: true }), y: q('y', { bin: true }), size: { aggregate: 'count' } } }],
    ['binned circle, x only, with a count size', { data: DATA, mark: 'circle', encoding: { x: q('x', { bin: { maxbins: 3 } }), y: n('c'), size: { aggregate: 'count' } } }],
    ['binned text', { data: DATA, mark: 'text', encoding: { x: q('x', { bin: true }), y: q('y', { bin: true }), text: { aggregate: 'count' } } }],
    ['binned line', { data: DATA, mark: 'line', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } }],
  ],
}

const SIZE_KEYS = (vg: any) => ({
  width: vg.width,
  height: vg.height,
  signals: (vg.signals ?? []).filter((s: any) => /width|height|step/i.test(s.name)).map((s: any) => ({ name: s.name, value: s.value, update: s.update, init: s.init })),
  scales: Object.fromEntries((vg.scales ?? []).filter((s: any) => /^[xy](Offset)?$/.test(s.name)).map((s: any) => [s.name, { type: s.type, range: s.range, paddingInner: s.paddingInner, paddingOuter: s.paddingOuter, padding: s.padding }])),
})
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const deepFreeze = <T,>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

async function check(spec: Record<string, any>): Promise<void> {
  const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
  const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
  expect(plain(SIZE_KEYS(ours)), 'size / layout of the compiled Vega').toEqual(plain(SIZE_KEYS(oracle)))
  const [ref, mine, refChecked] = await Promise.all([renderWithVega(oracle), renderWithVegaChecked(plain(ours)), renderWithVegaChecked(oracle)])
  const inherited = new Set([...refChecked.errors, ...refChecked.warnings])
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m))).toEqual([])
  expect(diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
}

for (const [group, cases] of Object.entries(GROUPS)) {
  describe(`@aster/vl == vega-lite: ${group}`, () => {
    for (const [name, spec] of cases) it(name, () => check(spec), 30_000)
  })
}
