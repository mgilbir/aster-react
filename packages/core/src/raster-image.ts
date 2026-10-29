/**
 * The bitmap a `heatmap` transform produces: what vega-geo draws into a canvas element (`getImageData` / `putImageData`) and the
 * image mark then shows. vega reads it back as `item.image`: the SVG renderer writes `image.toDataURL()` as the `href`, the canvas
 * renderer `drawImage`s it. This is a canvas-shaped value that holds its own pixels, so a host with no canvas (Node, a worker) can
 * still run the transform and render the image:
 *
 *   - `toDataURL()` is the platform canvas' own encoding when the document has one (so the PNG is byte for byte what vega's canvas
 *     element gives in the same browser), else a PNG written here (a valid but uncompressed one, large for a big grid);
 *   - `toCanvasSource()` is an element the canvas renderer's `drawImage` accepts, or undefined where the host has none.
 */

interface Canvas2D {
  width: number
  height: number
  getContext(kind: '2d'): { createImageData(w: number, h: number): { data: Uint8ClampedArray }; putImageData(image: unknown, x: number, y: number): void } | null
  toDataURL?(): string
}
const hostCanvas = (w: number, h: number): Canvas2D | undefined => {
  const g = globalThis as unknown as { document?: { createElement?: (tag: string) => unknown }; OffscreenCanvas?: new (w: number, h: number) => unknown }
  if (g.document?.createElement) {
    const c = g.document.createElement('canvas') as Canvas2D | null
    if (c) { c.width = w; c.height = h; return c }
  }
  return g.OffscreenCanvas ? (new g.OffscreenCanvas(w, h) as Canvas2D) : undefined
}

export class RasterImage {
  readonly complete = true
  private url: string | undefined
  private source: Canvas2D | null | undefined

  /** `pixels`: width x height x 4 bytes, straight (non-premultiplied) RGBA, as `ImageData` holds them. */
  constructor(readonly width: number, readonly height: number, readonly pixels: Uint8ClampedArray) {}

  /** The canvas holding the pixels, or null where the host has no canvas. */
  toCanvasSource(): Canvas2D | null {
    if (this.source === undefined) {
      const c = hostCanvas(this.width, this.height)
      const ctx = c?.getContext('2d') ?? null
      if (c && ctx) {
        const img = ctx.createImageData(this.width, this.height)
        img.data.set(this.pixels)
        ctx.putImageData(img, 0, 0)
        this.source = c
      } else this.source = null
    }
    return this.source
  }

  toDataURL(): string {
    if (this.url === undefined) {
      const c = this.toCanvasSource()
      this.url = c && typeof c.toDataURL === 'function' ? c.toDataURL() : pngDataUrl(this.width, this.height, this.pixels)
    }
    return this.url
  }
}

// -- a PNG without a compressor: 8-bit RGBA, stored deflate blocks ------------------------------------------------------------

let crcTable: Int32Array | undefined
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return ~c
}

function pngDataUrl(width: number, height: number, pixels: Uint8ClampedArray): string {
  const row = 1 + width * 4 // a filter byte (0: none) and the row
  const raw = new Uint8Array(row * height)
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * row + 1)
  // zlib: header, stored blocks of at most 65535 bytes, the Adler-32 of the data
  const blocks = Math.max(1, Math.ceil(raw.length / 65535))
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  z[0] = 0x78; z[1] = 0x01
  let o = 2
  for (let b = 0; b < blocks; b++) {
    const from = b * 65535
    const len = Math.min(65535, raw.length - from)
    z[o++] = b === blocks - 1 ? 1 : 0
    z[o++] = len & 0xff; z[o++] = len >>> 8; z[o++] = ~len & 0xff; z[o++] = (~len >>> 8) & 0xff
    z.set(raw.subarray(from, from + len), o)
    o += len
  }
  let s1 = 1
  let s2 = 0
  for (let i = 0; i < raw.length; i++) { s1 = (s1 + raw[i]!) % 65521; s2 = (s2 + s1) % 65521 }
  const adler = ((s2 << 16) | s1) >>> 0
  z[o++] = adler >>> 24; z[o++] = (adler >>> 16) & 0xff; z[o++] = (adler >>> 8) & 0xff; z[o++] = adler & 0xff

  const png = new Uint8Array(8 + 25 + (12 + z.length) + 12)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const dv = new DataView(png.buffer)
  let p = 8
  const chunk = (type: string, data: Uint8Array): void => {
    dv.setUint32(p, data.length)
    for (let i = 0; i < 4; i++) png[p + 4 + i] = type.charCodeAt(i)
    png.set(data, p + 8)
    dv.setUint32(p + 8 + data.length, crc32(png, p + 4, p + 8 + data.length) >>> 0)
    p += 12 + data.length
  }
  const ihdr = new Uint8Array(13)
  const hv = new DataView(ihdr.buffer)
  hv.setUint32(0, width); hv.setUint32(4, height)
  ihdr[8] = 8; ihdr[9] = 6 // 8 bits per channel, RGBA
  chunk('IHDR', ihdr)
  chunk('IDAT', z)
  chunk('IEND', new Uint8Array(0))

  let bin = ''
  for (let i = 0; i < png.length; i += 0x8000) bin += String.fromCharCode(...png.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(bin)}`
}
