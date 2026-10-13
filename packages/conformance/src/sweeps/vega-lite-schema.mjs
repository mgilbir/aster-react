// One Vega-Lite specification per property value Vega-Lite's own schema
// declares. The test compares the Vega the engine compiles each into with the
// Vega upstream compiles it into.
//
// That is where a Vega-Lite defect lives. Vega-Lite's whole value is the
// defaults it supplies (a scale type, a stack transform, a tick count, a label
// angle, a band size) and every one of them is a property of the
// specification it emits. Comparing the emitted Vega names the rule that
// drifted; comparing the picture would say "some marks moved".
//
// The surface is much larger than Vega's: 458 definitions, a MarkDef of 88
// properties, an Encoding of 38 channels, a Config of 72. The fixture corpus
// covers what people draw; this covers what the schema says can be written.
//
// What is swept
//
// One family per mark type, sweeping the MarkDef table
// ({"mark": {"type": "bar", ...}}): which properties mean anything is the
// mark's own question, and cornerRadiusEnd belongs to a bar where interpolate
// belongs to a line.
//
// One family per encoding channel, sweeping the properties that channel's
// field definition declares ({"encoding": {"y": {"field": "c", ...}}}). What a
// property means is the channel's question, and a stack belongs to a position
// where a legend belongs to a colour. Several channels appear twice under
// different measures, because the measure is most of what decides the answer:
// an x over a number and an x over a date are different charts, and a rule
// that reads one correctly can still read the other wrong.
//
// A channel's chart gives the swept channel a column of the kind its own
// properties are about, and names that channel separately from the encoding:
// several of these charts need a second channel to be a chart at all, and a
// property written on the wrong one would be measuring that instead. The facet
// channels take a different column from the one on x for the same reason:
// sharing it makes upstream emit groupby: ["c", "c"] where a compiler that
// de-duplicates emits ["c"], and every case in both families then reports that
// one disagreement rather than the property it was there to try.
//
// One family per guide block a channel carries (axis, legend, header, scale),
// and one per configuration block; see GUIDE_CHARTS and CONFIG_CHARTS.
//
// Values are chosen from the schema and nothing else: an enum's words, both
// booleans, a small fixed set of numbers, one colour, one string. Anything the
// schema does not say enough about is skipped and counted, with its reason.
//
// A specification upstream refuses is still a case: "upstream will not compile
// this either" is an agreement, and the comparison records it as one.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The rows every chart here draws: a category, a number, a second number, and a date. */
const ROWS = [
  { c: 'alpha', v: 28, w: 3, t: '2024-01-07' },
  { c: 'beta', v: 55, w: 7, t: '2024-03-19' },
  { c: 'gamma', v: 43, w: 5, t: '2024-06-02' },
  { c: 'delta', v: 91, w: 9, t: '2024-09-11' },
];

const SCHEMA_URL = 'https://vega.github.io/schema/vega-lite/v6.json';

/**
 * The encoding each mark type is given, so that a swept property has a chart
 * to mean something on.
 *
 * Deliberately plain and deliberately complete for the type: an arc needs a
 * theta, a line needs an ordered x, a text needs something to write. A
 * property that means nothing on the chart it lands on is an agreement like
 * any other (both compilers ignore it) and the ones that do mean something are
 * the point.
 */
const MARK_ENCODINGS = {
  bar: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
  line: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } },
  area: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } },
  point: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } },
  circle: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } },
  square: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } },
  tick: { x: { field: 'v', type: 'quantitative' }, y: { field: 'c', type: 'nominal' } },
  rect: {
    x: { field: 'c', type: 'nominal' },
    y: { field: 't', type: 'ordinal' },
    color: { field: 'v', type: 'quantitative' },
  },
  rule: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
  text: {
    x: { field: 'c', type: 'nominal' },
    y: { field: 'v', type: 'quantitative' },
    text: { field: 'v', type: 'quantitative' },
  },
  arc: { theta: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } },
  trail: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } },
};

/** The chart a swept mark property is applied to. */
function markBaseSpec(type) {
  return {
    $schema: SCHEMA_URL,
    width: 200,
    height: 120,
    data: { values: ROWS },
    mark: { type },
    encoding: MARK_ENCODINGS[type],
  };
}

