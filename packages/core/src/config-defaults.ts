/**
 * Vega's default configuration (vega-parser `config.js`) and its merge rule
 * (vega-util `mergeConfig`).
 *
 * A Vega view is parsed with `mergeConfig(defaults(), userConfig, spec.config)`, and
 * every mark, axis, legend, title and scale reads its defaults through that
 * merged config: a raw Vega `symbol` mark with no encode gets `size: 64` and
 * `fill: #4c78a8` because `config.symbol` says so, a `rect` gets the `#4c78a8`
 * fill, a `line` its stroke and width, `text` its font and size. Vega-Lite specs
 * compile to a spec that restates most of these, which is why only raw Vega
 * specs ever showed the gap (N1). Applying the merged config once, at compile
 * time, is the general mechanism: no mark type is special-cased.
 */

const DEFAULT_FONT = 'sans-serif'
const DEFAULT_SYMBOL_SIZE = 30
const DEFAULT_STROKE_WIDTH = 2
const DEFAULT_COLOR = '#4c78a8'
const BLACK = '#000'
const GRAY = '#888'
const LIGHT_GRAY = '#ddd'

type Cfg = Record<string, unknown>

/** vega-parser `defaultConfig()`: a fresh object on every call (callers may keep it). */
export function vegaDefaultConfig(): Cfg {
  return {
    description: 'Vega visualization',
    padding: 0,
    autosize: 'pad',
    background: null,
    events: { defaults: { allow: ['wheel'] } },
    group: null,
    mark: null,
    arc: { fill: DEFAULT_COLOR },
    area: { fill: DEFAULT_COLOR },
    image: null,
    line: { stroke: DEFAULT_COLOR, strokeWidth: DEFAULT_STROKE_WIDTH },
    path: { stroke: DEFAULT_COLOR },
    rect: { fill: DEFAULT_COLOR },
    rule: { stroke: BLACK },
    shape: { stroke: DEFAULT_COLOR },
    symbol: { fill: DEFAULT_COLOR, size: 64 },
    text: { fill: BLACK, font: DEFAULT_FONT, fontSize: 11 },
    trail: { fill: DEFAULT_COLOR, size: DEFAULT_STROKE_WIDTH },
    style: {
      'guide-label': { fill: BLACK, font: DEFAULT_FONT, fontSize: 10 },
      'guide-title': { fill: BLACK, font: DEFAULT_FONT, fontSize: 11, fontWeight: 'bold' },
      'group-title': { fill: BLACK, font: DEFAULT_FONT, fontSize: 13, fontWeight: 'bold' },
      'group-subtitle': { fill: BLACK, font: DEFAULT_FONT, fontSize: 12 },
      point: { size: DEFAULT_SYMBOL_SIZE, strokeWidth: DEFAULT_STROKE_WIDTH, shape: 'circle' },
      circle: { size: DEFAULT_SYMBOL_SIZE, strokeWidth: DEFAULT_STROKE_WIDTH },
      square: { size: DEFAULT_SYMBOL_SIZE, strokeWidth: DEFAULT_STROKE_WIDTH, shape: 'square' },
      cell: { fill: 'transparent', stroke: LIGHT_GRAY },
      view: { fill: 'transparent' },
    },
    title: { orient: 'top', anchor: 'middle', offset: 4, subtitlePadding: 3 },
    axis: {
      minExtent: 0,
      maxExtent: 200,
      bandPosition: 0.5,
      domain: true,
      domainWidth: 1,
      domainColor: GRAY,
      grid: false,
      gridWidth: 1,
      gridColor: LIGHT_GRAY,
      labels: true,
      labelAngle: 0,
      labelLimit: 180,
      labelOffset: 0,
      labelPadding: 2,
      ticks: true,
      tickColor: GRAY,
      tickOffset: 0,
      tickRound: true,
      tickSize: 5,
      tickWidth: 1,
      titlePadding: 4,
    },
    axisBand: { tickOffset: -0.5 },
    projection: { type: 'mercator' },
    legend: {
      orient: 'right',
      padding: 0,
      gridAlign: 'each',
      columnPadding: 10,
      rowPadding: 2,
      symbolDirection: 'vertical',
      gradientDirection: 'vertical',
      gradientLength: 200,
      gradientThickness: 16,
      gradientStrokeColor: LIGHT_GRAY,
      gradientStrokeWidth: 0,
      gradientLabelOffset: 2,
      labelAlign: 'left',
      labelBaseline: 'middle',
      labelLimit: 160,
      labelOffset: 4,
      labelOverlap: true,
      symbolLimit: 30,
      symbolType: 'circle',
      symbolSize: 100,
      symbolOffset: 0,
      symbolStrokeWidth: 1.5,
      symbolBaseFillColor: 'transparent',
      symbolBaseStrokeColor: GRAY,
      titleLimit: 180,
      titleOrient: 'top',
      titlePadding: 5,
      layout: {
        offset: 18,
        direction: 'horizontal',
        left: { direction: 'vertical' },
        right: { direction: 'vertical' },
      },
    },
    range: {
      category: { scheme: 'tableau10' },
      ordinal: { scheme: 'blues' },
      heatmap: { scheme: 'yellowgreenblue' },
      ramp: { scheme: 'blues' },
      diverging: { scheme: 'blueorange', extent: [1, 0] },
      symbol: ['circle', 'square', 'triangle-up', 'cross', 'diamond', 'triangle-right', 'triangle-down', 'triangle-left'],
    },
  }
}

