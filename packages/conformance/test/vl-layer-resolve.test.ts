// @vitest-environment node
/**
 * Resolution over a layer tree (C79, C163, C164, C161), against vega-lite 6.4.3 through real Vega: layers of two and three units and
 * nested layers x the channel (x, y, color, size, opacity, shape, xOffset, theta, radius) x the resolution (scale, axis, legend;
 * independent or shared; at the root or on a nested layer) x scales that cannot merge (nominal beside quantitative, linear beside log) x
 * explicit axis orients x `axis: null` x the sizes of the layers (their own, handed down, or their scale's default).
 *
 * Where vega-lite's own output is broken (Vega refuses it, or it draws an empty view) @aster-charts/vl refuses the spec instead
 * (DECISIONS Q9): those cases assert the refusal and the defect of vega-lite's output.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import * as vega from 'vega'
import { compile, VLCompileError } from '@aster-charts/vl'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 8 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], c: i % 2 ? 'p' : 'q', g: ['u', 'v'][i % 2], b: (i * 7) % 13 + 1, d: (i * 3) % 7 + 1, e: (i * 5) % 11 + 2 }))
const data = { values: rows }
type View = Record<string, unknown>
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })

const cases: Array<[string, Record<string, unknown>]> = []
const add = (name: string, spec: Record<string, unknown>): void => { cases.push([name, spec]) }

// position scales and axes: two points, a bar and a line, three layers
const pts = (y1: string, y2: string): View[] => [{ mark: 'point', encoding: { x: q('d'), y: q(y1) } }, { mark: 'point', encoding: { x: q('e'), y: q(y2), color: { value: 'red' } } }]
const barLine: View[] = [{ mark: 'bar', encoding: { x: n('a'), y: q('b') } }, { mark: 'line', encoding: { x: n('a'), y: q('e', { aggregate: 'mean' }) } }]
const three: View[] = [...barLine, { mark: 'rule', encoding: { y: q('d', { aggregate: 'mean' }) } }]
for (const [lName, layers] of [['two points', pts('b', 'e')], ['bar and line', barLine], ['three layers', three]] as const) {
  for (const ch of ['x', 'y'] as const) {
    for (const [rName, resolve] of [
      ['scale independent', { scale: { [ch]: 'independent' } }],
      ['axis independent', { axis: { [ch]: 'independent' } }],
      ['scale and axis independent', { scale: { [ch]: 'independent' }, axis: { [ch]: 'independent' } }],
      ['scale independent, axis shared (independent wins)', { scale: { [ch]: 'independent' }, axis: { [ch]: 'shared' } }],
      ['axis shared, explicit', { axis: { [ch]: 'shared' } }],
    ] as const) add(caseName(lName, ch, rName), { data, layer: layers, resolve })
  }
  add(caseName(lName, 'x and y independent'), { data, layer: layers, resolve: { scale: { x: 'independent', y: 'independent' } } })
}
// independent position scales over layers sized differently: a band, a continuous scale, none
{
  const SIZED: Record<string, View> = { band: barLine[0]!, continuous: { mark: 'point', encoding: { x: q('d'), y: q('b') } }, none: { mark: 'rule', encoding: { y: q('d', { aggregate: 'mean' }) } } }
  for (const a of Object.keys(SIZED)) for (const b of Object.keys(SIZED)) {
    if (a !== b) add(caseName('independent x', `${a} then ${b}`), { data, layer: [SIZED[a]!, SIZED[b]!], resolve: { scale: { x: 'independent' } } })
  }
  for (const [a, b] of [['band', 'continuous'], ['band', 'none'], ['band', 'band'], ['continuous', 'band']] as const) {
    add(caseName('independent x', `${a} then ${b}, the layer sized`), { data, width: 200, layer: [SIZED[a]!, SIZED[b]!], resolve: { scale: { x: 'independent' } } })
    add(caseName('independent x', `${a} then ${b}, the first layer sized`), { data, layer: [{ ...SIZED[a]!, width: 200 }, SIZED[b]!], resolve: { scale: { x: 'independent' } } })
    add(caseName('independent x', `${a} then ${b}, a container width`), { data, width: 'container', layer: [SIZED[a]!, SIZED[b]!], resolve: { scale: { x: 'independent' } } })
  }
  for (const [a, b] of [['band', 'continuous'], ['continuous', 'none'], ['continuous', 'continuous']] as const) {
    add(caseName('independent x in a nested layer', `${a} then ${b}`), { data, layer: [{ layer: [SIZED[a]!, SIZED[b]!], resolve: { scale: { x: 'independent' } } }, SIZED.none!] })
    add(caseName('independent x in a nested layer', `${a} then ${b}, the nested layer sized`), { data, layer: [{ width: 200, layer: [SIZED[a]!, SIZED[b]!], resolve: { scale: { x: 'independent' } } }, SIZED.none!] })
  }
  add(caseName('independent x', 'continuous sized as the default, then continuous'), { data, layer: [{ ...SIZED.continuous!, width: 300 }, SIZED.continuous!], resolve: { scale: { x: 'independent' } } })
  add(caseName('independent x', 'band then band'), { data, layer: [SIZED.band!, { ...SIZED.band!, mark: 'tick' }], resolve: { scale: { x: 'independent' } } })
}
// orients under independent axes (C163)
for (const [o1, o2] of [[undefined, 'left'], ['right', undefined], ['right', 'right'], ['left', 'right'], [undefined, undefined]] as const) {
  const axis = (o: string | undefined) => (o !== undefined ? { axis: { orient: o } } : {})
  add(caseName('independent y axes', `orients ${o1 ?? 'default'} / ${o2 ?? 'default'}`), { data, layer: [{ mark: 'bar', encoding: { x: n('a'), y: q('b', axis(o1)) } }, { mark: 'line', encoding: { x: n('a'), y: q('e', { aggregate: 'mean', ...axis(o2) }) } }], resolve: { scale: { y: 'independent' } } })
  add(caseName('independent y axes over a shared scale', `orients ${o1 ?? 'default'} / ${o2 ?? 'default'}`), { data, layer: [{ mark: 'bar', encoding: { x: n('a'), y: q('b', axis(o1)) } }, { mark: 'line', encoding: { x: n('a'), y: q('e', { aggregate: 'mean', ...axis(o2) }) } }], resolve: { axis: { y: 'independent' } } })
}
add('three independent y axes', { data, layer: [{ mark: 'bar', encoding: { x: n('a'), y: q('b') } }, { mark: 'line', encoding: { x: n('a'), y: q('e', { aggregate: 'mean' }) } }, { mark: 'point', encoding: { x: n('a'), y: q('d') } }], resolve: { scale: { y: 'independent' } } })
add('explicit grid on the second independent axis', { data, layer: [{ mark: 'bar', encoding: { x: n('a'), y: q('b') } }, { mark: 'line', encoding: { x: n('a'), y: q('e', { aggregate: 'mean', axis: { grid: true } }) } }], resolve: { scale: { y: 'independent' } } })
// axis: null (C164)
for (const ch of ['x', 'y'] as const) {
  const nul = (v: View, which: string): View => ({ ...v, encoding: { ...(v.encoding as object), [which]: { ...((v.encoding as Record<string, object>)[which]), axis: null } } })
  add(caseName(`axis null on the first layer's ${ch}`), { data, layer: [nul(barLine[0]!, ch), barLine[1]!] })
  add(caseName(`axis null on every layer's ${ch}`), { data, layer: [nul(barLine[0]!, ch), nul(barLine[1]!, ch)] })
  add(caseName(`axis null on the first layer's ${ch}, axes independent`), { data, layer: [nul(barLine[0]!, ch), barLine[1]!], resolve: { axis: { [ch]: 'independent' } } })
  add(caseName(`axis null on the first layer's ${ch}, scales independent`), { data, layer: [nul(barLine[0]!, ch), barLine[1]!], resolve: { scale: { [ch]: 'independent' } } })
}
// non-position channels: scales and legends
const colourPts = (f1: string, f2: string, ch: string, t1 = 'nominal', t2 = 'nominal'): View[] => [
  { mark: 'point', encoding: { x: q('d'), y: q('b'), [ch]: { field: f1, type: t1 } } },
  { mark: 'square', encoding: { x: q('e'), y: q('b'), [ch]: { field: f2, type: t2 } } },
]
for (const ch of ['color', 'size', 'opacity', 'shape'] as const) {
  const t = ch === 'size' || ch === 'opacity' ? 'quantitative' : 'nominal'
  const [f1, f2] = t === 'quantitative' ? ['b', 'e'] : ['a', 'c']
  for (const [rName, resolve] of [['scale independent', { scale: { [ch]: 'independent' } }], ['legend independent', { legend: { [ch]: 'independent' } }], ['shared', {}]] as const) {
    add(caseName(ch, rName), { data, layer: colourPts(f1!, f2!, ch, t, t), resolve })
    add(caseName(ch, rName, 'one field'), { data, layer: colourPts(f1!, f1!, ch, t, t), resolve })
  }
}
// scales that cannot merge: vega-lite keeps them apart without being asked
add('a colour nominal in one layer and quantitative in the other', { data, layer: colourPts('a', 'b', 'color', 'nominal', 'quantitative') })
add('a linear x beside a log x', { data, layer: [{ mark: 'point', encoding: { x: q('d'), y: q('b') } }, { mark: 'point', encoding: { x: q('e', { scale: { type: 'log' } }), y: q('b') } }] })
// offsets and polar channels
add('xOffset independent', { data, layer: [{ mark: 'bar', encoding: { x: n('a'), xOffset: n('c'), y: q('b') } }, { mark: 'point', encoding: { x: n('a'), xOffset: { field: 'd', type: 'ordinal' }, y: q('b') } }], resolve: { scale: { xOffset: 'independent' } } })
for (const ch of ['theta', 'radius'] as const) {
  add(caseName(ch, 'independent'), { data, layer: [{ mark: 'arc', encoding: { theta: q('b'), radius: q('d'), color: n('a') } }, { mark: 'arc', encoding: { theta: q('e'), radius: q('e'), color: n('a') } }], resolve: { scale: { [ch]: 'independent' } } })
}
// nested layers resolve their own layers first
add('a nested layer with independent y beside a rule', { data, layer: [{ layer: barLine, resolve: { scale: { y: 'independent' } } }, { mark: 'rule', encoding: { y: q('d', { aggregate: 'mean' }) } }] })
add('a nested layer with independent colour beside a point', { data, layer: [{ layer: colourPts('a', 'c', 'color'), resolve: { scale: { color: 'independent' } } }, { mark: 'point', encoding: { x: q('d'), y: q('e'), color: n('g') } }] })
add('a nested layer with an independent colour legend', { data, layer: [{ layer: colourPts('a', 'a', 'color'), resolve: { legend: { color: 'independent' } } }, { mark: 'point', encoding: { x: q('d'), y: q('e'), color: n('a') } }] })
add('independent y at the root over a nested shared layer', { data, layer: [{ layer: [{ mark: 'point', encoding: { x: n('a'), y: q('b') } }, { mark: 'line', encoding: { x: n('a'), y: q('b', { aggregate: 'mean' }) } }] }, { mark: 'bar', encoding: { x: n('a'), y: q('e', { aggregate: 'sum' }) } }], resolve: { scale: { y: 'independent' } } })
add('a boxplot and a line, y independent', { data, layer: [{ mark: 'boxplot', encoding: { x: n('a'), y: q('b') } }, { mark: 'line', encoding: { x: n('a'), y: q('e', { aggregate: 'mean' }) } }], resolve: { scale: { y: 'independent' } } })
// a layer's size and its layers' sizes (C161)
for (const [sName, root, kids] of [
  ['a child width and height', {}, [{ width: 100, height: 80 }, {}]],
  ['a child step', {}, [{ width: { step: 40 } }, {}]],
  ['a parent width and a child width', { width: 400 }, [{ width: 100 }, {}]],
  ['two children, different widths', {}, [{ width: 120 }, { width: 50 }]],
  ['a nested layer\'s width', {}, [{}, {}]],
] as const) {
  const layers = barLine.map((l, i) => ({ ...l, ...kids[i] }))
  add(caseName('sizes', sName), sName === 'a nested layer\'s width' ? { data, layer: [{ layer: barLine, width: 150 }, { mark: 'rule', encoding: { y: q('d', { aggregate: 'mean' }) } }] } : { data, ...root, layer: layers })
}

/** Specs vega-lite compiles to a broken chart, refused here (DECISIONS Q9), with how its output is broken. */
const REFUSED: Array<[RegExp, string, (out: Record<string, any>) => Promise<boolean>]> = [
  [/independent [xy] scales over layers sized differently/, 'the view has no width or height: its output draws nothing', async (out) => {
    const view = new (vega as any).View((vega as any).parse(out), { renderer: 'none' })
    await view.runAsync()
    const empty = view.width() === 0 || view.height() === 0
    view.finalize()
    return empty
  }],
  [/independent [xy] scales in a nested layer over layers sized differently/, 'the view takes another layer\'s size, and a nested layer\'s scale spans a size of its own', async (out) => {
    const view = new (vega as any).View((vega as any).parse(out), { renderer: 'none' })
    await view.runAsync()
    const sizes = (out.signals ?? []).filter((s: { name: string }) => /^layer_.*_(width|height)$/.test(s.name)).map((s: { name: string }) => [s.name.endsWith('width') ? view.width() : view.height(), view.signal(s.name)])
    const broken = sizes.some(([viewSize, own]: [number, number]) => viewSize !== own)
    view.finalize()
    return broken
  }],
  [/axis: null` on a layer after one that draws/, 'vega-lite crashes', async () => true],
]

describe('a layer tree resolves its scales, axes and legends as vega-lite does', () => {
  for (const [name, spec] of cases) {
    it(name, async () => {
      try {
        compile(JSON.parse(JSON.stringify(spec)))
      } catch (e) {
        const rule = REFUSED.find(([re]) => re.test(String((e as Error).message)))
        if (e instanceof VLCompileError && rule !== undefined) {
          let theirs: Record<string, any> | undefined
          try { theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec } catch { theirs = undefined }
          expect(theirs === undefined || (await rule[2](theirs)), `refused because ${rule[1]}`).toBe(true)
          return
        }
      }
      await drawsLikeVegaLite(spec)
    }, 30_000)
  }
})
