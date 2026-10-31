/**
 * The dataflow optimizations vega-lite runs over the datasets of the whole spec (compile/data/optimizers.ts), on the assembled Vega:
 *
 *  - MergeBins: the bins of one field and parameters over the same rows are computed once (one extent, one bins signal, named after the
 *    LAST of them: `MergeBins` pops the last promotable bin and merges the others into it, `renameSignal(other, this)`);
 *  - MergeIdenticalNodes: datasets that derive the same way from the same source are one dataset, and so is the part of their
 *    pipelines they share: vega-lite's dataflow is a TREE, a prefix of transforms common to several datasets is one node whose output
 *    they all read (so a `ci0` / `ci1` aggregate, or a `sample`, that two marks draw from is computed once, and the marks agree on it).
 *
 * Views are compiled one by one here, so each one declares its own copy of what its siblings declare; this pass is what makes the
 * copies one. It only merges what is the same by construction (equal pipelines over equal sources), never what merely looks alike.
 */
import { renameDataRefs, renameExpr, renameFragment } from './embed.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** A filter that only keeps the rows whose fields are valid numbers / dates: `isValid(f) && isFinite(+f) && ...` in any order. */
const INVALID_TERM = /isValid\((datum\["(?:[^"\\]|\\.)*"\])\) && isFinite\(\+\1\)|\(isDate\((datum\["(?:[^"\\]|\\.)*"\])\) \|\| \(isValid\(\2\) && isFinite\(\+\2\)\)\)/g

/** Vega-lite hashes a FilterInvalid node by its (sorted-key) field dictionary, so the order of the fields does not matter. */
function filterKey(expr: string): string {
  const terms = expr.match(INVALID_TERM)
  if (terms && terms.join(' && ').length === expr.length) return `invalid:${[...terms].sort().join('|')}`
  return `expr:${expr}`
}

/** `toNumber(datum["f"])` written onto `f`: the casts of a dataset's fields are independent of one another, whatever order they were found in. */
const SELF_CAST = /^(?:toNumber|toDate|toString)\(datum\[("(?:[^"\\]|\\.)*")\]\)$/
const isSelfCast = (t: Obj): boolean => {
  const m = t.type === 'formula' && typeof t.expr === 'string' && typeof t.as === 'string' ? SELF_CAST.exec(t.expr) : null
  return m !== null && JSON.parse(m[1]!) === t.as
}

/** The transforms of a dataset as a key: each run of casts is a set. */
function pipelineKey(ts: Obj[]): string[] {
  const out: string[] = []
  for (let i = 0; i < ts.length; i++) {
    if (isSelfCast(ts[i]!)) {
      const run: string[] = []
      while (i < ts.length && isSelfCast(ts[i]!)) run.push(JSON.stringify(ts[i++]))
      i--
      out.push(`casts:${run.sort().join('|')}`)
    } else out.push(transformKey(ts[i]!))
  }
  return out
}

function transformKey(t: Obj): string {
  if (t.type === 'filter' && typeof t.expr === 'string' && Object.keys(t).length === 2) return JSON.stringify(['filter', filterKey(t.expr)])
  return JSON.stringify(t)
}

/** Whether a dataset is one this compiler derived (and so one it may merge away): it only has a name, a source and transforms. */
function isDerived(d: Obj, generated: (name: string) => boolean): boolean {
  return typeof d.name === 'string' && generated(d.name) && typeof d.source === 'string' && Object.keys(d).every((k) => k === 'name' || k === 'source' || k === 'transform')
}

function renameDatasetRefs(out: Obj, map: ReadonlyMap<string, string>): void {
  if (map.size === 0) return
  const data = (out.data as Obj[] | undefined) ?? []
  for (const d of data) {
    if (typeof d.source === 'string' && map.has(d.source)) d.source = map.get(d.source)
    for (const t of (d.transform as Obj[] | undefined) ?? []) {
      if (typeof t.from === 'string' && map.has(t.from)) t.from = map.get(t.from)
      if (typeof t.expr === 'string') t.expr = renameExpr(t.expr, { signals: new Map(), scales: new Map(), datasets: map })
    }
  }
  const rest = { ...out }
  delete rest.data
  renameDataRefs(rest, map)
  renameFragment(rest, { signals: new Map(), scales: new Map(), datasets: map })
}

/** The transforms from the root dataset down to (not including) transform `k` of dataset `d`. */
function pipelineBefore(byName: Map<string, Obj>, d: Obj, k: number, skip: Obj | undefined): string {
  const chain: string[] = []
  let cur: Obj | undefined = d
  let upTo = k
  const seen = new Set<Obj>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const ts = (cur.transform as Obj[] | undefined) ?? []
    const part = pipelineKey(ts.slice(0, upTo).filter((t) => t !== skip))
    chain.unshift(`${typeof cur.source === 'string' ? '' : String(cur.name)}[${part.join(',')}]`)
    cur = typeof cur.source === 'string' ? byName.get(cur.source) : undefined
    upTo = Infinity
  }
  return chain.join('>')
}

