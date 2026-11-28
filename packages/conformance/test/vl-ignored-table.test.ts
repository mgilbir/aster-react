// @vitest-environment node
/**
 * The mark-definition properties @aster-charts/vl consumes without a use of its own come from vega-lite, not from a list kept by hand
 * (T3; packages/vl/scripts/ignored-table.mjs writes packages/vl/src/ignored-table.ts from what real vega-lite does with each property
 * of the pinned schema's MarkDef, on every mark type, over the chart shapes of scripts/ignored-probe.mjs):
 *  - the committed table is what the generator makes of the pinned vega-lite (a table edited by hand, or left behind by an upgrade,
 *    fails here);
 *  - over the whole matrix (mark type x chart shape x property x every value the schema gives it, an `{expr}` where the schema takes
 *    one), @aster-charts/vl does with the property what vega-lite does: a property the table says vega-lite ignores or forwards is
 *    never refused; and every case either changes Aster's Vega as it changes vega-lite's (nothing, or the property forwarded as it
 *    is), or draws vega-lite's SVG through real Vega, or - for a property vega-lite uses there, and the table does not list - is
 *    refused with a VLCompileError. A property vega-lite uses that Aster reads wrongly, or drops, fails here.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { MARKS, effectOf, probe, vlCompile } from '../../vl/scripts/ignored-probe.mjs'
import { turn } from '../../../scripts/lib/turn.mjs'
import { spawnAsync } from '../../../scripts/lib/spawn-async.mjs'
import { MARKS as TABLE_MARKS, IGNORED, FORWARDED } from '../../vl/src/ignored-table.js'

/** (mark, prop) pairs the committed table lists, ignored or forwarded. */
const listed = new Set<string>()
{
  const marks = TABLE_MARKS.split(' ')
  for (const w of `${IGNORED} ${FORWARDED}`.split(' ')) {
    const [p, m] = w.split(':') as [string, string]
    const mask = parseInt(m, 36)
    marks.forEach((mark, i) => { if (Math.floor(mask / 2 ** i) % 2 === 1) listed.add(`${mark} ${p}`) })
  }
}

/** Properties vega-lite reads of a rect-like mark only in some chart shapes (a binned position, a sized band): ignored in the others, and then never refused. */
const CONTEXTUAL = new Set(['binSpacing', 'align', 'baseline'])

type Out = { json: string } | { refused: unknown }
function aster(spec: unknown): Out {
  try {
    return { json: JSON.stringify(compile(JSON.parse(JSON.stringify(spec)))) }
  } catch (e) {
    return { refused: e }
  }
}

/** What real Vega draws of a Vega spec, or the errors it raises instead. */
async function draws(json: string): Promise<ReturnType<typeof canonicalizeSvg> | string> {
  const r = await renderWithVegaChecked(JSON.parse(json))
  return r.errors.length ? `vega fails: ${r.errors.join('; ')}` : canonicalizeSvg(r.svg)
}
function drawDiff(a: ReturnType<typeof canonicalizeSvg> | string, b: ReturnType<typeof canonicalizeSvg> | string): string[] {
  if (typeof a === 'string' || typeof b === 'string') return a === b ? [] : [`vega-lite's: ${typeof a === 'string' ? a : 'draws'}; Aster's: ${typeof b === 'string' ? b : 'draws'}`]
  return diffCanonical(a, b)
}

describe('the mark-definition table is generated from vega-lite', () => {
  // (the generator's own `--check`, in a child: the table takes half a minute to make, and a worker that long in one synchronous call
  // cannot read the host's replies)
  it('the committed ignored-table.ts is what the generator makes of the pinned vega-lite', async () => {
    const run = await spawnAsync(process.execPath, [fileURLToPath(new URL('../../vl/scripts/ignored-table.mjs', import.meta.url)), '--check'], { timeout: 540_000 })
    expect(run.error, String(run.error)).toBeUndefined()
    expect(run.status, run.stderr.slice(-2000)).toBe(0)
  }, 600_000)
})

describe('@aster-charts/vl does with each mark-definition property what vega-lite does (every mark type, chart shape and value)', () => {
  for (const mark of MARKS as string[]) {
    it(mark, async () => {
      const failures: string[] = []
      const bases = new Map<string, Out>()
      let cases = 0
      for (const c of probe({ marks: [mark] }) as Iterable<{ mark: string; context: string; prop: string; value: unknown; spec: Record<string, unknown>; effect: string }>) {
        await turn()
        if (c.effect === 'refused') continue
        cases++
        const where = `${c.mark} / ${c.context} / ${c.prop}: ${JSON.stringify(c.value)} (vega-lite: ${c.effect})`
        let base = bases.get(c.context)
        if (base === undefined) {
          const without = JSON.parse(JSON.stringify(c.spec))
          delete without.mark[c.prop]
          base = aster(without)
          bases.set(c.context, base)
        }
        const ours = aster(c.spec)
        if ('refused' in ours) {
          if (!(ours.refused instanceof VLCompileError)) failures.push(`${where}: threw ${String(ours.refused)}`)
          // (the probe draws values the schema takes, from the schema: one it forbids is a defect of the probe, never a case)
          else if (/\(Vega-Lite [\d.]+ schema\)$/.test((ours.refused as Error).message)) failures.push(`${where}: the probe drew a value the schema forbids: ${(ours.refused as Error).message}`)
          else if (CONTEXTUAL.has(c.prop) && c.mark in { bar: 1, rect: 1, tick: 1 } && c.effect === 'ignored' && !/places no (horizontal|vertical) position/.test((ours.refused as Error).message)) failures.push(`${where}: refused, but vega-lite reads it only where the chart bins or sizes a band, and ignores it here: ${(ours.refused as Error).message}`)
          else if (listed.has(`${c.mark} ${c.prop}`)) failures.push(`${where}: refused, but vega-lite ${c.effect === 'used' ? 'uses' : 'ignores or forwards'} it here and the table lists it: ${(ours.refused as Error).message}`)
          continue
        }
        if ('json' in base && effectOf(ours.json, base.json, c.prop, c.value) === c.effect) continue
        const theirs = vlCompile(c.spec) as string
        const diff = drawDiff(await draws(theirs), await draws(ours.json))
        if (diff.length) failures.push(`${where}: draws differently: ${diff.slice(0, 2).join(' | ')}`)
      }
      expect(cases).toBeGreaterThan(0)
      expect(failures).toEqual([])
    }, 600_000)
  }
})
