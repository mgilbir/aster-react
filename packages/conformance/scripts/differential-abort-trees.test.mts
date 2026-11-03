/**
 * A dataflow pass that fails, over random trees of nested scopes, against the pinned real Vega, in this process.
 *
 * Vega's dataflow stops at the first operator that throws: the error is logged ONCE, the operators ranked after it never run, and
 * the scenegraph is what the operators ranked before it made. The operators of a nested scope (a group's content) exist only once
 * the group item's own operators have run, so they rank after every operator of the enclosing scope, level by level. A failing
 * encode, signal, axis or legend part anywhere in a tree therefore decides which other marks, groups, axes and legends get built.
 *
 * Generated: specs of marks and groups nested up to three deep (own scales, faceted groups, axes, legends, titles) with one or
 * two failures put at random places (a mark's encode, a group's own encode, a guide part's encode, a signal), compared to vega
 * by the picture (strict canonicalizer) and by what was logged (how many errors and their class; the text when it names a
 * scale written out).
 *
 * `ASTER_DIFF_SCALE` multiplies the number of trees. To narrow a failure down: `ABORT_KINDS=axis,legend` draws only those failures, and
 * `ABORT_ONE=1` puts exactly one failure in every tree (differential-abort-gen.mts).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { makeRng, scaled } from './differential-gen.mts'
import { FAILS, treeSpec, type Fail } from './differential-abort-gen.mts'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { errors.push(String(a[0])); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}

function onAster(spec: Spec): { svg: string; errors: string[] } {
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {} }
  return { svg: renderSpec(structuredClone(spec) as never, { logger } as never), errors }
}

const SEEDS = [11, 23, 37]
const PER_SEED = scaled(200)

describe('a pass that fails builds what vega builds', () => {
  it.each(SEEDS)(`${PER_SEED} generated trees of nested scopes, seed %i`, { timeout: 600_000 }, async (seed) => {
    const r = makeRng(seed)
    const bad: string[] = []
    let failed = 0
    const kinds = new Map<Fail, number>()
    for (let c = 0; c < PER_SEED; c++) {
      const { spec, fails, label } = treeSpec(r)
      const want = await onVega(spec)
      let got: ReturnType<typeof onAster>
      const tag = `#${c} ${label}`
      try {
        got = onAster(spec)
      } catch (e) {
        bad.push(`${tag}: aster threw ${(e as Error).message}`)
        continue
      }
      if (want.errors.length) { failed++; for (const f of fails) kinds.set(f, (kinds.get(f) ?? 0) + 1) }
      // (one error, logged once: the first operator in vega's order that threw)
      if (JSON.stringify(want.errors) !== JSON.stringify(got.errors)) { bad.push(`${tag}: vega logged ${JSON.stringify(want.errors)}, aster ${got.errors.length}: ${JSON.stringify(got.errors.slice(0, 2))}`); continue }
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))
      if (d.length) bad.push(`${tag}: ${d.slice(0, 2).join(' | ')}`)
    }
    expect(bad.length, `${bad.length} of ${PER_SEED} trees differ:\n${bad.slice(0, 8).join('\n')}`).toBe(0)
    // not vacuous: most trees fail in vega, and every kind of failure was drawn and logged by it
    expect(failed).toBeGreaterThan(PER_SEED * 0.5)
    for (const kind of FAILS) expect(kinds.get(kind) ?? 0, `trees whose ${kind} failed in vega`).toBeGreaterThan(PER_SEED * 0.015)
  })
})