/**
 * The chart each swept encoding channel is applied to.
 *
 * One per channel rather than one for all of them, for the same reason the
 * mark families have one per type: a property is only worth comparing where
 * the channel it sits on is doing something. A bin on a nominal column and a
 * timeUnit on a number are agreements nobody learns from, so the column each
 * channel is given is the kind its own properties are about: w and v are
 * numbers, c is a category and t is a date.
 *
 * The swept channel is named separately from the encoding because several of
 * these charts need a second channel to be a chart at all, and a property
 * written on the wrong one would be measuring that instead.
 */
const CHANNEL_CHARTS = {
  x: { mark: 'point', channel: 'x', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } } },
  y: { mark: 'point', channel: 'y', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } } },
  'x-temporal': { mark: 'line', channel: 'x', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } } },
  'y-nominal': { mark: 'bar', channel: 'y', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'c', type: 'nominal' } } },
  x2: { mark: 'bar', channel: 'x2', encoding: { x: { field: 'w', type: 'quantitative' }, x2: { field: 'v' }, y: { field: 'c', type: 'nominal' } } },
  color: { mark: 'bar', channel: 'color', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'w', type: 'quantitative' } } },
  'color-nominal': { mark: 'bar', channel: 'color', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } },
  size: { mark: 'point', channel: 'size', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, size: { field: 'v', type: 'quantitative' } } },
  opacity: { mark: 'point', channel: 'opacity', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, opacity: { field: 'v', type: 'quantitative' } } },
  shape: { mark: 'point', channel: 'shape', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, shape: { field: 'c', type: 'nominal' } } },
  strokeWidth: { mark: 'point', channel: 'strokeWidth', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, strokeWidth: { field: 'v', type: 'quantitative' } } },
  text: { mark: 'text', channel: 'text', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, text: { field: 'v', type: 'quantitative' } } },
  detail: { mark: 'line', channel: 'detail', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' }, detail: { field: 'c', type: 'nominal' } } },
  order: { mark: 'line', channel: 'order', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' }, order: { field: 'w', type: 'quantitative' } } },
  theta: { mark: 'arc', channel: 'theta', encoding: { theta: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } },
  radius: { mark: 'arc', channel: 'radius', encoding: { theta: { field: 'v', type: 'quantitative' }, radius: { field: 'w', type: 'quantitative' } } },
  xOffset: { mark: 'bar', channel: 'xOffset', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, xOffset: { field: 'c', type: 'nominal' } } },
  row: { mark: 'bar', channel: 'row', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, row: { field: 't', type: 'ordinal' } } },
  column: { mark: 'bar', channel: 'column', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, column: { field: 't', type: 'ordinal' } } },
};

/** The chart a swept encoding property is applied to. */
function channelBaseSpec(key) {
  const chart = CHANNEL_CHARTS[key];
  return {
    $schema: SCHEMA_URL,
    width: 200,
    height: 120,
    data: { values: ROWS },
    mark: { type: chart.mark },
    encoding: structuredClone(chart.encoding),
  };
}

/**
 * The chart each swept configuration block is applied to, and the definition
 * it reads.
 *
 * A configuration is the third surface, and the one whose defaults are most of
 * what Vega-Lite is for. It is swept apart from the mark and the encoding
 * because it is a different code path to the same properties: getMarkConfig
 * walks the configuration chain and never looks at the mark definition, where
 * getMarkPropOrConfig reads the definition first, and the two can disagree
 * (over `invalid`, for one). A property that the mark families agree on may
 * still be read wrongly out of a theme.
 *
 * The axis block appears three times over (plain, axisX, and axisBand)
 * because the same table resolved at three scopes is three answers, and which
 * one wins is the rule rather than the value.
 */
