// Every program here runs twice: compiled to Wasm, and imported as the plain TypeScript it is.
// The two must give identical results: that is the language's whole contract.

import { test, expect } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { compile } from '../nib/compiler.ts'
import { instantiate } from '../nib/loader.ts'

const TMP = `${import.meta.dir}/.tmp`
rmSync(TMP, { recursive: true, force: true })
let count = 0

async function both(src: string | Record<string, string>) {
  const files = typeof src === 'string' ? { 'main.ts': src } : src
  const dir = `${TMP}/${count++}`
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(`${dir}/${path}`), { recursive: true })
    writeFileSync(`${dir}/${path}`, text)
  }
  const out = compile(`${dir}/main.ts`, { read: p => readFileSync(p, 'utf8'), lib: `${import.meta.dir}/../lib`, debug: true })
  return { out, wasm: instantiate(out.wasm, out.glue), js: await import(`${dir}/main.ts`) }
}

/** Makes the same calls on both and expects the same answers. Returns the answers. */
async function same(src: string | Record<string, string>, calls: [string, ...any[]][]): Promise<any[]> {
  const { wasm, js } = await both(src)
  const plain = (v: any) => ArrayBuffer.isView(v) ? [...(v as any)] : v
  const results = calls.map(([f, ...args]) => plain(js[f](...args)))
  calls.forEach(([f, ...args], i) => expect([f, args, plain(wasm[f](...args))]).toEqual([f, args, results[i]]))
  return results
}
const fails = (src: string) => { try { compile('main.ts', { read: () => src }) } catch (e: any) { return e.message as string } return '' }

test('numbers mean what they mean in JavaScript', async () => {
  const r = await same(`
    import type { i32, u32 } from 'nib'
    export function mix(a: number, b: number): number { return a + b * 2 - (a - b) / 4 }
    export function ints(a: i32, b: i32): i32 { return a * b + (a - b) % 7 }
    export function divide(a: i32, b: i32): number { return a / b }
    export function truncated(a: i32, b: i32): i32 { return (a / b) | 0 }
    export function bits(a: number, b: i32): i32 { return (a | 0) ^ (b << 3) ^ (b >> 1) ^ ~b }
    export function unsigned(a: i32): u32 { return a >>> 0 }
    export function shifted(a: i32): number { return (a >>> 1) + 1 }
    export function wrap(x: number): i32 { return x | 0 }
    export function compare(a: i32, b: number): boolean { return a < b && a !== 3 || b >= 100 }
    export function negate(a: i32, b: number): number { return -a + -b }
    export function inferred(n: i32): number {
      let count = 0              // stays an integer
      let total = 0              // becomes a number at the first fractional value
      for (let i = 0; i < n; i++) { count += i; total += i / 3 }
      return count + total
    }
    export function hash(n: i32): u32 {
      let h = 2166136261 | 0
      for (let i = 0; i < n; i++) {
        h = Math.imul(h ^ i, 16777619)
        h = h ^ (h >>> 13)
        h = ((h << 7 | h >>> 25) + i) | 0
      }
      return h >>> 0
    }
    export function truthy(x: number, i: i32): i32 { return (x ? 1 : 0) + (i ? 10 : 0) + (!x ? 100 : 0) }
    const BIG = 2 ** 0.5 > 1 ? 7 / 2 : 0
    export function constants(): number { return BIG + 0x10 + 1e3 + 1_000 + (6 / 2) + (7 % 4) + (1 << 4) }
  `.replace('2 ** 0.5 > 1', 'Math.sqrt(2) > 1'), [
    ['mix', 1.5, 2.25], ['ints', 7, -3], ['ints', -7, 3], ['divide', 7, 2], ['divide', 1, 3], ['truncated', 7, 2], ['truncated', -7, 2],
    ['bits', 5.9, 3], ['bits', -5.9, -3], ['unsigned', -1], ['shifted', -1], ['wrap', 2 ** 31 + 5.5], ['wrap', -(2 ** 32) - 7.2], ['wrap', NaN], ['wrap', 1e15],
    ['compare', 1, 2.5], ['compare', 3, 2.5], ['compare', 3, 100], ['negate', 5, 2.5], ['negate', 0, 1],
    ['inferred', 10], ['hash', 1000], ['truthy', NaN, 0], ['truthy', 0.1, 5], ['truthy', 0, -1], ['constants'],
  ])
  expect(r[3]).toBe(3.5)
  expect(r[5]).toBe(3)
  expect(r[9]).toBe(4294967295)
  expect(r[20]).toBe(45 + 15)
})

