// @vitest-environment node
/**
 * The loader's "non-public host" rule (C13), checked against an independent reference: the IANA special-purpose blocks as CIDR
 * data, matched by Node's own `net.BlockList`, over generated addresses (every block's edges and random members, random public
 * addresses) in every spelling the URL parser accepts for them: dotted, decimal, hex, octal, short forms, and the IPv6 forms that
 * carry an IPv4 address (mapped, well-known NAT64, 6to4). Names: dotless, trailing dots, the special-use and private-use suffixes.
 */
import { describe, expect, it } from 'vitest'
import { BlockList } from 'node:net'
import { isNonPublicHost } from './addon-load.js'

// -- the reference -----------------------------------------------------------------------------------------------------

/** IPv4 blocks that are not globally reachable (IANA IPv4 Special-Purpose Address Registry), multicast and reserved. */
const V4_NON_PUBLIC = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
]
/** IPv6: public is global unicast 2000::/3 minus these (the forms carrying an IPv4 address are judged by it, below). */
const V6_NON_PUBLIC_IN_2000 = ['2001::/23', '2001:db8::/32', '3fff::/20']

const v4List = new BlockList()
for (const c of V4_NON_PUBLIC) { const [a, p] = c.split('/'); v4List.addSubnet(a!, Number(p), 'ipv4') }
const v6List = new BlockList()
for (const c of V6_NON_PUBLIC_IN_2000) { const [a, p] = c.split('/'); v6List.addSubnet(a!, Number(p), 'ipv6') }

const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
const v4Expected = (n: number): boolean => v4List.check(dotted(n), 'ipv4')
const hex4 = (n: number): string => n.toString(16)

/** Every spelling of an IPv4 address the WHATWG parser reads as that address, in a URL host or inside an IPv6 literal. */
function v4Spellings(n: number): string[] {
  const o = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const hi = hex4((o[0]! << 8) | o[1]!)
  const lo = hex4((o[2]! << 8) | o[3]!)
  return [
    dotted(n), String(n >>> 0), '0x' + (n >>> 0).toString(16), '0' + (n >>> 0).toString(8),
    `${o[0]}.${(n & 0xffffff) >>> 0}`, `${o[0]}.${o[1]}.${n & 0xffff}`, o.map((x) => '0x' + x.toString(16)).join('.'), o.map((x) => '0' + x.toString(8)).join('.'),
    dotted(n) + '.', // a trailing dot
    `[::ffff:${dotted(n)}]`, `[::ffff:${hi}:${lo}]`, `[64:ff9b::${dotted(n)}]`, `[64:ff9b::${hi}:${lo}]`, `[2002:${hi}:${lo}::1]`, `[2002:${hi}:${lo}:ffff::]`,
  ]
}

// a deterministic generator (the run is reproducible from the seed)
let seed = 0x2f6b1d
const rand = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed }

function v4Samples(): number[] {
  const out: number[] = []
  for (const c of V4_NON_PUBLIC) {
    const [a, p] = c.split('/')
    const base = a!.split('.').reduce((x, y) => ((x << 8) | Number(y)) >>> 0, 0)
    const size = 2 ** (32 - Number(p))
    // the block's edges, the addresses just outside it, and members at random
    out.push(base, (base + size - 1) >>> 0, (base - 1) >>> 0, (base + size) >>> 0)
    for (let i = 0; i < 8; i++) out.push((base + (rand() % size)) >>> 0)
  }
  for (let i = 0; i < 400; i++) out.push(rand())
  return out.filter((n) => n >= 0 && n <= 0xffffffff)
}

