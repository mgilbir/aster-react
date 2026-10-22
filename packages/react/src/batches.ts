import type { StreamBatch } from '@aster/core'

/**
 * Compose two batches into one that has the same effect as applying `a` then
 * `b`. Used by producer-side queues that must stay bounded (the worker stream's
 * main-thread buffer under the `coalesce` policy).
 *
 * - a later full snapshot of a dataset supersedes earlier appends to it;
 * - appends concatenate in order;
 * - scalar inputs (signals, size, limits, text metrics, domain overrides) take
 *   the later value;
 * - explicit pulses cannot be composed in general, so they are dropped and the
 *   stream falls back to a snapshot diff (still correct, O(n)).
 */
export function mergeBatches<B extends Omit<StreamBatch, 'textMetrics'> & { textMetrics?: unknown }>(a: B, b: B): B {
  const data: Record<string, unknown[]> = { ...(a.data ?? {}), ...(b.data ?? {}) }
  const append: Record<string, unknown[]> = {}
  for (const [name, rows] of Object.entries(a.append ?? {})) {
    if (b.data && name in b.data) continue
    append[name] = rows.slice()
  }
  for (const [name, rows] of Object.entries(b.append ?? {})) {
    const cur = append[name]
    if (cur) cur.push(...rows)
    else append[name] = rows.slice()
  }
  const out: B = { ...a }
  for (const [k, v] of Object.entries(b)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  delete out.pulse
  if (Object.keys(data).length) out.data = data
  else delete out.data
  if (Object.keys(append).length) out.append = append
  else delete out.append
  if (a.signals || b.signals) out.signals = { ...(a.signals ?? {}), ...(b.signals ?? {}) }
  if (a.domainRaw || b.domainRaw) out.domainRaw = { ...(a.domainRaw ?? {}), ...(b.domainRaw ?? {}) }
  return out
}
