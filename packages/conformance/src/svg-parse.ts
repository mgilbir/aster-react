/**
 * Minimal well-formed XML/SVG parser (no DOM dependency). Produces a tree of
 * elements with attributes and text children.
 */

export interface XmlEl {
  tag: string
  attrs: Record<string, string>
  children: Array<XmlEl | string>
}

export function parseSvg(xml: string): XmlEl {
  const root: XmlEl = { tag: '#root', attrs: {}, children: [] }
  const stack: XmlEl[] = [root]
  let i = 0
  const n = xml.length

  const readTag = (): string => {
    const m = /^[^\s/>]+/.exec(xml.slice(i))
    if (!m) throw new Error('malformed tag')
    i += m[0].length
    return m[0]
  }
  const skipWs = () => {
    while (i < n && /\s/.test(xml[i]!)) i++
  }
  const readAttrValue = (): string => {
    const quote = xml[i]
    i++
    let s = ''
    while (i < n && xml[i] !== quote) {
      s += xml[i]
      i++
    }
    i++ // closing quote
    return s
  }

  while (i < n) {
    if (xml[i] === '<') {
      if (xml.startsWith('<!--', i)) {
        const end = xml.indexOf('-->', i)
        if (end < 0) throw new Error('unterminated comment')
        i = end + 3
        continue
      }
      if (xml.startsWith('<!', i)) {
        const end = xml.indexOf('>', i)
        if (end < 0) throw new Error('malformed declaration')
        i = end + 1
        continue
      }
      i++ // consume '<'
      const closing = xml[i] === '/'
      if (closing) i++
      skipWs()
      const tag = readTag()
      skipWs()
      const attrs: Record<string, string> = {}
      while (i < n && xml[i] !== '>' && !(xml[i] === '/' && xml[i + 1] === '>')) {
        skipWs()
        if (xml[i] === '>' || (xml[i] === '/' && xml[i + 1] === '>')) break
        const nameMatch = /^[^\s=/>]+/.exec(xml.slice(i))
        if (!nameMatch) throw new Error('malformed attribute')
        const name = nameMatch[0]
        i += name.length
        skipWs()
        if (xml[i] === '=') {
          i++
          skipWs()
          if (xml[i] === '"' || xml[i] === "'") attrs[name] = readAttrValue()
        }
      }
      const selfClosing = xml[i] === '/' && xml[i + 1] === '>'
      if (selfClosing) {
        i += 2
        stack[stack.length - 1]!.children.push({ tag, attrs, children: [] })
        continue
      }
      if (xml[i] === '>') i++
      if (closing) {
        const el = stack.pop()
        if (!el || el.tag !== tag) throw new Error(`mismatched close tag ${tag}`)
        continue
      }
      const el: XmlEl = { tag, attrs, children: [] }
      stack[stack.length - 1]!.children.push(el)
      stack.push(el)
    } else if (xml[i] === '>') {
      // stray close within text (e.g., '&gt;' already decoded) — skip
      i++
    } else {
      // text content
      let s = ''
      while (i < n && xml[i] !== '<') {
        s += xml[i]
        i++
      }
      const parent = stack[stack.length - 1]!
      parent.children.push(s)
    }
  }
  if (stack.length !== 1) throw new Error('unclosed elements')
  return root
}
