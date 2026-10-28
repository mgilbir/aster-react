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
