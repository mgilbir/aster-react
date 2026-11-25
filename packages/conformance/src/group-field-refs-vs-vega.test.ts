/**
 * `{field: {group | parent: <field>, level}}`, against real vega (C119).
 *
 * vega-parser's resolveField writes `item.mark.group` `level` times (at least once), then the field: of that group item -- any of
 * its properties as its encode wrote them (`width`, `fill`, `strokeWidth`, a channel of its own, `datum.k`) -- or of its datum
 * (`parent`). Aster knew `width`/`height`/`x`/`y` of the enclosing group only (anything else was 0) and ignored `level`. Generated:
 * each kind of field, levels 1 to 3 from a mark in a plain group, a facet cell and a group in a cell, and from the view's own marks;
 * the item values (or vega's error, past the view's group item) are compared.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>

const REFS: Array<[string, unknown]> = [
  ['width', { group: 'width' }], ['height', { group: 'height' }], ['x', { group: 'x' }], ['fill', { group: 'fill' }],
  ['strokeWidth', { group: 'strokeWidth' }], ['custom', { group: 'custom' }], ['datum.g', { group: 'datum.g' }], ['missing', { group: 'nothere' }],
  ['parent g', { parent: 'g' }], ['parent missing', { parent: 'zz' }],
]
const SHAPES = ['view', 'group', 'facet', 'group in facet'] as const

function caseOf(i: number): { id: string; spec: Spec } {
  const [refName, ref] = REFS[i % REFS.length]!
  const level = 1 + (Math.floor(i / REFS.length) % 3)
  const shape = SHAPES[Math.floor(i / (REFS.length * 3)) % SHAPES.length]!
  const field = { ...(ref as Spec), ...(level > 1 ? { level } : {}) }
  const leaf = { type: 'text', name: 'm', encode: { update: { x: { value: 1 }, y: { value: 2 }, a: { field } } } }
  const groupEnc = (n: number): Spec => ({ x: { value: 10 * n }, y: { value: 5 * n }, width: { value: 100 + n }, height: { value: 50 + n }, fill: { value: `#00${n}${n}00` }, strokeWidth: { value: n }, custom: { value: `c${n}` } })
  let marks: unknown[]
  if (shape === 'view') marks = [leaf]
  else if (shape === 'group') marks = [{ type: 'group', encode: { update: groupEnc(1) }, marks: [leaf] }]
  else if (shape === 'facet') marks = [{ type: 'group', from: { facet: { data: 't', name: 'f', groupby: 'g' } }, encode: { update: groupEnc(2) }, marks: [leaf] }]
  else marks = [{ type: 'group', from: { facet: { data: 't', name: 'f', groupby: 'g' } }, encode: { update: groupEnc(2) }, marks: [{ type: 'group', encode: { update: groupEnc(3) }, marks: [leaf] }] }]
  const spec = { width: 200, height: 100, padding: 0, autosize: 'none', data: [{ name: 't', values: [{ g: 1 }, { g: 2 }] }], marks }
  return { id: `${refName} level ${level} from ${shape}`, spec }
}

/** The `a` channel of every item of the marks named `m`, in order; or the error. */
function values(root: unknown): unknown[] {
  const out: unknown[] = []
  const visit = (n: unknown): void => {
    const g = n as { name?: string; marktype?: string; items?: unknown[] }
    if (g.name === 'm' && g.marktype === 'text') for (const it of g.items ?? []) out.push((it as { a?: unknown }).a ?? null)
    for (const c of g.items ?? []) if (c && typeof c === 'object') visit(c)
  }
  visit(root)
  return out
}

async function vegaValues(spec: Spec): Promise<unknown> {
  const errors: string[] = []
  const logger = { level() { return logger }, error(e: unknown) { errors.push(String((e as Error).message ?? e)); return logger }, warn() { return logger }, info() { return logger }, debug() { return logger } }
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none', logger: logger as never })
  try {
    await view.runAsync()
    return errors.length ? { error: errors[0] } : values((view.scenegraph() as unknown as { root: unknown }).root)
  } finally {
    view.finalize()
  }
}

function asterValues(spec: Spec): unknown {
  const errors: string[] = []
  const scene = evaluateChart(compileChart(spec as never), { logger: { error: (e: unknown) => { errors.push(String((e as Error).message ?? e)) }, warn() {}, info() {}, debug() {} } as never })
  return errors.length ? { error: errors[0] } : values(scene)
}

describe('{field: {group | parent, level}} (C119)', () => {
  it('every kind of field, levels 1 to 3, from every depth: the values vega gives, or its error', async () => {
    const N = REFS.length * 3 * SHAPES.length
    const bad: string[] = []
    for (let i = 0; i < N; i++) {
      const c = caseOf(i)
      const [want, got] = await forEngines(c.spec, (o, a) => Promise.all([vegaValues(o), Promise.resolve(asterValues(a))]))
      if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(`${c.id}: vega ${JSON.stringify(want)} aster ${JSON.stringify(got)}`)
    }
    expect(bad).toEqual([])
  }, 60_000)
})
