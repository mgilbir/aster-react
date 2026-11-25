// @vitest-environment jsdom
/**
 * The window listeners of a chart whose spec has `window:` event streams, across renders: a re-render that changes nothing adds none
 * (the first one used to bind the chart again: the markup the first commit wrote was emptied afterwards, and the binding depended on
 * that string), and nothing leaks (every listener added is removed by the chart's end, and the live count does not grow with the
 * renders). Counted on `window` itself, through the add/remove calls the chart makes.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const spec = (): never => ({
  width: 60, height: 30, padding: 0, autosize: 'none',
  signals: [
    { name: 'w', value: 0, on: [{ events: 'window:pointermove', update: 'w + 1' }] },
    { name: 'k', value: 0, on: [{ events: 'window:keydown', update: 'k + 1' }] },
  ],
  data: [{ name: 't', values: [{ x: 1 }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }],
}) as never

const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

forEachVariant(['signals'], (Chart) => {
  describe('window listeners across re-renders', () => {
    /** The window listeners the chart holds right now: those it added and has not removed, by type. */
    function listening(add: { mock: { calls: unknown[][] } }, remove: { mock: { calls: unknown[][] } }): Map<string, number> {
      const live = new Map<string, number>()
      for (const [type] of add.mock.calls) live.set(String(type), (live.get(String(type)) ?? 0) + 1)
      for (const [type] of remove.mock.calls) live.set(String(type), (live.get(String(type)) ?? 0) - 1)
      for (const [type, n] of live) if (n === 0) live.delete(type)
      return live
    }

    it('adds nothing on any re-render that changes nothing, and holds one listener per source', () => {
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')
      try {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        roots.push(root)
        const view = (): React.ReactElement => <Chart spec={spec()} onSignal={() => undefined} signals={{}} />
        act(() => { root.render(view()) })
        const added = add.mock.calls.length
        const live = listening(add, remove)
        expect(added).toBeGreaterThan(0)
        for (let i = 0; i < 6; i++) {
          // (a new spec object, a new callback and a new `signals` literal on every render, all of equal content)
          act(() => { root.render(view()) })
          expect(add.mock.calls.length, `adds after re-render ${i + 1}`).toBe(added)
          expect(listening(add, remove), `live listeners after re-render ${i + 1}`).toEqual(live)
        }
        act(() => { root.unmount() })
        roots.pop()
        expect(listening(add, remove), 'listeners left after unmount').toEqual(new Map())
      } finally { add.mockRestore(); remove.mockRestore() }
    })

    it('a signal the chart reacts to re-binds without a leak', () => {
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')
      try {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        roots.push(root)
        act(() => { root.render(<Chart spec={spec()} />) })
        const live = listening(add, remove)
        for (let i = 0; i < 5; i++) {
          act(() => { window.dispatchEvent(new MouseEvent('pointermove')) })
          expect(listening(add, remove), `live listeners after ${i + 1} events`).toEqual(live)
        }
      } finally { add.mockRestore(); remove.mockRestore() }
    })
  })
})
