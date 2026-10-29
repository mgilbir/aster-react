# Limits (untrusted specs and data)

Data and specs are untrusted input. `SpecLimits` are the budgets; `loadSpecData`
takes a URL policy; image marks and `href` links share that policy. Every limit is
optional: a dimension you do not set is unbounded. There are no default numbers for
`SpecLimits` (the values below are examples, see "Recommended starting points").
Passing a `limits` object at all, even `{}`, turns the limits scope on: that enables
the pre-flight walk with its hard depth ceiling, the regular-expression screen and
the default image/link URL policy described below.

```ts
import { renderSpec, type SpecLimits, type VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 200,
  height: 100,
  data: [{ name: 'table', values: [{ x: 1 }, { x: 2 }, { x: 3 }] }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { width: { value: 5 }, height: { value: 5 } } } }],
}

const limits: SpecLimits = {
  maxRows: 100_000,        // see "What maxRows counts"
  maxMarks: 200,           // mark definitions, recursive
  maxDepth: 32,            // spec object nesting (a hard ceiling of 1000 applies even when unset)
  maxStringLength: 10_000, // any string in the spec, a generated string, a regex input, scene text
  maxItems: 50_000,        // generated scene items (and axis/legend/time ticks)
  maxPathLength: 1_000_000,// any generated or supplied path `d`
  maxSvgLength: 8_000_000, // length of the serialized SVG string
  maxTimeMs: 2_000,        // wall clock of one evaluation, see "What maxTimeMs covers"
  maxGeneratedRows: 500_000,   // cumulative rows produced by transforms/emitters in one evaluation
  maxGeneratedBytes: 5_000_000 // cumulative characters built by expression builtins
}

const svg = renderSpec(spec, { limits })
console.log(svg.length > 0)
```

## Which entry point enforces what

The budgets are not all enforced by every entry point. The meters (see below) run
inside any evaluation that has a `limits` scope; the pre-flight, scene and SVG-length
checks are separate calls.

| Entry point | Pre-flight (`checkSpecLimits`) | Meters (rows, items, time, strings, regex) | Scene check (`checkSceneLimits`) | `maxSvgLength` |
|---|---|---|---|---|
| `renderSpec` | yes | yes | yes | yes |
| `handleChartWorkerRequest` (`useChartWorker`) | yes | yes | yes | yes |
| `createChartSession().evaluate` | yes | yes | yes | no (you serialize) |
| `createChartSession().change` | no | yes | yes | no |
| `createChartStream` flushes | yes (session) | yes | yes | no; `maxRows` also counts the rows the stream holds |
| `useChart` | yes (session) | yes | yes | yes when `serialize` is on (the default) |
| `<Chart limits>` | yes (session) | yes | yes | SVG renderer only: the scene is serialized once per evaluation to measure it, and only when `maxSvgLength` is set |
| `evaluateChart`, `getChartInfo` | no | yes | no | no |

So `evaluateChart` and `getChartInfo` do not apply `maxMarks`, `maxDepth`, the
spec-string check or the summed pre-flight row count, and they never check
`maxSvgLength` or the scene's `path`/`text` lengths. Call `checkSpecLimits`,
`checkSceneLimits` and `checkSvgLength` yourself if you build on the lower-level
functions (they are exported from `@aster/core`).

## What `maxRows` counts

The pre-flight reads the spec's lists the way the compiler does (vega-util `array()`: a lone `data` object counts as a one-element list), so `checkSpecLimits` and the runtime agree on what is a dataset.

- **Pre-flight**: the sum of all inline `values` arrays (top level and nested group
  `data`) plus every array in the host's `input.data`. Two datasets of 6 rows fail a
  `maxRows` of 10.
- **During evaluation**: each dataset on its own, after load, `source` and every
  transform step (not a sum). Datasets produced by `sequence`, `cross`, `fold` and the
  like count, so generated rows are covered. The cumulative total of generated rows is
  `maxGeneratedRows`.
- **`createChartStream`**: additionally the rows the stream holds (base snapshot plus what
  the flush will add), because those arrive through `input.data` after the session's
  pre-flight.
