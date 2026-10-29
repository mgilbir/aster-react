/**
 * The `force` transform: a physical simulation that moves the rows (the nodes) under center, collision, many-body, link
 * and x / y forces, stepped by hand (no timer). Loaded by the transforms addon.
 *
 * What the numbers depend on, and so what is fixed bit for bit:
 *  - the order of the float operations in integrating a step, in each force, and in the alpha cool-down;
 *  - the quadtree's shape and visiting order (see quadtree.ts): the Barnes-Hut sums follow it;
 *  - the draws of the shared random source, one per coincident coordinate, in the order the forces meet them;
 *  - the placement of a node that has no position (a phyllotaxis spiral by its index).
 * Everything else here (the force objects, how the parameters reach them) is free.
 */
import { error, hasOwnProperty } from './util.js'
import { fieldOf } from './transform-agg.js'
import type { Row, TransformContext } from './transform.js'
import { compileExprTransform } from './transform.js'
import { meterTick } from './limits.js'
import { layoutRandom } from './layout-random.js'
import { buildQuadTree, NO_CELL } from './quadtree.js'

type Node = Row & { index?: number; x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null }
type Random = () => number
/** A per-node (or per-link) number: a constant, or computed from the item. */
type Measure<T> = (item: T, i: number, all: T[]) => number

interface Link { source: Node | unknown; target: Node | unknown; index?: number; [k: string]: unknown }

/** One force of the simulation: bound to the nodes once, then applied once per tick. */
interface Force {
  bind(nodes: Node[], random: Random): void
  apply(alpha: number): void
}

const constant = (value: number): (() => number) => () => value
const measure = <T>(v: unknown): Measure<T> => (typeof v === 'function' ? (v as Measure<T>) : constant(+(v as number)))
/** A nudge off an exactly coincident coordinate, so that a direction exists. */
const jiggle = (random: Random): number => (random() - 0.5) * 1e-6

// -- center ---------------------------------------------------------------------------------------------------------

/** Translates every node so that their mean sits on (x, y). */
class CenterForce implements Force {
  private nodes: Node[] = []
  constructor(private readonly x: number, private readonly y: number) {}

  bind(nodes: Node[]): void { this.nodes = nodes }

  apply(): void {
    const nodes = this.nodes
    const n = nodes.length
    let sx = 0
    let sy = 0
    for (let i = 0; i < n; ++i) { sx += nodes[i]!.x; sy += nodes[i]!.y }
    sx = sx / n - this.x
    sy = sy / n - this.y
    for (let i = 0; i < n; ++i) { nodes[i]!.x -= sx; nodes[i]!.y -= sy }
  }
}

// -- collide --------------------------------------------------------------------------------------------------------

/** Pushes overlapping discs apart; a node's radius is `radius`, and each pass looks at the positions one step ahead. */
class CollideForce implements Force {
  private nodes: Node[] = []
  private random: Random = Math.random
  private radii = new Float64Array(0)
  private cellRadius = new Float64Array(0)
  constructor(
    private readonly radius: Measure<Node>,
    private readonly strength: number,
    private readonly iterations: number,
  ) {}

  bind(nodes: Node[], random: Random): void {
    this.nodes = nodes
    this.random = random
    this.radii = new Float64Array(nodes.length)
    for (let i = 0; i < nodes.length; ++i) this.radii[nodes[i]!.index!] = +this.radius(nodes[i]!, i, nodes)
  }

