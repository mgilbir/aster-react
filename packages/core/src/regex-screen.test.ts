// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { regexHazard } from './regex-screen.js'
import { compileExpr } from './expression.js'
import { withLimits, AsterLimitError } from './limits.js'
import { attack, expectLimit } from './attack.testkit.js'

/** Known catastrophic patterns from published ReDoS lists (OWASP, Davis et al. "The Impact of Regular Expression Denial of Service", regexlib). */
const REDOS: Array<[string, string?]> = [
  ['^(a+)+$'], ['^(a*)*$'], ['^(a|a)*$'], ['^(a|aa)+$'], ['(x+x+)+y'], ['^(\\w+\\s?)*$'],
  ['^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|([a-z]{2,3}[.]{1}[a-z]{2,3}))$'], // OWASP email
  ['^(([a-z])+.)+[A-Z]([a-z])+$'], // OWASP
  ['^(\\d+)*$'], ['(a+)+b'], ['([a-z]+)*'], ['^(\\w|\\d)+$'], ['(\\w|\\d)*'], ['^((a+)+)+$'], ['^(([a-z]+)+)$'],
  ['(?:a+)+'], ['(a+|b+)*'], ['^(.+)+$'], ['^(\\s*\\w+\\s*)*$'], ['(a|a?)+'], ['(\\d+|\\w+)*'], ['^([\\w.]+)*@'],
  ['(.*a){12,}'], ['^(?:(a|b)\\1)+$'], ['(?<x>a)(\\k<x>)*'], ['(?=(a+)+)b'], ['^(a+)+$', 'i'], ['(A|a)+', 'i'], ['^(\\d|\\w)+$'], ['(?:[a-z]|[a-f0-9])+x'],
]

/** Patterns typical in Vega specs and data pipelines. */
const BENIGN: Array<[string, string?]> = [
  ['^\\d{4}-\\d{2}-\\d{2}$'], ['^[A-Z][a-z]+$'], ['^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$'], ['\\s+'], ['^\\s+|\\s+$'], ['[^a-z0-9]+'],
  ['^#[0-9a-f]{3,6}$', 'i'], ['(cat|dog)s?'], ['^(jpg|png|gif)$'], ['(foo|bar)+'], ['\\b\\w+\\b'], ['^https?://'], ['[aeiou]'], ['^.{3,10}$'],
  ['^[a-z]{2}-[A-Z]{2}$'], ['(\\d{3})-(\\d{4})'], ['^(?:\\d{1,3}\\.){3}\\d{1,3}$'], ['^[^@]+@[^@]+$'], ['\\.csv$'], ['^(Mon|Tue|Wed|Thu|Fri)$'],
  ['^[+-]?\\d+(\\.\\d+)?$'], ['^\\$?[\\d,]+$'], ['[\\u4e00-\\u9fa5]+'], ['^(?!foo)\\w+$'], ['(?<=\\$)\\d+'], ['^[A-Za-z_][A-Za-z0-9_]*$'],
  ['^\\d+(px|em|%)$'], ['^\\s*$'], ['(a|b|c)+'], ['([A-Z])\\1'], ['\\d+(?:st|nd|rd|th)'], ['^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$'], ['[A-Z]{2,}'],
  ['^.*$'], ['^(?:[a-z]+\\s){2}[a-z]+$'], ['^\\p{L}+$', 'u'], ['^x*$'], ['[\\w-]+'], ['^(?<y>\\d{4})-(?<m>\\d{2})$'], ['(?:^|,)("[^"]*"|[^,]*)'.replace('*)', '{0,50})')], ['a{2,}b'],
]

