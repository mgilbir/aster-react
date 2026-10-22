#!/usr/bin/env node
// One chart per **property value Vega's own schema declares**, compared with upstream.
//
// The corpora in this repository are collections of charts: the fixtures, Vega-Lite's examples,
// specifications from GitHub. Every one of them is a sample of what people *draw*, which is
// exactly why they stop finding anything once the engine agrees with them. What they cannot reach
// is a property nobody happened to use, or a value of it nobody happened to choose:
// `tickBand: "extent"`, `labelOverlap: "greedy"`, `align: "all"`, `bandPosition: 0`. Those are not
// exotic; they are simply not in anybody's chart.
//
// `vega/build/vega-schema.json` is the list of them, and it is machine-readable: every guide,
// scale and mark property with its type, and for the many that take a word, the enumeration of the
// words. This walks that schema and writes one small chart per (property, value) pair, so the
// sweep covers the declared surface rather than the used one. The sweep test (sweep_test.go)
// renders each case with upstream and with the engine and compares the SVG.
//
// ### What is swept, and what is left out
//
// Ten kinds of family: `axis`, `legend`, `title`, `scale`, **projection**, the **view** itself, the
// **layout** of a group of groups, the **config block** behind a guide, a mark or a **range name**,
// a **mark's own properties**, and the **encode channels** every mark item carries. The guides are
// where the code is densest (a guide is a layout, a text measurement and half a dozen marks), a
// projection is a formula and a clipping rule whose difference is invisible until it is drawn, a
// config is the same property table reached by a different piece of code, and the last two are the
// widest declared surface there is: sixty channels, most of which no chart in any corpus sets. A
// property is swept when the schema says enough to choose values honestly:
//
//   * an **enum**, including one inside a `oneOf` beside a signal reference: every word it lists;
//   * a **boolean**: both;
//   * a **number**: a small fixed set, since the schema does not say what a sensible one is;
//   * a **number array** of a stated length: one plausible tuple.
//
// Anything else is skipped and *counted*: a free string (there is no honest value to choose), an
// object whose shape is another definition, a property that names something the base chart does
// not have. The generator returns the skips with their reason, so the sweep's coverage is a number
// somebody can read rather than a claim.
//
// ### The base chart
//
// One bar chart, deliberately ordinary and deliberately complete: a band scale and a linear scale,
// an ordinal colour scale with a legend, an axis on the bottom and one on the left, and a title. A
// property is applied to *one* place in it (the bottom axis, the legend, the title, or the named
// scale) so a difference the sweep reports names the property that caused it.
//
// Three families bring their own, because the chart a property means anything on is the family's
// own question: a scale type gets [scaleBaseSpec], a mark type gets its entry in [MARK_BASES], and
// a projection gets [projectionBaseSpec], which is a small map rather than a bar chart.
//
// The `layout` family brings [layoutBaseSpec], a trellis: a layout property is a relationship
// between cells, and every other chart here has one group or none.
//
// A `config-<guide>` family keeps the base chart and writes the property into `config` instead of
// onto the guide. It reaches **both** axes where the `axis` family reaches only the first.
//
// A `config-<marktype>` family writes the same *encode channel* the `encode-<marktype>` family
// writes, into `config` instead of onto the mark. Upstream folds those defaults into the mark's
// `enter` block (`applyDefaults`) so every channel reaches them through the one path it already
// uses, which is exactly what makes the route worth sweeping separately from the channel.
//
// A value upstream refuses is not dropped: the case is kept, and the comparison records "upstream
// will not draw this either" as an agreement (the "refused" column of the scoreboard). A sweep
// that quietly dropped them would be reporting a match rate over a corpus nobody can name.
//
// Everything that needs a module (vega, vega-projection) or a file under the oracle's
// node_modules (the schema, upstream's lookup tables) is read inside `generate(ctx)`, since a
// generator cannot import packages by name.


import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Set by init(ctx), before anything below runs.
let vega;
let schema;
let projectionProperties;
let pathCurves;
let pathSymbols;
let nodeModules;
let PROJECTION_TYPES;
let RANGE_NAMES;
let VOCABULARY;
let FAMILIES;

/** The chart every swept property is applied to. */
function baseSpec() {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200,
    height: 120,
    padding: 5,
    title: { text: 'Quarterly totals', subtitle: 'by region' },
    data: [
      {
        name: 't',
        values: [
          { c: 'alpha', v: 28, g: 'north' },
          { c: 'beta', v: 55, g: 'south' },
          { c: 'gamma', v: 43, g: 'north' },
          { c: 'delta', v: 91, g: 'east' },
        ],
      },
    ],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
      { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
      { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
    ],
    axes: [
      // grid: true on both so every grid property (gridColor, gridDash, gridCap, gridOpacity...)
      // reaches something visible; with the default (no grid) they swept nothing.
      { orient: 'bottom', scale: 'x', title: 'category', grid: true },
      { orient: 'left', scale: 'y', title: 'amount', tickCount: 4, grid: true },
    ],
    legends: [{ fill: 'colour', title: 'region' }],
    marks: [
      {
        type: 'rect',
        from: { data: 't' },
        encode: {
          enter: {
            x: { scale: 'x', field: 'c' },
            width: { scale: 'x', band: 1 },
            y: { scale: 'y', field: 'v' },
            y2: { scale: 'y', value: 0 },
            fill: { scale: 'colour', field: 'g' },
          },
        },
      },
    ],
  };
}


/**
 * One chart per **scale type**, because a scale's properties are its type's.
 *
 * The scale family had been swept through the band branch of the schema's `oneOf` — one of twelve —
 * and a `base` belongs to a log scale, an `exponent` to a power one and a `constant` to a symlog.
 * Nine properties were unreachable that way: those three and `clamp`, `zero`, `nice`, `bins`,
 * `domainImplicit` and `interpolate`. Scale arithmetic is also the least forgiving thing here — a
 * tick sequence, a rounded domain, an inverted position — so an unswept branch is a quiet place for
 * a difference to live.
 *
 * Each base puts the swept scale on the **y** axis with an axis drawn against it, so the ticks it
 * generates, the labels they carry and the marks they place are all compared. The data suits the
 * type: a log scale needs a domain clear of zero, a quantile needs enough values to have quantiles,
 * a time scale needs dates. `identity` takes pixel values straight from the data.
 */
const SCALE_ROWS = {
  positive: [
    { c: 'alpha', v: 3, g: 'north' },
    { c: 'beta', v: 40, g: 'south' },
    { c: 'gamma', v: 900, g: 'east' },
  ],
  spread: [
    { c: 'alpha', v: 8, g: 'north' },
    { c: 'beta', v: 17, g: 'south' },
    { c: 'gamma', v: 31, g: 'east' },
    { c: 'delta', v: 54, g: 'north' },
    { c: 'epsilon', v: 76, g: 'south' },
    { c: 'zeta', v: 95, g: 'east' },
  ],
  dated: [
    { c: 'alpha', v: '2024-01-07T00:00:00', g: 'north' },
    { c: 'beta', v: '2024-03-19T00:00:00', g: 'south' },
    { c: 'gamma', v: '2024-08-02T00:00:00', g: 'east' },
  ],
  pixels: [
    { c: 'alpha', v: 20, g: 'north' },
    { c: 'beta', v: 60, g: 'south' },
    { c: 'gamma', v: 110, g: 'east' },
  ],
};