function mergeBins(out: Obj): void {
  const data = (out.data as Obj[] | undefined) ?? []
  const byName = new Map(data.map((d) => [d.name as string, d]))
  interface Site { d: Obj; bin: Obj; extent?: Obj }
  const groups = new Map<string, Site[]>()
  for (const d of data) {
    const ts = (d.transform as Obj[] | undefined) ?? []
    ts.forEach((t, k) => {
      if (t.type !== 'bin' || typeof t.signal !== 'string' || !isObj(t.extent) || typeof (t.extent as Obj).signal !== 'string') return
      const extent = ts.find((e) => e.type === 'extent' && e.signal === (t.extent as Obj).signal)
      if (!extent || ts.indexOf(extent) >= k) return
      const { signal: _s, extent: _e, ...params } = t
      void _s
      void _e
      const key = JSON.stringify([extent.field, params, pipelineBefore(byName, d, k, extent)])
      const group = groups.get(key)
      const site = { d, bin: t, extent }
      if (group) group.push(site)
      else groups.set(key, [site])
    })
  }
  const renames = new Map<string, string>()
  for (const sites of groups.values()) {
    if (sites.length < 2) continue
    const last = sites[sites.length - 1]!
    sites.forEach((s, i) => {
      renames.set(s.bin.signal as string, last.bin.signal as string)
      renames.set(s.extent!.signal as string, last.extent!.signal as string)
      if (i === 0) return
      // (a signal is declared once: the later bin only writes its fields, reading the shared extent)
      s.d.transform = (s.d.transform as Obj[]).filter((t) => t !== s.extent)
      delete s.bin.signal
    })
  }
  const effective = new Map([...renames].filter(([from, to]) => from !== to))
  if (effective.size) renameFragment(out, { signals: effective, scales: new Map() })
}

/**
 * A bin's extent and bins signals are declared once, where MergeBins left them (the first of the merged bins keeps its `extent` and
 * its `signal`; the others read the shared extent): the rows are the same with or without the declarations, so they are not part of
 * what makes two pipelines the same.
 */
function withoutBinDeclarations(ts: Obj[]): Obj[] {
  const read = new Set(ts.filter((t) => t.type === 'bin' && isObj(t.extent) && typeof (t.extent as Obj).signal === 'string').map((t) => (t.extent as Obj).signal))
  return ts
    .filter((t) => !(t.type === 'extent' && typeof t.signal === 'string' && read.has(t.signal)))
    .map((t) => {
      if (t.type !== 'bin' || t.signal === undefined) return t
      const { signal: _s, ...rest } = t
      void _s
      return rest
    })
}

function mergeIdenticalDatasets(out: Obj, generated: (name: string) => boolean): void {
  const data = (out.data as Obj[] | undefined) ?? []
  const renames = new Map<string, string>()
  const seen = new Map<string, string>()
  const kept: Obj[] = []
  for (const d of data) {
    if (!isDerived(d, generated)) {
      kept.push(d)
      continue
    }
    const source = renames.get(d.source as string) ?? (d.source as string)
    d.source = source
    const key = JSON.stringify([source, pipelineKey(withoutBinDeclarations((d.transform as Obj[] | undefined) ?? []))])
    const have = seen.get(key)
    if (have === undefined) {
      seen.set(key, d.name as string)
      kept.push(d)
    } else renames.set(d.name as string, have)
  }
  if (renames.size === 0) return
  out.data = kept
  renameDatasetRefs(out, renames)
  dedupeDomainRefs(out, new Set(renames.values()))
}

/** A function that makes the next dataset name in the numbered series the compiler's own datasets follow (`data_7`), or none when it made no such dataset. */
function datasetNamer(data: Obj[], generated: (name: string) => boolean): (() => string) | undefined {
  const names = new Set(data.map((d) => d.name as string))
  let counter = 0
  let prefix = ''
  for (const d of data) {
    const m = isDerived(d, generated) ? /^(.*?)(\d+)$/.exec(d.name as string) : null
    if (m) { prefix = m[1]!; counter = Math.max(counter, Number(m[2]) + 1) }
  }
  if (prefix === '') return undefined
  return () => {
    while (names.has(`${prefix}${counter}`)) counter++
    names.add(`${prefix}${counter}`)
    return `${prefix}${counter}`
  }
}

/**
 * Aggregates of one source that group by the same fields are one aggregate: their measures are computed together and the datasets
 * that read them read the shared one. The measures are listed from the LAST of them, then the others in order, which is the order a
 * bootstrap interval (`ci0` / `ci1`) draws its random numbers in. A dataset left with nothing after its aggregate IS the shared one.
 */
