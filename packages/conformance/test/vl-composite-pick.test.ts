// @vitest-environment node
/** pickSpec makes the compilers' own names equal and nothing more: two different compiled specs are not made equal by it (C213). */
import { describe, it, expect } from 'vitest'
import { flatKeys, pickSpec } from './vl-composite-pick.js'

const copy = (as: string, expr: string) => ({ type: 'formula', expr, as })
const aster = (field: string, flat?: ReturnType<typeof copy>) => ({ data: flat ? [{ name: 'd', transform: [flat] }] : [], marks: [{ type: 'rect', encode: { update: { y: { field } } } }] })
const oracle = (field: string) => ({ marks: [{ type: 'rect', encode: { update: { y: { field } } } }] })
const nested = copy('o_v_ab12cd', 'datum["o"] && datum["o"]["v"]')

describe('pickSpec names', () => {
  it('reads a nested key back as its path', () => {
    expect([...flatKeys(aster('o_v_ab12cd', nested))]).toEqual([['o_v_ab12cd', 'o.v']])
    expect(pickSpec(aster('o_v_ab12cd', nested), 'aster')).toEqual(pickSpec(oracle('o.v'), 'oracle'))
  })
  it('reads an escaped key back as its escaped name', () => {
    const a = copy('a_b_ff00aa', 'datum["a.b"]')
    expect(pickSpec(aster('a_b_ff00aa', a), 'aster')).toEqual(pickSpec(oracle('a\\.b'), 'oracle'))
  })
  it('does not make another path, or an underscore for a dot, equal', () => {
    expect(pickSpec(aster('o_v_ab12cd', nested), 'aster')).not.toEqual(pickSpec(oracle('o.w'), 'oracle'))
    expect(pickSpec(aster('o_v_ab12cd', nested), 'aster')).not.toEqual(pickSpec(oracle('o_v'), 'oracle'))
    expect(pickSpec(aster('o_v', undefined), 'aster')).not.toEqual(pickSpec(oracle('o.v'), 'oracle'))
  })
  it('leaves a user name that looks like a hash alone', () => {
    expect(pickSpec(aster('v_abcdef'), 'aster')).toEqual(pickSpec(oracle('v_abcdef'), 'oracle'))
    expect(pickSpec(aster('v_abcdef'), 'aster')).not.toEqual(pickSpec(oracle('v'), 'oracle'))
  })
})