/** The scale each base declares, keyed by the type the schema branch names. */
const SCALE_BASES = {
  linear: { rows: 'spread', scale: { type: 'linear', range: 'height' } },
  sqrt: { rows: 'spread', scale: { type: 'sqrt', range: 'height' } },
  log: { rows: 'positive', scale: { type: 'log', range: 'height' } },
  pow: { rows: 'spread', scale: { type: 'pow', range: 'height' } },
  symlog: { rows: 'spread', scale: { type: 'symlog', range: 'height' } },
  time: { rows: 'dated', scale: { type: 'time', range: 'height' } },
  utc: { rows: 'dated', scale: { type: 'utc', range: 'height' } },
  quantize: { rows: 'spread', scale: { type: 'quantize', range: 'height' } },
  threshold: {
    rows: 'spread',
    // A threshold scale's domain is the boundaries themselves, and its range is one longer.
    scale: { type: 'threshold', domain: [20, 50, 80], range: [10, 40, 80, 118] },
  },
  quantile: { rows: 'spread', scale: { type: 'quantile', range: [10, 40, 80, 118] } },
  'bin-ordinal': {
    rows: 'spread',
    scale: { type: 'bin-ordinal', domain: [0, 25, 50, 75, 100], range: [10, 40, 80, 118] },
  },
  ordinal: { rows: 'spread', scale: { type: 'ordinal', range: [10, 40, 80, 118, 90, 30] } },
  point: { rows: 'spread', scale: { type: 'point', range: 'height' } },
  identity: { rows: 'pixels', scale: { type: 'identity' } },
};

/**
 * A chart whose **y** scale is of one type, with an axis and a symbol per row drawn against it.
 *
 * Symbols rather than bars, because half of these scales have no zero to draw a bar down to: a
 * point placed by the scale is the one encoding every type here can satisfy. The band scale along
 * the bottom stays as it is in the base chart, so a difference belongs to the scale being swept.
 */
function scaleBaseSpec(type) {
  const base = SCALE_BASES[type];
  const rows = SCALE_ROWS[base.rows];
  const dated = base.rows === 'dated';
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200,
    height: 120,
    padding: 5,
    background: 'white',
    data: [
      {
        name: 't',
        values: rows,
        ...(dated ? { format: { parse: { v: 'date' } } } : {}),
      },
    ],
    scales: [
      {
        name: 'y',
        domain: base.scale.domain ?? { data: 't', field: 'v' },
        ...base.scale,
      },
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
    ],
    axes: [
      { orient: 'left', scale: 'y', title: 'amount' },
      { orient: 'bottom', scale: 'x' },
    ],
    marks: [
      {
        type: 'symbol',
        from: { data: 't' },
        encode: {
          enter: {
            x: { scale: 'x', field: 'c', band: 0.5 },
            y: { scale: 'y', field: 'v' },
            size: { value: 80 },
            fill: { value: 'steelblue' },
          },
        },
      },
    ],
  };
}

/**
 * One mark of each type, drawn from the same three rows, for the channel sweep.
 *
 * Deliberately plain: enough encoding to put the mark on the chart and nothing more, so a swept
 * channel is the only thing that varies. `image` is absent — it needs a file to load, and a
 * comparison that fetched one would be measuring the network.
 */
const MARK_BASES = {
  rect: () => ({
    type: 'rect',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c' },
        width: { scale: 'x', band: 1 },
        y: { scale: 'y', field: 'v' },
        y2: { scale: 'y', value: 0 },
        fill: { value: 'steelblue' },
      },
    },
  }),
  symbol: () => ({
    type: 'symbol',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        size: { value: 200 },
        fill: { value: 'steelblue' },
      },
    },
  }),
  text: () => ({
    type: 'text',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        text: { field: 'c' },
        fill: { value: '#333333' },
      },
    },
  }),
  line: () => ({
    type: 'line',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        stroke: { value: 'steelblue' },
        strokeWidth: { value: 2 },
      },
    },
  }),
  area: () => ({
    type: 'area',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        y2: { scale: 'y', value: 0 },
        fill: { value: 'steelblue' },
      },
    },
  }),
  arc: () => ({
    type: 'arc',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { value: 60 },
        startAngle: { value: 0 },
        endAngle: { value: 2 },
        outerRadius: { value: 25 },
        innerRadius: { value: 8 },
        fill: { value: 'steelblue' },
      },
    },
  }),
  rule: () => ({
    type: 'rule',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        y2: { scale: 'y', value: 0 },
        stroke: { value: '#333333' },
        strokeWidth: { value: 2 },
      },
    },
  }),
  path: () => ({
    type: 'path',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        path: { value: 'M-8,0L0,-12L8,0Z' },
        fill: { value: 'steelblue' },
      },
    },
  }),
  trail: () => ({
    type: 'trail',
    from: { data: 't' },
    encode: {
      enter: {
        x: { scale: 'x', field: 'c', band: 0.5 },
        y: { scale: 'y', field: 'v' },
        size: { value: 6 },
        fill: { value: 'steelblue' },
      },
    },
  }),
};

/** Where each family's property is written into the base chart. */
/**
 * Every projection upstream registers, read from its own registry table.
 *
 * `vega-projection` exports a **lookup** and no enumeration — `projection(type)` answers one or
 * null — so the names come out of the table that fills it, and each is then put back through that
 * lookup by [verified]. The keys are written bare there rather than quoted, which is why the table
 * reader takes a pattern.
 *
 * Seventeen, and the registry lowercases both what it stores and what it is asked for, so the
 * spelling a specification uses never matters. `equalEarth` and `naturalEarth1` are written in the
 * table with capitals and stored without them; the names here are the stored ones.
 */
function loadProjectionTypes() {
  return verified(
  tableKeys(
    'vega-projection/src/projections.js',
    'const projections = {',
    /^ {2}([A-Za-z0-9]+):/gm,
  ).map((name) => name.toLowerCase()),
    (name) => vega.projection(name),
    'projections',
  );
}

/**
 * The geography every projection family draws, small enough to write down and chosen to be awkward.
 *
 * A projection is a formula plus a **clipping rule**, and the formula is the easy half. What
 * separates one port from another is what happens at the edges: a polygon that reaches the pole,
 * one that crosses the antimeridian and has to be cut in two and stitched to the seam, a line with
 * no area to it, and a bare point, which is drawn by `pointRadius` rather than by the projection at
 * all. Rings wind counter-clockwise, which is the exterior winding `d3-geo` reads as "the inside is
 * the small part"; wound the other way each of these would mean the whole sphere except itself.
 */
const GEOGRAPHY = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'block' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-100, 20],
            [-60, 20],
            [-60, 50],
            [-100, 50],
            [-100, 20],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'cap' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-30, 70],
            [30, 70],
            [30, 88],
            [-30, 88],
            [-30, 70],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'seam' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [160, -20],
            [-160, -20],
            [-160, 10],
            [160, 10],
            [160, -20],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'track' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [-120, -40],
          [0, 0],
          [120, 40],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'dot' },
      geometry: { type: 'Point', coordinates: [10, 45] },
    },
  ],
};

