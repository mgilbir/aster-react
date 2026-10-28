/**
 * The vega `force` transform (vega-force Force) and the d3-force 3.0.0 / d3-quadtree 3.0.1 pieces it drives, ported
 * operation for operation: `forceSimulation` (stepped by hand: no timer), `forceCenter`, `forceCollide`,
 * `forceManyBody` (`nbody`), `forceLink`, `forceX`, `forceY`, the Lehmer-style `lcg` the simulation draws its jiggle
 * from, and the quadtree the collide and many-body forces query. Loaded by the transforms addon.
 */
import { error, hasOwnProperty } from './util.js'
import { fieldOf } from './transform-agg.js'
import type { Row, TransformContext } from './transform.js'
import { compileExprTransform } from './transform.js'
import { meterTick } from './limits.js'

type Node = Row & { index?: number; x: number; y: number; vx: number; vy: number; fx?: number | null; fy?: number | null }
type Num<T> = number | ((d: T, i: number, nodes: Node[]) => number)

// --- d3-quadtree ---------------------------------------------------------------------------------------------------

interface Leaf { data: Node; next?: Leaf }
type QuadNode = (QuadNode | undefined)[] & { data?: Node; next?: Leaf; r?: number; value?: number; x?: number; y?: number }

class Quadtree {
  _x0 = NaN
  _y0 = NaN
  _x1 = NaN
  _y1 = NaN
  _root: QuadNode | undefined
  constructor(readonly _x: (d: Node) => number, readonly _y: (d: Node) => number) {}

  cover(xIn: number, yIn: number): this {
    const x = +xIn
    const y = +yIn
    if (isNaN(x) || isNaN(y)) return this // ignore invalid points
    let x0 = this._x0
    let y0 = this._y0
    let x1 = this._x1
    let y1 = this._y1
    // If the quadtree has no extent, initialize them. Integer extent are necessary so that if we later double the
    // extent, the existing quadrant boundaries don't change due to floating point error!
    if (isNaN(x0)) {
      x1 = (x0 = Math.floor(x)) + 1
      y1 = (y0 = Math.floor(y)) + 1
    } else {
      // Otherwise, double repeatedly to cover.
      let z = x1 - x0 || 1
      let node = this._root
      while (x0 > x || x >= x1 || y0 > y || y >= y1) {
        const i = ((y < y0) ? 1 : 0) << 1 | ((x < x0) ? 1 : 0)
        const parent = new Array(4) as QuadNode
        parent[i] = node
        node = parent
        z *= 2
        switch (i) {
          case 0: x1 = x0 + z; y1 = y0 + z; break
          case 1: x0 = x1 - z; y1 = y0 + z; break
          case 2: x1 = x0 + z; y0 = y1 - z; break
          case 3: x0 = x1 - z; y0 = y1 - z; break
        }
      }
      if (this._root && this._root.length) this._root = node
    }
    this._x0 = x0
    this._y0 = y0
    this._x1 = x1
    this._y1 = y1
    return this
  }

  private addPoint(x: number, y: number, d: Node): void {
    if (isNaN(x) || isNaN(y)) return // ignore invalid points
    let parent: QuadNode | undefined
    let node = this._root
    const leaf: Leaf = { data: d }
    let x0 = this._x0
    let y0 = this._y0
    let x1 = this._x1
    let y1 = this._y1
    let xm: number
    let ym: number
    let right: boolean
    let bottom: boolean
    let i = 0
    let j: number
    // If the tree is empty, initialize the root as a leaf.
    if (!node) { this._root = leaf as unknown as QuadNode; return }
    // Find the existing leaf for the new point, or add it.
    while (node.length) {
      if (right = x >= (xm = (x0 + x1) / 2)) x0 = xm; else x1 = xm
      if (bottom = y >= (ym = (y0 + y1) / 2)) y0 = ym; else y1 = ym
      parent = node
      i = (bottom ? 1 : 0) << 1 | (right ? 1 : 0)
      if (!(node = node[i])) { parent[i] = leaf as unknown as QuadNode; return }
    }
    // Is the new point is exactly coincident with the existing point?
    const xp = +this._x(node.data!)
    const yp = +this._y(node.data!)
    if (x === xp && y === yp) {
      leaf.next = node as unknown as Leaf
      if (parent) parent[i] = leaf as unknown as QuadNode
      else this._root = leaf as unknown as QuadNode
      return
    }
    // Otherwise, split the leaf node until the old and new point are separated.
    do {
      parent = parent ? parent[i] = new Array(4) as QuadNode : this._root = new Array(4) as QuadNode
      if (right = x >= (xm = (x0 + x1) / 2)) x0 = xm; else x1 = xm
      if (bottom = y >= (ym = (y0 + y1) / 2)) y0 = ym; else y1 = ym
    } while ((i = (bottom ? 1 : 0) << 1 | (right ? 1 : 0)) === (j = ((yp >= ym) ? 1 : 0) << 1 | ((xp >= xm) ? 1 : 0)))
    parent![j] = node
    parent![i] = leaf as unknown as QuadNode
  }

