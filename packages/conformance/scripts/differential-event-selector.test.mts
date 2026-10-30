/**
 * LIVE generated differential for the event selector parser (vega-event-selector 4.0.0, reached through vega-parser):
 * random selectors, built from the grammar and then damaged character by character, go through the real parser and
 * through both copies Aster carries (`@aster/core` runs its signals on one, `@aster/vl` compiles with the other). Each
 * must return the same stream definitions, or fail with the same message. `src/event-selector.test.ts` pins a fixed
 * grammar; this one finds what a fixed list does not think of.
 */
import { describe, expect, it } from 'vitest'
import { parseEventSelectorString as inCore } from '../../core/src/event-selector.ts'
import { parseEventSelectorString as inVl } from '../../vl/src/event-selector.ts'
import { importChain, seeded } from './upstream.mts'

type Parse = (selector: string, source?: string, marks?: Record<string, unknown>) => unknown
const upstream = ((await importChain('vega', 'vega-parser', 'vega-event-selector')) as { parseSelector: Parse }).parseSelector

function outcome(f: () => unknown): unknown {
  try {
    return { ok: JSON.parse(JSON.stringify(f())) }
  } catch (e) {
    return { err: typeof e === 'string' ? e : e instanceof Error ? e.message : String(e) }
  }
}

const TYPES = ['click', 'mousemove', 'mouseup', 'pointerdown', 'wheel', 'keydown', 'timer', 'dblclick', 'a', 'event-type']
const SOURCES = ['', '', '', 'window:', 'view:', 'scope:', '#id:', '.cls:', 'rect:', 'symbol:', '*:', '@name:', '@bars:', 'group:', 'text:', 'a b:']
const FILTERS = ['event.shiftKey', 'x>1', 'a[0]', 'datum.a == "]"', '', ' event.altKey ']
const MARKS = [{ rect: 1, line: 1 }, { '*': 1 }, {}]

function stream(r: ReturnType<typeof seeded>): string {
  let s = r.pick(SOURCES) + r.pick(TYPES)
  if (r.int(5) === 0) s += '!'
  for (let k = r.int(3); k > 0; k--) s += '[' + r.pick(FILTERS) + ']'
  if (r.int(4) === 0) s += r.pick(['{100}', '{10,20}', '{0}', '{0,15}', '{x}', '{1,2,3}', '{}', ' { 5 } '])
  return s
}

function selector(r: ReturnType<typeof seeded>, depth = 0): string {
  switch (depth < 2 ? r.int(6) : 0) {
    case 1: return `[${selector(r, depth + 1)}, ${selector(r, depth + 1)}] > ${selector(r, depth + 1)}`
    case 2: return `${selector(r, depth + 1)}, ${selector(r, depth + 1)}`
    case 3: return `[${stream(r)}, ${stream(r)}]>${stream(r)}`
    default: return stream(r)
  }
}

const NOISE = ['[', ']', '{', '}', ',', ':', '@', '>', '!', ' ', '0', 'a', '*']
/** Damage a valid selector: delete, duplicate or insert a character at random places. */
function damage(r: ReturnType<typeof seeded>, s: string): string {
  for (let k = 1 + r.int(3); k > 0; k--) {
    const at = r.int(s.length + 1)
    switch (r.int(3)) {
      case 0: s = s.slice(0, at) + s.slice(at + 1); break
      case 1: s = s.slice(0, at) + s.slice(at, at + 1) + s.slice(at); break
      default: s = s.slice(0, at) + r.pick(NOISE) + s.slice(at)
    }
  }
  return s
}

describe('event selector parsers vs vega-event-selector (generated)', () => {
  const r = seeded(20260101)
  const cases: Array<{ s: string; source: string | undefined; marks: Record<string, unknown> | undefined }> = []
  for (let i = 0; i < 6000; i++) {
    const base = selector(r)
    cases.push({
      s: i % 2 ? damage(r, base) : base,
      source: r.pick([undefined, 'view', 'scope', 'window']),
      marks: r.int(4) === 0 ? r.pick(MARKS) : undefined,
    })
  }

  it('returns the same definitions, or the same error, for every case', () => {
    let errors = 0
    let valid = 0
    for (const c of cases) {
      const want = outcome(() => upstream(c.s, c.source, c.marks))
      expect(outcome(() => inCore(c.s, c.source, c.marks)), JSON.stringify(c)).toEqual(want)
      expect(outcome(() => inVl(c.s, c.source, c.marks)), JSON.stringify(c)).toEqual(want)
      if ((want as { err?: string }).err !== undefined) errors++
      else valid++
    }
    // a vacuous mix (all valid or all failing) would prove nothing
    expect(errors).toBeGreaterThan(500)
    expect(valid).toBeGreaterThan(2000)
  })
})
