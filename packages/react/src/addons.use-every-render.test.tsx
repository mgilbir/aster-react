// @vitest-environment jsdom
/**
 * `useAddons` calls `React.use` on every render, whatever is left to load. A render that suspended on a part is replayed by React when the
 * part's promise settles; if the replay found the part loaded and skipped `use`, the hooks after it would land in other slots than the
 * attempt it replays, and React throws "Update hook called on initial render" (seen on CI with `renderer="canvas"`, timing dependent).
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VgSpec } from '@aster-charts/core'

const useCalls = vi.hoisted(() => ({ n: 0 }))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, use: <T,>(t: PromiseLike<T> | React.Context<T>) => { useCalls.n++; return actual.use(t as never) } }
})

const { useAddons } = await import('./addons')

const SPEC = { width: 10, height: 10, marks: [] } as unknown as VgSpec

function Probe({ canvas }: { canvas?: { load: () => Promise<void> } }): React.ReactElement {
  useAddons(SPEC, undefined, canvas ? { canvas } : undefined)
  const after = React.useRef(0) // a hook after `useAddons`: its slot must not move between an attempt and its replay
  after.current++
  return <i />
}

const roots: Array<{ unmount(): void }> = []
afterEach(() => { for (const r of roots.splice(0)) act(() => r.unmount()) })
/** Render under a Suspense boundary; React retries a suspended tree only once the act scope that rendered it is awaited (`done`). */
function render(el: React.ReactElement): { c: HTMLDivElement; done: PromiseLike<void> } {
  const c = document.createElement('div')
  const root = createRoot(c)
  roots.push(root)
  const done = act(() => { root.render(<React.Suspense fallback={<b />}>{el}</React.Suspense>) }) as unknown as PromiseLike<void>
  return { c, done }
}

describe('useAddons', () => {
  it('calls React.use on a render with nothing left to load', () => {
    useCalls.n = 0
    const { c } = render(<Probe />)
    expect(c.innerHTML).toBe('<i></i>')
    expect(useCalls.n).toBeGreaterThan(0)
  })
})
