/**
 * Vega-Lite 6 animation: the `time` channel and the timer selection that drives it.
 *
 * vega-lite 6.4.3 compiles an animation from three pieces, all ported here (compile/selection/point.ts
 * `animationSignals` and `topLevelSignals`, compile/selection/assemble.ts `assembleUnitSelectionData`,
 * compile/scale/range.ts for the TIME channel, compile/unit.ts `correctDataNames`):
 *
 *  - a `point` selection param whose `on` is a timer: `{"name": "anim", "select": {"type": "point", "on": "timer",
 *    "fields": ["year"]}}` (or `"encodings": ["time"]`). It compiles to a store dataset (`anim_store`) and a chain
 *    of signals: a clock that a `timer` event stream advances while `is_playing`, the `time` scale's value at that
 *    clock (`invert('time', clock)`), and a tuple of it that `modify("anim_store", tuple, true)` writes to the store;
 *  - a `filter: {param: "anim"}` transform: the selection's predicate (`!length(data(store)) || vlSelectionTest(...)`),
 *    which vega-lite moves out of the main dataset into `<main>_curr`, the dataset the marks read, so scales keep
 *    the whole data's domains while only the current frame is drawn;
 *  - the `time` encoding channel: a band scale (`range: {step: 1000 / config.scale.framesPerSecond}`) over the
 *    field, no axis, no legend. (Its `animationDuration` is unused by vega-lite 6.4.3, a linear time scale being
 *    unimplemented upstream.)
 *
 * What vega-lite 6.4.3 does NOT do is validate: a `time` channel without the timer selection and its filter compiles
 * to marks that read a dataset it never defines. Those specs are refused here, with the reason.
 *
 * The first frame (before the first tick) is all of the data: the store is empty, so the predicate lets every row
 * through; the clock then starts and the tuples arrive.
 */
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** vega-lite's THROTTLE: the timer stream runs at 60 frames per second. */
const THROTTLE = (1 / 60) * 1000

export interface TimerSelection {
  name: string
  /** the projected fields: what the tuple holds a value of, and the store entries are matched on */
  fields: Array<{ type: 'E'; field: string; channel?: string }>
}

export const storeName = (name: string): string => `${name}_store`

/** Names the animation reserves (every one is a signal): a parameter or a selection may not take them. */
export function animationSignalNames(name: string): string[] {
  return [
    'unit', name, 'anim_clock', 'last_tick_at', 'is_playing', 'eased_anim_clock', `${name}_domain`, 'min_extent',
    'max_range_extent', 'anim_value', `${name}_tuple`, `${name}_tuple_fields`, `${name}_modify`,
  ]
}

/** Is this a `select` whose `on` is a timer: `"timer"`, `"timer{<ms>}"` or `{"type": "timer"}` (vega-lite `isTimerSelection`)? */
export function isTimerSelect(select: unknown): boolean {
  if (!isObj(select) || select.type !== 'point') return false
  const on = select.on
  if (typeof on === 'string') return /^\s*timer\s*(\{\s*\d+(\.\d+)?\s*\})?\s*$/.test(on)
  if (isObj(on)) return on.type === 'timer'
  return false
}

/** A timer selection param, checked: throws a VLCompileError naming what is not supported. */
export function validateTimerSelection(param: Obj, at: string, fail: (path: string, msg: string) => never): void {
  const select = param.select as Obj
  for (const k of Object.keys(select)) {
    if (!['type', 'on', 'fields', 'encodings'].includes(k)) fail(`${at}.select.${k}`, 'a timer selection takes only `type`, `on` and one of `fields` / `encodings` (the animation options vega-lite 6.4.3 has are these)')
  }
  if (isObj(select.on)) {
    for (const k of Object.keys(select.on)) if (k !== 'type' && k !== 'throttle') fail(`${at}.select.on.${k}`, 'a timer event stream is {"type": "timer"} (vega-lite replaces its throttle with its own 60 fps clock)')
  }
  const hasFields = select.fields !== undefined
  const hasEnc = select.encodings !== undefined
  if (hasFields === hasEnc) {
    fail(`${at}.select`, 'a timer selection needs exactly one of `fields` or `encodings` (without either, vega-lite 6.4.3 selects by row id and emits marks that read a dataset it never defines)')
  }
  if (hasFields) {
    const f = select.fields
    if (!Array.isArray(f) || f.length === 0 || !f.every((x) => typeof x === 'string' && x !== '')) fail(`${at}.select.fields`, 'must be a non-empty array of field names')
  } else {
    const e = select.encodings
    if (!Array.isArray(e) || e.length !== 1 || e[0] !== 'time') fail(`${at}.select.encodings`, 'a timer selection can project the `time` encoding only: ["time"]')
  }
  if (param.value !== undefined) fail(`${at}.value`, 'an initial value does not apply to a timer selection')
  if (param.bind !== undefined) fail(`${at}.bind`, 'a bound timer selection is not supported')
}

