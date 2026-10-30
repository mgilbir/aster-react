/**
 * Generated `wordcloud` specs (seeded) for wordcloud-vs-vega.test.ts: the size of the cloud, the words (repeated, unicode, a word
 * too long to place, one too large for the sheet), the font (family, style, weight), the font size as a constant or a field scaled
 * into a range, the rotation as a constant, a field or `random()`, the padding and the spiral.
 */
export type Spec = Record<string, unknown>

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VOCABULARY = [
  'vega', 'declarative', 'visualization', 'grammar', 'interaction', 'signals', 'dataflow', 'reactive', 'scenegraph', 'encode', 'Zoë',
  'données', 'naïve', 'über', 'wordcloud', 'layout', 'sprite', 'collision', 'spiral', 'archimedean', 'rectangular', 'padding', 'WWW', 'iii', 'gjpqy',
  'x', 'It', 'Quick', 'brown', 'Fox', 'jumps', 'lazy', 'dog', 'ÅÄÖ', 'thequickbrownfoxjumpsoverthelazydogagainandagain',
]
const FAMILIES = ['sans-serif', 'serif', 'monospace', 'Helvetica Neue, Arial', 'Georgia, serif', 'Courier New, monospace']

export function wordcloudCase(seed: number): { id: string; spec: Spec } {
  const r = stream(seed * 7919 + 13)
  const int = (n: number): number => Math.floor(r() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!
  const chance = (p: number): boolean => r() < p

  const count = 3 + int(chance(0.3) ? 60 : 25)
  const sameCount = chance(0.12)
  const values = Array.from({ length: count }, () => ({
    text: pick(VOCABULARY),
    count: sameCount ? 5 : 1 + int(chance(0.5) ? 5 : 100),
    angle: pick([-90, -45, 0, 0, 30, 45, 90]),
    weight: pick(['normal', 'bold', '300', '600']),
  }))
  const size: [number, number] = pick([[300, 200], [500, 500], [640, 360], [800, 400], [200, 300], [400, 100]] as Array<[number, number]>)
  const rotate: unknown = pick<unknown>([0, 0, 45, { field: 'datum.angle' }, { field: 'datum.angle' }, { expr: '[-45, 0, 45][~~(random() * 3)]' }, { expr: 'datum.datum.count > 50 ? 90 : 0' }])
  const fontSize: unknown = pick<unknown>([{ field: 'datum.count' }, { field: 'datum.count' }, { expr: 'sqrt(datum.datum.count) * 4' }, 18, 30, { field: 'datum.count' }])
  const transform: Spec = {
    type: 'wordcloud',
    size,
    text: { field: 'text' },
    rotate,
    font: pick(FAMILIES),
    fontSize,
    ...(chance(0.7) ? { fontSizeRange: pick<unknown>([[12, 56], [10, 50], [8, 30], [20, 40]]) } : {}),
    ...(chance(0.5) ? { fontStyle: pick(['normal', 'italic']) } : {}),
    ...(chance(0.6) ? { fontWeight: chance(0.5) ? { field: 'datum.weight' } : pick(['bold', 'normal', '600']) } : {}),
    ...(chance(0.8) ? { padding: pick([0, 1, 2, 3, 5]) } : {}),
    ...(chance(0.25) ? { spiral: 'rectangular' } : {}),
  }
  const spec: Spec = {
    width: size[0], height: size[1], padding: 0, autosize: 'none',
    data: [{ name: 'table', values }],
    marks: [{
      type: 'text',
      from: { data: 'table' },
      encode: {
        enter: { text: { field: 'text' }, align: { value: 'center' }, baseline: { value: 'alphabetic' }, fill: { value: '#222' } },
        update: { fillOpacity: { value: 1 } },
      },
      transform: [transform],
    }],
  }
  return { id: `cloud-${seed}`, spec }
}

