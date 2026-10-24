import { describe, expect, it } from 'vitest'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

/**
 * C90: a sort that throws in a facet header builder used to be swallowed by `catch {}`. vega logs
 * it and leaves the rows in data order; the engine now reports it through RuntimeInput.logger.
 * (The encode / filter / mark-sort sites are compared with real vega in
 * packages/conformance/src/error-semantics.test.ts.)
 */
describe('header sort errors are reported, not swallowed (C90)', () => {
  const spec = (role: string, name: string): VgSpec => ({
    width: 100, height: 60, padding: 5, autosize: 'none',
    data: [{ name: 'cols', values: [{ k: 'a', o: { x: 2 } }, { k: 'b' }, { k: 'c', o: { x: 1 } }] }],
    marks: [{ type: 'group', name, role, from: { data: 'cols' }, sort: { field: 'datum.o.x' }, title: { text: { signal: 'parent.k' } }, encode: { update: { width: { value: 30 }, height: { value: 30 } } } }],
  } as unknown as VgSpec)

  it.each([['row-header', 'row_header'], ['column-header', 'column_header']])('%s', (role, name) => {
    const errors: unknown[] = []
    expect(() => renderSpec(spec(role, name), { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } })).not.toThrow()
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toBeInstanceOf(TypeError)
  })

  it('a sort that works reports nothing', () => {
    const ok = spec('column-header', 'column_header') as unknown as { marks: Array<{ sort: { field: string } }> }
    ok.marks[0]!.sort.field = 'datum.k'
    const errors: unknown[] = []
    renderSpec(ok as unknown as VgSpec, { logger: { error: (...a) => errors.push(a[0]), warn: () => {} } })
    expect(errors).toEqual([])
  })
})