test('Math', async () => {
  const src = `
    import type { i32 } from 'nib'
    export function round(x: number): number { return Math.round(x) }
    export function floor(x: number): number { return Math.floor(x) + Math.ceil(x) * 10 + Math.trunc(x) * 100 }
    export function abs(x: number, i: i32): number { return Math.abs(x) + Math.abs(i) }
    export function least(a: number, b: number, c: i32, d: i32): number { return Math.min(a, b) + Math.max(a, b, 3) * 10 + Math.min(c, d) * 100 + Math.max(c, d, 0) * 1000 }
    export function root(x: number): number { return Math.sqrt(x) }
    export function single(a: number, b: number): number { const x = Math.fround(a), y = Math.fround(b); return Math.fround(x * y) + Math.fround(x + y) + Math.fround(a) }
    export function leading(x: i32): i32 { return Math.clz32(x) ^ Math.imul(x, 0x7fffffff) }
    export function trig(x: number): number { return Math.sin(x) + Math.atan2(x, 2) + Math.pow(x, 3) + Math.hypot(x, 4) }
    const TABLE = Math.cos(Math.PI / 3) + Math.E
    export function constant(): number { return TABLE }
    export function floatMod(a: number, b: number): number { return a % b }
  `
  await same(src, [
    ...[0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994, 2.4, -2.6, 1e20, -0].map(x => ['round', x] as [string, number]),
    ['floor', 2.7], ['floor', -2.7], ['abs', -3.5, -9], ['abs', 3.5, 9], ['least', 1.5, -2, 7, -8], ['least', NaN, 1, 2, 2],
    ['root', 2], ['root', -1], ['single', 0.1, 0.7], ['leading', 1], ['leading', 0], ['leading', -5], ['trig', 0.3], ['constant'], ['floatMod', 7.5, 2], ['floatMod', -7.5, 2],
  ])
  // Math.cos ran in the compiler: the module calls into JavaScript only for trig() and floatMod()
  const { out } = await both(src)
  expect(out.glue.entries.filter(e => e !== 'M$').sort()).toEqual(['(a)=>Math.sin(a)', '(a)=>Math.atan2(a,2)', '(a)=>Math.pow(a,3)', '(a)=>Math.hypot(a,4)', '(a,b)=>a%b'].sort())
})

test('control flow', async () => {
  await same(`
    import type { i32 } from 'nib'
    export function collatz(n: i32): i32 {
      let steps = 0
      while (n !== 1) {
        if (n % 2 === 0) n = (n / 2) | 0
        else n = n * 3 + 1
        steps++
      }
      return steps
    }
    export function odds(n: i32): i32 {
      let s = 0
      for (let i = 0; i < n; i++) { if (i % 2 === 0) continue; s += i }
      return s
    }
    export function firstSquareOver(n: i32): i32 {
      let i = 0
      for (;;) { if (i * i > n) break; i++ }
      return i
    }
    export function nested(n: i32): i32 {
      let c = 0
      for (let i = 0; i < n; i++) {
        let j = 0
        while (j < i) { j++; if (j === 3) continue; if (j > 5) break; c++ }
      }
      return c
    }
    export function countdown(n: i32): i32 { let s = 0; do { s += n; n-- } while (n > 0); return s }
    export function steps(from: number, to: number): number { let s = 0; for (let x = from; x < to; x += 0.25) s += x; return s }
    export function backwards(n: i32): i32 { let s = 0; for (let i = n - 1; i >= 0; i -= 2) s = s * 3 + i; return s }
    export function sign(x: number): i32 { if (x < 0) return -1; else if (x === 0) return 0; return 1 }
    export function pick(x: i32, a: number, b: number): number { return x > 0 && x < 10 || x === 99 ? a : b }
    let calls = 0
    function tick(v: boolean): boolean { calls++; return v }
    export function circuit(a: boolean, b: boolean): i32 { calls = 0; const r = (tick(a) && tick(b)) || (tick(!a) && tick(!b)); return calls * 10 + (r ? 1 : 0) }
    export function post(n: i32): i32 { let i = n; const a = i++; const b = ++i; const c = i--; return a * 100 + b * 10 + c + i }
  `, [
    ['collatz', 27], ['odds', 10], ['firstSquareOver', 50], ['nested', 9], ['countdown', 4], ['countdown', 0], ['steps', 0.5, 3], ['backwards', 7],
    ['sign', -5], ['sign', 0], ['sign', 5], ['pick', 5, 1, 2], ['pick', 50, 1, 2], ['pick', 99, 1, 2],
    ['circuit', true, true], ['circuit', true, false], ['circuit', false, false], ['circuit', false, true], ['post', 5],
  ])
})

