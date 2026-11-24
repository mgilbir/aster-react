// @vitest-environment node
/**
 * The defaults a mark takes from its config and its styles, against vega (C128, C129). vega-parser (encode/defaults.js) gives a mark
 * whose role is `mark` the channels of `config.mark` and `config[type]` (a solid paint skipped when either paint is encoded), then
 * those of each style the mark NAMES (`style`, never its type), each skipped where the mark encodes the channel; a default is a value
 * that lands in the `enter` set (a `{signal}` one in `update`); and vega adjusts the spatial channels per set (`adjustSpatial`), the
 * enter set's and then the update set's.
 *
 * Generated (seeded): a mark of every type, encoded in `enter` only, `update` only or both (spatial channels split between them),
 * with defaults from `config.mark`, `config.<type>`, `config.style.<type>` (which the mark does not name: no default) and a named
 * style, each holding spatial channels (`x`, `x2`, `xc`, `width`, ... `y`, `y2`, `yc`, `height`), paints and sizes, some as signals.
 * The SVG is compared canonically and strictly with vega's.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES = ['rect', 'symbol', 'text', 'rule', 'arc', 'image', 'group', 'area', 'line', 'path', 'trail']
const SPATIAL = ['x', 'x2', 'xc', 'width', 'y', 'y2', 'yc', 'height']
const OTHER: Record<string, () => unknown> = {
  fill: () => 'steelblue', stroke: () => 'black', strokeWidth: () => 3, size: () => 200, opacity: () => 0.6, fontSize: () => 16,
  text: () => 'T', innerRadius: () => 5, outerRadius: () => 20, startAngle: () => 0, endAngle: () => 2, cornerRadius: () => 2,
  path: () => 'M0,0L10,10', url: () => 'data:image/png;base64,iVBORw0KGgo=', align: () => 'right', angle: () => 30,
}

const OWN_TYPE: Record<string, string[]> = { text: ['text'], align: ['text'], fontSize: ['text'], path: ['path'], url: ['image'] }

function caseOf(seed: number): { label: string; spec: Obj } {
  const r = stream(seed)
  const int = (n: number): number => Math.floor(r() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!
  const chance = (p: number): boolean => r() < p
  const type = pick(TYPES)
  const num = (): number => 5 + int(60)
  /** A block of defaults: some spatial channels, some others, some as signals. */
  const block = (): Obj => {
    const out: Obj = {}
    for (let i = 0, n = 1 + int(4); i < n; i++) out[pick(SPATIAL)] = chance(0.15) ? { signal: String(num()) } : num()
    for (let i = 0, n = int(3); i < n; i++) {
      const k = pick(Object.keys(OTHER))
      // (a channel of another mark type goes to its own: an arc that carries a right-aligned `text` with a `fontSize`, or a `path`,
      // is bounded otherwise in Aster than in vega, defaults or not -- a bounds defect reported with C129, not a matter of where the
      // channels come from)
      if (OWN_TYPE[k] !== undefined && !OWN_TYPE[k]!.includes(type)) continue
      out[k] = OTHER[k]!()
    }
    return out
  }
  const config: Obj = {}
  if (chance(0.5)) config.mark = block()
  if (chance(0.6)) config[type] = block()
  const style: Obj = {}
  if (chance(0.5)) style[type] = block()
  const named = chance(0.6) ? 'own' : undefined
  if (named) style.own = block()
  if (Object.keys(style).length) config.style = style
  // the mark's own channels, in enter, update or both
  const sets = pick(['enter', 'update', 'both'] as const)
  const own = (): Obj => {
    const out: Obj = {}
    for (let i = 0, n = 1 + int(3); i < n; i++) out[pick(SPATIAL)] = { value: num() }
    if (chance(0.4)) out.fill = { value: 'tomato' }
    return out
  }
  const encode: Obj = sets === 'both' ? { enter: own(), update: own() } : { [sets]: own() }
  // (an arc is drawn with radii of its own: an arc of no radius is a point, whose extent Aster bounds otherwise than vega when it is
  // turned -- a bounds defect reported with C129)
  if (type === 'arc') Object.assign((encode.enter ??= {}) as Obj, { outerRadius: { value: 12 }, endAngle: { value: 2 } })
  const mark: Obj = { type, encode, ...(named ? { style: chance(0.5) ? named : [named] } : {}) }
  if (type === 'area' || type === 'line' || type === 'trail') Object.assign(mark, { from: { data: 'pts' } })
  const spec: Obj = { width: 120, height: 80, data: [{ name: 'pts', values: [{}, {}] }], config, marks: [mark] }
  return { label: `#${seed} ${type} ${sets}${named ? ' style' : ''}`, spec }
}

