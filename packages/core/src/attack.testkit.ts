/**
 * Test kit: run an attack in a CHILD PROCESS with a hard kill timeout.
 *
 * A regression that lets an attack through would otherwise hang (or exhaust the
 * memory of) the test runner itself. The child bundles the real sources with
 * esbuild, runs the attack body, and reports the error it got plus the wall time
 * measured INSIDE the child (so node start-up is not counted).
 * Excluded from the published build (tsconfig.build.json).
 */
import { expect } from 'vitest'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), 'aster-limits-'))
process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ } })

/** Allowance on top of 2 * maxTimeMs for one uninterruptible chunk of work and GC. */
export const SLACK_MS = 400
/** Parent-side hard limit: the child is SIGKILLed past this, whatever it is doing. */
export const HARD_KILL_MS = 20_000

export interface AttackResult {
  threw: { name: string; code?: string; message: string } | null
  /** Whatever the body returned (must be JSON-serialisable). */
  value?: unknown
  /** Wall time inside the child, from the start of the attack to the throw/return. */
  ms: number
  killed: boolean
  stderr: string
}

const trellisSpec = readFileSync(join(here, '..', 'testdata', 'limits-trellis.vg.json'), 'utf8')

let counter = 0
/**
 * Run `body` (async JS with `core` and `trellisSpec` in scope; may `return` a
 * JSON value) in a child process with a 512 MB heap cap and a hard kill.
 */
export async function attack(body: string): Promise<AttackResult> {
  const entry = `
    import * as core from ${JSON.stringify(join(here, 'index.ts'))}
    import ${JSON.stringify(join(here, 'addon-load.ts'))}
    import ${JSON.stringify(join(here, 'addon-geo.ts'))}
    import ${JSON.stringify(join(here, 'addon-transforms.ts'))}
    const trellisSpec = ${JSON.stringify(trellisSpec)}
    const t0 = performance.now()
    let threw = null
    let value
    try { value = await (async () => { ${body} })() } catch (e) {
      threw = { name: e && e.name, code: e && e.code, message: String(e && e.message).slice(0, 300) }
    }
    console.log('RESULT ' + JSON.stringify({ threw, value, ms: performance.now() - t0 }))
  `
  const out = await build({
    stdin: { contents: entry, resolveDir: here, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent', target: 'node20',
    // The addons are imported bare, for their registration. package.json's `sideEffects` lists DIST files, so it would mark
    // these src files side-effect free and drop them; this harness tests behaviour, not tree-shaking (check:bundle does).
    ignoreAnnotations: true,
  })
  const file = join(scratch, `attack-${++counter}.mjs`)
  writeFileSync(file, out.outputFiles[0]!.text)
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--max-old-space-size=512', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let killed = false
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, HARD_KILL_MS)
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
      const parsed = line ? (JSON.parse(line.slice(7)) as { threw: AttackResult['threw']; value?: unknown; ms: number }) : { threw: null, ms: Infinity }
      resolve({ ...parsed, killed, stderr: stderr.slice(0, 500) })
    })
  })
}

/** The attack must fail with an AsterLimitError naming `fragment`, in bounded time. */
export function expectLimit(r: AttackResult, fragment: RegExp, maxTimeMs?: number): void {
  expect(r.killed, `child had to be killed (hang). stderr: ${r.stderr}`).toBe(false)
  expect(r.threw, `no error thrown (the attack succeeded). stderr: ${r.stderr}`).not.toBeNull()
  expect(r.threw!.name, JSON.stringify(r)).toBe('AsterLimitError')
  expect(r.threw!.code).toBe('ASTER_LIMIT')
  expect(r.threw!.message).toMatch(fragment)
  if (maxTimeMs != null) expect(r.ms).toBeLessThan(2 * maxTimeMs + SLACK_MS)
}
