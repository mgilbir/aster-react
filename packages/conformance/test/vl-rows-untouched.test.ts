// @vitest-environment node
/**
 * Rows are data, never spec: a row whose fields look like spec (`{repeat: ...}`, `{signal: ...}`, `{data: ...}`, `axes`,
 * `legends`, `scales`, a dataset's name) reaches the compiled spec exactly as written, as vega-lite hands it on. The compiler's
 * rewrites of the spec tree (repeat substitution, renames, aria, guides, the optimizer) do not reach into rows.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'

type Obj = Record<string, any>
const tricky = (): Obj[] => [
  {
    x: 1, y: 2, k: 'a',
    r: { repeat: 'repeat' }, rr: { repeat: 'row' },
    s: { signal: 'width' }, u: { update: 'width', name: 'n' },
    d: { data: 'source_0' }, dd: { data: 'data_0' },
    axes: [{ scale: 'x', orient: 'bottom', gridColor: { condition: { test: 'true', value: 'red' }, value: 'blue' } }],
    legends: [{ fill: 'color', title: '' }], scales: [{ name: 'x', type: 'linear', domain: { fields: [{ data: 'a', field: 'x' }, { data: 'a', field: 'x' }] } }],
    label: 'row_domain', scale: 'x', field: { group: 'width' },
  },
  { x: 2, y: 3, k: 'b', r: { repeat: 'repeat' }, s: { signal: 'height' }, label: 'column_domain' },
]

const xy = { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } }
const SHAPES: Record<string, (rows: Obj[]) => Obj> = {
  unit: (rows) => ({ data: { values: rows }, mark: 'point', encoding: xy }),
  'named view': (rows) => ({ name: 'chart', data: { values: rows }, mark: 'point', encoding: xy }),
  'aria off': (rows) => ({ config: { aria: false }, data: { values: rows }, mark: 'point', encoding: xy }),
  repeat: (rows) => ({ data: { values: rows }, repeat: ['x', 'y'], spec: { mark: 'point', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative' }, y: xy.y } } }),
  'repeat of a layer with rows inside': (rows) => ({ repeat: { layer: ['x', 'y'] }, spec: { data: { values: rows }, mark: 'line', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: { repeat: 'layer' }, type: 'quantitative' } } } }),
  hconcat: (rows) => ({ hconcat: [{ data: { values: rows }, mark: 'point', encoding: xy }, { data: { values: rows }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: xy.y } }] }),
  facet: (rows) => ({ data: { values: rows }, facet: { row: { field: 'k', type: 'nominal' } }, spec: { mark: 'point', encoding: xy } }),
  'layer with a legend': (rows) => ({ data: { values: rows }, layer: [{ mark: 'point', encoding: { ...xy, color: { field: 'k', type: 'nominal' } } }, { mark: 'line', encoding: { ...xy, size: { field: 'y', type: 'quantitative' } } }] }),
}

/** The rows of every inline dataset of a compiled spec, at any depth. */
function emitted(spec: Obj): Obj[][] {
  const out: Obj[][] = []
  const visit = (node: Obj): void => {
    for (const d of (node.data as Obj[] | undefined) ?? []) if (Array.isArray(d.values)) out.push(d.values)
    for (const m of (node.marks as Obj[] | undefined) ?? []) if (m.type === 'group') visit(m)
  }
  visit(spec)
  return out
}

describe('rows reach the compiled spec as written', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    it(name, () => {
      const spec = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', ...make(tricky()) }
      const oracle = (vl as any).compile(structuredClone(spec)).spec as Obj
      const ours = compile(spec as never) as Obj
      const want = emitted(oracle)
      expect(want.length).toBeGreaterThan(0)
      for (const rows of want) expect(rows).toEqual(tricky())
      const got = emitted(ours)
      expect(got.length).toBeGreaterThan(0)
      for (const rows of got) expect(rows).toEqual(tricky())
    })
  }
})
