/**
 * The incremental oracle's own checks: that what it compares it can SEE differ, and that what it reports is true. Each test breaks
 * something the oracle watches (through the hooks of `RunOptions`, between a step's evaluation and its comparison, or after it),
 * runs the oracle on it, and requires the failure the oracle names -- and, beside each, the same run without the break passes.
 */
import { describe, expect, it } from 'vitest'
import { datasetsOfScene } from './index.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import {
  PIPES, checkSeed, featuresOf, historyBound, norm, pipeFor, scenario, scenarioCensus, scenarioSel, wholeNumberKnob, type RunOptions,
} from './incremental-oracle.testlib.js'

const seedOf = (name: string): number => {
  const i = PIPES.findIndex((p) => p.name === name)
  expect(i, `no pipeline ${name}`).toBeGreaterThanOrEqual(0)
  return i + 1
}

describe('the knobs are strict (C654)', () => {
  it('a value that is not a whole number is an error, never a sweep of nothing', () => {
    expect(wholeNumberKnob('K', undefined, 40, 1)).toBe(40)
    expect(wholeNumberKnob('K', '7', 40, 1)).toBe(7)
    for (const raw of ['', ' ', '2k', '1.5', 'NaN', '-3', '0']) expect(() => wholeNumberKnob('K', raw, 40, 1), `"${raw}"`).toThrow(/K must be a whole number of at least 1/)
    expect(wholeNumberKnob('K', '0', 40, 0)).toBe(0)
  })
})

describe('a generated state that does not evaluate is a failure, not an agreement (C513)', () => {
  const broken: typeof scenario = (seed, n) => {
    const sc = scenario(seed, n)
    ;(sc.g.spec.signals as unknown[]).push({ name: 'boom', update: 'sequence(0, 1e9)' })
    return sc
  }
  it('both sides refusing the same state fails the scenario', () => {
    expect(checkSeed(1, 3, broken) ?? '').toMatch(/the generated state does not evaluate on either side/)
    expect(checkSeed(1, 3) ?? '').toBe('')
  })
})

describe('the data sets of a scene are compared (C252)', () => {
  const grow: RunOptions = { beforeCompare: (_, scene) => { (datasetsOfScene(scene).get('t') as unknown[]).push({ x: 1, v: 1 }) } }
  it('a scene whose data set holds a row the fresh one does not fails, though no item shows it', () => {
    const seed = seedOf('none')
    expect(checkSeed(seed, 4) ?? '').toBe('')
    expect(checkSeed(seed, 4, scenario, grow) ?? '').toMatch(/\$\.datasets\./)
  })

  it('a Set is compared by what it holds, not flattened', () => {
    expect(norm(new Set([2, 1]))).toEqual(norm(new Set([1, 2])))
    expect(norm(new Set([1, 2]))).not.toEqual(norm(new Set([1, 3])))
    expect(norm(new Map([['a', 1]]))).not.toEqual(norm(new Map([['a', 2]])))
  })
})

