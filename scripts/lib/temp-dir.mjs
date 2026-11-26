/**
 * The one way a test, a gate or a script makes a temporary directory.
 *
 * Every directory made here is removed when its owner is done with it: when `withTempDir`'s callback returns, throws or rejects;
 * when `removeTempDir` is called (an `afterAll`); and, for whatever is still alive when the process ends, on `exit` and on
 * SIGINT / SIGTERM / SIGHUP (a killed gate, a Ctrl-C). A process ended by SIGKILL cannot clean up after itself: a parent that starts
 * a child which writes into a directory owns that directory (make it in the parent, remove it in the parent's `finally`).
 *
 * Nothing else in the repository calls `mkdtemp`: scripts/temp-dir-leaks.test.mjs fails the gate on a new call site, and runs the
 * affected suites and scripts with TMPDIR pointed at a fresh directory and asserts nothing is left in it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {Set<string>} */
const live = new Set()
let hooked = false

function sweepAll() {
  for (const dir of live) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch { /* the process is ending: nothing better to do */ }
  }
  live.clear()
}

function hook() {
  if (hooked) return
  hooked = true
  process.on('exit', sweepAll)
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
    const onSignal = () => {
      sweepAll()
      process.off(signal, onSignal)
      // Ours was the only handler: restore the default (the signal ends the process). Another handler owns the shutdown otherwise.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    }
    process.on(signal, onSignal)
  }
}

/**
 * Make a directory under the OS temp dir (`$TMPDIR`), named `<prefix><random>`, and remember it so that it is removed at the latest
 * when the process ends. Prefer `withTempDir`; use this where the directory's life spans several hooks, with `removeTempDir` in the last.
 * @param {string} prefix
 * @param {string} [base] the directory to make it in, for a script whose files must resolve packages from a place in the repository
 *   (a gitignored `.tmp*` directory); the OS temp dir by default
 * @returns {string}
 */
export function makeTempDir(prefix, base = tmpdir()) {
  const dir = mkdtempSync(join(base, prefix))
  live.add(dir)
  hook()
  return dir
}

/** Remove a directory made by `makeTempDir`. Safe to call twice. @param {string} dir */
export function removeTempDir(dir) {
  live.delete(dir)
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * Run `fn(dir)` with a fresh temp directory and remove it afterwards, whether `fn` returns, throws or rejects.
 * @template T
 * @param {string} prefix
 * @param {(dir: string) => T | Promise<T>} fn
 * @returns {Promise<Awaited<T>>}
 */
export async function withTempDir(prefix, fn) {
  const dir = makeTempDir(prefix)
  try {
    return await fn(dir)
  } finally {
    removeTempDir(dir)
  }
}

/** Sync form of `withTempDir`, for `fn` that does not await. @template T @param {string} prefix @param {(dir: string) => T} fn @returns {T} */
export function withTempDirSync(prefix, fn) {
  const dir = makeTempDir(prefix)
  try {
    return fn(dir)
  } finally {
    removeTempDir(dir)
  }
}

/**
 * The environment of a process whose OS temp dir is `dir` (a sandbox that must end empty). Node's compile cache lives in
 * `$TMPDIR/node-compile-cache` unless told otherwise (tsc, vite and pnpm turn it on): it is a cache, not a leak, so it is kept outside
 * the sandbox, in node_modules/.cache, where every run shares it.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function sandboxEnv(dir) {
  const compileCache = process.env.NODE_COMPILE_CACHE ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', '.cache', 'node-compile-cache')
  return { TMPDIR: dir, TMP: dir, TEMP: dir, NODE_COMPILE_CACHE: compileCache }
}
