/**
 * @aster/core's default config and merge rule are copies of vega-parser's
 * `config.js` and vega-util's `mergeConfig`. Copies drift, so the copies are
 * compared with the installed originals (N1).
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { mergeVegaConfig, vegaDefaultConfig } from '../../core/src/config-defaults.js'

const require = createRequire(import.meta.url)
// vega-parser is vega's dependency, not ours: resolve it from vega's own location
const parserDir = join(dirname(require.resolve('vega')), '..', '..', 'vega-parser')
const upstream = (await import(pathToFileURL(join(parserDir, 'src', 'config.js')).href)) as { default: () => Record<string, unknown> }

describe('vega default config', () => {
  it('is exactly vega-parser\'s defaultConfig()', () => {
    expect(vegaDefaultConfig()).toEqual(upstream.default())
  })

  it('returns a fresh object each call (callers may mutate)', () => {
    const a = vegaDefaultConfig()
    ;(a.symbol as Record<string, unknown>).size = 1
    expect((vegaDefaultConfig().symbol as Record<string, unknown>).size).toBe(64)
  })
})

describe('mergeVegaConfig is vega-util mergeConfig', () => {
  const merge = (vega as unknown as { mergeConfig: (...c: Array<Record<string, unknown>>) => Record<string, unknown> }).mergeConfig
  const CASES: Array<[string, Array<Record<string, unknown>>]> = [
    ['user axis keys overwrite defaults, others stay', [upstream.default(), { axis: { gridColor: 'red', domain: false } }]],
    ['symbol block is shallow', [upstream.default(), { symbol: { fill: 'crimson' } }]],
    ['style recurses into every named style', [upstream.default(), { style: { point: { size: 5 }, 'guide-label': { fontSize: 12 }, mine: { fill: 'x' } } }]],
    ['legend recurses only into layout', [upstream.default(), { legend: { orient: 'top', layout: { offset: 3, bottom: { direction: 'horizontal' } } } }]],
    ['signals merge by name, later wins', [{ signals: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] }, { signals: [{ name: 'a', value: 9 }] }]],
    ['null and array values replace', [upstream.default(), { group: { fill: 'x' }, range: { symbol: ['circle'] }, background: 'white' }]],
    ['three configs', [upstream.default(), { axis: { a: 1 } }, { axis: { b: 2 }, title: { orient: 'bottom' } }]],
    ['prototype keys are refused', [upstream.default(), JSON.parse('{"__proto__": {"polluted": true}, "axis": {"constructor": 1, "ok": 2}}')]],
  ]
  for (const [name, configs] of CASES) {
    it(name, () => {
      expect(mergeVegaConfig(...configs)).toEqual(merge(...configs))
    })
  }

  it('does not pollute Object.prototype', () => {
    mergeVegaConfig(JSON.parse('{"__proto__": {"polluted": true}}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