test('typed arrays are the memory', async () => {
  const { out } = await both(`export const N = 3`)
  expect(out.glue.pages).toBe(0)
  const r = await same(`
    import type { i32 } from 'nib'
    const STRIDE = 3
    export const points = new Float32Array(4 * STRIDE)
    const table = new Int32Array([10, 20, 30, 40])
    const bytes = new Uint8Array([1, 255, 3])
    const small = new Int8Array(4)
    const wide = new Float64Array(2)
    const words = new Uint16Array(4)
    const big = new Uint32Array(2)
    const squares = buildSquares()              // filled by the compiler
    function buildSquares(): Int32Array {
      const out = new Int32Array(8)
      for (let i = 0; i < out.length; i++) out[i] = i * i
      return out
    }
    export function fill(): number {
      for (let i = 0; i < 4; i++) {
        points[i * STRIDE] = i + 0.1
        points[i * STRIDE + 1] = 2
        points[i * STRIDE + 2] = i * 1000
      }
      return points[4] + points[9] + points.length
    }
    export function narrow(v: number): number {
      bytes[0] = v; small[1] = v; words[2] = v; big[1] = v; wide[1] = v; small[2] = 200
      return bytes[0] + small[1] * 10 + words[2] * 100 + big[1] * 1000 + wide[1] + small[2] + bytes[1]
    }
    export function look(i: i32): i32 { return table[i] + table[3] + squares[i + 4] + table.length }
    export function update(i: i32): number { points[i] += 1.5; points[i] *= 2; points[i + 1]++; return points[i] + points[i + 1] }
    export function walk(): i32 { let i = 0, s = 0; while (i < 4) s += table[i++] * i; return s }
    export function views(): number {
      const mid = points.subarray(3, 9), tail = mid.subarray(4)
      mid[0] = 77
      tail[1] = 88
      return points[3] + points[8] + mid.length * 100 + tail.length * 1000
    }
    export function bulk(): number {
      const a = new Float32Array(6), b = new Float32Array([1, 2, 3])
      a.fill(9)
      a.set(b, 2)
      a.copyWithin(0, 3, 5)
      a.subarray(5).fill(0.5)
      bytes.fill(7, 1)
      wide.fill(0)
      return a[0] + a[1] * 10 + a[2] * 100 + a[3] * 1000 + a[4] * 1e4 + a[5] * 1e5 + bytes[0] + bytes[2] + wide[1]
    }
    export function fresh(n: i32): number {
      const a = new Float64Array(n)
      for (let i = 0; i < a.length; i++) a[i] = i / 4
      return sumOf(a) + a.length
    }
    function sumOf(a: Float64Array): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }
  `, [['fill'], ['narrow', 300.7], ['narrow', -1.2], ['look', 1], ['update', 4], ['update', 4], ['walk'], ['views'], ['bulk'], ['fresh', 100], ['fresh', 70000]])
  expect(r[3]).toBe(20 + 40 + 25 + 4)
  // an exported array is the module's own memory, seen from JavaScript
  const { wasm } = await both(`export const shared = new Float32Array(4)\nexport function set(): void { shared[2] = 6.5 }`)
  wasm.set()
  expect([...wasm.shared]).toEqual([0, 0, 6.5, 0])
  wasm.shared[1] = 3
  expect(new Float32Array(wasm.memory.buffer, wasm.shared.byteOffset, 4)[1]).toBe(3)
})

