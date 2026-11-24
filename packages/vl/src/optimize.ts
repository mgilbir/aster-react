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

import { EXPRESSION_KEYS } from './embed.js'
import { tokenize } from './expr-tokens.js'
import { isRows, sameData, stringifyWithoutRows } from './rows.js'
import { VLCompileError } from './names.js'

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

/**
 * A bin or an extent as the rows it makes: the names of the signals it declares or reads are no part of that (two views' copies of one
 * bin are named after their views), the field its extent is taken over is.
 */
function asRows(ts: Obj[]): Obj[] {
  const extentField = new Map(ts.filter((t) => t.type === 'extent' && typeof t.signal === 'string').map((t) => [t.signal as string, t.field]))
  return ts.map((t) => {
    if (t.type === 'extent' && typeof t.signal === 'string') return { type: 'extent', field: t.field }
    if (t.type !== 'bin') return t
    const { signal: _s, ...rest } = t
    void _s
    if (isObj(rest.extent) && typeof rest.extent.signal === 'string' && extentField.has(rest.extent.signal)) rest.extent = { over: extentField.get(rest.extent.signal) }
    return rest
  })
}

/** The transforms from the root dataset down to (not including) transform `k` of dataset `d`, as the rows they make. */
function pipelineBefore(byName: Map<string, Obj>, d: Obj, k: number, skip: Obj | undefined): string {
  const chain: string[] = []
  let cur: Obj | undefined = d
  let upTo = k
  const seen = new Set<Obj>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const ts = (cur.transform as Obj[] | undefined) ?? []
    const part = pipelineKey(asRows(ts.slice(0, upTo).filter((t) => t !== skip)))
    chain.unshift(`${typeof cur.source === 'string' ? '' : String(cur.name)}[${part.join(',')}]`)
    cur = typeof cur.source === 'string' ? byName.get(cur.source) : undefined
    upTo = Infinity
  }
  return chain.join('>')
}

/**
 * optimizers.ts MergeBins: sibling bin nodes (the same parent: the same rows) with the same field and parameters are one node, named
 * after the LAST of them (`promotableBins.pop()`, `renameSignal(other, this)`). A bin with a computed extent shares its extent too. The
 * signals of each merged bin are renamed everywhere they are read (`within`: the part of the spec that reads them). A bin that declares a
 * signal no merge shared is a dataset's own, never merged away (mergeIdenticalDatasets).
 */
/** The bins that kept the declarations of a merge (the others read them): through every later pass, until the compile is done. */
const SHARED_BINS = new WeakSet<object>()

export function mergeBins(data: Obj[], within: unknown): void {
  const byName = new Map(data.map((d) => [d.name as string, d]))
  interface Site { d: Obj; bin: Obj; extent?: Obj }
  const groups = new Map<string, Site[]>()
  for (const d of data) {
    const ts = (d.transform as Obj[] | undefined) ?? []
    ts.forEach((t, k) => {
      if (t.type !== 'bin' || typeof t.signal !== 'string') return
      const extentSignal = isObj(t.extent) && typeof (t.extent as Obj).signal === 'string' ? (t.extent as Obj).signal : undefined
      const extent = extentSignal === undefined ? undefined : ts.find((e) => e.type === 'extent' && e.signal === extentSignal)
      // (a bin that reads an extent it does not declare before it - a parameter's - is left as it is)
      if (extentSignal !== undefined && (extent === undefined || ts.indexOf(extent) >= k)) return
      const params = Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'signal' && !(extent !== undefined && key === 'extent')))
      const key = JSON.stringify([extent?.field, params, pipelineBefore(byName, d, k, extent)])
      const group = groups.get(key)
      const site = { d, bin: t, ...(extent !== undefined ? { extent } : {}) }
      if (group) group.push(site)
      else groups.set(key, [site])
    })
  }
  const renames = new Map<string, string>()
  for (const sites of groups.values()) {
    if (sites.length < 2) continue
    const last = sites[sites.length - 1]!
    SHARED_BINS.add(sites[0]!.bin)
    sites.forEach((s, i) => {
      renames.set(s.bin.signal as string, last.bin.signal as string)
      if (s.extent !== undefined) renames.set(s.extent.signal as string, last.extent!.signal as string)
      if (i === 0) return
      // (a signal is declared once: the later bin only writes its fields, reading the shared extent)
      if (s.extent !== undefined) s.d.transform = (s.d.transform as Obj[]).filter((t) => t !== s.extent)
      delete s.bin.signal
    })
  }
  const effective = new Map([...renames].filter(([from, to]) => from !== to))
  if (effective.size) renameFragment(within, { signals: effective, scales: new Map() })
}

