import { describe, expect, it } from 'vitest'
import { parsePairId, planSwap, swapGateProblems } from './swap-plan.js'

const spec = (id: string) => ({ id })
const byId = new Map(['vega/a', 'vega/b', 'vl/c', 'vl/d'].map((id) => [id, spec(id)]))
const IDS = ['vega/a => vl/c', 'vega/a => vl/d', 'vega/b => vl/c']

describe('the spec-swap plan reads the committed pair list, not the passing lists', () => {
  it('runs every pair whose B passes fresh', () => {
    const plan = planSwap(IDS, byId, new Set(['vl/c', 'vl/d']))
    expect(plan.runnable.map((p) => p.id)).toEqual(IDS)
    expect(plan.skipped).toEqual([])
  })

  it('a B that left the passing list is SKIPPED with a reason, and is not a regression', () => {
    const plan = planSwap(IDS, byId, new Set(['vl/c']))
    expect(plan.skipped).toEqual([{ id: 'vega/a => vl/d', reason: 'B no longer passes fresh' }])
    expect(plan.runnable.map((p) => p.id)).toEqual(['vega/a => vl/c', 'vega/b => vl/c'])
    const results = new Map(plan.runnable.map((p) => [p.id, 'pass']))
    expect(swapGateProblems(plan, results, 2)).toEqual([])
  })

  it('a spec that left the gallery is skipped with its own reason; a passing list that GROWS changes nothing', () => {
    const small = new Map([...byId].filter(([id]) => id !== 'vega/b'))
    expect(planSwap(IDS, small, new Set(['vl/c', 'vl/d'])).skipped.map((k) => k.reason)).toEqual(['A (vega/b) is no longer in the gallery'])
    const grown = planSwap(IDS, byId, new Set(['vl/c', 'vl/d', 'vega/a', 'vega/b']))
    expect(grown.runnable.map((p) => p.id)).toEqual(IDS)
  })

  it('fewer runnable pairs than the floor fails, even though nothing failed', () => {
    const plan = planSwap(IDS, byId, new Set())
    expect(plan.runnable).toEqual([])
    const problems = swapGateProblems(plan, new Map(), 2)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('0 runnable pairs < floor 2')
  })

  it('a runnable pair that does not pass still fails (the skip is not a way out)', () => {
    const plan = planSwap(IDS, byId, new Set(['vl/c', 'vl/d']))
    const results = new Map(plan.runnable.map((p) => [p.id, 'pass']))
    results.set('vega/a => vl/d', 'fail')
    expect(swapGateProblems(plan, results, 1).join()).toContain('vega/a => vl/d [fail]')
  })

  it('rejects a malformed line', () => {
    expect(() => parsePairId('vega/a vl/c')).toThrow(/A => B/)
  })
})
