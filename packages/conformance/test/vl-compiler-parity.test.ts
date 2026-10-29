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
import { expressionDiff, expressionsOf } from './vl-expressions.js'

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
const BOX = {
  values: Array.from({ length: 48 }, (_, i) => ({
    c: ['A', 'B', 'C'][i % 3],
    g: i % 2 ? 'p' : 'q',
    x: i % 5,
    v: [3, 5, 4, 6, 5, 4, 7, 5, 6, 4, 5, 6, 40, 5, 6, 4, -30, 5, 4, 6][i % 20] + (i % 7),
    t: `${2000 + (i % 4)}-01-01`,
  })),
}
const SPARSE = {
  values: [
    { c: 'A', g: 'p', x: 1, v: 2 },
    { c: 'B', g: 'q', x: 2, v: 5 },
    { c: 'A', g: 'q', x: 3, v: 3 },
    { c: 'B', g: 'q', x: 4, v: 6 },
  ],
}
const GAPS = {
  values: [
    { a: 0, b: 28, c: 0 }, { a: 0, b: 91, c: 1 }, { a: 1, b: 43, c: 0 }, { a: 1, b: 55, c: 1 },
    { a: 2, b: 81, c: 0 }, { a: 2, b: 53, c: 1 }, { a: 3, b: 19, c: 0 },
  ],
}
const BINS = {
  values: [
    { bin_start: 8, bin_end: 10, count: 7, g: 'a' }, { bin_start: 10, bin_end: 12, count: 29, g: 'b' }, { bin_start: 12, bin_end: 14, count: 71, g: 'a' },
    { bin_start: 14, bin_end: 16, count: 127, g: 'b' }, { bin_start: 16, bin_end: 18, count: 94, g: 'a' }, { bin_start: 18, bin_end: 20, count: 54, g: 'b' },
  ],
}
const MONTHS = {
  values: [
    { d: '2005-01-01', v: 5, g: 'p' }, { d: '2005-01-01', v: 7, g: 'q' }, { d: '2005-02-01', v: 6, g: 'p' }, { d: '2005-02-01', v: 3, g: 'q' },
    { d: '2005-03-01', v: 9, g: 'p' }, { d: '2005-03-01', v: 4, g: 'q' }, { d: '2006-04-01', v: 8, g: 'p' },
  ],
}
const NULLS = {
  values: [
    { a: null, b: 100, c: 5 },
    { a: -10, b: null, c: 3 },
    { a: -5, b: -25, c: null },
    { a: 1, b: 30, c: 7 },
    { a: 5, b: 40, c: 2 },
    { a: 10, b: null, c: 9 },
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
  // model.ts assembleTitle: a composition anchors its title at the start; axis.ts: an empty title is no title; tooltip.ts:
  // `fieldDef.title || defaultTitle`
  'titles (area_density_facet, bar_default_tooltip_title_null)': [
    ['hconcat title', { data: DATA, title: 'A concat', hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }] }],
    ['vconcat title object with a subtitle', { data: DATA, title: { text: 'A concat', subtitle: 'sub' }, vconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['facet title', { data: DATA, title: 'A facet', facet: { row: n('g') }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['repeat title', { data: DATA, title: 'A repeat', repeat: ['y', 'v'], spec: { mark: 'point', encoding: { x: q('x'), y: q('y', { field: { repeat: 'repeat' } }) } } }],
    ['composition title with config.title.anchor', { data: DATA, config: { title: { anchor: 'end' } }, title: 'A concat', hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['unit title, middle anchor', { data: DATA, title: { text: 'A unit', anchor: 'middle' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['layer title', { data: DATA, title: 'A layer', layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] }],
    ['empty field title and a null axis title, with a tooltip', { data: DATA, mark: { type: 'bar', tooltip: true }, encoding: { x: n('c', { title: '' }), y: q('v', { axis: { title: null } }) } }],
    ['null field title', { data: DATA, mark: { type: 'bar', tooltip: true }, encoding: { x: n('c', { title: null }), y: q('v') } }],
  ],
  // legend/parse.ts mergeLegendComponent + split.ts mergeValuesWithExplicit + common.ts mergeTitle
  'legend titles merge (circle_scale_quantile, dynamic_color_legend)': [
    ['one legend for a size and a colour on a field, one with a legend title', { data: DATA, mark: 'circle', encoding: { y: n('c'), size: q('v', { scale: { type: 'quantile' } }), color: q('v', { scale: { type: 'quantile' }, legend: { title: 'Quantile' } }) } }],
    ['the same with a field title instead', { data: DATA, mark: 'circle', encoding: { y: n('c'), size: q('v', { scale: { type: 'quantize' } }), color: q('v', { scale: { type: 'quantize' }, title: 'Quantize' }) } }],
    ['layers: an explicit legend title beats an implicit one', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('c', { title: 'Letter' }) } }] }],
    ['layers: two implicit titles join', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('g') } }] }],
    ['layers: two explicit titles join', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c', { title: 'One' }) } }, { mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('g', { title: 'Two' }) } }] }],
    ['vconcat: an explicit colour title and domain beat the implicit ones', { data: DATA, vconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c', { title: 'Letter', scale: { domain: ['C', 'B', 'A'] } }) } }, { mark: 'bar', encoding: { x: { aggregate: 'count' }, y: n('c'), color: n('c') } }] }],
    ['a quantize size scale has no zero', { data: DATA, mark: 'circle', encoding: { x: q('x'), y: q('y'), size: q('v', { scale: { type: 'quantize' } }) } }],
  ],
  // bin.ts autoMaxBins: 6 bins on color / size / opacity / facets; scale/type.ts: a binned colour is a bin-ordinal scale; no
  // aggregate node without an aggregate; a binned facet groups by both ends of its bin
  'binned non-positional channels and facets (point_binned_color, trellis_scatter_binned_row)': [
    ['binned colour on a point', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v', { bin: true }) } }],
    ['binned size on a point', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v', { bin: true }) } }],
    ['binned opacity on a point', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), opacity: q('v', { bin: true }) } }],
    ['binned stroke width on a point', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), strokeWidth: q('v', { bin: true }) } }],
    ['binned colour with explicit maxbins', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v', { bin: { maxbins: 3 } }) } }],
    ['binned colour on a rect', { data: DATA, mark: 'rect', encoding: { x: n('c'), y: n('g'), color: q('v', { bin: true }) } }],
    ['binned colour on a line with a temporal x', { data: DATA, mark: 'line', encoding: { x: t('t'), y: q('y', { aggregate: 'mean' }), color: q('v', { bin: true }) } }],
    ['bin only, no aggregate: a bar', { data: DATA, mark: 'bar', encoding: { x: q('x', { bin: true }) } }],
    ['bin only, no aggregate: a point', { data: DATA, mark: 'point', encoding: { x: q('x', { bin: true }), y: q('y') } }],
    ['facet row, binned', { data: DATA, mark: 'point', encoding: { row: q('v', { bin: true }), x: q('x'), y: q('y') } }],
    ['facet column, binned, with a count bar', { data: DATA, mark: 'bar', encoding: { column: q('v', { bin: { maxbins: 3 } }), x: n('c'), y: { aggregate: 'count' } } }],
    ['wrapped facet, binned', { data: DATA, facet: q('v', { bin: { maxbins: 3 } }), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['facet with a binned size and a temporal x in the child', { data: DATA, mark: 'point', encoding: { x: t('t'), y: q('y'), size: q('v', { bin: true }), facet: n('g') } }],
    ['custom number format type on a binned tooltip', { data: DATA, usermeta: {}, config: { customFormatTypes: true, numberFormatType: 'pow' }, mark: { type: 'point', tooltip: true }, encoding: { x: q('x'), y: q('y', { bin: true }) } }],
  ],
  // normalize/pathoverlay.ts: a path mark with a point (or an area with a line) overlay is a layer of the mark and its overlays
  'path overlays (area_overlay, line_overlay, stacked_area_overlay, line_shape_overlay)': [
    ['area with a line and points', { data: DATA, mark: { type: 'area', line: true, point: true }, encoding: { x: t('t'), y: q('v') } }],
    ['area with a styled line', { data: DATA, mark: { type: 'area', line: { color: 'darkgreen' } }, encoding: { x: t('t'), y: q('v') } }],
    ['line with points', { data: DATA, mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('y') } }],
    ['line with coloured points', { data: DATA, mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('y', { aggregate: 'mean' }), color: n('g') } }],
    ['line with stroked points', { data: DATA, mark: { type: 'line', point: { filled: false, fill: 'white' } }, encoding: { x: q('x'), y: q('y', { aggregate: 'mean' }), color: n('g') } }],
    ['line with transparent points', { data: DATA, mark: { type: 'line', point: 'transparent' }, encoding: { x: q('x'), y: q('y') } }],
    ['line with sized points', { data: DATA, mark: { type: 'line', point: { size: 200 } }, encoding: { x: q('x'), y: q('y'), size: q('v') } }],
    ['line with points through config', { data: DATA, config: { line: { point: true } }, mark: 'line', encoding: { x: q('x'), y: q('y') } }],
    ['area with a line through config', { data: DATA, config: { area: { line: true } }, mark: 'area', encoding: { x: q('x'), y: q('y') } }],
    ['line with a shape channel', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), shape: n('g') } }],
    ['line with a constant shape', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), shape: { value: 'square' } } }],
    ['stacked area with a line', { data: DATA, mark: { type: 'area', line: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum' }), color: n('g') } }],
    ['stacked area (no aggregate) with points', { data: DATA, mark: { type: 'area', point: true }, encoding: { x: q('x'), y: q('v'), color: n('g') } }],
    ['normalized stacked area with a line', { data: DATA, mark: { type: 'area', line: true }, encoding: { x: q('x'), y: q('v', { aggregate: 'sum', stack: 'normalize' }), color: n('g') } }],
    ['area with a line and an opacity', { data: DATA, mark: { type: 'area', line: true, opacity: 0.4 }, encoding: { x: q('x'), y: q('v') } }],
    ['line with points in a layer', { data: DATA, layer: [{ mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('y') } }, { mark: 'rule', encoding: { y: { datum: 4 } } }] }],
    ['line with points under a shared encoding', { data: DATA, encoding: { x: q('x'), y: q('y') }, layer: [{ mark: { type: 'line', point: true } }, { mark: 'text', encoding: { text: q('v') } }] }],
    ['line with points, faceted by a row channel', { data: DATA, mark: { type: 'line', point: true }, encoding: { x: q('x'), y: q('y'), row: n('g') } }],
    ['trail with points', { data: DATA, mark: { type: 'trail', point: true }, encoding: { x: q('x'), y: q('y'), size: q('v') } }],
  ],
  // mark/encode/position-point.ts + valueref.ts: invalid values "show"; common.ts getMarkPropOrConfig: config.mark.tooltip
  'invalid values, config tooltips, child titles (test_invalid_show, test_invalid_filter)': [
    ['a line over the valid aggregate of a temporal field (coerced to quantitative, so cast to a number)', { data: { values: [{ c: 'alpha', v: 28, t: '2024-01-07' }, { c: 'beta', v: 55, t: '2024-03-19' }] }, mark: 'line', encoding: { x: { field: 't', type: 'temporal', aggregate: 'valid' }, y: { field: 'v', type: 'quantitative' } } }],
    ['invalid show: a bar, a line with points and an area in an hconcat', { data: NULLS, config: { mark: { invalid: 'show', tooltip: true } }, title: 'Invalid', hconcat: [{ mark: 'bar', encoding: { x: q('a'), y: q('b') } }, { mark: { type: 'line', point: true }, encoding: { x: q('a'), y: q('b') } }, { mark: 'area', encoding: { x: q('a'), y: q('b') } }, { mark: 'point', encoding: { x: q('a'), y: q('b') } }] }],
    ['invalid filter in a vconcat of hconcats with titles', { data: NULLS, config: { mark: { invalid: 'filter' } }, vconcat: [{ title: 'Quantitative X', hconcat: [{ mark: 'point', encoding: { x: q('a'), y: q('b') } }, { mark: 'bar', encoding: { x: q('a'), y: q('b') } }] }, { title: { text: 'Ordinal X', anchor: 'middle' }, hconcat: [{ mark: 'point', encoding: { x: { field: 'a', type: 'ordinal' }, y: q('b') } }] }] }],
    ['config.<mark>.tooltip', { data: DATA, config: { point: { tooltip: true } }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['config.mark.tooltip overridden by the mark', { data: DATA, config: { mark: { tooltip: true } }, mark: { type: 'point', tooltip: false }, encoding: { x: q('x'), y: q('y') } }],
    ['a color in one view and a size in another over one field share a legend', { data: DATA, concat: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v') } }, { mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v') } }] }],
    ['independent y scales with invalid show', { data: NULLS, config: { mark: { invalid: 'show' } }, resolve: { scale: { y: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('a'), y: q('b') } }, { mark: 'line', encoding: { x: q('a'), y: q('c') } }] }],
  ],
  // pointOrRangePosition + aggregate.ts: a ranged channel's aggregated field; rule.ts: the middle of a missing position;
  // compositemark: the types a composite reads are inferred, and the layer's shared encoding groups it
  'ranged channels, rules, composite marks (rule_extent, errorband_tooltip, bar_grouped_errorbar)': [
    ['bar between two quantitative x values', { data: DATA, mark: 'bar', encoding: { x: q('x'), x2: q('v'), y: n('c') } }],
    ['bar between two quantitative y values, count', { data: DATA, mark: 'bar', encoding: { x: q('x'), x2: q('v'), y: { aggregate: 'count' } } }],
    ['bar between two points of an ordinal scale', { data: DATA, mark: 'bar', encoding: { x: { field: 'c', type: 'ordinal', scale: { type: 'point', padding: 0 } }, x2: { field: 'g' }, y: q('v') } }],
    ['rect between two quantitative values on both axes', { data: DATA, mark: 'rect', encoding: { x: q('x'), x2: q('v'), y: q('y'), y2: q('x') } }],
    ['rule between aggregated min and max', { data: DATA, mark: 'rule', encoding: { x: n('c'), y: q('v', { aggregate: 'min' }), y2: q('v', { aggregate: 'max' }) } }],
    ['area between aggregated min and max', { data: DATA, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'max' }), y2: q('v', { aggregate: 'min' }) } }],
    ['bar between aggregated min and max', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'min' }), y2: q('v', { aggregate: 'max' }) } }],
    ['horizontal rule with only x', { data: DATA, mark: { type: 'rule', orient: 'horizontal' }, encoding: { x: q('x'), x2: q('v') } }],
    ['vertical rule with only y', { data: DATA, mark: { type: 'rule', orient: 'vertical' }, encoding: { y: q('y'), y2: q('v') } }],
    ['errorband without types', { data: DATA, mark: 'errorband', encoding: { y: { field: 'v', type: 'quantitative' }, x: { timeUnit: 'year', field: 't' } } }],
    ['grouped bars with an errorbar sharing the layer encoding', { data: DATA, encoding: { x: n('c'), xOffset: n('g') }, layer: [{ mark: 'bar', encoding: { y: q('v', { aggregate: 'mean' }), color: n('g') } }, { mark: 'errorbar', encoding: { y: q('v') } }] }],
    ['layered axis: one explicit title wins over an implicit one', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { title: 'Value' }) } }] }],
    ['layered axis: a null title removes it', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { title: null }) } }] }],
  ],
  // resolve.ts defaultScaleResolve: a facet's cells own their theta scale; model.ts assembleGroupStyle; facet path groups
  'faceted arcs and series (arc_facet, trellis_area)': [
    ['arcs, one pie per column', { data: DATA, mark: 'arc', encoding: { column: n('g'), theta: q('v', { aggregate: 'sum' }), color: n('c') } }],
    ['arcs, one pie per wrapped facet', { data: DATA, facet: n('g'), columns: 2, spec: { mark: 'arc', encoding: { theta: q('v', { aggregate: 'sum' }), color: n('c') } } }],
    ['stacked areas, one per row', { data: DATA, width: 120, height: 40, mark: 'area', encoding: { x: q('x'), y: q('y'), color: n('c', { legend: null }), row: n('g') } }],
    ['lines per series, one per column', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('c'), column: n('g') } }],
    ['layered lines and points per series, one per row', { data: DATA, facet: { row: n('g') }, spec: { width: 120, height: 60, layer: [{ mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }] } }],
  ],
  // axis/assemble.ts conditional axis values, axis/properties.ts tickMinStep, scale/properties.ts padding, offsets of points,
  // scale/parse.ts domainMin as a datetime, conditional.ts wrapCondition, timeunit UTC
  'axis, scale and channel details (bar_negative, point_grouped, line_domainminmax)': [
    ['a conditional grid colour', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum', axis: { gridColor: { condition: { test: 'datum.value === 0', value: 'black' }, value: '#ddd' } } }) } }],
    ['a conditional label colour and tick width on both axes', { data: DATA, config: { axis: { labelColor: { condition: { test: 'datum.value > 3', value: 'red' }, value: 'black' }, tickWidth: { condition: { test: 'datum.value === 0', value: 3 }, value: 1 } } }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['a continuous scale padding', { data: DATA, mark: 'bar', encoding: { x: q('x', { scale: { padding: 20 } }), y: n('c') } }],
    ['an integer axis format sets the tick min step', { data: DATA, mark: 'bar', encoding: { x: q('x', { axis: { format: 'd' } }), y: q('v') } }],
    ['points offset along a point scale', { data: DATA, mark: 'point', encoding: { x: n('c'), y: q('v'), xOffset: n('g'), color: n('g') } }],
    ['text and bars share an offset scale', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v'), xOffset: n('g') } }, { mark: 'text', encoding: { x: n('c'), y: q('v'), xOffset: n('g'), text: q('v') } }] }],
    ['a time domainMin / domainMax given as DateTimes', { data: DATA, mark: 'line', encoding: { x: t('t', { scale: { domainMin: { year: 2002 }, domainMax: { year: 2005 } } }), y: q('v') } }],
    ['a condition-only opacity falls back to the mark config', { data: DATA, config: { point: { opacity: 0.5 } }, mark: 'point', encoding: { x: q('x'), y: q('y'), opacity: { condition: [{ test: 'datum.x > 2', value: 0.25 }] } } }],
    ['a condition-only colour falls back to the mark colour', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { test: 'datum.x > 2', value: '#aaa' } } } }],
    ['a UTC time unit', { data: DATA, mark: { type: 'point', tooltip: true }, encoding: { x: { field: 't', timeUnit: 'utcyearmonthdate', type: 'temporal' }, y: q('v') } }],
  ],
  // unit.ts alignStackOrderWithColorDomain; legend/assemble.ts; formatparse.ts (no cast under count / distinct)
  'stack order, symbol legends, distinct (stacked_bar_weather, bar_diverging_stack_population_pyramid, bar_distinct)': [
    ['stacked bars ordered like the colour domain', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: n('g', { scale: { domain: ['q', 'p'], range: ['#111', '#999'] } }) } }],
    ['horizontal stacked bars ordered like the colour domain', { data: DATA, mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }), color: n('g', { scale: { domain: ['q', 'p'] } }) } }],
    ['grouped bars take the colour domain as the offset sort', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g', { scale: { domain: ['q', 'p'] } }) } }],
    ['a stack with an order channel is left alone', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), order: { aggregate: 'count', type: 'quantitative' }, color: n('g', { scale: { domain: ['q', 'p'] } }) } }],
    ['a symbol legend on top is not a gradient', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: n('g', { legend: { orient: 'top', title: null } }) } }],
    ['a gradient legend on top', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v', { legend: { orient: 'top' } }) } }],
    ['distinct count of a text field', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: { aggregate: 'distinct', field: 'g' } } }],
  ],
  // header/facet.ts (header: null, an empty title), legend/properties.ts symbolType, scale/range.ts (theta, shape), stack order
  'headers, shapes and arcs (trellis_bar_no_header, point_shape_custom, arc_pie_pyramid)': [
    ['a facet row without a header', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), row: n('g', { header: null }) } }],
    ['a facet row with an empty header title', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), row: n('g', { header: { title: '' } }) } }],
    ['a facet row header with a negative label angle', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), row: n('g', { header: { labelAngle: -90 } }) } }],
    ['a facet column header with title and label angles', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), column: n('g', { header: { labelAngle: 45, titleAngle: -90 } }) } }],
    ['a facet column and row, one without a header', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('g', { header: null }), column: n('c') } }],
    ['a constant custom shape names the legend symbols', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c'), size: q('v'), shape: { value: 'M0,0.2L0.2351,0.3236 0.1902,0.0618 0.3804,-0.1236 0,-0.4 -0.3804,-0.1236 -0.1902,0.0618 -0.2351,0.3236 0,0.2Z' } } }],
    ['a shape scale with its own range, through a selection condition', { data: DATA, params: [{ name: 'pts', select: { type: 'point', fields: ['c'], toggle: false } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'pts', field: 'g', type: 'nominal' }, value: 'grey' }, shape: { condition: { param: 'pts', field: 'c', type: 'nominal', scale: { range: ['triangle-left', 'triangle-right', 'triangle-up'] } }, value: 'circle' } } }],
    ['a pie ordered by the order channel with a custom angular range', { data: DATA, mark: { type: 'arc', outerRadius: 80 }, encoding: { theta: q('v', { scale: { range: [2.35, 8.63] }, stack: true }), color: n('c'), order: { field: 'x' } } }],
  ],
  // position-rect.ts rectBinPosition + data/timeunit.ts offsetedRectFormulas + channeldef.ts getBandPosition / getBandSize
  'bands of time units and bins (bar_month_band, bar_month_temporal_band_center, line_month_center_band, tick_histogram)': [
    ['a bar with a relative width over a time unit', { data: DATA, mark: { type: 'bar', width: { band: 0.7 } }, encoding: { x: { timeUnit: 'year', field: 't' }, y: q('v', { aggregate: 'sum' }) } }],
    ['a bar with a relative width through config.bar.timeUnitBandSize', { data: DATA, config: { bar: { timeUnitBandSize: 0.6 } }, mark: 'bar', encoding: { x: { timeUnit: 'year', field: 't' }, y: q('v', { aggregate: 'sum' }) } }],
    ['a bar at the start of its time unit (bandPosition 0)', { data: DATA, mark: 'bar', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal', bandPosition: 0 }, y: q('v', { aggregate: 'sum' }) } }],
    ['a bar a quarter into its time unit', { data: DATA, mark: 'bar', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal', bandPosition: 0.25 }, y: q('v', { aggregate: 'sum' }) } }],
    ['a bar with config.bar.timeUnitBandPosition', { data: DATA, config: { bar: { timeUnitBandPosition: 0 } }, mark: 'bar', encoding: { x: { timeUnit: 'year', field: 't' }, y: q('v', { aggregate: 'sum' }) } }],
    ['a bar with a time unit on y', { data: DATA, mark: 'bar', encoding: { y: { timeUnit: 'year', field: 't', type: 'temporal', bandPosition: 0 }, x: q('v', { aggregate: 'sum' }) } }],
    ['a rect heatmap over two time units', { data: DATA, mark: 'rect', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal', bandPosition: 0 }, y: { timeUnit: 'month', field: 't', type: 'temporal', bandPosition: 0 }, color: q('v', { aggregate: 'sum' }) } }],
    ['a bar with a visual offset on its band ends', { data: DATA, mark: { type: 'bar', xOffset: -2, x2Offset: 2 }, encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal' }, y: q('v', { aggregate: 'sum' }) } }],
    ['a line at the middle of its time unit', { data: DATA, mark: 'line', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal', bandPosition: 0.5 }, y: q('v', { aggregate: 'sum' }) } }],
    ['points at the end of their time unit', { data: DATA, mark: 'point', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal', bandPosition: 1 }, y: q('v', { aggregate: 'sum' }) } }],
    ['a line with no band position has no band end', { data: DATA, mark: 'line', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal' }, y: q('v', { aggregate: 'sum' }) } }],
    ['ticks over a time unit', { data: DATA, mark: 'tick', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal' }, y: q('v', { aggregate: 'sum' }) } }],
    ['ticks over a bin', { data: DATA, mark: 'tick', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } }],
    ['a reversed histogram', { data: DATA, mark: 'bar', encoding: { x: q('x', { bin: true, scale: { reverse: true } }), y: { aggregate: 'count' } } }],
    ['a histogram sorted descending, without bin spacing', { data: DATA, config: { bar: { binSpacing: 0 } }, mark: 'bar', encoding: { x: q('x', { bin: true, sort: 'descending' }), y: { aggregate: 'count' } } }],
    ['a histogram with an axis translate', { data: DATA, mark: 'bar', encoding: { x: q('x', { bin: true, axis: { translate: 0 } }), y: { aggregate: 'count' } } }],
    ['a time unit on the colour with a band end', { data: DATA, config: { bar: { timeUnitBandPosition: 0 } }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: { timeUnit: 'year', field: 't', type: 'temporal' } } }],
    ['a rect between two time-unit values', { data: { values: [{ a: 'May 1, 2010', b: 'July 15, 2010' }] }, mark: 'rect', encoding: { x: { timeUnit: 'month', field: 'a', type: 'temporal' }, x2: { timeUnit: 'month', field: 'b' } } }],
  ],
  // position-rect.ts positionAndSize + scale/range.ts getOffsetRange (relative band sizes, offsets without / over time units)
  'band sizes and offsets of bars and ticks (tick_width_band, bar_x_offset_without_x, bar_group_timeunit)': [
    ['ticks with a relative width', { data: DATA, width: { step: 50 }, mark: { type: 'tick', width: { band: 0.5 } }, encoding: { x: n('c'), y: q('v') } }],
    ['grouped ticks', { data: DATA, mark: 'tick', encoding: { x: n('c'), y: q('v'), xOffset: n('g'), color: n('g') } }],
    ['bars with a relative height and a visual offset', { data: DATA, height: { step: 50 }, mark: { type: 'bar', yOffset: 5, height: { band: 0.5 } }, encoding: { y: n('c', { scale: { padding: 0 } }), x: { aggregate: 'count' } } }],
    ['a relative height with a y axis bandPosition on the grid', { data: DATA, mark: { type: 'bar', height: { band: 0.5 } }, encoding: { y: n('c', { axis: { grid: true, bandPosition: 0 } }), x: { aggregate: 'count' } } }],
    ['bars offset without an x', { data: DATA, mark: 'bar', encoding: { y: q('v'), xOffset: n('g'), color: n('g') } }],
    ['bars offset over a time unit', { data: DATA, width: 400, mark: 'bar', encoding: { x: { timeUnit: 'year', field: 't', type: 'temporal' }, xOffset: n('g'), color: n('g'), y: { aggregate: 'count' } } }],
    ['bars offset over a week time unit', { data: DATA, mark: 'bar', encoding: { x: { timeUnit: 'yearweek', field: 't', type: 'temporal' }, xOffset: n('g'), color: n('g'), y: { aggregate: 'count' } } }],
    ['horizontal bars offset over a time unit', { data: DATA, mark: 'bar', encoding: { y: { timeUnit: 'year', field: 't', type: 'temporal' }, yOffset: n('g'), color: n('g'), x: { aggregate: 'count' } } }],
    ['bars offset with a right alignment', { data: DATA, mark: { type: 'bar', align: 'right' }, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g') } }],
  ],
  // resolve.ts parseGuideResolve / defaultScaleResolve; header model names (varName); layoutsize/parse.ts (columns: 1)
  'resolve and repeat (brush_table, repeat_independent_colors, repeat_splom)': [
    ['independent colour scales in a concat', { data: DATA, resolve: { scale: { color: 'independent' } }, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('g') } }] }],
    ['independent colour legends over one scale in a concat', { data: DATA, resolve: { legend: { color: 'independent' } }, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }] }],
    ['a shared x scale in a vconcat', { data: DATA, resolve: { scale: { x: 'shared' } }, vconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['independent size legends in a layer', { data: DATA, resolve: { legend: { size: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v', { title: 'One' }) } }, { mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v', { title: 'Two' }), color: { value: 'red' } } }] }],
    ['independent legends in a layer inside a concat', { data: DATA, vconcat: [{ resolve: { legend: { size: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v', { title: 'One' }) } }, { mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v', { title: 'Two' }) } }] }, { mark: 'point', encoding: { x: q('x'), y: q('y') } }] }],
    ['a repeat over fields with spaces', { data: { values: [{ 'a b': 1, 'c (d)': 2, k: 'x' }, { 'a b': 3, 'c (d)': 1, k: 'y' }] }, repeat: { row: ['a b', 'c (d)'], column: ['c (d)', 'a b'] }, spec: { width: 60, height: 60, mark: 'point', encoding: { x: { field: { repeat: 'column' }, type: 'quantitative' }, y: { field: { repeat: 'row' }, type: 'quantitative' }, color: n('k') } } }],
    ['a repeat in one column keeps the width of its children', { data: DATA, repeat: ['y', 'v'], columns: 1, autosize: { type: 'fit-x', contains: 'padding' }, spec: { mark: 'bar', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative', bin: true }, y: { aggregate: 'count' } } } }],
    ['a concat in one column keeps the width of its children', { data: DATA, columns: 1, concat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
  ],
  // mark/text.ts + valueref.ts positionRef (text on a stack, bandPosition), config.style over text defaults, position2Ref band
  'text, stacks and ranged rules (layer_arc_label, stacked_bar_h_normalized_labeled, layer_bar_labels_style, waterfall_chart)': [
    ['a pie with labels in the wedges', { data: DATA, encoding: { theta: q('v', { stack: true }), color: n('c', { legend: null }) }, layer: [{ mark: { type: 'arc', outerRadius: 80 } }, { mark: { type: 'text', radius: 90 }, encoding: { text: n('c') } }] }],
    ['text on a normalized stacked bar with a band position', { data: DATA, encoding: { y: n('c'), x: q('v', { aggregate: 'sum', stack: 'normalize' }), color: n('g') }, layer: [{ mark: 'bar' }, { mark: 'text', encoding: { x: q('v', { aggregate: 'sum', stack: 'normalize', bandPosition: 0.5 }), text: q('v', { aggregate: 'sum' }) } }] }],
    ['text at the start of its stack segment', { data: DATA, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: n('g') }, layer: [{ mark: 'bar' }, { mark: 'text', encoding: { y: q('v', { aggregate: 'sum', bandPosition: 0 }), text: q('v', { aggregate: 'sum' }) } }] }],
    ['a text style overriding the default alignment', { data: DATA, config: { style: { label: { align: 'left', baseline: 'middle', dx: 3 } } }, layer: [{ mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }) } }, { mark: { type: 'text', style: 'label' }, encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }), text: q('v', { aggregate: 'sum' }) } }] }],
    ['config.text alignment replaces the default', { data: DATA, config: { text: { align: 'right', dx: -5, dy: 5 } }, mark: 'text', encoding: { x: q('x'), y: q('y'), text: q('v') } }],
    ['a rule between two ordinal positions', { data: DATA, layer: [{ mark: 'bar', encoding: { x: { field: 'c', type: 'ordinal', sort: null }, y: q('v') } }, { mark: { type: 'rule', xOffset: -5, x2Offset: 5 }, encoding: { x: { field: 'c', type: 'ordinal', sort: null }, x2: { field: 'g' }, y: q('v') } }] }],
  ],
  // stack.ts impute with bins (bin_mid), mark.ts getStackGroup (stroke, band end), legend/encode.ts symbols
  'stacked bins, rounded stacks, symbol legends (stacked_area_binned, stacked_bar_count_corner_radius_stroke, circle_natural_disasters)': [
    ['a stacked area over bins', { data: DATA, mark: 'area', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' }, color: n('g') } }],
    ['a stacked area over bins with an explicit maxbins', { data: DATA, mark: 'area', encoding: { x: q('x', { bin: { maxbins: 3 } }), y: { aggregate: 'sum', field: 'v', type: 'quantitative' }, color: n('c') } }],
    ['rounded stacked bars with a stroke over a time unit', { data: DATA, config: { bar: { strokeWidth: 2 } }, mark: { type: 'bar', cornerRadius: 10, stroke: 'black' }, encoding: { x: { timeUnit: 'year', field: 't', type: 'ordinal' }, y: { aggregate: 'count' }, color: n('g') } }],
    ['rounded stacked bars over a bin', { data: DATA, mark: { type: 'bar', cornerRadius: 6 }, encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' }, color: n('g') } }],
    ['a layered axis takes the time unit format and step of another layer', { data: DATA, layer: [{ mark: 'errorband', encoding: { y: q('v', { scale: { zero: false } }), y2: { field: 'y' }, x: { field: 't', timeUnit: 'year' } } }, { mark: 'line', encoding: { y: q('v'), x: { field: 't', timeUnit: 'year' } } }] }],
    ['a size legend with the colour legend turned off', { data: DATA, mark: { type: 'circle', opacity: 0.8, stroke: 'black', strokeWidth: 1 }, encoding: { x: q('x'), y: n('c'), size: q('v', { title: 'Size', legend: { clipHeight: 30 } }), color: n('c', { legend: null }) } }],
  ],
  // channeldef.ts binRequiresRange + domain.ts: a binned ordinal / nominal field is a band over its bins' texts
  'binned discrete fields (histogram_ordinal)': [
    ['a histogram over an ordinal bin', { data: DATA, mark: 'bar', encoding: { x: { bin: true, field: 'x', type: 'ordinal' }, y: { aggregate: 'count' } } }],
    ['an ordinal bin sorted by count, descending', { data: DATA, mark: 'bar', encoding: { x: { bin: true, field: 'x', type: 'ordinal', sort: '-y' }, y: { aggregate: 'count' } } }],
    ['an ordinal bin sorted descending', { data: DATA, mark: 'bar', encoding: { x: { bin: { maxbins: 3 }, field: 'x', type: 'ordinal', sort: 'descending' }, y: { aggregate: 'count' } } }],
    ['a horizontal histogram over a nominal bin', { data: DATA, mark: 'bar', encoding: { y: { bin: true, field: 'v', type: 'nominal' }, x: { aggregate: 'count' } } }],
    ['an ordinal bin with a colour', { data: DATA, mark: 'bar', encoding: { x: { bin: true, field: 'x', type: 'ordinal' }, y: { aggregate: 'count' }, color: n('g') } }],
    ['an ordinal bin with a number format', { data: DATA, mark: 'bar', encoding: { x: { bin: true, field: 'x', type: 'ordinal', axis: { format: '.1f' } }, y: { aggregate: 'count' } } }],
  ],
  // conditional.ts + channeldef.ts getFieldDef: a condition that is itself a field def (here a count) drives the channel's scale and legend
  'a conditional field def with an aggregate (selection_project_interval, selection_type_point, selection_composition_and)': [
    ['an interval param over a conditional count', { data: DATA, params: [{ name: 'pts', select: 'interval' }], mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { param: 'pts', aggregate: 'count' }, value: 'grey' } } }],
    ['a point param over a conditional count', { data: DATA, params: [{ name: 'pts', select: 'point' }], mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { param: 'pts', aggregate: 'count' }, value: 'grey' } } }],
    ['a point param on pointerover over a conditional count', { data: DATA, params: [{ name: 'pts', select: { type: 'point', on: 'pointerover' } }], mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { param: 'pts', aggregate: 'count' }, value: 'grey' } } }],
    ['a conjunction of intervals over a conditional count', { data: DATA, params: [{ name: 'a', select: { type: 'interval', on: '[pointerdown[!event.shiftKey], pointerup] > pointermove' } }, { name: 'b', select: { type: 'interval', on: '[pointerdown[event.shiftKey], pointerup] > pointermove' } }], mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { test: { and: [{ param: 'a' }, { param: 'b' }] }, aggregate: 'count' }, value: 'grey' } } }],
    ['a disjunction of intervals over a conditional count', { data: DATA, params: [{ name: 'a', select: 'interval' }, { name: 'b', select: { type: 'interval', on: '[pointerdown[event.shiftKey], pointerup] > pointermove' } }], mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { test: { or: [{ param: 'a' }, { param: 'b' }] }, aggregate: 'count' }, value: 'grey' } } }],
    ['an interval param over a conditional sum', { data: DATA, params: [{ name: 'pts', select: 'interval' }], mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { param: 'pts', aggregate: 'sum', field: 'v', type: 'quantitative' }, value: 'grey' } } }],
    ['an interval param over a conditional mean on a plain channel', { data: DATA, params: [{ name: 'pts', select: 'interval' }], mark: 'rect', encoding: { y: n('g'), x: n('c'), fill: { condition: { param: 'pts', aggregate: 'mean', field: 'v', type: 'quantitative' }, value: 'grey' } } }],
    ['a point param over a conditional bin', { data: DATA, params: [{ name: 'pts', select: 'point' }], mark: 'point', encoding: { y: q('y'), x: q('x'), color: { condition: { param: 'pts', bin: true, field: 'v', type: 'quantitative' }, value: 'grey' } } }],
    ['a test condition over a conditional count with an explicit type', { data: DATA, mark: 'rect', encoding: { y: n('g'), x: n('c'), color: { condition: { test: 'datum.v > 4', aggregate: 'count', type: 'quantitative' }, value: 'grey' } } }],
  ],
  // compositemark/boxplot.ts normalizeBoxPlot (+ common.ts): a boxplot is a layer of simple marks over aggregates, in either
  // orientation, over any shared channel, with the part switches of the mark def and of config.boxplot
  'boxplot, every orientation and part (boxplot_2D_horizontal, boxplot_1D_horizontal, boxplot_groupped, boxplot_tooltip_aggregate, layer_boxplot_circle)': [
    ['a vertical boxplot', { data: BOX, mark: 'boxplot', encoding: { x: n('c'), y: q('v', { scale: { zero: false } }) } }],
    ['a horizontal boxplot', { data: BOX, mark: 'boxplot', encoding: { y: n('c'), x: q('v', { scale: { zero: false } }) } }],
    ['a vertical boxplot with a colour field and no legend', { data: BOX, mark: 'boxplot', encoding: { x: n('c'), color: n('c', { legend: null }), y: q('v') } }],
    ['a horizontal boxplot with a constant size and colour', { data: BOX, mark: 'boxplot', encoding: { y: n('c'), x: q('v'), size: { value: 10 }, color: { value: 'teal' } } }],
    ['a one-dimensional horizontal boxplot', { data: BOX, mark: 'boxplot', encoding: { x: q('v', { scale: { zero: false } }) } }],
    ['a one-dimensional vertical boxplot', { data: BOX, mark: 'boxplot', encoding: { y: q('v', { scale: { zero: false } }) } }],
    ['a one-dimensional boxplot with a custom median and ticks', { data: BOX, mark: { type: 'boxplot', extent: 1.5, median: { color: 'red' }, ticks: true }, encoding: { x: q('v') } }],
    ['a min-max horizontal boxplot', { data: BOX, mark: { type: 'boxplot', extent: 'min-max' }, encoding: { y: n('c'), x: q('v', { scale: { zero: false } }) } }],
    ['a min-max vertical boxplot with a colour', { data: BOX, mark: { type: 'boxplot', extent: 'min-max' }, encoding: { x: n('c'), color: n('c', { legend: null }), y: q('v') } }],
    ['a min-max boxplot with a median colour from config.boxplot', { data: BOX, config: { boxplot: { median: { color: 'orange' } } }, mark: { type: 'boxplot', extent: 'min-max' }, encoding: { y: n('c'), x: q('v') } }],
    ['a boxplot with an extent of 3 iqr', { data: BOX, mark: { type: 'boxplot', extent: 3 }, encoding: { x: n('c'), y: q('v') } }],
    ['a boxplot with an aggregate tooltip', { data: BOX, mark: 'boxplot', encoding: { y: n('c'), x: q('v'), tooltip: { field: 'v', aggregate: 'mean' } } }],
    ['a boxplot with a raw tooltip', { data: BOX, mark: 'boxplot', encoding: { y: n('c'), x: q('v'), tooltip: { field: 'v', type: 'quantitative' } } }],
    ['a grouped boxplot through an offset', { data: BOX, mark: 'boxplot', encoding: { x: n('c'), color: n('g'), xOffset: n('g'), y: q('v') } }],
    ['a boxplot with an axis and a title on the dimension', { data: BOX, mark: 'boxplot', encoding: { x: n('c', { axis: { labelAngle: 0 }, title: 'Group' }), y: q('v', { axis: { title: 'Value' } }) } }],
    ['a boxplot that drops the invalid values', { data: BOX, mark: { type: 'boxplot', invalid: 'filter' }, encoding: { x: q('x', { axis: { labelAngle: 0 } }), y: q('v') } }],
    ['a boxplot without outliers', { data: BOX, mark: { type: 'boxplot', outliers: false }, encoding: { y: n('c'), x: q('v') } }],
    ['a boxplot without a box colour but with an opacity and a size', { data: BOX, mark: { type: 'boxplot', opacity: 0.5, size: 20, color: 'purple' }, encoding: { x: n('c'), y: q('v') } }],
    ['a boxplot after a filter', { data: BOX, transform: [{ filter: 'datum.x > 1' }], mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }],
    ['a boxplot over an ordinal dimension with an explicit orient', { data: BOX, mark: { type: 'boxplot', orient: 'vertical' }, encoding: { x: { field: 'x', type: 'ordinal' }, y: q('v') } }],
    ['a boxplot over a time unit', { data: BOX, mark: 'boxplot', encoding: { x: { field: 't', timeUnit: 'year', type: 'ordinal' }, y: q('v') } }],
    ['a boxplot with data exactly on the whisker fences (the inlier test is inclusive)', { data: { values: Array.from({ length: 11 }, (_, i) => ({ c: 'A', v: i })) }, mark: { type: 'boxplot', extent: 0.5 }, encoding: { x: n('c'), y: q('v') } }],
    ['a boxplot in a layer with circles', { data: BOX, width: 300, layer: [{ mark: { type: 'boxplot', outliers: false }, encoding: { y: { field: 'c', type: 'ordinal' }, x: q('v', { title: 'population' }) } }, { mark: 'circle', encoding: { y: { field: 'c', type: 'ordinal' }, x: q('v', { title: 'population' }), color: { value: 'black' }, opacity: { value: 0.2 } } }] }],
    ['a boxplot in a concat', { data: BOX, hconcat: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }, { mark: 'boxplot', encoding: { x: n('g'), y: q('v') } }] }],
    ['a boxplot under a shared layer encoding', { data: BOX, encoding: { x: n('c') }, layer: [{ mark: 'boxplot', encoding: { y: q('v') } }, { mark: 'tick', encoding: { y: q('v', { aggregate: 'mean' }) } }] }],
  ],
  // channeldef.ts getBandSize + position-rect.ts positionAndSize: the size of a bar / tick (mark def or encoding value) is its band size
  // on any scale, in the middle of an offset sub-band, and on a view that lacks the band channel
  'explicit sizes of bars and ticks (boxplot_1D_invalid, boxplot_2D_horizontal_color_size, errorbar_aggregate)': [
    ['a bar with a size over a quantitative x', { data: DATA, mark: { type: 'bar', size: 14 }, encoding: { x: q('x'), y: q('v') } }],
    ['a horizontal bar with a size over a quantitative y', { data: DATA, mark: { type: 'bar', size: 9, orient: 'horizontal' }, encoding: { y: q('x'), x: q('v') } }],
    ['a bar with a size over a temporal x', { data: DATA, mark: { type: 'bar', size: 12 }, encoding: { x: t('t'), y: q('v') } }],
    ['a bar with a size value in the encoding', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), size: { value: 10 } } }],
    ['a tick with a size value in the encoding', { data: DATA, mark: 'tick', encoding: { x: n('c'), y: q('v'), size: { value: 10 } } }],
    ['a bar with an encoding size that overrides the mark size', { data: DATA, mark: { type: 'bar', size: 30 }, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), size: { value: 8 } } }],
    ['bars with a size inside an offset sub-band', { data: DATA, mark: { type: 'bar', size: 7 }, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), xOffset: n('g'), color: n('g') } }],
    ['horizontal bars with a size inside an offset sub-band', { data: DATA, mark: { type: 'bar', size: 7 }, encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }), yOffset: n('g'), color: n('g') } }],
    ['ticks with a size inside an offset sub-band', { data: DATA, mark: { type: 'tick', size: 9 }, encoding: { x: n('c'), y: q('v'), xOffset: n('g'), color: n('g') } }],
    ['a one-dimensional horizontal bar with a size', { data: DATA, mark: { type: 'bar', size: 11 }, encoding: { x: q('v', { aggregate: 'sum' }) } }],
    ['a one-dimensional vertical bar with a size', { data: DATA, mark: { type: 'bar', size: 11 }, encoding: { y: q('v', { aggregate: 'sum' }) } }],
    ['a one-dimensional vertical tick with a size', { data: DATA, mark: { type: 'tick', size: 11, orient: 'vertical' }, encoding: { x: q('v') } }],
    ['a one-dimensional horizontal tick with a size', { data: DATA, mark: { type: 'tick', size: 11, orient: 'horizontal' }, encoding: { y: q('v') } }],
    ['a one-dimensional horizontal tick with a size on the other axis', { data: DATA, mark: { type: 'tick', size: 11, orient: 'horizontal' }, encoding: { x: q('v') } }],
    ['a one-dimensional vertical tick with a size on the other axis', { data: DATA, mark: { type: 'tick', size: 11, orient: 'vertical' }, encoding: { y: q('v') } }],
  ],
  // model.ts assembleGroupEncodeEntry / assembleEncodeFromView, unit.ts assembleGroupStyle: the `view` background is the view group's own encode
  'the view background (point_background, layer_likert, trail_comet, concat_population_pyramid, trellis_area_seattle)': [
    ['a filled unit view', { data: DATA, view: { fill: 'yellow' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['a unit view without a stroke', { data: DATA, view: { stroke: null }, mark: 'trail', encoding: { x: q('x'), y: q('y'), size: q('v') } }],
    ['a unit view with a transparent stroke', { data: DATA, view: { stroke: 'transparent' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['a unit view with every group property', { data: DATA, view: { fill: '#eee', fillOpacity: 0.5, stroke: 'red', strokeWidth: 3, strokeOpacity: 0.8, strokeDash: [4, 2], strokeDashOffset: 1, strokeCap: 'round', strokeJoin: 'bevel', cornerRadius: 8, opacity: 0.9 }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['a layer view without a stroke', { data: DATA, view: { stroke: null }, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }, { mark: 'rule', encoding: { y: q('v', { aggregate: 'mean' }) } }] }],
    ['a layer view of a map-less unframed view', { data: DATA, view: { fill: 'lightgray', stroke: null }, encoding: { theta: q('v', { stack: true }), color: n('c') }, layer: [{ mark: { type: 'arc', outerRadius: 80 } }, { mark: { type: 'text', radius: 90 }, encoding: { text: n('c') } }] }],
    ['a view style', { data: DATA, view: { style: 'view' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['a view style list over the fill', { data: DATA, view: { style: ['cell', 'view'], fill: 'pink' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
    ['a view style in a layer', { data: DATA, layer: [{ view: { style: 'view' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] }],
    ['a view on one child of an hconcat', { data: DATA, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { view: { stroke: null }, mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['a view on a layer child of a vconcat', { data: DATA, vconcat: [{ view: { fill: 'lavender' }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['a view on the spec of a facet', { data: DATA, facet: { row: n('g') }, spec: { view: { stroke: null }, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a view on the spec of a column facet', { data: DATA, facet: { column: n('g') }, spec: { view: { fill: 'honeydew' }, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a view on the spec of a wrapped facet', { data: DATA, facet: n('c'), columns: 2, spec: { view: { stroke: null }, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a view on a layered spec of a facet', { data: DATA, facet: { row: n('g') }, spec: { view: { fill: 'azure' }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] } }],
    ['a view on the spec of a repeat', { data: DATA, repeat: ['y', 'v'], spec: { view: { fill: 'ivory' }, mark: 'point', encoding: { x: q('x'), y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }],
    ['a view with config.view', { data: DATA, config: { view: { stroke: 'blue' } }, view: { fill: 'cornsilk' }, mark: 'point', encoding: { x: q('x'), y: q('y') } }],
  ],
  // channeldef.ts defaultType: a facet field def without a type is nominal (facet_row_facet_row_point_future, facet_independent_scale)
  'facet field defs without a type (facet_column_facet_row_point_future, facet_cross_independent_scale, trellis_cross_sort)': [
    ['a row facet without a type', { data: DATA, facet: { row: { field: 'g' } }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a column facet without a type', { data: DATA, facet: { column: { field: 'g' } }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a row and a column facet without types', { data: DATA, facet: { row: { field: 'g' }, column: { field: 'c' } }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a wrapped facet without a type', { data: DATA, facet: { field: 'c' }, columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a facet in the encoding without a type', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), row: { field: 'g' } } }],
    ['a facet in the encoding with a sort and no type', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), column: { field: 'c', sort: 'descending' } } }],
    ['a row facet with a header and no type', { data: DATA, facet: { row: { field: 'g', header: { labelAngle: 0 } } }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
  ],
  // compile/facet.ts assembleFacet / facetSortFields, data/facet.ts, joinaggregatefacet.ts, calculate.ts sortArrayIndexField:
  // facet sorts by an aggregate or by a list, and the cross of a row and a column facet (trellis_cross_sort, facet_sort_*)
  'facet sorts and crossed facets (trellis_cross_sort, trellis_cross_sort_array, facet_cross_sparse)': [
    ['a row facet sorted by a median', { data: DATA, facet: { row: n('c', { sort: { op: 'median', field: 'v', order: 'descending' } }) }, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a column facet sorted by the default operation', { data: DATA, facet: { column: n('c', { sort: { field: 'v' } }) }, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a column facet sorted by a list', { data: DATA, facet: { column: n('c', { sort: ['C', 'A', 'B'] }) }, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a row facet sorted by a partial list', { data: DATA, facet: { row: n('c', { sort: ['B'] }) }, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a wrapped facet sorted by a mean', { data: DATA, facet: n('c', { sort: { op: 'mean', field: 'v', order: 'descending' } }), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a wrapped facet sorted by a list', { data: DATA, facet: n('c', { sort: ['C', 'B', 'A'] }), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a crossed facet sorted by medians', { data: DATA, facet: { row: n('g', { sort: { op: 'median', field: 'x' } }), column: n('c', { sort: { op: 'median', field: 'v' } }) }, spec: { width: 50, height: 50, mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a crossed facet sorted by lists', { data: DATA, facet: { row: n('g', { sort: ['q', 'p'] }), column: n('c', { sort: ['C', 'A', 'B'] }) }, spec: { width: 50, height: 50, mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a crossed facet with one sorted channel', { data: DATA, facet: { row: n('g'), column: n('c', { sort: { op: 'max', field: 'v', order: 'descending' } }) }, spec: { width: 50, height: 50, mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a crossed facet whose combinations are not all present', { data: SPARSE, facet: { row: n('g'), column: n('c') }, spec: { width: 50, height: 50, mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['a facet transform that spans the cells, under a layered spec (it runs once, before the facet)', { data: DATA, transform: [{ joinaggregate: [{ op: 'mean', field: 'v', as: 'm' }], groupby: ['g'] }], facet: { row: n('c') }, spec: { width: 80, height: 60, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('v') } }, { mark: 'rule', encoding: { y: q('m', { aggregate: 'mean' }) } }] } }],
    ['a facet window transform that spans the cells, under a layered spec', { data: DATA, transform: [{ window: [{ op: 'rank', as: 'r' }], sort: [{ field: 'v' }] }], facet: { column: n('c') }, spec: { width: 80, height: 60, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('r') } }, { mark: 'rule', encoding: { y: q('r', { aggregate: 'max' }) } }] } }],
    ['a faceted unit with a shared resolve (its resolve is the facet\'s)', { data: DATA, mark: 'point', resolve: { scale: { y: 'shared' }, axis: { x: 'shared' } }, encoding: { x: q('x'), y: q('v'), column: n('c') } }],
    ['a facet in the encoding sorted by an aggregate', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('v'), row: n('c', { sort: { op: 'sum', field: 'v' } }) } }],
  ],
  // normalize/core.ts mergeEncoding: a layer's shared channel defs merge into the layers' (a def with no field is a partial one)
  'shared layer encodings that merge into the layers (bar_layered_weather, layer_candlestick, layer_likert, stacked_bar_v_ascending)': [
    ['a shared quantitative y with a scale and an axis, the fields in the layers', { data: DATA, encoding: { x: n('c'), y: { type: 'quantitative', scale: { domain: [0, 12] }, axis: { title: 'Value' } } }, layer: [{ mark: 'bar', encoding: { y: { field: 'v' }, y2: { field: 'y' } } }, { mark: 'point', encoding: { y: { field: 'v' } } }] }],
    ['a shared x with a scale and no zero, the field in the layers', { data: DATA, encoding: { y: n('c'), x: { type: 'quantitative', scale: { zero: false }, title: 'X' } }, layer: [{ mark: 'point', encoding: { x: { field: 'x' } } }, { mark: 'point', encoding: { x: { field: 'v' } } }] }],
    ['a partial shared channel that no layer completes', { data: DATA, encoding: { x: q('x'), y: { type: 'quantitative', axis: { title: 'Nothing' } } }, layer: [{ mark: 'rule', encoding: { y: { field: 'v' } } }, { mark: 'point' }] }],
    ['a shared field def a layer overrides in part', { data: DATA, encoding: { x: q('x', { axis: { grid: false } }), y: q('y') }, layer: [{ mark: 'point' }, { mark: 'line', encoding: { y: { field: 'v' } } }] }],
    ['a shared colour a layer replaces by a value', { data: DATA, encoding: { x: q('x'), y: q('y'), color: n('c') }, layer: [{ mark: 'point' }, { mark: 'line', encoding: { color: { value: 'black' } } }] }],
    ['a shared colour a layer drops with null', { data: DATA, encoding: { x: q('x'), y: q('y'), color: n('c') }, layer: [{ mark: 'point' }, { mark: 'line', encoding: { color: null } }] }],
    ['a nested layer whose parents both share a channel', { data: DATA, encoding: { x: q('x') }, layer: [{ encoding: { y: { type: 'quantitative', scale: { zero: false } } }, layer: [{ mark: 'point', encoding: { y: { field: 'v' } } }, { mark: 'line', encoding: { y: { field: 'y' } } }] }] }],
    ['a stacked bar with an order that only gives the direction (ascending)', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: n('g'), order: { sort: 'ascending' } } }],
    ['a stacked bar with an order that only gives the direction (descending)', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: n('g'), order: { sort: 'descending' } } }],
    ['a horizontal stacked bar with an order that only gives the direction', { data: DATA, mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }), color: n('g'), order: { sort: 'descending' } } }],
    ['a shared partial order with a sort', { data: DATA, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), order: { sort: 'ascending' } }, layer: [{ mark: 'bar', encoding: { color: n('g'), order: { field: 'g' } } }] }],
    ['a shared partial channel under a concat', { data: DATA, vconcat: [{ encoding: { x: { type: 'quantitative', scale: { domain: [0, 8] }, axis: { title: 'T' } } }, layer: [{ mark: 'point', encoding: { x: { field: 'x' }, y: q('y') } }, { mark: 'rule', encoding: { x: { field: 'v' } } }] }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['a shared partial channel under a facet', { data: DATA, facet: { column: n('g') }, spec: { encoding: { y: { type: 'quantitative', scale: { zero: false } } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: { field: 'v' } } }, { mark: 'line', encoding: { x: q('x'), y: { field: 'y' } } }] } }],
  ],
  // position-point.ts pointPositionDefaultRef / valueref.ts widthHeightValueOrSignalRef: the mark def's x / y position a point-placed mark
  'positions in the mark def (layer_likert, layer_bar_annotations, layer_bar_labels_grey, interactive_global_development)': [
    ['a text at a mark-def x and y', { data: DATA, mark: { type: 'text', x: 40, y: 30, text: 'hello' } }],
    ['a text at the right edge', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }, { mark: { type: 'text', align: 'right', baseline: 'bottom', dx: -2, dy: -2, x: 'width', text: 'edge' } }] }],
    ['a text at the bottom edge', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: { type: 'text', y: 'height', baseline: 'bottom', x: 20, text: 'floor' } }] }],
    ['texts at a mark-def x beside a y field', { data: DATA, layer: [{ mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }) } }, { mark: { type: 'text', align: 'left', x: 5 }, encoding: { y: n('c'), text: n('c') } }] }],
    ['texts at a mark-def y beside an x field', { data: DATA, layer: [{ mark: 'point', encoding: { x: n('c'), y: q('v') } }, { mark: { type: 'text', y: -5, align: 'center', baseline: 'bottom' }, encoding: { x: n('c'), text: n('c') } }] }],
    ['a point at a mark-def y', { data: DATA, mark: { type: 'point', y: 100 }, encoding: { x: q('x') } }],
    ['a circle at the mark-def x', { data: DATA, mark: { type: 'circle', x: 'width' }, encoding: { y: q('y') } }],
    ['the encoding wins over the mark def', { data: DATA, mark: { type: 'point', x: 5 }, encoding: { x: q('x'), y: q('y') } }],
    ['a large text at a mark-def position', { data: DATA, mark: { type: 'text', fontSize: 80, x: 150, y: 100, opacity: 0.06 }, encoding: { text: n('c') } }],
  ],
  // data/impute.ts makeFromEncoding + assemble: a channel-level impute is the impute transform over the other position channel
  'channel-level impute (line_encoding_impute_keyvals, line_encoding_impute_keyvals_sequence, line_impute_frame)': [
    ['an imputed value with key values', { data: GAPS, mark: 'line', encoding: { x: q('a', { scale: { nice: 1 } }), y: q('b', { impute: { value: 100, keyvals: [4] } }), color: n('c') } }],
    ['an imputed value with a key value sequence', { data: GAPS, mark: 'line', encoding: { x: q('a', { scale: { nice: 1 } }), y: q('b', { impute: { value: 100, keyvals: { start: 4, stop: 6 } } }), color: n('c') } }],
    ['an imputed value with a stepped sequence', { data: GAPS, mark: 'line', encoding: { x: q('a'), y: q('b', { impute: { value: 0, keyvals: { start: 0, stop: 8, step: 2 } } }), color: n('c') } }],
    ['an imputed mean over a frame', { data: GAPS, mark: 'line', encoding: { x: q('a', { scale: { nice: 1 } }), y: q('b', { impute: { method: 'mean', frame: [-2, 2] } }), color: n('c') } }],
    ['an imputed maximum', { data: GAPS, mark: 'line', encoding: { x: q('a'), y: q('b', { impute: { method: 'max', keyvals: [5] } }), color: n('c') } }],
    ['an imputed x over a y key', { data: GAPS, mark: 'line', encoding: { y: q('a'), x: q('b', { impute: { value: 50, keyvals: [4] } }), color: n('c') }, }],
    ['an imputed value without a series', { data: GAPS, mark: 'line', encoding: { x: q('a'), y: q('b', { impute: { value: 7, keyvals: [-1] } }) } }],
    ['an imputed area stacked by colour', { data: GAPS, mark: 'area', encoding: { x: q('a'), y: q('b', { impute: { value: 0, keyvals: [4] } }), color: n('c') } }],
    ['an imputed aggregate', { data: GAPS, mark: 'line', encoding: { x: q('a'), y: q('b', { aggregate: 'sum', impute: { value: 0, keyvals: [4] } }), color: n('c') } }],
    ['an imputed value with a detail channel', { data: GAPS, mark: 'line', encoding: { x: q('a'), y: q('b', { impute: { value: 3, keyvals: [4] } }), detail: n('c') } }],
    ['an imputed point mark', { data: GAPS, mark: 'point', encoding: { x: q('a'), y: q('b', { impute: { value: 3, keyvals: [4] } }), color: n('c') } }],
  ],
  // compile/data/sequence.ts: a sequence generator is the source (sequence_line, sequence_line_fold)
  'sequence data (sequence_line, sequence_line_fold)': [
    ['a function of a generated sequence', { data: { sequence: { start: 0, stop: 12.7, step: 0.1, as: 'x' } }, transform: [{ calculate: 'sin(datum.x)', as: 'sin(x)' }], width: 300, height: 150, mark: 'line', encoding: { x: q('x'), y: q('sin(x)') } }],
    ['two functions folded', { data: { sequence: { start: 0, stop: 7, step: 0.5, as: 'x' } }, transform: [{ calculate: 'sin(datum.x)', as: 'sin(x)' }, { calculate: 'cos(datum.x)', as: 'cos(x)' }, { fold: ['sin(x)', 'cos(x)'] }], mark: 'line', encoding: { x: q('x'), y: q('value'), color: n('key', { title: null }) } }],
    ['a sequence with the default output name and step', { data: { sequence: { start: 1, stop: 6 } }, mark: 'bar', encoding: { x: q('data', { bin: true }), y: { aggregate: 'count' } } }],
    ['a sequence aggregated', { data: { sequence: { start: 0, stop: 10, step: 1, as: 'n' } }, mark: 'point', encoding: { x: q('n'), y: q('n', { aggregate: 'sum' }) } }],
    ['a named sequence in a layer', { layer: [{ data: { sequence: { start: 0, stop: 5, step: 1, as: 'u' } }, mark: 'point', encoding: { x: q('u'), y: q('u') } }, { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y') } }] }],
  ],
  // transform.ts AggregateTransform / facet.ts normalizeFacetedUnit: an aggregate with no measures only groups; a faceted unit's layout properties are the facet's
  'grouping aggregates and the layout of faceted units (vconcat_flatten, facet_grid_bar)': [
    ['an aggregate with no measures (the distinct groups)', { data: DATA, transform: [{ aggregate: [], groupby: ['c', 'g'] }], mark: 'point', encoding: { x: n('c'), y: n('g') } }],
    ['an aggregate with no measures in a concat child', { data: DATA, vconcat: [{ transform: [{ aggregate: [], groupby: ['c'] }], mark: 'point', encoding: { x: n('c') } }, { mark: 'point', encoding: { x: q('x'), y: q('y') } }] }],
    ['a faceted unit with a spacing', { data: DATA, spacing: 5, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('g'), column: n('c') } }],
    ['a faceted unit with row and column spacing', { data: DATA, spacing: { row: 3, column: 40 }, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('g'), column: n('c') } }],
    ['a wrapped faceted unit with align and bounds', { data: DATA, align: 'each', bounds: 'flush', mark: 'point', encoding: { x: q('x'), y: q('y'), facet: n('c', { columns: 2 }) } }],
    ['a faceted unit with a center', { data: DATA, center: true, mark: 'point', encoding: { x: q('x'), y: q('y'), column: n('c') } }],
  ],
  // spec/base.ts extractCompositionLayout: config.concat / config.facet give compositions their default spacing and columns
  'composition config (rect_mosaic_labelled, line_concat_facet)': [
    ['config.concat.spacing on an hconcat', { data: DATA, config: { concat: { spacing: 60 } }, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['config.concat.spacing under an own spacing', { data: DATA, config: { concat: { spacing: 60 } }, spacing: 5, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['config.concat.columns on a concat', { data: DATA, config: { concat: { columns: 2, spacing: 10 } }, concat: [1, 2, 3].map((i) => ({ width: 60, height: 60, mark: 'point', encoding: { x: q('x'), y: q(i === 1 ? 'y' : 'v') } })) }],
    ['config.concat.columns under a vconcat (one column all the same)', { data: DATA, config: { concat: { columns: 3 } }, vconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['config.concat.spacing on a repeat', { data: DATA, config: { concat: { spacing: 50 } }, repeat: ['y', 'v'], spec: { width: 80, height: 80, mark: 'point', encoding: { x: q('x'), y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }],
    ['config.facet.spacing on a facet', { data: DATA, config: { facet: { spacing: 4 } }, facet: { row: n('g') }, spec: { width: 80, height: 60, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['config.facet.spacing on a faceted unit', { data: DATA, config: { facet: { spacing: 4 } }, width: 80, height: 60, mark: 'point', encoding: { x: q('x'), y: q('y'), column: n('c') } }],
    ['config.facet.columns on a wrapped facet', { data: DATA, config: { facet: { columns: 2 } }, facet: n('c'), spec: { width: 60, height: 60, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['config.facet.columns does not apply to a row and column facet', { data: DATA, config: { facet: { columns: 2, spacing: 12 } }, facet: { row: n('g'), column: n('c') }, spec: { width: 60, height: 60, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a partial facet spacing falls back to the config', { data: DATA, config: { facet: { spacing: 4 } }, spacing: { row: 30 }, facet: { row: n('g'), column: n('c') }, spec: { width: 60, height: 60, mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a faceted unit in an hconcat', { data: DATA, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { width: 60, height: 40, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('g') } }] }],
    ['a faceted unit with a column in a vconcat', { data: DATA, vconcat: [{ width: 60, height: 40, mark: 'point', encoding: { x: q('x'), y: q('y'), column: n('c') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['a faceted unit with a title and layout in a concat', { data: DATA, hconcat: [{ title: 'Faceted', spacing: 3, width: 60, height: 40, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('g'), column: n('c') } }, { mark: 'point', encoding: { x: q('x'), y: q('v') } }] }],
    ['a faceted unit as the spec of a repeat', { data: DATA, repeat: ['y', 'v'], spec: { width: 60, height: 40, mark: 'point', encoding: { x: q('x'), y: { field: { repeat: 'repeat' }, type: 'quantitative' }, row: n('g') } } }],
    ['a facet nested in an hconcat under config.concat', { data: DATA, config: { concat: { spacing: 33 }, facet: { spacing: 2 } }, hconcat: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { width: 60, height: 40, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('g') } }] }],
  ],
  // axis/parse.ts mergeAxisComponent + common.ts mergeTitleComponent: a title written on an axis beats the titles derived from fields
  'axis titles of layers (rect_mosaic_labelled)': [
    ['an axis title in the second layer', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { axis: { title: 'Cyl' } }) } }] }],
    ['an axis title in the first layer', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y', { axis: { title: 'First' } }) } }, { mark: 'line', encoding: { x: q('x'), y: q('v') } }] }],
    ['an axis title and a field title in two layers', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y', { title: 'Field' }) } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { axis: { title: 'Axis' } }) } }] }],
    ['two axis titles', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y', { axis: { title: 'One' } }) } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { axis: { title: 'Two' } }) } }] }],
    ['an axis title with a ranged layer', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('y'), y2: { field: 'v' } } }, { mark: 'text', encoding: { x: n('c'), y: q('v', { axis: { title: 'Range' } }), text: n('c') } }] }],
  ],
  // scale/range.ts STROKEDASH + legend/parse.ts: a strokeDash field has an ordinal scale over the dash patterns and a legend
  'stroke dash scales and legends (line_strokedash, line_dashed_part, stocks-2009-layered-line-point)': [
    ['a line dashed by a field', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), strokeDash: n('g') } }],
    ['a line dashed and coloured by the same field', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('g'), strokeDash: n('g') } }],
    ['a line dashed and coloured by different fields', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('c'), strokeDash: n('g') } }],
    ['a dashed line with an explicit range', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), strokeDash: n('g', { scale: { range: [[8, 2], [2, 2]] } }) } }],
    ['a dashed line with no legend', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), strokeDash: n('g', { legend: null }) } }],
    ['a dashed line with a titled legend', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), strokeDash: n('g', { title: 'Group', legend: { orient: 'bottom' } }) } }],
    ['a dashed point', { data: DATA, mark: { type: 'point', filled: false }, encoding: { x: q('x'), y: q('y'), strokeDash: n('g') } }],
    ['a dashed bar outline', { data: DATA, mark: { type: 'bar', stroke: 'black' }, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), strokeDash: n('g') } }],
    ['a dashed area', { data: DATA, mark: { type: 'area', stroke: 'black' }, encoding: { x: q('x'), y: q('y'), strokeDash: n('g') } }],
    ['a layered line (dashed) and point (shaped) over one field', { data: DATA, transform: [{ filter: 'datum.x > 0' }], layer: [{ mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('g'), strokeDash: n('g') } }, { mark: { type: 'point', filled: true, size: 60, opacity: 1 }, encoding: { x: q('x'), y: q('y'), color: n('g'), shape: n('g') } }] }],
    ['a dashed line in a concat shares the scale', { data: DATA, hconcat: [{ mark: 'line', encoding: { x: q('x'), y: q('y'), strokeDash: n('g') } }, { mark: 'line', encoding: { x: q('x'), y: q('v'), strokeDash: n('g') } }] }],
    ['a dashed trail', { data: DATA, mark: 'trail', encoding: { x: q('x'), y: q('y'), size: q('v'), strokeDash: n('g') } }],
    ['a dashed line with a condition on the colour', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('y'), strokeDash: n('g'), color: { value: 'red' } } }],
  ],
  // scale/parse.ts (`scale: null` has no scale component): the field's own values paint the mark (bar_color_disabled_scale, ternary)
  'identity scales (bar_color_disabled_scale, ternary)': [
    ['a bar painted by colour names in the data', { data: { values: [{ k: 'a', v: 3, col: 'red' }, { k: 'b', v: 5, col: '#00ff00' }, { k: 'c', v: 2, col: 'steelblue' }] }, mark: 'bar', encoding: { x: n('k'), y: q('v'), color: n('col', { scale: null }) } }],
    ['points filled by colour names', { data: { values: [{ x: 1, y: 2, col: 'red' }, { x: 2, y: 3, col: 'blue' }] }, mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('col', { scale: null }) } }],
    ['a fill from the data on a bar', { data: { values: [{ k: 'a', v: 3, col: 'red' }, { k: 'b', v: 5, col: 'green' }] }, mark: 'bar', encoding: { x: n('k'), y: q('v'), fill: n('col', { scale: null }) } }],
    ['a stroke from the data on a point', { data: { values: [{ x: 1, y: 2, col: 'red' }, { x: 2, y: 3, col: 'blue' }] }, mark: { type: 'point', filled: false }, encoding: { x: q('x'), y: q('y'), stroke: n('col', { scale: null }) } }],
    ['opacity from the data', { data: { values: [{ x: 1, y: 2, o: 0.2 }, { x: 2, y: 3, o: 0.9 }] }, mark: 'circle', encoding: { x: q('x'), y: q('y'), opacity: q('o', { scale: null }) } }],
    ['stroke widths from the data', { data: { values: [{ x: 1, y: 2, w: 1 }, { x: 2, y: 3, w: 6 }] }, mark: 'point', encoding: { x: q('x'), y: q('y'), strokeWidth: q('w', { scale: null }) } }],
    ['an identity colour next to a scaled size', { data: { values: [{ x: 1, y: 2, col: 'red', s: 3 }, { x: 2, y: 3, col: 'blue', s: 9 }] }, mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('col', { scale: null }), size: q('s') } }],
    ['an identity colour in a layer', { data: { values: [{ x: 1, y: 2, col: 'red' }, { x: 2, y: 3, col: 'blue' }] }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('col', { scale: null }) } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] }],
  ],
  // param.ts: a variable parameter bound to an input needs no initial value of its own (interactive_paintbrush_simple_true)
  'bound parameters without a value (interactive_paintbrush_simple_true, interactive_paintbrush_simple_false)': [
    ['a checkbox toggling a colour field', { data: DATA, params: [{ name: 'toggle', bind: { input: 'checkbox' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'toggle', field: 'c', type: 'nominal' }, value: 'steelblue' } } }],
    ['a checkbox and a pointer selection', { data: DATA, params: [{ name: 'toggle', bind: { input: 'checkbox' } }, { name: 'brush', select: { type: 'point', on: 'pointerover' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'toggle', field: 'c', type: 'nominal' }, value: 'steelblue' }, size: { condition: { param: 'brush', value: 300 }, value: 50 } } }],
    ['a range input without a value used in a test', { data: DATA, params: [{ name: 'cut', bind: { input: 'range', min: 0, max: 8, step: 1 } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { test: 'datum.x > cut', value: 'red' }, value: 'grey' } } }],
  ],
  // position-rect.ts rectBinPosition, init.ts orient, scale `bins` (bar_binned_data, histogram_bin_transform, wheat_wages): bin: "binned" is a
  // field of bin starts with a secondary field of ends, drawn as the bins of a histogram
  'pre-binned data (bar_binned_data, histogram_bin_transform, layer_cumulative_histogram, wheat_wages)': [
    ['pre-binned bars with a step', { data: BINS, mark: 'bar', encoding: { x: { field: 'bin_start', bin: { binned: true, step: 2 } }, x2: { field: 'bin_end' }, y: q('count') } }],
    ['pre-binned bars with the string form', { data: BINS, mark: 'bar', encoding: { x: { field: 'bin_start', bin: 'binned', type: 'quantitative' }, x2: { field: 'bin_end' }, y: q('count') } }],
    ['horizontal pre-binned bars', { data: BINS, mark: 'bar', encoding: { y: { field: 'bin_start', bin: { binned: true, step: 2 } }, y2: { field: 'bin_end' }, x: q('count') } }],
    ['pre-binned bars with a colour', { data: BINS, mark: 'bar', encoding: { x: { field: 'bin_start', bin: { binned: true, step: 2 } }, x2: { field: 'bin_end' }, y: q('count'), color: n('g') } }],
    ['pre-binned bars with a bin spacing of zero', { data: BINS, config: { bar: { binSpacing: 0 } }, mark: 'bar', encoding: { x: { field: 'bin_start', bin: { binned: true, step: 2 } }, x2: { field: 'bin_end' }, y: q('count') } }],
    ['pre-binned bars with a title and a scale', { data: BINS, mark: 'bar', encoding: { x: { field: 'bin_start', bin: { binned: true, step: 2 }, title: 'Binned', scale: { domain: [0, 20] } }, x2: { field: 'bin_end' }, y: q('count') } }],
    ['pre-binned rects', { data: BINS, mark: 'rect', encoding: { x: { field: 'bin_start', bin: { binned: true, step: 2 } }, x2: { field: 'bin_end' }, y: n('g'), color: q('count') } }],
    ['pre-binned bars next to a line over the same position', { data: BINS, encoding: { x: { type: 'quantitative', axis: { tickCount: 4, title: 'Position' } }, y: { type: 'quantitative', axis: { zindex: 1 } } }, layer: [{ mark: 'bar', encoding: { x: { field: 'bin_start', bin: 'binned' }, x2: { field: 'bin_end' }, y: { field: 'count' } } }, { mark: 'line', encoding: { x: { field: 'bin_start' }, y: { field: 'count' } } }, { mark: 'rule', encoding: { x: { field: 'bin_end' } } }] }],
    ['pre-binned bars made by a bin transform', { data: DATA, transform: [{ bin: true, field: 'v', as: 'bv' }], mark: 'bar', encoding: { x: { field: 'bv', bin: { binned: true, step: 2 }, title: 'V (binned)' }, x2: { field: 'bv_end' }, y: { aggregate: 'count' } } }],
    ['cumulative pre-binned bars', { data: DATA, transform: [{ bin: true, field: 'v', as: 'bv' }, { aggregate: [{ op: 'count', as: 'count' }], groupby: ['bv', 'bv_end'] }, { sort: [{ field: 'bv' }], window: [{ op: 'sum', field: 'count', as: 'cum' }], frame: [null, 0] }], encoding: { x: { field: 'bv', type: 'quantitative', scale: { zero: false }, bin: 'binned' }, x2: { field: 'bv_end' } }, layer: [{ mark: 'bar', encoding: { y: q('cum') } }, { mark: { type: 'bar', color: 'yellow', opacity: 0.5 }, encoding: { y: q('count') } }] }],
  ],
  // timeunit.ts TimeUnitNode (binned) + predicate.ts: a binned time unit's field already holds the start of its unit; the end is made
  // only for rect-based marks or a band position (bar_binnedyearmonth, bar_binned_yearmonth_*, layer_bar_tick_binned_time_band_position)
  'binned time units (bar_binnedyearmonth, bar_binned_yearmonth_grouped, bar_binned_yearmonth_label, time_parse_binnedutc_with_escaped_field)': [
    ['bars over a binned year-month', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['bars over a binned UTC year', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: 'binnedutcyear', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['horizontal bars over a binned UTC year-month-date', { data: MONTHS, mark: 'bar', encoding: { y: { timeUnit: 'binnedutcyearmonthdate', field: 'd', type: 'temporal' }, x: q('v') } }],
    ['bars over the object form of a binned time unit', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: { unit: 'yearmonth', binned: true }, field: 'd', type: 'temporal' }, y: q('v') } }],
    ['bars over a binned time unit with a step', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: { unit: 'yearmonth', binned: true, step: 2 }, field: 'd', type: 'temporal' }, y: q('v') } }],
    ['grouped bars over a binned year-month', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, xOffset: n('g'), color: n('g'), y: q('v') } }],
    ['a filter over a binned time unit', { data: MONTHS, transform: [{ filter: { timeUnit: 'binnedyearmonth', field: 'd', range: [{ year: 2005, month: 1 }, { year: 2005, month: 3 }] } }], mark: 'bar', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['a filter over a binned time unit reads the raw dates', { data: { values: [{ d: '2005-01-15', v: 5 }, { d: '2005-02-15', v: 6 }, { d: '2005-03-15', v: 9 }, { d: '2005-03-01', v: 4 }] }, transform: [{ filter: { timeUnit: 'binnedyearmonth', field: 'd', range: [{ year: 2005, month: 1 }, { year: 2005, month: 3 }] } }], mark: 'point', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['bars and labels at the middle of a binned unit', { data: MONTHS, encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal', bandPosition: 0.5 }, y: q('v') }, layer: [{ mark: 'bar' }, { mark: { type: 'text', baseline: 'bottom' }, encoding: { text: q('v') } }] }],
    ['bars and a tick at the start of a binned unit', { data: MONTHS, config: { bar: { timeUnitBandPosition: 0 }, tick: { timeUnitBandPosition: 0 } }, encoding: { x: { timeUnit: 'binnedutcyear', field: 'd', type: 'temporal' }, y: q('v') }, layer: [{ mark: 'bar' }, { mark: { type: 'tick', size: 20 } }] }],
    ['points over a binned unit (no end is made)', { data: MONTHS, mark: 'point', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['a line over a binned unit', { data: MONTHS, mark: 'line', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['a binned unit on a field with an escaped name', { data: { values: [{ "a(b'c)": '2011-12-10' }, { "a(b'c)": '2011-10-12' }] }, mark: 'bar', encoding: { y: { timeUnit: 'binnedutcyearmonth', field: "a(b\\'c)", type: 'temporal' } } }],
  ],
  // transform.ts AggregateTransform: argmax / argmin keep the winning row, whose fields are read by a bracketed path (bar_argmax_transform)
  'argmax and argmin in aggregate transforms (bar_argmax_transform)': [
    ['the value of the row with the largest field', { data: DATA, transform: [{ aggregate: [{ op: 'argmax', field: 'v', as: 'top' }], groupby: ['c'] }], mark: 'bar', encoding: { x: { field: "top['x']", type: 'quantitative' }, y: n('c') } }],
    ['the value of the row with the smallest field', { data: DATA, transform: [{ aggregate: [{ op: 'argmin', field: 'v', as: 'low' }], groupby: ['g'] }], mark: 'bar', encoding: { y: { field: "low['y']", type: 'quantitative' }, x: n('g') } }],
    ['argmax next to another measure', { data: DATA, transform: [{ aggregate: [{ op: 'argmax', field: 'v', as: 'top' }, { op: 'sum', field: 'v', as: 'total' }], groupby: ['c'] }], mark: 'point', encoding: { x: { field: "top['x']", type: 'quantitative' }, y: q('total'), color: n('c') } }],
    ['argmax in a joinaggregate', { data: DATA, transform: [{ joinaggregate: [{ op: 'argmax', field: 'v', as: 'top' }], groupby: ['c'] }, { calculate: "datum.top.x", as: 'topx' }], mark: 'point', encoding: { x: q('x'), y: q('topx'), color: n('c') } }],
  ],
  // transform.ts RegressionTransform params: true: one row with the model's coefficients and R squared (layer_point_line_regression)
  'regression parameters (layer_point_line_regression)': [
    ['the R squared of a linear fit as a label', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: { type: 'line', color: 'firebrick' }, transform: [{ regression: 'y', on: 'x' }], encoding: { x: q('x'), y: q('y') } }, { transform: [{ regression: 'y', on: 'x', params: true }, { calculate: "'R2: ' + format(datum.rSquared, '.2f')", as: 'R2' }], mark: { type: 'text', color: 'firebrick', x: 'width', align: 'right', y: -5 }, encoding: { text: { type: 'nominal', field: 'R2' } } }] }],
    ['a quadratic fit parameters', { data: DATA, transform: [{ regression: 'y', on: 'x', method: 'quad', params: true }, { calculate: 'datum.coef[0]', as: 'c0' }], mark: 'text', encoding: { text: q('c0') } }],
    ['a grouped fit parameters', { data: DATA, transform: [{ regression: 'y', on: 'x', groupby: ['g'], params: true }, { calculate: 'datum.rSquared', as: 'r2' }], mark: 'bar', encoding: { x: n('g'), y: q('r2') } }],
    ['params: false is the fitted line', { data: DATA, transform: [{ regression: 'y', on: 'x', params: false }], mark: 'line', encoding: { x: q('x'), y: q('y') } }],
  ],
  // scale/assemble.ts + resolve.ts: layers whose scales of a channel cannot merge (or that ask for it) keep one each, named after the layer
  // (layer_text_heatmap_joinaggregate)
  'independent non-position scales in layers (layer_text_heatmap_joinaggregate)': [
    ['a quantitative and a nominal colour with an explicit domain', { data: DATA, encoding: { x: n('c'), y: n('g') }, layer: [{ mark: 'rect', encoding: { color: q('v', { title: 'V', legend: { direction: 'horizontal', gradientLength: 120 } }) } }, { mark: 'text', encoding: { text: q('v'), color: { field: 'g', type: 'nominal', scale: { domain: ['p', 'q'], range: ['black', 'white'] }, legend: null } } }] }],
    ['colour scales kept apart by resolve', { data: DATA, resolve: { scale: { color: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('g') } }] }],
    ['colour scales kept apart by resolve, with legends', { data: DATA, resolve: { scale: { color: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v') } }, { mark: { type: 'tick', thickness: 3 }, encoding: { x: q('x'), y: q('y'), color: n('c') } }] }],
    ['size scales kept apart by resolve', { data: DATA, resolve: { scale: { size: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), size: q('v') } }, { mark: 'circle', encoding: { x: q('x'), y: q('v'), size: q('y') } }] }],
    ['opacity scales kept apart by resolve', { data: DATA, resolve: { scale: { opacity: 'independent' } }, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), opacity: q('x', { aggregate: 'mean' }) } }, { mark: 'point', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }), opacity: q('y', { aggregate: 'max' }) } }] }],
    ['compatible colours still share one scale', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'line', encoding: { x: q('x'), y: q('y'), color: n('c') } }] }],
    ['a layer with no colour next to one with', { data: DATA, resolve: { scale: { color: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c') } }, { mark: 'line', encoding: { x: q('x'), y: q('y') } }] }],
  ],
  // scale/domain.ts mergeDomains: a signal domain (the extent of a bin transform) is one member of the union (layer_histogram_global_mean)
  'a binned layer next to a plain one (layer_histogram_global_mean)': [
    ['a histogram and the mean as a rule', { data: DATA, layer: [{ mark: 'bar', encoding: { x: q('v', { bin: true }), y: { aggregate: 'count' } } }, { mark: 'rule', encoding: { x: q('v', { aggregate: 'mean' }), color: { value: 'red' }, size: { value: 5 } } }] }],
    ['a rule first, then the histogram', { data: DATA, layer: [{ mark: 'rule', encoding: { x: q('v', { aggregate: 'mean' }), color: { value: 'red' } } }, { mark: 'bar', encoding: { x: q('v', { bin: true }), y: { aggregate: 'count' } } }] }],
    ['a histogram and raw points', { data: DATA, layer: [{ mark: 'bar', encoding: { x: q('v', { bin: { maxbins: 4 } }), y: { aggregate: 'count' } } }, { mark: 'point', encoding: { x: q('v') } }] }],
    ['two histograms of different fields', { data: DATA, layer: [{ mark: 'bar', encoding: { x: q('v', { bin: true }), y: { aggregate: 'count' } } }, { mark: { type: 'bar', opacity: 0.4 }, encoding: { x: q('y', { bin: true }), y: { aggregate: 'count' } } }] }],
  ],
  // channeldef.ts datum defs on the paint channels: a constant that the colour scale maps (line_color_halo)
  'datums on fill and stroke (line_color_halo)': [
    ['a line stroked by a datum', { data: DATA, mark: 'line', encoding: { x: q('x'), y: q('v'), stroke: { datum: 'series A', type: 'nominal' } } }],
    ['a bar filled by a datum', { data: DATA, mark: { type: 'bar', filled: true }, encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), fill: { datum: 'Total', type: 'nominal' } } }],
    ['lines of a repeated layer, each stroked by its field name', { data: DATA, repeat: { layer: ['x', 'y'] }, spec: { mark: 'line', encoding: { x: q('v'), y: { field: { repeat: 'layer' }, type: 'quantitative' }, stroke: { datum: { repeat: 'layer' }, type: 'nominal' } } } }],
    ['a halo under coloured lines', { data: DATA, repeat: { layer: ['x', 'y'] }, spec: { layer: [{ mark: { type: 'line', stroke: 'white', strokeWidth: 4 }, encoding: { x: q('v'), y: { field: { repeat: 'layer' }, type: 'quantitative' } } }, { mark: 'line', encoding: { x: q('v'), y: { field: { repeat: 'layer' }, type: 'quantitative' }, stroke: { datum: { repeat: 'layer' }, type: 'nominal' } } }] } }],
    ['two datums in two layers share the scale', { data: DATA, layer: [{ mark: 'line', encoding: { x: q('x'), y: q('y'), stroke: { datum: 'A', type: 'nominal' } } }, { mark: 'line', encoding: { x: q('x'), y: q('v'), stroke: { datum: 'B', type: 'nominal' } } }] }],
  ],
  // facet.ts getCardinalityAggregateForChild, model.ts getSizeSignalRef, layoutsize/assemble.ts, data/facet.ts: an independent x / y scale lives in
  // each cell; a step-sized discrete one makes the cell as wide as its own cardinality (facet_independent_scale, facet_cross_independent_scale, facet_bullet)
  'independent position scales in facets (facet_independent_scale, facet_cross_independent_scale, bar_grouped_facet_independent_scale, facet_bullet)': [
    ['a column facet with an independent discrete x', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
    ['a column facet with an independent discrete x and a step', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { width: { step: 17 }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: n('g') } } }],
    ['a column facet with an independent discrete x of fixed width', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { width: 100, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
    ['a row facet with an independent discrete y', { data: DATA, resolve: { scale: { y: 'independent' } }, facet: { row: n('g') }, spec: { mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }) } } }],
    ['a row and column facet with independent x and y', { data: SPARSE, resolve: { scale: { x: 'independent', y: 'independent' } }, facet: { row: n('g'), column: n('c') }, spec: { mark: 'rect', encoding: { x: n('x'), y: n('v') } } }],
    ['a row and column facet with only x independent', { data: SPARSE, resolve: { scale: { x: 'independent' } }, facet: { row: n('g'), column: n('c') }, spec: { mark: 'rect', encoding: { x: n('x'), y: n('v') } } }],
    ['an independent point x scale', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { mark: 'point', encoding: { x: n('c'), y: q('v') } } }],
    ['an independent continuous x', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['an independent continuous y in rows', { data: DATA, resolve: { scale: { y: 'independent' } }, facet: { row: n('g') }, spec: { mark: 'point', encoding: { x: q('x'), y: q('v') } } }],
    ['an independent x with the header at the bottom', { data: DATA, resolve: { scale: { x: 'independent' } }, mark: 'bar', encoding: { column: n('g', { header: { orient: 'bottom' } }), x: n('c', { axis: null }), y: q('v', { aggregate: 'sum' }), color: n('c') } }],
    ['an independent x over a layered spec', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { width: { step: 17 }, layer: [{ mark: 'line', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }, { mark: 'point', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }] } }],
    ['independent continuous x over layers of bars (a bullet)', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { row: n('c') }, spacing: 10, spec: { encoding: { x: { type: 'quantitative', scale: { nice: false }, title: null } }, layer: [{ mark: { type: 'bar', color: '#eee' }, encoding: { x: { field: 'v' } } }, { mark: { type: 'bar', color: 'steelblue', size: 10 }, encoding: { x: { field: 'y' } } }, { mark: { type: 'tick', color: 'black' }, encoding: { x: { field: 'x' } } }] } }],
    ['shared scales keep the header axes', { data: DATA, facet: { column: n('g') }, spec: { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
    ['a facet whose cells have an x axis and no y scale', { data: DATA, facet: { row: n('g') }, spec: { mark: 'point', encoding: { x: q('x', { axis: { grid: true } }) } } }],
  ],
  // found by comparing the compiled expressions: a composite mark's facet channels, a count-sorted facet, the invalid-value test of a
  // secondary position, a channel the mark does not draw, a predicate on a selection that a later view declares
  'composite marks in facets, facet sorts, invalid values, unsupported channels (expression parity)': [
    ['a boxplot faceted by a row channel', { data: BOX, mark: 'boxplot', encoding: { x: n('c'), y: q('v'), row: n('g') } }],
    ['an errorbar faceted by a column channel', { data: BOX, mark: 'errorbar', encoding: { x: n('c'), y: q('v'), column: n('g') } }],
    ['an errorband faceted by a column channel', { data: BOX, mark: 'errorband', encoding: { x: q('x'), y: q('v'), column: n('g') } }],
    ['an aggregate inside the spec of a facet is grouped by the facet too', { data: DATA, facet: { column: n('g') }, spec: { transform: [{ aggregate: [{ op: 'mean', field: 'v', as: 'm' }], groupby: ['c'] }], mark: 'bar', encoding: { x: n('c'), y: q('m') } } }],
    ['an aggregate on the facet itself runs once before the cells', { data: DATA, transform: [{ aggregate: [{ op: 'mean', field: 'v', as: 'm' }], groupby: ['c', 'g'] }], facet: { column: n('g') }, spec: { mark: 'bar', encoding: { x: n('c'), y: q('m') } } }],
    ['a boxplot in a facet operator', { data: BOX, facet: { column: n('g') }, spec: { mark: 'boxplot', encoding: { x: n('c'), y: q('v') } } }],
    ['a wrapped facet sorted by the count of its rows', { data: DATA, facet: n('c', { sort: { op: 'count', order: 'descending' } }), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a facet row sorted by the count of its rows', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), row: n('c', { sort: { op: 'count' } }) } }],
    ['a boxplot that shows the invalid values', { data: BOX, mark: { type: 'boxplot', invalid: null }, encoding: { x: n('c'), y: q('v') } }],
    ['a rule and a bar over two fields that show the invalid values', { data: NULLS, config: { mark: { invalid: null } }, layer: [{ mark: 'rule', encoding: { x: q('c'), y: q('a'), y2: { field: 'b' } } }, { mark: 'bar', encoding: { x: q('c'), y: q('a'), y2: { field: 'b' } } }] }],
    ['a tick with a y2 it does not draw', { data: DATA, mark: 'tick', encoding: { x: q('x'), y: q('y'), y2: { field: 'v' } } }],
    ['a bar with a shape and a text it does not draw', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), shape: n('g'), text: n('g') } }],
    ['a text mark with a shape it does not draw', { data: DATA, mark: 'text', encoding: { x: q('x'), y: q('y'), text: n('c'), shape: n('g') } }],
    ['a point with pre-binned x2', { data: BINS, mark: 'point', encoding: { x: { field: 'bin_start', bin: 'binned', type: 'quantitative' }, x2: { field: 'bin_end' }, y: q('count') } }],
    ['a log scale: no tick count on the grid', { data: DATA, mark: 'point', encoding: { x: q('x', { scale: { type: 'log' } }), y: q('y', { scale: { type: 'log' } }) } }],
    ['a filter on a selection that a later view declares', { data: DATA, vconcat: [{ transform: [{ filter: { param: 'pts' } }], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { params: [{ name: 'pts', select: { type: 'point', fields: ['c'] } }], mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } }] }],
  ],
  // refusals lifted: the references a datum is (valueref.ts valueRefForFieldOrDatumDef), the mark properties of a mark def
  // (base.ts markDefProperties) and a field read as it is next to the mark's own paint (color.ts)
  'datums, mark defs and unscaled paint (rule_params, layer_line_datum_rule_datetime, ternary)': [
    ['a rule at a DateTime datum over a line', { data: DATA, layer: [{ mark: 'line', encoding: { x: t('t'), y: q('v') } }, { mark: 'rule', encoding: { x: { datum: { year: 2003, month: 6 }, type: 'temporal' }, color: { value: 'red' } } }] }],
    ['a rule at a DateTime datum without a type', { data: DATA, layer: [{ mark: 'line', encoding: { x: t('t'), y: q('v') } }, { mark: 'rule', encoding: { x: { datum: { year: 2004 } } } }] }],
    ['a rule at a UTC DateTime datum on a y axis', { data: DATA, layer: [{ mark: 'line', encoding: { y: t('t'), x: q('v') } }, { mark: 'rule', encoding: { y: { datum: { year: 2002, utc: true }, type: 'temporal' } } }] }],
    ['a rule between two DateTime datums', { data: DATA, layer: [{ mark: 'line', encoding: { x: t('t'), y: q('v') } }, { mark: 'rule', encoding: { x: { datum: { year: 2002 } }, x2: { datum: { year: 2004 } }, y: { datum: 5 } } }] }],
    ['a rule at a temporal datum given as a string', { data: DATA, layer: [{ mark: 'line', encoding: { x: t('t'), y: q('v') } }, { mark: 'rule', encoding: { x: { datum: '2003-01-01', type: 'temporal' } } }] }],
    ['a rule at the value of a parameter', { data: { values: [{}] }, params: [{ name: 'px', value: 25 }, { name: 'py', value: 60 }], mark: 'rule', encoding: { x: { datum: { expr: 'px' }, type: 'quantitative', scale: { domain: [0, 100] } }, y: { datum: { expr: 'py' }, type: 'quantitative', scale: { domain: [0, 100] } }, x2: { datum: { expr: 'px + 30' } }, y2: { datum: { expr: 'py + 30' } } } }],
    ['a point at a datum next to the data', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: { type: 'point', color: 'red' }, encoding: { x: { datum: { expr: '3' }, type: 'quantitative' }, y: { datum: 4, type: 'quantitative' } } }] }],
    ['a stroked point with a fill field that is read as it is', { data: { values: [{ x: 1, y: 2, k: '#ff3c18' }, { x: 3, y: 1, k: '#2aa' }] }, mark: { type: 'point', stroke: '#000000', strokeWidth: 1.5, size: 200 }, encoding: { x: q('x'), y: q('y'), fill: { field: 'k', type: 'nominal', scale: null } } }],
    ['a filled circle with a stroke field that is read as it is', { data: { values: [{ x: 1, y: 2, k: '#ff3c18' }, { x: 3, y: 1, k: '#2aa' }] }, mark: { type: 'circle', fill: 'white', size: 200, strokeWidth: 3 }, encoding: { x: q('x'), y: q('y'), stroke: { field: 'k', type: 'nominal', scale: null } } }],
    ['a tick at a datum over grouped bars', { data: DATA, encoding: { x: n('c'), xOffset: n('g') }, layer: [{ mark: 'bar', encoding: { y: q('v', { aggregate: 'mean' }), color: n('g') } }, { mark: { type: 'tick', color: 'black' }, encoding: { y: { datum: 4 } } }] }],
    ['ticks at values over a nominal axis, oriented by a style', { data: DATA, config: { style: { tk: { orient: 'horizontal' } } }, encoding: { x: n('c') }, layer: [{ mark: 'line', encoding: { y: q('v', { aggregate: 'mean' }) } }, { mark: { type: 'tick', style: 'tk', size: 8 }, encoding: { y: { value: 40 } } }] }],
    ['bars and a tick sized by expressions (bar_bullet_expr_bind)', { data: { values: [{ r: [150, 225, 300], m: [220, 270] }] }, params: [{ name: 'height', value: 20, bind: { input: 'range', min: 1, max: 100, step: 1 } }, { name: 'inner', expr: 'height/2' }], encoding: { x: { type: 'quantitative', scale: { nice: false }, title: null } }, layer: [{ mark: { type: 'bar', color: '#eee', size: { expr: 'height' } }, encoding: { x: { field: 'r[2]' } } }, { mark: { type: 'bar', color: 'steelblue', size: { expr: 'inner' } }, encoding: { x: { field: 'm[0]' } } }, { mark: { type: 'tick', color: 'black', size: { expr: 'height' } }, encoding: { x: { field: 'm[1]' } } }] }],
    ['a vertical bar sized by an expression', { data: { values: [{}] }, params: [{ name: 'w', value: 30 }], mark: { type: 'bar', size: { expr: 'w' } }, encoding: { y: { datum: 5, type: 'quantitative' } } }],
    ['bars with a continuousBandSize and a line over the same time axis', { data: DATA, config: { bar: { continuousBandSize: 12 } }, encoding: { x: t('t'), y: q('v') }, layer: [{ mark: 'bar' }, { mark: 'line' }] }],
    ['a line then bars with a continuousBandSize', { data: DATA, config: { bar: { continuousBandSize: 12 } }, encoding: { x: t('t'), y: q('v') }, layer: [{ mark: 'line' }, { mark: 'bar' }] }],
    ['horizontal bars with a continuousBandSize and a line', { data: DATA, config: { bar: { continuousBandSize: 9 } }, encoding: { y: t('t'), x: q('v') }, layer: [{ mark: 'bar' }, { mark: 'line' }] }],
    ['layers whose first axis has an explicit label angle (layer_bar_annotations)', { data: DATA, encoding: { x: n('c') }, layer: [{ mark: 'bar', encoding: { x: { field: 'c', type: 'nominal', axis: { labelAngle: 0 } }, y: q('v', { aggregate: 'sum' }) } }, { mark: { type: 'text', dy: -4 }, encoding: { y: q('v', { aggregate: 'sum' }), text: q('v', { aggregate: 'sum' }) } }] }],
    ['a temporal axis with a format per time unit (line_override_dynamic_format)', { data: DATA, mark: 'line', encoding: { x: { field: 't', type: 'temporal', axis: { format: { year: '%y', quarter: '%b' } } }, y: q('v') } }],
    ['a tooltip on a temporal axis with a format per time unit', { data: DATA, mark: { type: 'point', tooltip: true }, encoding: { x: { field: 't', type: 'temporal', axis: { format: { year: '%y' } } }, y: q('v') } }],
    ['a time-unit axis with a format per time unit and a config time format', { data: DATA, config: { timeFormat: '%d/%m' }, mark: 'point', encoding: { x: { field: 't', type: 'temporal', timeUnit: 'yearmonth', axis: { format: { month: '%b' } } }, y: q('v') } }],
    ['grouped bars with the paddingInner of the offset scale (bar_grouped_custom_padding)', { data: DATA, mark: 'bar', encoding: { x: n('c', { scale: { padding: 0.2 } }), y: q('v'), xOffset: n('g', { scale: { paddingInner: 0.2 } }), color: n('g') } }],
    ['grouped bars with the paddingOuter of the offset scale', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v'), xOffset: n('g', { scale: { paddingOuter: 0.3 } }), color: n('g') } }],
    ['grouped bars with the padding of the offset scale', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v'), xOffset: n('g', { scale: { padding: 0.15 } }), color: n('g') } }],
    ['horizontal grouped bars with both paddings of the offset scale', { data: DATA, mark: 'bar', encoding: { y: n('c'), x: q('v'), yOffset: n('g', { scale: { paddingInner: 0.4, paddingOuter: 0.1 } }), color: n('g') } }],
    ['jittered points with the padding of the offset scale', { data: DATA, mark: 'point', encoding: { x: n('c'), y: q('v'), xOffset: n('g', { scale: { padding: 0.3 } }) } }],
    ['a dot plot stacking a count of circles (circle_wilkinson_dotplot_stacked)', { data: DATA, transform: [{ window: [{ op: 'rank', as: 'id' }] }], mark: 'circle', encoding: { x: n('c'), y: { aggregate: 'count', stack: true, bandPosition: 0.5 }, detail: { field: 'id' } } }],
    ['circles stacking a count without a band position', { data: DATA, transform: [{ window: [{ op: 'rank', as: 'id' }] }], mark: 'circle', encoding: { x: n('c'), y: { aggregate: 'count', stack: true }, detail: { field: 'id' } } }],
    ['circles stacking a count along x at the start of the segment', { data: DATA, transform: [{ window: [{ op: 'rank', as: 'id' }] }], mark: 'circle', encoding: { y: n('c'), x: { aggregate: 'count', stack: true, bandPosition: 0 }, detail: { field: 'id' } } }],
    ['points stacking a sum at the end of the segment', { data: DATA, mark: 'point', encoding: { x: n('c'), y: q('v', { aggregate: 'sum', stack: true, bandPosition: 1 }), color: n('g') } }],
    ['axes whose label angle is an expression (circle_labelangle_orient_signal)', { data: DATA, params: [{ name: 'xa', value: 0, bind: { input: 'range', min: -360, max: 360 } }, { name: 'ya', value: 0 }], mark: 'circle', encoding: { x: { field: 'c', type: 'nominal', axis: { orient: 'top', labelAngle: { expr: 'xa' } } }, y: { field: 'g', type: 'nominal', axis: { orient: 'right', labelAngle: { expr: 'ya' } } } } }],
    ['axes whose label angle is an expression, on their default sides', { data: DATA, params: [{ name: 'xa', value: 30 }, { name: 'ya', value: 60 }], mark: 'point', encoding: { x: n('c', { axis: { labelAngle: { expr: 'xa' } } }), y: q('v', { axis: { labelAngle: { expr: 'ya' } } }) } }],
    ['an axis whose label colour and size are expressions', { data: DATA, params: [{ name: 'lc', value: 'red' }, { name: 'fs', value: 14 }], mark: 'point', encoding: { x: n('c', { axis: { labelColor: { expr: 'lc' }, labelFontSize: { expr: 'fs' }, labelAlign: 'left' } }), y: q('v') } }],
    ['a tick oriented by the style named after its type', { data: DATA, config: { style: { tick: { orient: 'horizontal' } } }, mark: 'tick', encoding: { x: n('c'), y: { value: 20 } } }],
    ['a rect between four parameters', { data: { values: [{}] }, params: [{ name: 'a', value: 20 }, { name: 'b', value: 70 }], mark: { type: 'rect', color: 'orange', cornerRadius: { expr: 'a / 4' } }, encoding: { x: { datum: { expr: 'a' }, type: 'quantitative', scale: { domain: [0, 100] } }, y: { datum: { expr: 'a' }, type: 'quantitative', scale: { domain: [0, 100] } }, x2: { datum: { expr: 'b' } }, y2: { datum: { expr: 'b + 10' } } } }],
    ['a rect between two datums on a nominal band', { data: DATA, mark: 'rect', encoding: { x: n('c'), y: { datum: 3, type: 'quantitative' }, y2: { datum: 5 } } }],
    ['an area down to a datum', { data: DATA, mark: 'area', encoding: { x: t('t'), y: q('v'), y2: { datum: 0, type: 'quantitative' } } }],
    ['an area with a line and points down to a datum', { data: DATA, mark: { type: 'area', line: true, point: true }, encoding: { x: t('t'), y: q('v'), y2: { datum: 0, type: 'quantitative' } } }],
    ['bars grouped by the layers of a repeat (a datum offset and colour)', { data: DATA, repeat: { layer: ['x', 'v'] }, spec: { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum', field: { repeat: 'layer' }, title: 'Total' }), color: { datum: { repeat: 'layer' }, title: 'Which' }, xOffset: { datum: { repeat: 'layer' } } } } }],
    // the band padding of a scale that a point layer and a tick / bar layer share (scale/properties.ts rates every property with the merged type)
    ['a line then a tick over one nominal axis', { data: DATA, layer: [{ mark: 'line', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }, { mark: 'tick', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['a tick then a line over one nominal axis', { data: DATA, layer: [{ mark: 'tick', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }, { mark: 'line', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['a point then a bar over one nominal axis', { data: DATA, layer: [{ mark: 'point', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }, { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['a bar then a point over one nominal axis', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }, { mark: 'point', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['a line then a tick with a configured band padding', { data: DATA, config: { scale: { bandPaddingInner: 0.3 } }, layer: [{ mark: 'line', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }, { mark: 'tick', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['a line then a tick with an explicit padding on the line', { data: DATA, layer: [{ mark: 'line', encoding: { x: n('c', { scale: { padding: 0.4 } }), y: q('v', { aggregate: 'mean' }) } }, { mark: 'tick', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['grouped bars then a line over one nominal axis', { data: DATA, layer: [{ mark: 'bar', encoding: { x: n('c'), xOffset: n('g'), y: q('v'), color: n('g') } }, { mark: { type: 'line', color: 'black' }, encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] }],
    ['a text then a rect over one nominal axis', { data: DATA, layer: [{ mark: 'text', encoding: { x: n('c'), y: n('g'), text: n('c') } }, { mark: 'rect', encoding: { x: n('c'), y: n('g') } }] }],
    // bin.ts createBinComponent: the extent of a bin is a parameter's value (its `span`); the scale follows the selection (domainRaw, clip)
    ['a histogram over the range of a brush in the view above', { data: DATA, vconcat: [{ params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], mark: 'bar', encoding: { x: q('v', { bin: { maxbins: 6 } }), y: { aggregate: 'count' } } }, { mark: 'bar', encoding: { x: q('v', { bin: { maxbins: 6, extent: { param: 'brush' } } }), y: { aggregate: 'count' } } }] }],
    ['a histogram over the range of a brush in the view below', { data: DATA, vconcat: [{ mark: 'bar', encoding: { x: q('v', { bin: { maxbins: 6, extent: { param: 'brush' } } }), y: { aggregate: 'count' } } }, { params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], mark: 'bar', encoding: { x: q('v', { bin: { maxbins: 6 } }), y: { aggregate: 'count' } } }] }],
    ['a histogram over the range of a brush on another field', { data: DATA, hconcat: [{ params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'bar', encoding: { x: q('v', { bin: { extent: { param: 'brush', field: 'x' } } }), y: { aggregate: 'count' } } }] }],
    ['a histogram over the value of a variable parameter', { data: DATA, params: [{ name: 'range', value: [0, 20] }], mark: 'bar', encoding: { x: q('v', { bin: { maxbins: 5, extent: { param: 'range' } } }), y: { aggregate: 'count' } } }],
    // scale/domain.ts: a signal (or an expression, which init.ts turns into one) is the whole domain
    ['quantitative domains from a signal and from an expression', { data: DATA, params: [{ name: 'xd', value: [0, 8] }, { name: 'yd', value: [1, 9] }], mark: 'point', encoding: { x: q('x', { scale: { domain: { signal: 'xd' } } }), y: q('y', { scale: { domain: { expr: 'yd' } } }) } }],
    ['a nominal colour domain from an expression', { data: DATA, params: [{ name: 'dom', value: ['C', 'B', 'A'] }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c', { scale: { domain: { expr: 'dom' } } }) } }],
    ['a band domain from a signal', { data: DATA, params: [{ name: 'order', value: ['B', 'C', 'A'] }], mark: 'bar', encoding: { x: n('c', { scale: { domain: { signal: 'order' } } }), y: q('v', { aggregate: 'sum' }) } }],
    // scale.ts domainRaw: a domain set aside from the data's (a binding that overrides it)
    ['a domainRaw that is an expression of parameters', { data: DATA, params: [{ name: 'lo', value: 1, bind: { input: 'range', min: 0, max: 3 } }, { name: 'use', value: true, bind: { input: 'checkbox' } }], mark: { type: 'circle', clip: true }, encoding: { x: q('x', { scale: { domainRaw: { expr: 'use ? [lo, 5] : null' } } }), y: q('y'), size: q('v') } }],
    ['a domainRaw that is a signal on y', { data: DATA, params: [{ name: 'hi', value: 7 }], mark: 'point', encoding: { x: q('x'), y: q('y', { scale: { domainRaw: { signal: '[0, hi]' } } }) } }],
    ['a domainRaw on a log scale', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y', { scale: { type: 'log', domainRaw: { signal: '[1, 9]' } } }) } }],
    ['a domainRaw on a band scale (which cannot honour it)', { data: DATA, mark: 'bar', encoding: { x: n('c', { scale: { domainRaw: { signal: "['A', 'B']" } } }), y: q('v', { aggregate: 'sum' }) } }],
    // channel.ts: angle is a continuous channel with its own linear scale to degrees (no legend)
    ['wedges pointing along an angle field', { data: DATA, mark: { type: 'point', shape: 'wedge', filled: true }, encoding: { x: q('x'), y: q('y'), angle: q('v', { scale: { domain: [0, 10], range: [180, 540] } }) } }],
    ['text rotated by an angle field with the default range', { data: DATA, mark: 'text', encoding: { x: q('x'), y: q('y'), text: n('c'), angle: q('v') } }],
    ['squares rotated by a binned angle', { data: DATA, mark: 'square', encoding: { x: q('x'), y: q('y'), angle: q('v', { bin: true }) } }],
    ['an angle next to a colour and a size scale', { data: DATA, mark: { type: 'point', shape: 'wedge', filled: true }, config: { aria: false }, encoding: { x: q('x'), y: q('y'), size: q('v'), color: q('x'), angle: q('y') } }],
    ['an angle on a bar is dropped', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), angle: q('x') } }],
    // two views that each declare a selection of the same name share its store (concat_hover, interactive_dashboard_europe_pop)
    ['a hover selection declared by each of two views', { data: DATA, hconcat: [{ params: [{ name: 'hover', select: { type: 'point', on: 'pointerover' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'hover', empty: false, field: 'c', type: 'nominal' }, value: 'grey' } } }, { params: [{ name: 'hover', select: { type: 'point', on: 'pointerover' } }], mark: 'point', encoding: { x: q('x'), y: q('v'), color: { condition: { param: 'hover', empty: false, field: 'c', type: 'nominal' }, value: 'grey' } } }] }],
    ['a hover selection declared by the layers of two views', { data: DATA, hconcat: [{ layer: [{ params: [{ name: 'hover', select: { type: 'point', on: 'pointerover' } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'hover', empty: false, value: 'red' }, value: 'grey' } } }] }, { layer: [{ params: [{ name: 'hover', select: { type: 'point', on: 'pointerover' } }], mark: 'point', encoding: { x: q('x'), y: q('v'), color: { condition: { param: 'hover', empty: false, value: 'red' }, value: 'grey' } } }] }] }],
    ['an interval brush of the same name in two views', { data: DATA, hconcat: [{ params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], mark: 'bar', encoding: { x: q('x', { bin: true }), y: { aggregate: 'count' } } }, { params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'brush', value: 'red' }, value: 'grey' } } }] }],
    // mark/init.ts orient is undefined when neither axis is a measure: such a bar has no band channel, the missing axis is a range
    ['a bar over only a nominal y', { data: DATA, mark: 'bar', encoding: { y: n('c') } }],
    ['a bar over a nominal x and a nominal y', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: n('g') } }],
    ['a bar over a binned UTC time unit on an ordinal y', { data: MONTHS, mark: 'bar', encoding: { y: { timeUnit: 'binnedutcyearmonthdatehours', field: 'd', type: 'ordinal', title: 'time' } } }],
    ['a bar over a binned time unit on a nominal x', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'nominal' } } }],
    ['a bar over a binned time unit on an ordinal x with a measure', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'ordinal' }, y: q('v') } }],
    // position-rect.ts / position-range.ts: theta, theta2, radius and radius2 of the mark def stand for the missing channels of an arc
    ['an arc given by mark-def angles and radii', { data: { values: [{}] }, params: [{ name: 'r1', value: 10 }, { name: 'r2', value: 80 }, { name: 'a1', value: -0.7 }, { name: 'a2', value: 0.9 }], mark: { type: 'arc', radius: { expr: 'r1' }, radius2: { expr: 'r2' }, theta: { expr: 'a1' }, theta2: { expr: 'a2' }, cornerRadius: 4 } }],
    ['an arc given by constant mark-def angles and radii', { data: { values: [{}] }, mark: { type: 'arc', radius: 20, radius2: 90, theta: 0.5, theta2: 3 } }],
    ['stacked arcs whose mark def gives the radii', { data: DATA, params: [{ name: 'r1', value: 30 }, { name: 'r2', value: 100 }], mark: { type: 'arc', radius: { expr: 'r2' }, radius2: { expr: 'r1' }, padAngle: 0.05 }, encoding: { theta: q('v'), color: n('c') } }],
    // scale/range.ts: a range given as a field is that field's values, sorted by the scale's field
    ['a colour range read from a field', { data: { values: [{ y: 'X', l: 'A', c: 'red' }, { y: 'Y', l: 'B', c: 'blue' }, { y: 'Z', l: 'C', c: 'green' }] }, mark: 'circle', encoding: { y: n('y'), color: n('l', { scale: { range: { field: 'c' } } }) } }],
    ['a size range read from a field', { data: { values: [{ x: 1, y: 2, k: 'a', s: 20 }, { x: 2, y: 3, k: 'b', s: 120 }, { x: 3, y: 1, k: 'c', s: 300 }] }, mark: 'point', encoding: { x: q('x'), y: q('y'), size: n('k', { scale: { range: { field: 's' } } }) } }],
    // data/facet.ts: the facet's own data is the rows BEFORE the view's pipeline, so a facet sorted by an aggregate of a field orders
    // by the raw rows even when the view aggregates (trellis_barley); resolve.axis puts the axes in the cells (trellis_barley_independent)
    ['a wrapped facet ordered by the median of the raw rows (the view aggregates them away)', { data: { values: [50, 50, 50, 50, 0].map((v) => ({ g: 'p', c: 'X', v })).concat([{ g: 'p', c: 'Y', v: 60 }, { g: 'q', c: 'X', v: 10 }, { g: 'q', c: 'X', v: 10 }, { g: 'q', c: 'Y', v: 10 }]) }, facet: n('g', { sort: { op: 'median', field: 'v' } }), columns: 2, spec: { mark: 'point', encoding: { x: q('v', { aggregate: 'median' }), y: n('c', { sort: '-x' }) } } }],
    ['a wrapped facet sorted by a median over a view that aggregates', { data: DATA, facet: n('g', { sort: { op: 'median', field: 'v' } }), columns: 2, spec: { mark: 'point', encoding: { x: q('v', { aggregate: 'median' }), y: n('c', { sort: '-x' }), color: n('t') } } }],
    ['a row facet sorted by a mean over a view that aggregates', { data: DATA, mark: 'bar', encoding: { row: n('g', { sort: { op: 'mean', field: 'x' } }), x: n('c'), y: q('v', { aggregate: 'sum' }) } }],
    ['a crossed facet sorted by an aggregate over a view that aggregates', { data: DATA, mark: 'bar', encoding: { row: n('g', { sort: { op: 'max', field: 'v' } }), column: n('c'), x: n('t'), y: q('v', { aggregate: 'sum' }) } }],
    ['a wrapped facet with independent axes over shared scales', { data: DATA, facet: n('g'), columns: 2, resolve: { axis: { x: 'independent', y: 'independent' } }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a column facet with an independent x axis only', { data: DATA, resolve: { axis: { x: 'independent' } }, mark: 'point', encoding: { column: n('g'), x: q('x'), y: q('y') } }],
    // selection/nearest.ts: the voronoi mark of a faceted unit sits after the unit's marks (which the facet names `child_marks`)
    ['a faceted unit with a nearest point selection and a brush', { data: DATA, params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }, { name: 'near', select: { type: 'point', fields: ['x'], on: 'pointerover', nearest: true } }], mark: 'circle', encoding: { column: n('g'), x: q('x'), y: q('y'), color: { condition: { param: 'brush', value: 'red' }, value: 'grey' } } }],
    // compile/projection: a map in a facet fits its projection to the facet's geojson signal (geo_trellis, interactive_geo_facet_species)
    ['a faceted map of a geojson field', { data: { values: [{ g: 'a', v: 1, geo: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } } }, { g: 'b', v: 5, geo: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[20, 20], [30, 20], [30, 30], [20, 20]]] } } }] }, projection: { type: 'mercator' }, mark: 'geoshape', width: 200, height: 120, encoding: { shape: { field: 'geo', type: 'geojson' }, color: q('v'), row: n('g') } }],
    ['a wrapped facet of maps', { data: { values: [{ g: 'a', v: 1, geo: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } } }, { g: 'b', v: 5, geo: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[20, 20], [30, 20], [30, 30], [20, 20]]] } } }] }, projection: { type: 'mercator' }, mark: 'geoshape', width: 200, height: 120, encoding: { shape: { field: 'geo', type: 'geojson' }, color: q('v'), facet: { field: 'g', type: 'nominal', columns: 2, header: { title: null } } } }],
    ['faceted points on a map by longitude and latitude', { data: { values: [{ g: 'a', lon: 10, lat: 20 }, { g: 'a', lon: 30, lat: 40 }, { g: 'b', lon: -20, lat: 10 }] }, projection: { type: 'mercator' }, mark: 'circle', width: 160, height: 100, encoding: { longitude: q('lon'), latitude: q('lat'), column: n('g') } }],
    ['a text mark with a font and a font style', { data: DATA, mark: { type: 'text', font: 'Verdana', fontStyle: 'italic', fontWeight: 700, fontSize: 13, dx: 4 }, encoding: { x: q('x'), y: q('y'), text: n('c') } }],
  ],
  // optimizers.ts MergeBins + MergeIdenticalNodes: layers under one parent transform read one pipeline (bar_heatlane)
  'layers under a parent transform read one dataset (bar_heatlane)': [
    ['two layers over a parent bin, aggregate and bin', { data: BOX, height: 150, width: 400, transform: [{ bin: true, field: 'v', as: ['bin_v_start', 'bin_v_end'] }, { aggregate: [{ op: 'count', as: 'count' }], groupby: ['bin_v_start', 'bin_v_end'] }, { bin: true, field: 'count', as: ['bin_count_start', 'bin_count_end'] }, { calculate: '-datum.bin_count_end/2', as: 'y2' }, { calculate: 'datum.bin_count_end/2', as: 'y' }, { joinaggregate: [{ field: 'bin_count_end', op: 'max', as: 'max_bin_count_end' }] }], encoding: { x: { field: 'bin_v_start', type: 'quantitative', title: 'v', axis: { grid: false } }, x2: { field: 'bin_v_end' }, y: { field: 'y', axis: null }, y2: { field: 'y2' } }, layer: [{ mark: { type: 'bar', xOffset: 2, x2Offset: -2, cornerRadius: 3 }, encoding: { color: { field: 'max_bin_count_end', type: 'ordinal', title: 'count', scale: { scheme: 'lighttealblue' } } } }, { mark: { type: 'bar', xOffset: 2, x2Offset: -2, yOffset: -3, y2Offset: 3 }, encoding: { color: { field: 'bin_count_end', type: 'ordinal', title: 'count' } } }] }],
    // scale/domain.ts parseDomainForChannel: a discrete position's domain, widened by its secondary channel's, stays sorted
    ['a unit with a discrete y and a y2', { data: DATA, mark: 'bar', encoding: { x: q('x'), x2: { field: 'v' }, y: { field: 'c', type: 'ordinal' }, y2: { field: 'g' } } }],
    ['two layers over a parent bin', { data: BOX, transform: [{ bin: { maxbins: 5 }, field: 'v', as: ['b0', 'b1'] }], encoding: { x: { field: 'b0', type: 'quantitative' }, x2: { field: 'b1' }, y: { aggregate: 'count' } }, layer: [{ mark: 'bar' }, { mark: 'rule', encoding: { color: { value: 'red' } } }] }],
  ],
  // data/timeunit.ts TimeUnitNode.makeFromEncoding: a binned time unit makes its end only for a rect-based mark or a truthy band position
  // (bar_binned_yearmonth_label_band_center)
  'the end of a binned time unit (bar_binned_yearmonth_label_band_center)': [
    ['a bar layer and a text layer sharing a band position of 0', { data: MONTHS, encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal', bandPosition: 0 }, y: q('v') }, layer: [{ mark: 'bar' }, { mark: { type: 'text', baseline: 'bottom' }, encoding: { text: q('v') } }] }],
    ['a text mark with a band position of 0', { data: MONTHS, mark: 'text', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal', bandPosition: 0 }, y: q('v'), text: q('v') } }],
    ['a text mark with a band position of 0.5', { data: MONTHS, mark: 'text', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal', bandPosition: 0.5 }, y: q('v'), text: q('v') } }],
    ['a point mark with no band position', { data: MONTHS, mark: 'point', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal' }, y: q('v') } }],
    ['a bar with a band position of 0', { data: MONTHS, mark: 'bar', encoding: { x: { timeUnit: 'binnedyearmonth', field: 'd', type: 'temporal', bandPosition: 0 }, y: q('v') } }],
  ],
  // mark/encode/scaledZeroOrMinOrMax.ts: the far end of a bar, area or rect is scale zero when the scale definitely holds zero, the
  // domain's start when it definitely does not, and a probe in between (trellis_area_seattle)
  'the baseline of bars, areas and rects (trellis_area_seattle)': [
    ['an area over a scale without zero', { data: DATA, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } }],
    ['a horizontal area over a scale without zero', { data: DATA, mark: { type: 'area', orient: 'horizontal' }, encoding: { y: q('x'), x: q('v', { aggregate: 'mean', scale: { zero: false } }) } }],
    ['a horizontal area over a scale with zero', { data: DATA, mark: { type: 'area', orient: 'horizontal' }, encoding: { y: q('x'), x: q('v', { aggregate: 'mean' }) } }],
    ['an area over a log scale', { data: DATA, mark: 'area', encoding: { x: q('x'), y: q('v', { scale: { type: 'log' } }) } }],
    ['a bar over a scale without zero', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } }],
    ['a horizontal bar over a scale without zero', { data: DATA, mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'mean', scale: { zero: false } }) } }],
    ['a bar over a domain that holds zero', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { zero: false, domain: [-2, 12] } }) } }],
    ['a bar over a domain that does not', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { domain: [3, 12] } }) } }],
    ['a bar over a log scale', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { type: 'log' } }) } }],
    ['a rect over a scale without zero', { data: DATA, mark: 'rect', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } }],
    ['a rect over a sqrt scale', { data: DATA, mark: 'rect', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { type: 'sqrt' } }) } }],
    ['a rule over a scale without zero', { data: DATA, mark: 'rule', encoding: { x: n('c'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } }],
    ['layers over a scale without zero', { data: DATA, layer: [{ mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } }] }],
    ['an area faceted by a row, over a scale without zero', { data: DATA, facet: { row: n('g') }, spec: { height: 40, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'mean', scale: { zero: false } }) } } }],
  ],
}

