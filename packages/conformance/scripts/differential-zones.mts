/**
 * The time zones the generated time differentials run under, and instants drawn near their offset changes.
 *
 * Node re-reads `process.env.TZ` on every date operation, so one process can walk every zone (`withTz`). The changes
 * of UTC offset are found by scanning, not listed: whatever this machine's ICU data says about the zone is what both
 * sides are exercised on.
 */
import type { Rng } from './differential-gen.mts'

/**
 * UTC (no DST), America/New_York (DST, 1 h), Australia/Lord_Howe (DST of 30 min, so a transition lands inside an
 * hour), Pacific/Apia (skipped 2011-12-30 entirely, moved across the date line; DST until 2021), Asia/Kolkata (a
 * +5:30 offset with no DST).
 */
export const ZONES = ['UTC', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Asia/Kolkata'] as const

const HOUR = 3_600_000
const cache = new Map<string, number[]>()

/** Instants (ms) at which the zone's UTC offset changes, 1970-2040. Call inside `withTz(tz, ...)`. */
export function offsetChanges(tz: string): number[] {
  const known = cache.get(tz)
  if (known) return known
  const out: number[] = []
  const end = Date.UTC(2040, 0, 1)
  let prev = new Date(Date.UTC(1970, 0, 1)).getTimezoneOffset()
  for (let t = Date.UTC(1970, 0, 1) + HOUR; t < end; t += HOUR) {
    const now = new Date(t).getTimezoneOffset()
    if (now !== prev) out.push(t)
    prev = now
  }
  cache.set(tz, out)
  return out
}

/** A spread of instants, many of them hours or days around an offset change, some at the extremes of the Date range. */
export function genInstant(r: Rng, changes: readonly number[]): number {
  const k = r.int(20)
  if (k < 9 && changes.length) {
    const t = r.pick(changes)
    return t + r.pick([-1, 0, 1, -HOUR, HOUR, -2 * HOUR, 2 * HOUR, -30 * 60_000, 30 * 60_000, -25 * HOUR, 25 * HOUR]) + (r.chance(0.3) ? r.int(3 * 86_400_000) - 86_400_000 : 0)
  }
  if (k < 14) return r.between(-2_000_000_000_000, 4_000_000_000_000)
  if (k < 15) return r.pick([0, -1, 1, 951782400000, 946684800000, 1709251200000, 1735689599999, 1735689600000, 1704067200000])
  if (k < 16) return r.pick([8.64e15, -8.64e15, 8.64e15 - 1, -62198755200000, -62167219200000, -62135596800000, 253402300800000, 253402300799999, 1e14, -1e14])
  if (k < 17) return r.pick([NaN, NaN, 8.64e15 + 1, Infinity, -Infinity])
  // within the first centuries, where two-digit years and the Julian-free proleptic calendar are awkward
  return Date.UTC(r.between(0, 120), r.int(12), 1 + r.int(31), r.int(24), r.int(60), r.int(60), r.int(1000))
}