  addAll(data: Node[]): this {
    const n = data.length
    const xz = new Array<number>(n)
    const yz = new Array<number>(n)
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    // Compute the points and their extent.
    for (let i = 0; i < n; ++i) {
      const d = data[i]!
      const x = +this._x(d)
      const y = +this._y(d)
      if (isNaN(x) || isNaN(y)) continue
      xz[i] = x
      yz[i] = y
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    // If there were no (valid) points, abort.
    if (x0 > x1 || y0 > y1) return this
    // Expand the tree to cover the new points, then add them.
    this.cover(x0, y0).cover(x1, y1)
    for (let i = 0; i < n; ++i) this.addPoint(xz[i]!, yz[i]!, data[i]!)
    return this
  }

  /** Depth-first, pre-order; the callback returning true skips the node's children. */
  visit(callback: (node: QuadNode, x0: number, y0: number, x1: number, y1: number) => boolean | void): this {
    const quads: Array<[QuadNode, number, number, number, number]> = []
    if (this._root) quads.push([this._root, this._x0, this._y0, this._x1, this._y1])
    let q: [QuadNode, number, number, number, number] | undefined
    while ((q = quads.pop())) {
      const [node, x0, y0, x1, y1] = q
      if (!callback(node, x0, y0, x1, y1) && node.length) {
        const xm = (x0 + x1) / 2
        const ym = (y0 + y1) / 2
        let child: QuadNode | undefined
        if (child = node[3]) quads.push([child, xm, ym, x1, y1])
        if (child = node[2]) quads.push([child, x0, ym, xm, y1])
        if (child = node[1]) quads.push([child, xm, y0, x1, ym])
        if (child = node[0]) quads.push([child, x0, y0, xm, ym])
      }
    }
    return this
  }

  /** Depth-first, post-order. */
  visitAfter(callback: (node: QuadNode, x0: number, y0: number, x1: number, y1: number) => void): this {
    const quads: Array<[QuadNode, number, number, number, number]> = []
    const next: Array<[QuadNode, number, number, number, number]> = []
    if (this._root) quads.push([this._root, this._x0, this._y0, this._x1, this._y1])
    let q: [QuadNode, number, number, number, number] | undefined
    while ((q = quads.pop())) {
      const node = q[0]
      if (node.length) {
        const [, x0, y0, x1, y1] = q
        const xm = (x0 + x1) / 2
        const ym = (y0 + y1) / 2
        let child: QuadNode | undefined
        if (child = node[0]) quads.push([child, x0, y0, xm, ym])
        if (child = node[1]) quads.push([child, xm, y0, x1, ym])
        if (child = node[2]) quads.push([child, x0, ym, xm, y1])
        if (child = node[3]) quads.push([child, xm, ym, x1, y1])
      }
      next.push(q)
    }
    while ((q = next.pop())) callback(q[0], q[1], q[2], q[3], q[4])
    return this
  }
}

function quadtree(nodes: Node[], x: (d: Node) => number, y: (d: Node) => number): Quadtree {
  return new Quadtree(x, y).addAll(nodes)
}

// --- d3-force ------------------------------------------------------------------------------------------------------

type Random = () => number
interface Force {
  (alpha: number): void
  initialize?(nodes: Node[], random: Random): void
  [param: string]: unknown
}

const constant = <T>(x: T) => (): T => x
const jiggle = (random: Random): number => (random() - 0.5) * 1e-6
const nodeX = (d: Node): number => d.x
const nodeY = (d: Node): number => d.y

/** d3-force lcg: the generator the simulation draws its jiggle from (the same sequence on every run). */
function lcg(): Random {
  let s = 1
  return () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296
}

function forceCenter(xIn?: number, yIn?: number): Force {
  let nodes: Node[]
  let strength = 1
  let x = xIn == null ? 0 : xIn
  let y = yIn == null ? 0 : yIn
  const force = (() => {
    const n = nodes.length
    let sx = 0
    let sy = 0
    for (let i = 0; i < n; ++i) { const node = nodes[i]!; sx += node.x; sy += node.y }
    sx = (sx / n - x) * strength
    sy = (sy / n - y) * strength
    for (let i = 0; i < n; ++i) { const node = nodes[i]!; node.x -= sx; node.y -= sy }
  }) as unknown as Force
  force.initialize = (_) => { nodes = _ }
  force.x = (...a: unknown[]) => (a.length ? (x = +(a[0] as number), force) : x)
  force.y = (...a: unknown[]) => (a.length ? (y = +(a[0] as number), force) : y)
  force.strength = (...a: unknown[]) => (a.length ? (strength = +(a[0] as number), force) : strength)
  return force
}

function forceCollide(radiusIn?: Num<Node>): Force {
  let nodes: Node[] | undefined
  let radii: number[]
  let random: Random
  let strength = 1
  let iterations = 1
  let radius: (d: Node, i: number, nodes: Node[]) => number =
    typeof radiusIn === 'function' ? radiusIn : constant(radiusIn == null ? 1 : +radiusIn)

  const px = (d: Node): number => d.x + d.vx
  const py = (d: Node): number => d.y + d.vy

  const force = (() => {
    const n = nodes!.length
    for (let k = 0; k < iterations; ++k) {
      const tree = quadtree(nodes!, px, py).visitAfter(prepare)
      for (let i = 0; i < n; ++i) {
        const node = nodes![i]!
        const ri = radii[node.index!]!
        const ri2 = ri * ri
        const xi = node.x + node.vx
        const yi = node.y + node.vy
        tree.visit((quad, x0, y0, x1, y1) => {
          const data = quad.data
          const rj = quad.r!
          let r = ri + rj
          if (data) {
            if (data.index! > node.index!) {
              let x = xi - data.x - data.vx
              let y = yi - data.y - data.vy
              let l = x * x + y * y
              if (l < r * r) {
                if (x === 0) { x = jiggle(random); l += x * x }
                if (y === 0) { y = jiggle(random); l += y * y }
                l = (r - (l = Math.sqrt(l))) / l * strength
                let rjj = rj
                node.vx += (x *= l) * (r = (rjj *= rjj) / (ri2 + rjj))
                node.vy += (y *= l) * r
                data.vx -= x * (r = 1 - r)
                data.vy -= y * r
              }
            }
            return
          }
          return x0 > xi + r || x1 < xi - r || y0 > yi + r || y1 < yi - r
        })
      }
      meterTick('force', n)
    }
  }) as unknown as Force

  function prepare(quad: QuadNode): void {
    if (quad.data) { quad.r = radii[quad.data.index!]; return }
    quad.r = 0
    for (let i = 0; i < 4; ++i) {
      const q = quad[i]
      if (q && q.r! > quad.r!) quad.r = q.r
    }
  }

  function initialize(): void {
    if (!nodes) return
    const n = nodes.length
    radii = new Array(n)
    for (let i = 0; i < n; ++i) { const node = nodes[i]!; radii[node.index!] = +radius(node, i, nodes) }
  }

  force.initialize = (_nodes, _random) => { nodes = _nodes; random = _random; initialize() }
  force.iterations = (...a: unknown[]) => (a.length ? (iterations = +(a[0] as number), force) : iterations)
  force.strength = (...a: unknown[]) => (a.length ? (strength = +(a[0] as number), force) : strength)
  force.radius = (...a: unknown[]) => {
    if (!a.length) return radius
    const _ = a[0]
    radius = typeof _ === 'function' ? (_ as typeof radius) : constant(+(_ as number))
    initialize()
    return force
  }
  return force
}

function forceManyBody(): Force {
  let nodes: Node[] | undefined
  let node: Node
  let random: Random
  let alpha: number
  let strength: (d: Node, i: number, nodes: Node[]) => number = constant(-30)
  let strengths: number[]
  let distanceMin2 = 1
  let distanceMax2 = Infinity
  let theta2 = 0.81

  const force = ((_: number) => {
    const n = nodes!.length
    const tree = quadtree(nodes!, nodeX, nodeY).visitAfter(accumulate)
    alpha = _
    for (let i = 0; i < n; ++i) { node = nodes![i]!; tree.visit(apply) }
    meterTick('force', n)
  }) as unknown as Force

  function initialize(): void {
    if (!nodes) return
    const n = nodes.length
    strengths = new Array(n)
    for (let i = 0; i < n; ++i) { const nd = nodes[i]!; strengths[nd.index!] = +strength(nd, i, nodes) }
  }

  function accumulate(quad: QuadNode): void {
    let s = 0
    let q: QuadNode | Leaf | undefined
    let c: number
    let weight = 0
    let x: number
    let y: number
    // For internal nodes, accumulate forces from child quadrants.
    if (quad.length) {
      x = y = 0
      for (let i = 0; i < 4; ++i) {
        const qq = quad[i]
        if (qq && (c = Math.abs(qq.value!))) {
          s += qq.value!; weight += c; x += c * qq.x!; y += c * qq.y!
        }
      }
      quad.x = x / weight
      quad.y = y / weight
    } else {
      // For leaf nodes, accumulate forces from coincident quadrants.
      q = quad as unknown as Leaf
      ;(quad as { x?: number }).x = (q as Leaf).data.x
      ;(quad as { y?: number }).y = (q as Leaf).data.y
      do s += strengths[(q as Leaf).data.index!]!
      while (q = (q as Leaf).next)
    }
    quad.value = s
  }

  function apply(quadIn: QuadNode, x1: number, _y: number, x2: number): boolean | void {
    if (!quadIn.value) return true
    let quad: QuadNode | Leaf | undefined = quadIn
    let x = quadIn.x! - node.x
    let y = quadIn.y! - node.y
    let w = x2 - x1
    let l = x * x + y * y

    // Apply the Barnes-Hut approximation if possible. Limit forces for very close nodes; randomize direction if coincident.
    if (w * w / theta2 < l) {
      if (l < distanceMax2) {
        if (x === 0) { x = jiggle(random); l += x * x }
        if (y === 0) { y = jiggle(random); l += y * y }
        if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l)
        node.vx += x * quadIn.value * alpha / l
        node.vy += y * quadIn.value * alpha / l
      }
      return true
    }
    // Otherwise, process points directly.
    else if (quadIn.length || l >= distanceMax2) return

    // Limit forces for very close nodes; randomize direction if coincident.
    if ((quadIn as unknown as Leaf).data !== node || (quadIn as unknown as Leaf).next) {
      if (x === 0) { x = jiggle(random); l += x * x }
      if (y === 0) { y = jiggle(random); l += y * y }
      if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l)
    }

