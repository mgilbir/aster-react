/**
 * The page's data cache. Every gallery data file a spec loads is a request the page makes to the harness (Node), which answers it from
 * disk. Left lazy, that request waits on the Node event loop (shared with whatever else the harness is doing and with every other
 * worker's requests) INSIDE the loader's own 10 s timeout, so a starved harness reads as a data-loading failure of the chart.
 *
 * `window.__preloadData(urls)` is called by the harness BEFORE a spec runs, outside any timeout: it fetches the files once into page
 * memory. `fetch` is then answered from that memory for those URLs (both engines load through the global `fetch`), and passes through
 * to the network layer for anything else. Same bytes, same status and content type; only the wait moved.
 */
const cache = new Map<string, { body: ArrayBuffer; type: string }>()
const realFetch = window.fetch.bind(window)
const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

window.fetch = async (input, init) => {
  const hit = cache.get(new URL(urlOf(input), document.baseURI).href)
  if (hit === undefined || (init?.method ?? 'GET').toUpperCase() !== 'GET') return realFetch(input, init)
  if (init?.signal?.aborted) throw init.signal.reason
  return new Response(hit.body.slice(0), { status: 200, headers: { 'content-type': hit.type } })
}

;(window as unknown as { __preloadData: (urls: string[]) => Promise<void> }).__preloadData = async (urls) => {
  await Promise.all(urls.map(async (url) => {
    if (cache.has(url)) return
    const res = await realFetch(url)
    if (!res.ok) return // left to the lazy path, which reports the failure the way it always did
    cache.set(url, { body: await res.arrayBuffer(), type: res.headers.get('content-type') ?? 'application/octet-stream' })
  }))
}
