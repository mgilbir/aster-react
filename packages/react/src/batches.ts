import type { StreamBatch } from '@aster-charts/core'

type AnyBatch = Omit<StreamBatch, 'textMetrics'> & { textMetrics?: unknown }

/**
 * A batch that folds later batches into itself, with the same effect as applying them one after another (the producer-side
 * queue of the worker stream under `coalesce` holds one). It owns its arrays: folding appends rows in place, so a burst of n
 * one-row pushes costs O(n) in all, not O(n^2) (C492: each merge copied every row folded so far).
 *
 * - a later full snapshot of a dataset supersedes earlier appends to it;
 * - appends concatenate in order;
 * - scalar inputs (size, limits, text metrics) take the later value; `signals` and `domainRaw` merge key by key, the later
 *   value winning;
 * - explicit pulses cannot be composed in general: once a second batch is folded in they are dropped and the stream falls
 *   back to a snapshot diff (still correct, O(n)).
 */
export interface BatchFold<B extends AnyBatch> {
  /** Fold `batch` in (its `append` arrays are copied: the caller may reuse them). */
  add(batch: B): void
  /** Rows the fold holds (snapshot rows plus appended rows), as the stream counts them. */
  rows(): number
  /** Rows the fold would hold with `batch` folded in (a snapshot replaces what it held for that dataset), as the stream counts. */
  rowsWith(batch: B): number
  /** The folded batch (null when nothing was added). The fold is not used afterwards. */
  take(): B | null
}

export function createBatchFold<B extends AnyBatch>(): BatchFold<B> {
  let out: Record<string, unknown> | null = null
  let data: Record<string, unknown[]> | null = null
  let append: Record<string, unknown[]> | null = null
  let count = 0
  let rows = 0
  const lengthOf = (rec: Record<string, unknown[]> | null): number => {
    let n = 0
    if (rec) for (const name of Object.keys(rec)) n += rec[name]!.length
    return n
  }
  return {
    add(b) {
      count++
      out ??= {}
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined || k === 'data' || k === 'append' || k === 'signals' || k === 'domainRaw' || k === 'pulse') continue
        out[k] = v
      }
      if (b.signals) out.signals = { ...(out.signals as Record<string, unknown> | undefined), ...b.signals }
      if (b.domainRaw) out.domainRaw = { ...(out.domainRaw as Record<string, unknown> | undefined), ...b.domainRaw }
      if (count === 1 && b.pulse) out.pulse = b.pulse
      else delete out.pulse
      if (b.data) {
        for (const [name, list] of Object.entries(b.data)) {
          ;(data ??= {})[name] = list
          if (append && Object.hasOwn(append, name)) delete append[name]
        }
      }
      if (b.append) {
        for (const [name, list] of Object.entries(b.append)) {
          const cur = (append ??= {})[name]
          // Loop, not push(...list): a data-sized spread overflows the call stack.
          if (cur) { for (let i = 0; i < list.length; i++) cur.push(list[i]) }
          else append[name] = list.slice()
        }
      }
      rows = lengthOf(data) + lengthOf(append)
    },
    rows: () => rows,
    rowsWith(b) {
      let n = rows
      if (b.data) {
        for (const [name, list] of Object.entries(b.data)) {
          n -= (data && Object.hasOwn(data, name) ? data[name]!.length : 0) + (append && Object.hasOwn(append, name) ? append[name]!.length : 0)
          n += list.length
        }
      }
      if (b.append) for (const list of Object.values(b.append)) n += list.length
      return n
    },
    take() {
      if (out === null) return null
      if (data && Object.keys(data).length) out.data = data
      if (append && Object.keys(append).length) out.append = append
      const result = out as B
      out = null
      data = null
      append = null
      count = 0
      rows = 0
      return result
    },
  }
}

/** Rows a batch adds to the queue (snapshot rows plus appended rows), as the stream counts them. */
export function batchRows(b: AnyBatch): number {
  let n = 0
  for (const l of Object.values(b.data ?? {})) n += l.length
  for (const l of Object.values(b.append ?? {})) n += l.length
  return n
}
