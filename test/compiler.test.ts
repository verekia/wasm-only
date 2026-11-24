import { test, expect } from 'bun:test'
import { compile } from '../nib/compiler.ts'
import { instantiate } from '../nib/loader.ts'

/** Compiles `src` (plus optional extra files) and returns the instance's exports. */
function run(src: string, files: Record<string, string> = {}): any {
  const all: Record<string, string> = { 'main.nib': src, ...files }
  const { wasm, bindings } = compile('main.nib', { read: p => { if (p in all) return all[p]; throw new Error('missing ' + p) }, debug: true })
  return instantiate(wasm, bindings).exports
}
const fails = (src: string) => { try { run(src) } catch (e: any) { return e.message as string } return '' }

test('arithmetic, precedence and literal typing', () => {
  const x = run(`
    export fn a(x: i32, y: i32): i32 { return x + y * 2 - (x & 3) }
    export fn b(x: f32): f32 { return x * 0.5 + 1 }
    export fn c(x: f64): f64 { return -x / 4 }
    export fn d(x: u32): u32 { return x >> 1 }
    export fn e(x: i32): i32 { return x >> 1 }
    export fn f(x: u32, y: u32): bool { return x < y }
    export fn g(x: i32): i32 { return ~x % 7 }
    export fn h(x: i64): i64 { return x * 3 + 1 }
  `)
  expect(x.a(5, 7)).toBe(5 + 14 - 1)
  expect(x.b(3)).toBe(2.5)
  expect(x.c(8)).toBe(-2)
  expect(x.d(-2) >>> 0).toBe(0x7fffffff)
  expect(x.e(-2)).toBe(-1)
  expect(x.f(1, -1)).toBe(1)
  expect(x.g(10)).toBe(~10 % 7)
  expect(x.h(5n)).toBe(16n)
})

test('casts', () => {
  const x = run(`
    export fn a(x: f32): i32 { return x as i32 }
    export fn b(x: i32): f64 { return x as f64 / 2.0 }
    export fn c(x: i32): i32 { return x as u8 }
    export fn d(x: i32): i32 { return x as i8 }
    export fn e(x: u32): f64 { return x as f64 }
    export fn f(): i32 { return 3.99 as i32 + (300 as u8) }
    export fn g(x: i32): i64 { return x as i64 }
  `)
  expect(x.a(-3.7)).toBe(-3)
  expect(x.a(1e20)).toBe(2 ** 31 - 1)
  expect(x.b(3)).toBe(1.5)
  expect(x.c(0x1ff)).toBe(0xff)
  expect(x.d(0xff)).toBe(-1)
  expect(x.e(-1)).toBe(2 ** 32 - 1)
  expect(x.f()).toBe(3 + 44)
  expect(x.g(-2)).toBe(-2n)
})

test('control flow', () => {
  const x = run(`
    export fn sum(n: i32): i32 { let s = 0; for i in 0..n { s += i } return s }
    export fn collatz(n: i32): i32 {
      let steps = 0
      while n != 1 {
        if n % 2 == 0 { n = n / 2 } else { n = n * 3 + 1 }
        steps += 1
      }
      return steps
    }
    export fn odds(n: i32): i32 {
      let s = 0
      for i in 0..n { if i % 2 == 0 { continue } s += i }
      return s
    }
    export fn first(n: i32): i32 {
      let i = 0
      loop { if i * i > n { break } i += 1 }
      return i
    }
    export fn nested(n: i32): i32 {
      let c = 0
      for i in 0..n { let j = 0; while j < i { j += 1; if j == 3 { continue } if j > 5 { break } c += 1 } }
      return c
    }
    export fn early(x: i32): i32 { if x < 0 { return -1 } else if x == 0 { return 0 } return 1 }
    export fn pick(x: i32, a: f32, b: f32): f32 { return x > 0 && x < 10 || x == 99 ? a : b }
  `)
  expect(x.sum(101)).toBe(5050)
  expect(x.sum(0)).toBe(0)
  expect(x.collatz(27)).toBe(111)
  expect(x.odds(10)).toBe(25)
  expect(x.first(50)).toBe(8)
  let c = 0; for (let i = 0; i < 9; i++) { let j = 0; while (j < i) { j++; if (j === 3) continue; if (j > 5) break; c++ } }
  expect(x.nested(9)).toBe(c)
  expect([x.early(-5), x.early(0), x.early(5)]).toEqual([-1, 0, 1])
  expect([x.pick(5, 1, 2), x.pick(50, 1, 2), x.pick(99, 1, 2)]).toEqual([1, 2, 1])
})