    do if ((quad as unknown as Leaf).data !== node) {
      w = strengths[(quad as unknown as Leaf).data.index!]! * alpha / l
      node.vx += x * w
      node.vy += y * w
    } while (quad = (quad as unknown as Leaf).next as QuadNode | undefined)
  }

  force.initialize = (_nodes, _random) => { nodes = _nodes; random = _random; initialize() }
  force.strength = (...a: unknown[]) => {
    if (!a.length) return strength
    const _ = a[0]
    strength = typeof _ === 'function' ? (_ as typeof strength) : constant(+(_ as number))
    initialize()
    return force
  }
  force.distanceMin = (...a: unknown[]) => (a.length ? (distanceMin2 = (a[0] as number) * (a[0] as number), force) : Math.sqrt(distanceMin2))
  force.distanceMax = (...a: unknown[]) => (a.length ? (distanceMax2 = (a[0] as number) * (a[0] as number), force) : Math.sqrt(distanceMax2))
  force.theta = (...a: unknown[]) => (a.length ? (theta2 = (a[0] as number) * (a[0] as number), force) : Math.sqrt(theta2))
  return force
}

interface Link { source: Node | unknown; target: Node | unknown; index?: number; [k: string]: unknown }

function forceLink(linksIn?: Link[]): Force {
  let links: Link[] = linksIn == null ? [] : linksIn
  let id: (d: Node, i: number, nodes: Node[]) => unknown = (d) => d.index
  let strengths: number[]
  let distances: number[]
  let nodes: Node[] | undefined
  let count: number[]
  let bias: number[]
  let random: Random
  let iterations = 1
  let strength: (l: Link, i: number, links: Link[]) => number = (link) =>
    1 / Math.min(count[(link.source as Node).index!]!, count[(link.target as Node).index!]!)
  let distance: (l: Link, i: number, links: Link[]) => number = constant(30)

  const force = ((alpha: number) => {
    for (let k = 0, n = links.length; k < iterations; ++k) {
      for (let i = 0; i < n; ++i) {
        const link = links[i]!
        const source = link.source as Node
        const target = link.target as Node
        let x = target.x + target.vx - source.x - source.vx || jiggle(random)
        let y = target.y + target.vy - source.y - source.vy || jiggle(random)
        let l = Math.sqrt(x * x + y * y)
        l = (l - distances[i]!) / l * alpha * strengths[i]!
        x *= l; y *= l
        let b = bias[i]!
        target.vx -= x * b
        target.vy -= y * b
        source.vx += x * (b = 1 - b)
        source.vy += y * b
      }
    }
    meterTick('force', links.length)
  }) as Force

  function initialize(): void {
    if (!nodes) return
    const n = nodes.length
    const m = links.length
    const nodeById = new Map(nodes.map((d, i) => [id(d, i, nodes!), d] as const))
    count = new Array(n)
    for (let i = 0; i < m; ++i) {
      const link = links[i]!
      link.index = i
      if (typeof link.source !== 'object') link.source = find(nodeById, link.source)
      if (typeof link.target !== 'object') link.target = find(nodeById, link.target)
      const s = (link.source as Node).index!
      const t = (link.target as Node).index!
      count[s] = (count[s] || 0) + 1
      count[t] = (count[t] || 0) + 1
    }
    bias = new Array(m)
    for (let i = 0; i < m; ++i) {
      const link = links[i]!
      bias[i] = count[(link.source as Node).index!]! / (count[(link.source as Node).index!]! + count[(link.target as Node).index!]!)
    }
    strengths = new Array(m)
    initializeStrength()
    distances = new Array(m)
    initializeDistance()
  }
  function initializeStrength(): void {
    if (!nodes) return
    for (let i = 0, n = links.length; i < n; ++i) strengths[i] = +strength(links[i]!, i, links)
  }
  function initializeDistance(): void {
    if (!nodes) return
    for (let i = 0, n = links.length; i < n; ++i) distances[i] = +distance(links[i]!, i, links)
  }

  force.initialize = (_nodes, _random) => { nodes = _nodes; random = _random; initialize() }
  force.links = (...a: unknown[]) => (a.length ? (links = a[0] as Link[], initialize(), force) : links)
  force.id = (...a: unknown[]) => (a.length ? (id = a[0] as typeof id, force) : id)
  force.iterations = (...a: unknown[]) => (a.length ? (iterations = +(a[0] as number), force) : iterations)
  force.strength = (...a: unknown[]) => {
    if (!a.length) return strength
    const _ = a[0]
    strength = typeof _ === 'function' ? (_ as typeof strength) : constant(+(_ as number))
    initializeStrength()
    return force
  }
  force.distance = (...a: unknown[]) => {
    if (!a.length) return distance
    const _ = a[0]
    distance = typeof _ === 'function' ? (_ as typeof distance) : constant(+(_ as number))
    initializeDistance()
    return force
  }
  return force
}