describe('isNonPublicHost agrees with the IANA blocks (Node BlockList) for every IPv4 spelling', () => {
  it('IPv4 addresses, decimal / hex / octal / short / trailing-dot forms, and the IPv6 forms carrying them', () => {
    const wrong: string[] = []
    let checked = 0
    for (const n of v4Samples()) {
      const expected = v4Expected(n)
      for (const host of v4Spellings(n)) {
        checked++
        if (isNonPublicHost(host) !== expected) wrong.push(`${host} (${dotted(n)}) expected ${expected}`)
      }
    }
    expect(checked).toBeGreaterThan(5000)
    expect(wrong.slice(0, 20)).toEqual([])
  })

  it('IPv6: only global unicast 2000::/3 outside its special blocks is public', () => {
    const wrong: string[] = []
    const group = (): string => hex4(rand() & 0xffff)
    for (let i = 0; i < 3000; i++) {
      // bias the first group toward the interesting space: anywhere, inside 2000::/3, and the special prefixes
      const pick = i % 4
      const first = pick === 0 ? rand() & 0xffff : pick === 1 ? 0x2000 | (rand() & 0x1fff) : [0x2001, 0x2002, 0x3fff, 0x64, 0xfe80, 0xfec0, 0xfc00, 0xfd00, 0xff02, 0x0100, 0][rand() % 11]!
      const second = pick === 3 ? [0, 0x1, 0x1ff, 0x200, 0xdb8, 0xfff, 0x1000, 0xff9b][rand() % 8]! : rand() & 0xffff
      const groups = [hex4(first), hex4(second), group(), group(), group(), group(), group(), group()]
      const addr = groups.join(':')
      // forms carrying an IPv4 address are covered by the IPv4 test
      if (first === 0x2002 || (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every((g) => parseInt(g, 16) === 0))) continue
      const expected = (first & 0xe000) !== 0x2000 || v6List.check(addr, 'ipv6')
      if (isNonPublicHost(`[${addr}]`) !== expected) wrong.push(`${addr} expected ${expected}`)
      if (isNonPublicHost(addr) !== expected) wrong.push(`${addr} (no brackets) expected ${expected}`)
    }
    expect(wrong.slice(0, 20)).toEqual([])
  })

  it('the forms the audit found fetched (C13) are non-public', () => {
    for (const h of ['[::ffff:0:127.0.0.1]', '[::ffff:0:7f00:1]', '[64:ff9b:1::7f00:1]', '[fec0::1]', '[2001:0:7f00:1::]', '[::127.0.0.1]', '[::808:808]',
      '[100::1]', '[2001:db8::1]', '[3fff::1]', '[5f00::1]', '[::ffff:a9fe:a9fe]', '[64:ff9b::a9fe:a9fe]']) {
      expect(isNonPublicHost(h), h).toBe(true)
    }
    for (const h of ['[2606:4700::1111]', '[2a00:1450:4001::200e]', '[::ffff:808:808]', '[64:ff9b::808:808]', '[2002:808:808::1]']) {
      expect(isNonPublicHost(h), h).toBe(false)
    }
  })
})

describe('names', () => {
  it('a name with no dot (after trailing dots) is non-public: compose and cluster service names, search-domain names', () => {
    for (const h of ['metadata', 'intranet', 'db', 'redis', 'localhost', 'localhost.', 'localhost..', 'metadata.', 'printer...', '.', '..', '']) {
      expect(isNonPublicHost(h), JSON.stringify(h)).toBe(true)
    }
  })

  it('special-use and private-use suffixes are non-public, in any case and with trailing dots', () => {
    const suffixes = ['test', 'localhost', 'invalid', 'example', 'local', 'onion', 'alt', 'arpa', 'internal', 'localdomain', 'lan', 'home', 'corp', 'intranet', 'private', 'svc']
    for (const s of suffixes) {
      for (const h of [`a.${s}`, `x.y.${s}`, `A.${s.toUpperCase()}`, `a.${s}.`, `a.${s}..`]) expect(isNonPublicHost(h), h).toBe(true)
    }
    for (const h of ['kubernetes.default.svc', 'web.default.svc.cluster.local', 'printer.home.arpa', '1.0.0.127.in-addr.arpa', 'router.lan', 'db.corp']) {
      expect(isNonPublicHost(h), h).toBe(true)
    }
  })

  it('public names stay public (the suffix is the last label only)', () => {
    for (const h of ['example.com', 'data.example.org', 'lan.example.com', 'corp.example.net', 'local.news', 'test.io', 'xn--bcher-kva.example.com', 'EXAMPLE.COM', 'example.com.']) {
      expect(isNonPublicHost(h), h).toBe(false)
    }
  })

  it('anything that is not a host is non-public (fail closed)', () => {
    for (const h of ['a b', 'a/b', 'user@example.com', 'example.com:80', '[::1', '[zz::1]', 'exa%mple.com', '1.2.3.4.5:']) {
      expect(isNonPublicHost(h), h).toBe(true)
    }
    expect(isNonPublicHost(undefined as unknown as string)).toBe(true)
  })
})
