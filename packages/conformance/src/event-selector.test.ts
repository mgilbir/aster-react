/**
 * @aster/core's event selector parser is a port of vega-event-selector. A port can drift, so
 * it is compared with the real parser (vega re-exports it as `parseSelector`) over a grammar
 * of selectors -- including the malformed ones, where the error message must match too (C20).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { parseEventSelectorString } from '../../core/src/event-selector.js'
import { parseEventSelectorString as parseInVl } from '../../vl/src/event-selector.js'

const upstream = (vega as unknown as { parseSelector: (s: string, source?: string, marks?: Record<string, unknown>) => unknown }).parseSelector

function outcome(f: () => unknown): { ok: unknown } | { err: string } {
  try {
    return { ok: JSON.parse(JSON.stringify(f())) }
  } catch (e) {
    return { err: e instanceof Error ? e.message : String(e) }
  }
}

const TYPES = ['click', 'mousemove', 'mouseup', 'mousedown', 'wheel', 'keydown', 'touchstart', 'dblclick', 'timer', 'mouseover']
const SOURCES = ['', 'window:', 'view:', 'scope:', '#id:', '.cls:', 'rect:', 'symbol:', '*:', '@name:', '@bars:', 'group:', 'text:']
const SUFFIX = ['', '!', '[event.shiftKey]', '[event.shiftKey][event.altKey]', '{100}', '{10,20}', '[x>1]{5}', '!{30}', '[a[0]]', '{0,15}']

function* generate(): Generator<string> {
  for (const src of SOURCES) for (const t of TYPES) for (const suf of SUFFIX) yield `${src}${t}${suf}`
  for (const a of TYPES.slice(0, 4)) {
    for (const b of TYPES.slice(0, 4)) yield `[${a}, ${b}] > mousemove`
    yield `[${a}, window:mouseup] > @brush:mousemove[event.shiftKey]{10}`
    yield `[[${a}, mouseup] > mousemove, dblclick] > wheel`
    yield `${a}, mouseup, window:keydown`
    yield `[${a}, mouseup] > mousemove, [dblclick, click] > wheel`
  }
}

// malformed and edge selectors: errors (message parity) and oddities (whitespace, trailing garbage)
const ODD = [
  '', ' ', ',', 'click,', ',click', '[click] > mousemove', '[click, mouseup mousemove', '[a, b, c] > x', '[a, b] mousemove',
  '[a, b] >', 'click{', 'click}', 'click{abc}', 'click{1,2,3}', 'click{}', 'click[', 'click]', 'click[a', 'click[a]x',
  'rect:', ':click', '@:click', 'click!!', 'a:b:c', '{1}', '[', ']', '[]', 'mousemove click wheel', '  click  ', 'window : click',
  '@a b:click', 'x{1}{2}', 'rect:click{1}[a]', 'constructor:click', '__proto__:click', 'toString:click',
]

describe('event selector parser matches vega-event-selector', () => {
  const all = [...generate(), ...ODD]
  it('covers a meaningful grammar', () => {
    expect(all.length).toBeGreaterThan(1300)
  })
  for (const source of [undefined, 'scope', 'view']) {
    it(`agrees on every selector (default source ${source ?? 'unset'})`, () => {
      let compared = 0
      let agreedErrors = 0
      for (const s of all) {
        // `isMarkType` upstream is an inherited-property lookup: `constructor:click` is
        // read as a mark type there. The port deliberately uses an own-property test.
        if (/^(constructor|__proto__|toString):/.test(s)) continue
        const want = outcome(() => upstream(s, source))
        const got = outcome(() => parseEventSelectorString(s, source))
        expect(got, JSON.stringify(s)).toEqual(want)
        compared++
        if ('err' in want) agreedErrors++
      }
      expect(compared).toBeGreaterThan(1300)
      expect(agreedErrors).toBeGreaterThan(10)
    })
  }

  it('the copy @aster/vl carries (it has no dependency on the engine) is the same parser', () => {
    let compared = 0
    for (const s of [...generate(), ...ODD]) {
      expect(outcome(() => parseInVl(s, 'scope')), JSON.stringify(s)).toEqual(outcome(() => parseEventSelectorString(s, 'scope')))
      compared++
    }
    expect(compared).toBeGreaterThan(1300)
  })

  it('does not read inherited properties as mark types (a deliberate deviation)', () => {
    const got = parseEventSelectorString('constructor:click') as Array<{ source?: string; marktype?: string }>
    expect(got[0]!.marktype).toBeUndefined()
    expect(got[0]!.source).toBe('constructor')
  })
})
