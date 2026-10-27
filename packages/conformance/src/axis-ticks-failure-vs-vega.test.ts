// @vitest-environment jsdom
/**
 * An axis whose ticks cannot be made (an interval string on a non-time scale), against real Vega.
 *
 * vega's AxisTicks throws; the dataflow logs it and aborts the pass, so every operator ranked after it never runs. What is
 * on the page then is decided by the ranks: a scale that has a forward reference in its own scope (a domain over data
 * declared in that scope, an expression, a signal that reads data or a later signal) is moved to the end of its scope's
 * operators, so the axis's tick marks are never made while the rest of the axis is (a scenegraph with holes, which vega's
 * own SVG serializer cannot walk), or the axis is made from half-encoded items. Any other scale leaves a clean cut: the
 * axes before the failing one, in raw (unlaid-out) positions, and nothing that follows it in its scope -- not the marks,
 * the legends, the title, and nothing of the groups that vega builds after it (nested scopes are built level by level).
 *
 * Every case is a raw Vega spec through vega.View and through Aster. A document must match the strict canonicalizer; a
 * case vega cannot serialize must be refused by Aster too.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>
type Outcome = { svg: string } | { threw: string }

async function oracle(spec: Spec): Promise<Outcome> {
  const log = console.error
  console.error = () => {}
  try {
    const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(spec as never), { renderer: 'none' })
    try {
      await view.runAsync()
      return { svg: await view.toSVG() }
    } catch (e) {
      return { threw: (e as Error).message }
    } finally {
      view.finalize()
    }
  } finally {
    console.error = log
  }
}
function aster(spec: Spec): Outcome {
  const log = console.error
  console.error = () => {}
  try {
    return { svg: renderSpec(spec as never) }
  } catch (e) {
    return { threw: (e as Error).message }
  } finally {
    console.error = log
  }
}

const ROWS = [{ k: 'a', v: 3 }, { k: 'b', v: 8 }, { k: 'c', v: 5 }]
const bad = { orient: 'bottom', scale: 'x', tickCount: 'week', title: 'Bad' }
const left = { orient: 'left', scale: 'y', title: 'Left' }
const right = { orient: 'right', scale: 'y' }
const top = { orient: 'top', scale: 'y2', domain: false }
const box = (extra: Spec = {}): Spec => ({ type: 'group', encode: { update: { width: { value: 60 }, height: { value: 50 }, stroke: { value: '#999' } } }, ...extra })
const rect = { type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'y', field: 'v' }, y: { value: 2 }, width: { value: 5 }, height: { value: 5 } } } }

/** the scale `x` (the failing axis's) in each way a scale can be defined */
const xScale: Record<string, { scale: Spec; signals?: Spec[]; data?: Spec[]; needsData?: boolean }> = {
  literal: { scale: { name: 'x', type: 'linear', domain: [0, 10], range: 'width' } },
  'data in its own scope': { scale: { name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }, needsData: true },
  'fields over its own scope data': { scale: { name: 'x', type: 'linear', domain: { fields: [{ data: 't', field: 'v' }, [1, 2]] }, range: 'width' }, needsData: true },
  'a signal that is a signal': { scale: { name: 'x', type: 'linear', domain: { signal: 'dom' }, range: 'width' }, signals: [{ name: 'dom', value: [0, 4] }] },
  'an expression': { scale: { name: 'x', type: 'linear', domain: [0, { signal: 'hi * 2' }], range: 'width' }, signals: [{ name: 'hi', value: 4 }] },
  'a signal reading data': { scale: { name: 'x', type: 'linear', domain: { signal: 'span' }, range: 'width' }, signals: [{ name: 'span', update: '[0, length(data("t"))]' }], needsData: true },
  'a signal reading a later signal': { scale: { name: 'x', type: 'linear', domain: { signal: 'a1' }, range: 'width' }, signals: [{ name: 'a1', update: '[0, b1]' }, { name: 'b1', value: 7 }] },
  'a range signal': { scale: { name: 'x', type: 'linear', domain: [0, 10], range: [0, { signal: 'width / 2' }] } },
  'a band scale over data': { scale: { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width' }, needsData: true },
}
const y = { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }
const y2 = { name: 'y2', type: 'linear', domain: [0, 10], range: 'width' }
const tData = { name: 't', values: ROWS }

interface Case { name: string; spec: Spec }
const placements = ['the view', 'a group', 'a group with the data outside', 'a group inside a group'] as const
const orders: Record<string, Spec[]> = {
  'bad between two axes': [left, bad, right],
  'bad first': [bad, left],
  'bad last': [left, top, bad],
}
const rest: Record<string, (scope: Spec) => Spec> = {
  'with marks, a legend and a title': (s) => ({ ...s, marks: [...((s.marks as Spec[]) ?? []), rect], legends: [{ fill: 'c', title: 'Legend' }], title: 'Title' }),
  'with nothing after': (s) => s,
}

function cases(): Case[] {
  const out: Case[] = []
  for (const [xn, x] of Object.entries(xScale)) {
    for (const placement of placements) {
      for (const [on, axes] of Object.entries(orders)) {
        for (const [rn, tail] of Object.entries(rest)) {
          const scales = [x.scale, y, y2, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['#c00', '#0a0'] }]
          const signals = x.signals ?? []
          const scope: Spec = { scales, axes }
          const root: Spec = { width: 100, height: 80, padding: 5, autosize: 'none', signals, data: [] }
          const dataAt = (where: 'root' | 'inner'): Spec[] => (x.needsData || rn !== 'with nothing after' ? [tData] : []).filter(() => where === 'root' || x.needsData || true)
          let spec: Spec
          switch (placement) {
            case 'the view':
              spec = { ...root, data: dataAt('root'), ...tail(scope) }
              break
            case 'a group':
              spec = { ...root, data: [], marks: [box({ data: dataAt('inner'), ...tail(scope), marks: [...((tail(scope).marks as Spec[]) ?? [])] })] }
              delete (spec.marks as Spec[])[0]!.title
              break
            case 'a group with the data outside':
              spec = { ...root, data: dataAt('root'), marks: [box({ ...tail(scope) }), box({ scales: [y], axes: [left] })] }
              break
            default:
              spec = { ...root, data: dataAt('root'), marks: [box({ ...tail(scope), marks: [box({ scales: [y], axes: [left] })] })] }
          }
          out.push({ name: `${xn}, in ${placement}, ${on}, ${rn}`, spec })
        }
      }
    }
  }
  return out
}

const CASES = cases()

describe('an axis whose ticks cannot be made', () => {
  it(`is the same outcome as vega, over ${CASES.length} specs`, async () => {
    const wrong: string[] = []
    const counts = { svg: 0, threw: 0 }
    for (const c of CASES) {
      const want = await oracle(c.spec)
      const got = aster(c.spec)
      if ('threw' in want) {
        counts.threw++
        if (!('threw' in got)) wrong.push(`${c.name}: vega cannot serialize it (${want.threw.slice(0, 50)}), aster drew a document`)
        continue
      }
      counts.svg++
      if ('threw' in got) { wrong.push(`${c.name}: vega drew a document, aster refused: ${got.threw.slice(0, 100)}`); continue }
      let diff: string[]
      try { diff = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg)) } catch (e) { wrong.push(`${c.name}: canonicalizer: ${(e as Error).message.slice(0, 80)}`); continue }
      if (diff.length) wrong.push(`${c.name}: ${diff[0]}`)
    }
    // both outcomes are exercised: a matrix that only ever threw (or only ever drew) would prove nothing
    expect(counts.svg).toBeGreaterThan(CASES.length / 4)
    expect(counts.threw).toBeGreaterThan(CASES.length / 8)
    expect(wrong).toEqual([])
  }, 600_000)
})

