/**
 * Circle packing for the `pack` layout: siblings are placed one by one against the "front" of the circles placed so far,
 * then the smallest circle enclosing the front is found by a randomised incremental search.
 *
 * Observable behaviour fixed here (every position and radius depends on it, to the last bit):
 *  - the first three circles are placed by fixed rules, each later one tangent to two neighbours of the front;
 *  - the front is a circular list that is walked from both sides of the newest edge, the side with less length walked so
 *    far first, until a circle that the candidate overlaps is met (then the front is cut back and the circle retried);
 *  - the front's next closest-to-centroid pair is the first minimum of `score` around the list;
 *  - the enclosing circle search shuffles the front with the shared random source (one draw per circle, from the last to
 *    the first) and tries candidate bases in a fixed order.
 */
import { meterTick } from './limits.js'

export interface Circle {
  x: number
  y: number
  r: number
}

/** Fisher-Yates from the end; one draw per element. */
function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  let m = items.length
  while (m) {
    const i = random() * m-- | 0
    const t = items[m]!
    items[m] = items[i]!
    items[i] = t
  }
  return items
}

/** Put circle `c` tangent to both `a` and `b` (on the side that `b` to `a` turns toward). */
function placeTangent(b: Circle, a: Circle, c: Circle): void {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d2 = dx * dx + dy * dy
  if (d2) {
    let a2 = a.r + c.r
    a2 *= a2
    let b2 = b.r + c.r
    b2 *= b2
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2)
      const y = Math.sqrt(Math.max(0, b2 / d2 - x * x))
      c.x = b.x - x * dx - y * dy
      c.y = b.y - x * dy + y * dx
    } else {
      const x = (d2 + a2 - b2) / (2 * d2)
      const y = Math.sqrt(Math.max(0, a2 / d2 - x * x))
      c.x = a.x + x * dx - y * dy
      c.y = a.y + x * dy + y * dx
    }
  } else {
    c.x = a.x + c.r
    c.y = a.y
  }
}

function overlaps(a: Circle, b: Circle): boolean {
  const dr = a.r + b.r - 1e-6
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dr > 0 && dr * dr > dx * dx + dy * dy
}

/** Squared distance from the origin to the radius-weighted midpoint of two circles. */
function centroidScore(a: Circle, b: Circle): number {
  const ab = a.r + b.r
  const dx = (a.x * b.r + b.x * a.r) / ab
  const dy = (a.y * b.r + b.y * a.r) / ab
  return dx * dx + dy * dy
}

/**
 * Pack `circles` (their radii set) around the origin: sets every `x` and `y`, and returns the radius of the circle that
 * encloses them all, centred on the origin.
 */
export function packSiblings(circles: Circle[], random: () => number): number {
  const n = circles.length
  if (!n) return 0
  const first = circles[0]!
  first.x = 0
  first.y = 0
  if (n < 2) return first.r
  const second = circles[1]!
  first.x = -second.r
  second.x = first.r
  second.y = 0
  if (n < 3) return first.r + second.r
  placeTangent(second, first, circles[2]!)

  // The front is a circular doubly linked list over circle indices, starting as the first three.
  const next = new Int32Array(n)
  const prev = new Int32Array(n)
  next[0] = 1; prev[2] = 1
  next[1] = 2; prev[0] = 2
  next[2] = 0; prev[1] = 0
  let a = 0
  let b = 1
  for (let i = 3; i < n; ++i) {
    const c = circles[i]!
    placeTangent(circles[a]!, circles[b]!, c)
    // walk out from the new circle's two neighbours, the side walked less far first, to the nearest circle it overlaps
    let j = next[b]!
    let k = prev[a]!
    let walkedJ = circles[b]!.r
    let walkedK = circles[a]!.r
    let cut = false
    do {
      meterTick('pack')
      if (walkedJ <= walkedK) {
        if (overlaps(circles[j]!, c)) {
          b = j
          next[a] = b
          prev[b] = a
          cut = true
          break
        }
        walkedJ += circles[j]!.r
        j = next[j]!
      } else {
        if (overlaps(circles[k]!, c)) {
          a = k
          next[a] = b
          prev[b] = a
          cut = true
          break
        }
        walkedK += circles[k]!.r
        k = prev[k]!
      }
    } while (j !== next[k]!)
    if (cut) { --i; continue } // the front was cut back: place this circle again against the new edge

    // splice it in between a and b, then find the front pair closest to the centroid
    prev[i] = a
    next[i] = b
    next[a] = i
    prev[b] = i
    b = i
    let best = centroidScore(circles[a]!, circles[next[a]!]!)
    for (let m = next[i]!; m !== b; m = next[m]!) {
      const score = centroidScore(circles[m]!, circles[next[m]!]!)
      if (score < best) { a = m; best = score }
    }
    b = next[a]!
  }

  // enclose the front, then move the circles so that the enclosing circle is centred on the origin
  const front: Circle[] = [circles[b]!]
  for (let m = next[b]!; m !== b; m = next[m]!) front.push(circles[m]!)
  const enclosing = enclose(front, random)
  for (let i = 0; i < n; ++i) {
    circles[i]!.x -= enclosing.x
    circles[i]!.y -= enclosing.y
  }
  return enclosing.r
}

