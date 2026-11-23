/**
 * A scale `type` vega does not register is refused when the spec is compiled, with vega-parser's message (C539: the compiled type
 * is one of `ScaleType`, which is what runs). Every registered type compiles; typos, retired names and other values do not.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '@aster-charts/core'

const NAMES: unknown[] = [
  'identity', 'linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'sequential-linear', 'sequential-log',
  'sequential-pow', 'sequential-sqrt', 'sequential-symlog', 'diverging', 'diverging-linear', 'diverging-log', 'diverging-pow',
  'diverging-sqrt', 'diverging-symlog', 'quantile', 'quantize', 'threshold', 'ordinal', 'band', 'point', 'bin-ordinal', 'bin-linear',
  'nonsense', 'Linear', 'linear ', '', 'toString', '__proto__', 'constructor', 0, null, true, ['linear'], undefined,
]

async function vegaOutcome(type: unknown): Promise<string> {
  try {
    const view = new vega.View(vega.parse({ scales: [{ name: 'x', type, domain: [0, 1] }] } as never), { renderer: 'none' })
    await view.runAsync()
    view.finalize()
    return 'ok'
  } catch (e) { return `threw ${(e as Error).message}` }
}
function asterOutcome(type: unknown): string {
  try { compileChart({ scales: [{ name: 'x', type, domain: [0, 1] }] } as never); return 'ok' } catch (e) { return `threw ${(e as Error).message}` }
}

describe('scale types (vs real vega)', () => {
  it('registered types compile; any other is refused with vega\'s message', async () => {
    const diffs: string[] = []
    for (const t of NAMES) {
      const want = await vegaOutcome(t)
      const got = asterOutcome(t)
      // (vega's other refusals of a type it registers -- a missing range, a scheme -- are not this check's: only "refused or not")
      const same = want.startsWith('threw Unrecognized scale type') ? got === want : !got.startsWith('threw Unrecognized scale type')
      if (!same) diffs.push(`${JSON.stringify(t)}: vega ${want} | aster ${got}`)
    }
    expect(diffs).toEqual([])
  })
})