- **`loadSpecData`**: rows of each loaded dataset (`limits.maxRows`), and decoded topojson
  coordinates (against `maxGeneratedRows`, else `maxRows`).

## What `maxTimeMs` covers

`maxTimeMs` is one wall-clock budget per `withLimits` scope, started when the scope opens.
`renderSpec`, `evaluateChart`, `getChartInfo`, a session's `evaluate`/`change` and the worker
handler each open one. It is checked at phase boundaries (`pre-flight`, `compile`,
`evaluate`, `render`) and, inside the evaluation, every 1024 rows/items or at each metered
site (see below). It does **not** cover:

- anything it cannot interrupt: a single synchronous native call (a regular expression, see
  below), or `compileChart` itself;
- work done after the evaluation returns: the SVG serialization in `useChart` and
  `<Chart>`, the DOM patch, canvas painting, React rendering;
- each evaluation is its own budget: `<Chart>` re-evaluating on a prop change, or a stream
  flush, starts a new clock.

A session keeps the limits in its cache key. Re-evaluating the same inputs with the same
limits returns the cached scene (it was accepted under exactly those limits); a different
`limits` value re-evaluates and can reject. The only time check on a cache hit is the one
at the start of `evaluate` (`maxTimeMs: 0` fails there). A failed evaluation leaves the
session as it was.

## How the budgets are enforced: meters, not checkpoints

A budget that is only compared between phases cannot stop the costs that live
inside one synchronous call (a transform, one `sequence(0, 5e7)`, a 50-million
tick axis). So each such site reports what it is **about to spend** to a *meter*
that shares the one wall clock:

| Where | What is metered |
|---|---|
| Pre-flight (`checkSpecLimits`) | every string in the spec (`maxStringLength`), object depth (`maxDepth`, ceiling 1000), mark definitions (`maxMarks`), summed inline rows (top level, nested group `data`, host `input.data`). Iterative: a 200 000-deep or cyclic spec is an `AsterLimitError`, never a `RangeError` |
| Every dataset | rows after load/`source`/transforms must be `<= maxRows` |
| Transforms and row emitters | `sequence`, `fold` (rows x fields), `flatten`, `cross` (n x n), `impute`, `kde`/`quantile`/`regression`/`loess`/`countpattern` row counts, contour grid cells and thresholds, label bitmap, `range`: checked **before** the output is allocated; `aggregate`, `joinaggregate`, `pivot`, `bootstrap`, `stack`, `window`, `loess`, `kde`, `wordcloud`, `pack`, `voronoi`, `cross` with a filter and `indata()` sample the clock **inside** their loops |
| Encode loop | one item per row: `maxItems` is checked before the mark is encoded; the clock is sampled every 1024 items. Group items are metered the same way |
| Guides and scales | numeric tick counts, calendar-month tick counts, time-interval ranges, quantize colour samples (all against `maxItems`), facet `columns` |
| Expression builtins | `sequence` (rows), `pad` and number-format width (`maxStringLength`, cumulative `maxGeneratedBytes`), regex pattern/input length |
| Expression parser | nesting depth (1000): an `AsterLimitError`, not a stack overflow. Always thrown by the parser; see "A limit error cannot be swallowed" for what happens without a scope |
| Topojson | decoded coordinates against `maxGeneratedRows` (else `maxRows`) |
| Serialisation | every generated path `d` is checked as it is written (`maxPathLength`); `maxSvgLength` on the result where the entry point checks it (see the table above) |
| Scene (`checkSceneLimits`) | leaf items (`maxItems`), item `path` strings (`maxPathLength`), the total length of string and array `text` (`maxStringLength`), and a lower bound for line/area paths (4 characters per point) |

Properties worth knowing:

- **One clock.** `renderSpec`, sessions, `evaluateChart`, `getChartInfo` and the worker
  handler open a scope (`withLimits`) with one wall clock. The `autosize: fit` loop, which
  evaluates the content several times, no longer restarts the budget per pass.
  Calling lower-level functions (`applyTransforms`, `buildScale`) yourself? Wrap
  them in `withLimits(limits, () => ...)` to get the same metering.