// -- the smallest enclosing circle ----------------------------------------------------------------------------------

/** Welzl's search over a shuffled copy of the circles: grow a basis of at most three until it holds them all. */
function enclose(circles: Circle[], random: () => number): Circle {
  const shuffled = shuffleInPlace(Array.from(circles), random)
  const n = shuffled.length
  let basis: Circle[] = []
  let enclosing: Circle | undefined
  let i = 0
  while (i < n) {
    const p = shuffled[i]!
    if (enclosing && containsWeakly(enclosing, p)) ++i
    else {
      basis = extendBasis(basis, p)
      enclosing = circleOf(basis)
      i = 0
    }
  }
  return enclosing!
}

/** A basis that holds the old basis' circles and `p`, preferring the smaller ones. */
function extendBasis(basis: Circle[], p: Circle): Circle[] {
  if (containsAllWeakly(p, basis)) return [p]
  for (let i = 0; i < basis.length; ++i) {
    if (excludes(p, basis[i]!) && containsAllWeakly(circleOf2(basis[i]!, p), basis)) return [basis[i]!, p]
  }
  for (let i = 0; i < basis.length - 1; ++i) {
    for (let j = i + 1; j < basis.length; ++j) {
      if (
        excludes(circleOf2(basis[i]!, basis[j]!), p) &&
        excludes(circleOf2(basis[i]!, p), basis[j]!) &&
        excludes(circleOf2(basis[j]!, p), basis[i]!) &&
        containsAllWeakly(circleOf3(basis[i]!, basis[j]!, p), basis)
      ) return [basis[i]!, basis[j]!, p]
    }
  }
  throw new Error('[aster] pack: unable to find enclosing circle')
}

/** `a` does not contain `b`. */
function excludes(a: Circle, b: Circle): boolean {
  const dr = a.r - b.r
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dr < 0 || dr * dr < dx * dx + dy * dy
}

/** `a` contains `b`, allowing a relative slack of 1e-9. */
function containsWeakly(a: Circle, b: Circle): boolean {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dr > 0 && dr * dr > dx * dx + dy * dy
}

function containsAllWeakly(a: Circle, circles: Circle[]): boolean {
  for (let i = 0; i < circles.length; ++i) if (!containsWeakly(a, circles[i]!)) return false
  return true
}

function circleOf(basis: Circle[]): Circle {
  switch (basis.length) {
    case 1: return { x: basis[0]!.x, y: basis[0]!.y, r: basis[0]!.r }
    case 2: return circleOf2(basis[0]!, basis[1]!)
    default: return circleOf3(basis[0]!, basis[1]!, basis[2]!)
  }
}

/** The smallest circle around two. */
function circleOf2(a: Circle, b: Circle): Circle {
  const x1 = a.x, y1 = a.y, r1 = a.r
  const x2 = b.x, y2 = b.y, r2 = b.r
  const x21 = x2 - x1, y21 = y2 - y1, r21 = r2 - r1
  const l = Math.sqrt(x21 * x21 + y21 * y21)
  return {
    x: (x1 + x2 + x21 / l * r21) / 2,
    y: (y1 + y2 + y21 / l * r21) / 2,
    r: (l + r1 + r2) / 2,
  }
}

/** The circle tangent to, and around, three (Apollonius' problem, solved as a quadratic in the radius). */
function circleOf3(a: Circle, b: Circle, c: Circle): Circle {
  const x1 = a.x, y1 = a.y, r1 = a.r
  const x2 = b.x, y2 = b.y, r2 = b.r
  const x3 = c.x, y3 = c.y, r3 = c.r
  const a2 = x1 - x2
  const a3 = x1 - x3
  const b2 = y1 - y2
  const b3 = y1 - y3
  const c2 = r2 - r1
  const c3 = r3 - r1
  const d1 = x1 * x1 + y1 * y1 - r1 * r1
  const d2 = d1 - x2 * x2 - y2 * y2 + r2 * r2
  const d3 = d1 - x3 * x3 - y3 * y3 + r3 * r3
  const ab = a3 * b2 - a2 * b3
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1
  const xb = (b3 * c2 - b2 * c3) / ab
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1
  const yb = (a2 * c3 - a3 * c2) / ab
  const qa = xb * xb + yb * yb - 1
  const qb = 2 * (r1 + xa * xb + ya * yb)
  const qc = xa * xa + ya * ya - r1 * r1
  const r = -(Math.abs(qa) > 1e-6 ? (qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa) : qc / qb)
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r }
}
