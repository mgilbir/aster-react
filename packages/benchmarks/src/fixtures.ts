/**
 * Deterministic benchmark fixtures: seeded data generators and Vega specs
 * (same shapes as the conformance corpus, scaled up) plus helpers to
 * produce updated specs without mutating the previous one.
 */

export type Row = Record<string, unknown>
export type ChartKind = 'line' | 'bar' | 'scatter'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fresh dataset values for a given chart kind. Different seeds => different values. */
export function genValues(kind: ChartKind, points: number, seed: number): Row[] {
  const rnd = mulberry32(seed)
  const rows: Row[] = []
  switch (kind) {
    case 'line':
      for (let i = 0; i < points; i++) rows.push({ x: i, y: rnd() * 100 })
      break
    case 'scatter':
      for (let i = 0; i < points; i++) rows.push({ x: rnd() * 100, y: rnd() * 100 })
      break
    case 'bar':
      for (let i = 0; i < points; i++) rows.push({ cat: `c${i}`, val: rnd() * 100 })
      break
  }
  return rows
}

const AXES = [
  { scale: 'x', orient: 'bottom', grid: true, labels: false },
  { scale: 'y', orient: 'left', grid: true, labels: false },
]

export function buildSpec(kind: ChartKind, values: Row[], width: number, height: number): Record<string, unknown> {
  const base = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width,
    height,
    padding: 5,
    background: 'white',
    autosize: 'none',
    data: [{ name: 'table', values }],
  }
  switch (kind) {
    case 'line':
    case 'scatter': {
      return {
        ...base,
        scales: [
          { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width', nice: true },
          { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' }, range: [{ signal: 'height' }, 0], nice: true },
        ],
        axes: AXES,
        marks:
          kind === 'line'
            ? [
                {
                  type: 'line',
                  from: { data: 'table' },
                  encode: {
                    update: {
                      x: { scale: 'x', field: 'x' },
                      y: { scale: 'y', field: 'y' },
                      stroke: { value: 'steelblue' },
                    },
                  },
                },
              ]
            : [
                {
                  type: 'symbol',
                  from: { data: 'table' },
                  encode: {
                    update: {
                      x: { scale: 'x', field: 'x' },
                      y: { scale: 'y', field: 'y' },
                      size: { value: 80 },
                      fill: { value: 'steelblue' },
                      stroke: { value: 'white' },
                      strokeWidth: { value: 1 },
                    },
                  },
                },
              ],
      }
    }
    case 'bar':
      return {
        ...base,
        scales: [
          { name: 'x', type: 'band', domain: { data: 'table', field: 'cat' }, range: 'width', padding: 0.2 },
          { name: 'y', type: 'linear', domain: { data: 'table', field: 'val' }, range: [{ signal: 'height' }, 0], nice: true },
        ],
        axes: AXES,
        marks: [
          {
            type: 'rect',
            from: { data: 'table' },
            encode: {
              update: {
                x: { scale: 'x', field: 'cat' },
                width: { scale: 'x', band: 1 },
                y: { scale: 'y', field: 'val' },
                y2: { scale: 'y', value: 0 },
                fill: { value: 'steelblue' },
              },
            },
          },
        ],
      }
  }
}

export function firstDataset(spec: Record<string, unknown>): { name: string; values: Row[] } {
  const d = (spec.data as { name: string; values: Row[] }[])[0] as { name: string; values: Row[] }
  return { name: d.name, values: d.values }
}