test('structs are values: locals, multi-value returns, nesting, globals', () => {
  const x = run(`
    struct V2 { x: f32, y: f32 }
    struct Box { lo: V2, hi: V2, id: i32 }
    var acc: V2 = V2(1, 2)
    fn add(a: V2, b: V2): V2 { return V2(a.x + b.x, a.y + b.y) }
    fn grow(b: Box, by: f32): Box { b.hi = add(b.hi, V2(by, by)); b.id += 1; return b }
    export fn area(w: f32, h: f32): f32 {
      let b = grow(Box(V2(0, 0), V2(w, h), 7), 1)
      return (b.hi.x - b.lo.x) * (b.hi.y - b.lo.y) + b.id as f32
    }
    export fn pair(a: f32): V2 { return add(V2(a, a), V2(1, 2)) }
    export fn bump(): f32 { acc = add(acc, V2(10, 20)); acc.x += 0.5; return acc.x + acc.y }
    export fn field(): f32 { return add(V2(1, 2), V2(3, 4)).y }
  `)
  expect(x.area(2, 3)).toBe(3 * 4 + 8)
  expect(x.pair(5)).toEqual([6, 7])
  expect(x.bump()).toBe(11.5 + 22)
  expect(x.bump()).toBe(22 + 42)
  expect(x.field()).toBe(6)
})

test('memory: statics, pointers, struct layout, narrow types', () => {
  const x = run(`
    struct P { x: f32, y: f32, tag: u8, n: u16 }
    static ps: [P; 4]
    static table: [i32; 4] = [10, 20, 30, 40]
    static bytes: [u8; 3] = [1, 255, 3]
    export fn size(): i32 { return sizeof(P) }
    export fn fill() { for i in 0..4 { ps[i] = P(i as f32, 2.0, 200 + i, 1000 * i) } }
    export fn get(i: i32): f32 { let p = ps[i]; return p.x + p.y + p.tag as f32 + p.n as f32 }
    export fn viaPtr(i: i32): i32 { let p = &ps[i]; p.n += 5; return p.n }
    export fn look(i: i32): i32 { return table[i] + table[3] + bytes[1] }
    export fn raw(): i32 { let q = &ps[1].y as *u32; return q[0] as i32 }
    export fn swap() { let t = ps[0]; ps[0] = ps[3]; ps[3] = t }
    export fn where(): i32 { return &ps[2].tag as i32 - ps as i32 }
  `)
  expect(x.size()).toBe(12)
  x.fill()
  expect(x.get(2)).toBe(2 + 2 + 202 + 2000)
  expect(x.viaPtr(3)).toBe(3005)
  expect(x.look(1)).toBe(20 + 40 + 255)
  expect(x.raw()).toBe(0x40000000)
  x.swap()
  expect(x.get(0)).toBe(3 + 2 + 203 + 3005)
  expect(x.where()).toBe(24 + 8)
  expect(new Float32Array(x.memory.buffer, 16, 2)[0]).toBe(3)
})