  apply(): void {
    const { nodes, radii, random, strength } = this
    const n = nodes.length
    for (let k = 0; k < this.iterations; ++k) {
      const tree = buildQuadTree(nodes, (d) => d.x + d.vx, (d) => d.y + d.vy)
      const { body, quad } = tree
      if (this.cellRadius.length < tree.size) this.cellRadius = new Float64Array(tree.size)
      const cellRadius = this.cellRadius
      // a branch's radius is its largest; a leaf's is its head body's (bodies chained behind it are not looked at)
      tree.walkUp((cell) => {
        if (body[cell]! >= 0) { cellRadius[cell] = radii[nodes[body[cell]!]!.index!]!; return }
        let largest = 0
        for (let q = 0; q < 4; ++q) {
          const c = quad[cell * 4 + q]!
          if (c !== NO_CELL && cellRadius[c]! > largest) largest = cellRadius[c]!
        }
        cellRadius[cell] = largest
      })
      // the body whose collisions are being looked for, and its radius and next position
      let node = nodes[0]!
      let ri = 0
      let ri2 = 0
      let xi = 0
      let yi = 0
      const visit = (cell: number, x0: number, y0: number, x1: number, y1: number): boolean | void => {
        const rj = cellRadius[cell]!
        let r = ri + rj
        if (body[cell]! >= 0) {
          const other = nodes[body[cell]!]!
          if (other.index! > node.index!) {
            let x = xi - other.x - other.vx
            let y = yi - other.y - other.vy
            let l = x * x + y * y
            if (l < r * r) {
              if (x === 0) { x = jiggle(random); l += x * x }
              if (y === 0) { y = jiggle(random); l += y * y }
              l = (r - (l = Math.sqrt(l))) / l * strength
              let rj2 = rj
              node.vx += (x *= l) * (r = (rj2 *= rj2) / (ri2 + rj2))
              node.vy += (y *= l) * r
              other.vx -= x * (r = 1 - r)
              other.vy -= y * r
            }
          }
          return
        }
        return x0 > xi + r || x1 < xi - r || y0 > yi + r || y1 < yi - r
      }
      for (let i = 0; i < n; ++i) {
        node = nodes[i]!
        ri = radii[node.index!]!
        ri2 = ri * ri
        xi = node.x + node.vx
        yi = node.y + node.vy
        tree.walk(visit)
      }
      meterTick('force', n)
    }
  }
}

// -- many-body ------------------------------------------------------------------------------------------------------

/** Attracts or repels every node by every other, a far group of nodes standing in as its centre of mass (Barnes-Hut). */
class ManyBodyForce implements Force {
  private nodes: Node[] = []
  private random: Random = Math.random
  private strengths = new Float64Array(0)
  private mass = new Float64Array(0)
  private cx = new Float64Array(0)
  private cy = new Float64Array(0)
  constructor(
    private readonly strength: Measure<Node>,
    private readonly distanceMin2: number,
    private readonly distanceMax2: number,
    private readonly theta2: number,
  ) {}

  bind(nodes: Node[], random: Random): void {
    this.nodes = nodes
    this.random = random
    this.strengths = new Float64Array(nodes.length)
    for (let i = 0; i < nodes.length; ++i) this.strengths[nodes[i]!.index!] = +this.strength(nodes[i]!, i, nodes)
  }

  apply(alpha: number): void {
    const { nodes, strengths, random, distanceMin2, distanceMax2, theta2 } = this
    const n = nodes.length
    const tree = buildQuadTree(nodes, (d) => d.x, (d) => d.y)
    const { body, chain, quad } = tree
    if (this.mass.length < tree.size) {
      this.mass = new Float64Array(tree.size)
      this.cx = new Float64Array(tree.size)
      this.cy = new Float64Array(tree.size)
    }
    const { mass, cx, cy } = this
    // a cell's mass is the sum of the strengths below it, placed at the strength-magnitude weighted mean of its parts
    tree.walkUp((cell) => {
      let sum = 0
      if (body[cell]! < 0) {
        let weight = 0
        let x = 0
        let y = 0
        for (let k = 0; k < 4; ++k) {
          const q = quad[cell * 4 + k]!
          let c: number
          if (q !== NO_CELL && (c = Math.abs(mass[q]!))) { sum += mass[q]!; weight += c; x += c * cx[q]!; y += c * cy[q]! }
        }
        cx[cell] = x / weight
        cy[cell] = y / weight
      } else {
        const head = nodes[body[cell]!]!
        cx[cell] = head.x
        cy[cell] = head.y
        let leaf = cell
        do sum += strengths[nodes[body[leaf]!]!.index!]!
        while ((leaf = chain[leaf]!) !== NO_CELL)
      }
      mass[cell] = sum
    })
    let node = nodes[0]!
    const visit = (cell: number, x0: number, _y0: number, x1: number): boolean | void => {
      const m = mass[cell]!
      if (!m) return true
      let x = cx[cell]! - node.x
      let y = cy[cell]! - node.y
      let w = x1 - x0
      let l = x * x + y * y
      // far enough: the whole cell acts as one body
      if (w * w / theta2 < l) {
        if (l < distanceMax2) {
          if (x === 0) { x = jiggle(random); l += x * x }
          if (y === 0) { y = jiggle(random); l += y * y }
          if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l)
          node.vx += x * m * alpha / l
          node.vy += y * m * alpha / l
        }
        return true
      }
      if (body[cell]! < 0 || l >= distanceMax2) return
      // a leaf close by: each body chained there acts on the node from the leaf's head position
      if (nodes[body[cell]!] !== node || chain[cell] !== NO_CELL) {
        if (x === 0) { x = jiggle(random); l += x * x }
        if (y === 0) { y = jiggle(random); l += y * y }
        if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l)
      }
      let leaf = cell
      do if (nodes[body[leaf]!] !== node) {
        w = strengths[nodes[body[leaf]!]!.index!]! * alpha / l
        node.vx += x * w
        node.vy += y * w
      } while ((leaf = chain[leaf]!) !== NO_CELL)
    }
    for (let i = 0; i < n; ++i) {
      node = nodes[i]!
      tree.walk(visit)
    }
    meterTick('force', n)
  }
}

