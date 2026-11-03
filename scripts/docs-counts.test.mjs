/**
 * The counts the docs quote are checked against the source, so they cannot go stale.
 *
 * The corpus size is the number of files in packages/conformance/corpus; every "N/N" the docs print for a run over the corpus has
 * that number as its denominator; the signals sweep numbers are the arguments of the `sweep-signals` gate in scripts/gates.mjs.
 * (The numbers that only a run can produce -- how many of the 1055 pass in Chromium -- are results, dated, in docs/TESTING.md;
 * what must never disagree is what they are out of.)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { GATES } from './gates.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const corpus = readdirSync(join(root, 'packages', 'conformance', 'corpus'))
const total = corpus.length
const vega = corpus.filter((f) => f.endsWith('.vg.json')).length
const lite = corpus.filter((f) => f.endsWith('.vl.json')).length

const flag = (args, name) => {
  const i = args.indexOf(name)
  expect(i, `sweep-signals has no ${name}`).toBeGreaterThan(-1)
  return Number(args[i + 1])
}
const sweep = GATES.find((g) => g.name === 'sweep-signals').args
const signals = { floor: flag(sweep, '--floor'), ok: flag(sweep, '--min-ok'), retained: flag(sweep, '--max-retained'), nodeError: flag(sweep, '--max-node-error') }

const README = read('README.md')
const TESTING = read('docs/TESTING.md')
const INTERACTION = read('docs/INTERACTION.md')

/** The row of the TESTING.md table whose command cell contains `command`. */
const cells = (line) => line.split(/(?<!\\)\|/)
const row = (command) => {
  const line = TESTING.split('\n').find((l) => l.startsWith('|') && cells(l)[2]?.includes(command))
  expect(line, `docs/TESTING.md has no table row for ${command}`).toBeDefined()
  return line
}
const result = (command) => cells(row(command))[3]
const numbers = (s) => [...s.matchAll(/\d+/g)].map((m) => Number(m[0]))

describe('the corpus', () => {
  it('has both kinds, and the sizes the tests below compare the docs to', () => {
    expect(vega).toBeGreaterThan(0)
    expect(lite).toBeGreaterThan(0)
    expect(vega + lite).toBe(total)
  })
})

describe('README.md quotes the corpus and the signals sweep as they are', () => {
  it('the corpus size and its split', () => {
    expect(README).toContain(`${total} specs: ${vega} Vega, ${lite} Vega-Lite`)
  })

  it('pnpm conformance runs the whole corpus; pnpm conformance-vl the Vega-Lite specs', () => {
    expect(README).toContain(`\`pnpm conformance\` (${total}/${total})`)
    expect(README).toContain(`the same ${lite} Vega-Lite specs`)
    expect(README).toContain(`\`pnpm conformance-vl\` (${lite}/${lite})`)
  })

  it('the Chromium corpus run is out of the corpus size', () => {
    expect(README).toMatch(new RegExp(`the corpus matches Vega's string renderer \\(\\d+/${total}\\)`))
  })

  it('the signals sweep', () => {
    expect(README).toContain(`signals ${signals.ok} ok of ${signals.floor} (${signals.retained} \`retained\``)
  })
})

describe('docs/TESTING.md reference results', () => {
  it('the corpus-size row', () => {
    expect(numbers(result('ls packages/conformance/corpus'))).toEqual([total, vega, lite])
  })

  it.each([['pnpm conformance`'], ['pnpm scene-diff'], ['pnpm a11y-parity']])('%s is out of the whole corpus', (command) => {
    expect(result(command)).toMatch(new RegExp(`\\b${total}/${total}\\b`))
  })

  it('pnpm conformance-vl is out of the Vega-Lite specs', () => {
    expect(result('pnpm conformance-vl')).toContain(`${lite} passed, 0 failed, 0 errored / ${lite}`)
  })

  it('the Chromium corpus run is out of the corpus size', () => {
    expect(result('pnpm conformance:browser')).toMatch(new RegExp(`\\b\\d+/${total} passed`))
  })

  it('the signals sweep row quotes the arguments of the gate', () => {
    const r = row('pnpm sweep-signals')
    expect(r).toContain(`--floor ${signals.floor} --min-ok ${signals.ok} --max-node-error ${signals.nodeError} --max-retained ${signals.retained}`)
    expect(cells(r)[3]).toContain(`${signals.ok} ok, ${signals.retained} retained`)
    expect(cells(r)[3]).toMatch(new RegExp(`/ ${signals.floor}\\s*$`))
  })

  it('names no other corpus size in prose', () => {
    for (const m of TESTING.matchAll(/\b(\d{3,4}) (?:corpus )?specs\b/g)) {
      expect([total, lite, vega].includes(Number(m[1])), `docs/TESTING.md says "${m[0]}"`).toBe(true)
    }
  })
})

describe('the browser results README.md quotes are the ones docs/TESTING.md reports', () => {
  it('the canvas comparisons and the signal event streams', () => {
    const canvas = /chromium (\d+)\/(\d+) passed/.exec(result('pnpm conformance:canvas'))
    expect(canvas, 'TESTING.md canvas row').not.toBeNull()
    expect(canvas[1]).toBe(canvas[2])
    expect(README).toContain(`(${canvas[1]}/${canvas[2]} pixel comparisons)`)
    const events = /(\d+)\/(\d+) cases agree/.exec(result('pnpm conformance:signals'))
    expect(events, 'TESTING.md signal event streams row').not.toBeNull()
    expect(README).toContain(`(${events[1]}/${events[2]} cases)`)
    // the gate's own floor on the number of cases (packages/conformance/package.json) is what the docs may not fall under
    const floor = Number(/--min-cases=(\d+)/.exec(JSON.parse(read('packages/conformance/package.json')).scripts['conformance:signals'])?.[1])
    expect(Number(events[2])).toBeGreaterThanOrEqual(floor)
  })
})

describe('docs/INTERACTION.md quotes the signals sweep as it is', () => {
  it('the case count and the outcome split', () => {
    expect(INTERACTION).toContain(`(\`pnpm sweep-signals\`, ${signals.floor} cases)`)
    expect(INTERACTION).toContain(`${signals.ok} ok, ${signals.retained} retained`)
  })
})

describe('no other doc keeps its own corpus size', () => {
  it('ARCHITECTURE.md and TESTING.md name no corpus count in prose', () => {
    for (const doc of ['docs/ARCHITECTURE.md', 'docs/TESTING.md']) {
      for (const m of read(doc).matchAll(/\b(?:all |the )?(\d{3,4}) corpus specs\b/g)) {
        expect([total, lite, vega].includes(Number(m[1])), `${doc} says "${m[0]}"`).toBe(true)
      }
    }
  })
})