/** The timer selections declared at the top of a spec (validated: see `validateTimerSelection`). */
export function timerSelections(root: Obj, timeField?: string): TimerSelection[] {
  const out: TimerSelection[] = []
  for (const p of Array.isArray(root.params) ? (root.params as Obj[]) : []) {
    if (!isObj(p) || !isTimerSelect(p.select)) continue
    const select = p.select as Obj
    const fields = Array.isArray(select.fields)
      ? (select.fields as string[]).map((field) => ({ type: 'E' as const, field }))
      : timeField !== undefined ? [{ field: timeField, channel: 'time', type: 'E' as const }] : []
    out.push({ name: p.name as string, fields })
  }
  return out
}

/** vega-lite `parseSelectionPredicate` for a point selection with the default resolve: the filter's expression. */
export function selectionPredicate(sel: TimerSelection, empty: boolean | undefined): string {
  const store = JSON.stringify(storeName(sel.name))
  const test = `vlSelectionTest(${store}, datum)`
  const length = `length(data(${store}))`
  return empty === false ? `${length} && ${test}` : `!${length} || ${test}`
}

/** The store dataset: the timer selection's tuples, written by `modify`. */
export function animationStore(sel: TimerSelection): Obj {
  return { name: storeName(sel.name) }
}

/** vega-lite `animationSignals` + `topLevelSignals` + the selection's tuple and modify signals, for the one unit. */
export function animationSignals(sel: TimerSelection, timeScale: string, unitName: string): Obj[] {
  const name = sel.name
  const tuple = `${name}_tuple`
  const store = JSON.stringify(storeName(name))
  return [
    { name: 'unit', value: {}, on: [{ events: 'pointermove', update: 'isTuple(group()) ? group() : unit' }] },
    { name, update: `vlSelectionResolve(${store}, "union", true, true)` },
    {
      name: 'anim_clock',
      init: '0',
      on: [{
        events: { type: 'timer', throttle: THROTTLE },
        update: 'is_playing ? (anim_clock + (now() - last_tick_at) > max_range_extent ? 0 : anim_clock + (now() - last_tick_at)) : anim_clock',
      }],
    },
    { name: 'last_tick_at', init: 'now()', on: [{ events: [{ signal: 'anim_clock' }, { signal: 'is_playing' }], update: 'now()' }] },
    { name: 'is_playing', init: 'true' },
    { name: 'eased_anim_clock', update: 'anim_clock' },
    { name: `${name}_domain`, init: `domain('${timeScale}')` },
    { name: 'min_extent', init: `extent(${name}_domain)[0]` },
    { name: 'max_range_extent', init: `extent(range('${timeScale}'))[1]` },
    { name: 'anim_value', update: `invert('${timeScale}', eased_anim_clock)` },
    {
      name: tuple,
      on: [{
        events: [{ signal: 'eased_anim_clock' }, { signal: 'anim_value' }],
        update: `{unit: ${JSON.stringify(unitName)}, fields: ${tuple}_fields, values: [anim_value ? anim_value : min_extent]}`,
        force: true,
      }],
    },
    { name: `${tuple}_fields`, value: sel.fields.map((f) => ({ ...f })) },
    { name: `${name}_modify`, on: [{ events: { signal: tuple }, update: `modify(${store}, ${tuple}, true)` }] },
  ]
}

/** The `time` scale's range: one step per frame (vega-lite scale/range.ts, TIME). */
export function timeScaleRange(framesPerSecond: unknown): Obj {
  const fps = typeof framesPerSecond === 'number' ? framesPerSecond : 2
  return { step: 1000 / fps }
}
