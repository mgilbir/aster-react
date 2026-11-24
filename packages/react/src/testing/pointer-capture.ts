/**
 * jsdom has no pointer capture (`Element.prototype.setPointerCapture` and the rest are undefined), and the chart's drags call it.
 * `stubPointerCapture()` puts mocks on `Element.prototype` and `restore()` takes them off again, so a test file leaves the
 * prototype as it found it (a stub left behind is global state the next test file in the same worker would inherit).
 */
import { vi, type Mock } from 'vitest'

const NAMES = ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture', 'getPointerCapture'] as const

export interface PointerCaptureStub {
  setPointerCapture: Mock
  releasePointerCapture: Mock
  restore(): void
}

export function stubPointerCapture(): PointerCaptureStub {
  const proto = Element.prototype as unknown as Record<string, unknown>
  const saved = NAMES.map((n) => [n, Object.getOwnPropertyDescriptor(proto, n)] as const)
  const stub = {
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false), getPointerCapture: vi.fn(() => null),
  }
  for (const n of NAMES) Object.defineProperty(proto, n, { value: stub[n], configurable: true, writable: true })
  return {
    setPointerCapture: stub.setPointerCapture,
    releasePointerCapture: stub.releasePointerCapture,
    restore() {
      for (const [n, d] of saved) { if (d) Object.defineProperty(proto, n, d); else delete proto[n] }
    },
  }
}