test('inline functions keep constants constant', () => {
  const x = run(`
    inline fn sq(x: f32): f32 { return x * x }
    inline fn clamp(x: i32, lo: i32, hi: i32): i32 { if x < lo { return lo } if x > hi { return hi } return x }
    inline fn pow(x: i32, n: i32): i32 { return n == 0 ? 1 : x * pow(x, n - 1) }
    inline fn countdown(n: i32): i32 { let s = 0; while n > 0 { s += n; n -= 1 } return s }
    const K = sq(3) + 1
    export fn a(x: f32): f32 { return sq(x + 1) }
    export fn b(x: i32): i32 { return clamp(x, 0, 10) + clamp(x * 2, -5, 5) }
    export fn c(x: i32): i32 { return pow(x, 5) }
    export fn d(): f32 { return K }
    export fn e(n: i32): i32 { return countdown(n) + countdown(3) }
    export fn f(): i32 { let s = 0; inline for i in 0..4 { s += pow(2, i) } return s }
  `)
  expect(x.a(2)).toBe(9)
  expect([x.b(-3), x.b(4), x.b(40)]).toEqual([-5, 9, 15])
  expect(x.c(3)).toBe(243)
  expect(x.d()).toBe(10)
  expect(x.e(4)).toBe(16)
  expect(x.f()).toBe(15)
})

test('comptime: constants, host functions and memory snapshots', () => {
  const x = run(`
    extern fn Math.sin(x: f64): f64
    extern fn Math.tan(x: f64): f64
    struct V2 { x: f32, y: f32 }
    fn fib(n: i32): i32 { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
    fn polar(a: f64): V2 { return V2(sin(a) as f32, tan(a) as f32) }
    const F20 = fib(20)
    const DIR = polar(0.5)
    const HALF: f64 = sin(0.5235987755982988)
    static squares: [i32; 8] = comptime fill
    fn fill(p: *i32) { for i in 0..8 { p[i] = i * i } }
    export fn a(): i32 { return F20 + comptime fib(10) }
    export fn b(): f32 { return DIR.x + DIR.y }
    export fn c(): f64 { return HALF }
    export fn d(i: i32): i32 { return squares[i] }
  `)
  expect(x.a()).toBe(6765 + 55)
  expect(x.b()).toBe(Math.fround(Math.fround(Math.sin(0.5)) + Math.fround(Math.tan(0.5))))
  expect(x.c()).toBeCloseTo(0.5, 12)
  expect(x.d(7)).toBe(49)
  // the trig ran in the compiler: the module imports nothing
  const { wasm } = compile('m', { read: () => 'extern fn Math.sin(x: f64): f64\nconst S: f64 = sin(1.0)\nexport fn s(): f64 { return S }' })
  expect(WebAssembly.Module.imports(new WebAssembly.Module(wasm))).toEqual([])
})

test('addresses computed at compile time match the final layout', () => {
  const x = run(`
    static pad: [i32; 7]
    static a: [f32x4; 2]
    static b: [u8; 3] = [1, 2, 3]
    static links: [*u8; 2] = comptime link
    const A = a as *f32
    const LAST = &b[2]
    fn link(out: **u8) { out[0] = b; out[1] = &b[1] }
    export fn go(): f32 { pad[6] = 9; A[5] = 2.5; return a[1].y + LAST[0] as f32 + links[1][0] as f32 + (links[0] == b ? 100.0 : 0.0) }
  `)
  expect(x.go()).toBe(2.5 + 3 + 2 + 100)
})

