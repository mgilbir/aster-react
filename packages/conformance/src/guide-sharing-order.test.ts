/**
 * The guides' marks are shared between charts (by content). A chart must render the same whatever was rendered before it in
 * the process: the whole corpus forward, then shuffled, in one worker, and charts that have the same guide content but other
 * signals, scale types and data, evaluated interleaved. Sliced into short tests (one long one starves the worker's heartbeat).
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster/core'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')
const files = readdirSync(CORPUS).filter((f) => f.endsWith('.vg.json') || f.endsWith('.vl.json')).sort()
const SLICES = 8
const slice = (list: string[], i: number): string[] => list.filter((_, j) => j % SLICES === i)

let seed = 7
const shuffled = [...files].sort(() => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5)

function render(f: string): string {
  const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8')) as Record<string, unknown>
  const spec = f.endsWith('.vl.json') ? (vl.compile(raw as never).spec as unknown as Record<string, unknown>) : raw
  const log = console.error; const warn = console.warn
  console.error = () => {}; console.warn = () => {}
  try {
    return createHash('sha1').update(renderSpec(spec as never)).digest('hex')
  } catch (e) {
    return 'ERR ' + String((e as Error).message)
  } finally {
    console.error = log; console.warn = warn
  }
}

const forward = new Map<string, string>()
describe('the corpus, forward', () => {
  for (let i = 0; i < SLICES; i++) it(`slice ${i + 1} of ${SLICES}`, () => { for (const f of slice(files, i)) forward.set(f, render(f)) }, 120_000)
})
describe('the corpus, shuffled, in the same process', () => {
  for (let i = 0; i < SLICES; i++) {
    it(`slice ${i + 1} of ${SLICES} renders as it did forward`, () => {
      const wrong: string[] = []
      for (const f of slice(shuffled, i)) if (render(f) !== forward.get(f)) wrong.push(f)
      expect(wrong).toEqual([])
    }, 120_000)
  }
})

// the same axis and legend content, other signals, scale types and data
const mk = (v: number, type: string, fmt: string): Record<string, unknown> => ({
  width: 200, height: 100,
  signals: [{ name: 'off', value: v }, { name: 'fmt', value: fmt }, { name: 'ttl', value: 'T' + v }],
  data: [{ name: 't', values: [{ a: 'p', b: 1 + v }, { a: 'q', b: 5 * v + 2 }] }],
  scales: [
    { name: 'x', type, domain: type === 'band' ? { data: 't', field: 'a' } : [0, 10 * v + 5], range: 'width' },
    { name: 'c', type: 'ordinal', domain: { data: 't', field: 'a' }, range: { scheme: 'category10' } },
  ],
  axes: [{ orient: 'bottom', scale: 'x', grid: true, title: { signal: 'ttl' }, format: { signal: 'fmt' },
    encode: { grid: { update: { strokeOpacity: { signal: 'off / 10' } } }, labels: { update: { dx: { signal: 'off' } } } } }],
  legends: [{ fill: 'c', title: { signal: 'ttl' }, encode: { labels: { update: { fontSize: { signal: '8 + off' } } } } }],
  marks: [],
})
describe('charts with the same guide content and other signals, scale types and data', () => {
  const specs = [mk(1, 'linear', '.1f'), mk(2, 'band', ''), mk(3, 'linear', '.3f'), mk(1, 'linear', '.2f'), mk(2, 'linear', '.1f')]
  const hash = (s: string): string => createHash('sha1').update(s).digest('hex')
  it('evaluate interleaved as each does alone', () => {
    const alone = specs.map((s) => hash(renderSpec(s as never)))
    const charts = specs.map((s) => compileChart(s as never))
    const order = [0, 1, 2, 3, 4, 3, 2, 1, 0, 4, 1, 3]
    for (let r = 0; r < 3; r++) for (const i of order) expect(hash(renderSceneToSvg(evaluateChart(charts[i]!)))).toBe(alone[i])
  })
})
