import * as React from 'react'
import '@aster-charts/react/vl'
import '@aster-charts/core/geo'
import { compile } from '@aster-charts/vl'
import { Chart } from '@aster-charts/react'
import linkedBrush from '../../../packages/conformance/corpus/vlx-sel-mv-concat-linked-brush.vl.json'
import legendPoint from '../../../packages/conformance/corpus/vlx-sel-point-legend.vl.json'
import bindRadio from '../../../packages/conformance/corpus/vlx-sel-point-bind-radio.vl.json'
import facetBrush from '../../../packages/conformance/corpus/vlx-sel-mv-facet-brush.vl.json'
import choropleth from '../../../packages/conformance/corpus/vlx-geo-choropleth-geojson.vl.json'
import shapesAndPoints from '../../../packages/conformance/corpus/vlx-geo-layered-geoshape-points.vl.json'
import animScatter from '../../../packages/conformance/corpus/vlx-anim-scatter.vl.json'
import quantizeLegend from '../../../packages/conformance/corpus/color-quantize-scheme-legend.vl.json'
import thresholdScale from '../../../packages/conformance/corpus/bar-threshold-scale.vg.json'
import scaleTypes from '../../../packages/conformance/corpus/new-scale-types.vl.json'
import fillStroke from '../../../packages/conformance/corpus/new-fill-stroke.vl.json'
import radial from '../../../packages/conformance/corpus/new-radial.vl.json'
import descendingSort from '../../../packages/conformance/corpus/new-descending-sort.vl.json'
import datumChannels from '../../../packages/conformance/corpus/new-datum-channels.vl.json'

/**
 * Specs from the conformance corpus (packages/conformance/corpus, imported from there: no copy to drift), each one checked against
 * real vega / vega-lite by the gates (the 14 are held in the corpus by packages/conformance/src/showcase-corpus.test.ts). Vega-Lite specs go to <Chart> as they are (`@aster-charts/react/vl` compiles them, as an app would); the size is
 * the compiled spec's, as in the selections gate.
 */
type Spec = Record<string, unknown>

function sizeOf(spec: Spec): { width?: number; height?: number } {
  const vg = (String(spec.$schema ?? '').includes('vega-lite') ? compile(spec as never) : spec) as Spec
  // (a size is passed only where the compiled spec has a number: a concat or facet view is sized by its content, and a prop of 0 is no size)
  return { ...(typeof vg.width === 'number' ? { width: vg.width } : {}), ...(typeof vg.height === 'number' ? { height: vg.height } : {}) }
}

function AsterPane({ spec, label }: { spec: Spec; label: string }) {
  const size = React.useMemo(() => sizeOf(spec), [spec])
  return (
    <React.Suspense fallback={<div className="vega-loading" aria-busy="true">loading aster…</div>}>
      <Chart spec={spec as never} ariaLabel={label} {...size} />
    </React.Suspense>
  )
}

export const SHOWCASE: Array<{ title: string; desc: string; raw: Spec; aster: React.ReactNode; wide?: string }> = [
  { title: 'Linked brushing across views', desc: 'Drag an interval on the left scatter: the bar chart on the right is filtered by the brush (an hconcat, one selection shared across views).', raw: linkedBrush, aster: <AsterPane spec={linkedBrush} label="Linked brushing" />, wide: 'wide' },
  { title: 'Legend-bound selection', desc: 'Click a legend entry to highlight its category; shift-click adds to the selection, double-click clears it.', raw: legendPoint, aster: <AsterPane spec={legendPoint} label="Legend-bound point selection" /> },
  { title: 'Selection bound to inputs', desc: 'A point selection bound to radio buttons: the inputs and the chart drive each other.', raw: bindRadio, aster: <AsterPane spec={bindRadio} label="Radio-bound selection" /> },
  { title: 'A brush per facet cell', desc: 'Each facet cell has its own brush scope (group-scoped signals).', raw: facetBrush, aster: <AsterPane spec={facetBrush} label="Facet brush" />, wide: 'wide' },
  { title: 'Choropleth (GeoJSON)', desc: 'geoshape marks with a fitted projection, coloured by a quantitative field.', raw: choropleth, aster: <AsterPane spec={choropleth} label="Choropleth" /> },
  { title: 'Shapes and points on a map', desc: 'A geoshape layer with longitude/latitude points on the same projection.', raw: shapesAndPoints, aster: <AsterPane spec={shapesAndPoints} label="Shapes and points" /> },
  { title: 'Animated scatter (time channel)', desc: 'The `time` encoding with a timer-driven point selection steps through the years.', raw: animScatter, aster: <AsterPane spec={animScatter} label="Animated scatter" /> },
  { title: 'Quantize legend', desc: 'A quantize colour scale: the legend labels its bins at the breakpoints, as vega-encode does.', raw: quantizeLegend, aster: <AsterPane spec={quantizeLegend} label="Quantize legend" /> },
  { title: 'Threshold scale (raw Vega)', desc: 'A threshold scale and its discrete legend in a raw Vega spec.', raw: thresholdScale, aster: <AsterPane spec={thresholdScale} label="Threshold scale" /> },
]

/**
 * This build: one spec for each change a reader can see, each in the conformance corpus, so each is compared with vega-lite and vega
 * (compiled scales, axes and legends, the scales as they run, the rows and the SVG) by `pnpm conformance-vl` and the gates after it.
 */
export const NEW_SHOWCASE: Array<{ title: string; desc: string; raw: Spec; aster: React.ReactNode; wide?: string }> = [
  { title: 'Every scale type vega-lite honours', desc: 'Size by an ordinal scale and shape by a quantile scale: each channel takes the scale types vega-lite gives it.', raw: scaleTypes, aster: <AsterPane spec={scaleTypes} label="Ordinal size and quantile shape" /> },
  { title: 'fill and stroke as channels', desc: 'A stroked point mark with fill and stroke on fields of their own: two scales and two legends.', raw: fillStroke, aster: <AsterPane spec={fillStroke} label="fill and stroke channels" /> },
  { title: 'A radial chart', desc: 'Angle and radius both from fields, the radius on a square-root scale, with the values as labels.', raw: radial, aster: <AsterPane spec={radial} label="Radial chart" /> },
  { title: 'Descending sorts', desc: 'A descending sort orders a discrete channel by its domain, on the axis and in the legend alike.', raw: descendingSort, aster: <AsterPane spec={descendingSort} label="Descending sort" /> },
  { title: 'A datum on any channel', desc: 'A threshold rule and its label at a constant y, layered over the bars.', raw: datumChannels, aster: <AsterPane spec={datumChannels} label="Datum on channels" /> },
]
