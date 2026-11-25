/**
 * The incremental-equivalence oracle: for every spec and every sequence of updates, the scene the incremental or streamed path
 * produces deep-equals `evaluateChart(compileChart(spec), input)` built from scratch at that step. The harness, the generators and
 * the coverage counter are in incremental-oracle.testlib.ts (its header says what is compared and how); this file runs the families
 * of scenarios over seeds and holds the sweep to its floors.
 *
 * Every scenario family takes the pipelines in turn (seed n runs pipeline n mod the list), so any run of `PIPES.length` consecutive
 * seeds runs every pipeline, and each family starts from seeds of its own. The floors at the end count what the scenarios that RAN
 * contained (read off their built specs), never what a generator meant to draw: a feature that is not in them fails the test.
 *
 * Knobs (a value that is not a whole number is an error, never a sweep of nothing):
 *   ASTER_ORACLE_SEEDS=200        seeds per family (a sweep shorter than the pipeline list cannot hold the floors, and is refused)
 *   ASTER_ORACLE_SEED=17          run exactly one seed of every family (replay a failure; the floors are not held)
 *   ASTER_ORACLE_STEPS=14         steps per seed
 *   ASTER_ORACLE_START=1000       first seed when sweeping
 */
import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToSvg } from './index.js'
import type { SceneGroup, SceneRoot } from './types.js'
import {
  OFFSET, PIPES, applyStep, wholeNumberKnob, checkSeed, coverage, featuresOf, inputOf, pipeFor, scenario, scenarioCensus, scenarioContainer, scenarioRelational, scenarioRelationalMore, MORE_SHAPE_NAMES, scenarioScoped, scenarioSel, SHAPE_NAMES,
  type Op, type World,
} from './incremental-oracle.testlib.js'

const clone = <T,>(v: T): T => structuredClone(v)
const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)

const knob = (name: string, dflt: number, min: number): number => wholeNumberKnob(name, env(name), dflt, min)

const ONE = env('ASTER_ORACLE_SEED') === undefined ? undefined : knob('ASTER_ORACLE_SEED', 0, 0)
const STEPS = knob('ASTER_ORACLE_STEPS', 12, 1)
const START = knob('ASTER_ORACLE_START', 1, 1)
/** The default sweep is one run of every pipeline per family; a shorter one cannot hold the floors (a replay of one seed does not hold them). */
const SEEDS = knob('ASTER_ORACLE_SEEDS', PIPES.length, ONE === undefined ? PIPES.length : 1)
const SWEEP = ONE === undefined

const seedList = (n = SEEDS): number[] => (ONE !== undefined ? [ONE] : Array.from({ length: n }, (_, i) => START + i))
/** The relational family takes every shape in turn, several times over (the shapes rotate their marks and scales by occurrence). */
const RELATIONAL_SEEDS = Math.max(SEEDS, 8 * SHAPE_NAMES.length)

describe('the knobs', () => {
  it('the sweep has seeds to run', () => {
    expect(seedList().length).toBeGreaterThan(0)
  })
})

