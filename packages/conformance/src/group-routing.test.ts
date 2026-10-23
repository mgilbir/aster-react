/**
 * Group routing (audit C56): Aster used to send any group whose NAME contained "header" or
 * "footer" through its facet-header builders (a group called `page_header` threw, `page_footer`
 * rendered nothing), and crashed on `facet.groupby: 'g'` (vega reads groupby through
 * `array()`, like every transform's groupby). Groups route by the structural role vega's
 * ViewLayout uses; names mean nothing. Each case is judged against real vega.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

/**
 * Diffs between real vega and Aster for `spec`, minus the one known, separate gap: vega draws
 * every group's (unpainted) `background` path and Aster's nested-group renderer draws none
 * (a renderer matter, not routing). Exactly `groups` such paths may be missing, and they must be
 * rectangles with nothing painted; every other difference is returned.
 */
async function compare(spec: Spec, groups: number): Promise<string[]> {
  const diffs = diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))
  const background = (d: string): boolean => /^only-oracle: path\|M[-\d.]+,[-\d.]+(L[-\d.]+,[-\d.]+){3}Z\|fill=none\|\|$/.test(d)
  const known = diffs.filter(background)
  expect(known.length, 'missing group background paths').toBe(groups)
  return diffs.filter((d) => !background(d))
}

const DATA = [{ name: 't', values: [{ g: 'a', v: 10 }, { g: 'a', v: 20 }, { g: 'b', v: 30 }, { g: 'c', v: 40 }] }]
const FRAME = { width: 200, height: 100, padding: 5, autosize: 'none' }

const rectIn = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'v' }, y: { value: 3 }, width: { value: 6 }, height: { value: 9 }, fill: { value: 'tomato' }, ...extra } },
})

describe('groups route by role, not by name (C56)', () => {
  const NAMES = ['page_header', 'page_footer', 'header', 'footer', 'row_header', 'column_header', 'column_footer', 'my_header_row', 'footer_notes']
  it.each(NAMES)('a plain group named %s renders like vega', async (name) => {
    const spec = { ...FRAME, data: DATA, marks: [{ type: 'group', name, encode: { update: { x: { value: 12 }, y: { value: 8 }, width: { value: 150 }, height: { value: 60 } } }, marks: [rectIn()] }] }
    expect(await compare(spec, 1)).toEqual([])
    // and the marks inside are really there (a group that renders nothing agrees with nothing)
    expect(renderSpec(spec as never)).toContain('fill="tomato"')
  })

  it('a group named like a header but with a scoped child still renders its children', async () => {
    const spec = {
      ...FRAME, data: DATA,
      marks: [{
        type: 'group', name: 'page_header',
        scales: [{ name: 'lx', type: 'linear', domain: [0, 50], range: 'width' }],
        axes: [{ orient: 'bottom', scale: 'lx' }],
        encode: { update: { width: { value: 120 }, height: { value: 40 } } },
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'lx', field: 'v' }, y: { value: 2 }, width: { value: 4 }, height: { value: 4 }, fill: { value: 'teal' } } } }],
      }],
    }
    // A scoped group draws its own (separate, pre-existing) background; the routing claim is
    // that the child marks are drawn, at vega's positions.
    const tealPaths = (svg: string): string[] => [...svg.matchAll(/<path d="([^"]+)" fill="teal"\/>/g)].map((m) => m[1]!)
    const want = tealPaths(await oracleSvg(spec))
    expect(want.length).toBe(4)
    expect(tealPaths(renderSpec(spec as never))).toEqual(want)
  })
})

describe('facet groupby is read through array() (C56)', () => {
  const facetSpec = (groupby: unknown): Spec => ({
    ...FRAME, data: DATA,
    scales: [{ name: 'gx', type: 'band', domain: { data: 't', field: 'g' }, range: 'width', padding: 0.1 }],
    marks: [{
      type: 'group', from: { facet: { name: 'f', data: 't', groupby } },
      encode: { update: { x: { scale: 'gx', field: 'g' }, width: { scale: 'gx', band: 1 }, height: { value: 90 } } },
      marks: [{ type: 'rect', from: { data: 'f' }, encode: { update: { x: { value: 2 }, y: { field: 'v' }, width: { value: 8 }, height: { value: 5 }, fill: { value: 'steelblue' } } } }],
    }],
  })
  it('a string groupby renders like vega', async () => {
    expect(await compare(facetSpec('g'), 3)).toEqual([])
  })
  it('a string groupby equals the one-element array form (and both draw one group per key)', () => {
    const a = renderSpec(facetSpec('g') as never)
    const b = renderSpec(facetSpec(['g']) as never)
    expect(a).toBe(b)
    expect((a.match(/fill="steelblue"/g) ?? []).length).toBe(4)
  })
  it('the array form still renders like vega', async () => {
    expect(await compare(facetSpec(['g']), 3)).toEqual([])
  })
})
