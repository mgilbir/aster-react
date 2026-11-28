/**
 * How far the engine's coverage-only context is from the alpha a browser canvas left, for one drawing of `raster-shapes.ts`.
 * Shared by `raster-vs-chromium.test.ts` (which holds each drawing to its recorded numbers) and `scripts/raster-fixtures.mts`
 * (which records them), so the two cannot count differently.
 *
 * "Has any alpha" is what the label layout reads (a label is placed where no pixel under it has any), and its two errors are not the
 * same one: `missing` pixels are inked by the browser and left empty by the engine (a label may be put on ink the browser shows: the
 * error that matters), `extra` are inked by the engine and empty in the browser (a halo: a label keeps slightly further away).
 * A single sum would let a change that trades one for the other pass.
 */
import { AlphaCanvas } from '../../core/src/raster.js'
import type { RasterShape } from './raster-shapes.js'

/** Replay a drawing on the engine's context; the alpha it leaves. */
export function drawShape(s: RasterShape): Uint8Array {
  const c = new AlphaCanvas(s.w, s.h) as unknown as Record<string, unknown> & { alpha: Uint8Array }
  for (const cmd of s.cmds) {
    if (Array.isArray(cmd)) Reflect.apply(c[cmd[0]] as (x: unknown) => void, c, cmd.slice(1))
    else c[cmd.set] = cmd.value
  }
  return c.alpha
}

export interface Disagreement {
  /** Pixels the browser inked and the engine left empty. */
  missing: number
  /** Pixels the engine inked and the browser left empty. */
  extra: number
  /** The summed absolute alpha difference. */
  abs: number
}

/** The disagreement of `got` (the engine's alpha) with `want` (the browser's). */
export function measure(want: ArrayLike<number>, got: ArrayLike<number>): Disagreement {
  let missing = 0
  let extra = 0
  let abs = 0
  for (let i = 0; i < want.length; i++) {
    if (want[i] !== 0 && got[i] === 0) missing++
    else if (want[i] === 0 && got[i] !== 0) extra++
    abs += Math.abs(want[i]! - got[i]!)
  }
  return { missing, extra, abs }
}