// ---- the order the scopes are built in ------------------------------------------------------------------------------

const lit = [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, y]
const okGroup = (extra: Spec = {}): Spec => box({ scales: lit, axes: [left], marks: [rect], ...extra })
const badGroup = (extra: Spec = {}): Spec => box({ scales: lit, axes: [left, bad, right], marks: [rect], legends: [{ fill: 'c' }], ...extra })
const frame = (marks: Spec[], extra: Spec = {}): Spec => ({
  width: 160, height: 80, padding: 5, autosize: 'none', data: [tData],
  scales: [{ name: 'c', type: 'ordinal', domain: ['a'], range: ['#c00'] }, y], marks, ...extra,
})
const faceted = (inner: Spec): Spec => ({
  type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'k' } }, encode: { update: { width: { value: 30 }, height: { value: 40 }, x: { signal: 'width / 2 * 0 + 1' } } }, ...inner,
})

const NAMED: Record<string, Spec> = {
  'a failing group between two complete ones': frame([okGroup(), badGroup(), okGroup()]),
  'a complete group whose own child group comes after a failing sibling': frame([badGroup(), okGroup({ marks: [okGroup()] })]),
  'a failing group inside the first group, a second group after it': frame([okGroup({ marks: [badGroup()] }), okGroup({ marks: [okGroup()] })]),
  'a failing group inside the second group, a complete child in the first': frame([okGroup({ marks: [okGroup()] }), okGroup({ marks: [badGroup()] })]),
  'two failing groups, the later one deeper': frame([okGroup({ marks: [badGroup()] }), badGroup()]),
  'two failing axes in one group': frame([badGroup({ axes: [left, { ...bad, orient: 'top' }, bad] })]),
  'the view and a group both failing': frame([okGroup(), badGroup()], { scales: [lit[0], y, { name: 'c', type: 'ordinal', domain: ['a'], range: ['#c00'] }], axes: [left, bad] }),
  'a facet whose scale is literal': frame([faceted({ scales: lit, axes: [left, bad, right], marks: [rect] })]),
  'a facet whose scale is over its partition': frame([faceted({ scales: [{ name: 'x', type: 'linear', domain: { data: 'f', field: 'v' }, range: 'width' }, y], axes: [left, bad], marks: [] })]),
  'a facet whose scale is over the data of the view': frame([faceted({ scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }, y], axes: [left, bad], marks: [] })]),
  'a facet cell after a failing one': frame([faceted({ scales: lit, axes: [left, bad, right], marks: [] }), okGroup()]),
  'a group with its own data feeding the failing scale': frame([badGroup({ data: [{ name: 'own', values: [{ v: 1 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 'own', field: 'v' }, range: 'width' }, y] })]),
  'a group scale over a group that holds data that the outer scope also has': frame([badGroup({ data: [{ name: 't', values: [{ v: 1 }] }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }, y] })]),
  'a format that is no specifier': frame([okGroup({ axes: [left, { orient: 'bottom', scale: 'x', format: 'q' }, right] })]),
  'a format that is no specifier in the view': frame([], { scales: [lit[0], y], axes: [left, { orient: 'bottom', scale: 'x', format: 'q' }, right], title: 'T' }),
  'a time interval on a band scale in a group': frame([okGroup({ scales: [{ name: 'x', type: 'band', domain: ['a', 'b'], range: 'width' }, y], axes: [left, bad] })]),
  'a good interval on a time scale (no failure)': frame([okGroup({ scales: [{ name: 'x', type: 'time', domain: [1e12, 1.1e12], range: 'width' }, y], axes: [left, bad] })]),
  'a view with a layout grid and a failing group': frame([okGroup(), badGroup()], { layout: { columns: 2, padding: 4 } }),
  'a group with its own title after a failing axis': frame([badGroup({ title: { text: 'Inner' } }), okGroup({ title: { text: 'Other' } })]),
  'a legend of the view and a failing axis in a group': frame([badGroup()], { legends: [{ fill: 'c', title: 'View legend' }], title: 'View title' }),
  'an axis with no title and no domain over a late scale': frame([], { scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }, y], axes: [left, { orient: 'bottom', scale: 'x', tickCount: 'week', domain: false }] }),
}

