// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { flatField, datumRef, genName, genSignal, safeKey, signalSafe, splitAccessPath } from '../src/names.js'
import { DATA, xq, yq, cn, compileFrozen, strings, objects } from './helpers.js'

/** Hostile / awkward column names. `raw` is how the user writes the field; `key` the actual data key. */
const NAMES: Array<{ label: string; raw: string; key: string; row: Record<string, unknown> }> = [
  { label: 'plain', raw: 'v', key: 'v', row: { v: 1 } },
  { label: 'space', raw: 'IMDB Rating', key: 'IMDB Rating', row: { 'IMDB Rating': 6.1 } },
  { label: 'dotted key (escaped)', raw: 'a\\.b', key: 'a.b', row: { 'a.b': 2 } },
  { label: 'bracket key (escaped)', raw: 'a\\[0\\]', key: 'a[0]', row: { 'a[0]': 3 } },
  { label: 'quote key (escaped)', raw: "it\\'s", key: "it's", row: { "it's": 4 } },
  { label: 'injection attempt (escaped)', raw: "v\\'\\] + 1 + datum\\['v", key: "v'] + 1 + datum['v", row: { "v'] + 1 + datum['v": 5 } },
  { label: 'double quote + backslash (escaped)', raw: 'say \\"hi\\"\\\\', key: 'say "hi"\\', row: { 'say "hi"\\': 6 } },
  { label: 'unicode', raw: 'größe €', key: 'größe €', row: { 'größe €': 7 } },
]

function reads(expr: string): string[] {
  // every `datum["..."]` reference in an expression, JSON-decoded
  const out: string[] = []
  const re = /datum\[("(?:[^"\\]|\\.)*")\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr))) out.push(JSON.parse(m[1]!))
  return out
}

