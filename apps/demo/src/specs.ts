export const LineSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: { signal: 'width' },
  height: { signal: 'height' },
  padding: 5,
  data: { name: 'table', values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }, { x: 3, y: 25 }] },
  mark: 'line',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
  },
}

export const ParamBoundSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  params: [{ name: 'shift', value: 10, bind: { input: 'range', min: 0, max: 30 } }],
  data: { name: 'table', values: [{ x: 0, y: 2 }, { x: 1, y: 4 }, { x: 2, y: 3 }, { x: 3, y: 5 }] },
  transform: [{ calculate: 'datum.y + shift', as: 'y2' }],
  mark: 'line',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y2', type: 'quantitative' },
  },
}

export const InteractiveBrushSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  params: [{ name: 'brush', select: { type: 'interval' } }],
  data: { name: 'table', values: [{ x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 3 }, { x: 4, y: 5 }] },
  mark: 'point',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
  },
}

export const HistogramSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { v: 1 }, { v: 2 }, { v: 3 }, { v: 5 }, { v: 8 }, { v: 13 },
    { v: 4 }, { v: 6 }, { v: 9 }, { v: 11 }, { v: 7 }, { v: 12 },
  ] },
  mark: 'bar',
  encoding: {
    x: { bin: true, field: 'v', type: 'quantitative' },
    y: { aggregate: 'count', type: 'quantitative' },
  },
}

export const LegendScatterSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { x: 1, y: 2, cat: 'A' },
    { x: 2, y: 4, cat: 'B' },
    { x: 3, y: 3, cat: 'C' },
    { x: 4, y: 5, cat: 'A' },
  ] },
  mark: 'point',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
    color: { field: 'cat', type: 'nominal' },
  },
}