describe('an identifier is compared as identities against a freshly compiled chart (C85)', () => {
  const seed = seedOf('identifier')
  // (a number below `by` is one the engine gave: a row the engine carried to the next step already holds its new number)
  const rowsOf = (scene: SceneRoot): object[] => {
    const out: object[] = []
    for (const rows of datasetsOfScene(scene).values()) out.push(...((rows ?? []) as object[]))
    const walk = (items: readonly SceneItem[]): void => { for (const it of items) { if (it.datum && typeof it.datum === 'object') out.push(it.datum as object); walk((it as SceneGroup).items ?? []) } }
    walk(scene.items as SceneItem[])
    return out
  }
  const shift = (by: number): RunOptions => ({
    beforeCompare: (_, scene) => { for (const row of rowsOf(scene)) { const r = row as { id?: unknown }; if (typeof r.id === 'number' && r.id < by) r.id += by } },
  })
  const duplicate: RunOptions = {
    beforeCompare: (_, scene) => {
      for (const rows of datasetsOfScene(scene).values()) { const r = (rows ?? []) as Array<{ id?: unknown }>; if (r.length > 1 && typeof r[0]?.id === 'number') r[1]!.id = r[0]!.id }
    },
  }

  it('the scenario is checked against a fresh compile, not a chart carried through the states', () => {
    expect(historyBound(scenario(seed, 1).g)).toBe(false)
  })
  it('the same rows under other numbers are the same scene', () => {
    expect(checkSeed(seed, 6) ?? '').toBe('')
    expect(checkSeed(seed, 6, scenario, shift(100)) ?? '').toBe('')
  })
  it('two rows given one number are not', () => {
    expect(checkSeed(seed, 6, scenario, duplicate) ?? '').toMatch(/compared as identities/)
  })
  it('the scenarios whose result depends on how the view got there are the ones named, and only those', () => {
    const bound = [...Array.from({ length: 200 }, (_, i) => scenario(i + 1, 1).g), ...Array.from({ length: 200 }, (_, i) => scenarioSel(i + 1, 1).g)].filter(historyBound)
    expect(bound.length).toBeGreaterThan(0)
    for (const g of bound) expect(g.store === 'ids' || g.features.has('pipe=identifier-falsy'), g.label).toBe(true)
    expect(scenarioSel(1, 1).g.store === 'ids' || Array.from({ length: 50 }, (_, i) => scenarioSel(i + 1, 1).g).some((g) => g.store === 'ids')).toBe(true)
  })
})

describe('the shrinker reports a list that reproduces what it reports (C339)', () => {
  // a scene returned at step 1 is changed after the LAST step: only the final audit sees it, and at the last step
  const N = 8
  const mutateAtEnd: RunOptions = { afterStep: (step, retained) => { if (step === N - 1) (retained[1]!.scene as { width: number }).width += 17 } }
  it('a failure only the final audit sees is reported at the step that found it, with a list that fails the same way', () => {
    const report = checkSeed(seedOf('none'), N, scenario, mutateAtEnd) ?? ''
    expect(report).toMatch(/retained scene from step 0 mutated/)
    expect(report).toContain(`first failing step: ${N - 1} (final audit)`)
    expect(report).toContain(`minimal steps (${N})`)
    expect(report).toMatch(/minimal failure \(re-run on the minimal list\): step \d+ \(final audit\)/)
    expect(report).not.toContain('does NOT reproduce')
  })

  it('a shrink does not end on another failure than the one it was given', () => {
    // (the mutation fires at step 2 and again, differently, at step 5: the first is a mutated retained scene, the second a changed dataset)
    const mixed: RunOptions = {
      afterStep: (step, retained) => { if (step === 2) (retained[0]!.scene as { width: number }).width += 3 },
      beforeCompare: (step, scene) => { if (step === 5) (datasetsOfScene(scene).get('t') as unknown[]).push({ x: 1, v: 1 }) },
    }
    const report = checkSeed(seedOf('none'), 8, scenario, mixed) ?? ''
    const kind = (line: string): string => /\(.*?\) (retained scene from step \d+ mutated|scene)/.exec(report.split('\n').find((l) => l.includes(line)) ?? '')?.[1]?.replace(/\d+/, 'N') ?? 'none'
    expect(kind('first failing step')).not.toBe('none')
    expect(kind('minimal failure')).toBe(kind('first failing step'))
  })
})

describe('the labels and the coverage read what was built (C573)', () => {
  it('a scenario is labelled a facet exactly when its spec has one, a band exactly when it has a band scale', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const g = scenario(seed, 1).g
      expect(g.features.has('nested=facet'), `seed ${seed}`).toBe(JSON.stringify(g.spec).includes('"facet"'))
      expect(g.features.has('scale:band'), `seed ${seed}`).toBe(JSON.stringify(g.spec).includes('"type":"band"'))
      expect(g.features.has('pipe=' + pipeFor(seed).name)).toBe(true)
    }
  })

  it('no census scenario carries an ordinal x-axis it does not have', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const spec = scenarioCensus(seed, 1).g.spec
      const bx = (spec.scales as Array<{ name: string; type: string }>).find((s) => s.name === 'bx')!
      expect(['band', 'point']).toContain(bx.type)
      expect(featuresOf(spec)).not.toContain('scale:ordinal-x')
    }
  })
})
