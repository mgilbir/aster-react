/**
 * What `--plant-difference` does to Aster's output in the gates that compare SVG documents (scripts/lib/run-gate.mjs): a mark
 * Aster drew and the oracle did not, at the end of the document. Every gate must report it as a difference and fail; a gate
 * that does not has a comparator or an exit path that cannot fail (scripts/gate-self-test.test.mjs).
 */
export function plantSvg(svg: string): string {
  const end = svg.lastIndexOf('</svg>')
  if (end < 0) throw new Error('plantSvg: no </svg> in the document')
  return `${svg.slice(0, end)}<path d="M1,1L9,9" stroke="#f00"></path>${svg.slice(end)}`
}
