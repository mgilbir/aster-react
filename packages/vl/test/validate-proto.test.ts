/**
 * A property named after a member of Object.prototype (`toString`, `constructor`, `__proto__`, `hasOwnProperty`, ...) is an unknown
 * property like any other (C756, the CHANGELOG's "scale key named after an Object.prototype member" fix, which only `zeroish` pinned):
 * at every place the validator refuses unknown keys, each member of Object.prototype is refused with the message an ordinary unknown
 * name gets, and never read as a supported key through the prototype chain.
 */
import { describe, expect, it } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { DATA, xq, yq } from './helpers.js'

const unit = (extra: Record<string, unknown> = {}) => ({ data: DATA, mark: 'point', encoding: { x: xq, y: yq }, ...extra })
const SITES: Record<string, (k: string) => Record<string, unknown>> = {
  'top level': (k) => unit({ [k]: 1 }),
  'a scale': (k) => unit({ encoding: { x: { ...xq, scale: { [k]: 1 } }, y: yq } }),
  'an encoding channel': (k) => unit({ encoding: { x: xq, [k]: yq } }),
  'a field definition': (k) => unit({ encoding: { x: { ...xq, [k]: 1 }, y: yq } }),
  'a mark definition': (k) => unit({ mark: { type: 'point', [k]: 1 } }),
  'the config': (k) => unit({ config: { [k]: 1 } }),
  'the scale config': (k) => unit({ config: { scale: { [k]: 1 } } }),
  'a transform': (k) => unit({ transform: [{ [k]: 1 }] }),
  'a selection parameter': (k) => unit({ params: [{ name: 'p', select: { type: 'point', [k]: 1 } }] }),
  'an aggregate field': (k) => unit({ transform: [{ aggregate: [{ op: 'sum', field: 'x', as: 's', [k]: 1 }], groupby: ['c'] }] }),
}
const MEMBERS = Object.getOwnPropertyNames(Object.prototype)
const CONTROL = 'banana'

const refusal = (make: () => Record<string, unknown>): string | null => {
  try { compile(make() as never); return null } catch (e) { return e instanceof VLCompileError ? e.message : `${(e as Error).name}: ${(e as Error).message}` }
}

describe('Object.prototype members are unknown properties wherever the validator refuses unknown ones', () => {
  it('the members the test covers include the ones the CHANGELOG names', () => {
    for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) expect(MEMBERS).toContain(k)
  })

  it.each(Object.keys(SITES))('%s', (site) => {
    const make = SITES[site]!
    const control = refusal(() => make(CONTROL))
    expect(control, `an ordinary unknown name is refused at ${site}`).not.toBeNull()
    expect(control).toMatch(/^\[aster\/vl\]/)
    const bad: string[] = []
    for (const k of MEMBERS) {
      const got = refusal(() => make(k))
      // the same refusal as the control's, with the name it was given (a name close to a real one, `valueOf` to `value`, also says which: that is a suggestion, not another refusal)
      const bare = got === null ? null : got.replace(/ \(did you mean "[^"]*"\?\)$/, '')
      if (bare === null || bare.split(k).join('<k>') !== control!.split(CONTROL).join('<k>')) bad.push(`${k}: ${got === null ? 'compiled' : got.slice(0, 90)}`)
    }
    expect(bad).toEqual([])
  })
})
