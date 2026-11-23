/**
 * The one owner of a conformance gate's verdict (`runGate`).
 *
 * A gate is a script that compares Aster with an oracle case by case. Before this harness each gate script decided for itself
 * whether to set an exit code, whether zero cases is a pass, and which of its counters mattered; one set no exit code at all,
 * several passed on `--filter <typo>`, and several printed a counter they existed to raise without requiring it. Here the
 * script only REPORTS what it did, and the harness decides:
 *
 *   - the exit code: 0 the gate passed, 1 it failed (a difference, an error, a broken floor, a crash of the script itself);
 *   - the zero-case rule: a gate that compared nothing failed. On a full run every declared counter must reach its floor (a
 *     floor of 0 marks a counter that is only reported, never the first one); on a narrowed run (`--filter`, `--limit`) the
 *     first, primary counter must still be at least 1;
 *   - required counters: each counter counts what was actually COMPARED on a path the gate exists to test (not what it loaded),
 *     and its floor is today's number, which only ratchets up;
 *   - known gaps: a difference listed for this gate in the one expected-differences table (expected-differences.mjs) is not a
 *     failure, but the listed case must STILL differ: a case that now agrees fails the gate (remove the entry: the gap is
 *     closed), and on a full run an entry whose case was never compared fails it too (a stale entry hides nothing it names);
 *   - the build it judges: a gate that imports the built packages names them in `reads`, and runs only when their `dist` is
 *     newer than their sources (dist-fresh.mjs): run standalone after an edit without `pnpm build`, it fails instead of
 *     judging the previous engine;
 *   - the planted-difference self-test: `--plant-difference` (declare `GATE_FLAGS` in the script's `cli()` flags) asks the
 *     script to corrupt Aster's side of every case it compares, in a way that stands for a real defect; the gate must then
 *     report differences and exit 1 (scripts/gate-self-test.test.mjs runs every gate of scripts/gates.mjs that way, with a
 *     control run that passes and a run that matches no case).
 *
 * Output lines a reader (and the self-test) can rely on:
 *   `[<gate>] DIFFERS <case>: <detail>`      a comparison found a difference (a failure)
 *   `[<gate>] ERROR <case>: <detail>`        a case could not be compared, or the page/script reported an error (a failure)
 *   `[<gate>] EXPECTED <case>: <reason>`     a difference listed in the expected-differences table (not a failure)
 *   `[<gate>] FIXED-GAP <case>: ...`         a listed difference that no longer differs (a failure: remove the entry)
 *   `[<gate>] FLOOR <counter>: ...`          a counter under its floor (a failure)
 *   `[<gate>] PASS: ...` / `[<gate>] FAIL: ...` the verdict line, last
 */
import { staleDist } from './dist-fresh.mjs'
import { EXPECTED_DIFFERENCES } from './expected-differences.mjs'

/** The flags every gate script declares in its `cli()` call. */
export const GATE_FLAGS = Object.freeze({ 'plant-difference': 'bool' })

/**
 * A non-negative integer option value, or exit 2 (bad usage): `Number('abc')` is NaN and compares false against everything,
 * so a loop bounded by it never runs and a floor read from it never binds.
 * @param {string | undefined} value the raw text (undefined: the option is absent)
 * @param {string} flag the option name, for the message
 * @param {number} fallback the value when the option is absent
 * @param {{ min?: number }} [opts]
 */
export function intOption(value, flag, fallback, { min = 0 } = {}) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (value.trim() === '' || !Number.isInteger(n) || n < min) {
    console.error(`${flag} needs an integer >= ${min}, got ${JSON.stringify(value)}`)
    process.exit(2)
  }
  return n
}

