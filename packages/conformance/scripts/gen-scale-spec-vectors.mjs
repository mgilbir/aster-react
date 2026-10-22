/**
 * Records "scale spec -> built scale" oracle vectors from real vega (the pinned
 * `vega` devDependency: vega-parser + vega-encode's Scale transform), written to
 * `packages/core/testdata/vectors/spec-level/vega-scale-spec.json`. Cases live in
 * `scale-spec-cases.mjs`. Run with:
 *
 *   pnpm --filter @aster/conformance run vectors:scale-spec
 *
 * A separate generator (not gen-vectors.mjs) so the committed vectors of the
 * other libraries stay byte-stable. The replay is
 * `packages/core/src/scale-spec-vectors.test.ts`; the value codec and the
 * projection below are mirrored there and must agree.
 *
 * Local time is pinned to UTC so vectors are machine-independent; the replay
 * runs under several time zones (the scales under test are UTC or numeric, and
 * a local-time leak shows up as a mismatch there).
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.TZ = 'UTC'

const here = dirname(fileURLToPath(import.meta.url))
const req = createRequire(join(here, '..', 'package.json'))
const vega = await import('vega')
const { suites } = await import('./scale-spec-cases.mjs')

function enc(v) {
  if (v === undefined) return { $: 'undef' }
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { $: 'nan' }
    if (v === Infinity) return { $: 'inf' }
    if (v === -Infinity) return { $: '-inf' }
    if (v === 0 && 1 / v < 0) return { $: '-0' }
    return v
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? { $: 'baddate' } : { $: 'date', ms: v.getTime() }
  if (typeof v === 'function') return { $: 'fn' }
  if (typeof v === 'symbol') return { $: 'symbol', desc: v.description ?? null }
  if (Array.isArray(v)) return v.map(enc)
  if (v !== null && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = enc(v[k])
    return o
  }
  return v
}

const attempt = (f) => {
  try {
    return enc(f())
  } catch {
    return { $: 'throw' }
  }
}

/** Probe inputs derived from the oracle scale (recorded, so the replay feeds the same). */
function autoProbes(s) {
  const dom = attempt(() => s.domain())
  const d = s.domain?.() ?? []
  const out = []
  const nums = d.map((x) => (x instanceof Date ? x.getTime() : x))
  if (nums.length && nums.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    const lo = nums[0]
    const hi = nums[nums.length - 1]
    const span = hi - lo
    const stops = [...nums]
    for (const f of [-0.5, 0.1, 0.25, 0.5, 0.75, 0.9, 1.5]) stops.push(lo + span * f)
    // between consecutive stops of a piecewise domain too
    for (let i = 0; i + 1 < nums.length; i++) stops.push((nums[i] + nums[i + 1]) / 2)
    stops.push(0, 1, NaN, null, undefined)
    for (const x of stops) out.push(s.type === 'time' || s.type === 'utc' ? (x == null || Number.isNaN(x) ? x : x) : x)
  } else if (Array.isArray(d)) {
    for (const x of d.slice(0, 12)) out.push(x)
    out.push('__unknown__', null, undefined)
  }
  void dom
  return out
}

function project(s, probes) {
  const o = {}
  o.type = s.type
  o.domain = attempt(() => s.domain())
  o.range = attempt(() => (s.range ? s.range() : undefined))
  o.samples = probes.map((p) => attempt(() => s(p)))
  for (const m of ['bandwidth', 'step', 'thresholds', 'quantiles', 'clamp', 'round', 'exponent', 'base', 'constant', 'padding', 'paddingInner', 'paddingOuter', 'align', 'unknown']) {
    if (typeof s[m] === 'function') o[m] = attempt(() => (m === 'quantiles' ? s.quantiles(4) : s[m]()))
  }
  o.bins = 'bins' in s ? attempt(() => s.bins) : { $: 'undef' }
  if (typeof s.ticks === 'function') o.ticks = attempt(() => s.ticks(5))
  if (typeof s.invertExtent === 'function') {
    const r = (() => { try { return s.range() } catch { return [] } })()
    if (Array.isArray(r)) o.invertExtent = r.slice(0, 12).map((x) => attempt(() => s.invertExtent(x)))
  }
  return o
}

async function build(spec) {
  const s = structuredClone(spec)
  // vega's dataflow swallows an error thrown inside an operator (the transform
  // stops half-configured), so errors are captured through the logger: a case
  // whose scale transform errored is an oracle THROW, not a partial scale.
  const errors = []
  const quiet = {
    level() { return this },
    error(...a) { errors.push(a); return this },
    warn() { return this },
    info() { return this },
    debug() { return this },
  }
  const view = new vega.View(vega.parse(s), { renderer: 'none', logLevel: vega.None, logger: quiet })
  view.logger(quiet)
  await view.runAsync()
  if (errors.length) throw new Error(String(errors[0]))
  return view.scale('s')
}

const ZONES = ['America/New_York', 'Asia/Kolkata']
const out = { suites: {} }
let n = 0
let throws = 0
for (const [suite, cases] of Object.entries(suites)) {
  const list = []
  for (const c of cases) {
    let want
    let probes
    try {
      const s = await build(c.spec)
      probes = c.probes ?? autoProbes(s)
      want = project(s, probes)
    } catch (err) {
      want = { $: 'throw' }
      probes = c.probes ?? []
      throws++
    }
    const entry = { name: c.name, spec: enc(c.spec), probes: probes.map(enc), want }
    // A local-time scale (`time`) reads the process time zone: record it under
    // every zone the replay runs in (the UTC recording is `want`).
    if (/"type":"time"/.test(JSON.stringify(c.spec))) {
      entry.wantByTz = {}
      for (const tz of ZONES) {
        process.env.TZ = tz
        try {
          entry.wantByTz[tz] = project(await build(c.spec), probes)
        } catch {
          entry.wantByTz[tz] = { $: 'throw' }
        }
      }
      process.env.TZ = 'UTC'
    }
    list.push(entry)
    n++
  }
  out.suites[suite] = { oracle: 'vega@' + vega.version, cases: list }
}
const dest = join(here, '..', '..', 'core', 'testdata', 'vectors', 'spec-level', 'vega-scale-spec.json')
mkdirSync(dirname(dest), { recursive: true })
// one case per line: diffs stay reviewable and the file stays small
const body = Object.entries(out.suites)
  .map(([k, s]) => `${JSON.stringify(k)}:{"oracle":${JSON.stringify(s.oracle)},"cases":[\n${s.cases.map((c) => JSON.stringify(c)).join(',\n')}\n]}`)
  .join(',\n')
writeFileSync(dest, `{"suites":{\n${body}\n}}\n`)
console.log(`[vectors] wrote ${n} scale-spec cases (${throws} oracle throws) across ${Object.keys(out.suites).length} suites -> ${dest}`)
