import * as React from 'react'
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 300,
  height: 200,
  data: [{ name: 'table', values: [{ v: 1 }, { v: 2 }, { v: 3 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 'table', field: 'v' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'table', field: 'v' }, range: 'height' },
  ],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { enter: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'v' } } } }],
}

export function Static(): React.ReactElement {
  // Renders, pans/zooms, brushes an interval (`onSelect`, `brush`), binds inputs, builds the accessible tree.
  return <SvgChart spec={spec} panZoom onSelect={(interval) => { console.log(interval) }} />
}

export function Interactive(): React.ReactElement {
  // Tooltips, point selection and the spec's `signal.on` event streams need the capability, passed as a prop.
  return <SvgChart spec={spec} interaction={interaction} tooltip onPointSelect={(datum) => { console.log(datum) }} />
}
