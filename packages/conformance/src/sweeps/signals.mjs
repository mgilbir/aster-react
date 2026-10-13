// The signal sweep: one chart per (thing a signal can reach, value written).
//
// The other sweeps compare a chart as first drawn. This one renders a chart,
// writes a signal into the running view the way a slider, a dropdown or a
// fired handler does, runs the dataflow again, and compares the second render.
// The oracle does render -> view.signal(name, value) -> runAsync -> toSVG; the
// engine does the same through vega.Options.SignalWrites.
//
// What is varied is a signal's value, and deliberately not only sensible ones:
// a null, a word where a number goes, an empty list, a negative where only
// positives were imagined. A binding is exactly such a door; a host writes
// through it whatever its control produced.
//
// What it is varied in is one chart per thing a signal can reach, because the
// write has to carry the new value that far: a scale's domain, a scale's range,
// a mark's own property, an axis's tick count, a title's words, a transform's
// parameter, and a signal derived from the one being set, which tests the
// cascade rather than the write.
//
// Upstream rules the charts are written around:
//
// - update, never enter. An enter encode runs once, when an item is created,
//   and a signal written afterwards never reaches it; a strokeWidth in enter
//   stays at its first value however often the signal changes, while the same
//   channel in update tracks it. update runs on the first render as well, so it
//   is the whole encode and not half of one.
// - Upstream retains state across a write: a scale whose domain is overwritten
//   with null keeps its old domain, a data-driven domain keeps the order its
//   surviving rows were in and appends re-admitted ones, an axis keeps the tick
//   items whose values survived. The engine re-runs the same dataflow
//   incrementally, so the second render has to show the same retention; such a
//   case is not excluded, and a difference in it is a difference in the
//   dataflow rather than in the spec.
// - A value upstream refuses (an error while running) makes the oracle's answer
//   an error; "upstream will not draw this either" is an agreement.

const ROWS = [
  { k: 'a', v: 28, n: 1 },
  { k: 'b', v: 55, n: 2 },
  { k: 'c', v: 43, n: 3 },
  { k: 'd', v: 91, n: 4 },
];

const base = (extra) => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200,
  height: 120,
  padding: 5,
  data: [{ name: 't', values: ROWS }],
  ...extra,
});

