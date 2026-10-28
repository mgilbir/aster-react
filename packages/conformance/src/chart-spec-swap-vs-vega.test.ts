// @vitest-environment jsdom
/**
 * A <Chart> given a different `spec`, against real Vega in the same process.
 *
 * ONE mounted <Chart> is given spec A and then spec B (the prop changes; the chart stays mounted), and what it shows must be
 * what vega draws for B: no element of A left behind, none of B missing, none of A's state (timers, a drag in flight, signal
 * values) in B. The pairs are a seeded sample of the raw-Vega corpus, plus specs that are alive when they are replaced (a timer
 * ticking, a pointer drag in progress). B is a spec that a fresh mount already draws as vega does (checked first, so the
 * relation tested is the swap's and not a known fresh-mount difference). The same relation over the whole official gallery, in
 * a real browser, is `pnpm conformance:gallery` (the spec-swap path); the component- and hook-level relation to a fresh mount
 * is in packages/react (Chart.spec-swap.test.tsx, hooks.spec-swap.test.tsx).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vega from 'vega'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import '@aster/core/geo'
import '@aster/core/transforms'
import { Chart } from '@aster/react'
import { SvgChart } from '@aster/react/lite'
import { interaction } from '@aster/react/interaction'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Spec = Record<string, unknown>
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')

const mulberry32 = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(vega.parse(JSON.parse(JSON.stringify(spec)) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const SHELLS: Array<[string, (spec: Spec) => React.ReactElement]> = [
  ['<Chart>', (spec) => React.createElement(Chart as never, { spec })],
  ['<SvgChart interaction>', (spec) => React.createElement(SvgChart as never, { spec, interaction })],
]

const roots: Root[] = []
const mount = (): { container: HTMLElement; render(node: React.ReactElement): void } => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  return { container, render: (node) => { act(() => { root.render(node) }) } }
}
afterAll(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })
const canon = (c: HTMLElement) => canonicalizeSvg(c.querySelector('svg')!.outerHTML)

/** specs that are alive when they are replaced */
const FRAME = { width: 200, height: 50, padding: 0, autosize: 'none' }
const bar = (width: string): Spec => ({ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: width }, height: { value: 10 }, fill: { value: 'steelblue' } } } })
const ticking: Spec = { ...FRAME, signals: [{ name: 'n', value: 1, on: [{ events: { type: 'timer', throttle: 20 }, update: 'n + 1' }] }], data: [{ name: 't', values: [{ v: 1 }] }], marks: [bar('n * 5')] }
const dragging: Spec = { ...FRAME, signals: [{ name: 'moved', value: 0, on: [{ events: { type: 'mousemove', between: [{ type: 'mousedown' }, { type: 'mouseup' }] }, update: 'moved + 1' }] }], data: [{ name: 't', values: [{ v: 1 }] }], marks: [bar('50 + moved')] }

describe('a mounted <Chart> whose spec changes draws what vega draws for the new spec', () => {
  const eligible: Array<{ name: string; spec: Spec }> = []
  const all: Array<{ name: string; spec: Spec }> = []
  beforeAll(async () => {
    const files = readdirSync(CORPUS).filter((f) => f.endsWith('.vg.json')).sort()
    const rand = mulberry32(0x5eed1)
    const names = new Set<string>()
    while (names.size < 70) names.add(files[Math.floor(rand() * files.length)]!)
    for (const f of names) {
      const spec = JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Spec
      if (JSON.stringify(spec).includes('"url"')) continue // (loaded data is the gallery gate's business)
      all.push({ name: f, spec })
      // B must already be drawn as vega draws it by a fresh mount
      let want: ReturnType<typeof canonicalizeSvg>
      try { want = canonicalizeSvg(await vegaSvg(spec)) } catch { continue }
      const m = mount()
      m.render(SHELLS[0]![1](spec))
      if (diffCanonical(want, canon(m.container)).length === 0) eligible.push({ name: f, spec })
    }
  }, 120_000)

  for (const [shell, element] of SHELLS) {
    it(`${shell}: A -> B equals vega's B, over a seeded sample of corpus pairs and live specs`, async () => {
      expect(eligible.length).toBeGreaterThanOrEqual(35)
      const rand = mulberry32(0xbee5)
      const pairs: Array<[string, Spec, { name: string; spec: Spec }]> = []
      for (let i = 0; i < 50; i++) pairs.push(['', all[Math.floor(rand() * all.length)]!.spec, eligible[Math.floor(rand() * eligible.length)]!])
      for (const live of [ticking, dragging]) for (let i = 0; i < 8; i++) pairs.push(['live', live, eligible[Math.floor(rand() * eligible.length)]!])
      const bad: string[] = []
      for (const [kind, a, b] of pairs) {
        const want = canonicalizeSvg(await vegaSvg(b.spec))
        const m = mount()
        m.render(element(a))
        if (kind === 'live') {
          const svg = m.container.querySelector('svg')!
          act(() => { svg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) })
          await act(async () => { await new Promise((r) => setTimeout(r, 70)) })
        }
        m.render(element(b.spec))
        const diffs = diffCanonical(want, canon(m.container))
        if (diffs.length) bad.push(`${kind || 'corpus'} -> ${b.name}: ${diffs[0]}`)
        // and no tick of the old spec arrives afterwards
        if (kind === 'live') {
          await act(async () => { await new Promise((r) => setTimeout(r, 70)) })
          const later = diffCanonical(want, canon(m.container))
          if (later.length) bad.push(`live -> ${b.name} (after 70 ms): ${later[0]}`)
        }
        act(() => { roots.pop()!.unmount() })
      }
      expect(pairs.length).toBe(66)
      expect(bad).toEqual([])
    }, 180_000)
  }
})
