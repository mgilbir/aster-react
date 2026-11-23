/**
 * `runGate` (scripts/lib/run-gate.mjs) owns every conformance gate's verdict, so its own failure paths are tested here: a real
 * process per case (scripts/run-gate.fixture.mjs reports what it is told), its exit code and its verdict lines.
 */
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'
import { gateVerdict, intOption } from './lib/run-gate.mjs'
import { staleDist } from './lib/dist-fresh.mjs'
import { EXPECTED_DIFFERENCES } from './lib/expected-differences.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'run-gate.fixture.mjs')

async function gate(fake, ...args) {
  const r = await spawnAsync(process.execPath, [FIXTURE, ...args], { env: { ...process.env, FAKE_GATE: JSON.stringify(fake) }, timeout: 60_000 })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('runGate: the exit code is the verdict', { timeout: 60_000 }, () => {
  it('control: every case agrees and the floor is met: exit 0', async () => {
    const r = await gate({ agree: ['a', 'b'], counters: { compared: { floor: 2, what: 'cases' } } })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/\[fake\] PASS: compared 2\/2/)
  })

  it('a difference fails, and is named', async () => {
    const r = await gate({ agree: ['a'], differ: ['b'] })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/\[fake\] DIFFERS b: differs/)
  })

  it('a case that could not be compared fails, and counts toward nothing', async () => {
    const r = await gate({ agree: ['a'], error: ['b'], counters: { compared: { floor: 2, what: 'cases' } } })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/ERROR b: threw/)
    expect(r.out).toMatch(/FLOOR compared: 1 cases < 2/)
  })

  it('a problem that belongs to no case (a page error) fails', async () => {
    const r = await gate({ agree: ['a'], problems: ['page error: boom'] })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/ERROR page error: boom/)
  })

  it('the script crashing fails', async () => {
    const r = await gate({ agree: ['a'], crash: true })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/the gate script itself failed: Error: the script crashed/)
  })

  it('zero cases fail, on a full run and on a narrowed one (a filter typo)', async () => {
    for (const partial of [false, true]) {
      const r = await gate({ partial })
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/FLOOR compared: 0/)
    }
  })

  it('every counter is held to its floor on a full run; only the primary one, to 1, on a narrowed run', async () => {
    const counters = { compared: { floor: 1, what: 'cases' }, frames: { floor: 3, what: 'frames' } }
    const full = await gate({ agree: ['a'], counters })
    expect(full.code, full.out).toBe(1)
    expect(full.out).toMatch(/FLOOR frames: 0 frames < 3/)
    const narrowed = await gate({ agree: ['a'], counters, partial: true })
    expect(narrowed.code, narrowed.out).toBe(0)
  })

  it('a gate with no floor on its primary counter, or no counter at all, fails', async () => {
    expect((await gate({ agree: ['a'], counters: { compared: { floor: 0, what: 'cases' } } })).code).toBe(1)
    expect((await gate({ counters: {} })).out).toMatch(/declares no counter/)
  })

  it('--plant-difference reaches the gate, which must then fail', async () => {
    const control = await gate({ agree: ['a'], plantDiffers: true })
    expect(control.code, control.out).toBe(0)
    const planted = await gate({ agree: ['a'], plantDiffers: true }, '--plant-difference')
    expect(planted.code, planted.out).toBe(1)
    expect(planted.out).toMatch(/DIFFERS a: planted/)
    // a gate that ignores the flag passes under it: the self-test (gate-self-test.test.mjs) would catch that gate
    const deaf = await gate({ agree: ['a'] }, '--plant-difference')
    expect(deaf.code, deaf.out).toBe(0)
  })

  it('a case reported twice is an error (case names identify cases in the expected-differences table)', async () => {
    const r = await gate({ agree: ['a', 'a'] })
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/a: reported twice/)
  })
})

