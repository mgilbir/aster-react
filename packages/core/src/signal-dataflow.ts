/**
 * The run loop of vega-dataflow, as a model for the event-driven signal graph.
 *
 * What a signal does when an event arrives is not "re-evaluate whatever reads it": it is what vega-dataflow's `evaluate` does
 * with a graph of operators. Each operator has a RANK (a number that grows with its creation order, and is pushed above all
 * of its sources when it is connected to one declared later: `connect` / `rerank`); a run takes the touched operators off a
 * priority queue in rank order; an operator is queued and evaluated AT MOST ONCE PER STAMP (one run), however many sources
 * pulse it; an operator that was set by an event handler is SKIPPED (its own update expression is not evaluated) but still
 * pulses its dependents; an operator whose new value is the old one (`===`) does not pulse unless it was `modified` (the
 * `force` of a signal update). The consequences are observable: a handler of a signal stream that has already run in the
 * run does not see a later change of its source, a dataset edited by `setdata` is the new one only for the operators ranked
 * after it, the edits of `modify` are a run of their own after the current one, and a cycle through streams settles the way
 * vega's does, not the way a fixed point would.
 *
 * Port notes (vega-dataflow Operator.js, Heap.js, UniqueList.js, dataflow/{rank,connect,update,run}.js). Values live where
 * the host keeps them (an operator's `evaluate` reads and writes them); pulses, which carry tuples, are not modelled, only
 * the fact of propagation. Nothing here knows about DOM events, the DOM or React.
 */

/** What an operator's `evaluate` returns to stop its dependents from being queued (vega's `StopPropagation`). */
export const STOP: unique symbol = Symbol('StopPropagation')

export type Evaluate = () => typeof STOP | void

let nextOpId = 0

/** vega-dataflow `Operator`: a node with a rank, a stamp, a `skip` and a `modified` flag, and the operators it pulses. */
export class Op {
  readonly id = ++nextOpId
  rank = -1
  qrank = -1
  stamp = -1
  /** The operators pulsed when this one propagates, in the order they were added (vega `UniqueList`). */
  targets: Op[] = []
  private skipFlag = false
  private modifiedFlag = false

  constructor(
    readonly name: string,
    /** The update: `undefined` for an operator that only passes the pulse on. */
    public evaluate?: Evaluate,
  ) {}

  skip(): boolean
  skip(state: boolean): this
  skip(state?: boolean): boolean | this {
    if (state === undefined) return this.skipFlag
    this.skipFlag = state
    return this
  }

  modified(): boolean
  modified(state: boolean): this
  modified(state?: boolean): boolean | this {
    if (state === undefined) return this.modifiedFlag
    this.modifiedFlag = state
    return this
  }

  addTarget(op: Op): void {
    if (!this.targets.includes(op)) this.targets.push(op)
  }

  removeTarget(op: Op): void {
    const i = this.targets.indexOf(op)
    if (i >= 0) this.targets.splice(i, 1)
  }

  /** vega `Operator.run`: a skipped operator does not evaluate, and passes the pulse on. */
  run(): typeof STOP | void {
    if (this.skipFlag) {
      this.skipFlag = false
      return undefined
    }
    return this.evaluate?.()
  }
}

/** vega-dataflow's binary heap (util/Heap.js), ported as is: operators of equal rank come out in the order its sifts give. */
class Heap {
  private nodes: Op[] = []
  size(): number { return this.nodes.length }
  clear(): void { this.nodes = [] }
  private static cmp(a: Op, b: Op): number { return a.qrank - b.qrank }
  push(x: Op): void {
    this.nodes.push(x)
    this.siftdown(0, this.nodes.length - 1)
  }
  pop(): Op {
    const nodes = this.nodes
    const last = nodes.pop()!
    let item: Op
    if (nodes.length) {
      item = nodes[0]!
      nodes[0] = last
      this.siftup(0)
    } else {
      item = last
    }
    return item
  }
  private siftdown(start: number, idx: number): void {
    const array = this.nodes
    const item = array[idx]!
    while (idx > start) {
      const pidx = (idx - 1) >> 1
      const parent = array[pidx]!
      if (Heap.cmp(item, parent) < 0) {
        array[idx] = parent
        idx = pidx
        continue
      }
      break
    }
    array[idx] = item
  }
  private siftup(idx: number): void {
    const array = this.nodes
    const start = idx
    const end = array.length
    const item = array[idx]!
    let cidx = (idx << 1) + 1
    while (cidx < end) {
      const ridx = cidx + 1
      if (ridx < end && Heap.cmp(array[cidx]!, array[ridx]!) >= 0) cidx = ridx
      array[idx] = array[cidx]!
      idx = cidx
      cidx = (idx << 1) + 1
    }
    array[idx] = item
    this.siftdown(start, idx)
  }
}

