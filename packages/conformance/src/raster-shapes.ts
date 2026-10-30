/**
 * Drawings used to hold the engine's coverage-only 2D context (`@aster/core` raster.ts) to a browser canvas: each is a list of
 * 2D-context commands, replayed by `scripts/raster-fixtures.mts` on a real canvas (Chromium) to record the alpha channel it
 * leaves, and by `raster-vs-chromium.test.ts` on the engine's context.
 */
export type Cmd = [method: string, ...args: unknown[]] | { set: string; value: unknown }
export interface RasterShape { name: string; w: number; h: number; cmds: Cmd[] }

const fillBlack: Cmd[] = [{ set: 'fillStyle', value: '#000' }]
const circle = (cx: number, cy: number, r: number, alpha = 1): Cmd[] => [
  ...fillBlack, { set: 'globalAlpha', value: alpha }, ['beginPath'], ['moveTo', cx + r, cy], ['arc', cx, cy, r, 0, 2 * Math.PI, false], ['fill'],
]
const stroke = (w: number, cap: string, join: string, dash: number[] = []): Cmd[] => [
  { set: 'strokeStyle', value: '#000' }, { set: 'lineWidth', value: w }, { set: 'lineCap', value: cap }, { set: 'lineJoin', value: join }, { set: 'miterLimit', value: 4 }, ['setLineDash', dash], ['stroke'],
]

export const SHAPES: RasterShape[] = [
  // a circle moved down by a sixteenth of a pixel at a time: its vertices move a quarter of a pixel at a time
  ...Array.from({ length: 8 }, (_, i): RasterShape => ({ name: `circle r=2.5 cy=5.${(i * 125).toString().padStart(3, '0')}`, w: 11, h: 12, cmds: circle(5.5, 5 + i / 8, 2.5) })),
  { name: 'circle r=2.5 half transparent', w: 11, h: 11, cmds: circle(5.3, 5.7, 2.5, 0.5) },
  { name: 'circle r=1.5', w: 8, h: 8, cmds: circle(4.2, 3.9, 1.5, 0.5) },
  { name: 'circle r=4', w: 14, h: 14, cmds: circle(6.8, 7.1, 4) },
  { name: 'circle r=7.3', w: 22, h: 22, cmds: circle(10.6, 11.4, 7.3) },
  { name: 'circle r=20', w: 50, h: 50, cmds: circle(24.5, 25.2, 20) },
  { name: 'half circle', w: 16, h: 12, cmds: [...fillBlack, ['beginPath'], ['moveTo', 3.5, 8.2], ['arc', 8, 8.2, 4.5, Math.PI, 2 * Math.PI, false], ['closePath'], ['fill']] },
  { name: 'triangle', w: 10, h: 10, cmds: [...fillBlack, ['beginPath'], ['moveTo', 1.2, 1.1], ['lineTo', 8.6, 2.3], ['lineTo', 3.3, 7.9], ['closePath'], ['fill']] },
  { name: 'diamond', w: 12, h: 12, cmds: [...fillBlack, ['beginPath'], ['moveTo', 6.3, 1.4], ['lineTo', 10.7, 6.2], ['lineTo', 6.3, 10.9], ['lineTo', 1.9, 6.2], ['closePath'], ['fill']] },
  { name: 'rect with fractional edges', w: 12, h: 8, cmds: [...fillBlack, ['beginPath'], ['rect', 1.3, 1.6, 8.4, 4.7], ['fill']] },
  { name: 'quadratic', w: 14, h: 12, cmds: [...fillBlack, ['beginPath'], ['moveTo', 1.5, 10.5], ['quadraticCurveTo', 7, -3, 12.5, 10.5], ['closePath'], ['fill']] },
  { name: 'cubic', w: 16, h: 14, cmds: [...fillBlack, ['beginPath'], ['moveTo', 2.1, 11.3], ['bezierCurveTo', 2, 0, 14, 0, 13.7, 11.3], ['closePath'], ['fill']] },
  { name: 'line width 2, slope 0.25', w: 24, h: 10, cmds: [['beginPath'], ['moveTo', 1.2, 3.1], ['lineTo', 22.6, 8.4], ...stroke(2, 'butt', 'miter')] },
  { name: 'line width 1, steep', w: 12, h: 24, cmds: [['beginPath'], ['moveTo', 2.7, 1.2], ['lineTo', 8.4, 22.1], ...stroke(1, 'butt', 'miter')] },
  { name: 'polyline width 3, miter joins', w: 30, h: 16, cmds: [['beginPath'], ['moveTo', 2, 12], ['lineTo', 9.4, 3.3], ['lineTo', 16.2, 11.7], ['lineTo', 27.5, 4.6], ...stroke(3, 'butt', 'miter')] },
  { name: 'polyline width 3, round joins and caps', w: 30, h: 16, cmds: [['beginPath'], ['moveTo', 3, 12], ['lineTo', 9.4, 4.3], ['lineTo', 16.2, 11.7], ['lineTo', 26.5, 4.6], ...stroke(3, 'round', 'round')] },
  { name: 'dashed line', w: 40, h: 8, cmds: [['beginPath'], ['moveTo', 1.5, 3.5], ['lineTo', 38.5, 4.6], ...stroke(2, 'butt', 'miter', [6, 4])] },
  { name: 'stroked circle', w: 20, h: 20, cmds: [['beginPath'], ['arc', 10.3, 9.8, 6.5, 0, 2 * Math.PI, false], ...stroke(2, 'butt', 'miter')] },
  { name: 'closed stroked polygon', w: 18, h: 16, cmds: [['beginPath'], ['moveTo', 3.2, 3.1], ['lineTo', 14.7, 4.4], ['lineTo', 9.1, 13.2], ['closePath'], ...stroke(1.5, 'butt', 'miter')] },
]

