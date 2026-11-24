// @vitest-environment jsdom
/**
 * Every test file of this package runs in React's act environment without saying so (scripts/vitest-react-act.setup.mjs): this
 * file never sets `IS_REACT_ACT_ENVIRONMENT`, and a state update outside `act` is reported by React all the same. (The setup
 * also fails a test that causes the report; this one catches it on purpose, by replacing `console.error` for the call.)
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

describe("React's act environment is on for every file", () => {
  it('the flag is set before the first test of a file that never sets it', () => {
    expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true)
  })

  it('a state update outside act is reported by React', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let set: (n: number) => void = () => {}
      function Probe(): React.ReactElement { const [n, setN] = React.useState(0); set = setN; return <b>{n}</b> }
      const host = document.createElement('div')
      const root = createRoot(host)
      act(() => { root.render(<Probe />) })
      set(1)
      await new Promise((r) => setTimeout(r, 10))
      act(() => root.unmount())
      expect(reported.mock.calls.some((c) => /not wrapped in act\(/.test(String(c[0])))).toBe(true)
    } finally {
      reported.mockRestore()
    }
  })

  it('an update inside act is not', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let set: (n: number) => void = () => {}
      function Probe(): React.ReactElement { const [n, setN] = React.useState(0); set = setN; return <b>{n}</b> }
      const host = document.createElement('div')
      const root = createRoot(host)
      act(() => { root.render(<Probe />) })
      act(() => { set(1) })
      expect(host.textContent).toBe('1')
      act(() => root.unmount())
      expect(reported).not.toHaveBeenCalled()
    } finally {
      reported.mockRestore()
    }
  })
})
