// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { regexHazard } from './regex-screen.js'
import { compileExpr } from './expression.js'
import { withLimits, AsterLimitError } from './limits.js'
import { spawnSync } from 'node:child_process'
import { attack, expectLimit } from './attack.testkit.js'

/** Known catastrophic patterns from published ReDoS lists (OWASP, Davis et al. "The Impact of Regular Expression Denial of Service", regexlib). */
const REDOS: Array<[string, string?]> = [
  ['^(a+)+$'], ['^(a*)*$'], ['^(a|a)*$'], ['^(a|aa)+$'], ['(x+x+)+y'], ['^(\\w+\\s?)*$'],
  ['^([a-zA-Z0-9])(([\\-.]|[_]+)?([a-zA-Z0-9]+))*(@){1}[a-z0-9]+[.]{1}(([a-z]{2,3})|([a-z]{2,3}[.]{1}[a-z]{2,3}))$'], // OWASP email
  ['^(([a-z])+.)+[A-Z]([a-z])+$'], // OWASP
  ['^(\\d+)*$'], ['(a+)+b'], ['([a-z]+)*'], ['^(\\w|\\d)+$'], ['(\\w|\\d)*'], ['^((a+)+)+$'], ['^(([a-z]+)+)$'],
  ['(?:a+)+'], ['(a+|b+)*'], ['^(.+)+$'], ['^(\\s*\\w+\\s*)*$'], ['(a|a?)+'], ['(\\d+|\\w+)*'], ['^([\\w.]+)*@'],
  ['(.*a){12,}'],
  // polynomial: adjacent unbounded quantifiers over the same characters
  ['a*a*a*b'], ['a*a*a*a*a*b'], ['.*.*.*x'], ['\\d+\\d+\\d+$'], ['^\\s*\\s*\\s*x'], ['[a-z]*\\w*[a-z]*!'], ['(?:ab)*(?:ab)*(?:ab)*c'], ['^(?:(a|b)\\1)+$'], ['(?<x>a)(\\k<x>)*'], ['(?=(a+)+)b'], ['^(a+)+$', 'i'], ['(A|a)+', 'i'], ['^(\\d|\\w)+$'], ['(?:[a-z]|[a-f0-9])+x'],
  // shapes the old rule-based screen let through (C11), each measured past a 6 s kill on a 40-character input under maxTimeMs 250
  ['(a+){1,60}$'], ['(a|aa){1,60}$'], ['^(\\w+\\s?){1,50}$'], ['(.*a){12}$'], ['((a|a))*$'], ['(?:(a|aa)b?)+$'],
  // valid syntax the old screen misread as harmless (C11): Annex B `\x`, `\u`, `\k`, `\c` are literals there; modifier groups are valid
  ['\\x(a+)+$'], ['\\u(a+)+$'], ['\\k<(a+)+$'], ['(?i:(a+)+)$'], ['\\c(a+)+$'], ['[\\c](a+)+$'],
  // degree 3 once V8's search is counted: each start position runs the two loops again (measured: `\s*.*x` on 4 000 spaces 14 s,
  // `.*foo.*bar` on 6 000 characters 16 s, the trim idiom on 4 000 spaces before `x\n\nx` 19.7 s)
  ['\\s*.*x'], ['.*foo.*bar'], ['^\\s*(.*?)\\s*$'], ['\\d+\\.?\\d*x'], ['.*a.*a.*a.*b'], ['.{0,100}.{0,100}x'],
  // finite ambiguity without a loop: 2^13 ways to match 13 characters
  ['(a|a)'.repeat(13) + '$'],
]