// -- link -----------------------------------------------------------------------------------------------------------

/** Springs between linked nodes; the links' ends are looked up (and replaced by the nodes) when the force is bound. */
class LinkForce implements Force {
  private nodes: Node[] = []
  private random: Random = Math.random
  private distances = new Float64Array(0)
  private strengths = new Float64Array(0)
  private bias = new Float64Array(0)
  constructor(
    private readonly links: Link[],
    private readonly id: Measure<Node>,
    private readonly distance: Measure<Link>,
    private readonly strength: Measure<Link> | null,
    private readonly iterations: number,
  ) {}

  bind(nodes: Node[], random: Random): void {
    this.nodes = nodes
    this.random = random
    const links = this.links
    const m = links.length
    const byId = new Map<unknown, Node>(nodes.map((d, i) => [this.id(d, i, nodes), d] as const))
    // how many links meet at each node
    const degree = new Float64Array(nodes.length)
    for (let i = 0; i < m; ++i) {
      const link = links[i]!
      link.index = i
      if (typeof link.source !== 'object') link.source = findNode(byId, link.source)
      if (typeof link.target !== 'object') link.target = findNode(byId, link.target)
      degree[(link.source as Node).index!]! += 1
      degree[(link.target as Node).index!]! += 1
    }
    // the share of a spring's correction that the source end takes: the more links a node has, the less it moves
    this.bias = new Float64Array(m)
    for (let i = 0; i < m; ++i) {
      const s = degree[(links[i]!.source as Node).index!]!
      const t = degree[(links[i]!.target as Node).index!]!
      this.bias[i] = s / (s + t)
    }
    const strength: Measure<Link> = this.strength ?? ((link) => 1 / Math.min(degree[(link.source as Node).index!]!, degree[(link.target as Node).index!]!))
    this.strengths = new Float64Array(m)
    this.distances = new Float64Array(m)
    for (let i = 0; i < m; ++i) this.strengths[i] = +strength(links[i]!, i, links)
    for (let i = 0; i < m; ++i) this.distances[i] = +this.distance(links[i]!, i, links)
  }

  apply(alpha: number): void {
    const { links, random, distances, strengths, bias } = this
    const n = links.length
    for (let k = 0; k < this.iterations; ++k) {
      for (let i = 0; i < n; ++i) {
        const link = links[i]!
        const source = link.source as Node
        const target = link.target as Node
        let x = target.x + target.vx - source.x - source.vx || jiggle(random)
        let y = target.y + target.vy - source.y - source.vy || jiggle(random)
        let l = Math.sqrt(x * x + y * y)
        l = (l - distances[i]!) / l * alpha * strengths[i]!
        x *= l
        y *= l
        let b = bias[i]!
        target.vx -= x * b
        target.vy -= y * b
        source.vx += x * (b = 1 - b)
        source.vy += y * b
      }
    }
    meterTick('force', n)
  }
}

function findNode(byId: Map<unknown, Node>, id: unknown): Node {
  const node = byId.get(id)
  if (!node) throw new Error('node not found: ' + String(id))
  return node
}