function find(nodeById: Map<unknown, Node>, nodeId: unknown): Node {
  const node = nodeById.get(nodeId)
  if (!node) throw new Error('node not found: ' + String(nodeId))
  return node
}

function forceAxis(axis: 'x' | 'y', valueIn?: Num<Node>): Force {
  let strength: (d: Node, i: number, nodes: Node[]) => number = constant(0.1)
  let nodes: Node[] | undefined
  let strengths: number[]
  let zs: number[]
  let value: (d: Node, i: number, nodes: Node[]) => number =
    typeof valueIn === 'function' ? valueIn : constant(valueIn == null ? 0 : +valueIn)
  const v = axis === 'x' ? 'vx' : 'vy'

  const force = ((alpha: number) => {
    for (let i = 0, n = nodes!.length; i < n; ++i) {
      const node = nodes![i]!
      node[v] += (zs[i]! - node[axis]) * strengths[i]! * alpha
    }
  }) as Force

  function initialize(): void {
    if (!nodes) return
    const n = nodes.length
    strengths = new Array(n)
    zs = new Array(n)
    for (let i = 0; i < n; ++i) {
      strengths[i] = isNaN(zs[i] = +value(nodes[i]!, i, nodes)) ? 0 : +strength(nodes[i]!, i, nodes)
    }
  }

  force.initialize = (_) => { nodes = _; initialize() }
  force.strength = (...a: unknown[]) => {
    if (!a.length) return strength
    const _ = a[0]
    strength = typeof _ === 'function' ? (_ as typeof strength) : constant(+(_ as number))
    initialize()
    return force
  }
  force[axis] = (...a: unknown[]) => {
    if (!a.length) return value
    const _ = a[0]
    value = typeof _ === 'function' ? (_ as typeof value) : constant(+(_ as number))
    initialize()
    return force
  }
  return force
}

