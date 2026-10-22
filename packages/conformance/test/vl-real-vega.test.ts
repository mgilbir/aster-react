// @vitest-environment node
/**
 * @aster/vl output through REAL vega (audit C39/T4). Aster's own runtime is lenient, so the
 * Vega that @aster/vl emits is checked where the semantics are defined: for every
 * Vega-Lite spec, real vega must (1) raise no error/warning beyond what vega-lite's own
 * output raises and (2) render our Vega to the same canonical SVG as vega-lite's.
 *
 * This runs under `pnpm test`, so a broken VL compile fails PRs even where `conformance-vl`
 * is not wired into CI. It also covers shapes Aster's runtime cannot render (rounded
 * stacked bars, wrapped facets, ...), which have no place in the Aster-vs-reference corpus.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

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

const DATA = {
  name: 'table',
  values: [
    { c: 'A', g: 'p', x: 1, y: 2, v: 5 },
    { c: 'B', g: 'q', x: 2, y: 4, v: 9 },
    { c: 'A', g: 'q', x: 3, y: 3, v: 2 },
    { c: 'C', g: 'p', x: 4, y: 6, v: 7 },
    { c: 'B', g: 'p', x: 5, y: 5, v: 4 },
    { c: 'C', g: 'q', x: 6, y: 8, v: 6 },
  ],
}
const stackedBar = (mark: Record<string, unknown>, enc: Record<string, unknown>) => ({ width: 300, height: 200, autosize: 'none', data: DATA, mark: { type: 'bar', ...mark }, encoding: enc })
/** Shapes Aster's runtime cannot render from vega-lite's own output, so they live here rather than in the corpus. */
const EXTRA: Array<[string, Record<string, any>]> = [
  ['rounded stacked bars', stackedBar({ cornerRadius: 8 }, { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } })],
  ['rounded stacked bars with colour', stackedBar({ cornerRadiusTopLeft: 10, cornerRadiusTopRight: 4 }, { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'g', type: 'nominal' } })],
  ['rounded stacked bars, horizontal, cornerRadiusEnd', stackedBar({ cornerRadiusEnd: 8 }, { y: { field: 'c', type: 'nominal' }, x: { field: 'v', type: 'quantitative' }, color: { field: 'g', type: 'nominal' } })],
  ['rounded stacked bars in a layer', { width: 300, height: 200, autosize: 'none', data: DATA, layer: [{ mark: { type: 'bar', cornerRadiusEnd: 5 }, encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'g', type: 'nominal' } } }, { mark: { type: 'rule', color: 'black' }, encoding: { y: { datum: 10 } } }] }],
  ['sort array on a colour legend', { width: 300, height: 200, autosize: 'none', data: DATA, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color: { field: 'c', type: 'nominal', sort: ['C', 'A', 'B'] } } }],
  ['wrapped facet over layers', { autosize: 'none', data: DATA, facet: { field: 'g', type: 'nominal' }, columns: 2, spec: { width: 100, height: 80, layer: [{ mark: 'line', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } }, { mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } }] } }],
  ['hconcat of a facet and a repeat', { autosize: 'none', data: DATA, hconcat: [{ facet: { column: { field: 'g', type: 'nominal' } }, spec: { width: 80, height: 80, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } } }, { repeat: ['y', 'v'], spec: { width: 80, height: 80, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }] }],
]

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}

async function check(spec: Record<string, any>): Promise<void> {
  const oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(spec).spec
  const ours = compile(deepFreeze(JSON.parse(JSON.stringify(spec))) as never) as Record<string, unknown>
  const [ref, mine, refChecked] = await Promise.all([
    renderWithVega(oracle),
    renderWithVegaChecked(JSON.parse(JSON.stringify(ours))),
    renderWithVegaChecked(oracle),
  ])
  const inherited = new Set([...refChecked.errors, ...refChecked.warnings])
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m))).toEqual([])
  const diffs = diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine.svg))
  expect(diffs.slice(0, 2)).toEqual([])
}

describe('@aster/vl output renders identically to vega-lite in real vega', () => {
  it('found the corpus', () => {
    expect(specs.length).toBeGreaterThan(150)
  })
  for (const [name, spec] of specs) {
    it(name, async () => {
      await check(spec)
    }, 30_000)
  }
  for (const [name, spec] of EXTRA) {
    it(`[real vega only] ${name}`, async () => {
      await check(spec)
    }, 30_000)
  }
})
