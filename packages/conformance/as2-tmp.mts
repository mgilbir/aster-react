import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
const spec: any = {
  width: 100, height: 100,
  signals: [{ name: 'sel', update: 'vlSelectionResolve("sel_store", "union")' }],
  data: [
    { name: 'sel_store', transform: [{ type: 'collect' }] },
    { name: 'src', values: [{ t: 1 }, { t: 5 }, { t: 9 }], transform: [
      { type: 'extent', field: 't', signal: 'ext' },
      { type: 'bin', field: 't', as: ['b0', 'b1'], signal: 'bins', extent: { signal: 'ext' }, span: { signal: 'span(sel["t"])' }, maxbins: 4 },
    ] },
  ],
  marks: [{ type: 'rect', from: { data: 'src' }, encode: { update: { x: { value: 0 }, width: { value: 5 }, y: { field: 'b0' }, height: { value: 5 } } } }],
}
console.log(renderSpec(spec).length)
process.exit(0)
