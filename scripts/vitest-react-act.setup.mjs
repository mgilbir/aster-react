/**
 * Tell React that every test file runs in a test environment (`IS_REACT_ACT_ENVIRONMENT`), and fail a test that updates state
 * outside `act`.
 *
 * React's "An update to X inside a test was not wrapped in act(...)" warning, and its guarantee that `act` flushes effects, are
 * on only while this flag is true. A file that calls `act` without setting it gets neither: a state update outside `act` is
 * silent and the assertion that follows it races the render (23 of the react package's test files were in that state, some
 * switching the flag on mid-file from the first test of the variant matrix that happened to run). Setting it once here, before
 * any file runs, makes it true for every file whichever test ran first. It is inert for files that never load React.
 *
 * The warning itself is a `console.error`, which a test reads as noise and moves on from. A test that causes one has a
 * missing `act`, so it fails: the warning is recorded while the test runs and reported when it ends. (A test that exercises
 * the warning on purpose says so by catching it itself: it replaces `console.error` for the call.)
 */
import { afterEach, beforeEach } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ACT_WARNING = /not wrapped in act\(|not configured to support act\(/
let seen = []
let wrapped = null

beforeEach(() => {
  seen = []
  const outer = console.error
  const guard = (...args) => {
    const first = typeof args[0] === 'string' ? args[0] : ''
    if (ACT_WARNING.test(first)) seen.push(first.replace(/%s/, String(args[1] ?? '?')).split('\n')[0].replace(/\.$/, ''))
    return outer.apply(console, args)
  }
  wrapped = { outer, guard }
  console.error = guard
})

afterEach(() => {
  if (wrapped && console.error === wrapped.guard) console.error = wrapped.outer
  wrapped = null
  if (seen.length) {
    const lines = [...new Set(seen)]
    seen = []
    throw new Error(`React reported ${lines.length === 1 ? 'a state update' : 'state updates'} outside act(...): ${lines.join(' | ')}. Wrap the update (or the wait for it) in act.`)
  }
})
