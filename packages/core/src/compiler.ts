/**
 * vg-compiler: Vega spec JSON -> CompiledChart IR.
 * Consumes the Vega spec directly (the canonical IR). Vega-Lite specs reach it
 * through `@aster-charts/vl` (packages/vl), the from-scratch Vega-Lite compiler, which
 * emits the Vega this compiler consumes.
 */
import { namedSetsOf } from './encode-handlers.js'
import { dict, ownGet } from './util.js'
import { SpecParseError } from './parse-error.js'
import { parseExpressionCached } from './expr-parser.js'
import { assertSpecDepth } from './limits.js'
import { dataInputOf, normalizeSpecLists, VEGA_MARK_TYPES } from './spec-structure.js'
import { noteWrittenType, transformTypeOf } from './transform-names.js'
import { checkSpecExpressions } from './spec-expressions.js'
import { engineSlotMessage, isEngineSlot } from './item-slots.js'
import { checkFieldReferences } from './param-resolve.js'
import { markPlacing } from './tuple-order.js'
import { markShareable } from './guide-encode.js'
import { ENTER_COPY, setSpatialProgram, spatialProgramOf } from './spatial.js'
import { defaultMergedConfig, mergeVegaConfig, vegaDefaultConfig } from './config-defaults.js'
import { isSignalRef, paddingOf, staticAutosize, viewProperty, viewSignals } from './view-props.js'
import { assertSpecObject } from './spec-guards.js'
import type {
  CompiledAxis,
  CompiledChart,
  CompiledData,
  CompiledLegend,
  CompiledMark,
  CompiledProjection,
  CompiledScale,
  CompiledSignalDef,
  SignalOnDef,
  CompiledTitle,
  CompiledTransform,
  EncodeValue,
  SizeSpec,
  VgSpec,
} from './types.js'


export function compileChart(givenSpec: VgSpec): CompiledChart {
  assertSpecObject(givenSpec, 'compileChart')
  // a spec nested past the ceiling (or cyclic) is a typed error here, not a RangeError from the recursion below
  assertSpecDepth(givenSpec)
  // vega-parser reads every scope list through vega-util `array()` and refuses a spec that uses a data
  // set it never declared (`Undefined data set name`) before any view exists: same here, before anything runs.
  const rawSpec = normalizeSpecLists(givenSpec)
  // Vega parses a view with mergeConfig(defaultConfig(), spec.config): every
  // default below (mark, axis, legend, title, style, range...) is read from this
  // merged config, exactly as upstream does (see config-defaults.ts).
  const userConfig = rawSpec.config as Record<string, unknown> | undefined
  const mergedConfig = (userConfig == null || (typeof userConfig === 'object' && !Array.isArray(userConfig) && Object.keys(userConfig).length === 0)
    ? defaultMergedConfig()
    : mergeVegaConfig(vegaDefaultConfig(), userConfig)) as Record<string, unknown>
  // (one walk, in vega-parser's order: the data sets and scales a spec names, the parameters of its transforms, its expressions)
  const { regexSites, unitIndexed } = checkSpecExpressions(rawSpec, mergedConfig)
  markSeq = 0
  const spec: VgSpec = { ...rawSpec, config: mergedConfig as VgSpec['config'] }

  const cfg = (spec.config ?? {}) as Record<string, unknown>
  // The view's own properties are signals of the view (vega-parser `collectSignals`, see view-props.ts): the spec's property, else
  // the config's; a `{signal}` there is the signal's update, and a signal the spec declares by the same name is merged over it.
  // The signals are the spec's in that order, then the config's the spec does not declare.
  const viewSignalList = viewSignals(spec as Record<string, unknown>, cfg)
  const signalDefs = compileSignalDefs(viewSignalList)
  const signals = resolveSignals(signalDefs)
  const cfgStyle = (cfg.style ?? {}) as Record<string, Record<string, unknown>>
  const sigNames = signalDefs.map((d) => d.name).filter(Boolean)
  // (a view property that is a signal is read from the signal's value when the chart is evaluated: the static value here is what a
  // view whose signal never computes one shows)
  const viewValue = (name: 'background' | 'autosize' | 'padding' | 'width' | 'height'): unknown => {
    const v = viewProperty(spec as Record<string, unknown>, cfg, name)
    return isSignalRef(v) ? undefined : v
  }
  const bg = viewValue('background')
  // (vega-scenegraph writes a truthy background as the attribute's text: a number is its digits)
  const background = bg ? String(bg) : null
  const padding = paddingOf(viewValue('padding'))
  // A view size is its `width` / `height` signal (vega: the root group's size is `{signal: 'width'}`): one the spec declares or a
  // `{signal}` property makes is read from the signal's value when the chart is evaluated (its static `value` until it computes
  // one); otherwise the size is the property (spec, else config) as vega-parser makes it the signal's value, `|| 0`.
  const sizeOf = (name: 'width' | 'height'): SizeSpec => {
    if (sigNames.includes(name)) return { signal: name }
    const v = viewValue(name)
    return typeof v === 'number' ? v : (+(v as number) || 0)
  }
  const width = sizeOf('width')
  const height = sizeOf('height')
  const contentSized = (['width', 'height'] as const).filter((d) => viewProperty(spec as Record<string, unknown>, cfg, d) == null && !sigNames.includes(d))
  const frameStroke = resolveFrameStroke(spec)
  const frameFill = resolveFrameFill(spec)
  const frameFillTransparent = frameStyleValue(spec, 'fill') === 'transparent'
  const frameStrokeWidth = resolveFrameNumber(spec, 'strokeWidth')
  const frameFillOpacity = resolveFrameNumber(spec, 'fillOpacity')
  const frameOpacity = resolveFrameNumber(spec, 'opacity')
  const frameStrokeDash = resolveFrameDash(spec)
  const frameCornerRadius = resolveFrameNumber(spec, 'cornerRadius')
  const frameClip = frameStyleValue(spec, 'clip') === true
  const frameStrokeOpacity = resolveFrameNumber(spec, 'strokeOpacity')
  const frameStrokeMiterLimit = resolveFrameNumber(spec, 'strokeMiterLimit')
  const frameStrokeDashOffset = resolveFrameNumber(spec, 'strokeDashOffset')
  const frameStrokeCap = resolveFrameString(spec, 'strokeCap')
  const frameStrokeJoin = resolveFrameString(spec, 'strokeJoin')
  // (an `autosize` signal is read when the chart is evaluated; this is the property as vega-parser makes it the signal's value)
  const { type: autosize, contains: autosizeContains } = staticAutosize(viewValue('autosize'))
  const configRange = (cfg as { range?: Record<string, unknown> }).range

  const data: CompiledData[] = []
  for (const d of (spec.data as Array<Record<string, unknown>>) ?? []) {
    data.push(compileData(d))
  }

  const scales: CompiledScale[] = []
  for (const s of (spec.scales as Array<Record<string, unknown>>) ?? []) {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error('[aster] a scale definition must be an object')
    scales.push(compileScale(s))
  }

  const axes = compileGuideAxes(spec.axes as Array<Record<string, unknown>> | undefined, cfg, scales)
  const legends = compileGuideLegends(spec.legends as Array<Record<string, unknown>> | undefined, cfg)

  const marks: CompiledMark[] = []
  for (const m of (spec.marks as Array<Record<string, unknown>>) ?? []) {
    marks.push(compileMark(m, cfgStyle, cfg as Record<string, Record<string, unknown>> | undefined, scales))
  }

  const title = compileTitle(spec.title, spec.config as Record<string, unknown> | undefined)

  const projections: CompiledProjection[] = []
  for (const pr of (spec.projections as Array<Record<string, unknown>>) ?? []) {
    projections.push(compileProjection(pr, (cfg as { projection?: Record<string, unknown> }).projection))
  }

  return {
    ...((q) => (q === undefined ? {} : { callsIsTuple: q }))(tupleQuestions(spec)),
    ...(comparesTuples(spec) ? { comparesTuples: true as const } : {}),
    ...(regexSites.length ? { regexSites } : {}),
    ...(unitIndexed.length ? { unitIndexed } : {}),
    autosize,
    width,
    height,
    padding,
    background,
    // (vega-parser: `spec.description || config.description`, which vega-view writes as the container's aria-label)
    ...((rawSpec.description || (mergedConfig as { description?: unknown }).description) ? { description: String(rawSpec.description || (mergedConfig as { description?: unknown }).description) } : {}),
    frameStroke,
    frameFill,
    ...(frameFillTransparent ? { frameFillTransparent: true as const } : {}),
    frameStrokeWidth,
    frameFillOpacity,
    frameOpacity,
    frameStrokeDash,
    frameCornerRadius,
    frameClip,
    frameStrokeOpacity,
    frameStrokeMiterLimit,
    frameStrokeDashOffset,
    frameStrokeCap,
    frameStrokeJoin,
    ...((typeof (cfg.legend as { layout?: unknown } | undefined)?.layout === 'object' && (cfg.legend as { layout?: unknown }).layout !== null) ? { legendLayout: (cfg.legend as { layout: Record<string, unknown> }).layout } : {}),
    ...frameEncodeOf(spec),
    data,
    scales,
    axes,
    legends,
    marks,
    signals,
    signalDefs,
    title,
    projections,
    configRange,
    autosizeContains,
    style: cfgStyle,
    ...(cfg.lineBreak != null ? { lineBreak: cfg.lineBreak } : {}),
    ...(cfg.events != null && typeof cfg.events === 'object' ? { eventConfig: cfg.events as CompiledChart['eventConfig'] } : {}),
    // (vega-view reads `spec.locale` when it is truthy: an object's `number` and `time` halves; anything else is the default locale)
    ...(cfg.locale != null && typeof cfg.locale === 'object' ? { locale: cfg.locale as CompiledChart['locale'] } : {}),
    layout: (spec.layout as Record<string, unknown> | undefined) ?? undefined,
    ...(contentSized.length ? { contentSized } : {}),
  }
}

