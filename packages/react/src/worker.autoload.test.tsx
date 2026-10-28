// @vitest-environment jsdom
/**
 * Add-on auto-load in the worker host: the worker (a realm of its own) imports the add-ons a message's spec needs before it
 * handles the message, and the main-thread fallbacks of the worker hooks do the same. The worker entry itself runs messages in
 * arrival order; its pieces are tested here (`prepareWorkerMessage`, `handleWorkerMessageWithAddons`). No add-on is imported
 * by this file, which is the premise.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSpec, type ChartStream, type VgSpec } from '@aster/core'
import { isAddonLoaded } from '@aster/core/addons'
import {
  createWorkerDispatcher, handleChartWorkerRequest, handleWorkerMessage, handleWorkerMessageWithAddons, prepareWorkerMessage,   type ChartWorkerResponse, type ChartWorkerStreamResponse,
} from './worker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const PIE = corpus('t-pie.vg.json')
const MAP = corpus('geo-vlout-mercator-translate.vg.json')
const CSV: VgSpec = {
  width: 100, height: 40, padding: 0,
  data: [{ name: 't', values: 'k,v\na,1\nb,2', format: { type: 'csv', parse: { v: 'number' } } }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 10 } } } }],
}
const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

async function until(ready: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!ready() && Date.now() - t0 < ms) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

describe('the worker host, with nothing imported', () => {
  it('starts with no add-on registered', () => {
    expect((['transforms', 'geo', 'load'] as const).some(isAddonLoaded)).toBe(false)
  })

  it('a stream message for a later op needs nothing; init and one-shot requests are read for their spec', () => {
    const request = { id: 1, spec: PIE, input: { width: 300, height: 200 } }
    expect(prepareWorkerMessage(request).missing).toEqual(['transforms'])
    expect(prepareWorkerMessage({ kind: 'stream', id: 2, streamId: 1, op: 'init', spec: MAP }).missing).toEqual(['geo'])
    expect(prepareWorkerMessage({ kind: 'stream', id: 3, streamId: 1, op: 'flush', batches: [] }).missing).toEqual([])
    expect(prepareWorkerMessage({ id: 4, spec: 'not a spec' }).missing).toEqual([])
    expect(prepareWorkerMessage(null).missing).toEqual([])
  })

  it('the sync request handler, without the add-on, answers with the actionable error (the premise of loading it)', () => {
    const response = handleChartWorkerRequest({ id: 1, spec: PIE, input: { width: 300, height: 200 } })
    expect(response.error?.message).toMatch(/load the addon first/)
  })

  it('handleWorkerMessageWithAddons loads what the spec needs, then answers like the sync handler', async () => {
    const message = { id: 7, spec: PIE, input: { width: 300, height: 200 } }
    const { data, missing } = prepareWorkerMessage(message)
    expect(missing).toEqual(['transforms'])
    const response = await handleWorkerMessageWithAddons(data, missing, new Map<number, ChartStream>()) as ChartWorkerResponse
    expect(response.error).toBeUndefined()
    expect(response.id).toBe(7)
    expect(response.svg).toBe(renderSpec(PIE, { width: 300, height: 200 }))
    // loaded now: the same message needs nothing, and the plain handler answers the same
    expect(prepareWorkerMessage(message).missing).toEqual([])
    expect((handleWorkerMessage(message, new Map()) as ChartWorkerResponse).svg).toBe(response.svg)
  })

  it('a stream init loads the add-on too, and its answer carries the first scene', async () => {
    const streams = new Map<number, ChartStream>()
    const { data, missing } = prepareWorkerMessage({ kind: 'stream', id: 9, streamId: 3, op: 'init', spec: MAP })
    expect(missing).toEqual(['geo'])
    const response = await handleWorkerMessageWithAddons(data, missing, streams) as ChartWorkerStreamResponse
    expect(response.error).toBeUndefined()
    expect(response.scene).toBeTruthy()
    expect(streams.has(3)).toBe(true)
  })

  it('the dispatcher answers messages in arrival order: a flush queued behind an init that waits for an import', async () => {
    // (the load add-on has not been loaded yet; the csv stream init needs it)
    expect(isAddonLoaded('load')).toBe(false)
    const out: Array<ChartWorkerResponse | ChartWorkerStreamResponse> = []
    const dispatch = createWorkerDispatcher(new Map<number, ChartStream>(), (r) => out.push(r))
    dispatch({ kind: 'stream', id: 21, streamId: 5, op: 'init', spec: CSV })
    dispatch({ kind: 'stream', id: 22, streamId: 5, op: 'flush', batches: [] })
    dispatch({ id: 23, spec: PIE, input: { width: 300, height: 200 } })
    expect(out).toEqual([]) // the init is waiting for the import, the rest behind it
    for (let i = 0; i < 400 && out.length < 3; i++) await new Promise((r) => setTimeout(r, 10))
    expect(out.map((r) => r.id)).toEqual([21, 22, 23])
    expect(out.map((r) => r.error)).toEqual([undefined, undefined, undefined])
    // and once nothing waits, a message that needs nothing is answered in the same turn
    dispatch({ kind: 'stream', id: 24, streamId: 5, op: 'close' })
    expect(out.map((r) => r.id)).toEqual([21, 22, 23, 24])
  })
})