describe('field names reach expressions only through JSON-escaped datum[...] reads (C37)', () => {
  for (const n of NAMES) {
    it(`${n.label}: raw ${JSON.stringify(n.raw)} compiles with the key ${JSON.stringify(n.key)} read as ONE literal`, () => {
      const out = compileFrozen({
        data: { name: 't', values: [n.row] },
        mark: 'bar',
        encoding: { x: { field: n.raw, type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' }, color: { field: n.raw, type: 'ordinal' } },
      })
      const exprs: string[] = []
      for (const o of objects(out)) {
        for (const k of ['expr', 'signal'] as const) if (typeof o[k] === 'string') exprs.push(o[k] as string)
      }
      expect(exprs.length).toBeGreaterThan(0)
      // (the flat column the compiler materializes for a key that is not a plain identifier is its own too)
      const known = new Set<string>([n.key, flatField(n.raw).key])
      for (const e of exprs) {
        for (const read of reads(e)) {
          // a datum read is either the user's key or a field this compiler generated
          const generated = /^(bin_|__count|count|sum_|_)/.test(read) || read === n.key || known.has(read)
          expect(generated, `unexpected datum read ${JSON.stringify(read)} in ${e}`).toBe(true)
        }
        // the hostile text never appears outside a JSON string literal: strip all string literals, nothing of it may remain
        const stripped = e.replace(/"(?:[^"\\]|\\.)*"/g, '""')
        expect(stripped).not.toContain("datum['v")
        expect(stripped).not.toContain('+ 1 +')
      }
    })

    it(`${n.label}: generated field/signal names are valid`, () => {
      const out = compileFrozen({
        data: { name: 't', values: [n.row] },
        mark: 'bar',
        encoding: { x: { field: n.raw, type: 'quantitative', bin: { maxbins: 5 } }, y: { aggregate: 'sum', field: n.raw, type: 'quantitative' } },
      })
      // Vega signal names must be identifiers
      for (const o of objects(out)) {
        if (typeof o.signal === 'string' && o.type === 'bin') expect(o.signal).toMatch(/^[A-Za-z_][\w]*$/)
        if (o.type === 'extent' && typeof o.signal === 'string') expect(o.signal).toMatch(/^[A-Za-z_][\w]*$/)
      }
      // every generated `as` name round-trips through Vega's access-path parser as ONE key
      for (const o of objects(out)) {
        for (const as of Array.isArray(o.as) ? o.as : typeof o.as === 'string' ? [o.as] : []) {
          if (typeof as === 'string') expect(splitAccessPath(as)).toEqual([as])
        }
      }
    })
  }

  it('a malformed access path is rejected, never spliced into an expression', () => {
    for (const bad of ["v'] + 1 + datum['v", 'a[', 'a]', "'unterminated", 'x"y"z[']) {
      expect(() => compile({ data: DATA, mark: 'point', encoding: { x: { field: bad, type: 'quantitative' }, y: yq } } as never), bad).toThrowError(VLCompileError)
    }
  })

  it('dotted paths address nested data: o.v is read as datum["o"]["v"] ONCE and every later reference is a flat key', () => {
    const out = compileFrozen({
      data: DATA, mark: 'bar',
      encoding: { x: cn, y: { aggregate: 'sum', field: 'o.v', type: 'quantitative' } },
    })
    const flat = (out.data as Array<{ transform?: Array<Record<string, any>> }>).flatMap((d) => d.transform ?? [])
    const copy = flat.find((t) => t.type === 'formula' && t.expr === 'datum["o"]["v"]')
    expect(copy).toBeDefined()
    expect(splitAccessPath(copy!.as)).toEqual([copy!.as])
    const agg = flat.find((t) => t.type === 'aggregate')!
    expect(agg.fields).toEqual([copy!.as])
    // the bars read the aggregated field, a flat name (the audit repro gave no bars)
    const mark = out.marks[0]
    expect(mark.encode.update.y.field).toBe(agg.as[0])
    expect(splitAccessPath(agg.as[0])).toEqual([agg.as[0]])
  })

  it('timeUnit / bin names of an awkward field are flat and consistent between pipeline and marks', () => {
    for (const n of NAMES) {
      const out = compileFrozen({
        data: { name: 't', values: [n.row] },
        mark: 'bar',
        encoding: { x: { field: n.raw, type: 'ordinal', timeUnit: 'month' }, y: { aggregate: 'count', type: 'quantitative' } },
      })
      const tu = (out.data as Array<{ transform?: Array<Record<string, any>> }>).flatMap((d) => d.transform ?? []).find((t) => t.type === 'timeunit')!
      const [startName] = tu.as as string[]
      expect(splitAccessPath(startName)).toEqual([startName])
      expect(JSON.stringify(out.scales)).toContain(JSON.stringify(startName).slice(1, -1))
    }
  })
})

describe('names.ts helpers', () => {
  it('flatField keeps ordinary names and flattens nested/escaped paths', () => {
    expect(flatField('IMDB Rating')).toEqual({ key: 'IMDB Rating' })
    // vega's own access-path grammar reads an unescaped quote as the start of a quoted segment
    expect(() => flatField("it's")).toThrowError(VLCompileError)
    expect(flatField("it\\'s").expr).toBe('datum["it\'s"]')
    const nested = flatField('o.v')
    expect(nested.expr).toBe('datum["o"]["v"]')
    expect(nested.key).not.toMatch(/[.[\]]/)
    expect(flatField('a\\.b').expr).toBe('datum["a.b"]')
    expect(flatField('a\\.b').key).not.toContain('.')
  })

  it('different hostile names never collapse to the same generated key', () => {
    const keys = new Set(['a.b', 'a_b', 'a b', 'a[b]', 'a\\.b'].map((n) => safeKey(n)))
    expect(keys.size).toBe(5)
    const sigs = new Set(['a.b', 'a_b', 'a b'].map((n) => signalSafe(n)))
    expect(sigs.size).toBe(3)
  })

  it('datumRef and genName produce literals / valid names', () => {
    expect(datumRef('x"y')).toBe('datum["x\\"y"]')
    expect(genName('sum', 'o_v')).toBe('sum_o_v')
    expect(genSignal('bin_maxbins_10', 'IMDB Rating')).toMatch(/^[A-Za-z_]\w*$/)
  })
})

describe('generated dataset names never collide with the user\'s (C97)', () => {
  it('a user dataset called data_0 / source_0 / lookup_x keeps its name and the generated ones move', () => {
    const out = compileFrozen({
      data: { name: 'data_0', values: DATA.values },
      transform: [{ filter: 'datum.x > 0' }],
      layer: [
        { mark: 'point', encoding: { x: xq, y: yq } },
        { data: { name: 'source_0', values: [{ x: 1, y: 2 }] }, mark: 'line', encoding: { x: xq, y: yq } },
      ],
    })
    const names = (out.data as Array<{ name: string }>).map((d) => d.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('data_0')
    expect(names).toContain('source_0')
    // every dataset a mark reads exists
    for (const o of objects(out.marks)) {
      const d = o.from?.data
      if (typeof d === 'string') expect(names).toContain(d)
    }
    for (const sc of out.scales as Array<{ domain: any }>) {
      for (const [k, v] of strings(sc.domain)) if (k === 'data') expect(names).toContain(v)
    }
  })
})