/**
 * Parse a projection definition. Numeric parameters may be literal, a
 * `{signal}` object (resolved at runtime), or an expression string (e.g.
 * `"[width / 2, height / 2]"`).
 */
function compileProjection(pr: Record<string, unknown>, config?: Record<string, unknown>): CompiledProjection {
  // vega-parser: every parameter is carried (a signal stays a signal; the runtime
  // resolves it per evaluation), then `config.projection` fills what the spec left out.
  const out = dict<unknown>({ name: pr.name, type: (pr.type as string) || 'mercator' })
  for (const [k, v] of Object.entries(pr)) {
    if (k === 'name' || k === 'type' || v == null) continue
    out[k] = v
  }
  for (const [k, v] of Object.entries(config ?? {})) {
    if (out[k] == null && v != null) out[k] = v
  }
  return out as unknown as CompiledProjection
}

/**
 * Whether an evaluation of the spec must register the tuples it makes (see `withTuples`): an expression of the spec (or its config)
 * asks `isTuple` of something that may be one of them. The words of the spec are looked at, not the rows of its inline data
 * (`values` arrays), so a large dataset costs nothing; a mention outside an expression only makes the evaluation register what it
 * need not. Two questions Vega-Lite asks in every selection need no registration, and do not count:
 * - `isTuple(group())`: `group()` is only defined in an event handler (vega throws without an event), where it gives the event
 *   loop's item facade, registered whatever the evaluation;
 * - `isTuple(facet)`, when every signal named `facet` is Vega-Lite's (`{}`, then `isTuple(facet) ? facet : group(...).datum` on
 *   events): its value is then `{}` or a facet cell's datum, registered whatever the evaluation. A host can still set the signal;
 *   `'facet'` says the evaluation looks at the value it is given (see `registersTuples` in runtime.ts).
 */
/**
 * Whether an expression of the spec compares two values that may be objects: an equality operator neither of whose operands is a
 * literal, one of them a bare name (`datum === src`, `item != hovered`). Over-counting costs only the bookkeeping of
 * `withTupleOrigins`; a comparison it misses would compare copies of one row as different objects.
 */
