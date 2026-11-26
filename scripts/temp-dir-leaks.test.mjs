/**
 * No test, gate or script leaves a temporary directory behind (the machine's disk once filled with ~18,000 `aster-*` directories,
 * 394 GB, over four weeks of gate runs).
 *
 * - scripts/lib/temp-dir.mjs removes what it makes on every way a directory's owner can end: the callback returns, throws or rejects;
 *   the process exits, exits with an error, throws uncaught, is sent SIGINT / SIGTERM / SIGHUP. Each case runs in a child process whose TMPDIR
 *   is a fresh directory of this test's, and asserts that directory is empty afterwards.
 * - the gate runner (scripts/gates.mjs) runs every gate with TMPDIR pointed at a fresh directory and FAILS a gate that leaves anything
 *   in it, so a new leak anywhere in a gate fails `pnpm check`. This file plants a leaking gate and watches it fail.
 * - no file makes a temp directory by any other way than the helper (a source scan: a new `mkdtemp` call fails here).
 * The suites that make temp directories run under the same sandbox in the `test` gate (their own checks: verify-publish.test.mjs,
 * packages/core/src/attack.testkit.test.ts).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { runGate, runGates } from './gates.mjs'
import { makeTempDir, removeTempDir, sandboxEnv, withTempDir, withTempDirSync } from './lib/temp-dir.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HELPER = join(root, 'scripts', 'lib', 'temp-dir.mjs')
const LAUNCHER = join(root, 'scripts', 'lib', 'launch-browser.mjs')
const sandboxRoot = makeTempDir('aster-leak-test-')
afterAll(() => removeTempDir(sandboxRoot))
let n = 0
/** A fresh, empty directory to be some process's TMPDIR. */
const sandbox = () => {
  const dir = join(sandboxRoot, `tmp${n++}`)
  mkdirSync(dir)
  return dir
}
const entries = (dir) => readdirSync(dir)

describe('withTempDir / makeTempDir remove what they make', () => {
  // (os.tmpdir() reads TMPDIR on every call, so a sandboxed TMPDIR is enough to observe what the helper makes)
  const inSandbox = async (fn) => {
    const old = process.env.TMPDIR
    const box = sandbox()
    process.env.TMPDIR = box
    try { await fn(box) } finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old }
    return box
  }

  it('on return, with the callback\'s value', async () => {
    const box = await inSandbox(async (b) => {
      const seen = await withTempDir('aster-t-', (dir) => { expect(existsSync(dir)).toBe(true); expect(dir.startsWith(b)).toBe(true); return 42 })
      expect(seen).toBe(42)
    })
    expect(entries(box)).toEqual([])
  })

  it('on a thrown error and on a rejected promise (the error still reaches the caller)', async () => {
    const box = await inSandbox(async () => {
      await expect(withTempDir('aster-t-', () => { throw new Error('boom') })).rejects.toThrow('boom')
      await expect(withTempDir('aster-t-', async () => { throw new Error('later') })).rejects.toThrow('later')
      expect(() => withTempDirSync('aster-t-', () => { throw new Error('sync') })).toThrow('sync')
    })
    expect(entries(box)).toEqual([])
  })

  it('removeTempDir is idempotent, and the directory is gone while the caller is still running', async () => {
    const box = await inSandbox(() => {
      const d = makeTempDir('aster-t-')
      expect(entries(d)).toEqual([])
      removeTempDir(d)
      removeTempDir(d)
      expect(existsSync(d)).toBe(false)
    })
    expect(entries(box)).toEqual([])
  })
})

