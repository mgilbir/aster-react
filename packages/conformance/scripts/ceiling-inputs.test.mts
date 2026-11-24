/**
 * The inputs the differentials cannot draw: counts and steps on which the oracle itself dies (a tick count of 2^32 or more, an
 * infinite one, a bin step that lists a billion cells, `sequence` to Infinity). Vega loops or runs out of memory on them, so
 * there is nothing to compare; Aster's own guarantee is what is held here: the built-in ceilings (docs/LIMITS.md, `items`) refuse
 * them, with or without `limits`, at once and before anything is allocated (C22, C353).
 *
 * Every case runs in a child process with a small heap and a deadline, so a ceiling that stops holding fails this test (a killed
 * child, a heap abort, a timeout) instead of taking the test runner down with it. The child renders each spec with
 * `renderSpec` from the built core and reports how each ended.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CORE = fileURLToPath(new URL('../../core/dist/index.js', import.meta.url))
const DOMAINS: Record<string, string> = { time: '[1577836800000,1609459200000]', utc: '[1577836800000,1609459200000]', linear: '[0,100]', log: '[1,1000]', pow: '[0,100]', sqrt: '[0,100]', symlog: '[0,100]' }

type Ended = { how: 'ok' | 'logged' | 'threw'; name?: string; message?: string }
interface Case { name: string; spec: string; limits?: Record<string, unknown> }

function runAll(cases: Case[]): Record<string, Ended> {
  const script = `
    import { renderSpec } from ${JSON.stringify(CORE)}
    const cases = JSON.parse(process.argv.at(-1))
    const out = {}
    for (const c of cases) {
      let logged
      try {
        renderSpec(JSON.parse(c.spec), { logger: { error: (e) => { logged ??= e }, warn() {} }, ...(c.limits ? { limits: c.limits } : {}) })
        out[c.name] = logged ? { how: 'logged', name: logged.name, message: String(logged.message).slice(0, 160) } : { how: 'ok' }
      } catch (e) {
        out[c.name] = { how: 'threw', name: e.name, message: String(e.message).slice(0, 160) }
      }
    }
    console.log(JSON.stringify(out))`
  const run = spawnSync(process.execPath, ['--max-old-space-size=300', '--input-type=module', '-e', script, JSON.stringify(cases)], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1 << 24 })
  expect(run.error, `the child did not finish in 60 s: ${run.error?.message}`).toBeUndefined()
  expect(run.status, `the child died (${run.signal}): ${run.stderr.slice(0, 300)}`).toBe(0)
  return JSON.parse(run.stdout.trim().split('\n').at(-1)!) as Record<string, Ended>
}

const guide = (kind: 'axis' | 'legend', tickCount: string): string =>
  kind === 'axis' ? `"axes":[{"orient":"bottom","scale":"x","tickCount":${tickCount}}]` : `"legends":[{"fill":"x","tickCount":${tickCount}}]`
const specOf = (type: string, scaleExtra: string, guides: string): string =>
  `{"width":300,"height":40,"scales":[{"name":"x","type":"${type}","domain":${DOMAINS[type]},"range":"width"${scaleExtra}}],${guides}}`

/** Counts no chart means: past 2^32 (an array length no more), infinite, a signal that divides by zero. */
const HOSTILE_COUNTS = ['4294967296', '1e308', '1e400', '{"signal":"1/0"}']
const NON_FINITE_OR_NAN = ['-1e400', '{"signal":"0/0"}']

describe('a count the spec sets is refused by the built-in ceiling, or ends at once, with or without limits', () => {
  const cases: Case[] = []
  for (const type of Object.keys(DOMAINS)) {
    for (const kind of ['axis', 'legend'] as const) {
      for (const tc of [...HOSTILE_COUNTS, ...NON_FINITE_OR_NAN]) {
        cases.push({ name: `${type} ${kind} tickCount ${tc}`, spec: specOf(type, '', guide(kind, tc)) })
        cases.push({ name: `${type} ${kind} tickCount ${tc} (limits)`, spec: specOf(type, '', guide(kind, tc)), limits: { maxTimeMs: 500, maxItems: 1000 } })
      }
    }
  }
  let memo: Record<string, Ended> | undefined
  const ended = new Proxy({} as Record<string, Ended>, { get: (_t, k) => (memo ??= runAll(cases))[k as string], ownKeys: () => Object.keys((memo ??= runAll(cases))), getOwnPropertyDescriptor: (_t, k) => ({ enumerable: true, configurable: true, value: (memo ??= runAll(cases))[k as string] }) })

  it('every case ended (none hung, none ran out of memory)', () => {
    expect(Object.keys(ended).length).toBe(cases.length)
  })

  it('a time or utc scale refuses a tick count of 2^32 or more, or infinite, as an AsterLimitError (the C22 inputs)', () => {
    let refused = 0
    for (const type of ['time', 'utc']) for (const kind of ['axis', 'legend']) for (const tc of HOSTILE_COUNTS) for (const suffix of ['', ' (limits)']) {
      const r = ended[`${type} ${kind} tickCount ${tc}${suffix}`]!
      expect(r, `${type} ${kind} ${tc}${suffix}`).toMatchObject({ how: 'threw', name: 'AsterLimitError' })
      refused++
    }
    expect(refused).toBe(2 * 2 * HOSTILE_COUNTS.length * 2)
  })

  it('every other scale ends too: its own count or an Invalid array length where an array that size is asked for, never a hang', () => {
    for (const [name, r] of Object.entries(ended)) {
      if (r.how === 'ok') continue
      expect(`${r.name}: ${r.message}`, name).toMatch(/AsterLimitError|RangeError: \[?.*Invalid array length|RangeError: Invalid array length/)
    }
  })

  it('a count that is not a number the scale can use (-Infinity, NaN) draws, as in vega', () => {
    for (const type of Object.keys(DOMAINS)) for (const kind of ['axis', 'legend']) for (const tc of NON_FINITE_OR_NAN) {
      expect(ended[`${type} ${kind} tickCount ${tc}`]!.how, `${type} ${kind} ${tc}`).toBe('ok')
    }
  })
})

describe('a bin step or a sequence that would list a billion entries is refused', () => {
  const cases: Case[] = [
    { name: 'linear bins step 1e-9', spec: specOf('linear', ',"bins":{"step":1e-9}', '"axes":[{"orient":"bottom","scale":"x"}]') },
    { name: 'linear bins step 1e-9 (limits)', spec: specOf('linear', ',"bins":{"step":1e-9}', '"axes":[{"orient":"bottom","scale":"x"}]'), limits: { maxTimeMs: 500, maxItems: 1000 } },
    { name: 'sequence to Infinity', spec: '{"data":[{"name":"d","transform":[{"type":"sequence","start":0,"stop":1e400}]}]}' },
    { name: 'sequence to 1e12', spec: '{"data":[{"name":"d","transform":[{"type":"sequence","start":0,"stop":1e12}]}]}' },
    { name: 'sequence by a step of 1e-12', spec: '{"data":[{"name":"d","transform":[{"type":"sequence","start":0,"stop":1,"step":1e-12}]}]}' },
  ]
  let memo: Record<string, Ended> | undefined
  const endedOf = (): Record<string, Ended> => (memo ??= runAll(cases))
  it('each ends as an AsterLimitError', () => {
    for (const c of cases) expect(endedOf()[c.name], c.name).toMatchObject({ how: 'threw', name: 'AsterLimitError' })
  })
})
