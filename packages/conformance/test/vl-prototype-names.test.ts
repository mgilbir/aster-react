// @vitest-environment node
/**
 * A field, a dataset, an output (`as`) or a parameter named as a member of Object.prototype (`constructor`, `toString`, `valueOf`,
 * `__proto__` ...), in every place a spec names one (C442). Vega keeps names in plain objects, so its handling of these is irregular:
 * vega-lite 6.4.3's output fails in Vega, or draws a chart that is not the chart of an ordinary name, in most places, and is right in a
 * few. Each place x each member is classified against vega-lite through real Vega, with a control - the same spec with an ordinary name
 * of the same length (so text is laid out alike), its SVG and its datasets compared with the name put back:
 *  - vega-lite fails, or draws other than the control: @aster-charts/vl refuses with a VLCompileError naming it (DECISIONS Q9);
 *  - vega-lite draws the control's chart: @aster-charts/vl draws the same SVG.
 * Either way nothing is written to Object.prototype.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { NAME_PLACES } from './vl-name-places.js'

type Spec = Record<string, unknown>
const NAMES = Object.getOwnPropertyNames(Object.prototype)
const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }

/** The spec with the name `from` (a whole string, or a parameter in an expression) replaced by `to`. */
const sub = (spec: Spec, from: string, to: string): Spec => JSON.parse(JSON.stringify(spec).replaceAll(`"${from}"`, `"${to}"`).replaceAll(`${from} *`, `${to} *`))

/**
 * Run `f` (vega-lite, or real Vega) and put the built-in prototypes back as they were: real Vega, given these names, can write to
 * Object.prototype itself, and a later case would run in a broken process. (@aster-charts/vl's own compile is checked not to write.)
 */
async function restoringPrototypes<T>(f: () => Promise<T>): Promise<T> {
  const saved = [Object.prototype, Array.prototype, Function.prototype].map((p) => [p, Object.getOwnPropertyDescriptors(p)] as const)
  try {
    return await f()
  } finally {
    for (const [p, descriptors] of saved) {
      for (const key of Reflect.ownKeys(p)) if (!Object.hasOwn(descriptors, key)) delete (p as Record<PropertyKey, unknown>)[key]
      for (const key of Reflect.ownKeys(descriptors)) Object.defineProperty(p, key, (descriptors as Record<PropertyKey, PropertyDescriptor>)[key]!)
    }
  }
}

/** vega-lite's chart of `spec`, or why there is none. */
const vegaLite = (spec: Spec): Promise<{ svg: string; data: string } | { failed: string }> => restoringPrototypes(() => vegaLite0(spec))
async function vegaLite0(spec: Spec): Promise<{ svg: string; data: string } | { failed: string }> {
  let out: Spec
  try {
    out = (vl as any).compile(plain(spec), { logger: quiet }).spec
  } catch (e) {
    return { failed: `vega-lite: ${(e as Error).message}` }
  }
  const r = await renderWithVegaChecked(out)
  if (r.errors.length) return { failed: `vega: ${r.errors.join('; ')}` }
  return { svg: r.svg, data: JSON.stringify(Object.values(r.datasets)) }
}

const prototypeKeys = (): string => Reflect.ownKeys(Object.prototype).map(String).sort().join(',')

describe('a name that is a member of Object.prototype is refused where vega-lite\'s chart is wrong, and drawn as vega-lite draws it elsewhere', () => {
  for (const [place, make] of Object.entries(NAME_PLACES)) {
    it(place, async () => {
      const problems: string[] = []
      for (const N of NAMES) {
        const spec = make(N)
        const ref = await vegaLite(spec)
        const ctrlName = 'q'.repeat(N.length)
        const ctrl = await vegaLite(sub(spec, N, ctrlName))
        if ('failed' in ctrl) throw new Error(`${place}: the control with an ordinary name does not draw (${ctrl.failed})`)
        const right = !('failed' in ref) && ctrl.svg.replaceAll(ctrlName, N) === ref.svg && ctrl.data.replaceAll(ctrlName, N) === ref.data
        const before = prototypeKeys()
        let ours: Spec | undefined
        let error: unknown
        try {
          ours = compile(plain(spec)) as Spec
        } catch (e) {
          error = e
        }
        if (prototypeKeys() !== before) problems.push(`${N}: Object.prototype changed`)
        if (!right) {
          const why = 'failed' in ref ? ref.failed : 'vega-lite draws other than with an ordinary name'
          if (!(error instanceof VLCompileError) || !error.message.includes(JSON.stringify(N))) problems.push(`${N}: ${why}, so it must be refused by name; got ${error ? String(error) : 'a chart'}`)
          continue
        }
        if (error !== undefined) { problems.push(`${N}: vega-lite draws it right, but @aster-charts/vl throws ${String(error)}`); continue }
        const mine = await restoringPrototypes(() => renderWithVegaChecked(plain(ours)))
        if (mine.errors.length || mine.svg !== (ref as { svg: string }).svg) problems.push(`${N}: vega-lite draws it right, and @aster-charts/vl draws ${mine.errors.length ? `errors ${mine.errors.join('; ')}` : 'another SVG'}`)
      }
      expect(problems).toEqual([])
    }, 120_000)
  }
})
