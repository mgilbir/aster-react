// @vitest-environment node
/**
 * The recorded oracle vectors (`packages/core/testdata/vectors/*.json`) are reproducible: running the committed
 * generator (`scripts/gen-vectors.mjs`) against the pinned upstream writes the committed files again.
 *
 *  - two regenerations are byte-identical (no clock, no randomness, no host state in a recording; the first
 *    recording held `Date.now()` as an `isDate` input, so every regeneration rewrote it);
 *  - the committed files are what the generator writes now (a vector edited by hand, or a generator change that
 *    was not re-recorded, fails here). The colour file is compared within the replay's tolerance: its maths goes
 *    through Math.cbrt / Math.pow, whose last bit differs between V8 builds, so it is not byte-stable across Node
 *    versions (the replay in packages/core/src/oracle-vectors.test.ts compares it the same way).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const generator = join(here, '..', 'scripts', 'gen-vectors.mjs')
const committed = join(here, '..', '..', 'core', 'testdata', 'vectors')
const BYTE_UNSTABLE_ACROSS_ENGINES = new Set(['d3-color.json'])

const scratch: string[] = []
function regenerate(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aster-vectors-'))
  scratch.push(dir)
  execFileSync(process.execPath, [generator, '--out', dir], { stdio: 'pipe', timeout: 120_000 })
  return dir
}
afterAll(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })

const NUM = /[-+]?\d+\.\d+(?:e[+-]?\d+)?/gi

/** Same shape, same strings, numbers (also inside strings) within the replay's tolerance. */
function close(a: unknown, b: unknown, path: string): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-6 + 1e-9 * Math.abs(b) ? null : `${path}: ${a} vs ${b}`
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const ta = a.split(NUM), tb = b.split(NUM)
    if (ta.length !== tb.length || ta.some((t, i) => t !== tb[i])) return `${path}: ${a} vs ${b}`
    const na = (a.match(NUM) ?? []).map(Number), nb = (b.match(NUM) ?? []).map(Number)
    for (let i = 0; i < nb.length; i++) {
      if (Math.abs(na[i]! - nb[i]!) > 1e-6 + 1e-9 * Math.abs(nb[i]!)) return `${path}: ${a} vs ${b}`
    }
    return null
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) { const r = close(a[i], b[i], `${path}[${i}]`); if (r) return r }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort()
    if (ka.join() !== kb.join()) return `${path}: keys ${ka} vs ${kb}`
    for (const k of kb) { const r = close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); if (r) return r }
    return null
  }
  return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`
}

describe('oracle vectors are reproducible from the pinned upstream', () => {
  const first = regenerate()
  const second = regenerate()
  const files = readdirSync(committed).filter((f) => f.endsWith('.json')).sort()

  it('writes every committed file, and nothing else', () => {
    expect(readdirSync(first).sort()).toEqual(files)
  })

  for (const file of files) {
    it(`${file}: a second regeneration is byte-identical`, () => {
      expect(readFileSync(join(second, file), 'utf8') === readFileSync(join(first, file), 'utf8')).toBe(true)
    })
    it(`${file}: the committed recording is what the generator writes`, () => {
      const want = readFileSync(join(committed, file), 'utf8')
      const got = readFileSync(join(first, file), 'utf8')
      if (!BYTE_UNSTABLE_ACROSS_ENGINES.has(file)) {
        expect(got === want, `${file} differs from a fresh recording: run \`pnpm vectors\` and review the diff`).toBe(true)
        return
      }
      const diff = close(JSON.parse(got), JSON.parse(want), '$')
      expect(diff, `${file} differs from a fresh recording`).toBeNull()
    })
  }
})