test('objects with fixed fields are values', async () => {
  await same(`
    import type { i32 } from 'nib'
    interface V2 { readonly x: number; readonly y: number }
    type Box = { lo: V2, hi: V2, id: i32 }
    let total: V2 = { x: 1, y: 2 }
    function add(a: V2, b: V2): V2 { return { x: a.x + b.x, y: a.y + b.y } }
    function grow(b: Box, by: number): Box { return { lo: b.lo, hi: add(b.hi, { x: by, y: by }), id: b.id + 1 } }
    export function area(w: number, h: number): number {
      const b = grow({ lo: { x: 0, y: 0 }, hi: { x: w, y: h }, id: 7 }, 1)
      return (b.hi.x - b.lo.x) * (b.hi.y - b.lo.y) + b.id
    }
    export function accumulate(): number { total = add(total, { x: 10, y: 20 }); return total.x + total.y }
    export function choose(first: boolean): number { const v: V2 = first ? { x: 1, y: 2 } : add(total, total); return v.x * 10 + v.y }
    export function direct(): number { return add({ x: 1, y: 2 }, { x: 3, y: 4 }).y }
    export function pair(a: number): V2 { return add({ x: a, y: a }, { x: 1, y: 2 }) }
  `, [['area', 2, 3], ['accumulate'], ['accumulate'], ['choose', true], ['choose', false], ['direct'], ['pair', 5]])
})

test('functions: inlining, recursion, values and arrows', async () => {
  await same(`
    import type { i32 } from 'nib'
    function square(x: number): number { return x * x }
    /** @inline */
    function clamp(x: i32, lo: i32, hi: i32): i32 { if (x < lo) return lo; if (x > hi) return hi; return x }
    function power(x: i32, n: i32): i32 { return n === 0 ? 1 : x * power(x, n - 1) }
    const K = square(3) + 1
    export function a(x: number): number { return square(x + 1) + K }
    export function b(x: i32): i32 { return clamp(x, 0, 10) + clamp(x * 2, -5, 5) }
    export function c(x: i32): i32 { return power(x, 5) }
    export function unrolled(): i32 { let s = 0; for (let i = 0; i < 4; i++) s += power(2, i); return s }

    type Op = (a: number, b: number) => number
    function plus(a: number, b: number): number { return a + b }
    function times(a: number, b: number): number { return a * b }
    let current: Op = plus
    function apply(f: Op, x: number): number { return f(x, 3) + f(1, x) }
    export function values(mul: boolean, x: number): number {
      current = mul ? times : plus
      const local = current
      return apply(current, x) + local(2, 2) + apply((p: number, q: number): number => p - q, x)
    }
    /** @inline */
    function twice(f: (x: number) => number, x: number): number { return f(f(x)) }
    export function direct(x: number): number { return twice(square, x) }
  `, [['a', 2], ['b', -3], ['b', 4], ['b', 40], ['c', 3], ['unrolled'], ['values', true, 5], ['values', false, 5], ['direct', 3]])
})

test('f32x4', async () => {
  await same(`
    import { f32x4 } from 'nib'
    const m = new Float32Array(16), out = new Float32Array(16)
    const TENTH = f32x4.splat(0.1)
    function mul(o: Float32Array, a: Float32Array, b: Float32Array): void {
      const a0 = f32x4.load(a, 0), a1 = f32x4.load(a, 4), a2 = f32x4.load(a, 8), a3 = f32x4.load(a, 12)
      for (let j = 0; j < 16; j += 4) {
        const c = f32x4.load(b, j)
        f32x4.store(o, j, f32x4.add(f32x4.add(f32x4.mul(a0, f32x4.splat(c.x)), f32x4.mul(a1, f32x4.splat(c.y))), f32x4.add(f32x4.mul(a2, f32x4.splat(c.z)), f32x4.mul(a3, f32x4.splat(c.w)))))
      }
    }
    export function go(s: number): number {
      for (let i = 0; i < 4; i++) f32x4.store(m, i * 4, f32x4(s, i, 0.3, 1))
      f32x4.store(m, 12, f32x4.sub(f32x4(1, 2, 3, 4), f32x4.mul(TENTH, f32x4(0, 0, 0, 2))))
      mul(out, m, m)
      const v = f32x4.sqrt(f32x4.abs(f32x4.neg(f32x4.load(out, 12))))
      const w = f32x4.div(f32x4.max(f32x4.load(out, 0), f32x4.load(out, 4)), f32x4.min(v, f32x4.splat(s)))
      return v.x + v.y + v.z + v.w + w.y + out[5]
    }
    export function lanes(): Float32Array { return out }
  `, [['go', 2], ['go', 0.37], ['lanes']])
})