describe('gateVerdict: the expected-differences table', () => {
  const base = { name: 'g', counters: { compared: { floor: 1, what: 'cases' } }, counts: { compared: 2 }, partial: false, errors: [] }
  const expected = [{ gate: 'g', case: 'known', reason: 'the oracle is undefined here' }, { gate: 'other', case: 'x', reason: 'r' }]
  const outcomes = (o) => new Map(Object.entries(o))

  it('a listed case that still differs is not a failure', () => {
    const v = gateVerdict({ ...base, outcomes: outcomes({ known: { differs: 'd', error: null }, a: { differs: null, error: null } }), expected })
    expect(v.ok, v.lines.join('\n')).toBe(true)
    expect(v.lines.join('\n')).toMatch(/EXPECTED known: the oracle is undefined here/)
  })

  it('a listed case that now agrees fails the gate: the entry must be removed', () => {
    const v = gateVerdict({ ...base, outcomes: outcomes({ known: { differs: null, error: null } }), expected })
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toMatch(/FIXED-GAP known/)
  })

  it('a listed case never compared on a full run fails the gate (a stale entry); a narrowed run does not see all cases', () => {
    const v = gateVerdict({ ...base, outcomes: outcomes({ a: { differs: null, error: null } }), expected })
    expect(v.ok).toBe(false)
    expect(v.lines.join('\n')).toMatch(/STALE-GAP known/)
    expect(gateVerdict({ ...base, partial: true, outcomes: outcomes({ a: { differs: null, error: null } }), expected }).ok).toBe(true)
  })

  it("another gate's entry does not excuse this gate's case", () => {
    const v = gateVerdict({ ...base, outcomes: outcomes({ x: { differs: 'd', error: null } }), expected: [expected[1]] })
    expect(v.ok).toBe(false)
  })

  it('every entry of the real table names a gate of scripts/gates.mjs and carries its reason', async () => {
    const { GATES } = await import('./gates.mjs')
    const names = new Set(GATES.map((g) => g.name))
    for (const e of EXPECTED_DIFFERENCES) {
      expect(names.has(e.gate), `${e.gate}/${e.case}`).toBe(true)
      expect(e.reason.length, `${e.gate}/${e.case}`).toBeGreaterThan(40)
    }
    const keys = EXPECTED_DIFFERENCES.map((e) => `${e.gate}/${e.case}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('intOption: numeric flags are validated (Number("abc") is NaN, and a loop bounded by NaN never runs)', () => {
  it('reads integers at or above the minimum and the fallback when absent', () => {
    expect(intOption(undefined, '--seeds', 200, { min: 1 })).toBe(200)
    expect(intOption('3', '--seeds', 200, { min: 1 })).toBe(3)
  })

  it('exits 2 on anything else', async () => {
    for (const v of ['abc', '', '0', '-1', '1.5']) {
      const r = await spawnAsync(process.execPath, ['--input-type=module', '-e', `import { intOption } from ${JSON.stringify(join(here, 'lib', 'run-gate.mjs'))}; intOption(${JSON.stringify(v)}, '--seeds', 1, { min: 1 })`], { timeout: 30_000 })
      expect(r.status, `${JSON.stringify(v)}: ${r.stderr}`).toBe(2)
    }
  })
})

describe('staleDist: a gate never judges a build older than its sources', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'aster-dist-fresh-'))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))
  const at = (file, seconds) => utimesSync(file, seconds, seconds)
  const repo = (name) => {
    const dir = join(scratch, name)
    for (const d of ['packages/core/src/sub', 'packages/core/dist']) mkdirSync(join(dir, d), { recursive: true })
    for (const f of ['packages/core/src/a.ts', 'packages/core/src/sub/b.ts', 'packages/core/src/a.test.ts', 'packages/core/dist/a.js']) writeFileSync(join(dir, f), '')
    at(join(dir, 'packages/core/src/a.ts'), 1000)
    at(join(dir, 'packages/core/src/sub/b.ts'), 1000)
    at(join(dir, 'packages/core/src/a.test.ts'), 1000)
    at(join(dir, 'packages/core/dist/a.js'), 2000)
    return dir
  }

  it('fresh when dist was built after every compiled source', () => {
    expect(staleDist(['core'], repo('fresh'))).toBeNull()
  })

  it('stale when a compiled source (at any depth) was edited after the build', () => {
    const dir = repo('stale')
    at(join(dir, 'packages/core/src/sub/b.ts'), 3000)
    expect(staleDist(['core'], dir)).toMatch(/packages\/core\/src was edited after/)
  })

  it('a test file edited after the build does not make it stale (the build does not compile it)', () => {
    const dir = repo('test-edit')
    at(join(dir, 'packages/core/src/a.test.ts'), 3000)
    expect(staleDist(['core'], dir)).toBeNull()
  })

  it('a missing dist is stale', () => {
    const dir = repo('missing')
    rmSync(join(dir, 'packages/core/dist'), { recursive: true })
    expect(staleDist(['core'], dir)).toMatch(/dist is missing/)
  })
})