const EQUALITY = new Set(['==', '!=', '===', '!=='])
const NOT_OBJECTS = new Set(['undefined', 'NaN', 'Infinity'])
function comparesTuples(spec: unknown): boolean {
  const seen = new Set<unknown>()
  const isName = (n: { type?: unknown; name?: unknown }): boolean => n.type === 'Identifier' && !NOT_OBJECTS.has(n.name as string)
  const compares = (tree: unknown): boolean => {
    const stack: unknown[] = [tree]
    while (stack.length) {
      const e = stack.pop()
      if (e === null || typeof e !== 'object') continue
      if (Array.isArray(e)) { for (const x of e) stack.push(x); continue }
      const node = e as { type?: unknown; operator?: unknown; left?: { type?: unknown; name?: unknown }; right?: { type?: unknown; name?: unknown } }
      if (node.type === 'BinaryExpression' && EQUALITY.has(node.operator as string) && node.left && node.right
        && node.left.type !== 'Literal' && node.right.type !== 'Literal' && (isName(node.left) || isName(node.right))) return true
      for (const v of Object.values(node)) if (v !== null && typeof v === 'object') stack.push(v)
    }
    return false
  }
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') {
      if (!/[=!]=/.test(v)) return false
      let tree: unknown
      try { tree = parseExpressionCached(v) } catch { return false }
      return compares(tree)
    }
    if (v === null || typeof v !== 'object' || seen.has(v)) return false
    seen.add(v)
    if (Array.isArray(v)) return v.some(walk)
    // (a dataset's inline rows are data, not expressions: never read -- a host's row may be read only where the chart draws it)
    return Object.keys(v).some((k) => !(k === 'values' && Array.isArray((v as Record<string, unknown>)[k])) && walk((v as Record<string, unknown>)[k]))
  }
  return walk(spec)
}

