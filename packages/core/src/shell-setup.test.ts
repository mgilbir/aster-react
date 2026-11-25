// @vitest-environment node
/**
 * The pulse path the React shells load on demand (shell-setup.ts): a failed import is not retried -- every evaluation still makes the
 * same scene, in full -- and it is said once, as a warning, never swallowed (C501).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./addons.js', () => ({ loadParts: vi.fn(() => Promise.reject(new Error('network down'))) }))
vi.mock('./engine-parts.js', () => ({ setPartRequester: vi.fn() }))

afterEach(() => { vi.restoreAllMocks() })

describe('a pulse part that fails to load (C501)', () => {
  it('is said once, as a warning naming the cause, and not asked for again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { setUpShell } = await import('./shell-setup.js')
    const { setPartRequester } = await import('./engine-parts.js')
    const { loadParts } = await import('./addons.js')
    setUpShell()
    const requester = vi.mocked(setPartRequester).mock.calls[0]![0] as (name: string) => void
    requester('pulse')
    await new Promise((r) => setTimeout(r, 0))
    requester('pulse')
    requester('time')
    await new Promise((r) => setTimeout(r, 0))
    expect(vi.mocked(loadParts)).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/pulse.*failed to load.*network down/)
  })
})
