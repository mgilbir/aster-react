// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { regexHazard, regexModel } from './regex-screen.js'
import { compileExpr } from './expression.js'
import { withLimits, AsterLimitError, REGEX_MAX_INPUT, REGEX_RUN_BUDGET_MS } from './limits.js'
import { attack, expectLimit, expectReturned, SLACK_MS } from './attack.testkit.js'

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
  // a bounded run after a loop over the same characters, searched: the run is entered from every place the loop can stop, which
  // multiplies the quadratic search by its length (measured on 10 000 characters: `a*[ab]{0,20}x` 11 s, `a+a{30}x` 14.6 s,
  // `[ab]*?[ab]{1,3}\s*?x$` 0.67 s, 1.65 s under load, where the searched `a*x` takes 0.08 s)
  ['a*[ab]{0,20}x'], ['a+a{30}x'], ['[ab]*?[ab]{1,3}\\s*?x$'],
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
  ['[a-z]+[0-9]{1,4}x'],
]
/**
 * The subject length the benign corpus is accepted at: a run may take REGEX_RUN_BUDGET_MS (100 ms), and a searched quadratic
 * pattern fits it on about a thousand characters, by the screen's cost model (regexRunMs). At the default subject cap of the
 * limits, 10 000 characters, none of the quadratic ones fits, and each is refused (below).
 */
const BENIGN_SUBJECT = 1000