const SIZE_KEYS = (vg: any) => ({
  width: vg.width,
  height: vg.height,
  signals: (vg.signals ?? []).filter((s: any) => /width|height|step/i.test(s.name)).map((s: any) => ({ name: s.name, value: s.value, update: s.update, init: s.init })),
  scales: Object.fromEntries((vg.scales ?? []).filter((s: any) => /^[xy](Offset)?$/.test(s.name)).map((s: any) => [s.name, { type: s.type, range: s.range, paddingInner: s.paddingInner, paddingOuter: s.paddingOuter, padding: s.padding }])),
})
/** The kinds of data-shaping node in the spec (formula casts, the dataset layout, naming, order and the sharing of nodes between views are not part of it). */
const DATA_NODES = (vg: any): string[] =>
  (vg.data ?? [])
    .flatMap((d: any) => (d.transform ?? []).map((t: any) => t.type))
    .filter((ty: string) => ['aggregate', 'bin', 'extent', 'stack', 'impute', 'window', 'joinaggregate', 'timeunit', 'pivot', 'flatten', 'fold', 'lookup', 'sequence'].includes(ty))

const DATA_NODE_KINDS = (vg: any): string[] => [...new Set(DATA_NODES(vg))].sort()
/** The tick steps of the axes (one entry per axis, in order). */
const AXIS_STEPS = (vg: any): unknown[] => (vg.axes ?? []).map((a: any) => ({ orient: a.orient, grid: a.grid, tickMinStep: a.tickMinStep }))
/** Which text-layout properties the text marks encode themselves (the rest is the config's / the style's). */
const TEXT_PROPS = (vg: any): string[] => {
  const out: string[] = []
  const walk = (ms: any[]): void => {
    for (const m of ms ?? []) {
      if (m.type === 'text') for (const k of ['align', 'baseline', 'dx', 'dy']) if (m.encode?.update?.[k] !== undefined) out.push(k)
      walk(m.marks)
    }
  }
  walk(vg.marks)
  return out.sort()
}
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
  expect(plain(AXIS_STEPS(ours)), 'axis tick steps').toEqual(plain(AXIS_STEPS(oracle)))
  expect(TEXT_PROPS(ours), 'text properties the marks encode').toEqual(TEXT_PROPS(oracle))
  expect(DATA_NODE_KINDS(ours), 'data-shaping transforms').toEqual(DATA_NODE_KINDS(oracle))
  const exprDiff = expressionDiff(ours, oracle)
  if (exprDiff !== '') expect.fail(`compiled expressions differ:\n${exprDiff}`)
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