/**
 * The verdict of a gate run, as data (pure: the unit test drives it directly).
 * @param {{
 *   name: string,
 *   counters: Record<string, { floor: number, what: string }>,
 *   counts: Record<string, number>,
 *   partial: boolean,
 *   outcomes: Map<string, { differs: string | null, error: string | null }>,
 *   errors: string[],
 *   expected: ReadonlyArray<{ gate: string, case: string, reason: string }>,
 * }} run
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function gateVerdict({ name, counters, counts, partial, outcomes, errors, expected }) {
  const lines = []
  let failures = 0
  const mine = new Map(expected.filter((e) => e.gate === name).map((e) => [e.case, e]))
  for (const [kase, o] of outcomes) {
    const known = mine.get(kase)
    const bad = o.error ?? o.differs
    if (known) {
      if (bad === null) {
        failures++
        lines.push(`[${name}] FIXED-GAP ${kase}: listed in expected-differences.mjs (${known.reason}) but it now agrees with the oracle; remove the entry`)
      } else lines.push(`[${name}] EXPECTED ${kase}: ${known.reason}`)
    } else if (bad !== null) {
      failures++
      lines.push(`[${name}] ${o.error !== null ? 'ERROR' : 'DIFFERS'} ${kase}: ${bad}`)
    }
  }
  for (const e of errors) {
    failures++
    lines.push(`[${name}] ERROR ${e}`)
  }
  if (!partial) {
    for (const [kase, e] of mine) {
      if (outcomes.has(kase)) continue
      failures++
      lines.push(`[${name}] STALE-GAP ${kase}: listed in expected-differences.mjs (${e.reason}) but never compared on a full run`)
    }
  }
  const names = Object.keys(counters)
  if (names.length === 0) {
    failures++
    lines.push(`[${name}] FLOOR: the gate declares no counter, so it cannot show that it compared anything`)
  }
  if (!partial && names.length > 0 && !(counters[names[0]].floor >= 1)) {
    failures++
    lines.push(`[${name}] FLOOR: the primary counter ${names[0]} has no floor (it must be at least 1)`)
  }
  names.forEach((c, i) => {
    const n = counts[c] ?? 0
    const floor = partial ? (i === 0 ? 1 : 0) : counters[c].floor
    if (n < floor) {
      failures++
      lines.push(`[${name}] FLOOR ${c}: ${n} ${counters[c].what} < ${floor}${partial ? ' (a narrowed run that compared nothing)' : ''}`)
    }
  })
  const summary = names.map((c) => `${c} ${counts[c] ?? 0}${partial || counters[c].floor === 0 ? '' : `/${counters[c].floor}`}`).join(', ')
  const ok = failures === 0
  lines.push(`[${name}] ${ok ? 'PASS' : 'FAIL'}: ${summary}${partial ? ' (narrowed run: floors not applied)' : ''}${ok ? '' : `; ${failures} failure(s)`}`)
  return { ok, lines }
}

/**
 * Run a gate and exit with its verdict. Never returns.
 * @param {{
 *   name: string,
 *   counters: Record<string, { floor: number, what: string }>,
 *   partial?: boolean,
 *   reads?: string[],
 *   argv?: string[],
 *   run: (gate: import('./run-gate.d.mts').Gate) => Promise<void> | void,
 * }} spec
 */
export async function runGate({ name, counters, partial = false, reads = ['core', 'vl'], argv = process.argv.slice(2), run }) {
  const stale = staleDist(reads)
  if (stale !== null) {
    console.error(`[${name}] ERROR ${stale}`)
    console.log(`[${name}] FAIL: the build it would judge is stale`)
    process.exit(1)
  }
  const counts = Object.fromEntries(Object.keys(counters).map((c) => [c, 0]))
  const outcomes = new Map()
  const errors = []
  const primary = Object.keys(counters)[0]
  const record = (kase, outcome, counter) => {
    if (outcomes.has(kase)) {
      errors.push(`${kase}: reported twice (case names must be unique within a gate)`)
      return
    }
    outcomes.set(kase, outcome)
    if (counter !== null) gate.count(counter ?? primary)
  }
  const gate = {
    plant: argv.includes('--plant-difference'),
    partial,
    count(counter, n = 1) {
      if (!(counter in counts)) throw new Error(`[${name}] count('${counter}'): not a declared counter (${Object.keys(counts).join(', ')})`)
      counts[counter] += n
    },
    agree(kase, counter) { record(kase, { differs: null, error: null }, counter) },
    differ(kase, detail, counter) { record(kase, { differs: String(detail || 'differs'), error: null }, counter) },
    // an error is a case that was NOT compared: it counts toward no counter
    error(kase, detail) { record(kase, { differs: null, error: String(detail || 'error') }, null) },
    problem(detail) { errors.push(String(detail)) },
  }
  if (gate.plant) console.log(`[${name}] --plant-difference: Aster's side of every compared case is corrupted; this run must FAIL`)
  let code
  try {
    await run(gate)
    const verdict = gateVerdict({ name, counters, counts, partial, outcomes, errors, expected: EXPECTED_DIFFERENCES })
    for (const l of verdict.lines) console.log(l)
    code = verdict.ok ? 0 : 1
  } catch (err) {
    console.error(`[${name}] ERROR the gate script itself failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    console.log(`[${name}] FAIL: the gate crashed`)
    code = 1
  }
  process.exit(code)
}
