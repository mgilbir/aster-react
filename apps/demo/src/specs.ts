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

export const PieSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200,
  height: 200,
  padding: 5,
  data: { name: 'table', values: [
    { cat: 'Alpha', value: 4 },
    { cat: 'Beta', value: 6 },
    { cat: 'Gamma', value: 3 },
    { cat: 'Delta', value: 7 },
  ] },
  mark: { type: 'arc', innerRadius: 50 },
  encoding: {
    theta: { field: 'value', type: 'quantitative' },
    color: { field: 'cat', type: 'nominal' },
  },
}

export const TextLabelSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { x: 1, y: 2, label: 'Start' },
    { x: 2, y: 4, label: 'Middle' },
    { x: 3, y: 3, label: 'Peak' },
    { x: 4, y: 5, label: 'End' },
  ] },
  mark: 'text',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
    text: { field: 'label', type: 'nominal' },
  },
}

export const HeatmapSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 300,
  height: 200,
  padding: 5,
  data: { name: 'table', values: [
    { row: 'A', col: 'X', val: 1 }, { row: 'A', col: 'Y', val: 3 }, { row: 'A', col: 'Z', val: 2 },
    { row: 'B', col: 'X', val: 4 }, { row: 'B', col: 'Y', val: 2 }, { row: 'B', col: 'Z', val: 5 },
  ] },
  mark: 'rect',
  encoding: {
    x: { field: 'col', type: 'nominal' },
    y: { field: 'row', type: 'nominal' },
    color: { field: 'val', type: 'quantitative' },
  },
}

export const StackedBarSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { cat: 'A', group: 'X', val: 3 }, { cat: 'A', group: 'Y', val: 5 },
    { cat: 'B', group: 'X', val: 4 }, { cat: 'B', group: 'Y', val: 2 },
  ] },
  mark: 'bar',
  encoding: {
    x: { field: 'cat', type: 'nominal' },
    y: { field: 'val', type: 'quantitative' },
    color: { field: 'group', type: 'nominal' },
  },
}

export const LayerSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 3 }, { x: 4, y: 5 },
  ] },
  layer: [
    { mark: 'area', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } },
    { mark: 'line', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } },
  ],
}

export const DonutSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200,
  height: 200,
  padding: 5,
  data: { name: 'table', values: [
    { cat: 'Alpha', value: 4 }, { cat: 'Beta', value: 6 },
    { cat: 'Gamma', value: 3 }, { cat: 'Delta', value: 7 },
  ] },
  mark: { type: 'arc', innerRadius: 60 },
  encoding: {
    theta: { field: 'value', type: 'quantitative' },
    color: { field: 'cat', type: 'nominal' },
  },
}

export const RegressionSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { x: 1, y: 2.1 }, { x: 2, y: 3.9 }, { x: 3, y: 6.2 },
    { x: 4, y: 7.8 }, { x: 5, y: 10.1 }, { x: 6, y: 12.2 },
  ] },
  layer: [
    { mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } },
    { mark: 'line', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y2', type: 'quantitative' } },
      transform: [{ regression: 'y', on: 'x', as: 'y2' }] },
  ],
}

export const StreamgraphSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  data: { name: 'table', values: [
    { date: '2024-01', cat: 'A', val: 3 }, { date: '2024-01', cat: 'B', val: 5 },
    { date: '2024-02', cat: 'A', val: 4 }, { date: '2024-02', cat: 'B', val: 2 },
    { date: '2024-03', cat: 'A', val: 2 }, { date: '2024-03', cat: 'B', val: 6 },
  ] },
  mark: 'area',
  encoding: {
    x: { field: 'date', type: 'temporal' },
    y: { field: 'val', type: 'quantitative', stack: 'center' },
    color: { field: 'cat', type: 'nominal' },
  },
}

export const BubbleSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400, height: 300, padding: 5,
  data: { name: 'table', values: [
    { x: 1, y: 2, size: 100 }, { x: 2, y: 4, size: 300 },
    { x: 3, y: 3, size: 200 }, { x: 4, y: 5, size: 400 }
  ]},
  mark: 'point',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
    size: { field: 'size', type: 'quantitative' }
  }
}

