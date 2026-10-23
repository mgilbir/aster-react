/**
 * Invertible scale snapshots that survive a structured clone.
 *
 * A scene produced in a worker has no live scale handles (functions do not
 * cross `postMessage`), yet pan/zoom, brushing and the keyboard contract need
 * `scale(v)`, `scale.invert(px)` and `scale.domain()` on the main thread. The
 * worker therefore attaches the plain-data description below
 * (`SCALE_INFO_KEY` on the scene root), and the host rebuilds equivalent
 * callable scales from it. Only continuous numeric scales are described: those
 * are the only ones pan/zoom and interval brushing operate on.
 */

export const SCALE_INFO_KEY = '__scaleInfo'

export interface SerializedScale {
  name: string
  type: 'linear' | 'log' | 'pow' | 'sqrt' | 'symlog' | 'time' | 'utc'
  domain: number[]
  range: number[]
  base?: number
  exponent?: number
  constant?: number
  clamp?: boolean
}

const CONTINUOUS = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc'])

interface LiveScale {
  type?: string
  domain?: () => unknown[]
  range?: () => unknown[]
  invert?: unknown
  base?: () => number
  exponent?: () => number
  constant?: () => number
  clamp?: () => boolean
}

/** Describe every continuous numeric scale in a live scale map (worker side). */
export function serializeScales(scales: Map<string, unknown> | undefined): SerializedScale[] {
  const out: SerializedScale[] = []
  if (!scales) return out
  for (const [name, scale] of scales) {
    const s = scale as LiveScale
    if (typeof s?.domain !== 'function' || typeof s.range !== 'function' || typeof s.invert !== 'function') continue
    const type = s.type
    if (type == null || !CONTINUOUS.has(type)) continue
    const domain = s.domain().map(Number)
    const range = s.range()
    if (domain.length < 2 || domain.some((v) => !Number.isFinite(v))) continue
    if (range.length !== domain.length || range.some((v) => typeof v !== 'number' || !Number.isFinite(v))) continue
    out.push({
      name,
      type: type as SerializedScale['type'],
      domain,
      range: range as number[],
      ...(typeof s.base === 'function' ? { base: s.base() } : {}),
      ...(typeof s.exponent === 'function' ? { exponent: s.exponent() } : {}),
      ...(typeof s.constant === 'function' ? { constant: s.constant() } : {}),
      ...(typeof s.clamp === 'function' ? { clamp: s.clamp() } : {}),
    })
  }
  return out
}

interface Transform {
  fwd: (x: number) => number
  inv: (y: number) => number
}

function transformOf(info: SerializedScale): Transform {
  switch (info.type) {
    case 'log': {
      const base = info.base ?? 10
      const lb = Math.log(base)
      // d3 reflects a negative domain so log() stays defined.
      const neg = info.domain[0]! < 0
      return neg
        ? { fwd: (x) => -Math.log(-x) / lb, inv: (y) => -Math.exp(-y * lb) }
        : { fwd: (x) => Math.log(x) / lb, inv: (y) => Math.exp(y * lb) }
    }
    case 'pow':
    case 'sqrt': {
      const e = info.type === 'sqrt' ? 0.5 : (info.exponent ?? 1)
      return {
        fwd: (x) => (x < 0 ? -Math.pow(-x, e) : Math.pow(x, e)),
        inv: (y) => (y < 0 ? -Math.pow(-y, 1 / e) : Math.pow(y, 1 / e)),
      }
    }
    case 'symlog': {
      const c = info.constant ?? 1
      return {
        fwd: (x) => Math.sign(x) * Math.log1p(Math.abs(x / c)),
        inv: (y) => Math.sign(y) * Math.expm1(Math.abs(y)) * c,
      }
    }
    default:
      return { fwd: (x) => x, inv: (y) => y }
  }
}

/** Piecewise-linear interpolation of `v` from `xs` to `ys` (d3 `polylinear`). */
function piecewise(xs: number[], ys: number[], v: number, clamp: boolean): number {
  const n = xs.length
  // Descending domains are walked reversed so the search stays monotone.
  const desc = xs[0]! > xs[n - 1]!
  const x = desc ? [...xs].reverse() : xs
  const y = desc ? [...ys].reverse() : ys
  let i = 0
  if (v <= x[0]!) i = 0
  else if (v >= x[n - 1]!) i = n - 2
  else while (i < n - 2 && v > x[i + 1]!) i++
  const x0 = x[i]!
  const x1 = x[i + 1]!
  let t = x1 === x0 ? 0 : (v - x0) / (x1 - x0)
  if (clamp) t = Math.min(1, Math.max(0, t))
  return y[i]! + t * (y[i + 1]! - y[i]!)
}

/** Rebuild callable, invertible scales from `serializeScales` output. */
export function scalesFromSerialized(list: readonly SerializedScale[]): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const info of list) {
    const { fwd, inv } = transformOf(info)
    const tx = info.domain.map(fwd)
    const clamp = info.clamp === true
    const apply = (v: unknown): number => piecewise(tx, info.range, fwd(Number(v)), clamp)
    const scale = Object.assign(apply, {
      type: info.type,
      domain: () => info.domain.slice(),
      range: () => info.range.slice(),
      invert: (p: number): number => inv(piecewise(info.range, tx, Number(p), clamp)),
    })
    out.set(info.name, scale)
  }
  return out
}