const CONFIG_CHARTS = {
  '': { definition: 'Config', chart: 'legendy' },
  axis: { definition: 'AxisConfig', chart: 'plain' },
  axisX: { definition: 'AxisConfig', chart: 'plain' },
  axisBand: { definition: 'AxisConfig', chart: 'plain' },
  legend: { definition: 'LegendConfig', chart: 'legendy' },
  header: { definition: 'HeaderConfig', chart: 'faceted' },
  title: { definition: 'TitleConfig', chart: 'titled' },
  view: { definition: 'ViewConfig', chart: 'plain' },
  scale: { definition: 'ScaleConfig', chart: 'legendy' },
  mark: { definition: 'MarkConfig', chart: 'plain' },
  bar: { definition: 'BarConfig', chart: 'plain' },
  line: { definition: 'LineConfig', chart: 'temporal' },
  area: { definition: 'AreaConfig', chart: 'temporal' },
  point: { definition: 'MarkConfig', chart: 'pointy' },
  text: { definition: 'MarkConfig', chart: 'texty' },
  tick: { definition: 'TickConfig', chart: 'ticky' },
  rect: { definition: 'RectConfig', chart: 'recty' },
  arc: { definition: 'RectConfig', chart: 'arcy' },
};

/** The charts the configuration families are tried on, one per shape a block needs. */
const CONFIG_BASE = {
  plain: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } },
  legendy: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } },
  faceted: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, column: { field: 't', type: 'ordinal' } } },
  titled: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } }, title: 'A chart with a caption' },
  temporal: { mark: 'line', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } } },
  pointy: { mark: 'point', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' } } },
  texty: { mark: 'text', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, text: { field: 'v', type: 'quantitative' } } },
  ticky: { mark: 'tick', encoding: { x: { field: 'v', type: 'quantitative' }, y: { field: 'c', type: 'nominal' } } },
  recty: { mark: 'rect', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 't', type: 'ordinal' }, color: { field: 'v', type: 'quantitative' } } },
  arcy: { mark: 'arc', encoding: { theta: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } },
};

/** The chart a swept configuration property is applied to. */
function configBaseSpec(key) {
  const base = CONFIG_BASE[CONFIG_CHARTS[key].chart];
  return {
    $schema: SCHEMA_URL,
    width: 200,
    height: 120,
    data: { values: ROWS },
    ...structuredClone(base),
  };
}

/**
 * Properties of a configuration block that are not a setting, and why each is
 * left alone.
 *
 * The nested blocks are the omission that matters: a style inside a mark
 * configuration is another table of tables, and the composite marks are whole
 * specifications. Both are families of their own rather than values to try
 * here.
 */
const CONFIG_SKIP = {
  style: 'a table of tables, keyed by names this chart does not use',
  selection: 'selection defaults, which need a selection to mean anything',
  params: 'parameters, which are a specification rather than a value',
  locale: 'a locale, which is a table of its own',
  range: 'the scheme tables, which are resolved at the Vega layer',
  boxplot: 'a composite mark, which is a specification rather than a value',
  errorbar: 'a composite mark, which is a specification rather than a value',
  errorband: 'a composite mark, which is a specification rather than a value',
  tooltipFormat: 'a format table read only where a tooltip is drawn',
  numberFormatType: 'names a function the page registers, and there is no page here',
  timeFormatType: 'names a function the page registers, and there is no page here',
  customFormatTypes: 'a switch for the two above',
  font: 'a font family, resolved by whatever engine measures the text',
};

/**
 * The guide blocks a channel carries, swept per channel rather than per theme.
 *
 * {"encoding": {"x": {"axis": {...}}}} is a different code path from
 * {"config": {"axis": {...}}}, and the difference is the whole reason both are
 * swept: a channel's own block is explicit where a theme's is derived, and the
 * two are resolved by different functions (parseAxis reads the stated one
 * before it reads any configuration, and upstream's isExplicit decides which
 * of them wins on a merge). A property both agree on says nothing; one they
 * disagree about is a rule.
 *
 * Which channel carries which guide is not a choice: an axis belongs to a
 * position, a legend to a colour or a size, a header to a facet, and a scale
 * to anything scaled. They are named here rather than derived so that a guide
 * is only ever swept where it is actually drawn.
 */
