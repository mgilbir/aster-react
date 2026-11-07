// @vitest-environment node
/**
 * Every mark that draws longitude / latitude positions x each geographic channel x every property a channel definition takes, every
 * data type, and a datum and a value of each type (vl-geo-channels-space.ts), compiled by vega-lite 6.4.3 and by @aster-charts/vl.
 * vega-lite projects the raw field whatever the definition says, and reads the rest of it as it reads it on any other channel: an
 * aggregate aggregates (grouped by the projected positions of the other channels), a bin and a time unit add their fields and a
 * temporal type parses the field before it is projected, a sort array adds its index, the type says how the description formats
 * the field; a scale, an axis, a legend, a stack, an impute, a band or a pre-binned `bin` changes nothing. The end of a pair is
 * drawn by a rule (and a line that spans it, which is drawn as a rule), and by a point, a circle, a square or a trail only beside a
 * pre-binned `y`.
 * Where vega runs vega-lite's output, the compiled scales, axes and legends, the scales as they run, the rows and the SVG must be the
 * same (vl-ranged-compare.ts).
 *
 * The cases @aster-charts/vl refuses stay in the space, and each must be refused with its own error (all under "Throws" in
 * packages/vl/README.md, which readme-refusals.test.ts checks):
 *   - a condition that gives a field on a position the mark draws (vl-mark-channels.test.ts gives the reason);
 *   - what vega cannot run of vega-lite's output, each checked here to be so: a pair of coordinates of which one is a value, a
 *     condition alone or a count of records (vega-lite emits a geopoint transform with no field for it, and vega fails the
 *     dataflow), and a datum that is not a number (vega-lite writes it into the geopoint transform as an expression vega cannot
 *     parse).
 * A case vega cannot run that @aster-charts/vl has no refusal for fails here, so the space cannot silently stop comparing anything.
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { silent } from './vl-time-helpers.js'
import { differences } from './vl-ranged-compare.js'
import { GEO_MARKS, geoChannelCases } from './vl-geo-channels-space.js'

type Obj = Record<string, unknown>

const POSITION_CONDITION = /a condition that gives a field or a datum on a position channel/
const HALF_PAIR = /needs its pair: give both/
const COUNT = /a count of records reads no field: it has no position to project/
const NOT_A_NUMBER = /a geographic position constant must be a finite number/

const isObj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x)
/** vega-lite's field definition: a `field`, or a count of records. */
const isFieldDef = (d: unknown): boolean => isObj(d) && ('field' in d || d.aggregate === 'count')
const isBinned = (b: unknown): boolean => b === 'binned' || (isObj(b) && b.binned === true)

/** Does `mark` draw the geographic channel `ch` (vega-lite: the end of a pair on a point or a line only beside a pre-binned `y`)? */
function draws(enc: Obj, ch: string, mark: string): boolean {
  if (!ch.endsWith('2') || mark === 'rule') return true
  if (mark === 'text') return false
  return isFieldDef(enc.y) && isBinned((enc.y as Obj).bin) && isFieldDef(enc[ch])
}

/** vega-lite's ruleforrangedline.ts: a line that spans a field (not pre-binned) or a datum is drawn as a rule. */
function drawnAs(mark: string, enc: Obj): string {
  const spans = ['x', 'y', 'longitude', 'latitude', 'theta', 'radius'].some((main) => {
    const def = enc[main]
    return enc[`${main}2`] !== undefined && isObj(def) && ((isFieldDef(def) && !isBinned(def.bin)) || 'datum' in def)
  })
  return mark === 'line' && spans ? 'rule' : mark
}

/** The error @aster-charts/vl must refuse `spec` with, if any. */
function refusalOf(spec: Obj): RegExp | undefined {
  const enc = spec.encoding as Obj
  const mark = drawnAs(spec.mark as string, enc)
  const drawn = Object.keys(enc).filter((ch) => /^(longitude|latitude)2?$/.test(ch) && draws(enc, ch, mark))
  const defs = drawn.map((ch) => enc[ch] as Obj)
  if (defs.some((d) => ([] as unknown[]).concat(d.condition ?? []).some((c) => isObj(c) && (c.field !== undefined || c.datum !== undefined)))) return POSITION_CONDITION
  if (defs.some((d) => d.field === undefined && d.aggregate === 'count')) return COUNT
  if (defs.some((d) => d.datum !== undefined && typeof d.datum !== 'number')) return NOT_A_NUMBER
  const placed = (ch: string): boolean => drawn.includes(ch) && (isObj(enc[ch]) && ((enc[ch] as Obj).field !== undefined || (enc[ch] as Obj).datum !== undefined))
  for (const [lon, lat] of [['longitude', 'latitude'], ['longitude2', 'latitude2']]) if (placed(lon!) !== placed(lat!)) return HALF_PAIR
  return undefined
}

/** Does vega run vega-lite's output of `spec` without an error, thrown or logged? */
async function vegaRuns(spec: Obj): Promise<boolean> {
  let vg: Obj
  try { vg = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec } catch { return false }
  let failed = false
  const logger = { ...silent, level: () => logger, error: () => { failed = true; return logger } }
  try {
    const view = new vega.View(vega.parse(vg), { renderer: 'none', logger: logger as never })
    await view.runAsync()
    await view.toSVG()
  } catch { return false }
  return !failed
}

/** What @aster-charts/vl throws compiling `spec`, if anything. */
function refusalFrom(spec: Obj): unknown {
  try { compile(JSON.parse(JSON.stringify(spec)) as never) } catch (e) { return e }
  return undefined
}

describe('a geographic channel reads every definition as vega-lite reads it', () => {
  for (const mark of GEO_MARKS) {
    it(`${mark}: longitude / latitude and their ends, every property, type, datum and value`, async () => {
      const all = [...geoChannelCases(mark)]
      const bad: string[] = []
      const refused = new Map<RegExp, number>()
      let compared = 0
      for (const [name, spec] of all) {
        const refusal = refusalOf(spec)
        if (refusal) {
          refused.set(refusal, (refused.get(refusal) ?? 0) + 1)
          const got = refusalFrom(spec)
          if (!(got instanceof VLCompileError) || !refusal.test(got.message)) bad.push(`${name}: expected the refusal ${refusal} but ${got === undefined ? 'it compiled' : `got ${String(got).slice(0, 160)}`}`)
          // (every refusal but the position condition's refuses what vega itself cannot run)
          else if (refusal !== POSITION_CONDITION && (await vegaRuns(spec))) bad.push(`${name}: vega runs vega-lite's output, so it is not to be refused`)
          continue
        }
        const out = await differences(spec)
        if (out.why) bad.push(`${name}: ${out.why}`)
        else if (!out.compared || !(await vegaRuns(spec))) bad.push(`${name}: vega cannot run vega-lite's output, and @aster-charts/vl does not refuse it`)
        else compared++
      }
      expect(bad.slice(0, 8), `${bad.length} of ${all.length} differ`).toEqual([])
      // (the space compares most of what it holds, and holds each kind of refusal the mark meets)
      expect(compared).toBeGreaterThan(all.length * 0.8)
      expect([...refused.keys()].sort((a, b) => a.source.localeCompare(b.source))).toEqual([COUNT, HALF_PAIR, NOT_A_NUMBER, POSITION_CONDITION].sort((a, b) => a.source.localeCompare(b.source)))
    }, 240_000)
  }
})
