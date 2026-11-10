/**
 * Expression text as the expression lexer reads its names (expr-parser.ts): what the patterns that look for a name or a call in
 * the text of an expression read, so that they find what the lexer finds.
 */
/** A string the lexer reads as it is written: no escape, no character past ASCII (its names are what an ASCII pattern finds). */
export function lexedAsWritten(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === 92 || c > 127) return false
  }
  return true
}

/** The blanks the lexer skips besides the ASCII ones (see expr-parser.ts `isBlank`). */
const WIDE_BLANKS = new RegExp(`[${[0xa0, 0x1680, 0x180e, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff].map((c) => String.fromCharCode(c)).join('')}]`, 'g')

/**
 * `str` as the expression lexer reads its names: a `\uXXXX` escape is the character it stands for (`data` spelled with an escape is `data`)
 * and every blank it skips is a space, so the patterns that look for a name or a call in the text find what the lexer finds. Every
 * escape is decoded, those inside string literals too: that finds more names, never fewer.
 */
export function lexedText(str: string): string {
  if (lexedAsWritten(str)) return str
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))).replace(WIDE_BLANKS, ' ')
}

