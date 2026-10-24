// @vitest-environment node
/**
 * The axes @aster/vl emits must be vega-lite's: the same axes in the same order (every grid axis,
 * then the main axes, x before y), with the same orient, grid flag and zindex. Paint order in the
 * rendered scenegraph follows this order, so a lenient canonicalizer would never notice a
 * reordering; this compares the arrays themselves for every Vega-Lite corpus spec.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'

const ROOT = join(__dirname, '..')
const specs: Array<[string, Record<string, any>]> = []
for (const dir of ['corpus', 'corpus-vega-only']) {
  const d = join(ROOT, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d).filter((x) => x.endsWith('.vl.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(d, f), 'utf8'))
    specs.push([`${dir}/${f.replace('.vl.json', '')}`, doc.$schema ? doc : (doc.spec ?? doc)])
  }
}

/** Every axis in the tree with its group path; scale names are reduced to their channel (names differ for named views). */
function axesOf(vg: unknown): string[] {
  const out: string[] = []
  const walk = (o: any, path: string): void => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { for (const x of o) walk(x, path); return }
    if (Array.isArray(o.axes)) {
      for (const a of o.axes) out.push(`${path}|${/(?:^|_)([xy])$/.exec(String(a.scale))?.[1] ?? a.scale}|${a.orient}|grid=${a.grid === true}|zindex=${a.zindex}`)
    }
    for (const k of Object.keys(o)) if (k !== 'axes') walk(o[k], `${path}/${o.role ?? ''}`)
  }
  walk(vg, '')
  return out
}

describe('emitted axes match vega-lite (order, orient, grid, zindex)', () => {
  for (const [name, spec] of specs) {
    it(name, () => {
      const expected = axesOf((vl as any).compile(spec).spec)
      expect(axesOf(compile(spec as never))).toEqual(expected)
    })
  }
})