const GUIDE_CHARTS = {
  'axis-x': { definition: 'Axis', guide: 'axis', channel: 'x', chart: 'plain' },
  'axis-y': { definition: 'Axis', guide: 'axis', channel: 'y', chart: 'plain' },
  'axis-x-temporal': { definition: 'Axis', guide: 'axis', channel: 'x', chart: 'temporal' },
  'legend-color': { definition: 'Legend', guide: 'legend', channel: 'color', chart: 'coloured' },
  'legend-size': { definition: 'Legend', guide: 'legend', channel: 'size', chart: 'sized' },
  'header-column': { definition: 'Header', guide: 'header', channel: 'column', chart: 'faceted' },
  'scale-x': { definition: 'Scale', guide: 'scale', channel: 'x', chart: 'plain' },
  'scale-color': { definition: 'Scale', guide: 'scale', channel: 'color', chart: 'coloured' },
};

/** The charts the guide families are tried on, one per guide a channel can carry. */
const GUIDE_BASE = {
  plain: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } },
  temporal: { mark: 'line', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'v', type: 'quantitative' } } },
  coloured: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'w', type: 'quantitative' } } },
  sized: { mark: 'point', encoding: { x: { field: 'w', type: 'quantitative' }, y: { field: 'v', type: 'quantitative' }, size: { field: 'v', type: 'quantitative' } } },
  faceted: { mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, column: { field: 't', type: 'ordinal' } } },
};

/** The chart a swept guide property is applied to. */
function guideBaseSpec(key) {
  const chart = GUIDE_CHARTS[key];
  return {
    $schema: SCHEMA_URL,
    width: 200,
    height: 120,
    data: { values: ROWS },
    ...structuredClone(GUIDE_BASE[chart.chart]),
  };
}

/**
 * Properties of a guide that are not a setting on it, and why each is left
 * alone.
 *
 * Narrower than the other skip tables, because a guide block is almost all
 * settings, which is the point of sweeping it. encoding and style are the two
 * that are tables of their own, and condition needs a selection this chart
 * does not declare.
 */
const GUIDE_SKIP = {
  encoding: 'a table of encode blocks, which is a specification rather than a value',
  style: 'names config blocks the base chart does not declare',
  condition: 'a rule against a selection this chart does not declare',
};

/**
 * Properties that are not a setting on the mark, and why each is left alone.
 * The skips are returned so that coverage is a number somebody can read rather
 * than a claim.
 */
const SKIP = {
  type: 'the mark type itself, which the family already fixes',
  // A composite mark's parts are whole specifications of their own.
  box: 'a box plot part, which is a specification rather than a value',
  median: 'a box plot part, which is a specification rather than a value',
  outliers: 'a box plot part, which is a specification rather than a value',
  rule: 'a box plot part, which is a specification rather than a value',
  ticks: 'a box plot part, which is a specification rather than a value',
  extent: 'a box plot or error bar extent, whose meaning depends on the composite type',
  point: 'a line or area overlay, which is a mark specification rather than a value',
  line: 'an area overlay, which is a mark specification rather than a value',
  style: 'names config blocks the base chart does not declare',
  tooltip: 'a pointer affordance, and there is no pointer in a compiled specification',
  text: 'the text itself, which the encoding supplies',
  url: 'an image to fetch, and a comparison that fetched one would be measuring the network',
  description: 'prose, emitted verbatim',
  aria: 'an accessibility flag with no geometry',
  ariaRole: 'prose, emitted verbatim',
  ariaRoleDescription: 'prose, emitted verbatim',
  href: 'a link, which draws nothing',
  x: 'a position the encoding already supplies',
  y: 'a position the encoding already supplies',
  x2: 'a position the encoding already supplies',
  y2: 'a position the encoding already supplies',
  theta: 'a position the encoding already supplies',
  theta2: 'a position the encoding already supplies',
  radius: 'a position the encoding already supplies',
  radius2: 'a position the encoding already supplies',
  width: "the mark's own size, which the view already fixes",
  height: "the mark's own size, which the view already fixes",
  clip: 'clipping, which changes no property of the compiled specification',
  font: 'a font family, resolved by whatever engine measures the text',
  timeUnitBandSize: 'a band size in time units, which needs a time-unit encoding to mean anything',
  timeUnitBandPosition:
    'a band position in time units, which needs a time-unit encoding to mean anything',
};