// compile/invalid/datasources.ts + data/parse.ts: every invalid mode over every kind of mark. The marks read the data the mode gives
// them, the scales' domains read the data it gives them (a PreFilterInvalid or a PostFilterInvalid dataset when they differ), and what
// the two compilers draw is the same (test_invalid_break_paths_filter_domains, test_invalid_break_paths_show_domains)
describe('@aster/vl == vega-lite: the data that marks and scale domains read, per invalid mode', () => {
  const MODES: Array<string | null> = ['filter', 'show', 'break-paths-filter-domains', 'break-paths-show-domains', 'break-paths-show-path-domains', null]
  const MARKS: Array<[string, unknown]> = [['point', 'point'], ['bar', 'bar'], ['line', 'line'], ['area', 'area'], ['line with points', { type: 'line', point: true }], ['tick', 'tick']]
  /** Which dataset (by the number of the transforms behind it) each mark and each scale domain reads. */
  const reads = (vg: any): unknown => {
    const byName = new Map<string, any>((vg.data ?? []).map((d: any) => [d.name, d]))
    const chain = (name: string): string => {
      const d = byName.get(name)
      if (!d) return name
      const own = (d.transform ?? []).map((t: any) => t.type === 'filter' ? 'filter' : t.type).filter((ty: string) => ty !== 'formula').join(',')
      if (d.source === undefined) return ''
      return own === '' ? chain(d.source) : `${chain(d.source)}>${own}`
    }
    const out: string[] = []
    const walk = (ms: any[]): void => { for (const m of ms ?? []) { if (m.from?.data) out.push(`mark ${m.name}: ${chain(m.from.data)}`); walk(m.marks) } }
    walk(vg.marks)
    for (const sc of vg.scales ?? []) {
      const d = sc.domain
      const refs = d?.data ? [d.data] : (d?.fields ?? []).map((f: any) => f.data)
      out.push(`scale ${sc.name}: ${[...new Set(refs.filter(Boolean).map(chain))].sort().join(' | ')}`)
    }
    return out
  }
  for (const [label, mark] of MARKS) {
    for (const mode of MODES) {
      const spec = { data: NULLS, width: 100, height: 100, config: { mark: { invalid: mode } }, mark, encoding: { x: q('a'), y: q('b') } }
      it(`${label}, invalid ${JSON.stringify(mode)}`, async () => {
        const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
        const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
        expect(reads(ours), 'what the marks and the scales read').toEqual(reads(oracle))
        await check(spec)
      }, 30_000)
    }
  }
  // (getMarkConfig('invalid') decides where the scales read: the config alone, not the mark definition the datasets are made from)
  for (const [label, mark] of [['point', 'point'], ['line', 'line']] as const) {
    for (const mode of MODES) {
      it(`a ${label} whose own definition says invalid ${JSON.stringify(mode)}`, async () => {
        const spec = { data: NULLS, width: 100, height: 100, mark: { type: mark, invalid: mode }, encoding: { x: q('a'), y: q('b'), size: q('c') } }
        const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
        const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
        expect(reads(ours), 'what the marks and the scales read').toEqual(reads(oracle))
        await check(spec)
      }, 30_000)
    }
  }
  const layered = (mode: string | null) => ({ data: NULLS, config: { mark: { invalid: mode } }, layer: [{ mark: 'line', encoding: { x: q('a'), y: q('b') } }, { mark: 'point', encoding: { x: q('a'), y: q('b') } }] })
  for (const mode of MODES) {
    it(`a line and a point in layers, invalid ${JSON.stringify(mode)}`, async () => {
      const spec = layered(mode)
      const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(reads(ours), 'what the marks and the scales read').toEqual(reads(oracle))
      await check(spec)
    }, 30_000)
  }
  for (const mode of ['break-paths-filter-domains', 'break-paths-show-domains']) {
    for (const mark of ['line', 'point']) {
      it(`a ${mark} faceted by a row, invalid ${JSON.stringify(mode)}`, async () => {
        await check({ data: NULLS, config: { mark: { invalid: mode } }, width: 100, height: 100, mark, encoding: { x: q('a'), y: q('b'), row: n('c') } })
      }, 30_000)
    }
  }
  it('an ordinal x and a colour, invalid break-paths-filter-domains', async () => {
    const spec = { data: NULLS, config: { mark: { invalid: 'break-paths-filter-domains' } }, mark: 'line', encoding: { x: { field: 'a', type: 'ordinal' }, y: q('b'), color: q('c') } }
    const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
    const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
    expect(reads(ours), 'what the marks and the scales read').toEqual(reads(oracle))
    await check(spec)
  }, 30_000)
})

