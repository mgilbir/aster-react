import { loadSpecData } from '@aster/core/load'
import { renderWithVega } from './src/render-vega.ts'
const base: any = {
  width: 200, height: 120, padding: 5, background: 'white',
  title: { text: 'Quarterly totals', subtitle: 'by region' },
  data: [{ name: 't', values: [
    { c: 'alpha', v: 28, g: 'north' }, { c: 'beta', v: 55, g: 'south' },
    { c: 'gamma', v: 43, g: 'north' }, { c: 'delta', v: 91, g: 'east' }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
    { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  ],
  axes: [
    { orient: 'bottom', scale: 'x', title: 'category' },
    { orient: 'left', scale: 'y', title: 'amount', tickCount: 4 },
  ],
  legends: [{ fill: 'colour', title: 'region' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
    fill: { scale: 'colour', field: 'g' } } } }],
}
const variants: [string, any][] = [
  ['base', {}],
  ['tAnchor-m', { titleAnchor: 'middle' }], ['tAnchor-e', { titleAnchor: 'end' }],
  ['tAlign-c', { titleAlign: 'center' }], ['tAlign-r', { titleAlign: 'right' }],
  ['tOrient-l', { titleOrient: 'left' }], ['tOrient-r', { titleOrient: 'right' }], ['tOrient-b', { titleOrient: 'bottom' }],
  ['dir-h', { direction: 'horizontal' }], ['cols-2', { columns: 2 }],
  ['tO-l+a-s', { titleOrient: 'left', titleAnchor: 'start' }],
  ['tO-l+a-e', { titleOrient: 'left', titleAnchor: 'end' }],
  ['tO-r+a-s', { titleOrient: 'right', titleAnchor: 'start' }],
  ['tO-r+a-e', { titleOrient: 'right', titleAnchor: 'end' }],
  ['tO-b+a-s', { titleOrient: 'bottom', titleAnchor: 'start' }],
  ['tO-b+a-m', { titleOrient: 'bottom', titleAnchor: 'middle' }],
  ['tO-b+a-e', { titleOrient: 'bottom', titleAnchor: 'end' }],
  ['tO-t+a-m', { titleOrient: 'top', titleAnchor: 'middle' }],
  ['dir-h', { direction: 'horizontal' }],
  ['dir-h+cp0', { direction: 'horizontal', columnPadding: 0 }],
  ['dir-h+cp16', { direction: 'horizontal', columnPadding: 16 }],
  ['dir-h+cols1', { direction: 'horizontal', columns: 1 }],
  ['cols-2', { columns: 2 }],
  ['cols-2+cp0', { columns: 2, columnPadding: 0 }],
]
for (const [name, over] of variants) {
  const spec = JSON.parse(JSON.stringify(base))
  Object.assign(spec.legends[0], over)
  const svg = await renderWithVega(await loadSpecData(spec) as never)
  const i = svg.indexOf('mark-group role-legend')
  const root = /class="marks" width="(\d+)" height="(\d+)"/.exec(svg)?.slice(1).join('x')
  console.log('===', name, 'root', root)
  const seg = svg.slice(i, i + 2600)
  // legend outer translate, background, entry translates, title translate
  const outer = /role-legend"[^>]*>\s*<g transform="translate\(([-\d.]+),([-\d.]+)\)"/.exec(seg.slice(0, 200))
  console.log('  outer', outer ? `${outer[1]},${outer[2]}` : (seg.slice(0, 120).match(/transform="translate\(([-\d.]+),([-\d.]+)\)"/) ?? ['', '?', '?']).slice(1).join(','))
  const bg = /class="background"[^>]*d="M0,0h(\d+)v(\d+)/.exec(seg)
  console.log('  bg', bg ? `${bg[1]}x${bg[2]}` : '?')
  const entryT = [...seg.matchAll(/role-legend-entry">\s*<g transform="translate\(([-\d.]+),([-\d.]+)\)"/g)].map(m => `${m[1]},${m[2]}`)
  console.log('  entries', entryT.join(' | '))
  const ti = seg.indexOf('role-legend-title')
  const tseg = ti >= 0 ? seg.slice(ti, ti + 400) : ''
  const tm = /transform="translate\(([-\d.]+),([-\d.]+)\)[^"]*"/.exec(tseg)
  const tt = />([^<]*)</.exec(tseg.slice(200))
  console.log('  title', tm ? `${tm[1]},${tm[2]}` : '?', tseg.includes('rotate') ? 'ROT ' + /rotate\([^)]*\)[^"]*/.exec(tseg)?.[0] : '', tt ? tt[1] : '')
  const scopes = [...seg.matchAll(/role-scope[^>]*>\s*<g transform="translate\(([-\d.]+),([-\d.]+)\)"/g)].map(m => `${m[1]},${m[2]}`)
  const entryBgs = [...seg.matchAll(/opacity="1"\/>\s*<\/g>/g)]
  const swatches = [...seg.matchAll(/<path class="background"[^>]*d="M0,0h(\d+)v(\d+)/g)].map(m => `${m[1]}x${m[2]}`)
  console.log('  scopeT', scopes.join(' | '), 'bgDims', swatches.join(' | '))
}