/** Four places to pin, which the `geopoint` transform turns into positions rather than outlines. */
const PINS = [
  { lon: -75, lat: 40 },
  { lon: 0, lat: 0 },
  { lon: 135, lat: -25 },
  { lon: 20, lat: 78 },
];

/**
 * The scale and translation a projection family starts from, so the map lands on the page.
 *
 * Every type's **own** defaults — `albers` at 1070 over a 960 by 500 page, `orthographic` at 249.5,
 * `identity` at 1 — are exercised by the projection corpus charts, so nothing here is trying to test
 * them again. What this is for is the properties, and a property is easier to read against a map
 * that is on the canvas.
 *
 * `identity` is the exception: its input is pixels rather than degrees, and 60 pixels per pixel is
 * not a map of anything.
 */
const PROJECTION_PLACEMENT = {
  identity: { scale: 1, translate: [100, 60] },
};

/**
 * A chart that draws [GEOGRAPHY] through one projection, with four pinned points beside it.
 *
 * Two comparisons rather than one, because a projection reaches the scene by two routes and they
 * fail differently. The `geoshape` transform turns geometry into a **path string**, which is where
 * clipping, resampling and winding live; the `geopoint` transform turns a longitude and a latitude
 * into an **x and a y**, which is the formula alone with nothing to hide behind. A projection whose
 * clip rule is wrong can still place every pin correctly, and a projection whose formula is off by a
 * constant still draws a plausible-looking map.
 */
function projectionBaseSpec(type) {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200,
    height: 120,
    padding: 5,
    background: 'white',
    data: [
      { name: 'geo', values: GEOGRAPHY, format: { type: 'json', property: 'features' } },
      {
        name: 'pins',
        values: PINS,
        transform: [
          { type: 'geopoint', projection: 'p', fields: ['lon', 'lat'], as: ['px', 'py'] },
        ],
      },
    ],
    projections: [
      { name: 'p', type, scale: 60, translate: [100, 60], ...(PROJECTION_PLACEMENT[type] || {}) },
    ],
    marks: [
      {
        type: 'shape',
        from: { data: 'geo' },
        encode: {
          enter: {
            fill: { value: '#cfd8dc' },
            stroke: { value: '#37474f' },
            strokeWidth: { value: 0.5 },
          },
        },
        transform: [{ type: 'geoshape', projection: 'p' }],
      },
      {
        type: 'symbol',
        from: { data: 'pins' },
        encode: {
          enter: {
            x: { field: 'px' },
            y: { field: 'py' },
            size: { value: 30 },
            fill: { value: '#b35a1f' },
          },
        },
      },
    ],
  };
}

/**
 * The six range names upstream's own configuration fills in, read from where it fills them.
 *
 * `config.range.category` is how every theme sets a palette: a scale that says `"range": "category"`
 * gets whatever the configuration put there, and upstream's default puts a scheme. The names are
 * six and the schema knows none of them — `config` is declared as `{"type": "object"}` — so they
 * come out of `vega-parser`'s own default configuration, at the one indent that holds the names
 * rather than the schemes inside them.
 */
function loadRangeNames() {
  return tableKeys(
  'vega-parser/src/config.js',
  '    range: {',
  /^ {6}([A-Za-z]+):/gm,
);
}

/**
 * A chart with one scale per range name, so a `config.range` entry has something to land on.
 *
 * Six scales and three rows of marks: the four colour ranges paint rects, the symbol range shapes a
 * row of symbols, and the diverging one paints a row of its own because its default carries an
 * `extent` of `[1, 0]` — it is the one range whose default reverses the scheme, and a chart that
 * reads the scheme and drops the extent is a chart with its colours the wrong way round.
 */
function rangeBaseSpec() {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 220,
    height: 120,
    padding: 5,
    background: 'white',
    data: [
      {
        name: 't',
        values: [
          { c: 'alpha', v: 10 },
          { c: 'beta', v: 45 },
          { c: 'gamma', v: 70 },
          { c: 'delta', v: 95 },
        ],
      },
    ],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
      { name: 'category', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
      { name: 'ordinal', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'ordinal' },
      { name: 'heatmap', type: 'linear', domain: { data: 't', field: 'v' }, range: 'heatmap' },
      { name: 'ramp', type: 'linear', domain: { data: 't', field: 'v' }, range: 'ramp' },
      { name: 'diverging', type: 'linear', domain: { data: 't', field: 'v' }, range: 'diverging' },
      { name: 'symbol', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'symbol' },
    ],
    marks: [
      ...['category', 'ordinal', 'heatmap', 'ramp', 'diverging'].map((scale, row) => ({
        type: 'rect',
        from: { data: 't' },
        encode: {
          enter: {
            x: { scale: 'x', field: 'c' },
            width: { scale: 'x', band: 1 },
            y: { value: row * 18 },
            height: { value: 16 },
            fill: { scale, field: scale === 'category' || scale === 'ordinal' ? 'c' : 'v' },
          },
        },
      })),
      {
        type: 'symbol',
        from: { data: 't' },
        encode: {
          enter: {
            x: { scale: 'x', field: 'c', band: 0.5 },
            y: { value: 102 },
            size: { value: 90 },
            shape: { scale: 'symbol', field: 'c' },
            fill: { value: '#555555' },
          },
        },
      },
    ],
  };
}

/**
 * A **trellis**, which is the only chart a `layout` means anything on.
 *
 * `layout` belongs to a group mark whose children are groups, and everything it decides is a
 * relationship *between* cells: how they line up, how far apart they sit, whether a narrow one
 * hugs the left of its column or floats in the middle of it. A chart with one group has no layout
 * to get wrong, which is why the base chart cannot serve here and why none of the other families
 * reaches this at all.
 *
 * Six cells of six different widths and two different heights, in a grid of three. The differences
 * are the point: `align`, `bounds` and `center` all answer "what about the cell that does not fill
 * its column", and every cell the same size is the one arrangement where their answers agree.
 *
 * Each cell carries a **title** so that `titleBand` and `titleAnchor` have a title to band and
 * anchor, and a bottom **axis** so that `bounds: "full"` has something sticking out of the cell to
 * measure — an axis is drawn outside its group's own rectangle, which is the whole difference
 * between `full` and `flush`.
 */