test('JavaScript values: strings, objects, calls and callbacks', async () => {
  const g = globalThis as any
  const run = async (which: 'wasm' | 'js') => {
    const log: any[] = []
    g.host = {
      log, count: 2, label: 'ab', nothing: null,
      box: { width: 12.5, name: 'box', tags: ['x', 'y'], add(a: number, b: number) { return a + b }, child: { depth: 3 } },
      emit(...xs: any[]) { log.push(xs.length === 1 ? xs[0] : xs) },
      later(f: (v: number) => void) { g.host.pending = f },
      order(tag: string) { log.push(tag); return { then(v: number) { log.push(['then', v]) } } },
    }
    return { m: (await both(src))[which], log }
  }
  const src = `
    import type { i32 } from 'nib'
    declare const host: any
    interface V2 { readonly x: number; readonly y: number }
    const squares = new Float32Array([1, 4, 9])
    let seen = 0
    let greeting = 'hi'
    function note(v: number): void { seen = v * 2 }
    function bump(): number { seen++; return seen }
    export function strings(n: i32, name: string): string { return 'n=' + n + ', ' + name.toUpperCase() + \`/\${n * 2}:\${host.label}\` + greeting }
    export function numbers(): number {
      const w: number = host.box.width
      const whole: i32 = host.box.width | 0
      const boxed = host.count                       // stays a JavaScript value until a number is needed
      return w * 2 + whole + boxed * 10 + host.box.add(w, 1) + host.box.tags.length
    }
    export function objects(k: i32, v: V2): void {
      host.emit({ kind: 'point', at: [k, k + 1], size: v, big: 4000000000, flags: { on: true, off: k > 5 }, 'needs-quotes': null })
      host.emit(squares, squares.subarray(1), v)
      host.box.width = k * 1.5
      host.box.child.depth += k
      host.count++
      host.emit(host.box.width, host.box.child.depth, host.count)
    }
    export function choices(k: i32): number {
      const missing = host.nothing?.deep?.value ?? 'fallback'
      const kind = typeof host.box === 'object' ? 1 : 0
      const present: boolean = host.box.child
      const absent = !host.nothing
      host.emit(missing, k > 2 ? 'big' : host.label, host.nothing === null, host.box !== undefined)
      return kind + (present ? 10 : 0) + (absent ? 100 : 0) + (host.box.tags[1] === 'y' ? 1000 : 0)
    }
    export function callbacks(): void {
      host.later(note)
      host.emit(new Map([[1, 'one']]).get(1), new Date(86400000).getUTCDate(), parseInt('ff', 16), [3, 1, 2].map((x: number): number => x * 10).join('-'))
    }
    export function ordered(): void { host.order('first').then(bump()) }          // JavaScript's order: the call, then bump()
    export function seenNow(): number { return seen }
  `
  const drive = async (which: 'wasm' | 'js') => {              // one at a time: both read the same global
    const { m, log } = await run(which)
    log.push(m.strings(7, 'ann'), m.numbers())
    m.objects(3, { x: 1.5, y: -2 })
    log.push(m.choices(1), m.choices(9))
    m.callbacks()
    g.host.pending(21)
    log.push(m.seenNow())
    m.ordered()
    log.push(m.seenNow())
    return { log }
  }
  const js = await drive('js')
  const wasm = await drive('wasm')
  const plain = (v: any): any => ArrayBuffer.isView(v) ? [...(v as any)] : Array.isArray(v) ? v.map(plain) : v
  expect(wasm.log.map(plain)).toEqual(js.log.map(plain))
  expect(js.log[0]).toBe('n=7, ANN/14:abhi')
  expect(js.log.at(-3)).toEqual('first')
  expect(js.log.at(-1)).toBe(43)
})

test('bindings are written by the compiler, fused and with constants inside', async () => {
  const { out } = await both(`
    declare const gpu: any
    let device: any
    export function buffer(n: number): unknown {
      return device.createBuffer({ size: n * 4, usage: 72, label: 'vertices' })
    }
    export function view(): unknown { return gpu.context.getCurrentTexture().createView() }
    export function missing(): number { return thereIsNoSuchGlobal.value }
    declare const thereIsNoSuchGlobal: any
  `)
  expect(out.glue.entries).toEqual([
    '(a,b)=>a.createBuffer({size:b,usage:72,label:"vertices"})',
    '()=>gpu.context.getCurrentTexture().createView()',
    '()=>thereIsNoSuchGlobal.value',
  ])
  const m = instantiate(out.wasm, out.glue)                 // a missing global fails when it is used, not at load
  expect(() => m.missing()).toThrow('thereIsNoSuchGlobal')
})

