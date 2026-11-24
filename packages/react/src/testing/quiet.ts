/**
 * The add-on auto-load tests look at the first commit of a suspended tree (the Suspense fallback, with no error) before they await the
 * `act` scope, because only a synchronous act can show that no import has settled yet. React warns about exactly that ("A component
 * suspended inside an `act` scope, but the `act` call was not awaited"); the tests do await it, one line later. This drops that one
 * message and nothing else, for the file that calls it, and puts `console.error` back when the file is done.
 */
import { afterAll, beforeAll, vi, type MockInstance } from 'vitest'

export function ignoreSuspendedActWarning(): void {
  let spy: MockInstance | undefined
  beforeAll(() => {
    const log = console.error.bind(console)
    spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]): void => {
      if (typeof args[0] === 'string' && args[0].includes('suspended inside an `act` scope')) return
      log(...args)
    })
  })
  afterAll(() => { spy?.mockRestore() })
}
