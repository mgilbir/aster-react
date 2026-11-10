/**
 * The id counter of a view. Every `identifier` transform of a view numbers from the same counter, in the order the transforms
 * run, so ids continue across datasets; a row keeps the number it was given for as long as it lives, and a row that arrives
 * later is numbered from where the counter stands. A view is evaluated again and again from its inputs (a signal moved, rows
 * appended), so "the row it was given" has to be found in what the previous evaluation left: by the change a pulse describes,
 * or, when nothing says what changed, by the rows that are as they were at the two ends of the list.
 */
import { equalCell } from './pulse.js'

type Row = Record<string, unknown>

/** The counter, and the numbers the rows of the transform being run had (`carry[i]` for row `i`; none: all are new). */
export interface IdCounter {
  value: number
  carry?: readonly unknown[]
}

/** The numbers rows had, by the index each had in the output of the previous evaluation (`from[i]`; -1: a new row). */
export function carryByMapping(from: readonly number[], previous: readonly Row[] | undefined, as: string): unknown[] | undefined {
  if (!previous) return undefined
  const carry = new Array<unknown>(from.length)
  for (let i = 0; i < from.length; i++) {
    const old = from[i]!
    if (old >= 0) carry[i] = previous[old]?.[as]
  }
  return carry
}

/** Whether a row as the transform receives it is the row it numbered: the same but for the number. */
function sameBut(row: Row, numbered: Row, as: string): boolean {
  let n = 0
  for (const k in row) {
    if (k === as) continue
    n++
    if (!equalCell(row[k], numbered[k])) return false
  }
  let m = 0
  for (const k in numbered) if (k !== as) m++
  return n === m
}

/** A row as text, but for its number: rows with the same text are the same row, whatever the transform did to its number. */
function signature(row: Row, as: string): string {
  let text = ''
  for (const k in row) {
    if (k === as) continue
    const v = row[k]
    text += k + (v !== null && typeof v === 'object' ? ':o' + (JSON.stringify(v) ?? '') : ':' + typeof v + String(v)) + '\u0001'
  }
  return text
}

/** How far ahead of a row that does not match either list is searched for the place they meet again. */
const RESYNC = 64

/**
 * The numbers rows had when the transform is run again with nothing to say what changed. The rows that are as they were at the
 * start and at the end of the list keep their numbers (the common case: nothing changed, or rows were added or taken away at the
 * ends). Between, the two lists are walked together: rows that match go on in step, a row of one list that is nowhere near in the
 * other is an addition or a removal, and a row that is neither -- changed where it stood -- keeps the number of the row it replaces.
 * When short lists are too unlike for that (rows moved about), rows are found by what they hold: the same row once for each time it
 * was there.
 */
export function carryByAlignment(rows: readonly Row[], previous: readonly Row[] | undefined, as: string): unknown[] | undefined {
  if (!previous || !previous.length || !rows.length) return undefined
  return align(rows, previous, as, (j) => previous[j]![as])
}

/**
 * Which row of `previous` each row of `rows` is (its index; -1: a new row), by the same reading as {@link carryByAlignment}: the rows
 * that are as they were at the two ends, then the two lists walked together, or searched by what the rows hold. `ignore` is a field
 * that is not compared.
 */
export function alignIndices(rows: readonly Row[], previous: readonly Row[], ignore: string): number[] {
  const out = new Array<number>(rows.length).fill(-1)
  if (!previous.length || !rows.length) return out
  const found = align(rows, previous, ignore, (j) => j)
  for (let i = 0; i < rows.length; i++) if (typeof found[i] === 'number') out[i] = found[i] as number
  return out
}

function align(rows: readonly Row[], previous: readonly Row[], as: string, pick: (j: number) => unknown): unknown[] {
  const carry = new Array<unknown>(rows.length)
  const most = Math.min(rows.length, previous.length)
  let head = 0
  while (head < most && sameBut(rows[head]!, previous[head]!, as)) { carry[head] = pick(head); head++ }
  let tail = 0
  while (tail < most - head && sameBut(rows[rows.length - 1 - tail]!, previous[previous.length - 1 - tail]!, as)) {
    carry[rows.length - 1 - tail] = pick(previous.length - 1 - tail)
    tail++
  }
  const open = rows.length - tail
  const end = previous.length - tail
  if (head === open) return carry
  const walked = walk(rows, previous, as, head, open, end, pick)
  if (walked) { for (let i = head; i < open; i++) if (walked[i - head] !== undefined) carry[i] = walked[i - head]; return carry }
  return byContent(rows, previous, as, head, open, end, carry, pick)
}

/** Lists longer than this are not searched by content when they part (see `walk`): that costs more than the lists are worth. */
const SEARCHABLE = 4096

/**
 * The two lists walked together from `from`; `null` when they part too often for that to mean anything and the lists are short enough
 * to be searched by what the rows hold (a long list that parts that often is read as rows changed where they stood).
 */
function walk(rows: readonly Row[], previous: readonly Row[], as: string, from: number, open: number, end: number, pick: (j: number) => unknown): unknown[] | null {
  const carry = new Array<unknown>(open - from)
  let parted = 0
  const allowed = 16 + ((open - from) >> 3)
  let i = from
  let j = from
  let run = 0
  while (i < open && j < end) {
    if (sameBut(rows[i]!, previous[j]!, as)) { carry[i - from] = pick(j); i++; j++; run = 0; continue }
    let k = 1
    let found = false
    // (rows that keep differing are rows changed where they stood: looking for where the lists meet again is for the first few)
    for (; k <= RESYNC && !found && run < 4; k++) {
      if (j + k < end && sameBut(rows[i]!, previous[j + k]!, as)) { j += k; found = true } else if (i + k < open && sameBut(rows[i + k]!, previous[j]!, as)) { i += k; found = true }
    }
    if (found) { run = 0; continue }
    run++
    // neither list has the row soon: it is the row that stood here, changed
    if (++parted > allowed && open - from <= SEARCHABLE) return null
    carry[i - from] = pick(j)
    i++
    j++
  }
  return carry
}

function byContent(rows: readonly Row[], previous: readonly Row[], as: string, head: number, open: number, end: number, carry: unknown[], pick: (j: number) => unknown): unknown[] {
  const taken = new Uint8Array(previous.length)
  for (let j = 0; j < head; j++) taken[j] = 1
  for (let j = end; j < previous.length; j++) taken[j] = 1
  const waiting = new Map<string, number[]>()
  for (let j = head; j < end; j++) {
    const key = signature(previous[j]!, as)
    const queue = waiting.get(key)
    if (queue) queue.push(j)
    else waiting.set(key, [j])
  }
  const unmatched: number[] = []
  for (let i = head; i < open; i++) {
    const j = waiting.get(signature(rows[i]!, as))?.shift()
    if (j === undefined) { unmatched.push(i); continue }
    carry[i] = pick(j)
    taken[j] = 1
  }
  for (const i of unmatched) if (i < previous.length && !taken[i]) { carry[i] = pick(i); taken[i] = 1 }
  return carry
}