const legalKey = (k: string): boolean => k !== '__proto__' && k !== 'constructor' && k !== 'prototype'
const isObj = (v: unknown): v is Cfg => v !== null && typeof v === 'object' && !Array.isArray(v)

function writeConfig(out: Cfg, key: string, value: unknown, recurse?: boolean | Record<string, unknown> | null): void {
  if (!legalKey(key)) return
  if (isObj(value)) {
    const o = (isObj(out[key]) ? out[key] : (out[key] = {})) as Cfg
    for (const k of Object.keys(value)) {
      if (recurse && (recurse === true || (recurse as Record<string, unknown>)[k])) writeConfig(o, k, value[k])
      else if (legalKey(k)) o[k] = value[k]
    }
  } else {
    out[key] = value
  }
}

/**
 * vega-util `mergeConfig`: signals merge by name (later wins), the `legend`
 * block recurses into `layout`, the `style` block recurses into every named
 * style, every other block is a one-level overwrite (a user `axis` object
 * replaces the keys it names, not the whole default axis).
 */
export function mergeVegaConfig(...configs: Array<Cfg | undefined | null>): Cfg {
  const out: Cfg = {}
  for (const source of configs) {
    if (!source) continue
    for (const key of Object.keys(source)) {
      if (key === 'signals') {
        const named = new Map<string, unknown>()
        const merged: unknown[] = []
        for (const list of [source.signals, out.signals]) {
          if (!Array.isArray(list)) continue
          for (const sig of list) {
            const name = (sig as { name?: string }).name as string
            if (!named.has(name)) { named.set(name, 1); merged.push(sig) }
          }
        }
        out.signals = merged
      } else {
        writeConfig(out, key, source[key], key === 'legend' ? { layout: 1 } : key === 'style' ? true : null)
      }
    }
  }
  return out
}


let DEFAULT_MERGED: Cfg | undefined
/**
 * `mergeVegaConfig(vegaDefaultConfig())`, once, frozen: the config of every spec that gives none. Nothing reads a config
 * and writes it back, so the compiled charts of such specs share it, and what is derived from it (the guides' config
 * blocks, their marks) can be shared too.
 */
export function defaultMergedConfig(): Cfg {
  if (DEFAULT_MERGED === undefined) {
    const deepFreeze = (o: unknown): void => {
      if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o)
        for (const k of Object.keys(o)) deepFreeze((o as Record<string, unknown>)[k])
      }
    }
    DEFAULT_MERGED = mergeVegaConfig(vegaDefaultConfig())
    deepFreeze(DEFAULT_MERGED)
  }
  return DEFAULT_MERGED
}