export const CandlestickSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400, height: 300, padding: 5,
  data: { name: 'table', values: [
    { date: '2024-01-01', open: 3, close: 5, low: 2, high: 6 },
    { date: '2024-01-02', open: 5, close: 4, low: 3, high: 7 },
    { date: '2024-01-03', open: 4, close: 6, low: 3, high: 8 }
  ]},
  layer: [
    { mark: 'rule', encoding: {
        x: { field: 'date', type: 'temporal' },
        y: { field: 'low', type: 'quantitative' },
        y2: { field: 'high', type: 'quantitative' }
      }
    },
    { mark: 'bar', encoding: {
        x: { field: 'date', type: 'temporal' },
        y: { field: 'open', type: 'quantitative' },
        y2: { field: 'close', type: 'quantitative' },
        color: { condition: { test: 'datum.open < datum.close', value: '#2ca02c' }, value: '#d62728' }
      }
    }
  ]
}

export const ColorSchemeSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400, height: 300, padding: 5,
  data: { name: 'table', values: [
    { x: 1, y: 2, cat: 'A' }, { x: 2, y: 4, cat: 'B' }, { x: 3, y: 3, cat: 'C' }
  ]},
  mark: 'point',
  encoding: {
    x: { field: 'x', type: 'quantitative' },
    y: { field: 'y', type: 'quantitative' },
    color: { field: 'cat', type: 'nominal', scale: { range: ['#1f77b4', '#ff7f0e', '#2ca02c'] } }
  }
}

export const GroupedBarSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 400, height: 300, padding: 5,
  data: { name: 'table', values: [
    { cat: 'A', group: 'X', val: 3 }, { cat: 'A', group: 'Y', val: 5 },
    { cat: 'B', group: 'X', val: 4 }, { cat: 'B', group: 'Y', val: 2 }
  ]},
  mark: 'bar',
  encoding: {
    x: { field: 'cat', type: 'nominal' },
    y: { field: 'val', type: 'quantitative' },
    color: { field: 'group', type: 'nominal' },
    xOffset: { field: 'group', type: 'nominal' }
  }
}

export const RadarSpec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 200, padding: 5,
  data: [{ name: 'table', values: [
    { axis: 'A', value: 3 }, { axis: 'B', value: 5 },
    { axis: 'C', value: 4 }, { axis: 'D', value: 2 }, { axis: 'E', value: 5 }
  ]}],
  scales: [
    { name: 'r', type: 'linear', domain: { data: 'table', field: 'value' }, range: [0, 80], zero: true },
    { name: 'theta', type: 'point', domain: { data: 'table', field: 'axis', sort: true }, range: [0, 6.283185307179586] }
  ],
  marks: [{
    type: 'group',
    marks: [
      { type: 'line', from: { data: 'table' }, encode: {
        update: {
          x: { signal: "100 + scale('r',datum.value) * cos(scale('theta',datum.axis))" },
          y: { signal: "100 + scale('r',datum.value) * sin(scale('theta',datum.axis))" },
          stroke: { value: 'steelblue' }, strokeWidth: { value: 2 }, fill: { value: 'steelblue' }, fillOpacity: { value: 0.3 }
        }
      }},
      { type: 'rule', from: { data: 'table' }, encode: {
        update: {
          x: { value: 100 }, y: { value: 100 },
          x2: { signal: "100 + scale('r',datum.value) * cos(scale('theta',datum.axis))" },
          y2: { signal: "100 + scale('r',datum.value) * sin(scale('theta',datum.axis))" },
          stroke: { value: '#ccc' }, strokeWidth: { value: 1 }
        }
      }},
      { type: 'text', from: { data: 'table' }, encode: {
        update: {
          x: { signal: "100 + (90) * cos(scale('theta',datum.axis))" },
          y: { signal: "100 + (90) * sin(scale('theta',datum.axis))" },
          text: { field: 'axis' }, align: { value: 'center' }, baseline: { value: 'middle' },
          fill: { value: '#333' }, fontSize: { value: 12 }
        }
      }},
      { type: 'symbol', from: { data: 'table' }, encode: {
        update: {
          x: { signal: "100 + scale('r',datum.value) * cos(scale('theta',datum.axis))" },
          y: { signal: "100 + scale('r',datum.value) * sin(scale('theta',datum.axis))" },
          fill: { value: 'steelblue' }, size: { value: 40 }
        }
      }}
    ]
  }]
}
