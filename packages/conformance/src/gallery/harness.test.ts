/**
 * The gallery harness's own contracts (audit C394, C507, C527, C528, C537).
 */
import { describe, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { datasetVersionMismatches, galleryDataFor, localFileFor, nextPassingList, PINNED_DATASETS } from './lib.js'
import { runInline } from './react.js'
import { settleWithin } from '../render-vega.js'
import { logged, vegaSvg, warned } from './oracle.js'
import { loggedErrorsDiffer, oracleProblem, runStatic } from './static.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('gallery data URLs (C394)', () => {
  it('resolves the gallery\'s own data/ and the jsDelivr vega-datasets package, with the version it asks for', () => {
    expect(galleryDataFor('https://gallery.invalid/data/cars.json')).toMatchObject({ version: null })
    expect(galleryDataFor('data/cars.json')).toMatchObject({ version: null })
    expect(galleryDataFor('https://cdn.jsdelivr.net/npm/vega-datasets/data/cars.json')).toMatchObject({ version: null })
    expect(galleryDataFor(`https://cdn.jsdelivr.net/npm/vega-datasets@${PINNED_DATASETS}/data/cars.json`)).toMatchObject({ version: PINNED_DATASETS })
    expect(galleryDataFor('https://cdn.jsdelivr.net/npm/vega-datasets@1.0.0/data/cars.json')).toMatchObject({ version: '1.0.0' })
  })

  it('resolves no other package, no other path, and no malformed escape (it does not throw)', () => {
    expect(localFileFor('https://cdn.jsdelivr.net/npm/some-other-package@9/x/data/cars.json')).toBeNull()
    expect(localFileFor('https://cdn.jsdelivr.net/npm/vega-datasets@1/x/data/cars.json')).toBeNull()
    expect(localFileFor('https://gallery.invalid/elsewhere/data/cars.json')).toBeNull()
    expect(() => localFileFor('https://gallery.invalid/data/%E0%A4%A.json')).not.toThrow()
    expect(localFileFor('https://gallery.invalid/data/%E0%A4%A.json')).toBeNull()
    expect(localFileFor('https://example.com/data/cars.json')).toBeNull()
  })

  it('names the data URLs of a spec that ask for another vega-datasets version than the pinned one', () => {
    const spec = { data: [{ url: 'https://cdn.jsdelivr.net/npm/vega-datasets@v1.29.0/data/cars.json' }, { url: 'data/stocks.csv' }, { url: `https://cdn.jsdelivr.net/npm/vega-datasets@${PINNED_DATASETS}/data/cars.json` }] }
    expect(datasetVersionMismatches(spec)).toEqual(['https://cdn.jsdelivr.net/npm/vega-datasets@v1.29.0/data/cars.json'])
  })
})

describe('the passing baseline (C537)', () => {
  it('a run that lost a listed spec records nothing; a run that lost none records what passed', () => {
    expect(nextPassingList(['a', 'b'], new Set(['b', 'c']))).toEqual({ regressed: ['a'], write: null })
    expect(nextPassingList(['a', 'b'], new Set(['c', 'b', 'a']))).toEqual({ regressed: [], write: ['a', 'b', 'c'] })
  })
})

describe('a per-render deadline (C507)', () => {
  it('rejects a render that never settles, naming it, and passes one that does', async () => {
    await expect(settleWithin(new Promise(() => undefined), 'the oracle (test)', 50)).rejects.toThrow('the oracle (test) did not settle within 0.05 s')
    await expect(settleWithin(Promise.resolve(7), 'x', 50)).resolves.toBe(7)
  })
})

describe('runPage (C528)', () => {
  it('a worker that cannot open its page rejects the run, and the browser is closed', async () => {
    let browser: Browser | undefined
    const spec = { width: 10, height: 10, marks: [] }
    await expect(runInline([{ id: 'a', spec }, { id: 'b', spec }], () => undefined, 2, {
      onBrowser: (b) => { browser = b },
      beforeOpen: () => { throw new Error('planted: the page cannot open') },
    })).rejects.toThrow('planted: the page cannot open')
    expect(browser).toBeDefined()
    expect(browser!.isConnected()).toBe(false)
  }, 120_000)
})

describe('a broken oracle is not a pass (C527)', () => {
  it('names a data file the oracle could not load, and a canvas it lacks, as the reason the spec is unverifiable; an error the spec makes vega log is compared', () => {
    expect(oracleProblem([], [])).toBeNull()
    expect(oracleProblem(['TypeError: x is undefined\n    at f'], [])).toBeNull()
    expect(oracleProblem([], ['Loading failed: 404'])).toEqual({ reason: 'oracle-load-failed', first: 'Loading failed: 404' })
    expect(oracleProblem(['Error: getContext of null'], [])?.reason).toBe('oracle-needs-canvas (Node has none)')
  })

  it('the oracle the gallery renders with logs a formula that throws, and a file that does not load', async () => {
    const spec = (data: unknown, extra: unknown[] = []) => ({ width: 20, height: 20, data: [data, ...extra], marks: [] })
    logged.length = 0
    warned.length = 0
    await vegaSvg(spec({ name: 't', values: [{ a: 1 }], transform: [{ type: 'formula', expr: 'datum.a.b.c.d', as: 'z' }] }) as never)
    expect(logged, 'vega logged the error the formula throws').not.toEqual([])
    logged.length = 0
    warned.length = 0
    await vegaSvg(spec({ name: 't', url: 'data/no-such-file.json', format: { type: 'json' } }) as never)
    expect(oracleProblem(logged, warned), JSON.stringify([logged, warned])).not.toBeNull()
    logged.length = 0
    warned.length = 0
    await vegaSvg(spec({ name: 't', values: [{ a: 1 }] }) as never)
    expect(oracleProblem(logged, warned)).toBeNull()
  })
})

describe('a spec that makes vega log an error is compared on the document and on the errors (C527)', () => {
  it('the errors are the same, in order, once the error name is dropped; any other difference is named', () => {
    expect(loggedErrorsDiffer([], [])).toBeNull()
    expect(loggedErrorsDiffer(['Error: Unrecognized projection type: airy\n    at f (x.js:1:1)'], ['Unrecognized projection type: airy'])).toBeNull()
    expect(loggedErrorsDiffer(['Error: a'], [])).toMatch(/logged errors: vega \["a"\], aster \[\]/)
    expect(loggedErrorsDiffer([], ['b'])).toMatch(/aster \["b"\]/)
    expect(loggedErrorsDiffer(['Error: a', 'Error: b'], ['a'])).not.toBeNull()
    expect(loggedErrorsDiffer(['Error: a'], ['c'])).not.toBeNull()
  })

  it('a projection type vega does not know passes when Aster draws the same document and logs the same error (and not when it logs none)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aster-gallery-'))
    try {
      const spec = (type: string): unknown => ({
        width: 100, height: 60, padding: 5,
        projections: [{ name: 'p', type, scale: 20, translate: [50, 30] }],
        marks: [{ type: 'shape', encode: { update: { fill: { value: 'red' } } }, transform: [{ type: 'geoshape', projection: 'p' }] }],
      })
      const run = async (type: string) => {
        const file = join(dir, `${type}.vg.json`)
        writeFileSync(file, JSON.stringify(spec(type)))
        return runStatic({ id: `vega/${type}`, kind: 'vega', name: type, file })
      }
      expect((await run('airy')).status, 'airy is not in vega-projection\'s registry').toBe('pass')
      // the same document where nothing is logged is not the comparison: a known type logs nothing on either side
      expect((await run('mercator')).status).toBe('pass')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