const initialRadius = 10
const initialAngle = Math.PI * (3 - Math.sqrt(5))

/** d3 `forceSimulation(nodes)` without the timer: `tick()` advances the layout by hand. */
function forceSimulation(initialNodes: Node[]) {
  let nodes = initialNodes
  let alpha = 1
  let alphaMin = 0.001
  let alphaDecay = 1 - Math.pow(alphaMin, 1 / 300)
  let alphaTarget = 0
  let velocityDecay = 0.6
  const forces = new Map<string, Force>()
  const random = lcg()

  function tick(iterations = 1): void {
    const n = nodes.length
    for (let k = 0; k < iterations; ++k) {
      alpha += (alphaTarget - alpha) * alphaDecay
      forces.forEach((force) => { force(alpha) })
      for (let i = 0; i < n; ++i) {
        const node = nodes[i]!
        if (node.fx == null) node.x += node.vx *= velocityDecay
        else { node.x = node.fx; node.vx = 0 }
        if (node.fy == null) node.y += node.vy *= velocityDecay
        else { node.y = node.fy; node.vy = 0 }
      }
    }
  }

  function initializeNodes(): void {
    for (let i = 0, n = nodes.length; i < n; ++i) {
      const node = nodes[i]!
      node.index = i
      if (node.fx != null) node.x = node.fx
      if (node.fy != null) node.y = node.fy
      if (isNaN(node.x) || isNaN(node.y)) {
        const radius = initialRadius * Math.sqrt(0.5 + i)
        const angle = i * initialAngle
        node.x = radius * Math.cos(angle)
        node.y = radius * Math.sin(angle)
      }
      if (isNaN(node.vx) || isNaN(node.vy)) node.vx = node.vy = 0
    }
  }

  function initializeForce(force: Force): Force {
    if (force.initialize) force.initialize(nodes, random)
    return force
  }

  initializeNodes()

  const accessor = (get: () => number, set: (v: number) => void): { (): number; (v: number): void } =>
    ((...a: number[]) => (a.length ? set(a[0]!) : get())) as { (): number; (v: number): void }
  return {
    tick,
    alpha: accessor(() => alpha, (v) => { alpha = +v }),
    alphaMin: accessor(() => alphaMin, (v) => { alphaMin = +v }),
    alphaDecay: accessor(() => +alphaDecay, (v) => { alphaDecay = +v }),
    alphaTarget: accessor(() => alphaTarget, (v) => { alphaTarget = +v }),
    velocityDecay: accessor(() => 1 - velocityDecay, (v) => { velocityDecay = 1 - v }),
    force: (name: string, f: Force) => { forces.set(name, initializeForce(f)) },
  }
}

