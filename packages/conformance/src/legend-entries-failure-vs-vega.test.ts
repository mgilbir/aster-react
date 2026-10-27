// @vitest-environment jsdom
/**
 * A legend whose entries cannot be made (an interval string as tickCount over a scale that is not a time scale), against real Vega.
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
const lin = { name: 'g', type: 'linear', domain: [0, 10], range: ['white', 'black'] }
const linData = { name: 'g', type: 'linear', domain: { data: 't', field: 'v' }, range: ['white', 'black'] }
const qz = { name: 'g', type: 'quantize', domain: [0, 9], range: ['#eee', '#9bd', '#06c'] }
const size = { name: 'g', type: 'linear', domain: [0, 10], range: [10, 100] }
const ord = { name: 'g', type: 'ordinal', domain: ['a', 'b'], range: ['#c00', '#06c'] }
const other = { name: 'o', type: 'ordinal', domain: ['a', 'b'], range: ['#c00', '#06c'] }
const y = { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }
const bad = { fill: 'g', tickCount: 'week', title: 'Bad' }
const bads = { size: 'g', tickCount: 'week', title: 'Bad' }
const okL = { fill: 'o', title: 'Ok', orient: 'left' }
const okR = { fill: 'o', title: 'Ok2' }
const left = { orient: 'left', scale: 'y', title: 'Left' }
const box = (extra: Spec = {}): Spec => ({ type: 'group', encode: { update: { width: { value: 60 }, height: { value: 50 }, stroke: { value: '#999' } } }, ...extra })
const rect = { type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 2 }, width: { value: 5 }, height: { value: 5 } } } }

const scaleKinds: Record<string, { sc: Spec; legend: Spec }> = {
  'gradient over a literal scale': { sc: lin, legend: bad },
  'gradient over data in its scope': { sc: linData, legend: bad },
  'discrete (quantize)': { sc: qz, legend: bad },
  'symbols over a size scale': { sc: size, legend: bads },
  'symbols over an ordinal scale': { sc: ord, legend: bad },
}
const orders: Record<string, (b: Spec) => Spec[]> = {
  'bad between two legends': (b) => [okL, b, okR],
  'bad first': (b) => [b, okR],
  'bad last': (b) => [okL, b],
}
const tails: Record<string, (s: Spec) => Spec> = {
  'with axes, marks and a title': (s) => ({ ...s, axes: [left], marks: [...((s.marks as Spec[]) ?? []), rect], title: 'Title' }),
  'with nothing else': (s) => s,
}
const placements = ['the view', 'a group', 'a group inside a group', 'a group beside a group'] as const

function cases(): Array<{ name: string; spec: Spec }> {
  const out: Array<{ name: string; spec: Spec }> = []
  for (const [kn, k] of Object.entries(scaleKinds)) {
    for (const placement of placements) {
      for (const [on, order] of Object.entries(orders)) {
        for (const [tn, tail] of Object.entries(tails)) {
          const scope: Spec = { scales: [k.sc, other, y], legends: order(k.legend) }
          const root: Spec = { width: 200, height: 90, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }] }
          let spec: Spec
          switch (placement) {
            case 'the view': spec = { ...root, ...tail(scope) }; break
            case 'a group': spec = { ...root, marks: [box(tail(scope))] }; break
            case 'a group inside a group': spec = { ...root, marks: [box({ marks: [box(tail(scope))] })] }; break
            default: spec = { ...root, marks: [box(tail(scope)), box({ scales: [other], legends: [okR], axes: [] })] }
          }
          out.push({ name: `${kn}, in ${placement}, ${on}, ${tn}`, spec })
        }
      }
    }
  }
  return out
}
const CASES = cases()

describe('a legend whose entries cannot be made', () => {
  it(`is the same outcome as vega, over ${CASES.length} specs`, async () => {
    const wrong: string[] = []
    const counts = { svg: 0, threw: 0 }
    for (const c of CASES) {
      const want = await oracle(c.spec)
      const got = aster(c.spec)
      if ('threw' in want) {
        counts.threw++
        if (!('threw' in got)) wrong.push(`${c.name}: vega cannot serialize it, aster drew a document`)
        continue
      }
      counts.svg++
      if ('threw' in got) { wrong.push(`${c.name}: vega drew a document, aster refused: ${got.threw.slice(0, 100)}`); continue }
      let diff: string[]
      try { diff = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg)) } catch (e) { wrong.push(`${c.name}: canonicalizer: ${(e as Error).message.slice(0, 80)}`); continue }
      if (diff.length) wrong.push(`${c.name}: ${diff[0]}`)
    }
    expect(counts.svg).toBeGreaterThan(CASES.length / 4)
    expect(wrong).toEqual([])
  }, 600_000)
})

const frame = (marks: Spec[], extra: Spec = {}): Spec => ({
  width: 160, height: 80, padding: 5, autosize: 'none', data: [{ name: 't', values: ROWS }], scales: [lin, other, y], marks, ...extra,
})
const NAMED: Record<string, Spec> = {
  'a failing legend in the second of three groups': frame([box({ legends: [okR] }), box({ legends: [okR, bad, okL] }), box({ legends: [okR] })]),
  'a failing legend in a group, a complete child in the first': frame([box({ marks: [box({ legends: [okR] })] }), box({ legends: [bad] })]),
  'a failing legend deeper than a complete sibling subtree': frame([box({ marks: [box({ legends: [bad] })] }), box({ legends: [okR] })]),
  'an axis failing in the view and a legend failing in a group': frame([box({ legends: [bad] })], { axes: [left, { orient: 'bottom', scale: 'y', tickCount: 'week' }] }),
  'a legend failing in the view and an axis failing in a group': frame([box({ scales: [y], axes: [{ orient: 'bottom', scale: 'y', tickCount: 'week' }] })], { legends: [bad] }),
  'a time scale takes an interval': frame([], { scales: [{ name: 'g', type: 'time', domain: [1e12, 1.1e12], range: ['white', 'black'] }, other], legends: [{ fill: 'g', tickCount: 'week' }, okR] }),
  'a facet cell with a failing legend': frame([{ type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'k' } }, encode: { update: { width: { value: 30 }, height: { value: 40 } } }, legends: [bad, okR] }]),
}
describe('named legend failures', () => {
  for (const [name, spec] of Object.entries(NAMED)) {
    it(name, async () => {
      const want = await oracle(spec)
      const got = aster(spec)
      if ('threw' in want) { expect(got).toHaveProperty('threw'); return }
      if ('threw' in got) throw new Error(`vega drew a document, aster refused: ${got.threw}`)
      expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg)).slice(0, 8)).toEqual([])
    })
  }
})