/**
 * Properties of a channel definition that are not a setting on the channel,
 * and why each is left.
 *
 * The four guide blocks are the large omission here and they are deliberate:
 * an axis, a legend, a header and a scale are whole tables of properties
 * apiece, so each is a family of its own (GUIDE_CHARTS) rather than a value to
 * try here.
 */
const ENCODING_SKIP = {
  field: 'the column itself, which the chart already fixes',
  type: 'the measure, which decides what every other property here means',
  datum: 'a literal standing where the column is, so not a property of this definition',
  value: 'a literal standing where the column is, so not a property of this definition',
  condition: 'a definition of its own, tried against a selection this chart does not declare',
  axis: 'a table of properties, and a family of its own to write',
  legend: 'a table of properties, and a family of its own to write',
  header: 'a table of properties, and a family of its own to write',
  scale: 'a table of properties, and a family of its own to write',
  impute: 'an imputation, which is a specification rather than a value',
  bin: 'a bin, whose object form is a table of properties and whose bare form the mark families already draw',
};

/** The numbers tried for a number-typed property. */
const NUMBERS = [0, 0.5, 8, -4];

/** The one colour tried where the schema says a colour, chosen to be unlike every default. */
const COLOUR = '#b35a1f';

/**
 * The value tried for a free string, by property name.
 *
 * A string the schema does not constrain still has a shape the compiler
 * expects: format is a d3 specifier, symbolType is one of Vega's shape names,
 * lineBreak is what a caption is split on. Given prose instead, most of these
 * compile and compare fine, but the one or two that do not would be reported
 * as a difference in a chart nobody could draw, which is a worse use of a
 * reader's time than a value chosen to mean something.
 */
const STRINGS = {
  format: '.2f',
  formatType: 'number',
  symbolType: 'cross',
  lineBreak: '/',
  ellipsis: '…',
  labelExpr: "datum.label + '!'",
  href: 'https://example.invalid/',
  url: 'https://example.invalid/image.png',
  labelFont: 'Courier',
  titleFont: 'Courier',
  fontStyle: 'italic',
  labelFontStyle: 'italic',
  titleFontStyle: 'italic',
  ariaRole: 'graphics-symbol',
  ariaRoleDescription: 'a thing',
  text: 'Aa',
  title: 'Aa',
  description: 'Aa',
};

