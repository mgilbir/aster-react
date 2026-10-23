/**
 * Group marks as vega scopes (audit C51, C56, C58): the structure the runtime builds. The pixels are
 * compared against real vega in packages/conformance (guides-layout-vs-vega.test.ts); these tests pin
 * what a core-only run can see: scene shape, limits, and the cases that must not throw.
 */
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSpec, AsterLimitError } from './index.js'
import type { SceneGroup, VgSpec } from './types.js'

const rows = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ g: `g${i}`, v: i }))
const walk = (n: SceneGroup, f: (g: SceneGroup) => void): void => { f(n); for (const c of n.items ?? []) if ((c as SceneGroup).items) walk(c as SceneGroup, f) }

describe('group items', () => {
  const spec = (extra: Record<string, unknown> = {}): VgSpec => ({
    width: 200, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', values: rows(5) }],
    marks: [{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'g' } }, encode: { update: { width: { value: 30 }, height: { value: 20 } } }, marks: [{ type: 'rect', from: { data: 'f' }, encode: { update: { width: { value: 5 }, height: { value: 5 } } } }] }],
    layout: { columns: 2, padding: 5, bounds: 'full', align: 'each' },
    ...extra,
  } as unknown as VgSpec)

  it('a facet groupby may be a bare string (no crash) and yields one scope group per partition', () => {
    const scene = evaluateChart(compileChart(spec()))
    const groups = scene.items.filter((g) => g.role === 'scope')
    expect(groups).toHaveLength(5)
    // the grid placed them: two columns
    expect(new Set(groups.map((g) => g.x)).size).toBe(2)
  })

  it('any group name or role is a plain group (no routing on name substrings, C56)', () => {
    for (const name of ['page_header', 'page_footer', 'my-title', 'row_header_x']) {
      const s = spec()
      ;(s as unknown as { marks: Array<Record<string, unknown>> }).marks[0]!.name = name
      expect(() => renderSpec(s)).not.toThrow()
      expect(evaluateChart(compileChart(s)).items.filter((g) => g.name === name)).toHaveLength(5)
    }
  })

  it('a group with no marks and no guides still draws its background', () => {
    const s = { width: 50, height: 50, marks: [{ type: 'group', encode: { update: { width: { value: 20 }, height: { value: 10 }, stroke: { value: '#000' } } } }] } as unknown as VgSpec
    const scene = evaluateChart(compileChart(s))
    const g = scene.items[0]!
    expect(g.width).toBe(20)
    expect((g.items![0] as unknown as { path: string }).path).toBe('M0.5,0.5h20v10h-20Z')
  })

  it('a layout the grid cannot take is dropped (vega logs the error and renders the cells unlaid-out)', () => {
    expect(() => renderSpec(spec({ layout: { columns: 2.5, padding: 5 } }))).not.toThrow()
  })

  it('a group-level layout the grid cannot take is dropped too (the sweep sets columns on a group)', () => {
    const s: Record<string, unknown> = {
      width: 100, height: 100, data: [{ name: 't', values: rows(4) }],
      marks: [{ type: 'group', layout: { columns: -4, padding: 5 }, marks: [
        { type: 'group', encode: { update: { width: { value: 10 }, height: { value: 10 } } } },
        { type: 'group', encode: { update: { width: { value: 10 }, height: { value: 10 } } } },
      ] }],
    }
    expect(() => renderSpec(s as unknown as VgSpec)).not.toThrow()
    ;(s.marks as Array<Record<string, unknown>>)[0]!.layout = { columns: 0.5, padding: 5 }
    expect(() => renderSpec(s as unknown as VgSpec)).not.toThrow()
  })

  it('group items count against maxItems, and the clock runs inside the group loop', () => {
    const big = { width: 100, height: 100, data: [{ name: 't', values: rows(3000) }], marks: [{ type: 'group', from: { data: 't' }, encode: { update: { width: { value: 5 }, height: { value: 5 } } } }] } as unknown as VgSpec
    expect(() => renderSpec(big, { limits: { maxItems: 1000 } })).toThrow(/group items/)
    expect(() => renderSpec(big, { limits: { maxItems: 1000 } })).toThrow(AsterLimitError)
    expect(() => renderSpec(big, { limits: { maxItems: 100000 } })).not.toThrow()
  })

  it('the scene marks a mark with an href so only that mark pays for link lookups', () => {
    const s = { width: 50, height: 50, data: [{ name: 't', values: [{ h: 'x' }] }], marks: [
      { type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 1 }, href: { field: 'h' } } } },
      { type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 2 }, y: { value: 2 } } } },
    ] } as unknown as VgSpec
    const marks = evaluateChart(compileChart(s)).items.filter((g) => g.role === 'mark')
    expect(marks.map((m) => m.hasLinks === true)).toEqual([true, false])
  })

  it('nested scopes are fully formed: own scales snapshot, the facet partition, and every guide kind', () => {
    const s = {
      width: 200, height: 120, padding: 5, autosize: 'none', data: [{ name: 't', values: rows(3).map((r) => ({ ...r, k: 'a' })) }],
      marks: [{
        type: 'group', encode: { update: { width: { value: 80 }, height: { value: 60 } } },
        scales: [{ name: 'c', type: 'ordinal', domain: ['x', 'y'], range: ['red', 'blue'] }, { name: 'q', type: 'linear', domain: [0, 1], range: [60, 0] }],
        axes: [{ scale: 'q', orient: 'left' }], legends: [{ fill: 'c' }], title: { text: 'T' }, marks: [],
      }],
    } as unknown as VgSpec
    const scene = evaluateChart(compileChart(s))
    const roles: string[] = []
    walk(scene as unknown as SceneGroup, (g) => { if (g.role) roles.push(g.role) })
    expect(roles).toEqual(expect.arrayContaining(['scope', 'axis', 'legend', 'title']))
    expect((scene.items[0] as SceneGroup).__scales?.map((x) => x.name).sort()).toEqual(['c', 'q'])
  })
})