function mergeAggregates(out: Obj, generated: (name: string) => boolean): void {
  const data = (out.data as Obj[] | undefined) ?? []
  const fresh = datasetNamer(data, generated)
  if (fresh === undefined) return
  const groups = new Map<string, Obj[]>()
  for (const d of data) {
    const first = isDerived(d, generated) ? ((d.transform as Obj[] | undefined) ?? [])[0] : undefined
    if (first === undefined || first.type !== 'aggregate' || !Object.keys(first).every((k) => k === 'type' || k === 'groupby' || k === 'fields' || k === 'ops' || k === 'as')) continue
    if (!Array.isArray(first.fields) || !Array.isArray(first.ops) || !Array.isArray(first.as)) continue
    const key = JSON.stringify([d.source, first.groupby ?? []])
    groups.set(key, [...(groups.get(key) ?? []), d])
  }
  const renames = new Map<string, string>()
  // the shared dataset is declared where the last of the datasets it replaces was, and the ones that read it follow it
  const placed = new Map<Obj, Obj[]>()
  const moved = new Set<Obj>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const lead = members[members.length - 1]!
    const measures = new Map<string, [unknown, unknown]>()
    for (const d of [lead, ...members.slice(0, -1)]) {
      const t = (d.transform as Obj[])[0]!
      ;(t.as as unknown[]).forEach((as, i) => {
        if (!measures.has(String(as))) measures.set(String(as), [(t.fields as unknown[])[i], (t.ops as unknown[])[i]])
      })
    }
    const lt = (lead.transform as Obj[])[0]!
    const made: Obj = {
      name: fresh(),
      source: lead.source,
      transform: [{ ...lt, fields: [...measures.values()].map(([f]) => f), ops: [...measures.values()].map(([, o]) => o), as: [...measures.keys()] }],
    }
    const readers: Obj[] = []
    for (const d of members) {
      const rest = (d.transform as Obj[]).slice(1)
      if (rest.length === 0) renames.set(d.name as string, made.name as string)
      else {
        d.source = made.name
        d.transform = rest
        readers.push(d)
      }
      moved.add(d)
    }
    placed.set(lead, [made, ...readers])
  }
  if (placed.size === 0) return
  // (a dataset between them that reads one of the datasets that moved moves along, so that it still follows what it reads)
  const reads = (d: Obj, names: ReadonlySet<string>): boolean =>
    (typeof d.source === 'string' && names.has(d.source)) || ((d.transform as Obj[] | undefined) ?? []).some((t) => typeof t.from === 'string' && names.has(t.from))
  const result: Obj[] = []
  for (const [lead, group] of placed) {
    const names = new Set(group.map((d) => d.name as string))
    for (const d of renames.keys()) names.add(d)
    const after: Obj[] = []
    for (const d of data.slice(0, data.indexOf(lead))) {
      if (moved.has(d) || after.includes(d) || !reads(d, names)) continue
      after.push(d)
      names.add(d.name as string)
    }
    placed.set(lead, [...group, ...after])
    for (const d of after) moved.add(d)
  }
  for (const d of data) {
    const group = placed.get(d)
    if (group) result.push(...group)
    else if (!moved.has(d)) result.push(d)
  }
  out.data = result
  renameDatasetRefs(out, renames)
  dedupeDomainRefs(out, new Set(renames.values()))
}

/** A transform whose effect is not just its output rows (it declares a signal): it stays with the dataset that declared it. */
const writesSignal = (t: Obj): boolean => typeof t.signal === 'string'

/**
 * optimizers.ts MergeIdenticalNodes below the root: datasets derived from one source whose pipelines start with the same transforms
 * share them. The shared prefix becomes a dataset of its own, and each of them reads it and keeps only what comes after (a dataset
 * left with nothing after it IS the prefix, and is renamed to it).
 */