// --- vega-force Force ----------------------------------------------------------------------------------------------

const FORCES: Record<string, () => Force> = {
  center: forceCenter,
  collide: forceCollide,
  nbody: forceManyBody,
  link: forceLink,
  x: () => forceAxis('x'),
  y: () => forceAxis('y'),
}

/** Whether a value is a parameter given as an expression / a field: turned into a function of the node. */
function numberParam(v: unknown, ctx: TransformContext): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { expr?: unknown }).expr === 'string') {
    const f = compileExprTransform((v as { expr: string }).expr, ctx)
    return (d: Node) => f(d)
  }
  return v
}

function getForce(spec: Record<string, unknown>, ctx: TransformContext): Force {
  const name = spec.force as string
  if (!hasOwnProperty(FORCES, name)) error('Unrecognized force: ' + name)
  const f = FORCES[name]!()
  // (only the parameters the spec gives are set: vega-parser does not apply a force's declared defaults, so a
  // collide force has d3's strength 1, not the 0.7 its definition lists)
  const merged: Record<string, unknown> = spec
  for (const p of Object.keys(merged)) {
    if (p === 'force' || typeof f[p] !== 'function') continue
    let v = merged[p]
    if (p === 'links') {
      // `links` names a dataset (type 'data'): its rows are the links (d3 replaces their ends with the nodes)
      v = typeof v === 'string' ? ctx.datasets?.(v) ?? [] : v
    } else if (p === 'id') {
      const acc = fieldOf(v)
      v = (d: Node) => acc(d)
    } else if ((name === 'x' && p === 'x') || (name === 'y' && p === 'y')) {
      // (a `field` parameter: a name read off the node)
      if (typeof v === 'string') { const acc = fieldOf(v); v = (d: Node) => +(acc(d) as number) }
    } else {
      v = numberParam(v, ctx)
    }
    if (v === undefined) continue
    ;(f[p] as (x: unknown) => unknown)(v)
  }
  return f
}