// legend/parse.ts + legend/properties.ts: a legend's orient, direction and gradient length, from the legend and from config.legend; a
// property config.legend sets and the legend does not is left to the config (trail_comet)
describe('@aster/vl == vega-lite: the orient, direction and gradient length of a legend', () => {
  const CONFIGS: Array<Record<string, unknown>> = [
    {}, { orient: 'bottom' }, { orient: 'top' }, { orient: 'top-left' }, { orient: 'left' }, { direction: 'horizontal' }, { gradientDirection: 'horizontal' },
    { symbolDirection: 'horizontal' }, { orient: 'bottom', direction: 'horizontal' }, { orient: 'bottom', gradientLength: 50 },
    { orient: 'bottom', gradientHorizontalMinLength: 150, gradientHorizontalMaxLength: 260 }, { gradientVerticalMinLength: 40, gradientVerticalMaxLength: 120 },
    { orient: 'left', gradientDirection: 'horizontal' }, { orient: 'bottom', direction: 'horizontal', gradientDirection: 'vertical' },
  ]
  const LEGENDS: Array<Record<string, unknown> | undefined> = [
    undefined, { orient: 'bottom' }, { direction: 'horizontal' }, { orient: 'right', direction: 'horizontal' }, { gradientLength: 90 },
    { orient: 'top', gradientLength: 70 }, { direction: 'vertical', orient: 'bottom' },
  ]
  const shape = (v: any) => (v ? { legend: v } : {})
  const pick = (vg: any): unknown => (vg.legends ?? []).map((l: any) => ({ orient: l.orient, direction: l.direction, gradientLength: l.gradientLength, keys: Object.keys(l).filter((k) => ['fill', 'stroke', 'shape', 'size', 'opacity', 'strokeWidth'].includes(k)).sort() }))
  for (const cfg of CONFIGS) {
    for (const lg of LEGENDS) {
      it(`config.legend ${JSON.stringify(cfg)}, legend ${JSON.stringify(lg ?? null)}`, () => {
        const spec = { data: DATA, config: { legend: cfg }, mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v', shape(lg)), shape: n('c', shape(lg)), size: q('x', shape(lg)) } }
        const oracle = (vl as any).compile(plain(spec)).spec
        const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
        expect(plain(pick(ours))).toEqual(plain(pick(oracle)))
      })
    }
  }
  it('a gradient legend in a facet measures the cell', async () => {
    await check({ data: DATA, config: { legend: { orient: 'bottom', direction: 'horizontal' } }, mark: 'point', encoding: { x: q('x'), y: q('y'), color: q('v'), column: n('g') } })
  }, 30_000)
})

/** The domains of the scales, with the names of the datasets they read left out (how the datasets are named and cut is not what is compared). */
const DOMAIN_SHAPES = (vg: any): unknown =>
  (vg.scales ?? []).map((s: any) => {
    const strip = (d: any): any => (Array.isArray(d) ? d.map(strip) : d && typeof d === 'object' ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k === 'data' && typeof v === 'string' ? '*' : strip(v)])) : d)
    return [s.name, strip(s.domain)]
  })
