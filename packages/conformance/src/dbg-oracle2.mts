import * as vega from 'vega'
import * as vl from 'vega-lite'
import { readFileSync } from 'node:fs'
const vlSpec = JSON.parse(readFileSync('/tmp/case-source.vl.json','utf8'))
const vg = (vl as any).compile(vlSpec).spec
const view = new (vega as any).View((vega as any).parse(vg), { renderer: 'none' })
await view.runAsync()
console.log('origin', view._origin, 'viewWH', view._viewWidth, view._viewHeight)
const root = (view as any).scenegraph().root
const walk = (g: any, d: number): void => {
  const b = g.bounds
  console.log('  '.repeat(d), `mt=${g.marktype ?? ''} role=${g.role ?? ''} name=${g.name ?? ''} x=${g.x} y=${g.y} w=${g.width ?? ''} h=${g.height ?? ''} b=[${b && [Math.round(b.x1*10)/10, Math.round(b.y1*10)/10, Math.round(b.x2*10)/10, Math.round(b.y2*10)/10]}] items=${g.items?.length ?? 0}`)
  if (d < 2) for (const c of g.items ?? []) walk(c, d + 1)
}
walk(root, 0)
view.finalize()