- **A limit error cannot be swallowed, inside a scope.** The runtime has defensive
  `catch` blocks (a signal expression that fails falls back to a default). The first
  violation in a scope is recorded on the meter, every later meter call re-throws it,
  and the scope re-throws it on exit even if a `catch` ate it. Without `limits` there
  is no scope: the expression parser still throws its nesting error, but a defensive
  `catch` can turn it into the default value (a 5000-term `1+1+...` signal renders
  without error when no `limits` is given and fails with `maxDepth 1001 > 1000
  (expression nesting)` when it is).
- **Cost with limits off:** every site is one module-level null test. Limits ON
  adds an amortised clock read per 1024 rows/items.

### Deviations from Vega, made for safety

Vega has no budgets, no URL policy and no refusals of its own. Every row here is a
deliberate difference; each applies only where noted.

| Deviation | Why |
|---|---|
| Any budget in `SpecLimits`; rows, items, strings, paths, generated rows/bytes, SVG length and time are refused with `AsterLimitError` | vega renders whatever it is given |
| Pre-flight depth ceiling: with a `limits` object, spec nesting deeper than `HARD_MAX_SPEC_DEPTH` (1000, exported from `@aster/core`) fails even when `maxDepth` is unset, and a cyclic spec fails (`spec contains a cycle`) | an unbounded walk overflows the stack |
| `sequence`, `range`, numeric `ticks`, calendar and time-interval ranges, `pad` and number-format width are bounded by the active limits before they allocate | one call can otherwise allocate gigabytes |
| Expression nesting deeper than 1000 (parser and AST) throws `AsterLimitError` (the parser does so with or without `limits`; see "A limit error cannot be swallowed") | vega throws a raw `RangeError` at a stack-dependent depth |
| `bin`: a step that can never grow (underflowed to 0, `base` <= 1 that never reaches `maxbins`) throws `[aster] bin: cannot derive a step size ...` | vega loops forever. `maxbins: 0` (treated as 20) and `maxbins: -1` (NaN bins) give vega's output |
| `stratify` throws vega's errors (`cycle`, `multiple roots`, `missing: id`, `ambiguous: id`, `no root`) with an `[aster] stratify:` prefix | the messages are vega's; the prefix marks them as never recovered by the logger |
| Regex patterns with catastrophic-backtracking shapes, patterns > 1024 characters, and regex inputs longer than `maxStringLength` (default 10 000) are refused **under limits** | see the regex section |
| Decoded topojson coordinates are budgeted against `maxGeneratedRows` (else `maxRows`) | arcs are shared, so a few KB of input can decode to millions of points |
| `topojson` object names are looked up as own properties (`constructor`, `__proto__` are "not found") | the name is spec-controlled |
| `loadSpecData` and its URL policy: only public `http(s)` by default, no credentials, redirects re-vetted, timeout and size caps | a spec's `url` is a request made on the host's behalf |
| Image and `href` URLs go through the same policy **when `limits` or `urlPolicy` is given** (without either: vega parity) | a spec can name any URL |

Differences that are **not** about safety (unsupported-feature errors, strict
Vega-Lite validation, vega errors Aster does not raise) are listed in `docs/ERRORS.md`.

### Regular expressions: what a cooperative clock cannot do

A JavaScript regular expression runs to completion once started. A pattern such
as `(a+)+$` against `aaaa...!` takes time exponential in the input length and
**no check inside Aster can interrupt it**, and the attack input is tiny (a few dozen
characters). Under limits Aster does two things
before a pattern is compiled or run, for every pattern a spec or its data can
supply (`test`, `regexp`, `replace`/`split` with a RegExp or a `/literal/`,
`countpattern`):

