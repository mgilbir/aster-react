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

/**
 * Propagations one delivery may run before it is abandoned (a `modify` whose dataset feeds the signal that modifies it pulses
 * again after every run): far more than any chart needs, and what a run-away chain reaches in a fraction of a second.
 */
export const MAX_PROPAGATIONS = 1000
/** What `propagate` answers for a propagation the delivery's budget refused. */
const ABANDONED: Array<() => void> = []

export class Propagation {
  /** The number of the current (or last) propagation; the first is 1. */
  clock = 0
  private made = 0
  /** The nodes waiting, the next to run last. */
  private readonly queue: SignalNode[] = []
  private touched: SignalNode[] = []
  private running = false
  private after: Array<{ priority: number; callback: () => void }> = []

  /** Propagations run since the outermost `evaluate` began (see MAX_PROPAGATIONS). */
  private runs = 0
  /** Inside the outermost `evaluate`, running callbacks: a nested `evaluate` is run after the callback that asked, not inside it. */
  private draining = false
  private requested = false

  /**
   * `onError`: an error raised by a node (the rest of that propagation is abandoned) or by a handler. `beforeRun`: called before
   * every propagation of a delivery with how many it has run (the delivery's budget: its clock), and may throw to end it.
   */
  constructor(private readonly onError: (e: unknown) => void, private readonly beforeRun: (runs: number) => void = () => {}) {}

  /** Give `n` the next place in the order. */
  add(n: SignalNode): SignalNode {
    n.order = ++this.made
    return n
  }

  /**
   * `target` reads `sources`: when one of them comes after it, it and everything downstream of it are placed after all that is
   * placed. Throws on a cycle that comes back to `target`.
   *
   * vega-dataflow's `rerank` walks every PATH from `target` (a stack, no visited set), giving each node it pops the next rank, so
   * a node reached by several paths ends at the rank of its last visit: exponential in a lattice of diamonds. The same final order
   * is that of the last visit in a pre-order walk of the paths, which is the reverse post-order of a depth-first walk that visits
   * each node once, children last-to-first: computed here in time linear in what is downstream (the property test compares the
   * two on generated graphs). A cycle is a path that comes back to `target`.
   */
  connect(target: SignalNode, sources: readonly SignalNode[]): void {
    if (!sources.some((s) => target.order < s.order)) return
    const seen = new Set<SignalNode>([target])
    const post: SignalNode[] = []
    const stack: Array<[SignalNode, number]> = [[target, target.targets.length]]
    while (stack.length) {
      const top = stack[stack.length - 1]!
      if (top[1] === 0) { stack.pop(); post.push(top[0]); continue }
      const child = top[0].targets[--top[1]]!
      if (child === target) throw new Error('Cycle detected in dataflow graph.')
      if (seen.has(child)) continue
      seen.add(child)
      stack.push([child, child.targets.length])
    }
    for (let i = post.length; --i >= 0;) this.add(post[i]!)
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
    if (this.draining) {
      // (a callback asks for another propagation, as vega's modify does from its `runAfter`: it runs once the callback returns,
      // with its own callbacks, before the next callback of the propagation that queued this one, as vega's awaited `run()`
      // does; a chain of them is a loop here, not a stack)
      if (handlers) {
        try { handlers() } catch (e) { this.onError(e) }
      }
      this.requested = true
      return
    }
    this.runs = 0
    this.draining = true
    try {
      const frames: Array<Array<() => void>> = [this.propagate(handlers)]
      while (frames.length) {
        const frame = frames[frames.length - 1]!
        const callback = frame.shift()
        if (callback === undefined) { frames.pop(); continue }
        this.requested = false
        try { callback() } catch (e) { this.onError(e) }
        if (!this.requested) continue
        this.requested = false
        const next = this.propagate()
        // (a delivery past its budget ends: nothing it queued runs)
        if (next === ABANDONED) frames.length = 0
        else frames.push(next)
      }
    } finally {
      this.draining = false
      this.requested = false
    }
  }

  /** One propagation (after `handlers`): its callbacks, highest priority first; ABANDONED when the delivery's budget ended it. */
  private propagate(handlers?: () => void): Array<() => void> {
    if (handlers) {
      try { handlers() } catch (e) { this.onError(e) }
    }
    if (!this.touched.length) return []
    try {
      if (++this.runs > MAX_PROPAGATIONS) throw new Error(`a delivery ran more than ${MAX_PROPAGATIONS} propagations (a modify that feeds itself?)`)
      this.beforeRun(this.runs)
    } catch (e) {
      this.touched = []
      this.after = []
      this.onError(e)
      return ABANDONED
    }
    ++this.clock
    this.running = true
    const touched = this.touched
    this.touched = []
    for (const n of touched) this.enqueue(n)
    try {
      while (this.queue.length) {
        const n = this.queue.pop()!
        if (n.skip) n.skip = false
        else if (n.run?.() === false) continue
        for (const t of n.targets) this.enqueue(t)
      }
    } catch (e) {
      this.queue.length = 0
      this.running = false
      this.after = []
      this.onError(e)
      return []
    }
    this.running = false
    const callbacks = this.after.sort((a, b) => b.priority - a.priority).map((a) => a.callback)
    this.after = []
    return callbacks
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