test('for-loop counters index memory through a pre-scaled copy', () => {
  const x = run(`
    struct P { a: i32, b: f64 }
    static xs: [i32; 8]
    static ps: [P; 8]
    static bytes: [u8; 8]
    export fn go(from: i32, to: i32): f64 {
      for i in 0..8 { xs[i] = i * 10; ps[i] = P(i, i as f64 * 0.5); bytes[i] = i }
      let sum: f64 = 0.0
      for i in from..to {
        if i == 3 { continue }
        let p = &ps[i]
        for j in i..to { sum += (xs[j] + bytes[j] + p.a) as f64 + ps[j].b }
        if xs[i] > 50 { break }
      }
      return sum
    }
  `)
  const ref = (from: number, to: number) => {
    let sum = 0
    for (let i = from; i < to; i++) { if (i === 3) continue; for (let j = i; j < to; j++) sum += j * 10 + j + i + j * 0.5; if (i * 10 > 50) break }
    return sum
  }
  expect(x.go(0, 8)).toBe(ref(0, 8))
  expect(x.go(2, 7)).toBe(ref(2, 7))
  expect(x.go(5, 5)).toBe(0)
  expect(fails('export fn a() { for i in 0..4 { i = 2 } }')).toContain('a for-loop counter cannot be assigned')
})

test('simd', () => {
  const x = run(`
    static m: [f32x4; 4]
    static out: [f32x4; 4]
    inline fn mul(o: *f32x4, a: *f32x4, b: *f32x4) {
      let a0 = a[0]
      let a1 = a[1]
      let a2 = a[2]
      let a3 = a[3]
      inline for j in 0..4 {
        let c = b[j]
        o[j] = a0 * splat(c.x) + a1 * splat(c.y) + a2 * splat(c.z) + a3 * splat(c.w)
      }
    }
    export fn go(s: f32): f32 {
      for i in 0..4 { m[i] = f32x4(s, i as f32, 0, 1) }
      m[3] = f32x4(1, 2, 3, 4) - splat(1) * f32x4(0, 0, 0, 2)
      mul(out, m, m)
      let v = sqrt(out[3] * out[3])
      return v.x + v.y + v.z + v.w + max(out[0], out[1]).y
    }
  `)
  const s = 2, m = [[s, 0, 0, 1], [s, 1, 0, 1], [s, 2, 0, 1], [1, 2, 3, 2]]
  const col = (j: number) => [0, 1, 2, 3].map(r => m[0][r] * m[j][0] + m[1][r] * m[j][1] + m[2][r] * m[j][2] + m[3][r] * m[j][3])
  expect(x.go(s)).toBe(col(3).reduce((a, b) => a + Math.abs(b), 0) + Math.max(col(0)[1], col(1)[1]))
})

test('JavaScript bindings', () => {
  const g = globalThis as any
  g.__seen = []
  const x = run(`
    extern fn Math.hypot(...): f64
    extern new Map(): ext
    extern call Map.set(k: any, v: any): ext as put
    extern call Map.get(k: any): f64 as lookup
    extern get Map.size: i32
    extern call Array.push(...) as push
    extern call Array.join(sep: ext): ext
    extern val __seen: ext
    extern new Uint8Array(buf: ext, at: i32, len: i32): ext
    extern fn Reflect.get(o: ext, k: ext): ext as prop
    extern get WebAssembly.Memory.buffer: ext
    extern call Promise.then(f: func): ext
    extern call Promise.resolve(v: any): ext as resolved
    extern val Promise: ext
    extern js describe(o: ext, n: i32): ext = "(o, n) => Object.keys(o).slice(0, n).join('+')"
    static data: [u8; 4] = [7, 8, 9, 10]
    var later = 0
    fn onValue(v: i32) { later = v * 2 }
    export fn peek(): i32 { return later }
    export fn main(exports: ext): ext {
      let m = Map()
      put(m, "a", 1.5)
      put(m, 2, 40)
      let o = { name: "nib", n: size(m), list: [1, "two", 3.5], big: 4000000000 as u32 }
      push(__seen, o, lookup(m, "a") + lookup(m, 2), hypot(3, 4), join(prop(o, "list"), "-"))
      push(__seen, Uint8Array(buffer(prop(exports, "memory")), data as i32 + 1, 2), describe(o, 3), { fixed: [1, true, null, "s"], nested: { deep: [m] } })
      then(resolved(Promise, 21), onValue)
      return null
    }
  `)
  expect(x.main(x)).toBe(null)
  expect(g.__seen[0]).toEqual({ name: 'nib', n: 2, list: [1, 'two', 3.5], big: 4000000000 })
  expect(g.__seen.slice(1, 4)).toEqual([41.5, 5, '1-two-3.5'])
  expect([...g.__seen[4]]).toEqual([8, 9])
  expect(g.__seen[5]).toBe('name+n+list')
  expect(g.__seen[6]).toEqual({ fixed: [1, true, null, 's'], nested: { deep: [new Map<any, any>([['a', 1.5], [2, 40]])] } })
  // a literal is one binding: the JavaScript that builds it, constants included
  const out = compile('m', { read: () => 'export fn f(x: i32): ext { return { size: [x, 4], label: "hi", on: true } }' })
  expect(out.table).toEqual(['(a)=>({size:[a,4],label:"hi",on:true})'])
  expect(WebAssembly.Module.imports(new WebAssembly.Module(out.wasm))).toEqual([{ module: out.bindings.slice(1, out.bindings.indexOf(':')), name: '0', kind: 'function' }])
  return Promise.resolve().then(() => expect(x.peek()).toBe(42))
})

