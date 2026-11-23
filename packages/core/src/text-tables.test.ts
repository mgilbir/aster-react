// @vitest-environment node
/**
 * C385: the process-wide tables keyed by text a spec or its data chooses (expression trees and verdicts, selectors, handler
 * identifiers, field and pluck accessors, formatters, path readings, regex verdicts) are bounded by the total length of their keys,
 * not only by their number of entries: what an entry holds grows with its key, so a count alone let a few thousand huge keys hold
 * gigabytes.
 */
import { describe, expect, it } from 'vitest'
import { TextTable, textTableStats, pluck } from './util.js'
import { parseExpressionCached } from './expr-parser.js'
import { checkExpression } from './expr-check.js'
import { fieldOf } from './row-keys.js'
import { parsePathData } from './path-data.js'
import { regexHazard } from './regex-screen.js'
import { compileChart } from './compiler.js'
import { currentLocale } from './locale.js'

describe('TextTable', () => {
  it('keeps the total length of its keys within its budget, oldest out first', () => {
    const t = new TextTable<number>('test table', 100, 1000)
    for (let i = 0; i < 50; i++) t.set(String(i).padStart(100, '0'), i)
    const stats = textTableStats().find((s) => s.name === 'test table')!
    expect(stats.chars).toBeLessThanOrEqual(1000)
    expect(t.get('49'.padStart(100, '0'))).toBe(49)
    expect(t.get('0'.padStart(100, '0'))).toBeUndefined()
    t.set('y'.repeat(300), 1) // over a quarter of the budget: not kept
    expect(t.get('y'.repeat(300))).toBeUndefined()
  })
})

describe('every text-keyed table of the engine is bounded by the length of its keys', () => {
  it('stays within its bounds after many huge distinct keys', () => {
    for (let i = 0; i < 120; i++) {
      const big = 'k' + i + 'x'.repeat(60_000)
      parseExpressionCached(`"${big}"`)
      checkExpression(`"${big}" + ${i}`, () => false)
      pluck({}, big)
      fieldOf(big)
      parsePathData('M0,0' + 'L1,1'.repeat(15_000) + `L${i},0`)
      regexHazard('a{' + i + '}' + 'b'.repeat(1000))
      currentLocale().format(',.' + (i % 20) + 'f' + ' '.repeat(0))
      compileChart({ signals: [{ name: 's', value: 0, on: [{ events: `click[${JSON.stringify(big)} === ''${' '.repeat(i)}]`, update: '1' }] }] } as never)
    }
    const stats = textTableStats()
    for (const name of ['expression trees', 'expression verdicts', 'pluck accessors', 'field accessors', 'path segments', 'regex verdicts', 'view selectors']) {
      expect(stats.map((s) => s.name), name).toContain(name)
    }
    for (const s of stats) {
      expect(s.chars, s.name).toBeLessThanOrEqual(s.maxChars)
      expect(s.entries, s.name).toBeLessThanOrEqual(s.maxEntries)
      expect(s.maxChars, s.name).toBeLessThanOrEqual(8_000_000)
    }
  }, 60_000)
})