async function oracleSvg(spec: Obj): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

describe('a mark takes the defaults of its config and of the styles it names, adjusted per encode set, as vega gives them', () => {
  it('the audit cases', async () => {
    const cases: Obj[] = [
      // C128: config.style.<type> is not the mark's style
      { width: 50, height: 50, config: { style: { rect: { fill: 'blue', strokeWidth: 3, stroke: 'black' } } }, marks: [{ type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 10 }, height: { value: 10 } } } }] },
      { width: 50, height: 50, config: { rect: { fill: 'green' }, style: { rect: { fill: 'blue' } } }, marks: [{ type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 10 }, height: { value: 10 } } } }] },
      { width: 50, height: 50, config: { style: { symbol: { size: 400 } } }, marks: [{ type: 'symbol', encode: { update: { x: { value: 20 }, y: { value: 20 } } } }] },
      { width: 50, height: 50, config: { style: { text: { fontSize: 30, fill: 'red' } } }, marks: [{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { value: 'a' } } } }] },
      { width: 50, height: 50, config: { style: { group: { fill: 'red' } } }, marks: [{ type: 'group', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 10 }, height: { value: 10 } } } }] },
      // C129: an update-only mark takes its spatial defaults
      { width: 50, height: 50, config: { rect: { width: 33 } }, marks: [{ type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, height: { value: 5 } } } }] },
      { width: 80, height: 50, config: { style: { s: { xc: 44, width: 10 } } }, marks: [{ type: 'rect', style: 's', encode: { update: { y: { value: 5 }, height: { value: 5 } } } }] },
      { width: 50, height: 50, config: { symbol: { x: 20, y: 20 } }, marks: [{ type: 'symbol', encode: { update: { fill: { value: 'red' } } } }] },
      { width: 50, height: 50, config: { text: { x: 20, y: 20 } }, marks: [{ type: 'text', encode: { update: { text: { value: 'a' } } } }] },
      // the edges split between the sets
      { width: 80, height: 50, config: { style: { s: { x2: 40 } } }, marks: [{ type: 'rect', style: 's', encode: { update: { x: { value: 5 }, y: { value: 5 }, height: { value: 5 } } } }] },
      { width: 80, height: 50, config: { rect: { x: 30 } }, marks: [{ type: 'rect', encode: { update: { x2: { value: 60 }, y: { value: 5 }, height: { value: 5 } } } }] },
      { width: 80, height: 50, marks: [{ type: 'rect', encode: { enter: { x: { value: 0 }, x2: { value: 70 } }, update: { x: { value: 20 }, y: { value: 5 }, height: { value: 5 } } } }] },
      { width: 80, height: 50, marks: [{ type: 'rect', encode: { enter: { x2: { value: 70 }, width: { value: 15 } }, update: { x2: { value: 40 }, y: { value: 5 }, height: { value: 5 } } } }] },
    ]
    for (const spec of cases) expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(structuredClone(spec) as never))), JSON.stringify(spec)).toEqual([])
  })

  it('400 generated marks', { timeout: 120_000 }, async () => {
    const bad: string[] = []
    let refused = 0
    for (let seed = 1; seed <= 400; seed++) {
      const { label, spec } = caseOf(seed)
      let want: string
      try { want = await oracleSvg(spec) } catch { refused++; continue }
      let got: string
      try { got = renderSpec(structuredClone(spec) as never) } catch (e) { bad.push(`${label}: aster threw ${(e as Error).message}\n${JSON.stringify(spec)}`); continue }
      const d = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))
      if (d.length) bad.push(`${label}: ${d.slice(0, 3).join(' | ')}\n${JSON.stringify(spec)}`)
    }
    expect(bad, `${bad.length} differ:\n${bad.slice(0, 6).join('\n')}`).toEqual([])
    // (not vacuous: vega draws nearly all of them)
    expect(refused).toBeLessThan(40)
  })
})