describe('incremental === fresh evaluateChart(compileChart(spec))', () => {
  it('the generator is deterministic per seed', () => {
    const a = scenario(7, 6), b = scenario(7, 6)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(scenario(8, 6))).not.toBe(JSON.stringify(a))
  })

  it('every pipeline runs, in turn, over any run of as many seeds as there are pipelines', () => {
    for (const start of [1, 17, 1000]) {
      const names = Array.from({ length: PIPES.length }, (_, i) => pipeFor(start + i).name)
      expect(new Set(names).size).toBe(PIPES.length)
    }
    // ... and the scenario of a seed really is built from its pipeline (the label reads the built spec)
    for (let seed = 1; seed <= PIPES.length; seed++) expect(scenario(seed, 1).g.features.has(`pipe=${pipeFor(seed).name}`)).toBe(true)
  })

  // one test per seed: a worker that runs one long synchronous test cannot answer its host (vitest's onTaskUpdate RPC)
  for (const seed of seedList()) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

describe('incremental === fresh with selection stores that are edited between updates', () => {
  it('the generator is deterministic per seed and covers fields, ids, filters, conditions and resolves', () => {
    expect(JSON.stringify(scenarioSel(7, 6))).toBe(JSON.stringify(scenarioSel(7, 6)))
    const all = Array.from({ length: 200 }, (_, i) => scenarioSel(i + 1, 1).g.label).join('\n')
    for (const need of ['sel=ids', 'sel=fields/union', 'sel=fields/intersect', 'filter', 'encode', 'resolve']) {
      expect(all, `generator never produces ${need}`).toContain(need)
    }
    const ops = new Set(Array.from({ length: 40 }, (_, i) => scenarioSel(i + 1, 12).steps.map((x) => x.op)).flat())
    expect(ops.has('store')).toBe(true)
  })

  it('a store edit reaches the scene: the stores the scenarios build are not all empty', () => {
    let nonEmpty = 0
    for (let seed = 1; seed <= 40; seed++) {
      let w = scenarioSel(seed, 12).world
      const { steps } = scenarioSel(seed, 12)
      for (const st of steps) w = applyStep(w, st)
      if (w.sel.length) nonEmpty++
    }
    expect(nonEmpty).toBeGreaterThan(10)
  })

  for (const seed of seedList()) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS, scenarioSel) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

describe('incremental === fresh with group scopes whose signals events write between updates', () => {
  it('the generator is deterministic per seed and the scopes are real', () => {
    expect(JSON.stringify(scenarioScoped(7, 6))).toBe(JSON.stringify(scenarioScoped(7, 6)))
    const sc = scenarioScoped(3, 4)
    const scene = evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, sc.world))
    const ids: string[] = []
    const walk = (g: SceneGroup): void => { if (g.scopeSignals) ids.push(g.scopeSignals.id); for (const c of g.items ?? []) if ((c as SceneGroup).items) walk(c as SceneGroup) }
    for (const g of scene.items) walk(g)
    expect(ids).toEqual([sc.g.scoped!.outer, sc.g.scoped!.inner])
    expect(new Set(Array.from({ length: 40 }, (_, i) => scenarioScoped(i + 1, 12).steps.map((x) => x.op)).flat()).has('scoped')).toBe(true)
  })

  it('the scoped signals reach the scene: the stored value changes what is drawn', () => {
    const sc = scenarioScoped(3, 4)
    const a = evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, sc.world))
    const b = evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, { ...sc.world, scoped: { outer: 6, inner: 5 } }))
    expect(renderSceneToSvg(a)).not.toBe(renderSceneToSvg(b))
  })

  for (const seed of seedList()) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS, scenarioScoped) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