/**
 * The `force` transform: a d3-force simulation over the rows, which gain `x`, `y`, `vx`, `vy` and `index`. A static
 * layout runs `iterations` ticks to the cool-down; otherwise vega runs one tick when the dataflow starts (the
 * animation that follows is its timer's). The rows are changed in place when the caller owns them (`inPlace`: the
 * encoded items of a mark), as vega's tuples are.
 */
export function forceRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext & { dynamicParams?: ReadonlySet<string> }): Row[] {
  const nodes = (ctx.inPlace ? rows : rows.map((r) => ({ ...r }))) as Node[]
  const sim = forceSimulation(nodes)
  let iters = (t.iterations as number | undefined) || 300
  // vega-force applies alpha / alphaMin / alphaTarget / velocityDecay to the simulation only for a parameter its
  // dataflow reports as modified, which neither a literal nor a reference to a declared signal is: those are read
  // where the transform reads them directly (`alpha` below) and are otherwise d3's own defaults; a `{signal}` that
  // is an expression (`dynamicParams` names those) is applied
  const dyn = ctx.dynamicParams
  if (dyn?.has('alphaMin')) sim.alphaMin(+(t.alphaMin as number))
  if (dyn?.has('alphaTarget')) sim.alphaTarget(+(t.alphaTarget as number))
  if (dyn?.has('velocityDecay')) sim.velocityDecay(+(t.velocityDecay as number))
  if (dyn?.has('alpha')) sim.alpha(+(t.alpha as number))
  const forces = ([] as Array<Record<string, unknown>>).concat((t.forces as Array<Record<string, unknown>> | undefined) ?? [])
  forces.forEach((spec, i) => { sim.force('forces' + i, getForce(spec, ctx)) })
  if (!t.static) sim.tick() // ensure we run on init
  sim.alpha(Math.max(sim.alpha(), (t.alpha as number) || 1))
  sim.alphaDecay(1 - Math.pow(sim.alphaMin(), 1 / iters))
  if (t.static) while (--iters >= 0) sim.tick()
  return nodes as Row[]
}
