// @vitest-environment jsdom
/**
 * `signals` is controlled by content and the latest writer wins (DECISIONS Q19, C292, C157): generated sequences of prop
 * changes (some equal in content, some removing a key), unrelated re-renders, `setSignal` calls and bound-input edits are
 * checked against a model that knows nothing of the implementation -- each signal is what its latest writer set, a prop
 * that is removed leaves nothing behind, and an equal literal is not a write. The chart's drawn value, its bound input and
 * `getSignals()` all agree with the model after every step.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChartHandle } from './chart-types'
import { forEachVariant } from './testing/variants'

// (`u` holds an array: a new array with the same items each render is the same value, compared by content)
const DEFAULTS = { s: 5, t: 1, u: 0 } as const
type Name = keyof typeof DEFAULTS
const NAMES: Name[] = ['s', 't', 'u']
const BOUND: Name[] = ['s', 't']
/** How a value of each signal is written: `u` as a one-item array. */
const wire = (k: Name, v: number): unknown => (k === 'u' ? [v] : v)
const spec = {
  width: 100, height: 40, padding: 0, autosize: 'none',
  signals: [
    { name: 's', value: DEFAULTS.s, bind: { input: 'range', min: 0, max: 10, step: 1 } },
    { name: 't', value: DEFAULTS.t, bind: { input: 'range', min: 0, max: 10, step: 1 } },
    { name: 'u', value: [DEFAULTS.u] },
  ],
  marks: [{ type: 'text', name: 'out', encode: { update: { x: { value: 1 }, y: { value: 10 }, text: { signal: "s + ',' + t + ',' + u[0]" } } } }],
}

/** A small seeded generator (mulberry32), so a failing sequence can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The model: the latest writer of each signal, a prop or an event; a removed prop leaves nothing. */
class Model {
  prop: Partial<Record<Name, number>> | undefined
  writer: Partial<Record<Name, { kind: 'prop' | 'event'; value: number }>> = {}
  setProp(next: Partial<Record<Name, number>> | undefined): void {
    for (const k of NAMES) {
      const had = this.prop !== undefined && Object.hasOwn(this.prop, k)
      const has = next !== undefined && Object.hasOwn(next, k)
      if (has && (!had || this.prop![k] !== next![k])) this.writer[k] = { kind: 'prop', value: next![k]! }
      if (had && !has && this.writer[k]?.kind === 'prop') delete this.writer[k]
    }
    this.prop = next
  }
  event(k: Name, value: number): void { this.writer[k] = { kind: 'event', value } }
  value(k: Name): number { return this.writer[k]?.value ?? DEFAULTS[k] }
}

let roots: Array<{ root: Root; el: HTMLElement }> = []
afterEach(() => {
  act(() => { for (const r of roots) r.root.unmount() })
  for (const r of roots) r.el.remove()
  roots = []
})

/** Move a bound range input as a user does: the native value, then the event React listens to. */
function slide(input: HTMLInputElement, value: number): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, String(value))
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

forEachVariant(['svg'], (Chart) => {
  describe('signals: controlled by content, the latest writer wins', () => {
    // (60 seeds, in groups so that each test stays well inside the per-test timeout on a loaded machine)
    for (let group = 0; group < 6; group++) {
    it(`agrees with the model over generated sequences of prop changes, re-renders, setSignal and input edits (seeds ${group * 10 + 1}-${group * 10 + 10})`, () => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      for (let seed = group * 10 + 1; seed <= group * 10 + 10; seed++) {
        const random = rng(seed)
        const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
        const el = document.createElement('div')
        document.body.appendChild(el)
        const root = createRoot(el)
        roots.push({ root, el })
        const ref = React.createRef<ChartHandle>()
        const model = new Model()
        const log: string[] = []
        let prop: Partial<Record<Name, number>> | undefined
        let renders = 0
        const render = (): void => act(() => {
          renders++
          // a new literal every render, with whatever content `prop` has
          const literal = prop === undefined ? undefined : Object.fromEntries(Object.entries(prop).map(([k, v]) => [k, wire(k as Name, v)]))
          root.render(<Chart ref={ref} spec={spec as never} signals={literal} a11y={false} className={`r${renders}`} />)
        })
        render()
        model.setProp(prop)
        for (let step = 0; step < 14; step++) {
          const op = pick(['prop', 'prop', 'rerender', 'set', 'slide'] as const)
          if (op === 'prop') {
            const next: Partial<Record<Name, number>> | undefined = random() < 0.2 ? undefined : {}
            if (next) for (const k of NAMES) if (random() < 0.6) next[k] = pick([2, 3, 7])
            prop = next
            log.push(`prop ${JSON.stringify(next)}`)
            render()
            model.setProp(prop)
          } else if (op === 'rerender') {
            log.push('rerender')
            render()
          } else if (op === 'set') {
            const k = pick(NAMES)
            const v = pick([0, 4, 7, 9])
            log.push(`setSignal ${k} ${v}`)
            act(() => ref.current!.setSignal(k, wire(k, v)))
            model.event(k, v)
          } else {
            const k = pick(BOUND)
            const v = pick([1, 6, 8])
            log.push(`slide ${k} ${v}`)
            const input = el.querySelector<HTMLInputElement>(`[data-signal="${k}"] input`)!
            act(() => slide(input, v))
            model.event(k, v)
          }
          const where = `seed ${seed}: ${log.join(' | ')}`
          const drawn = el.querySelector('.mark-text text')?.textContent
          expect(drawn, where).toBe(`${model.value('s')},${model.value('t')},${model.value('u')}`)
          const signals = ref.current!.getSignals()
          for (const k of NAMES) {
            expect(signals[k] ?? wire(k, DEFAULTS[k]), `${where} getSignals().${k}`).toEqual(wire(k, model.value(k)))
            if (k === 'u') continue
            expect(el.querySelector<HTMLInputElement>(`[data-signal="${k}"] input`)!.value, `${where} input ${k}`).toBe(String(model.value(k)))
          }
        }
        act(() => root.unmount())
        el.remove()
        roots = roots.filter((r) => r.root !== root)
      }
    })
    }
  })
})