describe('named scopes', () => {
  for (const [name, spec] of Object.entries(NAMED)) {
    it(name, async () => {
      const want = await oracle(spec)
      const got = aster(spec)
      if ('threw' in want) {
        expect(got, 'vega cannot serialize it: aster must refuse too').toHaveProperty('threw')
        return
      }
      if ('threw' in got) throw new Error(`vega drew a document, aster refused: ${got.threw}`)
      expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg)).slice(0, 8)).toEqual([])
    })
  }
})

// ---- the marks an axis is made of: which of them make the half-built axis crash vega's serializer -------------------------

describe('a late scale: what the axis still draws decides whether vega can serialize it', () => {
  const flags: Array<[string, Spec]> = [
    ['no domain, no title', { domain: false }],
    ['a domain', {}],
    ['a title only', { domain: false, title: 'T' }],
    ['no ticks, no labels, no domain', { domain: false, ticks: false, labels: false }],
    ['a grid and no domain', { domain: false, grid: true }],
    ['no ticks and a domain', { ticks: false }],
    ['no labels and no domain', { domain: false, labels: false }],
    ['a null title', { domain: false, title: null }],
    ['an empty title', { domain: false, title: '' }],
  ]
  const late = { name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }
  for (const where of ['the view', 'a group'] as const) {
    for (const [what, f] of flags) {
      it(`${what}, in ${where}`, async () => {
        const axes = [left, { orient: 'bottom', scale: 'x', tickCount: 'week', ...f }, right]
        const spec = where === 'the view'
          ? frame([rect], { scales: [late, y, { name: 'c', type: 'ordinal', domain: ['a'], range: ['#c00'] }], axes, title: 'T' })
          : frame([box({ data: [{ name: 't', values: ROWS }], scales: [late, y], axes, marks: [rect] }), okGroup()])
        const want = await oracle(spec)
        const got = aster(spec)
        if ('threw' in want) { expect(got).toHaveProperty('threw'); return }
        if ('threw' in got) throw new Error(`vega drew a document, aster refused: ${got.threw}`)
        expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg)).slice(0, 8)).toEqual([])
      })
    }
  }
})
