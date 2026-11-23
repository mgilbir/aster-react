/**
 * ADR 0009: "Generated suites scale with `ASTER_DIFF_SCALE`". The variable has one reader, `scaled()` of differential-gen.mts, so a
 * generated suite that never calls it is a suite the deep local sweep (`ASTER_DIFF_SCALE=10`) silently leaves at its default count.
 * Every `*-gen.test.mts` / `*-generated.test.mts` file here must import `scaled` and call it (C760): the arc, selections, expression and
 * interpreter suites did not, nor did the shape and geo ones.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { scaled } from './differential-gen.mts'

const HERE = dirname(fileURLToPath(import.meta.url))
const generated = readdirSync(HERE).filter((f) => /(-gen|-generated)\.test\.mts$/.test(f)).sort()
/** The source of a file without its comments and string literals' contents, so a mention is not a call. */
const code = (f: string): string => readFileSync(join(HERE, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('every generated differential scales with ASTER_DIFF_SCALE', () => {
  it('finds the generated suites (the glob is not empty)', () => {
    expect(generated.length).toBeGreaterThanOrEqual(13)
  })

  it.each(generated)('%s imports scaled() and calls it', (file) => {
    const source = code(file)
    expect(source, `${file} does not import scaled from differential-gen.mts`).toMatch(/import\s*\{[^}]*\bscaled\b[^}]*\}\s*from\s*'\.\/differential-gen\.mts'/)
    expect(source, `${file} imports scaled but never calls it`).toMatch(/\bscaled\(/)
  })

  it('scaled() multiplies, never below 1, and ignores a value that is not a positive number', () => {
    const was = process.env.ASTER_DIFF_SCALE
    try {
      process.env.ASTER_DIFF_SCALE = '10'
      expect(scaled(30)).toBe(300)
      process.env.ASTER_DIFF_SCALE = '0.0001'
      expect(scaled(30)).toBe(1)
      for (const bad of ['0', '-3', 'abc', '']) {
        process.env.ASTER_DIFF_SCALE = bad
        expect(scaled(30)).toBe(30)
      }
    } finally {
      if (was === undefined) delete process.env.ASTER_DIFF_SCALE
      else process.env.ASTER_DIFF_SCALE = was
    }
  })
})
