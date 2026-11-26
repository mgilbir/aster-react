/**
 * Let the event loop turn once: a macrotask boundary inside a long test.
 *
 * A vitest worker reports to the host over an RPC with a 60 s timeout (`Timeout calling "onTaskUpdate"`), and only reads the host's
 * reply when its event loop turns. scripts/vitest-yield.setup.mjs turns it between tests; a test whose own loop runs longer than a
 * minute on a loaded machine (a sweep over thousands of cases, every one answered synchronously or by an already-resolved promise: an
 * `await` of one never leaves the microtask queue) must turn it itself, between cases:
 *
 *     for (const c of cases) { check(c); await turn() }
 *
 * `turn` costs one `setImmediate` (about a microsecond of CPU); a loop that makes a case in tens of milliseconds can call it every case.
 */
export function turn() {
  return new Promise((resolve) => setImmediate(resolve))
}