1. **Static screen** (`regex-screen.ts`): the pattern is parsed into a small AST
   (not matched with another regex) and refused, with an `AsterLimitError`
   (`regexSafety: ...`), when it has one of the known exponential shapes:
   - a group under an unbounded quantifier whose body contains another unbounded
     quantifier (`(a+)+`, `(\w+\s?)*`, `(.*a){2,}`);
   - an unbounded-quantified alternation whose branches can start with the same
     character (`(a|a)*`, `(a|aa)+`, `(\w|\d)+`);
   - a backreference inside a group that repeats more than once (`(?:(a)\1)*`, `(?:(a)\1){2,}`).
2. **Length caps**: a pattern over 1024 characters, or an input longer than
   `maxStringLength` (default 10 000), is refused. This bounds linear patterns.

**This is a heuristic, not a guarantee.** It blocks the known catastrophic
shapes. It does not prove a pattern safe: polynomial blow-ups such as `a*a*a*b`
pass, and safe patterns with a repeated group around an unbounded quantifier,
such as `(\d+\.)*\d+`, are refused (rewrite them without the nesting). Syntax
the screen cannot parse is passed to the RegExp constructor unscreened (its own
syntax error then surfaces). Without limits nothing is screened (vega parity).

**If specs are untrusted, run the render in a killable worker** (a
`worker_threads` Worker you can `terminate()`, or a child process with a
timeout) and treat the worker's deadline as the hard guarantee. `maxTimeMs` then
produces friendly errors in the common case, the screen stops the known
shapes, and the kill covers the rest.

## Loading URL data: `loadSpecData(spec, options)`

`url` datasets are fetched by `loadSpecData` from `@aster/core/load`, never by
`renderSpec` (a `url` dataset that was not loaded is an error that tells you to
call it, not an empty chart). It resolves `url` datasets at the top level **and**
inside group marks at any depth, and returns a new spec.

Every URL a spec names passes the policy before any request is made:

| Option | Default | Meaning |
|---|---|---|
| `fetch` | `globalThis.fetch` | your fetch; Aster still applies the policy and the caps around it |
| `baseURL` | none | base for relative `url`s. Without it a relative url is an `AsterUrlError`. A url on the base's own origin is host-chosen: it is exempt from the private-network check (not from `allow`, which is still consulted) |
| `protocols` | `['http:', 'https:']` | allowed protocols. Anything not listed is refused (`data:`, `file:`, `javascript:`, `ftp:`, `blob:`, ...); add `'data:'` to permit data URLs. URLs with embedded credentials are refused whatever `protocols` says |
| `allow(url)` | none | veto hook, awaited for the first URL **and every redirect hop**; it must return exactly `true` to permit. This is the place for an origin allowlist |
| `allowPrivateNetwork` | `false` | permit loopback, private, link-local (cloud metadata), CGNAT, multicast hosts, `localhost`, `*.local`, `*.internal`, and their IPv6/mapped/NAT64/6to4 forms. Not applied to the `baseURL` origin or to `data:` URLs. `allow` alone cannot override it |
| `timeoutMs` | 10 000 | per request, covering headers **and** body (an `AsterLimitError`) |
| `maxBytes` | 10 MiB (10 485 760 bytes) | enforced **while the body streams** (a declared `content-length` over it is refused up front); the reader is cancelled, not buffered first. A fetch shim whose response has no stream is measured after the text exists |
| `maxConcurrent` | 4 | requests in flight at once |
| `maxRedirects` | 5 | redirects are followed manually; each hop goes through the whole policy **before** it is requested |
| `signal` | none | abort the whole load |
| `limits` | none | `maxRows` per loaded dataset, topojson coordinates, and `maxTimeMs` over the whole call (`maxTimeMs exceeded during loadSpecData`) |

The defaults are exported as `LOAD_DEFAULTS` (`timeoutMs`, `maxBytes`, `maxConcurrent`, `maxRedirects`) from `@aster/core/load`.
Policy refusals are `AsterUrlError`; timeout, size, redirect and budget failures are `AsterLimitError`; an HTTP error
status is a plain `Error` (`[aster] failed to load dataset url ...: HTTP 404`).

### Why these defaults

A spec's `url` is the request a server or browser will make on the spec author's
behalf. The attack is not "fetch a public CSV" (that is the feature); it is
reaching what only the host can reach: loopback and internal services, cloud
metadata, and slow or endless responses that pin the process. So:

