import { describe, it, expect } from 'vitest'
import { DeadlineError, within } from './deadline.js'

describe('the deadline of the browser gates', () => {
  it('lets work that answers in time answer', async () => {
    await expect(within(1000, 'quick', new Promise<number>((r) => setTimeout(() => { r(7) }, 5)))).resolves.toBe(7)
  })
  it('fails work that never answers, naming it (a page that waits does not fail on its own)', async () => {
    await expect(within(30, 'seed 26', new Promise<never>(() => undefined))).rejects.toThrow('seed 26 did not finish within 0.03s')
    await expect(within(30, 'seed 26', new Promise<never>(() => undefined))).rejects.toBeInstanceOf(DeadlineError)
  })
  it('passes on what the work failed with', async () => {
    await expect(within(1000, 'x', Promise.reject(new Error('boom')))).rejects.toThrow('boom')
  })
})