/**
 * optimizers.ts MergeBins, within one dataset's transforms: a bin of the same field and parameters as an EARLIER bin, with nothing between
 * them that changes the rows it reads (a filter, an aggregate, anything that makes its field), is not made again: the earlier bin makes
 * the fields, and the later one's names are copies of them (`datum["b"]` -> `b2`), written where the earlier one is. The bin of a
 * transform and the bin of a channel are the same node to vega-lite whichever way each was written.
 *
 * Edits `ts` in place; returns where the transform that was at index `k` is now (for a caller that holds an index into `ts`).
 */
export function mergeChainedBins(ts: Obj[]): (k: number) => number {
  // the transforms a bin can be carried up past: they neither drop or add rows nor write the bin's field
  const passable = (t: Obj): boolean => t.type === 'formula' || t.type === 'extent' || t.type === 'bin' || t.type === 'timeunit'
  interface First { at: number; start: string; end: string; signal: unknown; extent: unknown }
  const firsts = new Map<string, First>()
  const drop = new Set<number>()
  const after = new Map<number, Obj[]>()
  const binKeyOf = (t: Obj, k: number): string | undefined => {
    if (t.type !== 'bin' || !Array.isArray(t.as) || t.as.length !== 2 || typeof t.signal !== 'string') return undefined
    const e = isObj(t.extent) && typeof t.extent.signal === 'string' ? ts.findLast((x, i) => i < k && x.type === 'extent' && x.signal === (t.extent as Obj).signal) : undefined
    if (isObj(t.extent) && e === undefined) return undefined
    const params = Object.fromEntries(Object.entries(t).filter(([key]) => key !== 'signal' && key !== 'as' && key !== 'extent'))
    return JSON.stringify([params, e === undefined ? t.extent : { of: e.field }])
  }
  ts.forEach((t, k) => {
    const key = binKeyOf(t, k)
    if (key === undefined) {
      // anything that is not passable ends the run of rows a bin can be shared over
      if (!passable(t)) firsts.clear()
      else if (t.type === 'formula' && typeof t.as === 'string') for (const [fk, f] of firsts) if (JSON.parse(fk)[0].field === t.as) { void f; firsts.delete(fk) }
      return
    }
    const first = firsts.get(key)
    if (first === undefined) {
      firsts.set(key, { at: k, start: (t.as as string[])[0]!, end: (t.as as string[])[1]!, signal: t.signal, extent: isObj(t.extent) ? (t.extent as Obj).signal : undefined })
      return
    }
    // (the copies; the extent the later bin declared goes with it)
    const names = t.as as string[]
    const copies: Obj[] = []
    if (names[0] !== first.start) copies.push({ type: 'formula', expr: `datum[${JSON.stringify(first.start)}]`, as: names[0] })
    if (names[1] !== first.end) copies.push({ type: 'formula', expr: `datum[${JSON.stringify(first.end)}]`, as: names[1] })
    after.set(first.at, [...(after.get(first.at) ?? []), ...copies])
    drop.add(k)
    const own = isObj(t.extent) ? ts.findLastIndex((x, i) => i < k && x.type === 'extent' && x.signal === (t.extent as Obj).signal) : -1
    // (an extent signal another bin reads stays: only the one this bin declared by itself, with the same signal as the first's, goes)
    if (own >= 0 && (t.extent as Obj).signal === first.extent && own > first.at) drop.add(own)
  })
  if (drop.size === 0) return (k) => k
  const out: Obj[] = []
  const place: number[] = []
  ts.forEach((t, k) => {
    place[k] = out.length
    if (!drop.has(k)) out.push(t)
    for (const c of after.get(k) ?? []) out.push(c)
  })
  ts.splice(0, ts.length, ...out)
  return (k) => (k >= place.length ? ts.length : place[k]!)
}

