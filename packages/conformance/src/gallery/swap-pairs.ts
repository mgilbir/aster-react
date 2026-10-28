/**
 * The sample of (A, B) spec pairs of the spec-swap path: ONE mounted <Chart> is given spec A, then spec B, and must show
 * what a fresh mount of B (and vega) shows. `generateSwapPairs` is the seeded selection that MADE gallery/swap-pairs.txt; the gate
 * runs that committed file, not this function (it depends on the passing lists, which other changes raise). Regenerate deliberately:
 * `pnpm conformance:gallery --regenerate-swap-pairs`.
 *
 * It is made of: the three pairs a playground user reported; every kind of spec that holds state across a prop change, as A (what is left
 * behind) and as B (what must start clean) -- timers, selections / event handlers, facets, maps; and a seeded random remainder.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GALLERY_DIR, listGallery, readSpec, type GallerySpec } from './lib.js'
import type { SwapPair } from './react.js'

export const SWAP_PAIRS_RANDOM = 140
export const SWAP_PAIRS_PER_CATEGORY = 10

const mulberry32 = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const CATEGORIES: Record<string, (json: string) => boolean> = {
  timer: (j) => /"timer"|\bnow\(\)/.test(j),
  selection: (j) => /"params"|"selection"|"on":\s*\[/.test(j),
  facet: (j) => /"facet"|"row"|"column"/.test(j),
  map: (j) => /"projection|"geoshape"|"geopath"|"type":\s*"shape"/.test(j),
}

export function generateSwapPairs(all: GallerySpec[] = listGallery()): SwapPair[] {
  const byId = new Map(all.map((g) => [g.id, g]))
  const rand = mulberry32(0x5eed)
  // B is a spec the fresh-mount gate already holds to vega, so "equals a fresh mount" and "equals vega" are the same claim for it
  const passing = readFileSync(join(GALLERY_DIR, 'passing-react.txt'), 'utf8').split('\n').filter(Boolean).map((id) => byId.get(id)).filter((g): g is GallerySpec => g !== undefined)
  // A is any spec <Chart> accepts at all: the passing ones, and every Vega spec (timers, force layouts and the rest that the fresh-mount gate cannot hold to vega)
  const left = all.filter((g) => g.kind === 'vega' || passing.includes(g))
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!
  const pairs: SwapPair[] = []
  const seen = new Set<string>()
  const add = (a: GallerySpec | undefined, b: GallerySpec | undefined): void => {
    if (!a || !b || a.id === b.id) return
    const id = `${a.id} => ${b.id}`
    if (seen.has(id)) return
    seen.add(id)
    pairs.push({ id, a, b })
  }
  // the reported ones
  add(byId.get('vega/donut-chart'), byId.get('vega/barley-trellis-plot'))
  add(byId.get('vega/radial-plot'), byId.get('vega/barley-trellis-plot'))
  add(byId.get('vega/donut-chart'), byId.get('vega/radial-plot'))
  // each category, as the spec left behind and as the spec that follows
  const json = new Map(all.map((g) => [g.id, JSON.stringify(readSpec(g))]))
  for (const [, test] of Object.entries(CATEGORIES)) {
    const members = left.filter((g) => test(json.get(g.id)!))
    const passingMembers = passing.filter((g) => test(json.get(g.id)!))
    for (let i = 0; i < SWAP_PAIRS_PER_CATEGORY; i++) add(pick(members), pick(passing))
    for (let i = 0; i < SWAP_PAIRS_PER_CATEGORY; i++) add(pick(left), pick(passingMembers))
  }
  for (let i = 0; i < SWAP_PAIRS_RANDOM; i++) add(pick(left), pick(passing))
  return pairs
}

export const SWAP_PAIRS_FILE = join(GALLERY_DIR, 'swap-pairs.txt')

/** The committed pair list: one `A => B` per line. */
export function readSwapPairIds(): string[] {
  return readFileSync(SWAP_PAIRS_FILE, 'utf8').split('\n').filter(Boolean)
}

/** Deliberately replace the committed list with a fresh seeded selection over the current passing lists. */
export function regenerateSwapPairs(): number {
  const pairs = generateSwapPairs()
  writeFileSync(SWAP_PAIRS_FILE, pairs.map((p) => p.id).sort().join('\n') + '\n')
  return pairs.length
}
