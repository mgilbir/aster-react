/**
 * A view size the host gives against the size the spec computes (C112): `width` / `height` as a literal, as a signal with a value,
 * with an `update` (constant or reading another signal), with handlers; the host sets the size (`input.width` = `view.width(n)` on
 * the running view), writes the signal (`input.signals` = `view.signal(name, n)`), both, or neither -- at sizes around the old 500
 * default. An input is what a host hands a chart that is running, as the event loop does: vega's view has run once, then is given
 * the size and runs again. The frame the SVG is drawn at and the value the signal holds must be vega's: never one size for the
 * frame and another for the signal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster-charts/core'

type Spec = Record<string, unknown>
const T = [{ type: 'text', encode: { update: { text: { signal: "width + 'x' + height" } } } }]

const DEFS: ReadonlyArray<readonly [string, (dim: string) => Spec]> = [
  ['a literal', (dim) => ({ [dim]: 300 })],
  ['a signal with a value', (dim) => ({ signals: [{ name: dim, value: 300 }] })],
  ['a signal with a constant update', (dim) => ({ signals: [{ name: dim, update: '300' }] })],
  ['a signal with a value and an update reading another', (dim) => ({ signals: [{ name: 'k', value: 3 }, { name: dim, value: 10, update: 'k * 100' }] })],
  ['a signal with an update and a handler', (dim) => ({ signals: [{ name: dim, value: 300, update: '300', on: [{ events: 'click', update: '200' }] }] })],
]
const HOST = ['size', 'signal', 'both', 'none'] as const

const frame = (svg: string): string => `${/width="([\d.]+)"/.exec(svg)?.[1]}x${/height="([\d.]+)"/.exec(svg)?.[1]}`
const shown = (svg: string): string | undefined => />(\d+x\d+)</.exec(svg)?.[1]

describe('the view size the host gives and the size the spec computes (generated, vs real vega)', () => {
  it('frame and signals', async () => {
    const diffs: string[] = []
    for (const dim of ['width', 'height'] as const) {
      const other = dim === 'width' ? 'height' : 'width'
      for (const [what, def] of DEFS) {
        for (const host of HOST) {
          for (const n of [499, 500, 501]) {
            const spec = { padding: 0, autosize: 'none', [other]: 100, marks: T, ...def(dim) }
            const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' }) as unknown as {
              width(n: number): unknown; height(n: number): unknown; signal(k: string, v?: unknown): unknown; runAsync(): Promise<unknown>; toSVG(): Promise<string>; finalize(): void
            }
            await view.runAsync()
            if (host === 'size' || host === 'both') view[dim](n)
            if (host === 'signal' || host === 'both') view.signal(dim, n)
            await view.runAsync()
            const want = await view.toSVG()
            view.finalize()
            const svg = renderSceneToSvg(evaluateChart(compileChart(structuredClone(spec) as never), {
              ...(host === 'size' || host === 'both' ? { [dim]: n } : {}),
              ...(host === 'signal' || host === 'both' ? { signals: { [dim]: n } } : {}),
            }))
            const a = `${frame(want)} ${shown(want)}`
            const b = `${frame(svg)} ${shown(svg)}`
            // (a signal with handlers is a state the event loop writes through `signals` after a handler assigned it -- vega skips
            // the update of a signal a handler assigned -- so an evaluation takes the value written; vega's `view.signal` from outside
            // pulses the update instead. The two are not told apart by an input: what holds is that frame and signal agree.)
            if (what.includes('handler') && host !== 'none') { if (frame(svg) !== shown(svg)) diffs.push(`${dim} ${what}, host ${host} ${n}: split ${b}`) }
            else if (a !== b) diffs.push(`${dim} ${what}, host ${host} ${n}: vega ${a} | aster ${b}`)
          }
        }
      }
    }
    expect(diffs).toEqual([])
  })
})