export function generate(ctx) {
  const schema = JSON.parse(
    readFileSync(
      path.join(ctx.nodeModules, 'vega-lite/build/vega-lite-schema.json'),
      'utf8',
    ),
  );

  /**
   * Every branch a schema fragment can take, with $refs followed.
   *
   * Vega-Lite wraps nearly everything in an anyOf with an ExprRef and a
   * conditional form, so a reader that stopped at the reference would see no
   * values at all.
   */
  function branchesOf(fragment, depth = 0) {
    if (!fragment || depth > 8) return [];
    if (fragment.$ref) {
      const name = fragment.$ref.split('/').pop();
      return branchesOf(schema.definitions[name], depth + 1);
    }
    const nested = fragment.oneOf || fragment.anyOf || fragment.allOf;
    if (nested) return nested.flatMap((branch) => branchesOf(branch, depth + 1));
    return [fragment];
  }

  /**
   * The properties a channel definition declares, taken from the branch that
   * names a field.
   *
   * A channel is an anyOf over the several shapes it can take (a field, a
   * literal datum, a bare value, and a conditional wrapping each) and merging
   * all of them would sweep value onto a definition that has a field, which is
   * not a specification anybody can write. The base charts above all encode
   * fields, so the field branch is the one whose properties are worth asking
   * about.
   */
  function fieldDefProperties(channel) {
    const fragment = schema.definitions.FacetedEncoding?.properties?.[channel];
    if (!fragment) return null;
    const branch = branchesOf(fragment).find((it) => it.properties?.field);
    return branch?.properties ?? null;
  }

  /** Collects the candidate values a schema fragment declares, or null where there are none. */
  function declaredValues(fragment, name) {
    const branches = branchesOf(fragment);
    for (const branch of branches) {
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
    // A colour is named by the definition it references rather than by the property's name.
    if (JSON.stringify(fragment).includes('Color')) return { kind: 'colour', values: [COLOUR] };
    for (const branch of branches) {
      if (branch.type === 'array' && (!branch.items || branch.items.type === 'number')) {
        return { kind: 'array', values: [[4, 2]] };
      }
    }
    // A free string, which the schema constrains no further: one value each,
    // and it has to be a value the property can actually take (a format
    // specifier where a format is wanted, a symbol name where a shape is). A
    // nonsense string would still compile and be compared, but it would
    // compare a chart nobody could draw. Where nothing meaningful
    // distinguishes one string from another the value is plain prose, which
    // is exactly what those properties carry.
    for (const branch of branches) {
      if (branch.type === 'string') {
        return { kind: 'string', values: [STRINGS[name] ?? 'Aa'] };
      }
    }
    return null;
  }

  /** A name-safe spelling of a value. */
  function slug(value) {
    return (
      JSON.stringify(value)
        .replace(/[^A-Za-z0-9.-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40) || 'blank'
    );
  }

  /**
   * A family is a property table, a chart to try each property on, and where
   * on that chart it goes.
   */
  const families = [
    ...Object.keys(MARK_ENCODINGS).map((type) => ({
      name: `mark-${type}`,
      properties: () => schema.definitions.MarkDef.properties,
      baseSpec: () => markBaseSpec(type),
      apply: (spec, property, value) => {
        spec.mark[property] = value;
      },
      skip: (property) => SKIP[property],
    })),
    ...Object.keys(CHANNEL_CHARTS).map((key) => ({
      name: `encoding-${key}`,
      properties: () => fieldDefProperties(CHANNEL_CHARTS[key].channel),
      baseSpec: () => channelBaseSpec(key),
      apply: (spec, property, value) => {
        spec.encoding[CHANNEL_CHARTS[key].channel][property] = value;
      },
      skip: (property) => ENCODING_SKIP[property],
    })),
    ...Object.keys(GUIDE_CHARTS).map((key) => ({
      name: `guide-${key}`,
      properties: () => schema.definitions[GUIDE_CHARTS[key].definition]?.properties ?? null,
      baseSpec: () => guideBaseSpec(key),
      apply: (spec, property, value) => {
        const { guide, channel } = GUIDE_CHARTS[key];
        spec.encoding[channel][guide] ??= {};
        spec.encoding[channel][guide][property] = value;
      },
      skip: (property) => GUIDE_SKIP[property],
    })),
    ...Object.keys(CONFIG_CHARTS).map((key) => ({
      name: key ? `config-${key}` : 'config',
      properties: () => schema.definitions[CONFIG_CHARTS[key].definition]?.properties ?? null,
      baseSpec: () => configBaseSpec(key),
      apply: (spec, property, value) => {
        spec.config ??= {};
        if (key) {
          spec.config[key] ??= {};
          spec.config[key][property] = value;
        } else {
          spec.config[property] = value;
        }
      },
      skip: (property) => CONFIG_SKIP[property],
    })),
  ];

  const cases = [];
  const skips = [];
  const used = new Map();

  for (const { name: family, properties, baseSpec, apply, skip } of families) {
    const table = properties();
    if (!table) {
      skips.push({ family, property: '*', reason: 'the schema declares no such definition' });
      continue;
    }
    for (const [property, fragment] of Object.entries(table)) {
      const reason = skip(property);
      if (reason) {
        skips.push({ family, property, reason });
        continue;
      }
      const candidates = declaredValues(fragment, property);
      if (!candidates) {
        skips.push({ family, property, reason: 'the schema declares no enumerable value here' });
        continue;
      }
      for (const value of candidates.values) {
        const spec = baseSpec();
        apply(spec, property, value);
        let name = `${family}-${property}-${slug(value)}`;
        if (used.has(name)) name = `${name}-${used.get(name) + 1}`;
        used.set(name, (used.get(name) || 0) + 1);
        cases.push({ name, family, property, lite: true, spec });
      }
    }
  }
  return { cases, skips };
}