describe('static regex screen (heuristic)', () => {
  it('has a meaningful corpus', () => {
    expect(REDOS.length).toBeGreaterThanOrEqual(20)
    expect(BENIGN.length).toBeGreaterThanOrEqual(30)
  })
  it.each(REDOS)('rejects %s', (src, flags) => {
    expect(regexHazard(src, flags ?? ''), src).not.toBeNull()
  })
  it.each(BENIGN)('accepts %s on 1000 characters', (src, flags) => {
    expect(regexHazard(src, flags ?? '', BENIGN_SUBJECT), src).toBeNull()
    new RegExp(src, flags) // the benign corpus really is valid syntax
  })
  it('accepts a pattern only for the subject length its run fits: the budget decides, not the shape alone', () => {
    // linear runs fit any length the limits allow; a searched quadratic one fits a thousand characters and not ten thousand
    expect(regexHazard('^\\d{4}-\\d{2}$', '', 1_000_000)).toBeNull()
    expect(regexHazard('\\s+$', '', 1000)).toBeNull()
    expect(regexHazard('\\s+$', '', 10_000)).toMatch(/polynomial backtracking of degree 2: about \d+ ms on 10000 characters, over the 100 ms/)
    expect(regexHazard('\\s+$', '', 10_000, 5000)).toBeNull()
    // a bounded run after a loop multiplies the work: it fits fewer characters
    expect(regexHazard('a*a{1,3}x', '', 1000)).not.toBeNull()
    expect(regexHazard('a*a{1,3}x', '', 500)).toBeNull()
    // the cubic trim idiom fits only a short subject
    expect(regexHazard('^\\s*(.*?)\\s*$', '', 100)).toBeNull()
    expect(regexHazard('^\\s*(.*?)\\s*$', '', 1000)).not.toBeNull()
    // exponential backtracking is refused at any length
    expect(regexHazard('(a+)+$', '', 5)).toMatch(/nested quantifiers/)
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

describe('the screen\'s own analysis is bounded by the evaluation (child process, hard kill)', () => {
  // a pattern whose analysis takes the screen 120 to 220 ms, made distinct by a suffix: a spec can hold many of them
  const heavy = (i: number): string => '\\\\w{1,3}((\\\\d|[ab]+[^b]{0,70}.)([ab]\\\\d*?[^b]?)?b)a{1,3}x' + 'c'.repeat(i) + '$'
  const spec = (n: number, rows = 1): string => `{ width: 10, height: 10, data: [{ name: 't', values: Array.from({ length: ${rows} }, () => ({ s: 'ab' })),
    transform: [${Array.from({ length: n }, (_, i) => `{ type: 'formula', as: 'f${i}', expr: ${JSON.stringify(`test(regexp('${heavy(i)}'), datum.s)`)} }`).join(', ')}] }],
    marks: [{ type: 'rect', from: { data: 't' } }] }`
  it('forty distinct heavy patterns under maxTimeMs 200 stop at the clock, not after 40 analyses', async () => {
    const r = await attack(`core.renderSpec(${spec(40)}, { limits: { maxTimeMs: 200 } })`)
    expectLimit(r, /maxTimeMs exceeded during regular expression screening/)
    expect(r.cpuMs).toBeLessThan(200 + SLACK_MS)
  }, 30_000)
  it('without maxTimeMs, the analysis of all the patterns of an evaluation is bounded by SCREEN_STEPS', async () => {
    const r = await attack(`core.renderSpec(${spec(40)}, { limits: {} })`)
    expectLimit(r, /regexSafety: the screen's analysis of this evaluation's patterns passed \d+ steps/)
    // (forty analyses take 5 to 9 s; the bound, 1 M steps, about 0.35 s)
    expect(r.cpuMs).toBeLessThan(800)
  }, 30_000)
  it('one heavy pattern over many rows is analysed once (cached by its text)', async () => {
    const r = await attack(`const t0 = performance.now(); core.renderSpec(${spec(1, 2000)}, { limits: { maxTimeMs: 2000 } }); return performance.now() - t0`)
    expect(r.threw, JSON.stringify(r.threw)).toBeNull()
    expect(r.value as number).toBeLessThan(1000)
  }, 30_000)
})

describe('polynomial backtracking (child process, hard kill)', () => {
  // 'a'.repeat(9000) against /a*a*a*a*a*b/ ran for over 20 s before the screen learnt the shape
  it('/a*a*a*a*a*b/ on 9000 characters, with an empty limits object, is refused before its run', async () => {
    const r = await attack(`
      core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ s: 'a'.repeat(9000) }], transform: [{ type: 'formula', as: 'n', expr: 'test(/a*a*a*a*a*b/, datum.s)' }] }],
        marks: [{ type: 'rect', from: { data: 't' } }] }, { limits: {} })`)
    expectLimit(r, /regexSafety: polynomial backtracking of degree \d+: about \d+ ms on 9000 characters, over the 100 ms a run may take/)
    expect(r.cpuMs).toBeLessThan(500)
  }, 30_000)

  it('the trim idiom is refused under limits (cubic: 19.7 s on 4000 spaces before x\n\nx), a pattern that can always end runs', async () => {
    const r = await attack(`
      core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ s: ' '.repeat(4000) + 'x\\n\\nx' }], transform: [
        { type: 'formula', as: 'a', expr: "test(/^\\\\s*(.*?)\\\\s*$/, datum.s)" }] }],
        marks: [{ type: 'rect', from: { data: 't' } }] }, { limits: {} })`)
    expectLimit(r, /regexSafety: polynomial backtracking of degree 3: about \d+ ms on 4004 characters, over the 100 ms a run may take/)
    expect(r.cpuMs).toBeLessThan(500)
    const ok = await attack(`
      const svg = core.renderSpec({ width: 10, height: 10, data: [{ name: 't', values: [{ s: ' '.repeat(10) + 'a'.repeat(8000) }], transform: [
        { type: 'formula', as: 'b', expr: "test(/\\\\s*a*b?/, datum.s)" }] }],
        marks: [{ type: 'rect', from: { data: 't' } }] }, { limits: {} })
      return svg.length > 0`)
    expectReturned(ok, true)
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
   * Every pattern the screen lets through (whatever the input: no exponential shape, nothing it cannot bound) is driven through the
   * engine under limits, on inputs built to make it backtrack at the longest subject those limits allow: each character the pattern
   * names repeated to that length, with no suffix and with suffixes that fail it. Each run either finishes within the time a run
   * may take or is refused, before it starts, with the typed `regexSafety` error (its cost on that subject does not fit); never a
   * slow run. An absolute bound, since nothing can interrupt a running RegExp. Patterns are generated from a small grammar
   * (seeded); they run in children that the parent kills past 20 s. The screen reads each pattern once before its runs are timed:
   * its analysis is bounded by its own step budget (`MAX_STEPS`), not by the run's (the slowest generated pattern took 272 ms). Two limits: the default (subjects up to 10 000 characters, a
   * run 100 ms), where searched quadratic patterns are refused on such subjects, and `maxStringLength: 1000`, where they run.
   */
  it.each([
    { limits: {}, subject: REGEX_MAX_INPUT },
    { limits: { maxStringLength: 1000 }, subject: 1000 },
  ])('generated patterns the screen accepts, on $subject-character attack inputs, run within the budget or are refused before they run', async ({ limits, subject }) => {
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
      const m = regexModel(p)
      if (m !== null && typeof m === 'object') accepted.push(p)
    }
    expect(accepted.length).toBe(300)
    let ran = 0, refused = 0, quadraticRan = 0
    for (let at = 0; at < accepted.length; at += 50) {
      const r = await attack(`
        const pats = ${JSON.stringify(accepted.slice(at, at + 50))}
        const limits = ${JSON.stringify(limits)}, subject = ${subject}, budget = ${REGEX_RUN_BUDGET_MS}
        const rt = { scale: () => undefined, data: () => [], expr: (e) => core.compileExpr(e, rt) }
        const f = core.compileExpr('test(regexp(datum.p), datum.s)', rt)
        const units = ['a', 'b', ' ', '1', 'x', 'ab', 'a ']; const tails = ['', '!', '\\n', 'b!']
        const out = { ran: 0, refused: 0, ranPatterns: [], slow: null, other: null }
        for (const p of pats) {
          // (the screen's analysis of the pattern, once per pattern and bounded by its own step budget, is not the run being timed)
          try { core.withLimits(limits, () => f({ p, s: '' }, {})) } catch {}
          let any = false
          for (const u of units) for (const t of tails) {
            const s = u.repeat(Math.ceil(subject / u.length)).slice(0, subject - t.length) + t
            const t0 = performance.now()
            try { core.withLimits(limits, () => f({ p, s }, {})); out.ran++; any = true } catch (e) {
              if (e instanceof core.AsterLimitError && /regexSafety: .* ms on \\d+ characters, over the \\d+ ms a run may take/.test(e.message)) out.refused++
              else { out.other = String(e && e.message).slice(0, 200) + ' ' + JSON.stringify([p, u, t]); return out }
            }
            const ms = performance.now() - t0
            if (ms > budget) { out.slow = ms.toFixed(0) + ' ms ' + JSON.stringify([p, u, t]); return out }
          }
          if (any) out.ranPatterns.push(p)
        }
        return out`)
      expect(r.killed, `patterns ${at}..: killed (a run that never finished)`).toBe(false)
      expect(r.threw, JSON.stringify(r.threw)).toBeNull()
      const v = r.value as { ran: number; refused: number; ranPatterns: string[]; slow: string | null; other: string | null }
      expect(v.slow, 'a run slower than the budget').toBeNull()
      expect(v.other, 'neither a run nor the typed refusal').toBeNull()
      ran += v.ran
      refused += v.refused
      for (const p of v.ranPatterns) { const m = regexModel(p) as { degree: number }; if (m.degree >= 2) quadraticRan++ }
    }
    // (not vacuous: runs happen, refusals happen at the long subject, and quadratic patterns run at the short one)
    expect(ran).toBeGreaterThan(1000)
    if (subject === REGEX_MAX_INPUT) expect(refused).toBeGreaterThan(100)
    else expect(quadraticRan).toBeGreaterThan(30)
  }, 600_000)

  it('`\\s+$` runs on a 1 000-character subject and is refused, before it runs, on a 10 000-character one', () => {
    const rt = { scale: () => undefined, data: () => [], expr: () => { throw new Error('x') } }
    const f = compileExpr('test(/\\s+$/, datum.s)', rt as never)
    expect(withLimits({}, () => f({ s: ' '.repeat(999) + 'x' }, {}))).toBe(false)
    expect(() => withLimits({}, () => f({ s: ' '.repeat(9999) + 'x' }, {})))
      .toThrow(/regexSafety: polynomial backtracking of degree 2: about \d+ ms on 10000 characters, over the 100 ms a run may take: \/\\s\+\$\//)
    // with more time, it runs
    expect(withLimits({ maxTimeMs: 5000 }, () => f({ s: ' '.repeat(9999) + 'x' }, {}))).toBe(false)
  })
})