test('modules, the library, text imports and startup order', async () => {
  const g = globalThis as any
  const files = {
    'main.ts': `
      import { sin, cos, random, randomSeed, quatSpin, mat4FromQuat, mat4Mul, mat4Perspective, mat4LookAt, type Quat } from 'nib/math'
      import { twice, LIMIT, counter, bump } from './lib/util.ts'
      import shader from './note.wgsl' with { type: 'text' }
      declare const trace: string[]
      export const SIZE = LIMIT * 2
      export const matrices = new Float32Array(48)
      const FOCAL = 1 / Math.tan(0.4)                          // computed by the compiler
      let rotation: Quat = { x: 0, y: 0, z: 0, w: 1 }
      trace.push('main starts, util counter is ' + counter)
      const startedAt = trace.length                            // needs the page: set at startup
      export function trig(x: number): number { return sin(x) * 1000 + cos(x) }
      export function dice(seed: number): number { randomSeed(seed); return random() + random() * 10 + random() * 100 }
      export function spin(steps: number): Float32Array {
        for (let i = 0; i < steps; i++) rotation = quatSpin(rotation, 0.5, 1.1, 0.3, 0.016)
        mat4FromQuat(matrices.subarray(16, 32), rotation)
        mat4Perspective(matrices.subarray(32, 48), FOCAL, 1.5, 0.1, 100)
        mat4LookAt(matrices, 0, 3, 5, 0, 0, 0)
        mat4Mul(matrices, matrices.subarray(32, 48), matrices)
        mat4Mul(matrices, matrices, matrices.subarray(16, 32))
        return matrices
      }
      export function misc(): number { bump(); return twice(SIZE) + counter + shader.length + startedAt }
      export function text(): string { return shader }
    `,
    'lib/util.ts': `
      declare const trace: string[]
      export const LIMIT = 21
      export let counter = 5
      export function twice(x: number): number { return x * 2 }
      export function bump(): void { counter++ }
      function unused(): number { return notCompiledSoNotChecked() }
      declare function notCompiledSoNotChecked(): number
      trace.push('util starts')
    `,
    'note.wgsl': '// a comment\nfn main() -> f32 {\n  return 1.0;\n}\n',
  }
  g.trace = []
  const { wasm, js, out } = await both(files)             // each one runs its top level once, imports first
  expect(g.trace).toEqual(['util starts', 'main starts, util counter is 5', 'util starts', 'main starts, util counter is 5'])
  for (const x of [0, 0.5, -2, 100.25, 1e6]) expect(wasm.trig(x)).toBe(js.trig(x))
  expect(Math.abs(js.trig(1) - (Math.sin(1) * 1000 + Math.cos(1)))).toBeLessThan(1e-6)
  expect(wasm.dice(42)).toBe(js.dice(42))
  expect([...wasm.spin(100)]).toEqual([...js.spin(100)])
  expect(wasm.misc()).toBe(js.misc())
  expect([wasm.SIZE, wasm.matrices.length, wasm.text()]).toEqual([42, 48, files['note.wgsl']])
  expect(out.files.map(f => f.replace(/.*\/(lib|\d+)\//, '$1/'))).toContain('lib/math.ts')
})

test('errors point at the source', () => {
  expect(fails('export function a(): i32 { return 1.5 }')).toContain('main.ts:1:35: expected i32, found number: write `| 0` to truncate')
  expect(fails('export function a(x: number): i32 { return x }')).toContain('expected i32, found number')
  expect(fails('export function a(x: i32): f32 { return x / 3 }')).toContain('write Math.fround(...)')
  expect(fails('export function a(x: number) { return x }')).toContain("function 'a' needs a return type")
  expect(fails('export function a(): void { const p = { x: 1 }; let q: { x: number } = { x: 2 }; q.x = 3 }')).toContain('objects are values here')
  expect(fails('const A: number = A + 1\nexport function a(): number { return A }')).toContain('depends on itself')
  expect(fails('export function a(): void { break }')).toContain('break outside a loop')
  expect(fails('export function a(): void {\n  let x = \n}')).toContain("main.ts:3:1: unexpected '}'")
  expect(fails('function make(n: number): () => number { return () => n }\nexport function a(): number { return make(1)() }')).toContain('closures are not supported')
  expect(fails('class A {}')).toContain("'class' is not supported")
  expect(fails('export function a(xs: number[]): void { for (const x of xs) {} }')).toContain('for...of')
  expect(fails('export const a = document.title')).toContain("'a' cannot be exported to JavaScript")
})