describe('what is still alive when the process ends is removed (no `finally` runs there)', () => {
  /** Run `body` in a child with TMPDIR = a fresh directory; the body can use `makeTempDir`. Returns the child's result and the sandbox. */
  const child = (body, env = {}) => {
    const box = sandbox()
    const code = `import { makeTempDir, withTempDir } from ${JSON.stringify(HELPER)}\nimport { writeFileSync } from 'node:fs'\nimport { join } from 'node:path'\n${body}`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...sandboxEnv(box), ...env }, encoding: 'utf8', timeout: 30_000 })
    return { r, box }
  }
  const fill = `const d = makeTempDir('aster-leak-'); writeFileSync(join(d, 'big'), 'x'.repeat(1 << 16));\n`

  it('process.exit(1) inside a try (the script\'s `finally` does not run)', () => {
    const { r, box } = child(`${fill} try { process.exit(1) } finally { }`)
    expect(r.status).toBe(1)
    expect(entries(box)).toEqual([])
  })
  it('an uncaught exception', () => {
    const { r, box } = child(`${fill} throw new Error('uncaught')`)
    expect(r.status).not.toBe(0)
    expect(entries(box)).toEqual([])
  })
  it('process.exit inside the callback of withTempDir (the callback has not finished)', () => {
    const { r, box } = child(`await withTempDir('aster-leak-', async (d) => { writeFileSync(join(d, 'f'), 'x'); process.exit(3) })`)
    expect(r.status).toBe(3)
    expect(entries(box)).toEqual([])
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    it(`${signal} (the process still ends by that signal)`, () => {
      const { r, box } = child(`${fill} process.kill(process.pid, ${JSON.stringify(signal)}); await new Promise((res) => setTimeout(res, 20_000))`)
      expect(r.signal).toBe(signal)
      expect(entries(box)).toEqual([])
    })
  }
  it('a signal another handler owns: that handler decides how the process ends (the directory is removed first)', () => {
    const { r, box } = child(`${fill} process.on('SIGTERM', () => process.exit(7)); process.kill(process.pid, 'SIGTERM'); await new Promise((res) => setTimeout(res, 20_000))`)
    expect(r.status).toBe(7)
    expect(entries(box)).toEqual([])
  })
})