function layoutBaseSpec() {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 300,
    height: 170,
    padding: 5,
    background: 'white',
    data: [
      {
        name: 't',
        values: [
          { c: 'a', w: 20, h: 30, v: 3 },
          { c: 'b', w: 60, h: 44, v: 8 },
          { c: 'c', w: 100, h: 30, v: 5 },
          { c: 'd', w: 34, h: 44, v: 9 },
          { c: 'e', w: 74, h: 30, v: 2 },
          { c: 'f', w: 114, h: 44, v: 6 },
        ],
      },
    ],
    scales: [
      { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
    ],
    marks: [
      {
        type: 'group',
        layout: { columns: 3, padding: 12 },
        marks: [
          {
            type: 'group',
            // Grouped by all three, so the facet's own datum carries `w` and `h`: a facet group's
            // datum is the grouping key and nothing else, and a cell that reads `{field: 'w'}` off
            // one grouped by `c` alone finds no width at all.
            from: { facet: { data: 't', name: 'cell', groupby: ['c', 'w', 'h'] } },
            title: { text: { signal: 'parent.c' }, fontSize: 8 },
            encode: {
              enter: {
                width: { field: 'w' },
                height: { field: 'h' },
              },
            },
            scales: [
              { name: 'x', type: 'linear', domain: [0, 10], range: { signal: '[0, width]' } },
            ],
            axes: [{ orient: 'bottom', scale: 'x', tickCount: 2 }],
            marks: [
              {
                type: 'rect',
                from: { data: 'cell' },
                encode: {
                  enter: {
                    x: { value: 0 },
                    width: { scale: 'x', field: 'v' },
                    y: { value: 0 },
                    height: { value: 10 },
                    fill: { scale: 'colour', field: 'c' },
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * What a `config-<block>` family is a config **of**.
 *
 * Two things follow from the block's name and neither is derivable from it: which schema definition
 * its properties come from, and which family's skips and vocabularies apply to it. A guide config
 * carries that guide's own properties; a **mark** config carries *encode channels* — `fill`,
 * `stroke`, `size`, the same table a mark item's encode block uses, which is not at all the table
 * the plain `mark` family sweeps (`clip`, `interactive`, `aria`, a mark's own properties). Upstream
 * says so itself: "defaults for basic mark types — each subset accepts mark properties (fill,
 * stroke, etc)".
 */
const CONFIG_BLOCKS = {
  axis: { definition: 'axis', like: 'axis' },
  legend: { definition: 'legend', like: 'legend' },
  title: { definition: 'title', like: 'title' },
  // `config.mark` is every mark type's defaults; `config.style.<name>` is the same table reached by
  // a name a mark carries; `config.<marktype>` is one type's.
  mark: { definition: 'encodeEntry', like: 'encode' },
  style: { definition: 'encodeEntry', like: 'encode' },
  // `config.range` is its own thing: its properties are range *names* rather than any guide's or
  // mark's, so nothing else's skips or vocabularies apply to it.
  range: { definition: null, like: 'config-range' },
  ...Object.fromEntries(
    Object.keys(MARK_BASES).map((type) => [type, { definition: 'encodeEntry', like: 'encode' }]),
  ),
};

function buildFamilies() {
  return {
  // The **bottom** axis, which is the one with a band scale under it: half of what an axis property
  // decides — `tickBand`, `bandPosition`, `labelOverlap` — only means anything over bands.
  axis: (spec, property, value) => {
    spec.axes[0][property] = value;
  },
  legend: (spec, property, value) => {
    spec.legends[0][property] = value;
  },
  title: (spec, property, value) => {
    spec.title[property] = value;
  },
  // The **band** scale, for the same reason: `align`, `padding`, `round` and `reverse` are its
  // properties, and a linear scale ignores most of them.
  scale: (spec, property, value) => {
    spec.scales[0][property] = value;
  },
  // One family per **scale type**, for the reason the mark types have one each: which properties
  // mean anything is the type's own question, and the schema says so in twelve `oneOf` branches
  // that nothing but the band one had been read from. See [SCALE_BASES].
  ...Object.fromEntries(
    Object.keys(SCALE_BASES).map((type) => [
      `scale-${type}`,
      (spec, property, value) => {
        spec.scales[0][property] = value;
      },
    ]),
  ),
  // `config.range.<name>`: the six palettes a theme sets, and the one place a chart says "whatever
  // the theme thinks a category looks like" rather than naming colours itself. Its properties are
  // the names rather than anything the schema declares, for the reason every `config` family has:
  // the schema declares `config` as an object and says nothing about what goes in it.
  'config-range': (spec, property, value) => {
    spec.config = { range: { [property]: value } };
  },
  // The **view** itself: the five properties a specification writes beside its marks, which decide
  // how big the drawing is rather than what is in it. Every case the sweep compares already checks
  // the surface, so this is the one family whose whole subject is the number every other family
  // checks in passing.
  view: (spec, property, value) => {
    spec[property] = value;
  },
  // The **layout** of a group of groups, which is a subsystem no other family reaches: every other
  // chart here has one group or none, and a layout property is a relationship between cells.
  layout: (spec, property, value) => {
    spec.marks[0].layout[property] = value;
  },
  // One family per **guide config block**, which is the same property table reached by a different
  // route. `config.axis.labelAngle` and an axis's own `labelAngle` are the same property and a
  // different piece of code: upstream reads every axis property through `lookup(spec, config)`,
  // which answers `spec[prop] ?? config[prop]`, so a property an implementation reads off the
  // specification alone is honoured there and ignored here — silently, and for every chart that
  // sets a theme rather than an axis.
  //
  // Five properties are the exception and they are the reason to sweep this rather than reason
  // about it: `tickCount`, `values`, `tickMinStep`, `format` and `formatType` are read as
  // `spec.tickCount` and never through the lookup, so upstream ignores them in a config too.
  ...Object.fromEntries(
    ['axis', 'legend', 'title'].map((guide) => [
      `config-${guide}`,
      (spec, property, value) => {
        spec.config = spec.config || {};
        spec.config[guide] = { [property]: value };
      },
    ]),
  ),
  // The **mark** config blocks, which carry encode channels rather than a mark's own properties.
  //
  // Upstream resolves them as `extend({}, config.mark, config[type])` and then the mark's `style`
  // names in order — but its *default* configuration has already filled `config[type]` in, with a
  // rect's blue and a symbol's size of 64 and a text's font. So `config.mark` sits **below** those
  // built-ins and everything else sits above, which is why setting `config.mark.fill` does not
  // recolour a rect and setting `config.rect.fill` does. That ordering is the thing worth sweeping:
  // it is not the order the names suggest, and it differs per channel depending on whether the
  // type's built-in block mentions that channel at all.
  //
  // One family per type, for the reason the encode channels have one each: which channels mean
  // anything is the mark's own question, and only the type's own block can answer for the ones its
  // built-in already sets.
  ...Object.fromEntries(
    Object.keys(MARK_BASES).map((type) => [
      `config-${type}`,
      (spec, property, value) => {
        spec.marks = [MARK_BASES[type]()];
        spec.config = { [type]: { [property]: value } };
      },
    ]),
  ),
  'config-mark': (spec, property, value) => {
    spec.marks = [MARK_BASES.rect()];
    spec.config = { mark: { [property]: value } };
  },
  // A **style** is the same table again, reached by a name the mark carries. Upstream applies the
  // named blocks after both mark blocks and in the order the mark lists them, so a style beats the
  // built-in a type's own block supplies where `config.mark` does not.
  'config-style': (spec, property, value) => {
    spec.marks = [MARK_BASES.rect()];
    spec.marks[0].style = 'swept';
    spec.config = { style: { swept: { [property]: value } } };
  },
  // One family per **projection type**, for the reason the scales have one each: which properties
  // a projection has is the type's own question. `parallels` belongs to the four conics and to
  // nothing else; `albersUsa` is three projections in a trenchcoat and has neither a centre nor a
  // rotation to set; `identity` has no sphere and so no clip angle. Upstream's rule is a guard
  // rather than a refusal — `if (_[prop] != null && proj[prop])` — so a property a type does not
  // have is *ignored*, silently, and "ignored the same way" is exactly what wants comparing.
  ...Object.fromEntries(
    PROJECTION_TYPES.map((type) => [
      `projection-${type}`,
      (spec, property, value) => {
        spec.projections[0][property] = value;
      },
    ]),
  ),
  // The bar mark's own properties — `clip`, `interactive`, `aria` and the rest — rather than its
  // channels.
  mark: (spec, property, value) => {
    spec.marks[0][property] = value;
  },
  // An **encode channel**, written into the mark's `enter` block as a literal value. Sixty of them
  // are declared and a bar chart reads perhaps eight, so this is the widest gap between what the
  // schema says and what any corpus exercises.
  //
  // One family per **mark type**, because which channels mean anything is the mark's own question:
  // a rect ignores `tension`, a line ignores `cornerRadius`, and only an arc reads `padAngle`. The
  // channel table is swept in full against each of them rather than against a guess at which pairs
  // matter — a pair that draws nothing is an agreement like any other, and the one place it is not
  // is exactly what this is for.
  //
  // **The position channels are swept too**, and they overwrite what the base chart encodes. They
  // were held back while the base was a bar chart and the reason — "the geometry the base chart
  // encodes from its own data" — stopped being true once each mark type brought its own base: what
  // a written `x2`, `width` or `yc` does is upstream's own resolution rule, `x`/`x2`/`width` being
  // two of three with the third derived, and it differs by mark type. A swept value replaces one
  // side of that pair, which is the case the rule is *for*. Same for `defined`, which needs a line
  // or an area to break and now has both, and for `size`, which needed a symbol.
  ...Object.fromEntries(
    Object.entries(MARK_BASES).map(([type, mark]) => [
      `encode-${type}`,
      (spec, property, value) => {
        spec.marks = [mark()];
        spec.marks[0].encode.enter[property] = { value };
      },
    ]),
  ),
  };
}

/**
 * Properties left out on purpose, with the reason recorded rather than assumed.
 *
 * Three kinds: what identifies a thing rather than styles it, what this base chart has nowhere to
 * put, and what needs a value no schema can supply.
 *
 * Keyed by **family first**, because the same name means different things in two of them: a
 * legend's `fill` names the scale it describes and a mark's `fill` is a colour, and skipping the
 * second for the first one's reason quietly dropped six channels from the sweep.
 */
const SHARED_SKIP = {
  name: 'names the object rather than styling it',
  scale: 'names the scale rather than styling it',
  type: 'the scale type; sweeping it rebuilds the chart rather than varying it',
  domain: 'needs data of its own',
  domainRaw: 'needs data of its own',
  domainMin: 'needs data of its own',
  domainMax: 'needs data of its own',
  domainMid: 'needs data of its own',
  range: 'needs a range of its own',
  rangeMin: 'needs a range of its own',
  rangeMax: 'needs a range of its own',
  values: 'needs values of its own',
  encode: 'a block of encoders rather than a value',
  style: 'names config blocks the base chart does not declare',
  interactive: 'no pointer in a static render',
  format: 'a format specifier, which the schema does not enumerate',
  formatType: 'meaningless without a matching format',
  text: 'the title text itself',
  subtitle: 'the subtitle text itself',
  scheme: 'a scheme name, swept through range instead',
  reverse: 'covered by the boolean sweep of the scale family',
  bins: 'needs bin boundaries of its own',
  init: 'an initial value for an interactive scale',
  on: 'event handlers, which a static render never fires',
  // A mark's own structure rather than its appearance: sweeping these builds a different chart
  // instead of varying one.
  from: 'names the data the mark is drawn from',
  marks: 'nested marks, which is a different chart',
  transform: 'a pipeline of its own',
  sort: 'needs a field to sort by',
  key: 'names the field items are matched by',
  role: 'names what the mark is, which the engine derives',
  // Channels that need a value the schema does not carry.
  url: 'an image to load, which a static comparison has nowhere to fetch from',
  path: 'an SVG path, and the schema says only that it is a string',
  text: 'the text of a text mark',
  tooltip: 'a value no static scene shows',
};

/**
 * Properties that really are open strings, and what makes each one open.
 *
 * The distinction this draws is the point of [VOCABULARY]: a property upstream *checks* against a
 * table has a vocabulary and belongs in the sweep, and a property upstream *passes through* has
 * none and cannot be swept honestly. A font name is the clearest case — `fontStyle` is concatenated
 * straight into the CSS font string, so the set of legal values belongs to the text engine on the
 * other side rather than to Vega, and any word this invented would be testing the platform.
 *
 * Recorded per property so the skip list says which kind of gap each skip is, rather than repeating
 * one sentence 121 times.
 */
const FREE_STRINGS = {
  font: 'a font family, resolved by whatever engine measures the text rather than by Vega',
  labelFont: 'a font family; see `font`',
  titleFont: 'a font family; see `font`',
  subtitleFont: 'a font family; see `font`',
  fontStyle: 'concatenated into the CSS font string verbatim; Vega checks it against nothing',
  labelFontStyle: 'concatenated into the CSS font string verbatim; see `fontStyle`',
  titleFontStyle: 'concatenated into the CSS font string verbatim; see `fontStyle`',
  subtitleFontStyle: 'concatenated into the CSS font string verbatim; see `fontStyle`',
  cursor: 'a CSS cursor name, emitted verbatim; no pointer in a static render reads it',
  ariaRole: 'an ARIA role, emitted verbatim',
  ariaRoleDescription: 'an ARIA role description, emitted verbatim',
  description: 'prose, emitted verbatim',
  title: 'the guide title itself, which is text rather than a setting',
  ellipsis: "the string a truncated label ends with; `item.ellipsis || '…'` accepts any",
  lineBreak: 'the separator `text.split(item.lineBreak)` uses; any string is one',
  gridScale: 'names a second scale for the grid to span, which is structure rather than style',
};

/**
 * The family a per-type one belongs to: `encode-rect` is an `encode`, `scale-log` is a `scale`.
 *
 * What a property *means* is the base family's question — a legend's `fill` names a scale whichever
 * legend it is — and what it may be **worth** is often the specific one's. Keeping the two apart is
 * why the skips and the vocabularies are looked up through here rather than by an exact name.
 */
function baseFamily(family) {
  // A **config block** is the guide it configures: `config.legend.fill` names a scale for exactly
  // the reason a legend's own `fill` does, and the skips and vocabularies that belong to the guide
  // have to reach the config route too or the sweep starts offering a legend the name of a scale
  // that is not there.
  if (family.startsWith('config-')) return CONFIG_BLOCKS[family.slice('config-'.length)].like;
  const dash = family.indexOf('-');
  return dash < 0 ? family : family.slice(0, dash);
}

/**
 * Why a property is not swept in a family, or nothing if it is.
 *
 * Three tables, most specific first, and the **first one that mentions the property** decides — so a
 * family may state `null` and mean "swept here", which a shared skip cannot then override. That is
 * not a nicety: `scale` names a scale everywhere in a specification except on a projection, where it
 * is the zoom, and the shared skip had quietly taken the most consequential number a map has.
 */
function skipReason(family, property) {
  for (const table of [FAMILY_SKIP[family], FAMILY_SKIP[baseFamily(family)], SHARED_SKIP]) {
    if (table && property in table) return table[property];
  }
  return undefined;
}

/** Skips that belong to **one** family, where the same name means something else in another. */
const FAMILY_SKIP = {
  scale: {
    // A scale's `interpolate` is **not** a mark's: it is the space the *range* is interpolated
    // through — `'interpolate' + type.split('-').map(titleCase).join('')` in `vega-scale` — and what
    // may legally go there depends on what the range is made of. Every scale base here ranges over
    // pixels, where a colour space means nothing; and of d3's interpolators, `transform-css` and
    // `transform-svg` reach for a DOM and throw in a headless oracle, which would file an
    // *environment* as a refusal and make this sweep say different things on different machines.
    // It wants a colour-ranged base of its own, which is its own change.
    interpolate: 'the space a range interpolates through, which needs a range that has one',
  },
  projection: {
    name: 'names the projection every mark and transform here refers to',
    // The family *is* the type: `projection-mercator` sets it, and sweeping it as a property would
    // write a second type over the first and file the difference under the wrong one.
    type: 'the family it belongs to already fixes it, one family per registered type',
    // **Not** skipped here, against the shared rule. Everywhere else in a specification `scale` is
    // the name of a scale; on a projection it is a number, the zoom, and it is the single property
    // a map is most obviously wrong about.
    scale: null,
  },
  legend: {
    fill: 'names the scale a legend describes',
    stroke: 'names the scale a legend describes',
    size: 'names the scale a legend describes',
    shape: 'names the scale a legend describes',
    opacity: 'names the scale a legend describes',
    strokeDash: 'names the scale a legend describes',
    strokeWidth: 'names the scale a legend describes',
  },
};

/**
 * The properties a family declares, dug out of however the schema spells that family.
 *
 * Three spellings, and each one says something: an `axis` is a plain object; a `legend` is an
 * `allOf` of the shared part and the per-kind parts, so every branch's properties belong to it; and
 * a `title` or a `scale` is a `oneOf` — a title may be written as a bare string, and a scale is a
 * different object for every scale type.
 *
 * **Which branch of a `oneOf`** is the family's own question, and for a long time the answer was
 * always the band one: a `scale-log` family reads the log branch and finds `base` there, where the
 * band branch has never heard of it. Nine properties were reachable through no family at all until
 * the scale types got one each.
 */
/**
 * The top-level properties, which the schema states in an `allOf` beside a `$ref` to a scope.
 *
 * `width`, `height`, `padding`, `autosize`, `background`, `style` and `description` — everything a
 * specification says about the drawing as a whole rather than about anything in it.
 */
function viewProperties() {
  const block = schema.allOf.find((branch) => branch.properties);
  const { $schema: _ignored, config: _alsoIgnored, ...rest } = block.properties;
  return rest;
}

function propertiesOf(family) {
  if (family === 'view') return viewProperties();
  // A range name is a *key*, not a declared property: the schema has no word for any of them, so
  // there is no fragment to read values out of and [FAMILY_VOCABULARY] states them instead.
  if (family === 'config-range') return Object.fromEntries(RANGE_NAMES.map((n) => [n, {}]));
  // Every `encode-<marktype>` family reads the same channel table; the mark type decides which of
  // them mean anything, not which of them exist.
  const named = family.startsWith('encode-')
    ? 'encodeEntry'
    : family.startsWith('scale-')
      ? 'scale'
      : family.startsWith('projection-')
        ? 'projection'
        : family.startsWith('config-')
          ? CONFIG_BLOCKS[family.slice('config-'.length)].definition
          : family;
  // A `scale-log` wants the branch that names `log`; everything else keeps the band branch, which
  // is the scale the plain `scale` family applies its properties to.
  const wanted = family.startsWith('scale-') ? family.slice('scale-'.length) : 'band';
  const definition = schema.definitions[named];
  const merged = {};
  const visit = (fragment) => {
    if (!fragment) return;
    if (fragment.properties) Object.assign(merged, fragment.properties);
    for (const branch of fragment.allOf || []) visit(branch);
    if (fragment.oneOf) {
      const branches = fragment.oneOf.filter((b) => b.properties);
      const chosen = branches.find(
        (b) => b.properties.type && (b.properties.type.enum || []).includes(wanted),
      );
      visit(chosen || branches[0]);
    }
  };
  visit(definition);
  if (family.startsWith('projection-')) {
    for (const property of projectionProperties) {
      if (!merged[property]) merged[property] = codePropertyShape(property);
    }
  }
  if (!Object.keys(merged).length) {
    throw new Error(`the schema has no properties for '${family}'`);
  }
  return merged;
}

/**
 * The shape of a projection property the schema does not declare, asked of the projection itself.
 *
 * `vega-projection` exports `projectionProperties`, nineteen names it forwards to whichever of them
 * the projection turns out to have, and the schema declares only eight of those — `reflectX` and
 * `reflectY` are missing from it, and so are the nine that belong to `d3-geo-projection`'s extended
 * families. This is the same hole [VOCABULARY] fills for `interpolate` and `shape`: a vocabulary
 * upstream keeps in code.
 *
 * The shape is **read off a live projection** rather than written down here — a fresh one is asked
 * for its current value and the type of that answer is the type the setter takes. The nine extended
 * properties have no owner among the seventeen registered types, so nothing in this package can be
 * asked what they take; they are offered a number, and what is being compared there is that all
 * seventeen ignore them, which is upstream's `if (_[prop] != null && proj[prop])`.
 */
function codePropertyShape(property) {
  for (const type of PROJECTION_TYPES) {
    const projection = vega.projection(type)();
    if (typeof projection[property] === 'function') {
      return typeof projection[property]() === 'boolean' ? { type: 'boolean' } : { type: 'number' };
    }
  }
  return { type: 'number' };
}

/**
 * The keys of a lookup table in one of upstream's own source files.
 *
 * Several properties the schema types as a bare `string` have a **closed vocabulary** all the same,
 * kept in upstream's code rather than in its schema: `interpolate` is one of seventeen curve names
 * and `shape` is one of twelve symbol names, and anything else is silently not drawn. The schema
 * cannot say so — a custom SVG path is also a legal `shape` — so a sweep that reads only the schema
 * skips the whole of both, which is 26 cases of real geometry.
 *
 * Read out of the pinned source rather than transcribed here, so the list cannot drift from the
 * package: a name added upstream appears in the sweep on the next `npm ci`. Every name is then put
 * back through upstream's own lookup by [verified], so a broken extraction fails loudly instead of
 * quietly sweeping nothing.
 */
function tableKeys(file, declaration, pattern = /^ {2}'([^']+)':/gm) {
  const source = readFileSync(join(nodeModules, file), 'utf8');
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`the table '${declaration}' is not in ${file}`);
  const body = source.slice(start);
  const table = body.slice(0, body.indexOf('\n};'));
  // Top-level quoted keys only — two spaces, a quoted name, a colon — so the nested `draw` and
  // `tension` entries inside each record are not mistaken for names of their own. The projection
  // registry writes its keys bare rather than quoted, which is the one place the pattern differs.
  const keys = [...table.matchAll(pattern)].map((match) => match[1]);
  if (!keys.length) throw new Error(`no keys found in '${declaration}' of ${file}`);
  return keys;
}

/** Every name upstream's own lookup accepts, which is the check that the extraction still works. */
function verified(names, lookup, what) {
  const accepted = names.filter((name) => lookup(name) != null);
  if (accepted.length !== names.length) {
    const rejected = names.filter((name) => lookup(name) == null);
    throw new Error(`upstream does not know these ${what}: ${rejected.join(', ')}`);
  }
  return accepted;
}

/**
 * Vocabularies the schema leaves open and upstream's code closes, with where each one comes from.
 *
 * Keyed by property name, and applied wherever the schema has nothing enumerable to say. The skips
 * these replace were honest when the sweep only read the schema; they were also the largest single
 * hole in it.
 */
function buildVocabulary() {
  const VOCABULARY = {
  // `vega-scenegraph/src/path/curves.js`, whose `lookup` is the whole of what `interpolate` may be.
  interpolate: verified(
    tableKeys('vega-scenegraph/src/path/curves.js', 'const lookup = {'),
    pathCurves,
    'curves',
  ),
  // `vega-scenegraph/src/path/symbols.js`. A `shape` may also be an SVG path — `symbols()` falls
  // back to `customSymbol` — and `path-marks` covers that; these are the named twelve.
  shape: verified(
    tableKeys('vega-scenegraph/src/path/symbols.js', 'const builtins = {'),
    pathSymbols,
    'symbols',
  ),
  // `item.dir === 'rtl'` in `vega-scenegraph/src/util/text.js`, which is a two-valued test: a
  // right-to-left run is laid out from the other end, and every other string means left-to-right.
  dir: ['ltr', 'rtl'],
};

/** `symbolType` is a legend's word for the same twelve names. */
VOCABULARY.symbolType = VOCABULARY.shape;
  return VOCABULARY;
}


/**
 * Properties whose vocabulary the schema states **under another name**.
 *
 * An axis's `domainCap` is a stroke cap; the schema declines to enumerate it and enumerates
 * `strokeCap` — the same three words, for the same canvas property — two definitions away. Taking
 * the enumeration from there keeps this schema-driven rather than transcribed.
 */
const VOCABULARY_ALIAS = {
  domainCap: 'strokeCap',
  gridCap: 'strokeCap',
  tickCap: 'strokeCap',
};

/**
 * Values that belong to **one family**, where the schema declares a shape rather than a number.
 *
 * Unlike [VOCABULARY], which only answers where the schema is silent, these answer **first**. They
 * exist for the properties whose schema declaration describes a *container* — "an object or an
 * array", "an array of arrays" — where the generic rules either read it as a plain number pair or
 * give up entirely. A projection's `rotate` is `[lambda, phi]` or `[lambda, phi, gamma]` of numbers
 * or signals, and the array rule wants `items.type === 'number'` and finds a reference instead; its
 * `clipExtent` is a rectangle written as two corners; its `fit` is a piece of geometry.
 *
 * `fit` is the one that matters most. It is how a chart says "make this map fill the page" without
 * knowing a single constant, it resolves to `fitExtent` or `fitSize` depending on which of `extent`
 * and `size` it is given, and it has been wrong here before: a composite projection was fitted by
 * setting a scale and a translation the composite ignores, and drew at its unfitted default. Left to
 * the array rule it was offered `[4, 2]`, which is not geometry at all.
 */
/** The one colour tried where the schema says a colour, chosen to be unlike every default. */
const COLOUR = '#b35a1f';

const FAMILY_VOCABULARY = {
  // A range is set three ways and all three are ordinary: a **scheme** by name, the colours written
  // **out**, and — for a diverging one — a scheme with an `extent` that reads part of it or turns
  // it round. The defaults themselves use two of the three, `symbol` being a written-out list of
  // shape names where the rest are schemes.
  'config-range': {
    category: {
      kind: 'scheme, and the colours written out',
      values: [{ scheme: 'dark2' }, ['#552255', '#225522', '#222255', '#552222']],
    },
    ordinal: { kind: 'scheme', values: [{ scheme: 'greens' }, { scheme: 'greys', count: 3 }] },
    heatmap: { kind: 'scheme', values: [{ scheme: 'magma' }] },
    ramp: { kind: 'scheme', values: [{ scheme: 'purples' }, { scheme: 'purples', extent: [1, 0] }] },
    // `[1, 0]` rather than `[0, 1]`: an override *replaces* the default entry, so a diverging range
    // given only a scheme already reads it forwards — the two cases would draw the same colours and
    // compare nothing. Reversing it is the case worth having, and it is what the default itself
    // does.
    diverging: {
      kind: 'scheme, with and without an extent',
      values: [{ scheme: 'purplegreen' }, { scheme: 'purplegreen', extent: [1, 0] }],
    },
    // Shapes whose **outlines** differ, not merely their names: a cross, a diamond and a square all
    // measure the same square box at a given size, so a row of them says nothing about which shape
    // was drawn. Outlines that differ show in the SVG path data; names would not.
    symbol: {
      kind: 'the shape names written out',
      values: [
        ['circle', 'triangle-up', 'wedge'],
        ['wedge', 'triangle'],
      ],
    },
  },
  view: {
    // The schema declares `autosize` as **either** a word or an object, and the object is where
    // `contains` and `resize` live: `contains: "padding"` makes the stated width include the
    // padding rather than sit inside it, which moves every mark in the chart. Sweeping the enum
    // alone — which is what the generic rules pick — leaves both unreached.
    autosize: {
      kind: 'enum and the object form',
      values: [
        'pad',
        'fit',
        'fit-x',
        'fit-y',
        'none',
        { type: 'fit', contains: 'padding' },
        { type: 'pad', contains: 'padding' },
        { type: 'fit', resize: true },
      ],
    },
    // Likewise: a number, or one number per side. A chart padded unevenly is the ordinary case for
    // anything with a legend on one side.
    padding: {
      kind: 'number and the per-side form',
      values: [0, 8, { top: 2, bottom: 12, left: 20, right: 4 }],
    },
    background: { kind: 'colour', values: [COLOUR] },
  },
  projection: {
    // Two and three, because the third is a **roll** about the axis the first two point along and
    // reaches a different part of the rotation than either of the others.
    rotate: {
      kind: 'array (degrees about each axis)',
      values: [
        [60, -20],
        [60, -20, 15],
      ],
    },
    center: { kind: 'array (a longitude and a latitude)', values: [[-40, 25]] },
    // Two standard parallels, which only the four conics have — and what the other thirteen do with
    // a pair they have no setter for is the thing worth comparing.
    parallels: { kind: 'array (two standard parallels)', values: [[20, 50]] },
    translate: { kind: 'array (a point on the page)', values: [[110, 55]] },
    size: { kind: 'array (a width and a height)', values: [[180, 100]] },
    clipExtent: {
      kind: 'array (a rectangle in page coordinates)',
      values: [
        [
          [5, 5],
          [150, 90],
        ],
      ],
    },
    extent: {
      kind: 'array (a rectangle in page coordinates)',
      values: [
        [
          [10, 10],
          [190, 110],
        ],
      ],
    },
    fit: { kind: 'geojson', values: [GEOGRAPHY] },
  },
};

/** The numbers tried for a `number`-typed property, and why these. */
const NUMBERS = [0, 0.5, 8, -4];


/**
 * Every branch a schema fragment can take, with `$ref`s followed.
 *
 * Following them is what makes the sweep reach the properties worth sweeping: `labelOverlap`,
 * `tickBand`, `tickExtra` and `tickCount` are all a bare `$ref`, so a reader that stopped at the
 * reference saw no values at all and skipped exactly the ones no chart in any corpus sets. The
 * depth cap is against the encoder-value definitions, which nest through `rule`, `stringModifiers`
 * and back into themselves; nothing useful is picked out of those, and the cap keeps the walk
 * finite rather than trusting that.
 */
function branchesOf(fragment, depth = 0) {
  if (!fragment || depth > 8) return [];
  if (fragment.$ref) {
    const name = fragment.$ref.split('/').pop();
    return branchesOf(schema.definitions[name], depth + 1);
  }
  const nested = fragment.oneOf || fragment.anyOf || fragment.allOf;
  if (nested) return nested.flatMap((branch) => branchesOf(branch, depth + 1));
  // An **encoder value**, which is where a channel's own enumeration lives: a channel is declared
  // as `{"value": {"enum": […]}}` rather than as the enum itself, because a channel may equally be
  // a field, a scale lookup or a signal. Following the `value` property is what makes the sixty
  // encode channels reachable at all; without it every one of them read as unenumerable.
  if (fragment.properties && fragment.properties.value) {
    return branchesOf(fragment.properties.value, depth + 1);
  }
  return [fragment];
}

/**
 * Collects the candidate values for a property: what the schema declares, or what upstream fixes.
 *
 * The schema is asked first and always. [VOCABULARY] only answers where it has nothing enumerable
 * to say, so a property the schema *does* enumerate can never be overridden by a list kept here.
 */
function valuesFor(fragment, property, family) {
  // A family answers **before** the schema for the few properties whose declaration is a container
  // rather than a value: `fit` is "an object or an array", and the generic array rule reads that as
  // a number pair and offers a projection `[4, 2]` to fit itself to. Everywhere else the order is
  // the other way round and the schema decides; see [FAMILY_VOCABULARY].
  const forFamily = (FAMILY_VOCABULARY[baseFamily(family)] || {})[property];
  if (forFamily) return forFamily;

  const declared = declaredValues(fragment);
  if (declared) return declared;

  const alias = VOCABULARY_ALIAS[property];
  if (alias) {
    const aliased = declaredValues(schema.definitions.encodeEntry.properties[alias]);
    if (aliased) return { ...aliased, kind: `enum (as ${alias})` };
  }
  const known = VOCABULARY[property];
  if (known) return { kind: 'enum (upstream)', values: known };
  return null;
}

/** Collects the candidate values a schema fragment declares, or null where there are none. */
function declaredValues(fragment) {
  const branches = branchesOf(fragment);
  for (const branch of branches) {
    // `null` is in several of these enumerations as "unset", which is what leaving the property out
    // already tests.
    if (branch.enum) {
      const values = branch.enum.filter((v) => v !== null);
      if (values.length) return { kind: 'enum', values };
    }
  }
  for (const branch of branches) {
    if (branch.type === 'boolean') return { kind: 'boolean', values: [true, false] };
  }
  for (const branch of branches) {
    if (branch.type === 'number') return { kind: 'number', values: NUMBERS };
  }
  // A colour is named by the definition it references rather than by the property's name, so this
  // stays schema-driven: `titleColor` is `oneOf [null, string, colorValue]`, and the bare `string`
  // branch on its own would be skipped as a free string.
  if (JSON.stringify(fragment).includes('colorValue')) {
    return { kind: 'colour', values: [COLOUR] };
  }
  // An array, **whether or not it says what is in it**. `strokeDash` is the case that matters and
  // its `value` branch is a bare `{"type": "array"}`: requiring `items.type === 'number'` dropped
  // the dash pattern from every one of the nine mark types, which is the one array-valued channel
  // there is. A property this offers a dash tuple to and cannot use records a refusal, which is
  // what the skip and refusal counts are for.
  for (const branch of branches) {
    if (branch.type === 'array' && (!branch.items || branch.items.type === 'number')) {
      return { kind: 'array', values: [[4, 2]] };
    }
  }
  return null;
}

/** A file-name-safe spelling of a value. */
function slug(value) {
  return JSON.stringify(value)
    .replace(/[^A-Za-z0-9.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'blank';
}

/** Reads what the generator needs from the context; see the header for why it is not imported. */
function init(ctx) {
  vega = ctx.vega;
  // Port note: upstream (aster Go) reads from its vendored oracle node_modules.
  // Here `ctx.nodeModules` is the package directory that contains `vega/` and
  // `vega-scenegraph/` (the pnpm virtual store for our pinned vega build).
  nodeModules = ctx.nodeModules;
  // Read rather than imported: the package does not export its build directory, and the schema is
  // data this reads rather than a module it depends on.
  schema = JSON.parse(readFileSync(join(nodeModules, 'vega/build/vega-schema.json'), 'utf8'));
  projectionProperties = ctx.require(join(nodeModules, 'vega-projection/index.js')).projectionProperties;
  pathCurves = vega.pathCurves;
  pathSymbols = vega.pathSymbols;
  PROJECTION_TYPES = loadProjectionTypes();
  RANGE_NAMES = loadRangeNames();
  VOCABULARY = buildVocabulary();
  FAMILIES = buildFamilies();
}

export function generate(ctx) {
  init(ctx);
  const cases = [];
  const skips = [];
  const used = new Map();

  for (const [family, apply] of Object.entries(FAMILIES)) {
    const definition = propertiesOf(family);
    for (const [property, fragment] of Object.entries(definition)) {
      const reason = skipReason(family, property);
      if (reason) {
        skips.push({ family, property, reason });
        continue;
      }
      const candidates = valuesFor(fragment, property, family);
      if (!candidates) {
        skips.push({
          family,
          property,
          reason:
            FREE_STRINGS[property] ||
            'the schema declares no enumerable value here, and upstream fixes no vocabulary for it',
        });
        continue;
      }
      for (const value of candidates.values) {
        const spec = family.startsWith('scale-')
          ? scaleBaseSpec(family.slice('scale-'.length))
          : family.startsWith('projection-')
            ? projectionBaseSpec(family.slice('projection-'.length))
            : family === 'layout'
              ? layoutBaseSpec()
              : family === 'config-range'
                ? rangeBaseSpec()
                : baseSpec();
        apply(spec, property, value);
        // A name that has already been used gets a number: two values can slug the same way
        // (`0` and `-0`, `"a b"` and `"a_b"`) and a second case replacing the first would silently
        // shrink the sweep.
        let name = `${family}-${property}-${slug(value)}`;
        if (used.has(name)) name = `${name}-${used.get(name) + 1}`;
        used.set(name, (used.get(name) || 0) + 1);
        cases.push({ name, family, property, spec });
      }
    }
  }
  return { cases, skips };
}