- public `http(s)` works out of the box (`useSpecData` and plain hosts keep
  working), while **non-public destinations are denied by default** and need an
  explicit `allowPrivateNetwork: true`;
- anything beyond that is the host's call through `allow(url)` (origin
  allowlist) and `baseURL` (relative-only deployments);
- time, size and concurrency are bounded by default because the alternative is
  an unbounded wait, buffer and fan-out.

What the defaults cannot see: DNS. A public name that resolves to a private
address passes the host-literal check. If that matters, give `allow` an origin
allowlist or enforce egress at the network. For maximum strictness set
`allow: (u) => u.origin === 'https://data.example.com'` and `baseURL`.

Trusted specs (a demo, a test harness) can opt out explicitly with
`loadSpecData(spec, TRUSTED_LOAD_OPTIONS)`. Never use that for specs you did
not write.

```ts
import { loadSpecData } from '@aster/core/load'
import type { VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 200,
  height: 100,
  data: [{ name: 'table', url: 'data/table.json' }],   // relative: resolved against baseURL
  marks: [],
}

const loaded = await loadSpecData(spec, {
  baseURL: 'https://data.example.com/',
  allow: (url) => url.origin === 'https://data.example.com',
  maxBytes: 2_000_000,
  limits: { maxRows: 100_000, maxTimeMs: 5_000 },
})
```

`format.parse` accepts vega's `date:'%d/%m/%Y'` and `utc:'%Y-%m-%d'` patterns
(quoted or not), resolved through the default locale like `vega-loader`.

## Image URLs

Image marks take their `url` from data, so a hostile spec can make the viewer's
browser request a tracking pixel or a `javascript:` URL. Image `url`s pass the
same checks, applied while the scene is built so the string renderer, the DOM
path and canvas all see vetted items:

```ts
import { renderSpec, type VgSpec } from '@aster/core'

const spec: VgSpec = {
  width: 100,
  height: 100,
  data: [{ name: 'icons', values: [{ src: 'https://cdn.example.com/a.png' }, { src: 'https://tracker.example.net/p.gif' }] }],
  marks: [{
    type: 'image',
    from: { data: 'icons' },
    encode: { enter: { url: { field: 'src' }, x: { value: 0 }, y: { value: 0 }, width: { value: 16 }, height: { value: 16 } } },
  }],
}

const log = (reason: string): void => { console.warn('image dropped:', reason) }
const svg = renderSpec(spec, { urlPolicy: {
  baseURL: 'https://app.example.com/',
  allow: (url) => url.hostname === 'cdn.example.com',
  onDeny: (url, error) => log(error.reason), // drop the image instead of throwing
}})
console.log(svg.includes('cdn.example.com'), svg.includes('tracker.example.net')) // true false
```

- With `urlPolicy` it is applied (its `protocols` default to `http:`, `https:`,
  `data:`). With `limits` and no `urlPolicy` the defaults apply (the spec is
  untrusted): `http:`, `https:`, `data:` and relative URLs only, no credentials;
  anything else throws `AsterUrlError` (or is dropped when `onDeny` is set).
- With neither, images are not vetted. That is parity with Vega, which draws any
  `url`, and an SVG `<image>` cannot execute script, so `javascript:` is not an
  injection vector there. **Residual risk:** a spec can still make the viewer's
  browser request an arbitrary URL (a tracking pixel, an IP leak, a request to an
  internal address the viewer can reach). If you render specs you did not write,
  pass `limits` (which turns the defaults on) or a `urlPolicy` with `allow`.
- `allow` for images is synchronous. A relative URL needs `baseURL` once `allow`
  is set (fail closed).
- With a `baseURL` a relative image URL is drawn resolved against it, the way vega's loader
  does (`base` + `/` + `url`, `//host` getting `http:`); the resolved URL goes through the
  policy again, so `allow` sees what is drawn. Without one it is drawn as written.