/** Patterns typical in Vega specs and data pipelines. */
const BENIGN: Array<[string, string?]> = [
  ['^\\d{4}-\\d{2}-\\d{2}$'], ['^[A-Z][a-z]+$'], ['^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$'], ['\\s+'], ['^\\s+|\\s+$'], ['[^a-z0-9]+'],
  ['^#[0-9a-f]{3,6}$', 'i'], ['(cat|dog)s?'], ['^(jpg|png|gif)$'], ['(foo|bar)+'], ['\\b\\w+\\b'], ['^https?://'], ['[aeiou]'], ['^.{3,10}$'],
  ['^[a-z]{2}-[A-Z]{2}$'], ['(\\d{3})-(\\d{4})'], ['^(?:\\d{1,3}\\.){3}\\d{1,3}$'], ['^[^@]+@[^@]+$'], ['\\.csv$'], ['^(Mon|Tue|Wed|Thu|Fri)$'],
  ['^[+-]?\\d+(\\.\\d+)?$'], ['^\\$?[\\d,]+$'], ['[\\u4e00-\\u9fa5]+'], ['^(?!foo)\\w+$'], ['(?<=\\$)\\d+'], ['^[A-Za-z_][A-Za-z0-9_]*$'],
  ['^\\d+(px|em|%)$'], ['^\\s*$'], ['(a|b|c)+'], ['([A-Z])\\1'], ['\\d+(?:st|nd|rd|th)'], ['^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$'], ['[A-Z]{2,}'],
  ['^.*$'],
  // what the old screen misread or refused, read right: `\u{` and `[\u{]` are literals without `u` (C10), a repeated group whose
  // iterations cannot overlap is linear, one loop searched is quadratic at worst
  ['a\\u{'], ['[\\u{]a'], ['a\\u{3}'], ['(\\d+\\.)*\\d+'], ['\\s+$'], ['a*b'],
  // adjacent quantifiers that are at worst quadratic, that do not overlap, or after which the match can always end
  ['\\s*.*'], ['\\d+\\.?\\d*'], ["[\\w']{3,}"], ['\\s*\\w+\\s*=\\s*\\d+'], ['a*b*c*'], ['^\\d+\\s*\\w*\\s*$'], ['^(?:[a-z]+\\s){2}[a-z]+$'], ['^\\p{L}+$', 'u'], ['^x*$'], ['[\\w-]+'], ['^(?<y>\\d{4})-(?<m>\\d{2})$'], ['(?:^|,)("[^"]*"|[^,]*)'.replace('*)', '{0,50})')], ['a{2,}b'],
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
    expect(regexHazard('(a|aa)+')).toMatch(/same input in more than one way/)
    expect(regexHazard('(?:(a)\\1)+')).toMatch(/backreference/)
    expect(regexHazard('a*a*a*b')).toMatch(/polynomial backtracking of degree 4/)
    expect(regexHazard('(a|a)'.repeat(13))).toMatch(/ways to match one input/)
  })
  it('leaves invalid syntax to the RegExp constructor', () => {
    expect(regexHazard('(')).toBeNull()
    expect(regexHazard('[')).toBeNull()
    expect(regexHazard('a\\u{', 'u')).toBeNull()
    expect(regexHazard('a', 'gg')).toBeNull()
  })
  it('refuses what it cannot analyse within its budget (fail closed)', () => {
    expect(regexHazard('[a-c]{64}'.repeat(40))).toMatch(/too complex to screen/)
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

describe('polynomial backtracking (child process, hard kill)', () => {
  // 'a'.repeat(9000) against /a*a*a*a*a*b/ ran for over 20 s before the screen learnt the shape
  it('/a*a*a*a*a*b/ on 9000 characters, with an empty limits object, is refused up front', async () => {
    const r = await attack(`
      core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ s: 'a'.repeat(9000) }], transform: [{ type: 'formula', as: 'n', expr: 'test(/a*a*a*a*a*b/, datum.s)' }] }],
        marks: [{ type: 'rect', from: { data: 't' } }] }, { limits: {} })`)
    expectLimit(r, /regexSafety: a chain of \d+ unbounded quantifiers/)
    expect(r.cpuMs).toBeLessThan(500)
  }, 30_000)

  it('the trim idiom is refused under limits (cubic: 19.7 s on 4000 spaces before x\n\nx), a pattern that can always end runs', async () => {
    const r = await attack(`
      core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ s: ' '.repeat(4000) + 'x\\n\\nx' }], transform: [
        { type: 'formula', as: 'a', expr: "test(/^\\\\s*(.*?)\\\\s*$/, datum.s)" }] }],
        marks: [{ type: 'rect', from: { data: 't' } }] }, { limits: {} })`)
    expectLimit(r, /regexSafety: a chain of 3 unbounded quantifiers/)
    expect(r.cpuMs).toBeLessThan(500)
    const ok = await attack(`
      const svg = core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ s: ' '.repeat(10) + 'a'.repeat(8000) }], transform: [
        { type: 'formula', as: 'b', expr: "test(/\\\\s*a*b?/, datum.s)" }] }],
        marks: [{ type: 'rect', from: { data: 't' } }] }, { limits: {} })
      return svg.length > 0`)
    expect(ok.threw, JSON.stringify(ok)).toBeNull()
    expect(ok.value).toBe(true)
  }, 30_000)
})

describe('the screen terminates and is sound (child processes, hard kill)', () => {
  // C10: `\u{` without a closing brace once reset the parser to the start of the pattern, which then grew its tree for ever
  it.each([['a\\\\u{'], ['[\\\\u{]a'], ['\\\\u{(a'], ['a\\\\u{1']])('test(regexp(%s), ...) under limits answers at once', async (p) => {
    const r = await attack(`
      const svg = core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ p: '${p}', s: 'a'.repeat(30) }], transform: [
        { type: 'formula', as: 'm', expr: 'test(regexp(datum.p), datum.s)' }] }], marks: [{ type: 'rect', from: { data: 't' } }] },
        { limits: { maxTimeMs: 250 } })
      return svg.length > 0`)
    expect(r.killed).toBe(false)
    expect(r.threw, JSON.stringify(r)).toBeNull()
    expect(r.cpuMs).toBeLessThan(500)
  }, 30_000)

  /**
   * Every pattern the screen lets through runs promptly on inputs built to make it backtrack, at the default input cap: each
   * character the pattern names repeated 10 000 times, with no suffix and with suffixes that fail it. Patterns are generated from a
   * small grammar (seeded); V8 runs them in a child that the parent kills past its budget.
   */
  it('generated patterns the screen accepts run within 1.5 s each on 10 000-character attack inputs', () => {
    let s = 0x5eed
    const rand = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296 }
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const ATOMS = ['a', 'b', '.', '\\s', '\\d', '\\w', '[ab]', '[^b]', 'x']
    const QUANT = ['', '', '*', '+', '?', '{2}', '{1,3}', '{0,70}', '*?']
    const gen = (depth: number): string => {
      const n = 1 + Math.floor(rand() * 3)
      let out = ''
      for (let k = 0; k < n; k++) {
        const r = rand()
        const atom = depth < 2 && r < 0.3 ? `(${gen(depth + 1)}${rand() < 0.4 ? '|' + gen(depth + 1) : ''})` : pick(ATOMS)
        out += atom + pick(QUANT)
      }
      return out
    }
    const accepted: string[] = []
    for (let n = 0; accepted.length < 300 && n < 20000; n++) {
      const p = (rand() < 0.3 ? '^' : '') + gen(0) + (rand() < 0.5 ? pick(['$', '!', 'x$']) : '')
      try { new RegExp(p) } catch { continue }
      if (regexHazard(p) === null) accepted.push(p)
    }
    expect(accepted.length).toBe(300)
    const child = `
      const pats = JSON.parse(process.argv[1]); const units = ['a', 'b', ' ', '1', 'x', 'ab', 'a ']; const tails = ['', '!', '\\n', 'b!']
      for (const p of pats) {
        const re = new RegExp(p)
        for (const u of units) for (const t of tails) {
          const s = u.repeat(Math.ceil(10000 / u.length)).slice(0, 10000 - t.length) + t
          process.stdout.write(JSON.stringify(p) + '\\n')
          const t0 = performance.now(); re.test(s); const ms = performance.now() - t0
          if (ms > 1500) { process.stdout.write('SLOW ' + ms.toFixed(0) + ' ' + JSON.stringify([p, u, t]) + '\\n'); process.exit(3) }
        }
      }
      process.stdout.write('DONE\\n')`
    const res = spawnSync(process.execPath, ['-e', child, JSON.stringify(accepted)], { timeout: 240_000, encoding: 'utf8', maxBuffer: 1 << 26 })
    const lines = (res.stdout ?? '').trim().split('\n')
    expect(lines[lines.length - 1], `killed or slow while running ${lines[lines.length - 1]}`).toBe('DONE')
  }, 300_000)
})
