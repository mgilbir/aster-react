/** Seeded generator of text marks for the text differentials (limit, ellipsis, dir, font, size, angle, polar offset, multi-line). */

type Spec = Record<string, unknown>

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = ['The', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'wiii', 'mmmm', 'a', 'I', 'extraordinarily', 'שלום', 'مرحبا', 'ñandú', '東京', 'x'.repeat(14)]
const FONTS = [undefined, 'sans-serif', 'serif', 'monospace', 'Helvetica, Arial']

export function textCase(seed: number): { spec: Spec; features: string[] } {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const maybe = (p: number): boolean => r() < p
  const features: string[] = []
  const sentence = (): string => Array.from({ length: 1 + Math.floor(r() * 9) }, () => pick(WORDS)).join(pick([' ', ' ', ' ', '  ']))
  const n = 1 + Math.floor(r() * 3)
  const update: Record<string, unknown> = {
    x: { field: 'x' }, y: { field: 'y' }, text: { field: 'text' }, fill: { value: '#222' },
  }
  const set = (k: string, v: unknown): void => { update[k] = { value: v } }
  if (maybe(0.75)) { set('limit', pick([0, -5, 1, 8, 20, 33, 45, 60, 90, 140, 400, '30'])); features.push('limit') }
  if (maybe(0.5)) { set('ellipsis', pick(['', '', '...', '→', '~~~~~~~~~~', '…', ' ', '--'])); features.push('ellipsis') }
  if (maybe(0.4)) { set('dir', pick(['rtl', 'rtl', 'ltr', 'bogus'])); features.push('dir') }
  if (maybe(0.5)) set('fontSize', pick([0, 6, 10, 11, 12, 16, 24, 40, -4]))
  const font = pick(FONTS)
  if (font) set('font', font)
  if (maybe(0.2)) set('fontWeight', pick(['bold', 700, 'normal']))
  if (maybe(0.2)) set('fontStyle', 'italic')
  if (maybe(0.4)) set('angle', pick([0, 30, -45, 90, 180, 359.5]))
  if (maybe(0.5)) set('align', pick(['left', 'center', 'right', 'nonsense']))
  if (maybe(0.5)) set('baseline', pick(['alphabetic', 'top', 'middle', 'bottom', 'line-top', 'line-bottom']))
  if (maybe(0.3)) set('dx', pick([-6, 3, 10]))
  if (maybe(0.3)) set('dy', pick([-4, 5, 12]))
  if (maybe(0.3)) set('lineHeight', pick([8, 14, 20]))
  if (maybe(0.15)) set('stroke', '#900')
  if (maybe(0.4)) { set('radius', pick([0, 10, 25, 60, -20])); set('theta', pick([0, 0.5, 1.2, 3.1416, -2])); features.push('radius') }
  else if (maybe(0.1)) { update.radius = { field: 'r' }; update.theta = { field: 't' }; features.push('radius') }
  const multi = pick(['none', 'none', 'break', 'array'])
  const rows = Array.from({ length: n }, (_, i) => {
    let text: unknown = sentence()
    if (multi === 'break') { text = `${sentence()}\n${sentence()}`; features.push('lineBreak') }
    else if (multi === 'array') { text = [sentence(), sentence(), ...(maybe(0.3) ? [sentence()] : [])]; features.push('array') }
    return { x: 20 + Math.floor(r() * 200), y: 20 + i * 45 + Math.floor(r() * 20), text, r: 5 + i * 9, t: i * 1.1 }
  })
  const mark: Record<string, unknown> = { type: 'text', from: { data: 't' }, encode: { update } }
  if (multi === 'break') (update as Record<string, unknown>).lineBreak = { value: '\n' }
  return {
    features,
    spec: { width: 260, height: 160, padding: 5, autosize: 'pad', data: [{ name: 't', values: rows }], marks: [mark] },
  }
}