// Each chart names one signal and the values to write into it; note says what
// the signal reaches.
const CHARTS = [
  {
    name: 'a-scale-domain',
    signal: 'dom',
    note: 'a signal that *is* a scale domain, so the write reaches the scale and every mark on it',
    values: [[0, 100], [0, 10], [50, 50], [100, 0], [0, 0], null, 'not a domain', []],
    spec: base({
      signals: [{ name: 'dom', value: [0, 100] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
        { name: 'y', type: 'linear', domain: { signal: 'dom' }, range: 'height' },
      ],
      axes: [{ orient: 'left', scale: 'y', tickCount: 4 }],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { scale: 'y', field: 'v' },
              y2: { scale: 'y', value: 0 },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-mark-property',
    signal: 'thickness',
    note: 'a signal read straight by a mark, where the value never passes through a scale',
    values: [10, 0, -5, 0.5, 1e6, null, 'wide', true],
    spec: base({
      signals: [{ name: 'thickness', value: 10 }],
      scales: [
        { name: 'x', type: 'point', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.5 },
      ],
      marks: [
        {
          type: 'symbol',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              y: { value: 60 },
              size: { value: 80 },
              stroke: { value: '#333' },
              strokeWidth: { signal: 'thickness' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-tick-count',
    signal: 'ticks',
    note: 'a signal an axis counts with, which decides how many labels a reader gets',
    values: [4, 0, 1, 40, -3, 2.5, null, 'four'],
    spec: base({
      signals: [{ name: 'ticks', value: 4 }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
      axes: [{ orient: 'left', scale: 'y', tickCount: { signal: 'ticks' } }],
      marks: [],
    }),
  },
  {
    name: 'a-title',
    signal: 'heading',
    note: 'a signal that is a title, which is words rather than geometry and is also captioned',
    values: ['Revenue', '', 'A much longer heading than the chart is wide', 0, null, ['two', 'lines'], 1e21],
    spec: base({
      title: { text: { signal: 'heading' } },
      signals: [{ name: 'heading', value: 'Revenue' }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
      axes: [{ orient: 'left', scale: 'y', tickCount: 4 }],
      marks: [],
    }),
  },
  {
    name: 'a-transform-parameter',
    signal: 'cutoff',
    note: 'a signal a filter reads, so the write changes how many rows exist rather than how they look',
    values: [40, 0, 100, -1, null, 'forty', 1e21],
    spec: base({
      signals: [{ name: 'cutoff', value: 40 }],
      data: [
        {
          name: 't',
          values: ROWS,
          transform: [{ type: 'filter', expr: 'datum.v > cutoff' }],
        },
      ],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
        { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' },
      ],
      axes: [{ orient: 'bottom', scale: 'x' }],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { scale: 'y', field: 'v' },
              y2: { value: 120 },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-derived-signal',
    signal: 'scale',
    note: 'a signal two others are computed from, so what is tested is the cascade and not the write',
    values: [2, 1, 0, -2, 0.25, null, 'twice'],
    spec: base({
      signals: [
        { name: 'scale', value: 2 },
        { name: 'height2', update: '60 * scale' },
        { name: 'label', update: "'x' + scale" },
      ],
      scales: [
        { name: 'x', type: 'point', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.5 },
      ],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k', offset: -8 },
              width: { value: 16 },
              y: { value: 10 },
              y2: { signal: 'height2' },
            },
          },
        },
        {
          type: 'text',
          encode: {
            update: { x: { value: 2 }, y: { value: 2 }, text: { signal: 'label' }, baseline: { value: 'top' } },
          },
        },
      ],
    }),
  },
  {
    name: 'a-legend-title',
    signal: 'legendTitle',
    note: 'a signal that titles a legend, which is words inside a guide rather than beside the chart',
    values: ['Series', ['two', 'lines'], '', null, 0, 1e21],
    spec: base({
      signals: [{ name: 'legendTitle', value: 'Series' }],
      scales: [
        { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' },
      ],
      legends: [{ fill: 'colour', title: { signal: 'legendTitle' } }],
      marks: [],
    }),
  },
  {
    name: 'a-view-size',
    signal: 'w',
    note: "the view's own width, which every scale ranged on it and the surface itself follow",
    values: [200, 0, 40, -100, 1e5, null, 'wide'],
    spec: base({
      signals: [{ name: 'w', value: 200 }],
      width: { signal: 'w' },
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
      ],
      axes: [{ orient: 'bottom', scale: 'x' }],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { value: 0 },
              y2: { value: 60 },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-format-specifier',
    signal: 'fmt',
    note: "an axis's number format, where the signal is a specifier rather than a quantity",
    values: ['.2f', '', '%', 'not a format', '.99f', null, 42],
    spec: base({
      signals: [{ name: 'fmt', value: '.2f' }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 1], range: 'height' }],
      axes: [{ orient: 'left', scale: 'y', tickCount: 3, format: { signal: 'fmt' } }],
      marks: [],
    }),
  },
  {
    name: 'a-colour-scheme',
    signal: 'scheme',
    note: 'the name of a scheme, which is looked up rather than read as a value',
    values: ['blues', 'BLUES', 'nosuchscheme', '', null, 7],
    spec: base({
      signals: [{ name: 'scheme', value: 'blues' }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
        { name: 'c', type: 'linear', domain: [0, 100], range: { scheme: { signal: 'scheme' } } },
      ],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { value: 0 },
              y2: { value: 60 },
              fill: { scale: 'c', field: 'v' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-mark-shape',
    signal: 'shape',
    note: 'a symbol shape, which is a name upstream resolves to a path and not a measurement',
    values: ['circle', 'triangle', 'M0,0L8,8Z', 'nosuchshape', '', null],
    spec: base({
      signals: [{ name: 'shape', value: 'circle' }],
      scales: [
        { name: 'x', type: 'point', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.5 },
      ],
      marks: [
        {
          type: 'symbol',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              y: { value: 60 },
              size: { value: 200 },
              shape: { signal: 'shape' },
              fill: { value: '#4c78a8' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-scale-range',
    signal: 'rng',
    note: 'a scale range, the domain\'s opposite end, where a reversed one reverses the chart',
    values: [[0, 100], [100, 0], [50, 50], [], null, 'height'],
    spec: base({
      signals: [{ name: 'rng', value: [0, 100] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
        { name: 'y', type: 'linear', domain: [0, 100], range: { signal: 'rng' } },
      ],
      axes: [{ orient: 'left', scale: 'y', tickCount: 3 }],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { scale: 'y', field: 'v' },
              y2: { scale: 'y', value: 0 },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'an-axis-orientation',
    signal: 'side',
    note: "which side an axis sits on, which moves the plotting area rather than a mark",
    values: ['left', 'right', 'top', 'bottom', '', null, 'sideways'],
    spec: base({
      signals: [{ name: 'side', value: 'left' }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
      axes: [{ orient: { signal: 'side' }, scale: 'y', tickCount: 3 }],
      marks: [],
    }),
  },
  {
    name: 'a-label-limit',
    signal: 'lim',
    note: "how much room a label has before it is cut short, where the text itself changes",
    values: [0, 12, 1, 1e6, -5, null, 'wide'],
    spec: base({
      signals: [{ name: 'lim', value: 0 }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
      ],
      axes: [{ orient: 'bottom', scale: 'x', labelLimit: { signal: 'lim' } }],
      marks: [
        {
          type: 'text',
          encode: {
            update: {
              x: { value: 10 },
              y: { value: 30 },
              text: { value: 'a label long enough to be cut' },
              limit: { signal: 'lim' },
              fontSize: { value: 11 },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-curve',
    signal: 'curve',
    note: "how a line joins its points, which changes the outline without moving one of them",
    values: ['linear', 'step', 'monotone', 'basis', '', null, 'squiggle'],
    spec: base({
      signals: [{ name: 'curve', value: 'linear' }],
      scales: [
        { name: 'x', type: 'point', domain: { data: 't', field: 'k' }, range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
      ],
      marks: [
        {
          type: 'line',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              y: { scale: 'y', field: 'v' },
              stroke: { value: '#4c78a8' },
              interpolate: { signal: 'curve' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-corner-radius',
    signal: 'radius',
    note: "how far a rect's corners are rounded, which is geometry a bounds check cannot see",
    values: [0, 6, 1e4, -4, 0.5, null, 'round'],
    spec: base({
      signals: [{ name: 'radius', value: 0 }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.2 },
      ],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { value: 0 },
              y2: { value: 60 },
              fill: { value: '#4c78a8' },
              cornerRadius: { signal: 'radius' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-clip-flag',
    signal: 'clipped',
    note: "whether a group hides what overflows it, which decides if marks are drawn at all",
    values: [true, false, 1, 0, '', null, 'yes'],
    spec: base({
      signals: [{ name: 'clipped', value: true }],
      marks: [
        {
          type: 'group',
          clip: { signal: 'clipped' },
          encode: {
            update: {
              x: { value: 0 },
              y: { value: 0 },
              width: { value: 60 },
              height: { value: 40 },
              stroke: { value: '#888' },
            },
          },
          marks: [
            {
              type: 'rect',
              encode: {
                update: {
                  x: { value: 10 },
                  y: { value: 10 },
                  width: { value: 120 },
                  height: { value: 20 },
                  fill: { value: '#4c78a8' },
                },
              },
            },
          ],
        },
      ],
    }),
  },
  {
    name: 'a-text-anchor',
    signal: 'anchor',
    note: "which way a label hangs off its point, where the anchor moves and the point does not",
    values: ['left', 'center', 'right', '', null, 'middle', 7],
    spec: base({
      signals: [{ name: 'anchor', value: 'left' }],
      marks: [
        {
          type: 'text',
          from: { data: 't' },
          encode: {
            update: {
              x: { value: 100 },
              y: { signal: '20 * datum.n' },
              text: { field: 'k' },
              align: { signal: 'anchor' },
              fontSize: { value: 12 },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-label-angle',
    signal: 'turn',
    note: "how far an axis label is turned, which changes the room the axis needs",
    values: [0, 45, -90, 360, 0.5, null, 'sideways'],
    spec: base({
      signals: [{ name: 'turn', value: 0 }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
      ],
      axes: [{ orient: 'bottom', scale: 'x', labelAngle: { signal: 'turn' } }],
      marks: [],
    }),
  },
  {
    name: 'a-font-size',
    signal: 'pt',
    note: 'how large a label is set, which every measurement of it follows',
    values: [11, 24, 0, -4, 0.5, null, 'large'],
    spec: base({
      signals: [{ name: 'pt', value: 11 }],
      marks: [
        {
          type: 'text',
          encode: {
            update: {
              x: { value: 10 },
              y: { value: 40 },
              text: { value: 'measure me' },
              fontSize: { signal: 'pt' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-paint-order',
    signal: 'above',
    note: "which of two overlapping marks is drawn on top, which is order and not position",
    values: [0, 1, -1, 1e6, 0.5, null, 'top'],
    spec: base({
      signals: [{ name: 'above', value: 0 }],
      marks: [
        {
          type: 'rect',
          encode: {
            update: {
              x: { value: 0 },
              y: { value: 0 },
              width: { value: 60 },
              height: { value: 40 },
              fill: { value: '#4c78a8' },
            },
          },
        },
        {
          type: 'rect',
          zindex: { signal: 'above' },
          encode: {
            update: {
              x: { value: 20 },
              y: { value: 10 },
              width: { value: 60 },
              height: { value: 40 },
              fill: { value: '#f58518' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-band-padding',
    signal: 'gap',
    note: "how much of a band is left empty, which moves every bar and the step between them",
    values: [0.1, 0, 1, 0.999, -0.5, null, 'wide'],
    spec: base({
      signals: [{ name: 'gap', value: 0.1 }],
      scales: [
        {
          name: 'x',
          type: 'band',
          domain: { data: 't', field: 'k' },
          range: 'width',
          padding: { signal: 'gap' },
        },
      ],
      axes: [{ orient: 'bottom', scale: 'x' }],
      marks: [
        {
          type: 'rect',
          from: { data: 't' },
          encode: {
            update: {
              x: { scale: 'x', field: 'k' },
              width: { scale: 'x', band: 1 },
              y: { value: 0 },
              y2: { value: 60 },
              fill: { value: '#4c78a8' },
            },
          },
        },
      ],
    }),
  },
  {
    name: 'a-domain-bound',
    signal: 'top',
    note: "one end of a domain pinned while the data decides the other",
    values: [100, 0, -50, 1e6, null, 'high'],
    spec: base({
      signals: [{ name: 'top', value: 100 }],
      scales: [
        {
          name: 'y',
          type: 'linear',
          domain: { data: 't', field: 'v' },
          domainMax: { signal: 'top' },
          range: 'height',
        },
      ],
      axes: [{ orient: 'left', scale: 'y', tickCount: 3 }],
      marks: [],
    }),
  },
  {
    name: 'a-dash-pattern',
    signal: 'dash',
    note: 'the on-and-off pattern of a stroke, where the signal holds a list rather than a number',
    values: [[4, 2], [], [0, 0], [3], null, 'dashed', 6],
    spec: base({
      signals: [{ name: 'dash', value: [4, 2] }],
      marks: [
        {
          type: 'rule',
          encode: {
            update: {
              x: { value: 0 },
              y: { value: 20 },
              x2: { value: 180 },
              y2: { value: 20 },
              stroke: { value: '#333' },
              strokeWidth: { value: 2 },
              strokeDash: { signal: 'dash' },
            },
          },
        },
      ],
    }),
  },
];

// A value's name in a case's name: short, stable and readable in a report. The
// sign is spelled out, because stripping it is a lie a report then tells: a
// case about a negative stroke width must not read as one about a positive one.
function slug(value, index) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'empty-list';
    return `list-${value.map((v) => String(v).replace('-', 'minus')).join('-')}`;
  }
  const text = String(value).replace(/^-/, 'minus');
  if (text === '') return 'empty';
  return text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || `v${index}`;
}

export function generate() {
  const cases = [];
  for (const chart of CHARTS) {
    chart.values.forEach((value, index) => {
      cases.push({
        name: `${chart.name}--${slug(value, index)}`,
        family: chart.name,
        property: chart.signal,
        spec: chart.spec,
        writes: [{ name: chart.signal, value }],
      });
    });
  }
  return { cases, skips: [] };
}