// -- x / y ----------------------------------------------------------------------------------------------------------

/** Pulls every node's coordinate toward a target value; a node whose target is not a number is not pulled. */
class AxisForce implements Force {
  private nodes: Node[] = []
  private strengths = new Float64Array(0)
  private targets = new Float64Array(0)
  constructor(
    private readonly axis: 'x' | 'y',
    private readonly target: Measure<Node> | null,
    private readonly strength: number,
  ) {}

  bind(nodes: Node[]): void {
    this.nodes = nodes
    const n = nodes.length
    this.strengths = new Float64Array(n)
    this.targets = new Float64Array(n)
    for (let i = 0; i < n; ++i) {
      this.targets[i] = this.target ? +this.target(nodes[i]!, i, nodes) : 0
      this.strengths[i] = isNaN(this.targets[i]!) ? 0 : this.strength
    }
  }

  apply(alpha: number): void {
    const { nodes, targets, strengths, axis } = this
    const v = axis === 'x' ? 'vx' : 'vy'
    for (let i = 0, n = nodes.length; i < n; ++i) {
      const node = nodes[i]!
      node[v] += (targets[i]! - node[axis]) * strengths[i]! * alpha
    }
  }
}

// -- the simulation -------------------------------------------------------------------------------------------------

const INITIAL_RADIUS = 10
const INITIAL_ANGLE = Math.PI * (3 - Math.sqrt(5))

class Simulation {
  alpha = 1
  alphaMin = 0.001
  alphaDecay = 1 - Math.pow(0.001, 1 / 300)
  alphaTarget = 0
  /** The share of a velocity kept each step (one minus the user-facing decay). */
  retain = 0.6
  private readonly random = layoutRandom()

  private readonly forces: Force[] = []

  constructor(private readonly nodes: Node[]) {
    for (let i = 0, n = nodes.length; i < n; ++i) {
      const node = nodes[i]!
      node.index = i
      if (node.fx != null) node.x = node.fx
      if (node.fy != null) node.y = node.fy
      // (global isNaN: a missing or non-numeric position is placed too)
      if (isNaN(node.x) || isNaN(node.y)) {
        const radius = INITIAL_RADIUS * Math.sqrt(0.5 + i)
        const angle = i * INITIAL_ANGLE
        node.x = radius * Math.cos(angle)
        node.y = radius * Math.sin(angle)
      }
      if (isNaN(node.vx) || isNaN(node.vy)) node.vx = node.vy = 0
    }
  }

  add(force: Force): void {
    force.bind(this.nodes, this.random)
    this.forces.push(force)
  }

  tick(): void {
    const { nodes, forces, retain } = this
    const n = nodes.length
    this.alpha += (this.alphaTarget - this.alpha) * this.alphaDecay
    for (const force of forces) force.apply(this.alpha)
    for (let i = 0; i < n; ++i) {
      const node = nodes[i]!
      if (node.fx == null) node.x += node.vx *= retain
      else { node.x = node.fx; node.vx = 0 }
      if (node.fy == null) node.y += node.vy *= retain
      else { node.y = node.fy; node.vy = 0 }
    }
  }
}

// -- the transform --------------------------------------------------------------------------------------------------

/**
 * The parameters each force reads. Anything else a force spec carries is ignored: vega reads a force's declared
 * parameters only.
 */
const FORCE_PARAMS: Record<string, readonly string[]> = {
  center: ['x', 'y'],
  collide: ['radius', 'strength', 'iterations'],
  nbody: ['strength', 'theta', 'distanceMin', 'distanceMax'],
  link: ['links', 'id', 'distance', 'strength', 'iterations'],
  x: ['strength', 'x'],
  y: ['strength', 'y'],
}

/** A parameter given as an expression turns into a function of the node (or link). */
function numberParam(v: unknown, ctx: TransformContext): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { expr?: unknown }).expr === 'string') {
    const f = compileExprTransform((v as { expr: string }).expr, ctx)
    return (d: unknown) => f(d as Row)
  }
  return v
}

