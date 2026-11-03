#!/usr/bin/env node
/**
 * The last step of the nightly workflow: one table of what ran, and a failing exit status when any check did not pass.
 *
 * Every check step of `.github/workflows/nightly.yml` carries an `id` and runs even when an earlier one failed
 * (`if: !cancelled() && ...`), so one failure never hides the others. A step that failed has already failed the job; this
 * step makes the whole list visible in one place and ALSO fails on a step that was skipped, because a check that did not
 * run is not a check that passed (its prerequisite -- the install, the build, the gallery fetch -- failed).
 *
 * Input: the `steps` context of the job, as JSON, in the STEPS environment variable (`${{ toJSON(steps) }}`).
 * Output: a table on stdout, and in $GITHUB_STEP_SUMMARY when that is set.
 */
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @param {Record<string, { outcome?: string }>} steps @returns {{ rows: string[][], bad: string[] }} */
export function summarize(steps) {
  const rows = []
  const bad = []
  for (const [id, step] of Object.entries(steps)) {
    const outcome = step?.outcome ?? 'unknown'
    rows.push([id, outcome])
    if (outcome !== 'success') bad.push(`${id} (${outcome})`)
  }
  return { rows, bad }
}

function main() {
  const raw = process.env.STEPS
  if (!raw) {
    console.error('[nightly-summary] STEPS is not set (expected ${{ toJSON(steps) }})')
    process.exit(2)
  }
  const { rows, bad } = summarize(JSON.parse(raw))
  if (rows.length === 0) {
    console.error('[nightly-summary] the steps context is empty: nothing was checked')
    process.exit(2)
  }
  const width = Math.max(...rows.map((r) => r[0].length))
  const lines = rows.map(([id, outcome]) => `${outcome === 'success' ? 'PASS' : 'FAIL'}  ${id.padEnd(width)}  ${outcome}`)
  console.log(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['## Nightly', '', '| check | outcome |', '|---|---|', ...rows.map(([id, outcome]) => `| ${id} | ${outcome} |`), '']
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'))
  }
  if (bad.length) {
    console.error(`[nightly-summary] ${bad.length} of ${rows.length} checks did not pass: ${bad.join(', ')}`)
    process.exit(1)
  }
  console.log(`[nightly-summary] all ${rows.length} checks passed`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
