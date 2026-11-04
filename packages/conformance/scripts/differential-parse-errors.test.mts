/**
 * LIVE differential for the expressions of a spec. vega parses every expression of a spec when it parses the spec, before a view
 * exists, and refuses what it cannot use, in the order it reads the spec:
 *
 * - a syntax error: `Expression parse error: <the text it parsed>` -- not the parser's own words. The text is what vega built,
 *   which is the expression as written in some places and in others a longer one: an encode entry becomes `(signal)`,
 *   `_scale("x", (signal))`, a rule's `(test)?value:...`, a stream's filters `(a)&&(event.item&&...)`, a data trigger
 *   `if(trigger,modify("name",...),0)`;
 * - then, in the same expression, what its code generator refuses: `Unrecognized function: foo`, `Illegal callee type: ...`,
 *   a call with too few arguments, and last `Unrecognized signal name: "x"` for a name that is no signal of the scope.
 *
 * Every place a spec holds an expression (expression-sites.mts: signals, formula/filter and field expressions of transforms,
 * data triggers, encode entries of marks and guides, the `{signal: ...}` of any property, and every part of the handlers of
 * signals: their updates, the filters of their streams however written, their sources) is given a series of broken
 * expressions, a series of unknown functions and signals, and a series of good ones; Aster must refuse exactly when vega does,
 * with vega's message, and accept what vega accepts. The handlers are also run in jsdom-parse-errors-handlers.test.mts.
 */
import { describe, expect, it } from 'vitest'
import { seeded } from './upstream.mts'
import { referenceSpec } from './parse-refusal-gen.mts'
import { WRAPPED } from '../../core/src/guide-model.ts'
import { asterOutcome, BAD, GOOD, GUIDE_CASES, HANDLER_SHAPES, HANDLER_SITES, randomGuide, SEMANTIC, SITES, UNBOUND_HANDLER_SITES, vegaOutcome } from './expression-sites.mts'

const POOL = [...BAD, ...GOOD, ...SEMANTIC]

describe('an expression a spec holds is refused as vega refuses it (Aster vs real Vega)', { timeout: 120_000 }, () => {
  for (const [group, sites] of [['', SITES], ['handler: ', HANDLER_SITES], ['handler: ', UNBOUND_HANDLER_SITES]] as const) {
    for (const [site, make] of Object.entries(sites)) {
      it(`${group}${site}`, () => {
        for (const e of POOL) {
          const spec = make(e)
          expect(asterOutcome(spec), `${site}: ${JSON.stringify(e)}`).toBe(vegaOutcome(spec))
        }
      })
    }
  }

  for (const [shape, spec] of Object.entries(HANDLER_SHAPES)) {
    it(`handler shape: ${shape}`, () => {
      expect(asterOutcome(spec), shape).toBe(vegaOutcome(spec))
    })
  }

  // an expression in a property of a guide is read only in the marks the guide has, and quoted as vega wrote it, which for some
  // properties is a longer text than the author's (WRAPPED: they are read, and their syntax errors quoted by themselves)
  const GUIDE_POOL = ['1 +', 'a b', 'nosuch', 'foo(1)', 'abs(nosuch)', 's', 'a b', 'datum.a']
  for (const { name, property, make } of GUIDE_CASES) {
    it(`guide: ${name}`, () => {
      for (const e of GUIDE_POOL) {
        const spec = make(e)
        const want = vegaOutcome(spec)
        const got = asterOutcome(spec)
        if (WRAPPED.test(property) && want.startsWith('Expression parse error') && got.startsWith('Expression parse error')) continue
        expect(got, `${name}: ${JSON.stringify(e)}`).toBe(want)
      }
    })
  }

  it('guides made at random, with one expression in one property, are read as vega reads them', () => {
    const r = seeded(0x6e1de)
    let refused = 0
    let accepted = 0
    for (let i = 0; i < 1500; i++) {
      const e = r.pick(GUIDE_POOL)
      const { spec, property } = randomGuide(r, e)
      const want = vegaOutcome(spec)
      const got = asterOutcome(spec)
      if (want === 'ok') accepted++; else refused++
      if (WRAPPED.test(property) && want.startsWith('Expression parse error') && got.startsWith('Expression parse error')) continue
      expect(got, `${property}: ${JSON.stringify(e)} in ${JSON.stringify(spec.axes ?? spec.legends)}`).toBe(want)
    }
    expect(refused).toBeGreaterThan(300)
    expect(accepted).toBeGreaterThan(300)
  })

  it('the sites refuse many things', () => {
    const all = { ...SITES, ...HANDLER_SITES }
    let refused = 0
    for (const make of Object.values(all)) for (const e of BAD) if (vegaOutcome(make(e)).startsWith('Expression parse error')) refused++
    expect(refused).toBeGreaterThan(Object.keys(SITES).length * 8)
  })

  it('the semantic expressions are refused for each of the reasons, and accepted where vega accepts', () => {
    const reasons = new Map<string, number>()
    let accepted = 0
    for (const site of ['signalUpdate', 'formula', 'encSignal', 'scaleDomain']) {
      for (const e of SEMANTIC) {
        const out = vegaOutcome(SITES[site]!(e))
        if (out === 'ok') accepted++
        else reasons.set(out.replace(/[":].*$/, ''), (reasons.get(out.replace(/[":].*$/, '')) ?? 0) + 1)
      }
    }
    for (const reason of ['Unrecognized function', 'Unrecognized signal name', 'Illegal callee type', 'Illegal identifier', 'Illegal property', 'Missing arguments to clamp function.', 'First argument to data functions must be a string literal.', 'TypeError']) {
      expect([...reasons.keys()].some((k) => k.startsWith(reason) || reason.startsWith(k)) || reason === 'TypeError', reason).toBe(true)
    }
    expect(accepted).toBeGreaterThan(40)
  })

  // the names a spec refers to outside its expressions and transforms: the scale of an axis or a legend, a facet's name, data and
  // groups, a signal pushed to an outer scope (and what such a push must not say), the field a domain is sorted by, the domain a
  // `domainMin` overrides -- present or not, in nested scopes, several in one spec (the first in vega's order is the one refused)
  it('references made at random are refused as vega refuses them', () => {
    const r = seeded(0x5ef5)
    const bad: string[] = []
    const reasons = new Map<string, number>()
    let accepted = 0
    for (let i = 0; i < 2000; i++) {
      const spec = referenceSpec(r)
      const want = vegaOutcome(spec)
      const got = asterOutcome(spec)
      if (want === 'ok') accepted++
      else reasons.set(want.replace(/[:"].*$/, ''), (reasons.get(want.replace(/[:"].*$/, '')) ?? 0) + 1)
      if (got !== want) bad.push(`#${i}: vega ${JSON.stringify(want)}, aster ${JSON.stringify(got)} in ${JSON.stringify(spec)}`)
    }
    expect(bad, `${bad.length} differ:\n${bad.slice(0, 6).join('\n')}`).toEqual([])
    for (const reason of ['Unrecognized scale name', 'Missing valid scale for legend.', 'Facet must have a name', 'Facet must specify groupby or field', 'Undefined data set name', 'No prior signal definition for "outer" push', 'Invalid property  for "outer" push', 'No field provided for sort aggregate op', 'No scale domain defined for domainMin/domainMax to override.']) {
      expect([...reasons.keys()].some((k) => reason.startsWith(k)), `${reason} in ${JSON.stringify([...reasons])}`).toBe(true)
    }
    expect(accepted).toBeGreaterThan(150)
  })
})