function buildForce(spec: Record<string, unknown>, ctx: TransformContext): Force {
  const name = spec.force as string
  if (!hasOwnProperty(FORCE_PARAMS, name)) error('Unrecognized force: ' + name)
  // (only the parameters the spec gives are read: vega-parser does not apply a force's declared defaults, so a collide
  // force has strength 1, not the 0.7 its definition lists)
  const given = (p: string): unknown => (FORCE_PARAMS[name]!.includes(p) ? spec[p] : undefined)
  const square = (p: string, fallback: number): number => { const v = given(p) as number | undefined; return v === undefined ? fallback : v * v }
  const num = (p: string, fallback: number): number => { const v = given(p); return v === undefined ? fallback : +(numberParam(v, ctx) as number) }
  const fn = <T>(p: string): Measure<T> | null => { const v = given(p); return v === undefined ? null : measure<T>(numberParam(v, ctx)) }
  switch (name) {
    case 'center':
      return new CenterForce(num('x', 0), num('y', 0))
    case 'collide':
      return new CollideForce(fn<Node>('radius') ?? constant(1), num('strength', 1), num('iterations', 1))
    case 'nbody': {
      return new ManyBodyForce(fn<Node>('strength') ?? constant(-30), square('distanceMin', 1), square('distanceMax', Infinity), square('theta', 0.81))
    }
    case 'link': {
      // `links` names a dataset: its rows are the links (their ends are replaced by the nodes)
      const links = given('links')
      const id = given('id')
      const acc = id === undefined ? null : fieldOf(id)
      return new LinkForce(
        (typeof links === 'string' ? ctx.datasets?.(links) ?? [] : links === undefined ? [] : links) as Link[],
        acc ? (d) => acc(d) as number : (d) => d.index as number,
        fn<Link>('distance') ?? constant(30),
        fn<Link>('strength'),
        num('iterations', 1),
      )
    }
    default: {
      const axis = name as 'x' | 'y'
      const target = given(axis)
      // (a field: a name read off the node)
      const fieldName = typeof target === 'string' ? target : (target as { field?: unknown } | null)?.field
      const acc = fieldName === undefined ? null : fieldOf(fieldName)
      return new AxisForce(axis, acc ? (d) => +(acc(d) as number) : target === undefined ? null : measure<Node>(target), num('strength', 0.1))
    }
  }
}

/**
 * The `force` transform: a simulation over the rows, which gain `x`, `y`, `vx`, `vy` and `index`. A static layout runs
 * `iterations` ticks to the cool-down; otherwise vega runs one tick when the dataflow starts (the animation that follows
 * is its timer's). The rows are changed in place when the caller owns them (`inPlace`: the encoded items of a mark), as
 * vega's tuples are.
 */
export function forceRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext & { dynamicParams?: ReadonlySet<string> }): Row[] {
  const nodes = (ctx.inPlace ? rows : rows.map((r) => ({ ...r }))) as Node[]
  const specs = ([] as Array<Record<string, unknown>>).concat((t.forces as Array<Record<string, unknown>> | undefined) ?? [])
  const sim = new Simulation(nodes)
  let iters = (t.iterations as number | undefined) || 300
  // vega applies alpha / alphaMin / alphaTarget / velocityDecay to the simulation only for a parameter its dataflow
  // reports as modified, which neither a literal nor a reference to a declared signal is: those are read where the
  // transform reads them directly (`alpha` below) and are otherwise the simulation's own defaults; a `{signal}` that is
  // an expression (`dynamicParams` names those) is applied
  const dyn = ctx.dynamicParams
  if (dyn?.has('alphaMin')) sim.alphaMin = +(t.alphaMin as number)
  if (dyn?.has('alphaTarget')) sim.alphaTarget = +(t.alphaTarget as number)
  if (dyn?.has('velocityDecay')) sim.retain = 1 - +(t.velocityDecay as number)
  if (dyn?.has('alpha')) sim.alpha = +(t.alpha as number)
  // (each force is built and bound in turn: a failure in a later spec comes after the earlier forces have met the nodes)
  for (const spec of specs) sim.add(buildForce(spec, ctx))
  if (!t.static) sim.tick() // ensure we run on init
  sim.alpha = Math.max(sim.alpha, (t.alpha as number) || 1)
  sim.alphaDecay = 1 - Math.pow(sim.alphaMin, 1 / iters)
  if (t.static) while (--iters >= 0) sim.tick()
  return nodes as Row[]
}
