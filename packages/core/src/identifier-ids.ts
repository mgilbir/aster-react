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

/**
 * The numbers rows had when the transform is run again with nothing to say what changed. The rows that are as they were at the
 * start of the list and at the end of it keep their numbers (the common case: nothing changed, or rows were added or taken away
 * at the ends); of the rest, those that are in the previous list too (the same row once for each time it was there), and then
 * those that are at the place of a row that is no longer there -- a row changed where it stood.
 */
export function carryByAlignment(rows: readonly Row[], previous: readonly Row[] | undefined, as: string): unknown[] | undefined {
  if (!previous || !previous.length || !rows.length) return undefined
  const carry = new Array<unknown>(rows.length)
  const taken = new Uint8Array(previous.length)
  const most = Math.min(rows.length, previous.length)
  let head = 0
  while (head < most && sameBut(rows[head]!, previous[head]!, as)) { carry[head] = previous[head]![as]; taken[head] = 1; head++ }
  let tail = 0
  while (tail < most - head && sameBut(rows[rows.length - 1 - tail]!, previous[previous.length - 1 - tail]!, as)) {
    carry[rows.length - 1 - tail] = previous[previous.length - 1 - tail]![as]
    taken[previous.length - 1 - tail] = 1
    tail++
  }
  const open = rows.length - tail
  if (head === open) return carry
  const waiting = new Map<string, number[]>()
  for (let j = head; j < previous.length - tail; j++) {
    const key = signature(previous[j]!, as)
    const queue = waiting.get(key)
    if (queue) queue.push(j)
    else waiting.set(key, [j])
  }
  const unmatched: number[] = []
  for (let i = head; i < open; i++) {
    const j = waiting.get(signature(rows[i]!, as))?.shift()
    if (j === undefined) { unmatched.push(i); continue }
    carry[i] = previous[j]![as]
    taken[j] = 1
  }
  for (const i of unmatched) if (i < previous.length && !taken[i]) { carry[i] = previous[i]![as]; taken[i] = 1 }
  return carry
}
