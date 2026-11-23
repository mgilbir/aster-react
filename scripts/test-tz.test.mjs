/** `pnpm test:tz <zone>`: a misspelt zone must fail, not run in UTC and report success (C497). */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ZONES, isKnownZone } from './test-tz.mjs'
import { spawnAsync } from './lib/spawn-async.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'test-tz.mjs')

describe('isKnownZone', () => {
  it('accepts IANA names, aliases and UTC', () => {
    for (const z of [...ZONES, 'UTC', 'Etc/UTC', 'Europe/London', 'Asia/Calcutta', 'America/Argentina/Buenos_Aires', 'GMT']) expect(isKnownZone(z), z).toBe(true)
  })
  it('refuses names Node would silently run as UTC', () => {
    for (const z of ['Asia/Kolkatta', 'asia/kolkatan', 'Mars/Olympus', '', ' ', 'UTC+3x', 'America/New York', '../etc/passwd', 'Asia/Kolkata;rm']) expect(isKnownZone(z), JSON.stringify(z)).toBe(false)
  })
  it('agrees with what Node does: a refused zone really is run as UTC, an accepted one is not', () => {
    const offset = (tz) => Number(execFileSync(process.execPath, ['-e', 'console.log(new Date(2024, 0, 1).getTimezoneOffset())'], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }))
    expect(offset('Asia/Kolkatta')).toBe(0)
    expect(isKnownZone('Asia/Kolkatta')).toBe(false)
    expect(offset('Asia/Kolkata')).toBe(-330)
    expect(isKnownZone('Asia/Kolkata')).toBe(true)
  })
})

describe('node scripts/test-tz.mjs', () => {
  it('exits 2 naming a misspelt zone, before running anything', async () => {
    const r = await spawnAsync(process.execPath, [script, 'Asia/Kolkatta'], { timeout: 30_000 })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/unknown time zone: "Asia\/Kolkatta"/)
    expect(r.stdout).not.toMatch(/vitest under TZ/)
  })
  it('names every unknown zone of several, even when one is fine', async () => {
    const r = await spawnAsync(process.execPath, [script, 'Asia/Kolkata', 'Nowhere/A', 'Nowhere/B'], { timeout: 30_000 })
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/"Nowhere\/A", "Nowhere\/B"/)
    expect(r.stdout).not.toMatch(/vitest under TZ/)
  })
  it('the default zones are all known', () => {
    for (const z of ZONES) expect(isKnownZone(z)).toBe(true)
  })
})