test('imports, embed and tree shaking', () => {
  const x = run(`
    import "lib/math"
    import "lib/math.nib"
    const TEXT = embed("note.txt")
    extern call String.charCodeAt(i: i32): i32
    export fn a(): i32 { return twice(21) + charCodeAt(TEXT, 4) }
  `, { 'lib/math.nib': 'fn twice(x: i32): i32 { return x * 2 }\nfn unused(): i32 { return nope() }', 'note.txt': 'hello' })
  expect(x.a()).toBe(42 + 111)
})

test('errors point at the source', () => {
  expect(fails('export fn a(): i32 { return 1.5 }')).toContain('main.nib:1:29: expected i32, found float literal')
  expect(fails('export fn a(x: i32): f32 { return x }')).toContain('expected f32, found i32')
  expect(fails('export fn a() { b() }')).toContain("unknown function 'b'")
  expect(fails('export fn a(x: i32) { let p = &x }')).toContain('locals have no address')
  expect(fails('const A = A + 1\nexport fn a(): i32 { return A }')).toContain('depends on itself')
  expect(fails('export fn a(x: i32, y: f32): f32 { return x * y }')).toContain('mismatched types: i32 * f32')
  expect(fails('export fn a() { break }')).toContain('break outside a loop')
  expect(fails('export fn a() {\n  let x = \n}')).toContain("main.nib:3:1: unexpected '}'")
})