describe('@aster/vl == vega-lite: the domains of the scales (the datasets read by name, the references once, the sorts)', () => {
  for (const [name, spec] of GROUPS['layers under a parent transform read one dataset (bar_heatlane)']!) {
    it(name, () => {
      const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(plain(DOMAIN_SHAPES(ours))).toEqual(plain(DOMAIN_SHAPES(oracle)))
    })
  }
})

// util.ts accessPathWithDatum: a nested field is flattened with every prefix guarded, so a row that lacks `o` is a missing value
describe('@aster/vl == vega-lite: the guarded flatten expression of a nested field (test_subobject_missing)', () => {
  const flattenExprs = (vg: any): string[] =>
    (vg.data ?? []).flatMap((d: any) => d.transform ?? []).filter((t: any) => t.type === 'formula' && /^datum\[[^(]*$/.test(t.expr)).map((t: any) => t.expr).sort()
  for (const [name, field] of [['two levels', 'o.v'], ['three levels', 'o.p.v'], ['an escaped dot inside a path', 'o.a\\.b']] as const) {
    it(name, () => {
      const spec = { data: { values: [{ c: 'A', o: { v: 1, p: { v: 2 }, 'a.b': 3 } }, { c: 'B' }] }, mark: 'point', encoding: { x: { field: 'c', type: 'nominal' }, tooltip: { field, type: 'nominal' } } }
      const oracle = (vl as any).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(flattenExprs(oracle).length).toBeGreaterThan(0)
      expect(flattenExprs(ours)).toEqual(flattenExprs(oracle))
    })
  }
})

// Every place a field accessor reaches an expression: vega-lite reads the FLATTENED field (`datum["o.v"]`, written by a parse
// formula that guards the path) in filters, conditions and time-unit predicates, and escapes the dot in the transforms that read
// a field by name (aggregate, bin, extent, timeunit). Rows without the parent object must not stop the chart.
describe('@aster/vl == vega-lite: nested fields in predicates and transforms (rows missing the parent object)', () => {
  const NESTED = { values: [{ o: { v: 1, t: '2020-01-01' }, x: 1, c: 'a' }, { o: { v: 2, t: '2021-01-01' }, x: 2, c: 'b' }, { o: { v: 1, t: '2022-01-01' }, x: 3, c: 'a' }, { x: 4, c: 'b' }] }
  const px = { x: { field: 'x', type: 'quantitative' } }
  const pt = (transform: unknown[]) => ({ data: NESTED, transform, mark: 'point', encoding: px })
  // (an ENCODING of a nested field is flattened under a hashed key here and under the joined path in vega-lite: those compare by render only)
  const RENDER_ONLY = new Set(['filter oneOf with a nested y encoding', 'encodings of a nested field', 'a nested field under a flatten output', 'a nested field under a calculated object', 'a nested field of the source next to a flatten'])
  const SITES: Array<[string, Record<string, any>]> = [
    ['filter equal', pt([{ filter: { field: 'o.v', equal: 1 } }])],
    ['filter range', pt([{ filter: { field: 'o.v', range: [1, 2] } }])],
    ['filter oneOf with a nested y encoding', { data: NESTED, transform: [{ filter: { field: 'o.v', oneOf: [1] } }], mark: 'point', encoding: { x: px.x, y: { field: 'o.v', type: 'quantitative' } } }],
    ['filter lt', pt([{ filter: { field: 'o.v', lt: 2 } }])],
    ['filter gt, gte, lte', pt([{ filter: { and: [{ field: 'o.v', gt: 0 }, { field: 'o.v', gte: 1 }, { field: 'o.v', lte: 2 }] } }])],
    ['filter valid', pt([{ filter: { field: 'o.v', valid: true } }])],
    ['filter on a time unit', pt([{ filter: { field: 'o.t', timeUnit: 'year', equal: 2021 } }])],
    ['filter with a string value', { data: { values: [{ o: { s: 'p' }, x: 1 }, { x: 2 }] }, transform: [{ filter: { field: 'o.s', equal: 'p' } }], mark: 'point', encoding: px }],
    ['a condition test', { data: NESTED, mark: 'point', encoding: { x: px.x, color: { condition: { test: { field: 'o.v', equal: 1 }, value: 'red' }, value: 'blue' } } }],
    ['a timeUnit transform', { data: NESTED, transform: [{ timeUnit: 'year', field: 'o.t', as: 'yr' }], mark: 'point', encoding: { x: { field: 'yr', type: 'temporal' }, y: px.x } }],
    ['an aggregate transform', { data: NESTED, transform: [{ aggregate: [{ op: 'sum', field: 'o.v', as: 's' }], groupby: ['c'] }], mark: 'point', encoding: { x: { field: 's', type: 'quantitative' } } }],
    ['a bin transform', { data: NESTED, transform: [{ bin: true, field: 'o.v', as: 'b' }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' } } }],
    ['encodings of a nested field', { data: NESTED, mark: 'point', encoding: { x: px.x, color: { field: 'o.v', type: 'nominal' }, tooltip: { field: 'o.v', type: 'quantitative' } } }],
    ['a nested field under a flatten output', { data: { values: [{ id: 'a', lc: [{ time: 1, mag: 18 }, { time: 2, mag: 19 }] }, { id: 'b', lc: [{ time: 1, mag: 20 }, { time: 3, mag: 22 }] }] }, transform: [{ flatten: ['lc'] }], mark: 'point', encoding: { x: { field: 'lc.time', type: 'quantitative' }, y: { field: 'lc.mag', type: 'quantitative' }, color: n('id') } }],
    ['a nested field under a calculated object', { data: DATA, transform: [{ calculate: '{u: datum.x * 2, w: {z: datum.y}}', as: 'o' }], mark: 'point', encoding: { x: { field: 'o.u', type: 'quantitative' }, y: { field: 'o.w.z', type: 'quantitative' } } }],
    ['a nested field of the source next to a flatten', { data: { values: [{ o: { v: 1 }, lc: [{ t: 1 }, { t: 2 }] }, { o: { v: 2 }, lc: [{ t: 3 }] }] }, transform: [{ flatten: ['lc'] }], mark: 'point', encoding: { x: { field: 'lc.t', type: 'quantitative' }, y: { field: 'o.v', type: 'quantitative' } } }],
  ]
  /** The expressions of the pipeline that name a field: the filters and the formulas that write a joined path. */
  const exprs = (vg: any): string[] =>
    (vg.data ?? []).flatMap((d: any) => d.transform ?? []).filter((t: any) => t.type === 'filter' || (t.type === 'formula' && String(t.as).includes('.'))).map((t: any) => `${t.type}:${t.as ?? ''}:${t.expr}`).filter((s: string) => /o[.\\"]/.test(s))
  const fields = (vg: any): string[] => (vg.data ?? []).flatMap((d: any) => d.transform ?? []).filter((t: any) => ['aggregate', 'bin', 'extent', 'timeunit'].includes(t.type)).map((t: any) => JSON.stringify([t.type, t.field, t.fields, t.groupby])).filter((s: string) => s.includes('o'))
  for (const [name, spec] of SITES) {
    it(name, async () => {
      const oracle = (vl as any).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      if (!RENDER_ONLY.has(name)) {
        expect(exprs(ours).sort()).toEqual(exprs(oracle).sort())
        expect(fields(ours)).toEqual(fields(oracle))
      }
      await check(spec)
    }, 30_000)
  }
})

// optimize/mergebins.ts: layers that bin the same field share one bin node (one extent, one bins signal)
describe('@aster/vl == vega-lite: layers that bin the same field (concat_bar_layer_circle)', () => {
  const binned = { x: { bin: { maxbins: 10 }, field: 'x', type: 'quantitative' }, y: { bin: { maxbins: 10 }, field: 'y', type: 'quantitative' }, size: { aggregate: 'count', type: 'quantitative' } }
  const SEL = { name: 'pts', select: { type: 'point', encodings: ['x'] } }
  const GROUP = { mark: 'bar', params: [SEL], encoding: { x: { field: 'c', type: 'nominal' }, y: { aggregate: 'count', type: 'quantitative' } } }
  const CASES2: Array<[string, Record<string, any>]> = [
    ['a layer filtered by a selection bins with the first layer\'s extent', { data: DATA, vconcat: [{ layer: [{ mark: 'circle', encoding: { ...binned, opacity: { value: 0.4 } } }, { transform: [{ filter: { param: 'pts' } }], mark: 'circle', encoding: binned }] }, GROUP] }],
    ['a layer filtered by a predicate', { data: DATA, layer: [{ mark: 'circle', encoding: binned }, { transform: [{ filter: 'datum.v > 4' }], mark: 'circle', encoding: { ...binned, color: { value: 'red' } } }] }],
  ]
  for (const [name, spec] of CASES2) it(name, async () => {
    const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
    const sigs = (ours.data as any[]).flatMap((d) => d.transform ?? []).filter((t: any) => typeof t.signal === 'string' && (t.type === 'bin' || t.type === 'extent')).map((t: any) => `${t.type}:${t.signal}`)
    expect(new Set(sigs).size, 'a signal is declared once').toBe(sigs.length)
    await check(spec)
  }, 30_000)
})

// compile/data/sequence.ts producedFields: the generated numbers are not parsed again (no cast formula in front of the pipeline)
describe('@aster/vl == vega-lite: a sequence is not cast', () => {
  const casts = (vg: any): string[] => (vg.data ?? []).flatMap((d: any) => d.transform ?? []).filter((t: any) => t.type === 'formula' && /toNumber|toDate/.test(t.expr)).map((t: any) => t.expr)
  it('the output name is left alone', () => {
    const spec = { data: { sequence: { start: 0, stop: 6, step: 1, as: 'x' } }, mark: 'point', encoding: { x: q('x'), y: q('x') } }
    const oracle = (vl as any).compile(plain(spec)).spec
    const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
    expect(casts(ours)).toEqual(casts(oracle))
  })
})

// compile/mark/encode/tooltip.ts tooltipData: the tooltip's formats are the config's overlaid by config.tooltipFormat
describe('@aster/vl == vega-lite: config.tooltipFormat', () => {
  const tooltips = (vg: any): string[] => {
    const out: string[] = []
    const walk = (ms: any[]): void => { for (const m of ms ?? []) { if (m.encode?.update?.tooltip) out.push(JSON.stringify(m.encode.update.tooltip)); walk(m.marks) } }
    walk(vg.marks)
    return out
  }
  const base = { data: { values: [{ a: 1.23456, b: 2.5, t: '2020-03-04', c: 'k' }] } }
  const CASES: Array<[string, Record<string, any>]> = [
    ['a number format for the tooltips only', { ...base, config: { tooltipFormat: { numberFormat: '.8f' }, numberFormat: 'd' }, mark: { type: 'bar', tooltip: true }, encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'a', type: 'quantitative' } } }],
    ['a time format for the tooltips only', { ...base, config: { tooltipFormat: { timeFormat: '%Y' }, timeFormat: '%d' }, mark: { type: 'point', tooltip: true }, encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'b', type: 'quantitative' } } }],
    ['a tooltip encoding with the tooltip format', { ...base, config: { tooltipFormat: { numberFormat: '.1f' } }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' }, tooltip: [{ field: 'a', type: 'quantitative' }, { field: 'b', type: 'quantitative' }] } }],
    ['a single tooltip field with the tooltip format', { ...base, config: { tooltipFormat: { numberFormat: '.3f' } }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' }, tooltip: { field: 'b', type: 'quantitative' } } }],
    ['a custom number format type for the tooltips', { ...base, config: { customFormatTypes: true, tooltipFormat: { numberFormat: '$', numberFormatType: 'price' } }, mark: { type: 'bar', tooltip: true }, encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'a', type: 'quantitative' } } }],
    ['no tooltip format', { ...base, config: { numberFormat: '.2f' }, mark: { type: 'bar', tooltip: true }, encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'a', type: 'quantitative' } } }],
  ]
  // (the screen-reader description of a mark reads the same formats)
  const descriptions = (vg: any): string[] => {
    const out: string[] = []
    const walk = (ms: any[]): void => { for (const m of ms ?? []) { if (m.encode?.update?.description) out.push(JSON.stringify(m.encode.update.description)); walk(m.marks) } }
    walk(vg.marks)
    return out
  }
  for (const [name, spec] of CASES) {
    it(name, () => {
      const oracle = (vl as any).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(tooltips(oracle).length).toBeGreaterThan(0)
      expect(tooltips(ours)).toEqual(tooltips(oracle))
      expect(descriptions(ours)).toEqual(descriptions(oracle))
    })
  }
})

// compile/selection/... parseParameter: an input binding's own properties (placeholder, autocomplete, debounce, element) reach the signal
describe('@aster/vl == vega-lite: input bindings', () => {
  const binds = (vg: any): unknown[] => (vg.signals ?? []).filter((sg: any) => sg.bind).map((sg: any) => [sg.name, sg.bind])
  const BINDS: Array<[string, Record<string, unknown>]> = [
    ['a search input with a placeholder and a name', { input: 'search', placeholder: 'Car model', name: 'Search' }],
    ['a text input with autocomplete', { input: 'text', placeholder: 'Type', autocomplete: 'off' }],
    ['a range with a debounce and an element', { input: 'range', min: 0, max: 5, step: 1, debounce: 100, element: '#ctl' }],
  ]
  for (const [name, bind] of BINDS) {
    it(name, async () => {
      const spec = { data: DATA, params: [{ name: 'q', value: '', bind }], mark: 'point', encoding: { x: q('x'), y: q('y'), opacity: { condition: { test: 'test(regexp(q,"i"), datum.c)', value: 0.8 }, value: 0.1 } } }
      const oracle = (vl as any).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(binds(oracle).length).toBe(1)
      expect(binds(ours)).toEqual(binds(oracle))
      await check(spec)
    }, 30_000)
  }
})

// facet.ts assembleDefaultLayout + axis/assemble.ts assembleAxisSignals: cells are not aligned along an independent direction (unless both row and column
// are given), and a cell whose axis has no grid scale gets the child's size as its own `width` / `height`
describe('@aster/vl == vega-lite: the layout and the signals of a faceted cell', () => {
  const cell = (vg: any): any => (vg.marks ?? []).find((m: any) => m.type === 'group' && m.style === 'cell' || m.name === 'cell')
  const SPECS: Array<[string, Record<string, any>]> = [
    ['a column facet with an independent x', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { column: n('g') }, spec: { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
    ['a row facet with an independent y', { data: DATA, resolve: { scale: { y: 'independent' } }, facet: { row: n('g') }, spec: { mark: 'bar', encoding: { y: n('c'), x: q('v', { aggregate: 'sum' }) } } }],
    ['a row facet with an independent x (still aligned)', { data: DATA, resolve: { scale: { x: 'independent' } }, facet: { row: n('g') }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
    ['a row and column facet with independent scales', { data: SPARSE, resolve: { scale: { x: 'independent', y: 'independent' } }, facet: { row: n('g'), column: n('c') }, spec: { mark: 'rect', encoding: { x: n('x'), y: n('v') } } }],
    ['cells with an x axis and no y scale', { data: DATA, facet: { row: n('g') }, spec: { mark: 'point', encoding: { x: q('x', { axis: { grid: true } }) } } }],
    ['cells with a y axis and no x scale', { data: DATA, facet: { column: n('g') }, spec: { mark: 'point', encoding: { y: q('y', { axis: { grid: true } }) } } }],
  ]
  for (const [name, spec] of SPECS) {
    it(name, () => {
      const oracle = (vl as any).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(plain(ours.layout?.align)).toEqual(plain(oracle.layout?.align))
      expect(plain(cell(ours)?.signals ?? null)).toEqual(plain(cell(oracle)?.signals ?? null))
    })
  }
})

// spec/base.ts extractCompositionLayout: a spacing given for one direction takes the config's (20) for the other (trellis_area_seattle)
describe('@aster/vl == vega-lite: the spacing of a composition', () => {
  const unit = { mark: 'point', encoding: { x: q('x'), y: q('y') } }
  const SPECS: Array<[string, Record<string, any>]> = [
    ['a row facet with a row spacing', { data: DATA, spacing: { row: 1 }, facet: { row: n('g') }, spec: unit }],
    ['a column facet with a column spacing', { data: DATA, spacing: { column: 3 }, facet: { column: n('g') }, spec: unit }],
    ['a facet with both spacings', { data: DATA, spacing: { row: 2, column: 4 }, facet: { row: n('g'), column: n('c') }, spec: unit }],
    ['a facet with one number', { data: DATA, spacing: 7, facet: { row: n('g') }, spec: unit }],
    ['a wrapped facet with a row spacing', { data: DATA, spacing: { row: 1 }, facet: n('c'), columns: 2, spec: unit }],
    ['a facet with a row spacing and config.facet.spacing', { data: DATA, config: { facet: { spacing: 9 } }, spacing: { row: 1 }, facet: { row: n('g') }, spec: unit }],
    ['a hconcat with a partial spacing', { data: DATA, spacing: { row: 1 }, hconcat: [unit, unit] }],
    ['a concat with a partial spacing and config.concat.spacing', { data: DATA, config: { concat: { spacing: 11 } }, spacing: { column: 2 }, concat: [unit, unit], columns: 2 }],
    ['a faceted unit with a partial spacing', { data: DATA, spacing: { column: 1 }, mark: 'point', encoding: { x: q('x'), y: q('y'), column: n('g') } }],
  ]
  for (const [name, spec] of SPECS) {
    it(name, () => {
      const oracle = (vl as any).compile(plain(spec)).spec
      const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
      expect(plain(ours.layout?.padding)).toEqual(plain(oracle.layout?.padding))
    })
  }
})

// -------------------------------------------------------------------------------------------------------------------------------
// The COMPILED EXPRESSIONS, case by case. The cases above compare what vega renders from the two compilers' output; that cannot see a
// generated expression whose results happen to coincide on the test data (a whisker fence scaled by 1.01 moves no point of a small data
// set). Here the expressions themselves are compared (test/vl-expressions.ts: every filter / formula / signal / encode expression of the
// compiled Vega, parsed and printed back, with Aster's safe field names reduced to vega-lite's), over the composite marks, whose data
// flow is nothing but generated expressions, and over the other features that generate them.
describe('@aster/vl == vega-lite: the compiled expressions', () => {
  const same = (spec: Record<string, any>): void => {
    const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
    const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
    const diff = expressionDiff(ours, oracle)
    if (diff !== '') expect.fail(`compiled expressions differ:\n${diff}`)
  }
  const E = BOX
  const CASES: Array<[string, Record<string, any>]> = []
  const add = (name: string, spec: Record<string, any>): void => void CASES.push([name, spec])

  // compositemark/boxplot.ts: the fences, the whisker aggregates and the outlier filter, for every extent
  for (const extent of [1.5, 3, 0.5, 'min-max'] as const) {
    for (const orient of ['vertical', 'horizontal'] as const) {
      const v = { field: 'v', type: 'quantitative' }
      const d = { field: 'c', type: 'nominal' }
      add(`boxplot, extent ${extent}, ${orient}`, { data: E, mark: { type: 'boxplot', extent }, encoding: orient === 'vertical' ? { x: d, y: v } : { y: d, x: v } })
    }
  }
  add('boxplot without a dimension', { data: E, mark: 'boxplot', encoding: { y: q('v') } })
  add('boxplot with a colour, a size and a tooltip', { data: E, mark: { type: 'boxplot', size: 20 }, encoding: { x: n('c'), y: q('v'), color: n('g'), tooltip: [n('c'), q('v')] } })
  add('boxplot with a time unit dimension', { data: E, mark: 'boxplot', encoding: { x: { field: 't', timeUnit: 'year', type: 'temporal' }, y: q('v') } })
  add('boxplot without outliers', { data: E, mark: { type: 'boxplot', outliers: false }, encoding: { x: n('c'), y: q('v') } })
  add('boxplot with the invalid values kept', { data: E, mark: { type: 'boxplot', invalid: null }, encoding: { x: n('c'), y: q('v') } })
  add('boxplot with a transform before it', { data: E, transform: [{ calculate: 'datum.v * 2', as: 'w' }, { filter: 'datum.w > 4' }], mark: 'boxplot', encoding: { x: n('c'), y: q('w') } })
  add('boxplot in a facet', { data: E, mark: 'boxplot', encoding: { x: n('c'), y: q('v'), row: n('g') } })
  add('boxplots in a layer', { data: E, layer: [{ mark: 'boxplot', encoding: { x: n('c'), y: q('v') } }, { mark: 'point', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }] })

  // compositemark/errorbar.ts: the extent expressions (stderr, stdev, ci, iqr), the centre, and the part switches
  for (const extent of ['ci', 'stderr', 'stdev', 'iqr'] as const) {
    for (const orient of ['vertical', 'horizontal'] as const) {
      const v = { field: 'v', type: 'quantitative' }
      const d = { field: 'c', type: 'nominal' }
      add(`errorbar, extent ${extent}, ${orient}`, { data: E, mark: { type: 'errorbar', extent }, encoding: orient === 'vertical' ? { x: d, y: v } : { y: d, x: v } })
      add(`errorbar with ticks and a mean, extent ${extent}, ${orient}`, { data: E, mark: { type: 'errorbar', extent, ticks: true, rule: { strokeWidth: 3 } }, encoding: orient === 'vertical' ? { x: d, y: v } : { y: d, x: v } })
      add(`errorband, extent ${extent}, ${orient}`, { data: E, mark: { type: 'errorband', extent, borders: true }, encoding: orient === 'vertical' ? { x: q('x'), y: v } : { y: q('x'), x: v } })
    }
  }
  add('errorbar over a minimum and a maximum', { data: E, mark: 'errorbar', encoding: { x: n('c'), y: q('v', { aggregate: 'min' }), y2: { field: 'v', aggregate: 'max' } } })
  add('errorbar over an error field', { data: { values: [{ c: 'A', v: 5, e: 1 }, { c: 'B', v: 7, e: 2 }] }, mark: 'errorbar', encoding: { x: n('c'), y: q('v'), yError: { field: 'e' } } })
  add('errorbar over two error fields', { data: { values: [{ c: 'A', v: 5, lo: 1, hi: 2 }] }, mark: 'errorbar', encoding: { x: n('c'), y: q('v'), yError: { field: 'lo' }, yError2: { field: 'hi' } } })
  add('errorbar over an error value', { data: E, mark: 'errorbar', encoding: { x: n('c'), y: q('v'), yError: { value: 2 } } })
  add('errorbar over a value and a dimension with a colour', { data: E, mark: { type: 'errorbar', thickness: 2, size: 20 }, encoding: { x: n('c'), y: q('v'), color: n('g') } })
  add('errorbar with an aggregate tooltip', { data: E, mark: { type: 'errorbar', tooltip: true }, encoding: { x: n('c'), y: q('v') } })
  add('errorbar of a time unit', { data: E, mark: 'errorbar', encoding: { x: { field: 't', timeUnit: 'year', type: 'temporal' }, y: q('v') } })
  add('errorbar after an aggregate-free transform', { data: E, transform: [{ filter: 'datum.v > 3' }], mark: 'errorbar', encoding: { x: n('c'), y: q('v') } })
  add('errorbar in a layer with a bar', { data: E, layer: [{ mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'mean' }) } }, { mark: { type: 'errorbar', extent: 'stdev' }, encoding: { x: n('c'), y: q('v') } }] })
  add('errorband with an opacity and a colour', { data: E, mark: { type: 'errorband', opacity: 0.4, color: 'red' }, encoding: { x: q('x'), y: q('v') } })
  add('errorband with a tooltip', { data: E, mark: { type: 'errorband', tooltip: true }, encoding: { x: q('x'), y: q('v') } })
  add('errorband between two fields', { data: { values: [{ x: 1, lo: 1, hi: 5 }, { x: 2, lo: 2, hi: 4 }] }, mark: 'errorband', encoding: { x: q('x'), y: q('lo'), y2: { field: 'hi' } } })
  add('errorband over error fields', { data: { values: [{ x: 1, v: 3, e: 1 }, { x: 2, v: 4, e: 2 }] }, mark: 'errorband', encoding: { x: q('x'), y: q('v'), yError: { field: 'e' } } })
  add('errorband by a colour', { data: E, mark: 'errorband', encoding: { x: q('x'), y: q('v'), color: n('g') } })
  add('errorband in a layer with a line', { data: E, layer: [{ mark: { type: 'errorband', extent: 'ci' }, encoding: { x: q('x'), y: q('v') } }, { mark: 'line', encoding: { x: q('x'), y: q('v', { aggregate: 'mean' }) } }] })

  // the other features whose output is generated expressions: filters and predicates, calculate, time units, bins, stacks, windows,
  // tooltips, conditions, impute, fold / pivot / flatten / lookup, selections
  const preds: Array<[string, unknown]> = [
    ['equal', { field: 'v', equal: 5 }],
    ['range', { field: 'v', range: [3, 8] }],
    ['oneOf', { field: 'c', oneOf: ['A', 'B'] }],
    ['lt, gt', { and: [{ field: 'v', lt: 9 }, { field: 'v', gt: 2 }] }],
    ['lte, gte', { or: [{ field: 'v', lte: 3 }, { field: 'v', gte: 8 }] }],
    ['not', { not: { field: 'c', equal: 'A' } }],
    ['valid', { field: 'v', valid: true }],
    ['a time unit', { field: 't', timeUnit: 'year', equal: 2002 }],
    ['a date range', { field: 't', range: [{ year: 2001 }, { year: 2003 }] }],
    ['an expression', 'datum.v > 3 && datum.c !== "B"'],
  ]
  for (const [name, filter] of preds) add(`filter ${name}`, { data: DATA, transform: [{ filter }], mark: 'point', encoding: { x: q('x'), y: q('y') } })
  add('a calculate', { data: DATA, transform: [{ calculate: 'datum.x * 2 + datum.y', as: 'z' }], mark: 'point', encoding: { x: q('z'), y: q('y') } })
  add('a calculate with a function', { data: DATA, transform: [{ calculate: 'sqrt(pow(datum.x, 2) + pow(datum.y, 2))', as: 'r' }], mark: 'point', encoding: { x: q('r'), y: q('y') } })
  add('a window', { data: DATA, transform: [{ window: [{ op: 'sum', field: 'v', as: 'cum' }], sort: [{ field: 'x' }], frame: [null, 0] }], mark: 'line', encoding: { x: q('x'), y: q('cum') } })
  add('a joinaggregate', { data: DATA, transform: [{ joinaggregate: [{ op: 'mean', field: 'v', as: 'm' }], groupby: ['c'] }, { calculate: 'datum.v - datum.m', as: 'dev' }], mark: 'bar', encoding: { x: n('c'), y: q('dev') } })
  add('a fold', { data: DATA, transform: [{ fold: ['x', 'y'], as: ['k', 'val'] }], mark: 'point', encoding: { x: n('k'), y: q('val') } })
  add('a pivot', { data: DATA, transform: [{ pivot: 'c', value: 'v', groupby: ['g'] }], mark: 'point', encoding: { x: q('A'), y: q('B') } })
  add('a flatten', { data: { values: [{ a: [1, 2], b: 'x' }] }, transform: [{ flatten: ['a'] }], mark: 'point', encoding: { x: q('a'), y: n('b') } })
  add('a lookup', { data: DATA, transform: [{ lookup: 'c', from: { data: { values: [{ k: 'A', w: 1 }, { k: 'B', w: 2 }] }, key: 'k', fields: ['w'] } }], mark: 'point', encoding: { x: q('x'), y: q('w') } })
  add('a sample and a stack', { data: DATA, transform: [{ sample: 3 }, { stack: 'v', groupby: ['c'], as: ['s0', 's1'] }], mark: 'bar', encoding: { x: n('c'), y: q('s0'), y2: { field: 's1' } } })
  add('a density', { data: BOX, transform: [{ density: 'v', bandwidth: 0.5 }], mark: 'area', encoding: { x: q('value'), y: q('density') } })
  add('a regression and a loess', { data: DATA, layer: [{ transform: [{ regression: 'y', on: 'x', method: 'poly', order: 2 }], mark: 'line', encoding: { x: q('x'), y: q('y') } }, { transform: [{ loess: 'y', on: 'x', bandwidth: 0.5 }], mark: 'line', encoding: { x: q('x'), y: q('y') } }] })
  add('a quantile', { data: BOX, transform: [{ quantile: 'v', step: 0.1 }], mark: 'point', encoding: { x: q('prob'), y: q('value') } })
  add('a time unit transform', { data: DATA, transform: [{ timeUnit: 'yearmonth', field: 't', as: 'ym' }], mark: 'bar', encoding: { x: { field: 'ym', type: 'temporal' }, y: q('v') } })
  add('a utc time unit with a step', { data: DATA, mark: 'bar', encoding: { x: { field: 't', timeUnit: { unit: 'utcyear', step: 2 }, type: 'ordinal' }, y: q('v') } })
  add('a bin transform with a maxbins', { data: DATA, transform: [{ bin: { maxbins: 4 }, field: 'v', as: 'b' }], mark: 'bar', encoding: { x: { field: 'b', bin: 'binned', type: 'quantitative' }, x2: { field: 'b_end' }, y: { aggregate: 'count' } } })
  add('an encoded bin with a step and an extent', { data: DATA, mark: 'bar', encoding: { x: q('v', { bin: { step: 2, extent: [0, 10] } }), y: { aggregate: 'count' } } })
  add('a binned axis label', { data: DATA, mark: 'bar', encoding: { x: q('v', { bin: true, axis: { format: '.1f' } }), y: { aggregate: 'count' } } })
  add('a stacked normalized area', { data: DATA, mark: 'area', encoding: { x: q('x'), y: q('v', { aggregate: 'sum', stack: 'normalize' }), color: n('g') } })
  add('a centered stack', { data: DATA, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum', stack: 'center' }), color: n('g') } })
  add('an impute', { data: SPARSE, mark: 'line', encoding: { x: q('x'), y: q('v', { impute: { value: 0 } }), color: n('g') } })
  add('an impute with a method', { data: SPARSE, mark: 'line', encoding: { x: q('x'), y: q('v', { impute: { method: 'mean', frame: [-1, 1] } }), color: n('g') } })
  add('a text mark with a format', { data: DATA, mark: 'text', encoding: { x: q('x'), y: q('y'), text: q('v', { format: '.2f' }) } })
  add('a tooltip of every type', { data: DATA, mark: { type: 'point', tooltip: true }, encoding: { x: q('x', { aggregate: 'mean' }), y: q('y'), tooltip: [q('v'), t('t'), n('c'), { field: 't', timeUnit: 'month', type: 'ordinal' }] } })
  add('a condition on a predicate', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { test: 'datum.v > 4', value: 'red' }, value: 'gray' } } })
  add('a condition on a field predicate', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), size: { condition: { test: { field: 'v', range: [3, 6] }, value: 100 }, value: 10 } } })
  add('a selection condition and a filter', { data: DATA, params: [{ name: 'sel', select: { type: 'interval', encodings: ['x'] } }], mark: 'point', encoding: { x: q('x'), y: q('y'), color: { condition: { param: 'sel', field: 'c', type: 'nominal' }, value: 'grey' } } })
  add('a point selection projected over a field', { data: DATA, params: [{ name: 'pick', select: { type: 'point', fields: ['c'] } }], transform: [{ filter: { param: 'pick' } }], mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } })
  add('an expression parameter', { data: DATA, params: [{ name: 'thr', value: 3, bind: { input: 'range', min: 0, max: 8 } }], transform: [{ filter: 'datum.v > thr' }], mark: 'point', encoding: { x: q('x'), y: q('y') } })
  add('an expression in a mark property', { data: DATA, params: [{ name: 'sz', value: 50 }], mark: { type: 'point', size: { expr: 'sz * 2' } }, encoding: { x: q('x'), y: q('y') } })
  add('an axis label expression', { data: DATA, mark: 'point', encoding: { x: q('x', { axis: { labelExpr: 'datum.value * 10' } }), y: q('y') } })
  add('a legend with a label expression', { data: DATA, mark: 'point', encoding: { x: q('x'), y: q('y'), color: n('c', { legend: { labelExpr: 'upper(datum.label)' } }) } })
  add('a sort by a field', { data: DATA, mark: 'bar', encoding: { x: n('c', { sort: { field: 'v', op: 'sum', order: 'descending' } }), y: q('v', { aggregate: 'sum' }) } })
  add('a sort by an encoding', { data: DATA, mark: 'bar', encoding: { x: n('c', { sort: '-y' }), y: q('v', { aggregate: 'sum' }), color: n('g') } })
  add('a facet with a sort and a column count', { data: DATA, facet: { field: 'c', type: 'nominal', sort: { op: 'count', order: 'descending' } }, columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } })
  add('a repeat', { data: DATA, repeat: { row: ['x', 'y'], column: ['v', 'x'] }, spec: { mark: 'point', encoding: { x: { field: { repeat: 'column' }, type: 'quantitative' }, y: { field: { repeat: 'row' }, type: 'quantitative' } } } })
  add('a log scale with an exponent', { data: DATA, mark: 'point', encoding: { x: q('x', { scale: { type: 'pow', exponent: 0.5 } }), y: q('y', { scale: { type: 'log' } }) } })
  add('a domain from a data field and a param', { data: DATA, params: [{ name: 'lo', value: 1 }], mark: 'point', encoding: { x: q('x', { scale: { domainMin: { expr: 'lo' } } }), y: q('y') } })
  add('arc with a radius', { data: DATA, mark: { type: 'arc', innerRadius: 20 }, encoding: { theta: q('v', { aggregate: 'sum' }), color: n('c'), radius: q('v', { aggregate: 'sum', scale: { type: 'sqrt', zero: true, rangeMin: 20 } }) } })
  add('a rule with a datum and an aggregate', { data: DATA, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'rule', encoding: { y: q('y', { aggregate: 'mean' }) } }, { mark: 'rule', encoding: { x: { datum: 3 } } }] })
  add('a heatmap with a binned colour', { data: DATA, mark: 'rect', encoding: { x: q('x', { bin: true }), y: q('y', { bin: true }), color: { aggregate: 'count' } } })
  add('a layered chart with a shared encoding and a transform', { data: DATA, transform: [{ calculate: 'datum.v + 1', as: 'w' }], encoding: { x: n('c'), y: q('w', { aggregate: 'mean' }) }, layer: [{ mark: 'bar' }, { mark: 'text', encoding: { text: q('w', { aggregate: 'mean', format: '.1f' }) } }] })

  for (const [name, spec] of CASES) it(name, () => same(spec))
  // (a vega-lite spec that the comparison would miss is not worth having: every case above must give at least one expression)
  it('every case has expressions to compare', () => {
    for (const [name, spec] of CASES) {
      const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
      expect(expressionsOf(oracle, 'vega-lite').length, name).toBeGreaterThan(0)
    }
  })
})

// compile/data/source.ts: the format of a URL source names the file's type (Vega reads json when it is not told, so a csv would not load)
describe('@aster/vl == vega-lite: the format of a URL source', () => {
  const URLS = ['data/cars.json', 'data/stocks.csv', 'data/flights.tsv', 'data/world.topojson', 'data/points.dsv', 'data/noextension', 'data/x.csv?v=1', 'https://example.com/a/b.json']
  for (const url of URLS) {
    for (const format of [undefined, { parse: { n: 'number' } }, { type: 'tsv' }] as const) {
      it(`${url} ${JSON.stringify(format ?? null)}`, () => {
        const spec = { data: { url, ...(format ? { format } : {}) }, mark: 'point', encoding: { x: q('x'), y: q('y') } }
        const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, any> } }).compile(plain(spec)).spec
        const ours = compile(deepFreeze(plain(spec)) as never) as Record<string, any>
        const src = (vg: any): unknown => (vg.data as any[]).find((d) => d.url !== undefined)?.format
        expect(src(ours)).toEqual(src(oracle))
      })
    }
  }
})