describe('static regex screen (heuristic)', () => {
  it('has a meaningful corpus', () => {
    expect(REDOS.length).toBeGreaterThanOrEqual(20)
    expect(BENIGN.length).toBeGreaterThanOrEqual(30)
  })
  it.each(REDOS)('rejects %s', (src, flags) => {
    expect(regexHazard(src, flags ?? ''), src).not.toBeNull()
  })
  it.each(BENIGN)('accepts %s', (src, flags) => {
    expect(regexHazard(src, flags ?? ''), src).toBeNull()
    new RegExp(src, flags) // the benign corpus really is valid syntax
  })
  it('names the problem', () => {
    expect(regexHazard('(a+)+')).toMatch(/nested quantifiers/)
    expect(regexHazard('(a|aa)+')).toMatch(/same prefix/)
    expect(regexHazard('(?:(a)\\1)+')).toMatch(/backreference/)
  })
  it('leaves unreadable syntax to the RegExp constructor', () => {
    expect(regexHazard('(')).toBeNull()
    expect(regexHazard('[')).toBeNull()
  })
})

describe('applied under limits only', () => {
  const rt = { scale: () => undefined, data: () => undefined, expr: () => { throw new Error('x') } }
  const ev = (expr: string): unknown => compileExpr(expr, rt)({}, {})

  it('without limits nothing changes (vega parity): the pattern compiles and runs', () => {
    expect(ev("test('^(a+)+$', 'aaaa!')")).toBe(false)
    expect(ev("test(/^(a+)+$/, 'aaaa')")).toBe(true)
    expect(ev("replace('aab', /(a+)+/, 'x')")).toBe('xb')
    expect(ev("length(split('a,b', /(,|;)+/))")).toBe(3) // (the capture group is spliced in, as in JS)
  })

  it('under limits every entry point refuses a catastrophic pattern', () => {
    for (const expr of [
      "test('^(a+)+$', 'aaa')", "test(/^(a+)+$/, 'aaa')", "regexp('(a|aa)+')", "replace('aaa', /(a+)+/, 'x')",
      "replace('aaa', regexp('(a+)*'), 'x')", "split('aaa', /(\\w|\\d)+/)",
    ]) {
      // one scope each: a violation is sticky within its scope
      let err: unknown
      try { withLimits({ maxTimeMs: 1000 }, () => ev(expr)) } catch (e) { err = e }
      expect(err, expr).toBeInstanceOf(AsterLimitError)
      expect(String((err as Error).message)).toMatch(/regexSafety/)
    }
  })

  it('under limits benign patterns still work', () => {
    withLimits({ maxTimeMs: 1000 }, () => {
      expect(ev("test('^\\\\d{4}-\\\\d{2}', '2024-01-15')")).toBe(true)
      expect(ev("test(/^[A-Z][a-z]+$/, 'Hello')")).toBe(true)
      expect(ev("replace('a  b', /\\s+/, ' ')")).toBe('a b')
    })
  })
})

describe('the real attack (child process, hard kill)', () => {
  const run = (expr: string, extra = '') => attack(`
    core.renderSpec({ data: [{ name: 't', values: [{ s: 'a'.repeat(40) + '!' }], transform: [{ type: 'filter', expr: ${JSON.stringify(expr)} }] }${extra}] },
      { limits: { maxTimeMs: 200, maxStringLength: 1000 } })`)

  it.each([
    ["test('^(a+)+$', datum.s)"],
    ["test(/^(a+)+$/, datum.s)"],
    ["length(split(datum.s, /(a|aa)+/)) > 0"],
    ["length(replace(datum.s, regexp('(\\\\w|\\\\d)+$'), '')) > 0"],
  ])('%s throws AsterLimitError in under 50 ms of CPU (a 40-character input would hang)', async (expr) => {
    const r = await run(expr)
    expectLimit(r, /regexSafety/)
    expect(r.cpuMs).toBeLessThan(50)
  }, 30_000)

  it('countpattern with a catastrophic pattern', async () => {
    const r = await attack(`
      core.renderSpec({ data: [{ name: 't', values: [{ s: 'a'.repeat(40) + '!' }], transform: [{ type: 'countpattern', field: 's', pattern: '(a+)+$' }] }] },
        { limits: { maxTimeMs: 200 } })`)
    expectLimit(r, /regexSafety/)
    expect(r.cpuMs).toBeLessThan(50)
  }, 30_000)
})