// ---------------------------------------------------------------------------------------------------------------------
// GENERATED drawings: a seeded set that exercises what the hand-written ones above do not -- curves long enough to be cut into
// many lines (and short ones cut into few), arcs of every sweep, scaled and rotated circles, strokes with every cap and join,
// dashes and transforms. The context is held to the browser on these by a ratchet (`raster-vs-chromium.test.ts`): the engine
// may not disagree with Chromium on more pixels than it did when the baseline was recorded.
// ---------------------------------------------------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generate(count: number): RasterShape[] {
  const r = prng(0xa57e12)
  const between = (lo: number, hi: number): number => lo + r() * (hi - lo)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const q = (v: number): number => Math.round(v * 8) / 8 // eighths of a pixel: the subpixel positions that matter
  const shapes: RasterShape[] = []
  for (let i = 0; i < count; i++) {
    const w = 24 + Math.floor(r() * 56)
    const h = 24 + Math.floor(r() * 56)
    const kind = i % 8
    const cmds: Cmd[] = [...fillBlack]
    if (r() < 0.3) cmds.push({ set: 'globalAlpha', value: pick([0.25, 0.5, 0.8]) })
    let name: string
    if (kind === 0) { // a circle at a random radius and subpixel position
      const rad = q(between(0.6, Math.min(w, h) / 2 - 1))
      cmds.push(['beginPath'], ['arc', q(between(rad + 1, w - rad - 1)), q(between(rad + 1, h - rad - 1)), rad, 0, 2 * Math.PI, false], ['fill'])
      name = `circle r=${rad}`
    } else if (kind === 1) { // an arc of any sweep, either direction, closed to its chord
      const rad = q(between(3, Math.min(w, h) / 2 - 2))
      const a0 = between(0, 2 * Math.PI)
      const sweep = between(0.2, 6.5)
      const ccw = r() < 0.4
      cmds.push(['beginPath'], ['moveTo', q(w / 2), q(h / 2)], ['arc', q(w / 2), q(h / 2), rad, a0, a0 + (ccw ? -sweep : sweep), ccw], ['closePath'], ['fill'])
      name = `arc r=${rad} sweep=${sweep.toFixed(2)}${ccw ? ' ccw' : ''}`
    } else if (kind === 2) { // a scaled and rotated circle: an ellipse
      const rad = q(between(2, 10))
      cmds.push(['save'], ['translate', q(w / 2), q(h / 2)], ['rotate', between(0, Math.PI)], ['scale', between(0.4, 3), between(0.4, 3)], ['beginPath'], ['arc', 0, 0, rad, 0, 2 * Math.PI, false], ['fill'], ['restore'])
      name = 'ellipse'
    } else if (kind === 3) { // a cubic blob through random control points
      const p = () => [q(between(1, w - 1)), q(between(1, h - 1))]
      const [a, b, c, d] = [p(), p(), p(), p()]
      cmds.push(['beginPath'], ['moveTo', ...a!], ['bezierCurveTo', ...b!, ...c!, ...d!], ['closePath'], ['fill'])
      name = 'cubic'
    } else if (kind === 4) { // a chain of quads
      const p = () => [q(between(1, w - 1)), q(between(1, h - 1))]
      cmds.push(['beginPath'], ['moveTo', ...p()!])
      for (let k = 0; k < 3; k++) cmds.push(['quadraticCurveTo', ...p()!, ...p()!])
      cmds.push(['closePath'], ['fill'])
      name = 'quads'
    } else if (kind === 5) { // a random polygon
      cmds.push(['beginPath'], ['moveTo', q(between(1, w - 1)), q(between(1, h - 1))])
      for (let k = 0; k < 2 + Math.floor(r() * 5); k++) cmds.push(['lineTo', q(between(1, w - 1)), q(between(1, h - 1))])
      cmds.push(['closePath'], ['fill'])
      name = 'polygon'
    } else if (kind === 6) { // a stroked polyline
      const wid = q(between(0.5, 6))
      const cap = pick(['butt', 'round', 'square'])
      const join = pick(['miter', 'round', 'bevel'])
      cmds.push(['beginPath'], ['moveTo', q(between(2, w - 2)), q(between(2, h - 2))])
      for (let k = 0; k < 2 + Math.floor(r() * 3); k++) cmds.push(['lineTo', q(between(2, w - 2)), q(between(2, h - 2))])
      if (r() < 0.3) cmds.push(['closePath'])
      for (const c of stroke(wid, cap, join, r() < 0.3 ? [q(between(1, 6)), q(between(1, 6))] : [])) cmds.push(c)
      name = `stroke w=${wid} ${cap} ${join}`
    } else { // a stroked curve
      const wid = q(between(0.5, 5))
      const p = () => [q(between(2, w - 2)), q(between(2, h - 2))]
      cmds.push(['beginPath'], ['moveTo', ...p()!], ['bezierCurveTo', ...p()!, ...p()!, ...p()!], ...stroke(wid, pick(['butt', 'round']), pick(['miter', 'round'])))
      name = `stroked cubic w=${wid}`
    }
    shapes.push({ name: `generated ${i} ${name}`, w, h, cmds })
  }
  return shapes
}

export const GENERATED_SHAPES: RasterShape[] = generate(96)