describe('incremental === fresh on container-sized views that are resized between updates', () => {
  it('the generator is deterministic per seed and the views are container-sized', () => {
    expect(JSON.stringify(scenarioContainer(7, 6))).toBe(JSON.stringify(scenarioContainer(7, 6)))
    const all = Array.from({ length: 200 }, (_, i) => scenarioContainer(i + 1, 1).g.label).join('\n')
    for (const need of ['container(fit)', 'container(fit-x)', 'container(fit-y)', 'container(pad)', 'container(none)', 'container(fill)']) {
      expect(all, `generator never produces ${need}`).toContain(need)
    }
    const ops = new Set(Array.from({ length: 40 }, (_, i) => scenarioContainer(i + 1, 12).steps.map((x) => x.op)).flat())
    expect(ops.has('resize')).toBe(true)
    expect(ops.has('size')).toBe(true)
  })

  it('the container reaches the scene, and a view size the host fixed is not moved by the size signals', () => {
    const sc = scenarioContainer(3, 4)
    const at = (w: Partial<World>): SceneRoot => evaluateChart(compileChart(clone(sc.g.spec) as never), inputOf(sc.g, { ...sc.world, width: undefined, height: undefined, sizeSig: undefined, ...w }))
    expect(renderSceneToSvg(at({ container: { width: 420, height: 280 } }))).not.toBe(renderSceneToSvg(at({ container: { width: 320, height: 200 } })))
    // the unfixed view follows the signals the event loop wrote ...
    expect(renderSceneToSvg(at({ sizeSig: { width: 300, height: 300 } }))).not.toBe(renderSceneToSvg(at({})))
    // ... a fixed one does not
    const fixed = { width: 480, height: 260 }
    expect(renderSceneToSvg(at({ ...fixed, sizeSig: { width: 300, height: 300 } }))).toBe(renderSceneToSvg(at({ ...fixed })))
  })

  for (const seed of seedList()) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS, scenarioContainer) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

// Seed 100 of the container scenario as the generator drew it before the families took seeds of their own: a data set whose rows are
// shuffled, evaluated in a view that was a different size the time before. The first fit pass numbered the rows by alignment, the
// second by the pulse, so the legend the padding comes from showed other ids than the scene drew (padding.right 78 for 47). Every pass
// of one evaluation must see the ids of the same rows. (The seed is kept; what it draws changed with the generator.)
describe('the passes of one evaluation number the same rows alike', () => {
  it('seed 100 of the container-sized views', () => {
    expect(checkSeed(100, STEPS, scenarioContainer) ?? '').toBe('')
  }, 600_000)
})

describe('incremental === fresh when every scale reads the source dataset (the domain census, scale reuse)', () => {
  it('the generator is deterministic per seed and drives the census ops', () => {
    expect(JSON.stringify(scenarioCensus(7, 6))).toBe(JSON.stringify(scenarioCensus(7, 6)))
    const ops = new Set(Array.from({ length: 40 }, (_, i) => scenarioCensus(i + 1, 12).steps.map((x) => x.op)).flat())
    for (const need of ['low', 'dropMin', 'removeExt', 'newGroup', 'swapCat', 'edit-group']) expect(ops.has(need as Op), `no ${need} step`).toBe(true)
    // (what the scenarios are, read off their specs: a band scale is a band scale, an ordinal one is not drawn as one)
    const types = new Set(Array.from({ length: 100 }, (_, i) => featuresOf(scenarioCensus(i + 1, 1).g.spec)).flat())
    for (const need of ['scale:pow', 'scale:linear', 'scale:band', 'scale:point', 'scale:ordinal', 'scale.zero', 'scale.no-zero', 'scale.nice', 'domain.sort']) expect(types.has(need), `no ${need} scenario`).toBe(true)
  })

  for (const seed of seedList()) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS, scenarioCensus) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

describe('incremental === fresh over the relational layer (what a node reads, not the rows it is drawn from)', () => {
  it('the generator is deterministic per seed and takes every shape in turn', () => {
    expect(seedList(RELATIONAL_SEEDS).length === 1 || RELATIONAL_SEEDS >= 8 * SHAPE_NAMES.length).toBe(true)
    expect(JSON.stringify(scenarioRelational(7, 6))).toBe(JSON.stringify(scenarioRelational(7, 6)))
    for (let seed = 1; seed <= SHAPE_NAMES.length; seed++) expect(scenarioRelational(seed, 1).g.features.has(`shape=${SHAPE_NAMES[seed - 1]}`), `seed ${seed}`).toBe(true)
  })

  for (const seed of seedList(RELATIONAL_SEEDS)) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS, scenarioRelational) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

// The audited defects of the incremental path, as the relational family draws them. Each seed below FAILED on the base the audit ran on
// (d30ead9) and passes now; it is kept because the shape it draws is the one the defect lived in, not because of the seed. The seeds are
// those of the generator as it is: a test that each still draws its shape (below) fails the day the generator moves them.
const HISTORICAL: ReadonlyArray<{ finding: string; seed: number; shape: string }> = [
  { finding: 'C7 (a mark drawn from a mark kept its items when the rows it was drawn from were edited in place)', seed: 67, shape: 'mark-from-mark' },
  { finding: 'C7 (the same, with a second mark layered on it)', seed: 186, shape: 'mark-from-mark' },
  { finding: 'C24 (a signal that holds a dataset past 512 values was keyed by identity)', seed: 116, shape: 'large-signal' },
  { finding: 'C24 (the same, a larger dataset)', seed: 193, shape: 'large-signal' },
  { finding: 'C26 (a leaf mark in a group item went stale when another dataset it reads grew)', seed: 179, shape: 'nested-reads' },
  { finding: 'C26 (the same, from a facet cell)', seed: 69, shape: 'nested-reads' },
  { finding: 'C26 (the same, a dataset that gains rows)', seed: 153, shape: 'nested-reads' },
  { finding: 'C42 (a fitted projection went stale for the consumers whose own rows did not change)', seed: 27, shape: 'fitted-projection' },
  { finding: 'C42 (the same, in the size the legend padding comes from)', seed: 49, shape: 'fitted-projection' },
]

describe('the seeds that caught the audited defects still draw their shapes and hold', () => {
  for (const h of HISTORICAL) {
    it(`${h.finding}: seed ${h.seed}`, () => {
      expect(scenarioRelational(h.seed, STEPS).g.features.has(`shape=${h.shape}`), `seed ${h.seed} no longer draws ${h.shape}`).toBe(true)
      expect(checkSeed(h.seed, STEPS, scenarioRelational) ?? '').toBe('')
    }, 600_000)
  }
})

describe('incremental === fresh over images, time scales and parsed data', () => {
  it('the generator takes every shape in turn', () => {
    for (let seed = 1; seed <= MORE_SHAPE_NAMES.length; seed++) expect(scenarioRelationalMore(seed, 1).g.features.has(`shape=${MORE_SHAPE_NAMES[seed - 1]}`), `seed ${seed}`).toBe(true)
  })
  for (const seed of seedList(Math.max(SEEDS, 12 * MORE_SHAPE_NAMES.length))) {
    it(`holds for seed ${seed} x ${STEPS} steps (chart reuse + session)`, () => {
      expect(checkSeed(seed, STEPS, scenarioRelationalMore) ?? '', `seed ${seed}`).toBe('')
    }, 600_000)
  }
})

/** What the scenarios that ran must have contained, at least this many times (read off their built specs, see `featuresOf`). */
const FLOORS: ReadonlyArray<readonly [string, number]> = [
  ...SHAPE_NAMES.map((n) => [`shape=${n}`, 3] as const),
  ...['symbol', 'rect', 'text', 'line', 'area', 'rule', 'arc', 'trail', 'path', 'group', 'shape'].map((m) => [`mark:${m}`, 2] as const),
  ...['linear', 'band', 'point', 'ordinal', 'pow', 'sqrt', 'symlog', 'log', 'quantize', 'quantile', 'threshold', 'sequential', 'bin-ordinal'].map((t) => [`scale:${t}`, 1] as const),
  ['mark-from-mark', 5], ['mark-from-mark@group', 2], ['nested=facet', 5], ['nested=scoped', 5], ['nested=leaf-reads-data', 5], ['enter+update', 3], ['exit', 2], ['hover', 2],
  ['mark:image', 3], ['scale:time', 3], ['scale:utc', 3], ['data:format.parse', 3], ['mark.key', 2], ['mark.zindex', 2], ['mark.sort', 2], ['layout', 2], ['axis:encode', 2], ['projection:fit', 5], ['signal:init', 3], ['signal:reads-data', 3],
  ['encode:per-item-signal', 5], ['encode:rules', 5], ['range=scheme', 1], ['mark.transform:label', 1], ['mark.transform:geopoint', 1], ['mark.transform:geoshape', 1], ['transform:extent', 2],
  ['op:empty', 5], ['op:odd', 10], ['op:appendU', 5], ['op:bulk', 2], ['op:bulkU', 2], ['rows:kept', 20], ['delivery:dataPulse', 20], ['delivery:inplace', 20], ['via:change', 10],
  ['sel=ids', 3], ['sel=fields/union', 3], ['scoped-signals', 3], ['container(fit)', 1], ['census', 3],
]

describe('the sweep covered what it claims to', () => {
  it('every feature the oracle claims was in scenarios that ran, at least its floor many times', () => {
    // (a replay of one seed runs one scenario of each family: it holds no floor)
    const short = FLOORS.filter(([name, floor]) => (coverage().get(name) ?? 0) < floor).map(([name, floor]) => `${name}: ${coverage().get(name) ?? 0} < ${floor}`)
    expect(SWEEP ? short : []).toEqual([])
  })

  it('every pipeline the seeds that ran draw ran, in every family it takes pipelines from', () => {
    const missing: string[] = []
    for (const family of ['scenario', 'scenarioSel', 'scenarioScoped', 'scenarioContainer'] as const) {
      const drawn = new Set(seedList().map((seed) => pipeFor(seed + OFFSET[family]).name))
      for (const name of drawn) if ((coverage().get(`${family}:pipe=${name}`) ?? 0) < 1) missing.push(`${family}:${name}`)
    }
    expect(missing).toEqual([])
  })

  it('a sweep runs every pipeline in every family (a shorter list is refused above, a replay of one seed holds only its own)', () => {
    const families = ['scenario', 'scenarioSel', 'scenarioScoped', 'scenarioContainer'] as const
    for (const family of families) {
      const names = new Set(seedList().map((seed) => pipeFor(seed + OFFSET[family]).name))
      expect(SWEEP ? names.size : 1).toBe(SWEEP ? PIPES.length : 1)
    }
  })
})