function mergeCommonPrefixes(out: Obj, generated: (name: string) => boolean): void {
  const data = (out.data as Obj[] | undefined) ?? []
  const fresh = datasetNamer(data, generated)
  if (fresh === undefined) return
  const renames = new Map<string, string>()
  const added: Array<{ before: Obj; made: Obj }> = []
  const keyOf = (d: Obj): string[] => ((d.transform as Obj[] | undefined) ?? []).map(transformKey)
  const work = [...data]
  for (let w = 0; w < work.length; w++) {
    const parent = work[w]!
    const children = data.concat(added.map((a) => a.made)).filter((d) => isDerived(d, generated) && d.source === parent.name && !renames.has(d.name as string))
    const groups = new Map<string, Obj[]>()
    for (const c of children) {
      const ts = (c.transform as Obj[] | undefined) ?? []
      if (ts.length === 0 || writesSignal(ts[0]!)) continue
      const first = transformKey(ts[0]!)
      groups.set(first, [...(groups.get(first) ?? []), c])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const keys = group.map(keyOf)
      const ts0 = group[0]!.transform as Obj[]
      let len = 0
      while (len < ts0.length && !writesSignal(ts0[len]!) && keys.every((k) => k[len] === keys[0]![len])) len++
      if (len === 0) continue
      const made: Obj = { name: fresh(), source: parent.name, transform: ts0.slice(0, len) }
      added.push({ before: group[0]!, made })
      work.push(made)
      for (const c of group) {
        const rest = (c.transform as Obj[]).slice(len)
        if (rest.length === 0) renames.set(c.name as string, made.name as string)
        else { c.source = made.name; c.transform = rest }
      }
    }
  }
  if (added.length === 0) return
  // the shared dataset goes where the first of its readers was, so a pipeline is declared before the datasets that read it
  const result: Obj[] = []
  const placed = new Set<Obj>()
  const place = (made: Obj): void => {
    if (placed.has(made)) return
    placed.add(made)
    result.push(made)
  }
  for (const d of data) {
    for (const a of added) if (a.before === d) place(a.made)
    if (!renames.has(d.name as string)) result.push(d)
  }
  out.data = result
  renameDatasetRefs(out, renames)
  dedupeDomainRefs(out, new Set(renames.values()))
}

/**
 * Once two datasets are one, the references a scale's domain made to each (`{data: "data_0", field: "y"}` and `{data: "data_1", field:
 * "y"}`) are the same reference: vega-lite never had two (scale/domain.ts mergeDomains keeps each distinct reference once, and
 * references to one dataset are written `{data, fields: [...]}`).
 */
function dedupeDomainRefs(node: unknown, merged: ReadonlySet<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) dedupeDomainRefs(n, merged)
    return
  }
  if (!isObj(node)) return
  if (Array.isArray(node.scales)) {
    for (const sc of node.scales as unknown[]) {
      if (!isObj(sc) || !isObj(sc.domain) || !Array.isArray(sc.domain.fields)) continue
      const d = sc.domain as Obj
      const refs = d.fields as unknown[]
      if (!refs.every((r) => isObj(r) && typeof r.data === 'string' && typeof r.field === 'string')) continue
      if (!refs.some((r) => merged.has((r as Obj).data as string))) continue
      const seen = new Set<string>()
      const unique = refs.filter((r) => {
        const k = JSON.stringify(r)
        return seen.has(k) ? false : (seen.add(k), true)
      })
      const data = new Set(unique.map((r) => (r as Obj).data))
      const plain = unique.every((r) => Object.keys(r as Obj).length === 2)
      if (data.size === 1 && plain) {
        const names = unique.map((r) => (r as Obj).field)
        sc.domain = { data: [...data][0], ...(names.length === 1 ? { field: names[0] } : { fields: names }), ...(d.sort !== undefined ? { sort: d.sort } : {}) }
      }
      else if (unique.length !== refs.length) d.fields = unique
    }
  }
  for (const v of Object.values(node)) if (v !== null && typeof v === 'object') dedupeDomainRefs(v, merged)
}

/**
 * optimizers.ts RemoveUnusedSubtrees: a dataset nothing reads - no mark, scale, expression, or dataset derived from it - is not
 * emitted. (A facet whose axes sit in its cells has no header groups, so the datasets that lay the headers out are unused.)
 */
function removeUnusedDatasets(out: Obj, removable: (name: string) => boolean): void {
  let data = (out.data as Obj[] | undefined) ?? []
  const rest = { ...out }
  delete rest.data
  const outside = JSON.stringify(rest)
  for (;;) {
    // (a name is read when it appears, whole, anywhere in the spec but its own dataset's name: a mark's `from`, a scale's domain, an
    // expression's `data("name")`, a source, a lookup)
    const text = outside + data.map((d) => JSON.stringify({ ...d, name: undefined })).join('\n')
    const reads = (name: string): boolean => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text)
    const keep = data.filter((d) => !(typeof d.name === 'string' && removable(d.name) && !reads(d.name)))
    if (keep.length === data.length) return
    data = keep
    out.data = keep
  }
}

/** Run the cross-view optimizations on an assembled spec (in place). `generated` tells the datasets this compiler numbered from the user's. */
export function optimizeData(out: Obj, generated: (name: string) => boolean): void {
  if (!Array.isArray(out.data) || out.data.length < 2) return
  mergeBins(out)
  mergeIdenticalDatasets(out, generated)
  mergeAggregates(out, generated)
  mergeCommonPrefixes(out, generated)
  // (only the datasets that lay out facet headers: vega-lite keeps the pipeline datasets its scales requested even when a cell's own
  // scales end up reading the cell's copies)
  removeUnusedDatasets(out, (name) => /(?:^|_)(?:row|column|facet)_domain(?:_row|_column)?$/.test(name))
}