export interface FlowHooks {
  /** An error raised by an operator in a run (vega: `Dataflow.error`); the rest of that run is abandoned. */
  error(e: unknown): void
}

/** An operator whose dependents form a cycle that does not come back to it: vega's `rerank` would not end. */
const RERANK_LIMIT = 1_000_000

/** vega-dataflow `Dataflow`, for the parts that decide the order and the number of evaluations. */
export class Flow {
  /** The stamp of the current (or last) run; the first run is 1. */
  clock = 0
  private rankCounter = 0
  private readonly heap = new Heap()
  private touched: Op[] = []
  private pulsing = false
  private postrun: Array<{ priority: number; callback: () => void }> = []

  constructor(private readonly hooks: FlowHooks) {}

  /** `Dataflow.stamp()` */
  stamp(): number { return this.clock }

  /** True while a run is propagating (vega: `df._pulse` is set). */
  get running(): boolean { return this.pulsing }

  /** vega `rank`: the operator gets the next rank. */
  rank(op: Op): void { op.rank = ++this.rankCounter }

  /** vega `add`, without the first-run touch (a graph is built after its first run): the operator gets the next rank. */
  add(op: Op): Op {
    this.rank(op)
    return op
  }

  /**
   * vega `connect`: `target` is a dependent of `sources`; when one of them ranks above it, it and everything downstream of
   * it are ranked again, above everything ranked so far. Throws on a cycle that comes back to `target`.
   */
  connect(target: Op, sources: readonly Op[]): void {
    const targetRank = target.rank
    for (const s of sources) {
      if (targetRank < s.rank) {
        this.rerank(target)
        return
      }
    }
  }

  /** vega `rerank`. */
  rerank(op: Op): void {
    const queue = [op]
    for (let steps = 0; queue.length; ++steps) {
      if (steps > RERANK_LIMIT) throw new Error('Cycle detected in dataflow graph.')
      let cur = queue.pop()!
      this.rank(cur)
      const list = cur.targets
      for (let i = list.length; --i >= 0;) {
        queue.push((cur = list[i]!))
        if (cur === op) throw new Error('Cycle detected in dataflow graph.')
      }
    }
  }

  /**
   * vega `touch`: outside a run the operator is queued for the next one; in the midst of one it is queued if and only if it has not
   * been evaluated on the current stamp. `skip`: its own update is not evaluated, its dependents are.
   */
  touch(op: Op, skip = false): void {
    if (this.pulsing) this.enqueue(op)
    else if (!this.touched.includes(op)) this.touched.push(op)
    if (skip) op.skip(true)
  }

  /** vega `_enqueue`: queued if it has no stamp for this run yet, or when `force`d. */
  private enqueue(op: Op, force = false): void {
    const q = op.stamp < this.clock
    if (q) op.stamp = this.clock
    if (q || force) {
      op.qrank = op.rank
      this.heap.push(op)
    }
  }

  /** vega `runAfter(callback, true, priority)`: run once the current propagation is over, highest priority first. */
  runAfter(callback: () => void, priority = 0): void {
    this.postrun.push({ priority, callback })
  }

  /**
   * vega `evaluate`: a new stamp; the touched operators, and what they pulse, are evaluated in rank order, each at most once;
   * then the callbacks queued by `runAfter`. `prerun` is invoked first (the event handlers of a delivery). An error in an
   * operator abandons the rest of the run and its callbacks.
   */
  evaluate(prerun?: () => void): void {
    if (this.pulsing) {
      this.hooks.error(new Error('Dataflow already running. Use runAsync() to chain invocations.'))
      return
    }
    if (prerun) {
      try { prerun() } catch (e) { this.hooks.error(e) }
    }
    if (!this.touched.length) return
    const stamp = ++this.clock
    this.pulsing = true
    const touched = this.touched
    this.touched = []
    for (const op of touched) this.enqueue(op, true)
    let error: unknown
    let failed = false
    try {
      while (this.heap.size() > 0) {
        const op = this.heap.pop()
        // re-queue if the rank changed
        if (op.rank !== op.qrank) {
          this.enqueue(op, true)
          continue
        }
        const next = op.run()
        if (next !== STOP) for (const t of [...op.targets]) this.enqueue(t)
      }
    } catch (e) {
      this.heap.clear()
      error = e
      failed = true
    }
    void stamp
    this.pulsing = false
    if (failed) {
      this.postrun = []
      this.hooks.error(error)
    }
    if (this.postrun.length) {
      const pr = this.postrun.sort((a, b) => b.priority - a.priority)
      this.postrun = []
      for (const { callback } of pr) {
        try { callback() } catch (e) { this.hooks.error(e) }
      }
    }
  }
}