- Where to pass it: `renderSpec`/`evaluateChart`/sessions take `urlPolicy` in the runtime
  input; `<Chart urlPolicy>`, `useChart(spec, { urlPolicy })` and `<ChartStream urlPolicy>`
  forward it (a denial without `onDeny` is a render error reported through `onError`; the
  stream reads it when it is created). Functions in it are compared by identity, so
  memoize the object. A Worker cannot receive `allow`/`onDeny` functions: register them
  in the worker with `registerWorkerUrlPolicy(name, { allow, onDeny })` and send
  `urlPolicy: { hooks: name, baseURL, protocols }` (`@aster/react/worker`).

## Hyperlinks (`href`)

A mark's `href` channel is drawn the way Vega's SVG renderer draws it: the item's element
sits inside `<a xlink:href="...">` (string renderer and DOM path alike; line, area and trail
link through their first item). Two checks apply to the value:

- Always, in every renderer: Vega's own link sanitizer. Only `http(s):`, `ftp:`, `mailto:`,
  `tel:`, `callto:`, `cid:`, `xmpp:`, `file:`, `data:` and scheme-less (relative) URIs are
  linked; `javascript:`, `vbscript:` and the like produce no link, whatever the spec says.
  (`//host/p` gets `http:`, `file://` is stripped to the path, as in Vega.)
- Under `limits` or an explicit `urlPolicy`, the URL policy above applies with the link
  protocols `http:`, `https:`, `mailto:`, `tel:` (and relative URLs): anything else throws
  `AsterUrlError`, or is dropped (the item is drawn without its link) when `onDeny` is set.

## Container size

`containerSize()` in expressions (Vega-Lite's `width: "container"`) returns
`[undefined, undefined]`, like headless Vega, unless the host passes
`containerSize: { width, height }` in the runtime input; Vega-Lite's own fallback size then
applies. A host that has a DOM element to fill passes its `clientWidth` / `clientHeight`.

`measuredSize: { width, height }` is the element a host lets the chart fill. It is the view size of a
spec with no `width` / `height` signal; a spec that drives those signals keeps doing so (the container
reaches it through `containerSize()`, which falls back to `measuredSize`). The view size has one value
for every consumer (scales, layout, marks and expressions); from the strongest: a fixed `width` /
`height`, a value written to the `width` / `height` signal (`signals`), then `measuredSize`.

## Locale and formatter caches

Expression `format`, `timeFormat`, `monthFormat`, ... read the **current**
default locale on every call, so `defaultLocale(...)` after import takes
effect. Memoised formatters are bounded (512 per table, least-recently-used out)
so arbitrary specifiers in data cannot grow the process without bound.

## In React and workers

- `<Chart limits>` applies the budgets at every evaluation (compared by content, so an
  inline literal is fine). A violation renders the error state and calls `onError` with
  an `AsterLimitError`. `maxSvgLength` is enforced on the SVG renderer only, by
  serializing the scene once per evaluation (only when `maxSvgLength` is set). `useChart`
  does the same when `serialize` is on.
- `useChartWorker`, `useChartWorkerStream` and `<ChartWorkerStream>` send `limits` to the
  worker, which enforces them there (the request handler runs the same sequence as
  `renderSpec`). A violation comes back as `{ name, message, code: 'ASTER_LIMIT' }`; the
  hooks turn it into an `AsterLimitError` (see `docs/ERRORS.md`).
- `useSpecData`, `useChartData` and `loadSpecData` from `@aster/react` take the same
  options as `loadSpecData` in `@aster/core/load`, so the URL policy and `limits` apply to
  Suspense loading too.
- A worker is not a kill switch by itself. To get the hard guarantee described above,
  terminate the Worker you created (`worker.terminate()`) when your own deadline passes.

## Recommended starting points

These are suggestions (a judgement, not measured defaults). Public dashboard: 100k rows, 50k items, 8 MB SVG, 2 s wall clock, and
`maxGeneratedRows: 500_000`. For an unknown spec on a server use smaller numbers
(10k rows, 250 ms), a `loadSpecData` allowlist, and a **killable worker** for the
render.
