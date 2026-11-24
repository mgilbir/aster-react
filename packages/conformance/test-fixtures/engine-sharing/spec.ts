/** A stacked bar chart over inline rows: vega's `stack` writes y0 / y1 onto the rows it is given. */
export const stackedSpec = (): Record<string, unknown> => ({
  width: 100, height: 60, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ k: 'a', c: 'x', v: 1 }, { k: 'a', c: 'y', v: 2 }, { k: 'b', c: 'x', v: 3 }], transform: [{ type: 'stack', groupby: ['k'], field: 'v' }] }],
  scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' }, { name: 'y', type: 'linear', domain: [0, 6], range: 'height' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'k' }, width: { value: 10 }, y: { scale: 'y', field: 'y1' }, y2: { scale: 'y', field: 'y0' } } } }],
})