function tupleQuestions(spec: unknown): true | 'facet' | undefined {
  const seen = new Set<unknown>()
  let facet = false
  let facetSignalsVl = true
  let all = false
  const VL_FACET = /^isTuple\(facet\) \? facet : group\((?:"[^"\\]*"|'[^'\\]*')?\)\.datum$/
  const ask = (text: string): void => {
    for (let i = text.indexOf('isTuple'); i >= 0 && !all; i = text.indexOf('isTuple', i + 7)) {
      const arg = /^isTuple\s*\(\s*(group\s*\(\s*\)|facet)\s*\)/.exec(text.slice(i))?.[1]
      if (arg === undefined) all = true
      else if (arg === 'facet') facet = true
    }
  }
  const signal = (sig: Record<string, unknown>): void => {
    if (sig.name !== 'facet') return
    const on = Array.isArray(sig.on) ? sig.on as Array<Record<string, unknown>> : []
    const value = sig.value
    const valueOk = value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    const updates = on.map((h) => h.update)
    if (!valueOk || sig.init !== undefined || sig.update !== undefined || sig.bind !== undefined || sig.push !== undefined
      || on.some((h) => h.encode !== undefined) || !updates.every((u) => typeof u === 'string' && VL_FACET.test(u.trim()))) facetSignalsVl = false
  }
  const walk = (v: unknown, inSignals: boolean): void => {
    if (all) return
    if (typeof v === 'string') { if (v.includes('isTuple')) ask(v); return }
    if (v === null || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    if (Array.isArray(v)) {
      for (const x of v) { if (inSignals && x !== null && typeof x === 'object') signal(x as Record<string, unknown>); walk(x, false) }
      return
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'values' && Array.isArray(x)) continue
      walk(x, k === 'signals' && Array.isArray(x))
    }
  }
  walk(spec, false)
  if (all || (facet && !facetSignalsVl)) return true
  return facet ? 'facet' : undefined
}

/**
 * The root frame's style value for `prop`, resolved the way vega-parser's
 * `applyDefaults` does for the frame role: `config.group` first, then each
 * entry of the view's `style` list in order (later styles win). `config.view`
 * is NOT a Vega config key (Vega-Lite folds its view config into `style.cell`),
 * and a `cell` style only applies when the spec asks for it.
 */
function frameStyleValue(spec: VgSpec, prop: string): unknown {
  const config = spec.config as { group?: Record<string, unknown> | null; style?: Record<string, Record<string, unknown>> } | undefined
  const style = spec.style
  const names = Array.isArray(style) ? style : style ? [style] : []
  let v: unknown = config?.group?.[prop]
  for (const name of names) {
    const block = config?.style?.[String(name)]
    if (block && prop in block) v = block[prop]
  }
  return v
}

/**
 * The view's own `encode` (`enter` under `update`), under the ARIA defaults the root frame takes from `config.group` and its
 * styles (vega-parser applyDefaults: a default is overridden by the encode's channel). Undefined when there is neither.
 */
function frameEncodeOf(spec: VgSpec): { frameEncode: NonNullable<CompiledChart['frameEncode']> } | undefined {
  const own = spec.encode as { enter?: object; update?: object } | undefined
  const aria: NonNullable<CompiledChart['frameEncode']> = {}
  for (const k of ['description', 'aria', 'ariaRole', 'ariaRoleDescription']) {
    const v = frameStyleValue(spec, k)
    if (v !== undefined) aria[k] = (v !== null && typeof v === 'object' && 'signal' in v ? { signal: (v as { signal: string }).signal } : { value: v }) as EncodeValue
  }
  // The root group's encode is vega-parser's `rootEncode` under the view's own: x and y 0 in `enter`, the size signals in `update`.
  // Its defaults (config.group, then the view's styles) can only add the edges `x2`, `xc`, `y2`, `yc` to its spatial channels
  // (the others are its own), and they land in `enter`: an `xc` places the root group at `xc` (vega adjusts each set on its own).
  const ownEnter = (own?.enter ?? {}) as Record<string, EncodeValue>
  const ownUpdate = (own?.update ?? {}) as Record<string, EncodeValue>
  const enter: Record<string, EncodeValue> = { x: { value: 0 }, y: { value: 0 } } as Record<string, EncodeValue>
  const update: Record<string, EncodeValue> = { width: { signal: 'width' }, height: { signal: 'height' } } as Record<string, EncodeValue>
  const has = (k: string): boolean => Object.hasOwn(enter, k) || Object.hasOwn(update, k) || hasOwnChannel({ enter: ownEnter, update: ownUpdate }, k)
  let spatialDefaults = false
  for (const k of ['x2', 'xc', 'y2', 'yc']) {
    const v = frameStyleValue(spec, k)
    if (v === undefined || has(k)) continue
    spatialDefaults = true
    if (v && typeof v === 'object' && (v as { signal?: unknown }).signal) update[k] = { signal: (v as { signal: string }).signal } as EncodeValue
    else enter[k] = { value: v } as EncodeValue
  }
  Object.assign(enter, ownEnter)
  Object.assign(update, ownUpdate)
  const keys = (set: Record<string, unknown>): Set<string> => new Set(Object.keys(set).filter((k) => set[k] != null))
  const program = spatialDefaults || own !== undefined ? spatialProgramOf('group', keys(enter), keys(update)) : undefined
  if (program === undefined && !spatialDefaults) {
    if (own === undefined && Object.keys(aria).length === 0) return undefined
    return { frameEncode: { ...aria, ...ownEnter, ...ownUpdate } as NonNullable<CompiledChart['frameEncode']> }
  }
  const merged: Record<string, EncodeValue | EncodeValue[]> = { ...aria, ...enter, ...update }
  if (program) {
    for (const dim of [program.x, program.y]) for (const k of dim?.enter ?? []) if (dim!.update.includes(k)) merged[ENTER_COPY + k] = enter[k]!
    setSpatialProgram(merged, program)
  }
  return { frameEncode: merged as NonNullable<CompiledChart['frameEncode']> }
}

/** The cell background fill. */
function resolveFrameFill(spec: VgSpec): string | undefined {
  const fill = frameStyleValue(spec, 'fill')
  return typeof fill === 'string' && fill !== 'transparent' ? fill : undefined
}

function resolveFrameStroke(spec: VgSpec): string | undefined {
  const stroke = frameStyleValue(spec, 'stroke')
  // (a 'transparent' stroke is a stroke to the scenegraph -- the frame is inset by its half width -- that the SVG leaves out)
  return typeof stroke === 'string' ? stroke : undefined
}

function resolveFrameNumber(spec: VgSpec, prop: string): number | undefined {
  const v = frameStyleValue(spec, prop)
  return typeof v === 'number' ? v : undefined
}

function resolveFrameString(spec: VgSpec, prop: string): string | undefined {
  const v = frameStyleValue(spec, prop)
  return typeof v === 'string' ? v : undefined
}

function resolveFrameDash(spec: VgSpec): number[] | undefined {
  const v = frameStyleValue(spec, 'strokeDash')
  return Array.isArray(v) ? v.map(Number) : undefined
}

/** vega-functions parseExpression's text for a signal's `init` / `update`: a string as it is, anything else truthy as its JSON; a falsy one is none. */
function signalExprText(v: unknown): string | undefined {
  if (!v) return undefined
  if (typeof v === 'string') return v
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

function compileSignalDefs(signals?: Array<Record<string, unknown>>): CompiledSignalDef[] {
  const out: CompiledSignalDef[] = []
  for (const s of signals ?? []) {
    if (!s || typeof s !== 'object') continue
    const def: CompiledSignalDef = { name: s.name as string }
    // a null value is a value (`??` would fall through to `init` for it)
    if (s.value !== undefined) def.value = s.value
    // `init` is an expression (vega signal-updates: `op.initonly`), not a value.
    // (vega-parser reads a truthy one as the text of an expression -- a number, a boolean, an array are written out as their JSON --
    // and ignores a falsy one: `init: 15` is 15, `init: 0` is no init)
    const init = signalExprText(s.init)
    if (init !== undefined && s.update === undefined) def.init = init
    const update = signalExprText(s.update)
    if (update !== undefined || typeof s.update === 'string') def.update = update ?? (s.update as string)
    if (s.bind != null && (typeof s.bind === 'string' || typeof s.bind === 'object')) {
      def.bind = s.bind as Record<string, unknown> | string
    }
    if (s.push === 'outer') def.push = 'outer'
    else if (s.react === false) def.react = false
    if (Array.isArray(s.on)) {
      // An event handler's `update` runs when its event fires; it is NOT a static
      // initial value. (Promoting the first handler to `def.update` made a signal
      // such as `(count||0)+1` tick on every evaluation with no event;
      // vega leaves such a signal undefined until the event.)
      // Keep the full event-stream spec: the host binds these via
      // bindSignalEvents (signals.ts) to drive the event loop.
      // Entries are kept whole (each entry object copied; what an entry holds -- its `events`, an
      // `encode` -- is the spec's, as are a dataset's `values` and `format`, a guide's `encode` and a
      // transform's parameter values: the compiled chart is not to be written, nor the spec while it is
      // in use): the event loop interprets `events` (string | object | array) itself.
      const on = (s.on as SignalOnDef[]).filter((o) => o != null && typeof o === 'object').map((o) => ({ ...o })) as SignalOnDef[]
      def.on = on
    }
    out.push(def)
  }
  return out
}

function resolveSignals(defs: CompiledSignalDef[]): Record<string, unknown> {
  const out = dict<unknown>()
  for (const s of defs) {
    if (s.value !== undefined) out[s.name] = s.value
  }
  return out
}

function compileData(d: Record<string, unknown>): CompiledData {
  const compiled: CompiledData = {
    name: d.name as string,
    transform: [],
  }
  // only the input vega reads is compiled (values, else url, else source), so every later step agrees with it
  const input = dataInputOf(d)
  if (input === 'values') compiled.values = d.values as unknown[]
  if (input === 'url') compiled.url = d.url as string
  if (d.format !== undefined) compiled.format = d.format as Record<string, unknown>
  if (input === 'source') compiled.source = (Array.isArray(d.source) ? d.source.map(String) : d.source) as string | string[]
  for (const t of (d.transform as Array<Record<string, unknown>>) ?? []) {
    compiled.transform.push(compileTransform(t))
  }
  markPlacing(compiled.transform as ReadonlyArray<{ type?: unknown; sort?: unknown }>)
  const on = (Array.isArray(d.on) ? d.on : d.on != null ? [d.on] : []).filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object')
  if (on.length) compiled.on = on
  return compiled
}

function compileTransform(t: Record<string, unknown>): CompiledTransform {
  const type = transformTypeOf(t.type)
  const out = dict<unknown>({ type }) // prototype-less: spec keys such as `__proto__` stay plain data
  noteWrittenType(out, t.type as string, type)
  for (const key of Object.keys(t)) {
    if (key === 'type') continue
    out[key] = t[key]
  }
  // (a field that is no access path is refused as vega's runtime refuses it, building the view)
  checkFieldReferences(out)
  return out as CompiledTransform
}


function compileScale(s: Record<string, unknown>): CompiledScale {
  // (a scale of a type vega-scale does not register is refused when the spec's expressions are read: spec-structure.ts `checkScale`)
  // prototype-less: scale keys are spec data (`__proto__` stays a plain key)
  const out = dict<unknown>({ name: s.name, type: s.type, domain: s.domain, range: s.range })
  // vega-parser copies every other scale key through to the Scale transform
  // (interpolateGamma, schemeExtent, domainImplicit, ...): a whitelist silently
  // dropped whatever it forgot. buildScale warns about a key the scale has no method of its own for, as vega does.
  for (const key of Object.keys(s)) {
    if (key === 'name' || key === 'type' || key === 'domain' || key === 'range') continue
    if (s[key] !== undefined) out[key] = s[key]
  }
  return out as unknown as CompiledScale
}

/**
 * The axes of one scope (the view or a group mark) with their config defaults.
 * vega applies the same lookup at every level - the config is the view's, the
 * scales are those the scope can see - so a nested group's axes follow
 * `config.axis` exactly as the top-level ones do.
 */
/** the axis config blocks of the default config, by orient and band: four orients, two kinds of scale at most */
const DEFAULT_AXIS_BLOCKS = new Map<string, Record<string, unknown>>()

function compileGuideAxes(raw: Array<Record<string, unknown>> | undefined, cfg: Record<string, unknown>, scales: CompiledScale[]): CompiledAxis[] {
  const cfgAxis = (cfg.axis ?? {}) as Record<string, unknown>
  const cfgAxisX = (cfg.axisX ?? {}) as Record<string, unknown>
  const cfgAxisY = (cfg.axisY ?? {}) as Record<string, unknown>
  const cfgAxisBand = (cfg.axisBand ?? {}) as Record<string, unknown>
  const axes: CompiledAxis[] = []
  for (const a of raw ?? []) {
    // vega axisConfig precedence (vega-parser axisConfig): axis < axisX/axisY
    // (by orient) < axis<Orient> < axisBand (band scales) - later wins; the
    // axis def itself then wins over every block.
    const orientRaw = a.orient as unknown
    if (orientRaw && typeof orientRaw === 'object' && typeof (orientRaw as { signal?: unknown }).signal === 'string') {
      // `orient: {signal}`: the config blocks are consulted per key, as signal expressions over the orient signal (vega's
      // axis config), so a guide property that carries one is a signal property like any other
      const sc = [...scales].reverse().find((s) => s.name === a.scale)
      const axis = compileAxis(applyConfigDefaults({ ...a, orient: '' }, signalOrientDefaults(cfg, (orientRaw as { signal: string }).signal, sc?.type === 'band')))
      axes.push({ ...axis, orientSignal: { signal: (orientRaw as { signal: string }).signal } })
      continue
    }
    const orient = String(a.orient ?? '')
    // the innermost scale of that name wins (a group's own scale shadows the view's)
    const sc = [...scales].reverse().find((s) => s.name === a.scale)
    const band = sc?.type === 'band'
    // (the blocks of a config nobody can change are merged once: the guides' marks are kept against the result)
    const memo = cfg === defaultMergedConfig() ? DEFAULT_AXIS_BLOCKS : undefined
    const memoKey = `${orient}|${band}`
    let defaults = memo?.get(memoKey)
    if (defaults === undefined) {
      defaults = { ...cfgAxis }
      Object.assign(defaults, orient === 'top' || orient === 'bottom' ? cfgAxisX : cfgAxisY)
      const orientBlock = (cfg as Record<string, Record<string, unknown>>)[`axis${orient.charAt(0).toUpperCase()}${orient.slice(1)}`]
      if (orient && typeof orientBlock === 'object') Object.assign(defaults, orientBlock)
      if (band) Object.assign(defaults, cfgAxisBand)
      if (memo !== undefined) { Object.freeze(defaults); markShareable(defaults); memo.set(memoKey, defaults) }
    }
    axes.push(compileAxis(applyConfigDefaults(a, defaults)))
  }
  return axes
}

/** The legends of one scope with `config.legend` defaults (see {@link compileGuideAxes}). */
function compileGuideLegends(raw: Array<Record<string, unknown>> | undefined, cfg: Record<string, unknown>): CompiledLegend[] {
  const cfgLegend = (cfg.legend ?? {}) as Record<string, unknown>
  if (cfg === defaultMergedConfig() && cfg.legend) markShareable(cfgLegend)
  return (raw ?? []).map((l) => compileLegend(applyConfigDefaults(l, cfgLegend, true)))
}

/** Where the config blocks say a thing about the orient: the keys of the blocks, whichever block holds them. */
const keysOf = (...blocks: Array<unknown>): string[] => {
  const seen = new Set<string>()
  for (const b of blocks) if (b && typeof b === 'object') for (const k of Object.keys(b)) seen.add(k)
  return [...seen]
}

/**
 * The axis defaults for an `orient` that is a signal: every key that an orient-dependent config block (axisX / axisY, and
 * axisTop / axisBottom / axisLeft / axisRight) mentions becomes an expression over the signal choosing among the blocks'
 * values, the rest are the plain `axis` block. The expression text is the one the orient decides with, so a signal that
 * is itself an expression keeps its precedence quirks. A property so made is a signal property: it is truthy as a flag
 * whatever it evaluates to, as for a spec that wrote the signal.
 */
function signalOrientDefaults(cfg: Record<string, unknown>, orient: string, band: boolean): Record<string, unknown> {
  const block = (name: string): Record<string, unknown> | undefined => {
    const b = cfg[name]
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : undefined
  }
  const axis = block('axis') ?? {}
  const style = (block('style') ?? {}) as Record<string, Record<string, unknown> | undefined>
  /** a block's own value for a key, else the `axis` block's, else the guide style's for the title and label keys */
  const fallback = (key: string, own: Record<string, unknown> | undefined): unknown => {
    if (own && Object.hasOwn(own, key)) return own[key]
    if (Object.hasOwn(axis, key)) return axis[key]
    const from = key.startsWith('title') ? 'guide-title' : key.startsWith('label') ? 'guide-label' : undefined
    if (from === undefined) return null
    const prop = key === 'titleColor' || key === 'labelColor' ? 'fill' : /^(title|label)(Font|FontSize|FontWeight)$/.test(key) ? key[5]!.toLowerCase() + key.slice(6) : undefined
    return prop === undefined ? undefined : style[from]?.[prop]
  }
  const text = (v: unknown): string | null => (v === undefined || v === null ? null : isSignalValue(v) ? v.signal : JSON.stringify(v))
  const axisX = block('axisX')
  const axisY = block('axisY')
  const out: Record<string, unknown> = { ...axis }
  const horizontal = `${orient} === 'top' || ${orient} === 'bottom'`
  for (const key of keysOf(axisX, axisY)) {
    out[key] = { signal: `${horizontal} ? (${text(fallback(key, axisX))}) : (${text(fallback(key, axisY))})` }
  }
  const top = block('axisTop')
  const bottom = block('axisBottom')
  const left = block('axisLeft')
  const right = block('axisRight')
  for (const key of keysOf(top, bottom, left, right)) {
    const part = (name: string, own: Record<string, unknown> | undefined): string => {
      const v = text(fallback(key, own))
      return v === null ? '' : `${orient} === '${name}' ? (${v}) : `
    }
    out[key] = { signal: part('left', left) + part('bottom', bottom) + part('right', right) + part('top', top) + '(null)' }
  }
  if (band) Object.assign(out, block('axisBand'))
  return out
}

const isSignalValue = (v: unknown): v is { signal: string } => !!v && typeof v === 'object' && typeof (v as { signal?: unknown }).signal === 'string'

function compileAxis(a: Record<string, unknown>): CompiledAxis {
  const out: CompiledAxis = {
    scale: a.scale as string,
    orient: a.orient as CompiledAxis['orient'],
  }

  // Every axis property is carried as written (vega reads each by name; a whitelist silently dropped whatever it forgot).
  for (const key of Object.keys(a)) {
    if (key === 'encode' || key === 'scale' || key === 'orient') continue
    if (a[key] !== undefined && !Object.hasOwn(out, key)) (out as unknown as Record<string, unknown>)[key] = a[key]
  }
  if (a.encode !== undefined) out.encode = a.encode as CompiledAxis['encode']
  return out
}

function compileLegend(l: Record<string, unknown>): CompiledLegend {
  const out: CompiledLegend = {}

  // every legend property is carried as written (a whitelist silently dropped whatever it forgot)
  for (const key of Object.keys(l)) {
    if (key === 'encode') continue
    if (l[key] !== undefined && !Object.hasOwn(out, key)) (out as unknown as Record<string, unknown>)[key] = l[key]
  }
  if (l.encode !== undefined) out.encode = l.encode as CompiledLegend['encode']
  return out
}

function compileTitle(value: unknown, config?: Record<string, unknown>): CompiledTitle | undefined {
  // vega's parser reads `if (spec.title)`: an empty-string (or otherwise falsy) title is no title, an object with empty text is one
  if (!value) return undefined
  const spec = typeof value === 'string' ? { text: value } : (value as Record<string, unknown>)
  const cfg = (config?.title ?? {}) as Record<string, unknown>
  // vega-parser title.js: the text mark's style is the spec's `style` (default
  // 'group-title'); a property the title spec and config.title leave unset
  // comes from that style's block of config.style.
  const cfgStyle = (config?.style ?? {}) as Record<string, Record<string, unknown>>
  const styleNames = ([] as unknown[]).concat(spec.style ?? 'group-title').map(String)
  const sty: Record<string, unknown> = {}
  for (const n of styleNames) Object.assign(sty, ownGet(cfgStyle, n))
  // Defaults mirror vega's config.title block (orient top, anchor middle,
  // offset 4, subtitlePadding 3).
  const textOf = (raw: unknown): CompiledTitle['text'] => (raw && typeof raw === 'object' && 'signal' in (raw as Record<string, unknown>)
    ? { signal: String((raw as { signal: unknown }).signal) }
    : typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(String) : String(raw ?? ''))
  const text = textOf(spec.text)
  const fontSize = (spec.fontSize as number | undefined) ?? (cfg.fontSize as number | undefined) ?? (sty.fontSize as number | undefined) ?? 11
  return {
    text,
    // (lines or a signal, as the text: not one string of them, `"line1,line2"` / `"[object Object]"`)
    subtitle: spec.subtitle != null ? textOf(spec.subtitle) : undefined,
    orient: (spec.orient as CompiledTitle['orient']) ?? (cfg.orient as CompiledTitle['orient']) ?? 'top',
    anchor: (spec.anchor as CompiledTitle['anchor']) ?? (cfg.anchor as CompiledTitle['anchor']) ?? 'middle',
    offset: (spec.offset as number | undefined) ?? (cfg.offset as number | undefined) ?? 4,
    subtitlePadding: (spec.subtitlePadding as number | undefined) ?? (cfg.subtitlePadding as number | undefined) ?? 3,
    fontSize,
    fontWeight: (spec.fontWeight as CompiledTitle['fontWeight']) ?? (cfg.fontWeight as CompiledTitle['fontWeight']) ?? (sty.fontWeight as CompiledTitle['fontWeight']),
    font: (spec.font as string | undefined) ?? (cfg.font as string | undefined) ?? (sty.font as string | undefined),
    fontStyle: (spec.fontStyle as string | undefined) ?? (cfg.fontStyle as string | undefined) ?? (sty.fontStyle as string | undefined),
    color: (spec.color as string | undefined) ?? (cfg.color as string | undefined) ?? (sty.fill as string | undefined) ?? '#000',
    baseline: (spec.baseline as string | undefined) ?? (cfg.baseline as string | undefined),
    align: (spec.align as string | undefined) ?? (cfg.align as string | undefined),
    angle: (spec.angle as number | undefined) ?? (cfg.angle as number | undefined),
    subtitleColor: (spec.subtitleColor as string | undefined) ?? (cfg.subtitleColor as string | undefined),
    subtitleFontSize: (spec.subtitleFontSize as number | undefined) ?? (cfg.subtitleFontSize as number | undefined),
    subtitleFontWeight: (spec.subtitleFontWeight as string | number | undefined) ?? (cfg.subtitleFontWeight as string | number | undefined),
    dx: (spec.dx as number | undefined) ?? (cfg.dx as number | undefined),
    dy: (spec.dy as number | undefined) ?? (cfg.dy as number | undefined),
    limit: (spec.limit as number | undefined) ?? (cfg.limit as number | undefined),
    lineBreak: (spec.lineBreak as string | undefined) ?? (cfg.lineBreak as string | undefined),
    frame: (spec.frame as string | undefined) ?? (cfg.frame as string | undefined),
    ...((spec.aria ?? cfg.aria) === false ? { aria: false } : {}),
    encode: spec.encode as CompiledTitle['encode'],
    own: spec,
    cfg,
  }
}

/** Fill properties from a config block (e.g. config.axis) for keys the spec omits. */
function applyConfigDefaults(o: Record<string, unknown>, defaults: Record<string, unknown>, isLegend = false): Record<string, unknown> {
  if (!defaults || typeof defaults !== 'object') return o
  const out: Record<string, unknown> = { ...defaults, ...o }
  // (a property the spec leaves null is as good as one it omits: the config's value stands in -- vega-parser's `lookup`)
  for (const k in o) if (o[k] === null && defaults[k] != null) out[k] = defaults[k]
  // `position` is read as `spec.position` in vega's buildAxisEncode — never
  // through the `lookup(spec, config)` — so a config block's copy is dead
  // upstream.  Drop it too, or a config theme would reshift every axis.
  if ('position' in defaults && !('position' in o)) delete out.position
  // `tickCount`, `values`, `tickMinStep`, `format` and `formatType` are read as
  // `spec.tickCount` (and friends) in vega's guide operators — never through
  // the `lookup(spec, config)` every other property goes through — so a config
  // block's copy is dead upstream.  Drop it too, or a config theme would both
  // retick every axis and refuse interval strings the oracle never sees.
  if (!isLegend) {
    for (const k of ['tickCount', 'values', 'tickMinStep', 'format', 'formatType', 'title']) {
      if (k in defaults && !(k in o)) delete out[k]
    }
  }
  // Some vega guide properties are read from the guide's OWN spec rather than
  // through the config lookup (axis-grid reads `spec.offset` while the axis layout
  // reads the config-merged one; gradient legend labels read `spec.labelOffset`
  // with `config.gradientLabelOffset` as their fallback, not `config.labelOffset`).
  // Keep the guide's own properties apart from the config-merged ones.
  out.own = o
  out.cfg = defaults
  return out
}

/**
 * The role vega's parser gives a mark, as far as the config goes: a group mark is a `scope` whatever it is called, a data
 * mark is a `mark` unless the spec names another role (a guide's role, `frame`, anything).
 */
function markRoleOf(m: Record<string, unknown>): string {
  return m.type === 'group' ? 'scope' : (typeof m.role === 'string' && m.role) || 'mark'
}

/** What a mark's encode sets are once its defaults are in them: the channels of vega's `enter` and `update` sets. */
interface EncodeSets { enter: Set<string>; update: Set<string> }

/** vega-parser encode/util.js `has`: the mark's own `enter` or `update` set gives the channel a (truthy) entry. */
const hasOwnChannel = (enc: Record<string, Record<string, unknown> | undefined>, key: string): boolean =>
  !!(enc.enter && Object.hasOwn(enc.enter, key) && enc.enter[key]) || !!(enc.update && Object.hasOwn(enc.update, key) && enc.update[key])

/**
 * A mark's defaults, as vega-parser's encode/defaults.js gives them: a mark whose role is `mark` takes the channels of
 * `config.mark` then `config[type]` (a mark the spec calls the `frame` takes `config.group`; a group, a guide's role or a role of its
 * own takes none), each skipped where the mark encodes the channel and a solid paint skipped where it encodes either paint; then the
 * channels of each style the mark NAMES (`style`, a name or a list; never its type), in order, each skipped where the mark encodes
 * it. A later source overrides an earlier one. A default is a value that lands in the `enter` set, or a `{signal}` that lands in
 * `update`; the mark's own channels win over them in each set.
 *
 * The mark's `update` becomes the merged set the runtime evaluates (enter under update); the channels of each set are returned, for
 * the spatial adjustment vega makes per set (spatial.ts).
 */
function applyStyleDefaults(m: Record<string, unknown>, cfgStyle: Record<string, Record<string, unknown>>, cfgMarktype?: Record<string, Record<string, unknown>>): EncodeSets {
  const enc = (m.encode ?? {}) as Record<string, Record<string, EncodeValue | EncodeValue[]>>
  const has = (key: string): boolean => hasOwnChannel(enc, key)
  const defaults: Record<string, EncodeValue> = {}
  const apply = (key: string, value: unknown): void => {
    defaults[key] = (value && typeof value === 'object' && (value as { signal?: unknown }).signal ? { signal: (value as { signal: string }).signal } : { value }) as EncodeValue
  }
  // (a default is a channel of the mark's items like any other: it may not name the engine's own slots, item-slots.ts)
  const refuseEngineSlot = (key: string): void => {
    if (isEngineSlot(key)) throw new SpecParseError(engineSlotMessage(key, 'a config style or mark default'))
  }
  const role = markRoleOf(m)
  const props: Record<string, unknown> = {}
  if (cfgMarktype && role === 'mark') {
    const gm = ownGet(cfgMarktype, 'mark')
    if (gm && typeof gm === 'object') Object.assign(props, gm)
    const st = ownGet(cfgMarktype, String(m.type))
    if (st && typeof st === 'object') Object.assign(props, st)
  } else if (cfgMarktype && role === 'frame') {
    const st = ownGet(cfgMarktype, 'group')
    if (st && typeof st === 'object') Object.assign(props, st)
  }
  for (const key of Object.keys(props)) {
    if (SKIPPED_DEFAULTS.has(key)) continue
    refuseEngineSlot(key)
    const skip = has(key) || ((key === 'fill' || key === 'stroke') && (has('fill') || has('stroke')))
    if (!skip) apply(key, props[key])
  }
  // (vega-util `array(style)`: a name is a list of one)
  const style = m.style
  for (const name of style == null ? [] : Array.isArray(style) ? style : [style]) {
    const block = ownGet(cfgStyle, String(name))
    if (!block || typeof block !== 'object') continue
    for (const key of Object.keys(block)) {
      if (SKIPPED_DEFAULTS.has(key)) continue
      refuseEngineSlot(key)
      if (!has(key)) apply(key, block[key])
    }
  }
  const enterDefaults: Record<string, EncodeValue> = {}
  const updateDefaults: Record<string, EncodeValue> = {}
  for (const [key, v] of Object.entries(defaults)) ((v as { signal?: unknown }).signal ? updateDefaults : enterDefaults)[key] = v
  const enter = { ...enterDefaults, ...(enc.enter ?? {}) }
  const update = { ...updateDefaults, ...(enc.update ?? {}) }
  // (vega skips a null channel: it is in neither set)
  const keysOf = (set: Record<string, unknown>): Set<string> => new Set(Object.keys(set).filter((k) => set[k] != null))
  m.encode = { ...enc, enter, update: { ...enter, ...update } }
  return { enter: keysOf(enter), update: keysOf(update) }
}

/**
 * Config keys that are properties of the mark, not channels of its items: Aster reads them from the mark itself (`interactive`,
 * `zindex`, `name`, `style`), so a config block's copy is no channel.
 */
const SKIPPED_DEFAULTS = new Set(['name', 'interactive', 'zindex', 'style'])

/**
 * vega reads `from.facet.groupby` through `array(...)`: a bare field name is a one-field
 * groupby (`groupby: 'g'`), as in every transform's groupby. The runtime iterates arrays, so
 * normalise once here (the spec itself is never written).
 */
function normalizeFrom(from: CompiledMark['from']): CompiledMark['from'] {
  const facet = (from as { facet?: { groupby?: unknown } } | undefined)?.facet
  if (facet === undefined || facet === null || typeof facet !== 'object' || Array.isArray(facet.groupby)) return from
  const groupby = facet.groupby == null ? [] : [facet.groupby]
  return { ...from, facet: { ...facet, groupby } } as CompiledMark['from']
}

/**
 * A mark's type: one of the mark types vega draws, written as its name. Anything else (an unknown name, a Vega-Lite mark such as
 * `circle`, `bar` or `geoshape`, another spelling, none) is refused, with the error vega's renderer fails with: never an empty or a
 * guessed mark. A list holding one name (`['rect']`), which vega looks up by name and draws with quirks of its own (no scope for
 * `['group']`, another ARIA role for `['text']`), is refused too: a documented deviation (docs/ARCHITECTURE.md).
 */
function markTypeOf(type: unknown): string {
  if (typeof type !== 'string' || !VEGA_MARK_TYPES.has(type)) throw new SpecParseError("Cannot read properties of undefined (reading 'tag')")
  return type
}

// (reset per chart: the same spec compiles to the same numbers, so scenes of equal charts are equal)
let markSeq = 0

function compileMark(m0: Record<string, unknown>, cfgStyle?: Record<string, Record<string, unknown>>, cfgMarktype?: Record<string, Record<string, unknown>>, scopeScales: CompiledScale[] = []): CompiledMark {
  const m: Record<string, unknown> = { ...m0, type: markTypeOf(m0.type) }
  const sets = applyStyleDefaults(m, cfgStyle ?? {}, cfgMarktype)
  const out: CompiledMark = {
    type: m.type as string,
    name: (m.name as string) ?? 'marks',
    seq: markSeq++,
  }
  // Vega evaluates `enter` when an item is created and `update` on every
  // pulse; in static rendering every item is created, so the effective set is
  // `enter` overridden per-channel by `update`.
  if (m.encode !== undefined) {
    const enc = m.encode as Record<string, Record<string, EncodeValue | EncodeValue[]>>
    const merged: Record<string, EncodeValue | EncodeValue[]> = { ...(enc.update ?? {}) }
    // vega adjusts the spatial channels per set: where the sets split a dimension's edges, the merged set carries the enter set's
    // own value of each channel the update set overrides, and the program that runs the two adjustments in order (spatial.ts)
    const program = spatialProgramOf(String(m.type), sets.enter, sets.update)
    if (program) {
      for (const dim of [program.x, program.y]) {
        for (const k of dim?.enter ?? []) if (dim!.update.includes(k)) merged[ENTER_COPY + k] = enc.enter![k]!
      }
      setSpatialProgram(merged, program)
    }
    out.encode = { ...enc, update: merged }
    // (a mark a signal handler can re-encode with a set of its own keeps the channels its spec's `update` writes: the channels a
    // run of `update` takes back from such a set, encode-handlers.ts)
    if (namedSetsOf(out).length) {
      const own = (m0.encode as { update?: unknown } | null | undefined)?.update
      out.updateChannels = own !== null && typeof own === 'object' ? Object.keys(own) : []
    }
  }
  if (m.role !== undefined) out.role = m.role as string
  // what the SVG container says about the mark (vega-scenegraph cssClass / ariaMarkAttributes): the name the SPEC gave it
  // (`name` above defaults to 'marks'; vega adds no class then), its description, `aria: false`
  if (m.name != null) out.userName = String(m.name)
  if (typeof m.description === 'string') out.description = m.description
  if (m.aria === false) out.aria = false
  if (m.style !== undefined) out.style = m.style as string | string[]
  if (m.from !== undefined) out.from = normalizeFrom(m.from as CompiledMark['from'])
  if (m.clip !== undefined) out.clip = m.clip as boolean
  if (m.interactive !== undefined) out.interactive = m.interactive as boolean
  if (m.zindex !== undefined) out.zindex = m.zindex as number
  if (m.key !== undefined) out.key = m.key as string
  if (m.sort !== undefined) out.sort = m.sort as CompiledMark['sort']
  if (m.title !== undefined) out.title = m.title as CompiledMark['title']
  // a group's title is a title like the view's, resolved against the same config (its text may read `parent`)
  if (m.type === 'group' && m.title !== undefined && m.title !== null) out.groupTitle = compileTitle(m.title, cfgMarktype as unknown as Record<string, unknown> | undefined)
  if (m.layout !== undefined) out.layout = m.layout as Record<string, unknown>
  // a group's own scales are visible to its axes and its children, after the enclosing scope's
  if ((m as any).scales !== undefined) out.scales = ((m as any).scales as Array<Record<string, unknown>>).map(compileScale)
  const inScope = out.scales ? [...scopeScales, ...out.scales] : scopeScales
  if (m.marks !== undefined) out.marks = (m.marks as Array<Record<string, unknown>>).map((nm) => compileMark(nm, cfgStyle, cfgMarktype, inScope))
  // a nested group's axes and legends are compiled like the view's: same config lookups
  const cfgAll = (cfgMarktype ?? {}) as unknown as Record<string, unknown>
  if ((m as any).axes !== undefined) out.axes = compileGuideAxes((m as any).axes as Array<Record<string, unknown>>, cfgAll, inScope)
  if ((m as any).legends !== undefined) out.legends = compileGuideLegends((m as any).legends as Array<Record<string, unknown>>, cfgAll)
  if ((m as any).data !== undefined) out.data = ((m as any).data as Array<Record<string, unknown>>).map(compileData)
  // a group's own projections (vega: built per group item, in its scope: `type: {signal: "parent.data"}`)
  if (m.type === 'group' && Array.isArray(m.projections) && m.projections.length) {
    out.projections = (m.projections as Array<Record<string, unknown>>).map((pr) => compileProjection(pr, (cfgMarktype as unknown as { projection?: Record<string, unknown> } | undefined)?.projection))
  }
  // a group's own signals (vega: one set per group item, see runtime buildGroupItem)
  if (m.type === 'group' && Array.isArray(m.signals) && m.signals.length) out.signalDefs = compileSignalDefs(m.signals as Array<Record<string, unknown>>)
  if (Array.isArray(m.transform)) {
    out.transform = (m.transform as Array<Record<string, unknown>>).map(compileTransform)
  }
  return out
}
