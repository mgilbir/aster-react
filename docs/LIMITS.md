# Limits (untrusted specs and data)

Data and specs are untrusted input. `SpecLimits` are the budgets; `loadSpecData`
takes a URL policy; image marks share that policy. All limits are optional.
Omit one to leave that dimension unbounded.

```ts
import { renderSpec, type SpecLimits } from '@aster/core'

const limits: SpecLimits = {
  maxRows: 100_000,        // rows in ANY dataset: inline, host input.data, nested group data, transform output
  maxMarks: 200,           // mark definitions, recursive
  maxDepth: 32,            // spec object nesting
  maxStringLength: 10_000, // any string in the spec, a generated string, a regex input
  maxItems: 50_000,        // generated scene items (and axis/legend ticks)
  maxPathLength: 1_000_000,// any generated or supplied path `d`
  maxSvgLength: 8_000_000,
  maxTimeMs: 2_000,        // wall clock, one budget for compile + evaluate + render
  maxGeneratedRows: 500_000,   // cumulative rows produced by transforms/emitters in one evaluation
  maxGeneratedBytes: 5_000_000 // cumulative characters built by expression builtins
}

renderSpec(spec, { limits })
```

## How the budgets are enforced: meters, not checkpoints

A budget that is only compared between phases cannot stop the costs that live
inside one synchronous call (a transform, one `sequence(0, 5e7)`, a 50-million
tick axis). So each such site reports what it is **about to spend** to a *meter*
that shares the one wall clock:

| Where | What is metered |
|---|---|
| Pre-flight (`checkSpecLimits`) | strings, depth, marks, inline rows (top level, nested group `data`, host `input.data`). Iterative: a 200 000-deep or cyclic spec is an `AsterLimitError`, never a `RangeError` |
| Every dataset | rows after load/`source`/transforms must be `<= maxRows` |
| Transforms and row emitters | `sequence`, `fold` (rows x fields), `flatten`, `cross` (n x n), `impute`, `pivot`, `kde`/`quantile` steps, contour grid cells, label bitmap, graticule/ranges: checked **before** the output is allocated; `window`, `loess`, `wordcloud`, `pack`, `voronoi`, `cross` with a filter and `indata()` sample the clock **inside** their loops |
| Encode loop | one item per row: `maxItems` is checked before the mark is encoded; the clock is sampled every 1024 items |
| Guides | tick counts (`tickCount`, time intervals, `scale.bins`, quantize samples), facet/legend `columns` |
| Expression builtins | `sequence`, `pad`, number-format width (`maxStringLength`, cumulative `maxGeneratedBytes`), regex pattern/input length, `timeSequence` |
| Expression parser | nesting depth (1000): an `AsterLimitError`, not a stack overflow |
| Serialisation | every generated path `d` is checked as it is written; `maxSvgLength` on the result |
| Scene (`checkSceneLimits`) | items, `path`, string and array `text`, and a lower bound for line/area paths |

Properties worth knowing:

- **One clock.** `renderSpec`, sessions, `evaluateChart` and `getChartInfo` open a
  scope (`withLimits`) with one wall clock. The `autosize: fit` loop, which
  evaluates the content several times, no longer restarts the budget per pass.
  Calling lower-level functions (`applyTransforms`, `buildScale`) yourself? Wrap
  them in `withLimits(limits, () => ...)` to get the same metering.
- **A limit error cannot be swallowed.** The runtime has defensive `catch` blocks
  (a signal expression that fails falls back to a default). The first violation
  in a scope is recorded on the meter, every later meter call re-throws it, and
  the scope re-throws it on exit even if a `catch` ate it.
- **Cost with limits off:** every site is one module-level null test. Limits ON
  adds an amortised clock read per 1024 rows/items.

### Deviations from Vega, made for safety

Each is deliberate and only applies where noted:

| Deviation | Why |
|---|---|
| `sequence`, `range`, `ticks`, interval ranges, `pad`, format width are bounded by the active limits before allocation | one call can otherwise allocate gigabytes |
| Expression nesting deeper than 1000 (parser and AST) throws `AsterLimitError` (always on, not only under limits) | vega throws a raw `RangeError` at a stack-dependent depth |
| `bin`: a step that can never grow (underflowed to 0, `base` <= 1 that never reaches `maxbins`) throws instead of spinning forever | vega loops forever; every other `maxbins`/`base` input follows vega exactly (`maxbins: 0` -> 20, `maxbins: -1` -> NaN bins) |
| `stratify` throws vega's errors (`cycle`, `multiple roots`, `missing: id`, `ambiguous: id`, `no root`) with an `[aster] stratify:` prefix; its walks are iterative | the old code looped forever on a cycle |
| Regex patterns with catastrophic-backtracking shapes, patterns > 1024 characters, and regex inputs longer than `maxStringLength` (default 10 000) are refused **under limits** | see the regex section |
| Decoded topojson coordinates are budgeted against `maxGeneratedRows` (else `maxRows`) | arcs are shared, so 22 KB of input can decode to millions of points |
| `scale.bins` with a step that is not positive and finite yields no bins | the loop never advanced |
| `topojson` object names are looked up as own properties (`constructor`, `__proto__` are "not found") | the name is spec-controlled |

