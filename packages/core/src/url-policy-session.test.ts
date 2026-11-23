/**
 * The URL policy through a session (C2, C478). A session evaluates update after update, keeping what did not change: an append
 * advances the mark's items array in place, and a channel is evaluated again only when what it reads changed. Whatever the
 * sequence -- appends and edits with urls the policy refuses (some updates throw `AsterUrlError`), signal changes, the policy
 * itself changing -- every scene must be what a fresh evaluation of the same input makes, and a scene returned before must never
 * change afterwards (a failed update included).
 */
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg, AsterUrlError } from './index.js'
import { createChartSession } from './session.js'
import { mulberry32, pick } from './scene-fuzz.testlib.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'
import type { ImageUrlPolicy } from './url-policy.js'

const SPEC = {
  width: 200, height: 100, data: [{ name: 't' }],
  signals: [{ name: 'op', value: 1 }],
  marks: [
    { type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 5 }, width: { value: 8 }, height: { value: 8 }, opacity: { signal: 'op' } } } },
    { type: 'symbol', from: { data: 't' }, encode: { update: { href: { field: 'h' }, x: { field: 'x' }, y: { value: 50 }, opacity: { signal: 'op' } } } },
  ],
} as unknown as VgSpec

const HOSTS = ['ok.test', 'ok.test', 'cdn.test', 'evil.test']
const allowOk = (u: URL): boolean => u.hostname !== 'evil.test'
const POLICIES: Array<() => ImageUrlPolicy> = [
  () => ({ allow: allowOk }),
  () => ({ allow: allowOk, onDeny: () => undefined }),
  () => ({ allow: () => false, onDeny: () => undefined }),
  () => ({ allow: () => true }),
]

describe('a session under a URL policy: every scene is a fresh evaluation\'s, and no scene changes after it is returned', () => {
  it('random sequences of appends, edits, signal changes and policy changes', () => {
    let threw = 0
    let appendsAfterThrow = 0
    for (let seed = 1; seed <= 80; seed++) {
      const r = mulberry32(seed)
      const session = createChartSession()
      const row = (i: number): Record<string, unknown> => ({ x: 10 + 15 * i, u: `https://${pick(r, HOSTS)}/i${i}.png`, h: `https://${pick(r, HOSTS)}/p${i}` })
      let rows: Array<Record<string, unknown>> = Array.from({ length: 2 }, (_, i) => ({ ...row(i), u: `https://ok.test/i${i}.png`, h: `https://ok.test/p${i}` }))
      let policyAt = 0
      let policy = POLICIES[policyAt]!()
      let op = 1
      const held: Array<{ scene: SceneRoot; svg: string }> = []
      let lastThrew = false
      for (let step = 0; step < 10; step++) {
        const what = r()
        // (an append of several rows: a refused one may come after rows already written in place)
        if (what < 0.45) for (let k = 1 + Math.floor(r() * 3); k > 0; k--) rows = [...rows, row(rows.length)]
        else if (what < 0.65 && rows.length) { const i = Math.floor(r() * rows.length); rows = rows.map((x, k) => (k === i ? { ...row(i) } : x)) }
        else if (what < 0.8) op = pick(r, [1, 0.5, 0.8])
        else { policyAt = Math.floor(r() * POLICIES.length); policy = POLICIES[policyAt]!() }
        if (lastThrew && what < 0.45) appendsAfterThrow++
        const input: RuntimeInput = { data: { t: structuredClone(rows) }, signals: { op }, urlPolicy: policy }
        let fresh: string | Error
        try { fresh = renderSceneToSvg(evaluateChart(compileChart(structuredClone(SPEC)), { ...input, data: { t: structuredClone(rows) } })) } catch (e) { fresh = e as Error }
        let got: string | Error
        try {
          const scene = session.evaluate(structuredClone(SPEC), input)
          got = renderSceneToSvg(scene)
          held.push({ scene, svg: got })
          lastThrew = false
        } catch (e) {
          got = e as Error
          threw++
          lastThrew = true
        }
        const label = `seed ${seed} step ${step} policy ${policyAt}`
        if (fresh instanceof Error) {
          expect(got, label).toBeInstanceOf(AsterUrlError)
          expect(fresh, label).toBeInstanceOf(AsterUrlError)
        } else {
          expect(got, label).toBe(fresh)
        }
        // nothing returned before has changed, the scenes a failed update would have extended included
        for (const h of held) expect(renderSceneToSvg(h.scene), `${label}: a scene returned before`).toBe(h.svg)
        // the scene of this update holds no refused host (only the last policy allows every host)
        if (!(got instanceof Error) && policyAt !== 3) expect(got.includes('evil.test'), label).toBe(false)
      }
    }
    // (the sequences reach what they must: refusals, and appends after one)
    expect(threw).toBeGreaterThan(20)
    expect(appendsAfterThrow).toBeGreaterThan(5)
  })

  it('the audit\'s sequence (C2): a refused append, then the rows before, then a signal change', () => {
    const session = createChartSession()
    const policy: ImageUrlPolicy = { allow: (u) => u.hostname === 'cdn.example.test' }
    const good = [{ x: 10, u: 'https://cdn.example.test/a.png', h: 'https://cdn.example.test/' }]
    const first = session.evaluate(structuredClone(SPEC), { data: { t: good }, urlPolicy: policy })
    const firstSvg = renderSceneToSvg(first)
    expect(() => session.evaluate(structuredClone(SPEC), { data: { t: [...good, { x: 30, u: 'https://tracker.evil.test/pixel.png', h: 'https://cdn.example.test/' }] }, urlPolicy: policy })).toThrowError(AsterUrlError)
    expect(renderSceneToSvg(first)).toBe(firstSvg)
    const again = renderSceneToSvg(session.evaluate(structuredClone(SPEC), { data: { t: good }, urlPolicy: policy }))
    expect(again).not.toContain('evil')
    const changed = renderSceneToSvg(session.evaluate(structuredClone(SPEC), { data: { t: good }, urlPolicy: policy, signals: { op: 0.5 } }))
    expect(changed).not.toContain('evil')
    expect((changed.match(/<image/g) ?? []).length).toBe(1)
  })

  it('a policy that changes with a signal change re-vets the links (C478): deny then allow, allow then deny', () => {
    for (const [a, b] of [[false, true], [true, false]] as const) {
      const session = createChartSession()
      const rows = [{ x: 10, u: 'https://ok.test/a.png', h: 'https://ok.test/p' }, { x: 40, u: 'https://ok.test/b.png', h: 'https://ok.test/q' }]
      const pol = (allow: boolean): ImageUrlPolicy => ({ allow: () => allow, onDeny: () => undefined })
      session.evaluate(structuredClone(SPEC), { data: { t: rows }, urlPolicy: pol(a), signals: { op: 1 } })
      const input: RuntimeInput = { data: { t: rows }, urlPolicy: pol(b), signals: { op: 0.5 } }
      const got = renderSceneToSvg(session.evaluate(structuredClone(SPEC), input))
      const fresh = renderSceneToSvg(evaluateChart(compileChart(structuredClone(SPEC)), input))
      expect(got, `${a} -> ${b}`).toBe(fresh)
      expect((got.match(/<a /g) ?? []).length, `${a} -> ${b}`).toBe(b ? 2 : 0)
    }
  })
})
