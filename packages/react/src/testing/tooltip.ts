import { expect } from 'vitest'

/**
 * The chart tooltip on the page, or null when none shows. The tooltip is portalled into the document's body (not into the chart's
 * element), so tests look for it in the document; more than one at a time is a leaked tooltip and fails here.
 */
export function chartTooltip(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>('[data-testid="chart-tooltip"]')
  expect(all.length, 'at most one chart tooltip on the page').toBeLessThanOrEqual(1)
  return all[0] ?? null
}