### Regular expressions: what a cooperative clock cannot do

A JavaScript regular expression runs to completion once started. A pattern such
as `(a+)+$` against `aaaa...!` takes time exponential in the input length and
**no check inside Aster can interrupt it**, and the attack input is tiny (26
characters cost seconds, 40 never return). Under limits Aster does two things
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
   - a backreference inside a group that repeats more than once.
2. **Length caps**: a pattern over 1024 characters, or an input longer than
   `maxStringLength` (default 10 000), is refused. This bounds linear patterns.

**This is a heuristic, not a guarantee.** It blocks the known catastrophic
shapes. It does not prove a pattern safe: polynomial blow-ups such as `a*a*a*b`
pass, and safe patterns with a repeated group around an unbounded quantifier,
such as `(\d+\.)*\d+`, are refused (rewrite them without the nesting). Syntax
the screen cannot parse is passed to the RegExp constructor unscreened. Without
limits nothing is screened (vega parity).

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
| `baseURL` | none | base for relative `url`s. Without it a relative url is an error. A url on the base's own origin is host-chosen and needs no `allow` |
| `protocols` | `['http:', 'https:']` | allowed protocols. `data:` is denied unless you add it. `file:`, `javascript:`, `ftp:`, `blob:` and URLs with embedded credentials are always refused unless listed |
| `allow(url)` | none | veto hook, awaited for the first URL **and every redirect hop**. This is the place for an origin allowlist |
| `allowPrivateNetwork` | `false` | permit loopback, private, link-local (cloud metadata), CGNAT, multicast hosts, `localhost`, `*.local`, `*.internal`, and their IPv6/mapped/NAT64/6to4 forms. Not applied to the `baseURL` origin. `allow` alone cannot override it |
| `timeoutMs` | 10 000 | per request, covering headers **and** body (an `AsterLimitError`) |
| `maxBytes` | 10 MiB | enforced **while the body streams** (a declared `content-length` over it is refused up front); the producer is cancelled, not buffered first |
| `maxConcurrent` | 4 | requests in flight at once |
| `maxRedirects` | 5 | redirects are followed manually; each hop goes through the whole policy **before** it is requested |
| `signal` | none | abort the whole load |
| `limits` | none | `maxRows` per loaded dataset, topojson coordinates, and `maxTimeMs` over the whole call |

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
renderSpec(spec, { urlPolicy: {
  baseURL: 'https://app.example.com/',
  allow: (url) => url.hostname === 'cdn.example.com',
  onDeny: (url, error) => log(error.reason), // drop the image instead of throwing
}})
```

- With `urlPolicy` it is applied as given. With `limits` and no `urlPolicy` the
  defaults apply (the spec is untrusted): `http:`, `https:`, `data:` and relative
  URLs only, no credentials; anything else throws `AsterUrlError` (or is dropped
  when `onDeny` is set).
- With neither, images are not vetted. That is parity with Vega, which draws any
  `url`, and an SVG `<image>` cannot execute script, so `javascript:` is not an
  injection vector there. **Residual risk:** a spec can still make the viewer's
  browser request an arbitrary URL (a tracking pixel, an IP leak, a request to an
  internal address the viewer can reach). If you render specs you did not write,
  pass `limits` (which turns the defaults on) or a `urlPolicy` with `allow`.
- `allow` for images is synchronous. A relative URL needs `baseURL` once `allow`
  is set (fail closed).
- `<Chart>` does not forward `urlPolicy` yet; set it where you call
  `renderSpec`/`evaluateChart`.

## Locale and formatter caches

Expression `format`, `timeFormat`, `monthFormat`, ... read the **current**
default locale on every call, so `defaultLocale(...)` after import takes
effect. Memoised formatters are bounded (512 per table, least-recently-used out)
so arbitrary specifiers in data cannot grow the process without bound.

## Recommended starting points

Public dashboard: 100k rows, 50k items, 8 MB SVG, 2 s wall clock, and
`maxGeneratedRows: 500_000`. For an unknown spec on a server use smaller numbers
(10k rows, 250 ms), a `loadSpecData` allowlist, and a **killable worker** for the
render.