test('assorted code generation paths agree with JavaScript', () => {
  const x = run(`
    struct P { a: i16, b: i8, c: f32 }
    static ps: [P; 16]
    static src: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8]
    static dst: [u8; 8]
    var calls = 0
    fn tick(v: bool): bool { calls += 1; return v }
    export fn compound(j: i32, v: i32): i32 {
      let p = ps as *i16
      p[j * 4 + 1] = -5
      p[j * 4 + 1] += v
      p[j * 4 + 1] *= 3
      ps[j + 1] = P(-300, -7, 1.5)
      ps[j + 1].c += 2.0
      return p[j * 4 + 1] + ps[j + 1].a + ps[j + 1].b + ps[j + 1].c as i32
    }
    export fn circuit(a: bool, b: bool): i32 {
      calls = 0
      let r = (tick(a) && tick(b)) || (tick(!a) && tick(!b))
      return calls * 10 + r as i32
    }
    export fn clamp(v: i32, lo: i32, hi: i32): i32 { return min(max(v, lo), hi) }
    export fn umax(a: u32, b: u32): u32 { return max(a, b) }
    export fn wide(a: i64, b: i64): i64 { return (a << 3 ^ b) / 7 + (a > b ? 1 : 0) as i64 - clz(b) }
    export fn copy(): i32 { memcopy(dst, &src[2], 4); memfill(&dst[4], 9, 3); return dst[0] + dst[3] * 10 + dst[6] * 100 + dst[7] * 1000 }
    export fn count(n: u32): u32 { let c: u32 = 0; let i: u32 = 0; while i < n { i += 1; if i % 3 == 0 { continue } c += i } return c }
    export fn nulls(): i32 { let e: ext = null; return isnull(e) as i32 + (isnull("s") ? 10 : 20) }
    export fn twice(v: f64): f64 { return 2.0 * v }
    export fn half(v: f64): f64 { return v / 2.0 }
    export fn eighth(v: f32): f32 { return (v + 0.0) / 8.0 }
    export fn third(v: f64): f64 { return v / 3.0 }
    export fn bits(v: u32): u32 { return popcnt(v) + ctz(v) * 100 + (~v >> 28) * 10000 }
  `)
  expect(x.compound(2, 12)).toBe((-5 + 12) * 3 + -300 + -7 + 3)
  expect([x.circuit(1, 1), x.circuit(1, 0), x.circuit(0, 0), x.circuit(0, 1)]).toEqual([21, 30, 31, 30])
  expect([x.clamp(5, 0, 3), x.clamp(-5, 0, 3), x.clamp(2, 0, 3)]).toEqual([3, 0, 2])
  expect(x.umax(-1, 5) >>> 0).toBe(0xffffffff)
  expect(x.wide(1000n, -3n)).toBe(((1000n << 3n) ^ -3n) / 7n + 1n - 0n)
  expect(x.copy()).toBe(3 + 6 * 10 + 9 * 100 + 0)
  let c = 0; for (let i = 1; i <= 100; i++) if (i % 3) c += i
  expect(x.count(100)).toBe(c)
  expect(x.nulls()).toBe(21)
  expect(x.bits(0x00f0)).toBe(4 + 400 + 15 * 10000)
  expect([x.twice(0.1), x.twice(-Infinity), x.half(0.3), x.half(5e-324), x.eighth(3), x.third(1)]).toEqual([0.2, -Infinity, 0.15, 5e-324 / 2, Math.fround(3 / 8), 1 / 3])
  expect(x.twice(NaN)).toBeNaN()
})

test('bindings are a static table, and missing APIs fail only when used', () => {
  const src = `
    extern fn no.such.thing(x: i32): i32
    extern fn Math.max(a: i32, b: i32): i32 as biggest
    extern val also.missing: ext
    extern fn Boolean(v: any): bool
    extern call String.toUpperCase(): ext
    export fn ok(): i32 { return biggest(3, 9) + (Boolean(missing) ? 100 : 0) }
    export fn shout(): ext { return toUpperCase("abc") }
    export fn bad(): i32 { return thing(1) }
  `
  const out = compile('m', { read: () => src })
  expect(out.table).toEqual(['globalThis.Math?.max||F', 'globalThis.Boolean||F', '(a)=>a.toUpperCase()', 'globalThis.no?.such?.thing||F', 'globalThis.also?.missing', '"abc"'])
  expect(out.bindings).not.toContain('eval')
  const x = instantiate(out.wasm, out.bindings).exports as any
  expect(x.ok()).toBe(9)
  expect(x.shout()).toBe('ABC')
  expect(() => x.bad()).toThrow('nib: missing binding')
})

test('memory builtins', () => {
  const x = run(`
    static pad: [u8; 100]
    export fn base(): i32 { return heap_base() }
    export fn pages(): i32 { return memory_pages() }
    export fn grow(n: i32): i32 { return memory_grow(n) }
    export fn poke(): i32 { pad[99] = 7; let p = (heap_base() + 70000) as *i32; p[0] = 5; return p[0] + pad[99] }
  `)
  expect(x.base()).toBe(128)
  expect(x.pages()).toBe(1)
  expect(x.grow(2)).toBe(1)
  expect(x.pages()).toBe(3)
  expect(x.poke()).toBe(12)
})