describe('a browser launched with launchBrowser leaves nothing in the temp dir, however its script ends (Playwright alone has left ~100 MB)', () => {
  // `fake` stands for Playwright: it makes its profile directory in the OS temp dir at launch, as Playwright does, and removes it only in close().
  const run = (ending, { real = false } = {}) => {
    const box = sandbox()
    const code = `import { launchBrowser } from ${JSON.stringify(join(root, 'scripts', 'lib', 'launch-browser.mjs'))}
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
${real ? "import { chromium } from 'playwright'" : ''}
const fake = { launch: async () => {
  const profile = mkdtempSync(join(tmpdir(), 'playwright_chromiumdev_profile-'))
  writeFileSync(join(profile, 'Cookies'), 'x'.repeat(1 << 16))
  const b = new EventEmitter()
  b.close = async () => { rmSync(profile, { recursive: true }); b.emit('disconnected') }
  return b
} }
const browser = await launchBrowser(${real ? 'chromium' : 'fake'}, { headless: true })
${ending}`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: join(root, 'packages', 'conformance'), env: { ...process.env, ...sandboxEnv(box) }, encoding: 'utf8', timeout: 90_000 })
    return { r, box }
  }
  it('closed', () => {
    const { r, box } = run('await browser.close()')
    expect(r.status, r.stderr).toBe(0)
    expect(entries(box)).toEqual([])
  })
  it('the script throws before it closes', () => {
    const { r, box } = run("throw new Error('the check failed')")
    expect(r.status).toBe(1)
    expect(entries(box)).toEqual([])
  })
  it('the script calls process.exit before it closes', () => {
    const { r, box } = run('process.exit(2)')
    expect(r.status).toBe(2)
    expect(entries(box)).toEqual([])
  })
  it('the script is ended by a signal before it closes', () => {
    const { r, box } = run("process.kill(process.pid, 'SIGTERM'); await new Promise((res) => setTimeout(res, 20_000))")
    expect(r.signal).toBe('SIGTERM')
    expect(entries(box)).toEqual([])
  })
  it('the browser cannot be launched (the directory made for it goes too)', () => {
    const box = sandbox()
    const code = `import { launchBrowser } from ${JSON.stringify(join(root, 'scripts', 'lib', 'launch-browser.mjs'))}
await launchBrowser({ launch: async () => { throw new Error('no browser') } }).catch((e) => console.log(e.message))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...sandboxEnv(box) }, encoding: 'utf8', timeout: 30_000 })
    expect(r.stdout.trim()).toBe('no browser')
    expect(entries(box)).toEqual([])
  })
  it('real Chromium, thrown before close (a race inside Playwright\'s own clean-up on exit no longer leaves its profile)', () => {
    const { r, box } = run("await browser.newPage(); throw new Error('the check failed')", { real: true })
    expect(r.status).toBe(1)
    expect(entries(box)).toEqual([])
  }, 120_000)
})

describe('the gate runner fails a gate that leaves a temp directory, on every way the gate can end', () => {
  const tmpLeaker = (name, body) => ({ name, command: process.execPath, args: ['--input-type=commonjs', '-e', `const fs = require('node:fs'), os = require('node:os'), path = require('node:path'); fs.mkdirSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leak-')) + '/x'); ${body}`], why: 't' })
  const quiet = { stdio: 'ignore' }
  const runAll = async (gates) => {
    const lines = []
    const log = console.log
    const err = console.error
    console.log = (...a) => { lines.push(a.join(' ')) }
    console.error = (...a) => { lines.push(a.join(' ')) }
    let code
    try { code = await runGates(gates, { run: (g, opts) => runGate(g, { ...quiet, ...opts }) }) } finally { console.log = log; console.error = err }
    return { code, out: lines.join('\n') }
  }

  it('a gate that cleans up passes, and ran with its own TMPDIR (not ours)', async () => {
    const seen = join(sandboxRoot, 'gate-tmpdir')
    const code = `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');fs.writeFileSync(${JSON.stringify(seen)}, os.tmpdir());const d=fs.mkdtempSync(p.join(os.tmpdir(),'ok-'));fs.rmSync(d,{recursive:true})`
    const { code: exit, out } = await runAll([{ name: 'clean', command: process.execPath, args: ['-e', code], why: 't' }])
    expect(exit, out).toBe(0)
    const gateTmp = readFileSync(seen, 'utf8')
    expect(gateTmp).not.toBe(tmpdir())
    expect(existsSync(gateTmp), 'the gate\'s temp dir is removed after it').toBe(false)
  })
  it('tsx\'s own per-user directory (one fixed name, reused by every run) is the one entry a gate may leave; any other name fails', async () => {
    const mk = (name) => ({ name: 'tool', command: process.execPath, args: ['-e', `const fs=require('node:fs'),os=require('node:os'),p=require('node:path');fs.mkdirSync(p.join(os.tmpdir(), ${JSON.stringify(name)}))`], why: 't' })
    expect((await runAll([mk(`tsx-${process.getuid()}`)])).code).toBe(0)
    expect((await runAll([mk(`tsx-${process.getuid() + 1}`)])).code).toBe(1)
  })
  it('a gate that exits 0 and leaves a directory fails with `left temp dirs`, and the leftover is removed', async () => {
    const { code, out } = await runAll([tmpLeaker('leak-ok', '')])
    expect(code).toBe(1)
    expect(out).toMatch(/leak-ok left 1 entry in its temp dir/)
    expect(out).toMatch(/FAIL {2}leak-ok .*\(left temp dirs\)/)
  })
  it('a gate that leaves a directory and then fails still reports the leak', async () => {
    const { code, out } = await runAll([tmpLeaker('leak-fail', 'process.exit(1)')])
    expect(code).toBe(1)
    expect(out).toMatch(/leak-fail \(left temp dirs\)/)
  })
  it('the directory is not an artefact of the run: every gate gets its own, so one leak is not charged to the next gate', async () => {
    const { code, out } = await runAll([tmpLeaker('first', ''), { name: 'second', command: process.execPath, args: ['-e', ''], why: 't' }])
    expect(code).toBe(1)
    expect(out).toMatch(/FAIL {2}first/)
    expect(out).toMatch(/PASS {2}second/)
  })
})

describe('only the helper makes a temp directory', () => {
  const SKIP = new Set(['node_modules', 'dist', '.git', '.gallery', 'coverage'])
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || name.startsWith('.tmp')) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(m?[jt]sx?|cjs)$/.test(name) && !name.endsWith('.d.mts')) out.push(p)
    }
    return out
  }
  it('no source file calls mkdtemp, builds a path in the OS temp dir by hand or launches a browser by hand (scripts/lib/temp-dir.mjs and launch-browser.mjs do)', () => {
    const offenders = []
    for (const dir of ['scripts', 'packages', 'apps']) {
      for (const file of walk(join(root, dir))) {
        if (file === HELPER || file === LAUNCHER || file === fileURLToPath(import.meta.url)) continue
        const text = readFileSync(file, 'utf8')
        if (/\bmkdtemp(Sync)?\b|\btmpdir\s*\(|\.launch\(/.test(text)) offenders.push(relative(root, file))
      }
    }
    expect(offenders, 'make temp directories with makeTempDir / withTempDir (scripts/lib/temp-dir.mjs) and launch browsers with launchBrowser (scripts/lib/launch-browser.mjs)').toEqual([])
  })
})
