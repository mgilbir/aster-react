/**
 * How a change of a signal spreads, for the event-driven signals of `signals.ts`.
 *
 * The signals of a view and the datasets they read form a graph: a node for each signal that has an update expression, each
 * dataset, each `{signal}` or expression an `on` entry follows, and each `on` entry; an edge from a node to the nodes that read
 * it (`targets`). An event is one propagation: its handlers assign signals and `touch` them, then the touched nodes, and the
 * nodes they reach, run in order of `order`. What the signals hold afterwards is a consequence of three rules, and the order:
 *
 * - a node runs at most once per propagation (`stamp` is the propagation that last queued it), however many of its sources
 *   changed, and a node that has run is not queued again;
 * - `run` answers `false` when its value is what it was, and its targets are then not queued (a node with `forced` set passes
 *   the change on regardless);
 * - a node a handler assigned (`touch(node, true)`) does not run its own update in the next propagation, but its targets do;
 * - nodes run in `order`: where the graph is built a node follows its sources, and otherwise they are in the order they were
 *   made. Two independent signals run in that order, and a handler reading the store sees the one run before it changed
 *   and the other not: the order is part of the behaviour. Nodes of equal order (the handlers of one source) run in the order
 *   they were queued.
 *
 * A cycle through streams settles the way this order and these rules do, not as a fixed point would. Nothing here knows about
 * DOM events, the DOM or React; what a node evaluates, and where its value lives, is the host's.
 */

export interface SignalNode {
  readonly name: string
  /** Position in the order of evaluation. */
  order: number
  /** The propagation (`Propagation.clock`) that last queued this node. */
  stamp: number
  /** The nodes that read this one, in the order they were added. */
  readonly targets: SignalNode[]
  /** Evaluate: `false` when the value is as it was (nothing is queued after it). Absent: the node only passes the change on. */
  run?: () => boolean | void
  /** The next propagation passes through this node without running it. */
  skip: boolean
  /** The change is passed on even when `run` says the value is as it was. */
  forced: boolean
}

export const node = (name: string, run?: () => boolean | void): SignalNode => ({ name, order: -1, stamp: -1, targets: [], run, skip: false, forced: false })

/** `target` reads `source`. */
export function follow(source: SignalNode, target: SignalNode): void {
  if (!source.targets.includes(target)) source.targets.push(target)
}

/** A bound on the walk below, for a cycle that does not come back to the node being placed. */
const ORDER_LIMIT = 1_000_000

export class Propagation {
  /** The number of the current (or last) propagation; the first is 1. */
  clock = 0
  private made = 0
  /** The nodes waiting, the next to run last. */
  private readonly queue: SignalNode[] = []
  private touched: SignalNode[] = []
  private running = false
  private after: Array<{ priority: number; callback: () => void }> = []

  /** `onError`: an error raised by a node (the rest of that propagation is abandoned) or by a handler. */
  constructor(private readonly onError: (e: unknown) => void) {}

  /** Give `n` the next place in the order. */
  add(n: SignalNode): SignalNode {
    n.order = ++this.made
    return n
  }

  /**
   * `target` reads `sources`: when one of them comes after it, it and everything downstream of it are placed after all that is
   * placed. Throws on a cycle that comes back to `target`.
   */
  connect(target: SignalNode, sources: readonly SignalNode[]): void {
    if (!sources.some((s) => target.order < s.order)) return
    const pending = [target]
    for (let steps = 0; pending.length; ++steps) {
      if (steps > ORDER_LIMIT) throw new Error('Cycle detected in dataflow graph.')
      const n = pending.pop()!
      this.add(n)
      for (let i = n.targets.length; --i >= 0;) {
        pending.push(n.targets[i]!)
        if (n.targets[i] === target) throw new Error('Cycle detected in dataflow graph.')
      }
    }
  }

  /**
   * Mark `n` changed. Outside a propagation it is run by the next; inside one, if it has not run in it. `skip`: its own update
   * is not run, its targets are.
   */
  touch(n: SignalNode, skip = false): void {
    if (this.running) this.enqueue(n)
    else if (!this.touched.includes(n)) this.touched.push(n)
    if (skip) n.skip = true
  }

  /** Run `callback` once the current propagation is over, highest priority first. */
  runAfter(callback: () => void, priority = 0): void {
    this.after.push({ priority, callback })
  }

  /**
   * One propagation: `handlers` first (they assign and `touch`), then the touched nodes and what they reach, each node at most
   * once, then the callbacks of `runAfter`. An error in a node abandons the rest of the propagation and its callbacks.
   */
  evaluate(handlers?: () => void): void {
    if (this.running) {
      this.onError(new Error('Dataflow already running. Use runAsync() to chain invocations.'))
      return
    }
    if (handlers) {
      try { handlers() } catch (e) { this.onError(e) }
    }
    if (!this.touched.length) return
    ++this.clock
    this.running = true
    const touched = this.touched
    this.touched = []
    for (const n of touched) this.enqueue(n)
    let failed = false
    try {
      while (this.queue.length) {
        const n = this.queue.pop()!
        if (n.skip) n.skip = false
        else if (n.run?.() === false) continue
        for (const t of n.targets) this.enqueue(t)
      }
    } catch (e) {
      this.queue.length = 0
      failed = true
      this.running = false
      this.after = []
      this.onError(e)
    }
    this.running = false
    if (failed || !this.after.length) return
    const callbacks = this.after.sort((a, b) => b.priority - a.priority)
    this.after = []
    for (const { callback } of callbacks) {
      try { callback() } catch (e) { this.onError(e) }
    }
  }

  /** Queue `n` if it has not been queued in this propagation: the queue is kept with the next to run last, equals in the order they came. */
  private enqueue(n: SignalNode): void {
    if (n.stamp >= this.clock) return
    n.stamp = this.clock
    const q = this.queue
    let at = q.length
    while (at > 0 && q[at - 1]!.order <= n.order) at--
    q.splice(at, 0, n)
  }
}
