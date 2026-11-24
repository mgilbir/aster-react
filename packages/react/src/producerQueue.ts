/**
 * The producer side of a worker stream: the batches `push` accepted and no flush has taken yet, in push order, under the stream's
 * backpressure policy. It is the ONE queue of `useChartWorkerStream`, whatever the stream is: a Worker, the in-realm fallback, or
 * nothing yet (before the start effect, while add-ons load, between a restart's render and its effect). Its answer is final:
 * what it accepts is delivered in order to the stream, which never refuses it (a flush never carries more than the stream's own
 * bounds), except that `drop-oldest` may later displace an accepted batch to make room for a newer one, as the stream does.
 *
 * The bounds are the stream's: `capacity` batches (one folded batch under `coalesce`) and `maxQueuedRows` rows. Under
 * `drop-newest` and `coalesce` a push past a bound is refused (`false`), under `drop-oldest` whole oldest batches are discarded
 * until it fits, and `error` throws `AsterStreamBackpressureError`. A batch larger than the row bound is always refused.
 */
import { AsterStreamBackpressureError, type StreamPolicy } from '@aster-charts/core'
import { batchRows, createBatchFold, type BatchFold } from './batches.js'
import type { ChartWorkerBatch } from './worker.js'

export interface ProducerQueueBounds {
  capacity: number
  maxQueuedRows: number
  policy: StreamPolicy
}

export interface ProducerQueue {
  /** Queue a batch. `false`: the policy refused it; `error` throws instead. */
  push(batch: ChartWorkerBatch): boolean
  /** Take everything queued, in order (folded into one batch under `coalesce`). */
  take(): ChartWorkerBatch[]
  /** Batches queued (0 or 1 under `coalesce`). */
  depth(): number
  /** Rows queued. */
  rows(): number
  /** Batches accepted earlier and then displaced by `drop-oldest`, since the queue was made. */
  displaced(): number
  /** New bounds for later pushes (what is queued stays queued). */
  setBounds(bounds: ProducerQueueBounds): void
  /** Drop everything queued; returns how many batches. */
  clear(): number
}

export function createProducerQueue(initial: ProducerQueueBounds): ProducerQueue {
  let bounds = initial
  let list: Array<{ batch: ChartWorkerBatch; rows: number }> = []
  let listRows = 0
  let fold: BatchFold<ChartWorkerBatch> | null = null
  let displaced = 0
  const refuse = (bound: 'batches' | 'rows', limit: number): false => {
    if (bounds.policy === 'error') throw new AsterStreamBackpressureError(limit, bound)
    return false
  }
  const queue: ProducerQueue = {
    push(batch) {
      const rows = batchRows(batch)
      const { capacity, maxQueuedRows, policy } = bounds
      if (rows > maxQueuedRows) return refuse('rows', maxQueuedRows)
      if (policy === 'coalesce') {
        // what is queued before a policy change stays a list; under coalesce later pushes fold behind it
        const after = (fold?.rowsWith(batch) ?? rows) + listRows
        if (after > maxQueuedRows) return refuse('rows', maxQueuedRows)
        ;(fold ??= createBatchFold<ChartWorkerBatch>()).add(batch)
        return true
      }
      if (fold) {
        // (a switch from coalesce: the folded batch becomes the oldest entry of the list)
        const folded = fold.take()
        fold = null
        if (folded) { list.push({ batch: folded, rows: batchRows(folded) }); listRows += batchRows(folded) }
      }
      while (list.length >= capacity || listRows + rows > maxQueuedRows) {
        if (policy !== 'drop-oldest') {
          const byBatches = list.length >= capacity
          return refuse(byBatches ? 'batches' : 'rows', byBatches ? capacity : maxQueuedRows)
        }
        listRows -= list.shift()!.rows
        displaced++
      }
      list.push({ batch, rows })
      listRows += rows
      return true
    },
    take() {
      const out = list.map((e) => e.batch)
      const folded = fold?.take()
      if (folded) out.push(folded)
      list = []
      listRows = 0
      fold = null
      return out
    },
    // (a fold exists only once something was folded into it)
    depth: () => list.length + (fold ? 1 : 0),
    rows: () => listRows + (fold?.rows() ?? 0),
    displaced: () => displaced,
    setBounds(next) { bounds = next },
    clear() {
      const n = queue.depth()
      list = []
      listRows = 0
      fold = null
      return n
    },
  }
  return queue
}
