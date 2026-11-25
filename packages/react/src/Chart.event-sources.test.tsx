// @vitest-environment jsdom
/**
 * `eventSources` (core's `SignalBindOptions.eventSources`, DECISIONS Q1): the HOST decides which `window` and CSS-selector sources a
 * spec's `signal.on` streams may listen to. A spec asks for `window:keydown`, a `window:pointermove` and a `body` selector source;
 * what it gets is what the host's policy lets through (by default the window's pointer moves, no key and no selector), narrowed by
 * the spec's own `config.events`, never widened by it. The prop follows the boundary's identity rule: compared by content, so an
 * inline literal does not rebind the chart, and a change of content does.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { EventSourcePolicy } from '@aster-charts/core/signals'
import { forEachVariant } from './testing/variants'

forEachVariant(['signals'], (Chart) => {
  const spec = (config?: Record<string, unknown>): never => ({
    width: 60, height: 30, padding: 0, autosize: 'none',
    signals: [
      { name: 'w', value: 0, on: [{ events: 'window:pointermove', update: 'w + 1' }] },
      { name: 'k', value: 0, on: [{ events: 'window:keydown', update: 'k + 1' }] },
      { name: 's', value: 0, on: [{ events: { source: 'body', type: 'mousedown' }, update: 's + 1' }] },
    ],
    data: [{ name: 't', values: [{ x: 1 }] }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 }, fill: { value: 'steelblue' } } } }],
    ...(config ? { config } : {}),
  }) as never

  const roots: Array<{ unmount(): void }> = []
  afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

  function mount(node: (policy?: EventSourcePolicy) => React.ReactElement, policy?: EventSourcePolicy): { rerender(policy?: EventSourcePolicy): void; reached(): [number, number, number] } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => { root.render(node(policy)) })
    const reached = (): [number, number, number] => {
      const before = seen()
      act(() => { window.dispatchEvent(new MouseEvent('pointermove')) })
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })) })
      act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
      const after = seen()
      return [after.w - before.w, after.k - before.k, after.s - before.s]
    }
    return { rerender: (p) => { act(() => { root.render(node(p)) }) }, reached }
  }

  const values: Record<string, number> = { w: 0, k: 0, s: 0 }
  const seen = (): { w: number; k: number; s: number } => ({ w: values.w!, k: values.k!, s: values.s! })
  const chart = (config?: Record<string, unknown>) => (policy?: EventSourcePolicy): React.ReactElement => (
    <Chart spec={spec(config)} onSignal={(name, value) => { values[name] = value as number }} {...(policy ? { eventSources: policy } : {})} />
  )

  describe('a spec\'s window and selector sources obey the host\'s eventSources', () => {
    it.each([
      ['the default: the window\'s pointer moves, no key, no selector', undefined, [1, 0, 0]],
      ['every source, for a host that trusts its specs', { window: true, selector: true }, [1, 1, 1]],
      ['a list of window types, and the default for selectors', { window: ['keydown'] }, [0, 1, 0]],
      ['no window source at all', { window: false }, [0, 0, 0]],
      ['selectors only', { window: false, selector: true }, [0, 0, 1]],
      ['a list of selector types', { window: false, selector: ['mousedown'] }, [0, 0, 1]],
      ['a list of selector types that is not the spec\'s', { window: false, selector: ['click'] }, [0, 0, 0]],
    ] as const)('%s', (_label, policy, want) => {
      for (const k of Object.keys(values)) values[k] = 0
      const m = mount(chart(), policy as EventSourcePolicy | undefined)
      expect(m.reached()).toEqual(want)
    })

    it('the spec\'s own config.events can narrow the host\'s policy, never widen it', () => {
      for (const k of Object.keys(values)) values[k] = 0
      const narrowed = mount(chart({ events: { window: ['keydown'] } }), { window: true, selector: true })
      expect(narrowed.reached()).toEqual([0, 1, 1])
      act(() => { roots.splice(0).forEach((r) => r.unmount()) })
      for (const k of Object.keys(values)) values[k] = 0
      const widened = mount(chart({ events: { window: true, selector: true } }))
      expect(widened.reached()).toEqual([1, 0, 0])
    })

    it('follows the identity rule: an equal inline literal does not rebind, a different one does', () => {
      for (const k of Object.keys(values)) values[k] = 0
      const add = vi.spyOn(window, 'addEventListener')
      try {
        const m = mount(chart(), { window: ['pointermove'] })
        const bound = add.mock.calls.length
        expect(bound).toBeGreaterThan(0)
        // a new object with the same content (an inline literal re-created by the parent's render): the binding is kept
        m.rerender({ window: ['pointermove'] })
        m.rerender({ window: ['pointermove'] })
        expect(add.mock.calls.length).toBe(bound)
        expect(m.reached()).toEqual([1, 0, 0])
        // other content: the chart is bound anew under it
        const before = add.mock.calls.length
        m.rerender({ window: ['keydown'] })
        expect(add.mock.calls.length).toBeGreaterThan(before)
        expect(m.reached()).toEqual([0, 1, 0])
        m.rerender(undefined)
        expect(m.reached()).toEqual([1, 0, 0])
      } finally { add.mockRestore() }
    })
  })
})
