/**
 * GENERATED live differential of what an expression may read where only signals are in scope (a signal's `init` / `update`, a
 * `{signal}` of a scale, a view size or a transform parameter -- vega's parameter and operator expressions). Real Vega and Aster
 * run the same specs in one process: `datum`, `event` and `item` are not defined there (`ReferenceError: datum is not defined`, when
 * the read is evaluated: `false && datum` is fine), and neither are the event functions (`item()` reads `event`). Both sides must
 * log the same errors and leave the same signals (read through a text mark).
 */
import { describe, expect, it, vi } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '../../core/src/index.ts'

vi.setConfig({ testTimeout: 120_000 })

/** Reads of the three names in every position a signal-only expression can put them. */
const EXPRESSIONS = [
  'datum', 'event', 'item', 'datum.x', 'datum["x"]', 'event.x', 'item.datum', 'item()', 'view()', 'group()', 'xy()', 'x()', 'y()',
  'false && datum', 'true || event', 'a > 0 ? 1 : item', 'a < 0 ? datum.x : 2', 'isObject(datum)', 'length(datum)', '[a, datum]',
  '{k: item}', 'datum || 3', 'a + 1', 'a', '!event', 'typeof_like(a)',
]

/** `drawn`: the scene is compared too (a failing view size ends vega's run before any mark is drawn: the failures alone are compared). */
type Form = { name: string; drawn?: false; spec: (code: string) => Record<string, unknown> }
const text = { type: 'text', encode: { enter: { text: { signal: "'s=' + s" } } } }
const FORMS: Form[] = [
  { name: 'init', spec: (c) => ({ signals: [{ name: 'a', value: 1 }, { name: 's', init: c }], marks: [text] }) },
  { name: 'update', spec: (c) => ({ signals: [{ name: 'a', value: 1 }, { name: 's', value: 'kept', update: c }], marks: [text] }) },
  { name: 'transform parameter', drawn: false, spec: (c) => ({ signals: [{ name: 'a', value: 1 }, { name: 's', value: 'kept' }], data: [{ name: 't', transform: [{ type: 'sequence', start: 0, stop: { signal: c }, step: 1 }] }], marks: [{ ...text, from: { data: 't' } }] }) },
  { name: 'view size', drawn: false, spec: (c) => ({ signals: [{ name: 'a', value: 1 }, { name: 's', value: 'kept' }], width: { signal: c }, height: 20, marks: [text] }) },
  { name: 'scale property', spec: (c) => ({ signals: [{ name: 'a', value: 1 }, { name: 's', value: 'kept' }], scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1], zero: { signal: c } }], marks: [text] }) },
]

function viaVega(spec: Record<string, unknown>): { errors: string[]; text: unknown } {
  const errors: string[] = []
  const logger = { level() { return this }, error(...a: unknown[]) { errors.push(String(a[0])); return this }, warn() { return this }, info() { return this }, debug() { return this } }
  const view = new vega.View(vega.parse({ ...spec, width: 10, height: 10, ...spec }), { renderer: 'none', logger: logger as never })
  view.run()
  const items: unknown[] = []
  const walk = (n: any): void => { if (n?.marktype === 'text') for (const i of n.items ?? []) items.push(i.text); else for (const c of n?.items ?? []) walk(c) }
  walk((view as any).scenegraph().root)
  return { errors, text: items[0] }
}

function viaAster(spec: Record<string, unknown>): { errors: string[]; text: unknown } {
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(String(a[0] instanceof Error ? a[0].message : a[0])) }, warn: () => {} }
  const scene = evaluateChart(compileChart({ width: 10, height: 10, ...spec } as never), { logger })
  const items: unknown[] = []
  const walk = (n: any): void => { if (n?.marktype === 'text') for (const i of n.items ?? []) items.push(i.text); else for (const c of n?.items ?? []) walk(c) }
  walk(scene)
  return { errors, text: items[0] }
}

/** `ReferenceError: x is not defined` and the message alone name the same failure. */
const normal = (e: string): string => e.replace(/^ReferenceError: /, '').replace(/\s*\(.*$/, '')

describe(`signal-only expressions vs vega@${vega.version} (datum, event, item are not defined)`, () => {
  for (const form of FORMS) {
    it(`${form.name}: every read of datum / event / item and of the event functions fails as vega's generated code does`, () => {
      const bad: string[] = []
      let refused = 0
      for (const code of EXPRESSIONS) {
        const spec = form.spec(code)
        let want, got
        try { want = viaVega(spec) } catch (e) { continue } // (the parser refuses it: nothing to compare)
        try { got = viaAster(spec) } catch (e) { got = { errors: [`THROW ${(e as Error).message}`], text: undefined } }
        if (want.errors.some((e) => /is not defined/.test(e))) refused++
        const shown = (v: unknown): string => (form.drawn === false ? '' : v !== null && typeof v === 'object' ? '[object]' : String(v))
        const w = JSON.stringify({ e: want.errors.map(normal), t: shown(want.text) })
        const g = JSON.stringify({ e: got.errors.map(normal), t: shown(got.text) })
        if (w !== g) bad.push(`${code}\n   vega  ${w}\n   aster ${g}`)
      }
      expect(bad.join('\n')).toBe('')
      // the reads that must fail are most of the list, or the test says little
      expect(refused).toBeGreaterThan(10)
    })
  }
})