/**
 * The declarations MergeBins shared (SHARED_BINS: one bin keeps its `extent` and its `signal`, the others read them) are
 * not part of what makes two pipelines the same: the rows are the same with or without them. A bin that declares a signal of its own
 * (one no merge renamed: its readers read it under that name) stays part of its dataset's identity.
 */
function withoutBinDeclarations(ts: Obj[]): Obj[] {
  const read = new Set(ts.filter((t) => t.type === 'bin' && isObj(t.extent) && typeof (t.extent as Obj).signal === 'string').map((t) => (t.extent as Obj).signal))
  const shared = (t: Obj): boolean => typeof t.signal !== 'string' || SHARED_BINS.has(t)
  return ts
    .filter((t) => !(t.type === 'extent' && typeof t.signal === 'string' && read.has(t.signal) && ts.some((b) => b.type === 'bin' && isObj(b.extent) && (b.extent as Obj).signal === t.signal && shared(b))))
    .map((t) => {
      if (t.type !== 'bin' || t.signal === undefined || !shared(t)) return t
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
        const measure: [unknown, unknown] = [(t.fields as unknown[])[i], (t.ops as unknown[])[i]]
        const have = measures.get(String(as))
        // (vega-lite merges the two into one aggregate that writes the name twice, and both views draw whichever is written last: a
        // wrong chart, refused instead, DECISIONS Q9)
        if (have !== undefined && JSON.stringify(have) !== JSON.stringify(measure)) {
          throw new VLCompileError(`two views aggregate different measures (${String(have[1])} of ${String(have[0])}, ${String(measure[1])} of ${String(measure[0])}) into the same field "${String(as)}" over the same data: vega-lite 6.4.3 merges the aggregates and both views draw one of them; give the measures different \`as\` names`)
        }
        if (have === undefined) measures.set(String(as), measure)
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
    if (group) for (const member of group) result.push(member)
    else if (!moved.has(d)) result.push(d)
  }
  out.data = result
  renameDatasetRefs(out, renames)
  dedupeDomainRefs(out, new Set(renames.values()))
}

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
  const work = [...data]
  for (let w = 0; w < work.length; w++) {
    const parent = work[w]!
    const children = data.concat(added.map((a) => a.made)).filter((d) => isDerived(d, generated) && d.source === parent.name && !renames.has(d.name as string))
    // (optimizers.ts MoveParseUp / MergeParse: the casts that start the children's pipelines move up into what they share, joined,
    // unless two children cast one field differently; what follows them is compared as it is)
    const castsOf = (c: Obj): Obj[] => {
      const ts = (c.transform as Obj[] | undefined) ?? []
      let n = 0
      while (n < ts.length && isSelfCast(ts[n]!)) n++
      return ts.slice(0, n)
    }
    const restOf = (c: Obj): Obj[] => ((c.transform as Obj[] | undefined) ?? []).slice(castsOf(c).length)
    const groups = new Map<string, Obj[]>()
    for (const c of children) {
      const rest = restOf(c)
      // (a transform that declares a signal is shared like any other when the declarations are the same, name included: Vega takes
      // one declaration of a name, and the readers read it under that name; two that declare different names never compare equal)
      if (rest.length === 0) continue
      const first = transformKey(rest[0]!)
      groups.set(first, [...(groups.get(first) ?? []), c])
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const casts = new Map<string, Obj>()
      let conflict = false
      for (const c of group) {
        for (const t of castsOf(c)) {
          const have = casts.get(t.as as string)
          if (have !== undefined && have.expr !== t.expr) conflict = true
          else casts.set(t.as as string, t)
        }
      }
      if (conflict) continue
      const keys = group.map((c) => restOf(c).map(transformKey))
      const rest0 = restOf(group[0]!)
      let len = 0
      while (len < rest0.length && keys.every((k) => k[len] === keys[0]![len])) len++
      if (len === 0) continue
      const made: Obj = { name: fresh(), source: parent.name, transform: [...casts.values(), ...rest0.slice(0, len)] }
      added.push({ before: group[0]!, made })
      work.push(made)
      for (const c of group) {
        const rest = restOf(c).slice(len)
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
  for (const v of Object.values(node)) if (v !== null && typeof v === 'object' && !isRows(v)) dedupeDomainRefs(v, merged)
}

/**
 * optimizers.ts RemoveUnusedSubtrees: a dataset nothing reads - no mark, scale, expression, or dataset derived from it - is not
 * emitted. (A facet whose axes sit in its cells has no header groups, so the datasets that lay the headers out are unused.)
 */
function removeUnusedDatasets(out: Obj, removable: (name: string) => boolean): void {
  let data = (out.data as Obj[] | undefined) ?? []
  // (only a dataset this compiler made can go; with none of them, there is nothing to look for: the text of the whole spec and the
  // tokens of all its expressions, below, are most of what this costs, and most specs have no such dataset)
  if (!data.some((d) => typeof d.name === 'string' && removable(d.name))) return
  const rest = { ...out }
  delete rest.data
  // (the user's rows name no dataset: they are left out of the text)
  const outside = stringifyWithoutRows(rest)
  for (;;) {
    // (a name is read when it appears, whole, anywhere in the spec but its own dataset's name: a mark's `from`, a scale's domain, an
    // expression's `data("name")`, a source, a lookup)
    const text = outside + data.map((d) => stringifyWithoutRows({ ...d, name: undefined })).join('\n')
    // (and every name and string an expression spells, as vega's lexer reads them: `data("row\\u005fdomain")` reads `row_domain`)
    const spelled = new Set<string>()
    const collect = (v: unknown, key: string): void => {
      if (typeof v === 'string') { if (EXPRESSION_KEYS.has(key)) for (const t of tokenize(v)) if (t.value !== undefined) spelled.add(t.value) }
      else if (Array.isArray(v)) v.forEach((x) => collect(x, key))
      else if (isObj(v)) for (const [k, x] of Object.entries(v)) if (k !== 'values') collect(x, k)
    }
    collect(rest, '')
    for (const d of data) collect({ ...d, name: undefined }, '')
    const reads = (name: string): boolean => spelled.has(name) || new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(text)
    const keep = data.filter((d) => !(typeof d.name === 'string' && removable(d.name) && !reads(d.name)))
    if (keep.length === data.length) return
    data = keep
    out.data = keep
  }
}

/**
 * compile/data/parse.ts findSource: the views of a spec share one list of sources, and a view's data is an existing source when it
 * is the same data -- equal inline values (deepEqual: keys in any order), the same url, the same name -- unless the two are named
 * differently or extract different topojson objects. On the assembled spec: a later source dataset that is an earlier one is merged
 * into it (formats merged, the earlier's keys winning; a name the earlier lacks taken from the later) and every reference follows.
 * `named` tells a name the user gave a dataset from one this compiler made.
 */
function mergeIdenticalSources(out: Obj, named: (name: string) => boolean): void {
  const data = (out.data as Obj[] | undefined) ?? []
  const isSource = (d: Obj): boolean => d.source === undefined && (d.transform === undefined || (Array.isArray(d.transform) && d.transform.length === 0)) && (d.values !== undefined || typeof d.url === 'string')
  const fmt = (d: Obj): Obj => (isObj(d.format) ? d.format : {})
  const sameSource = (d: Obj, other: Obj): boolean => {
    const dn = named(d.name as string)
    const on = named(other.name as string)
    if (dn && on && d.name !== other.name) return false
    const mesh = fmt(d).mesh
    const feature = fmt(d).feature
    const otherMesh = fmt(other).mesh
    const otherFeature = fmt(other).feature
    // (a view's explicit parse is a parse node of the view's own (data/parse.ts ParseNode.makeExplicit); MoveParseUp / MergeParse move
    // it up to the shared source unless another view parses the same field differently, in which case each keeps its own. Here the
    // parse is on the source's format: sources whose parses conflict on a field stay two sources; others merge, parses joined)
    const p1 = fmt(d).parse
    const p2 = fmt(other).parse
    if (isObj(p1) && isObj(p2) && Object.keys(p1).some((k) => Object.hasOwn(p2, k) && JSON.stringify(p1[k]) !== JSON.stringify(p2[k]))) return false
    if ((p1 === null) !== (p2 === null) && (isObj(p1) || isObj(p2))) return false
    if (mesh && otherFeature) return false
    if ((feature || otherFeature) && feature !== otherFeature) return false
    if ((mesh || otherMesh) && mesh !== otherMesh) return false
    if (d.values !== undefined && other.values !== undefined) return sameData(d.values, other.values)
    if (typeof d.url === 'string' && typeof other.url === 'string') return d.url === other.url
    return false
  }
  const sources: Obj[] = []
  const renames = new Map<string, string>()
  const kept: Obj[] = []
  for (const d of data) {
    if (!isSource(d)) { kept.push(d); continue }
    const into = sources.find((s) => sameSource(d, s))
    if (into === undefined) { sources.push(d); kept.push(d); continue }
    into.format = mergeFormats(fmt(d), fmt(into))
    if (Object.keys(into.format as Obj).length === 0 && d.format === undefined) delete into.format
    if (!named(into.name as string) && named(d.name as string)) {
      // (the earlier source takes the later's name: what read the earlier one reads it under that name)
      for (const [from, to] of renames) if (to === into.name) renames.set(from, d.name as string)
      renames.set(into.name as string, d.name as string)
      into.name = d.name
    } else {
      renames.set(d.name as string, into.name as string)
    }
  }
  if (renames.size === 0) return
  out.data = kept
  renameDatasetRefs(out, renames)
  dedupeDomainRefs(out, new Set(renames.values()))
}

/** vega-lite mergeDeep({}, later, earlier): the earlier's keys win, nested objects merged. */
function mergeFormats(later: Obj, earlier: Obj): Obj {
  const out: Obj = { ...later }
  for (const [k, v] of Object.entries(earlier)) {
    const value = isObj(v) && isObj(out[k]) ? mergeFormats(out[k] as Obj, v) : v
    Object.defineProperty(out, k, { value, writable: true, enumerable: true, configurable: true })
  }
  return out
}

/** Run the cross-view optimizations on an assembled spec (in place). `generated` tells the datasets this compiler numbered from the user's. */
export function optimizeData(out: Obj, generated: (name: string) => boolean, named: (name: string) => boolean = () => true): void {
  if (!Array.isArray(out.data) || out.data.length < 2) return
  mergeIdenticalSources(out, named)
  mergeBins((out.data as Obj[] | undefined) ?? [], out)
  mergeIdenticalDatasets(out, generated)
  mergeAggregates(out, generated)
  mergeCommonPrefixes(out, generated)
  // (only the datasets that lay out facet headers: vega-lite keeps the pipeline datasets its scales requested even when a cell's own
  // scales end up reading the cell's copies)
  removeUnusedDatasets(out, (name) => /(?:^|_)(?:row|column|facet)_domain(?:_row|_column)?$/.test(name))
}
