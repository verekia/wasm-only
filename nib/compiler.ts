// Nib → WebAssembly. One pass from AST to bytes: type checking, constant folding, inlining and
// struct scalarisation all happen while emitting. Nothing is compiled unless an export reaches it.

import { parse, walk, fail, type File } from './syntax.ts'
import { runtime } from './loader.ts'

// ---------------------------------------------------------------- types

const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c, V128 = 0x7b, FUNC = 0x70, EXT = 0x6f

interface Field { name: string; t: Type; off: number; slot: number }
interface Type {
  name: string
  kind: 'int' | 'float' | 'bool' | 'ext' | 'func' | 'vec' | 'struct' | 'ptr' | 'void' | 'lit'
  w: number                             // wasm value type (scalars only)
  size: number; align: number           // layout in linear memory
  signed: boolean
  flat: number[]                        // the wasm values this type occupies
  leaves: { t: Type; off: number }[]    // its scalars, with their memory offsets
  fields?: Field[]; to?: Type; ptr?: Type
}

function prim(name: string, kind: Type['kind'], w: number, size: number, signed = false): Type {
  const t: Type = { name, kind, w, size, align: size || 1, signed, flat: [w], leaves: [] }
  t.leaves = [{ t, off: 0 }]
  return t
}
const T = {
  i32: prim('i32', 'int', I32, 4, true), u32: prim('u32', 'int', I32, 4),
  i64: prim('i64', 'int', I64, 8, true), u64: prim('u64', 'int', I64, 8),
  i8: prim('i8', 'int', I32, 1, true), u8: prim('u8', 'int', I32, 1),
  i16: prim('i16', 'int', I32, 2, true), u16: prim('u16', 'int', I32, 2),
  f32: prim('f32', 'float', F32, 4), f64: prim('f64', 'float', F64, 8),
  bool: prim('bool', 'bool', I32, 1),
  ext: prim('ext', 'ext', EXT, 0), func: prim('func', 'func', FUNC, 0),
  f32x4: prim('f32x4', 'vec', V128, 16),
}
const VOID: Type = { name: 'void', kind: 'void', w: 0, size: 0, align: 1, signed: false, flat: [], leaves: [] }
const INT: Type = { ...VOID, name: 'integer literal', kind: 'lit' }      // untyped literals adapt to
const FLOAT: Type = { ...VOID, name: 'float literal', kind: 'lit' }      // whatever they meet

const ptrTo = (t: Type): Type => t.ptr ??= { ...prim('*' + t.name, 'ptr', I32, 4), to: t }
/** u8/i8/u16/i16 exist only in memory; as values they are i32. */
const valueType = (t: Type): Type => t.kind === 'int' && t.size < 4 ? T.i32 : t

// ---------------------------------------------------------------- encoding

type Code = (number | Func | Glob)[]     // bytes, plus references resolved once indices are final
interface Func { idx: number; type: number; name: string; imp?: [string, string]; exp?: string; locals: number[]; code: Code }
interface Glob { idx: number; w: number; mut: boolean; imp?: [string, string]; init: Code }

function uleb(n: number, out: number[] = []): number[] {
  do { const b = n & 0x7f; n >>>= 7; out.push(n ? b | 0x80 : b) } while (n)
  return out
}
function sleb(n: number | bigint): number[] {
  const out: number[] = []
  for (let v = BigInt(n); ;) {
    const b = Number(v & 0x7fn); v >>= 7n
    if ((v === 0n && !(b & 0x40)) || (v === -1n && b & 0x40)) { out.push(b); return out }
    out.push(b | 0x80)
  }
}
const scratch = new DataView(new ArrayBuffer(8))
const f32bytes = (x: number) => (scratch.setFloat32(0, x, true), [0, 1, 2, 3].map(i => scratch.getUint8(i)))
const f64bytes = (x: number) => (scratch.setFloat64(0, x, true), [0, 1, 2, 3, 4, 5, 6, 7].map(i => scratch.getUint8(i)))
const utf8 = new TextEncoder()
const name = (s: string) => { const b = utf8.encode(s); return [...uleb(b.length), ...b] }
const simd = (op: number) => [0xfd, ...uleb(op)]
const localGet = (i: number) => [0x20, ...uleb(i)]

const loadOp = (t: Type) => t.w === F32 ? [0x2a] : t.w === F64 ? [0x2b] : t.w === I64 ? [0x29] : t.w === V128 ? [0xfd, 0]
  : t.size === 4 ? [0x28] : t.size === 2 ? [t.signed ? 0x2e : 0x2f] : [t.signed ? 0x2c : 0x2d]
const storeOp = (t: Type) => t.w === F32 ? [0x38] : t.w === F64 ? [0x39] : t.w === I64 ? [0x37] : t.w === V128 ? [0xfd, 0x0b]
  : t.size === 4 ? [0x36] : t.size === 2 ? [0x3b] : [0x3a]
const memarg = (t: Type, off: number) => [Math.log2(t.size), ...uleb(off)]

// Opcodes for i32 and f32; the i64 and f64 forms sit at fixed distances. Pairs are [signed, unsigned].
const INT_OPS: Record<string, number | [number, number]> = {
  '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': [0x6d, 0x6e], '%': [0x6f, 0x70], '&': 0x71, '|': 0x72, '^': 0x73,
  '<<': 0x74, '>>': [0x75, 0x76], '==': 0x46, '!=': 0x47, '<': [0x48, 0x49], '>': [0x4a, 0x4b], '<=': [0x4c, 0x4d], '>=': [0x4e, 0x4f],
}
const FLOAT_OPS: Record<string, number> = {
  '+': 0x92, '-': 0x93, '*': 0x94, '/': 0x95, '==': 0x5b, '!=': 0x5c, '<': 0x5d, '>': 0x5e, '<=': 0x5f, '>=': 0x60,
}
const VEC_OPS: Record<string, number> = { '+': 0xe4, '-': 0xe5, '*': 0xe6, '/': 0xe7 }
const COMPARE = new Set(['==', '!=', '<', '>', '<=', '>='])
const roundEven = (x: number) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r }
// name → [f32 opcode, f32x4 opcode, JS equivalent for folding]
const FLOAT_FNS: Record<string, [number, number, (x: number) => number]> = {
  abs: [0x8b, 0xe0, Math.abs], ceil: [0x8d, 0x67, Math.ceil], floor: [0x8e, 0x68, Math.floor],
  trunc: [0x8f, 0x69, Math.trunc], round: [0x90, 0x6a, roundEven], sqrt: [0x91, 0xe3, Math.sqrt],
}
const BIT_FNS: Record<string, number> = { clz: 0x67, ctz: 0x68, popcnt: 0x69 }
const LANES = 'xyzw'
const param = (i: number) => i < 26 ? String.fromCharCode(97 + i) : 'a' + i          // names for generated JS parameters

function fold(op: string, t: Type, a: any, b: any): any {
  if (typeof a !== 'number' || typeof b !== 'number') return undefined
  const int = t.kind !== 'float' && t !== FLOAT
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return int && t !== INT ? Math.imul(a, b) : a * b
    case '/': return !int ? a / b : b === 0 || (a === -(2 ** 31) && b === -1) ? undefined : Math.trunc(a / b)
    case '%': return int && b !== 0 ? a % b : undefined
    case '&': return int ? a & b : undefined
    case '|': return int ? a | b : undefined
    case '^': return int ? a ^ b : undefined
    case '<<': return int ? a << (b & 31) : undefined
    case '>>': return int ? (t.signed || t === INT ? a >> (b & 31) : a >>> (b & 31)) : undefined
    case '==': return a === b
    case '!=': return a !== b
    case '<': return a < b
    case '>': return a > b
    case '<=': return a <= b
    case '>=': return a >= b
  }
}

const minifyWgsl = (s: string) =>
  s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}();,:=+*<>]) ?/g, '$1').trim()

const dirname = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'
function join(dir: string, rel: string): string {
  const out: string[] = []
  for (const part of (rel.startsWith('/') ? rel : dir + '/' + rel).split('/')) {
    if (part === '..' && out.length && out.at(-1) !== '..' && out.at(-1) !== '') out.pop()
    else if (part !== '.' && (part !== '' || !out.length)) out.push(part)
  }
  return out.join('/') || '.'
}

// ---------------------------------------------------------------- program

export interface Options {
  /** Reads a source file. */
  read(path: string): string
  /** Directory that `import "std/..."` resolves to. */
  std?: string
  /** Emit a name section so stack traces and profiles show function names. */
  debug?: boolean
}

interface Val { t: Type; c: Code; k?: any; ks?: any[]; pure?: boolean }
type Place = { t: Type; pre?: Code } & (
  | { p: 'loc'; i: number; scaled?: Map<number, number> }      // scaled: a for-loop counter's pre-multiplied copies
  | { p: 'glob'; g: Glob[]; o: number }
  | { p: 'mem'; base: Val; off: number }
  | { p: 'const'; ks: any[]; o: number })

/** Everything shared between compilation units: sources, declarations, resolved types, constants. */
class Program {
  decls = new Map<string, any>()
  files: string[] = []
  host?: WebAssembly.Imports
  opts: Options
  private addrs = new Map<any, number>()
  comptime = new Map<any, { t: Type; ks: any[] }>()
  top = 16                               // next free static address; address 0 stays unused
  constructor(opts: Options) { this.opts = opts }

  load(path: string, from?: { file: File; pos: number }): void {
    if (this.files.includes(path)) return
    let src: string
    try { src = this.opts.read(path) } catch { return fail(`cannot read '${path}'`, from) }
    this.files.push(path)
    const file = { path, src }, ast = parse(file)
    for (const imp of ast.imports) {
      const p = imp.path.startsWith('std/') ? join(this.opts.std ?? 'std', imp.path.slice(4)) : join(dirname(path), imp.path)
      this.load(/\.\w+$/.test(p) ? p : p + '.nib', { file, pos: imp.pos })
    }
    for (const d of ast.decls) {
      if (this.decls.has(d.name)) fail(`'${d.name}' is already declared`, { file, pos: d.pos })
      d.file = file
      this.decls.set(d.name, d)
    }
  }

  type(n: any, file: File): Type {
    if (n.n === 'tptr') return ptrTo(this.type(n.to, file))
    const p = (T as Record<string, Type>)[n.name]
    if (p) return p
    const d = this.decls.get(n.name)
    if (d?.n !== 'struct') fail(`unknown type '${n.name}'`, { file, pos: n.pos })
    return this.struct(d)
  }

  struct(d: any): Type {
    if (d.type) return d.type
    if (d.busy) fail(`struct '${d.name}' contains itself`, { file: d.file, pos: d.pos })
    d.busy = true
    const t: Type = { name: d.name, kind: 'struct', w: 0, size: 0, align: 1, signed: false, flat: [], leaves: [], fields: [] }
    for (const f of d.fields) {
      const ft = this.type(f.t, d.file)
      if (!ft.size) fail(`a struct field cannot be ${ft.name}`, { file: d.file, pos: d.pos })
      const off = (t.size + ft.align - 1) & -ft.align
      t.fields!.push({ name: f.name, t: ft, off, slot: t.leaves.length })
      for (const l of ft.leaves) t.leaves.push({ t: l.t, off: off + l.off })
      t.size = off + ft.size
      t.align = Math.max(t.align, ft.align)
    }
    t.size = (t.size + t.align - 1) & -t.align
    t.flat = t.leaves.map(l => l.t.w)
    return d.type = t
  }

  sig(d: any): { params: Type[]; ret: Type } {
    return d.sig ??= {
      params: d.params.map((p: any) => valueType(this.type(p.t, d.file))),
      ret: d.ret ? valueType(this.type(d.ret, d.file)) : VOID,
    }
  }

  /** Evaluates an expression at compile time. Whatever does not fold is compiled and run right here. */
  evalConst(e: any, file: File, want?: Type): { t: Type; ks: any[] } {
    const u = new Unit(this)
    u.file = file
    let v = u.expr(e)
    if (want) v = u.coerce(v, want, e)
    if (v.ks) return { t: v.t, ks: v.ks }
    if (v.k !== undefined) return { t: v.t, ks: [v.k] }
    let r: any
    try { r = (u.run(v).__ct as Function)() } catch (err: any) { return fail(`compile-time evaluation failed: ${err.message}`, { file, pos: e.pos }) }
    const ks = v.t.flat.length === 1 ? [r] : [...(r ?? [])]
    v.t.leaves.forEach((l, i) => {
      if (l.t === T.ext && typeof ks[i] !== 'string') fail('a compile-time ext value must be a string', { file, pos: e.pos })
      if (l.t.w === I32 && !l.t.signed) ks[i] >>>= 0
    })
    return { t: v.t, ks }
  }

  constOf(d: any): { t: Type; ks: any[] } {
    if (d.val) return d.val
    if (d.busy) fail(`constant '${d.name}' depends on itself`, { file: d.file, pos: d.pos })
    d.busy = true
    return d.val = this.evalConst(d.e, d.file, d.t && valueType(this.type(d.t, d.file)))
  }

  varInfo(d: any): { t: Type; ks?: any[] } {
    if (d.info) return d.info
    const want = d.t && valueType(this.type(d.t, d.file))
    if (!d.e) return d.info = { t: want }
    const v = this.evalConst(d.e, d.file, want)
    const t = v.t === INT ? T.i32 : v.t === FLOAT ? T.f32 : v.t
    return d.info = { t, ks: v.ks }
  }

  /** A static's address. One address space serves every unit, so pointers computed at compile time stay valid. */
  addr(d: any): number {
    let a = this.addrs.get(d)
    if (a === undefined) {
      const s = this.staticInfo(d)
      a = (this.top + s.el.align - 1) & -s.el.align
      this.top = a + s.size
      this.addrs.set(d, a)
    }
    return a
  }

  staticInfo(d: any): { el: Type; size: number; data?: Uint8Array } {
    if (d.info) return d.info
    const el = this.type(d.el, d.file), at = { file: d.file, pos: d.pos }
    if (!el.size) fail(`a static cannot hold ${el.name}`, at)
    const count = Number(this.evalConst(d.count, d.file, T.i32).ks[0])
    const info = d.info = { el, size: el.size * count, data: undefined as Uint8Array | undefined }
    if (d.init?.items) {
      if (el.leaves.length !== 1 || el.w === V128) fail('a list initializer needs a scalar element type', at)
      if (d.init.items.length > count) fail(`too many initializers for [${el.name}; ${count}]`, at)
      const data = new Uint8Array(info.size), dv = new DataView(data.buffer)
      d.init.items.forEach((e: any, i: number) => {
        const k = this.evalConst(e, d.file, el).ks[0], o = i * el.size
        if (el.w === F32) dv.setFloat32(o, k, true)
        else if (el.w === F64) dv.setFloat64(o, k, true)
        else if (el.w === I64) dv.setBigInt64(o, BigInt(k), true)
        else if (el.size === 4) dv.setInt32(o, k, true)
        else if (el.size === 2) dv.setInt16(o, k, true)
        else dv.setInt8(o, k)
      })
      info.data = data
    } else if (d.init) {            // `= comptime f`: run f(pointer) now and keep the bytes it wrote
      const f = this.decls.get(d.init.fn)
      if (f?.n !== 'fn' || f.params.length !== 1) fail(`'${d.init.fn}' must be a function taking the pointer to fill`, at)
      const u = new Unit(this)
      u.file = d.file
      const addr = u.addr(d)
      try {
        const ex = u.run({ t: VOID, c: [0x41, ...sleb(addr), 0x10, u.fn(f)] })
        ;(ex.__ct as Function)()
        info.data = new Uint8Array((ex.memory as WebAssembly.Memory).buffer, addr, info.size).slice()
      } catch (err: any) { fail(`compile-time evaluation failed: ${err.message}`, at) }
    }
    return info
  }
}

// ---------------------------------------------------------------- unit

/** One WebAssembly module under construction. */
class Unit {
  private typeKeys = new Map<string, number>()
  private typeDefs: number[][] = []
  private fimports = new Map<string, Func>()
  private gimports = new Map<string, Glob>()
  private funcs: Func[] = []
  private globals: Glob[] = []
  private fnOf = new Map<any, Func>()
  private globOf = new Map<any, Glob[]>()
  private statics = new Set<any>()
  private segs: { addr: number; bytes: Uint8Array }[] = []
  private elems = new Set<Func>()
  private queue: any[] = []
  private usesMem = false

  // state of the function being compiled
  file!: File
  private locals: number[] = []
  private nparam = 0
  private scopes: Map<string, Place>[] = [new Map()]
  private depth = 0                      // enclosing wasm labels
  private loops: { brk: number; cont: number }[] = []
  private ret: Type = VOID
  private inl: { depth: number } | null = null
  private inlining = 0

  P: Program
  constructor(program: Program) { this.P = program }

  private err(msg: string, n: any): never { return fail(msg, { file: this.file, pos: n.pos }) }

  // ---- module-level entities

  private functype(params: number[], results: number[]): number {
    const key = params.join() + '>' + results.join()
    let i = this.typeKeys.get(key)
    if (i === undefined) {
      this.typeKeys.set(key, i = this.typeDefs.length)
      this.typeDefs.push([0x60, ...uleb(params.length), ...params, ...uleb(results.length), ...results])
    }
    return i
  }
  private blockType(t: Type): number[] {
    return t.flat.length === 0 ? [0x40] : t.flat.length === 1 ? t.flat : sleb(this.functype([], t.flat))
  }
  private imp(mod: string, field: string, params: number[], results: number[]): Func {
    const type = this.functype(params, results), key = `${mod}\0${field}\0${type}`
    let f = this.fimports.get(key)
    if (!f) this.fimports.set(key, f = { idx: 0, type, name: field, imp: [mod, field], locals: [], code: [] })
    return f
  }
  private gimp(mod: string, field: string, w: number): Glob {
    const key = `${mod}\0${field}\0${w}`
    let g = this.gimports.get(key)
    if (!g) this.gimports.set(key, g = { idx: 0, w, mut: false, imp: [mod, field], init: [] })
    return g
  }
  private str(s: string): Val { return { t: T.ext, c: [0x23, this.gimp('str', s, EXT)], k: s, pure: true } }

  fn(d: any): Func {
    let f = this.fnOf.get(d)
    if (!f) {
      const sig = this.P.sig(d)
      f = { idx: 0, type: this.functype(sig.params.flatMap(t => t.flat), sig.ret.flat), name: d.name, locals: [], code: [] }
      if (d.exported) f.exp = d.name
      this.fnOf.set(d, f)
      this.funcs.push(f)
      this.queue.push(d)
    }
    return f
  }
  private globalsOf(d: any): Glob[] {
    let g = this.globOf.get(d)
    if (!g) {
      const { t, ks } = this.P.varInfo(d)
      g = t.leaves.map((l, i) => ({ idx: 0, w: l.t.w, mut: true, init: this.kval(l.t, ks ? ks[i] : l.t.w === V128 ? [0, 0, 0, 0] : l.t.w === I64 ? 0n : l.t.w === EXT || l.t.w === FUNC ? null : 0).c }))
      this.globals.push(...g)
      this.globOf.set(d, g)
    }
    return g
  }
  addr(d: any): number {
    const a = this.P.addr(d)
    if (!this.statics.has(d)) {
      this.statics.add(d)
      this.usesMem = true
      const data = this.P.staticInfo(d).data
      if (data) this.segs.push({ addr: a, bytes: data })
    }
    return a
  }

  // ---- values

  private kval(t: Type, k: any): Val {
    if (t.kind === 'lit') return { t, c: [], k, pure: true }
    switch (t.w) {
      case I32: k = t.kind === 'bool' ? +!!k : t.signed ? k | 0 : k >>> 0; return { t, c: [0x41, ...sleb(k | 0)], k, pure: true }
      case I64: k = BigInt.asIntN(64, BigInt(k)); return { t, c: [0x42, ...sleb(k)], k, pure: true }
      case F32: k = Math.fround(k); return { t, c: [0x43, ...f32bytes(k)], k, pure: true }
      case F64: return { t, c: [0x44, ...f64bytes(k)], k, pure: true }
      case V128: return { t, c: [0xfd, 0x0c, ...k.flatMap(f32bytes)], k, pure: true }
      case EXT: return typeof k === 'string' ? this.str(k) : { t, c: [0xd0, EXT], k: null, pure: true }
      default: return { t, c: [0xd0, FUNC], k: null, pure: true }
    }
  }
  private alloc(t: Type): number {
    const i = this.nparam + this.locals.length
    this.locals.push(...t.flat)
    return i
  }
  private sets(i: number, n: number): Code {
    const c: Code = []
    for (let j = n - 1; j >= 0; j--) c.push(0x21, ...uleb(i + j))
    return c
  }
  /** Moves a value into fresh locals so it can be read any number of times. */
  private spill(v: Val): Place {
    if (v.ks) return { p: 'const', t: v.t, ks: v.ks, o: 0 }
    if (v.k !== undefined) return { p: 'const', t: v.t, ks: [v.k], o: 0 }
    const i = this.alloc(v.t)
    return { p: 'loc', t: v.t, i, pre: [...v.c, ...this.sets(i, v.t.flat.length)] }
  }
  /** Splits a value into run-once code and a cheap, repeatable read. */
  private stable(v: Val): [Code, Val] {
    if (v.pure && v.c.length <= 8) return [[], v]
    const i = this.alloc(v.t)
    return [[...v.c, 0x21, ...uleb(i)], { t: v.t, c: localGet(i), pure: true }]
  }

  private load(pl: Place): Val {
    const pre = pl.pre ?? [], n = pl.t.flat.length
    switch (pl.p) {
      case 'const': {
        if (pl.t.kind === 'lit' || pl.t.leaves.length === 1) return this.kval(pl.t, pl.ks[pl.o])
        const ks = pl.ks.slice(pl.o, pl.o + n)
        return { t: pl.t, c: ks.flatMap((k, i) => this.kval(pl.t.leaves[i].t, k).c), ks, pure: true }
      }
      case 'loc': {
        const c = [...pre]
        for (let j = 0; j < n; j++) c.push(...localGet(pl.i + j))
        return { t: pl.t, c, pure: !pre.length }
      }
      case 'glob': {
        const c = [...pre]
        for (let j = 0; j < n; j++) c.push(0x23, pl.g[pl.o + j])
        return { t: pl.t, c, pure: !pre.length }
      }
      case 'mem': {
        const ls = pl.t.leaves
        const [once, base] = ls.length > 1 ? this.stable(pl.base) : [[], pl.base]
        const c = [...pre, ...once]
        for (const l of ls) c.push(...base.c, ...loadOp(l.t), ...memarg(l.t, pl.off + l.off))
        return { t: valueType(pl.t), c }
      }
    }
  }

  private store(pl: Place, v: Val, n: any): Code {
    const pre = pl.pre ?? [], count = pl.t.flat.length
    switch (pl.p) {
      case 'const': return this.err('cannot assign to a constant', n)
      case 'loc': return [...pre, ...v.c, ...this.sets(pl.i, count)]
      case 'glob': {
        const c = [...pre, ...v.c]
        for (let j = count - 1; j >= 0; j--) c.push(0x24, pl.g[pl.o + j])
        return c
      }
      case 'mem': {
        const ls = pl.t.leaves
        if (ls.length === 1) return [...pre, ...pl.base.c, ...v.c, ...storeOp(ls[0].t), ...memarg(ls[0].t, pl.off)]
        const src = this.spill(v), [once, base] = this.stable(pl.base)
        const c = [...pre, ...(src.pre ?? []), ...once]
        ls.forEach((l, j) => {
          const leaf: Place = src.p === 'loc' ? { p: 'loc', t: l.t, i: src.i + j } : { p: 'const', t: l.t, ks: (src as any).ks, o: j }
          c.push(...base.c, ...this.load(leaf).c, ...storeOp(l.t), ...memarg(l.t, pl.off + l.off))
        })
        return c
      }
    }
  }

  coerce(v: Val, t: Type, n: any): Val {
    if (v.t === t) return v
    if (v.t.kind === 'lit') {
      if (t.kind === 'float' || (t.kind === 'int' && v.t === INT)) return this.kval(valueType(t), v.k)
    } else if (t.kind === 'int' && t.size <= 4 && (v.t === T.bool || (t.size < 4 && (v.t === T.i32 || v.t === T.u32)))) {
      return { ...v, t: valueType(t) }
    }
    return this.err(`expected ${t.name}, found ${v.t.name}`, n)
  }
  private concrete(v: Val): Val { return v.t === INT ? this.kval(T.i32, v.k) : v.t === FLOAT ? this.kval(T.f32, v.k) : v }
  /** A value on its way to JavaScript, where every number is a double. */
  private js(v: Val, n: any): Val {
    if (v.t === INT) return this.kval(v.k === (v.k | 0) ? T.i32 : T.f64, v.k)
    if (v.t === FLOAT) return this.kval(T.f64, v.k)
    if (v.t === T.u32) return v.k !== undefined ? this.kval(T.f64, v.k) : { t: T.f64, c: [...v.c, 0xb8], pure: v.pure }
    if (v.t.flat.length !== 1) this.err(`cannot pass ${v.t.name} to JavaScript`, n)
    return v
  }
  /** A condition: non-zero is true. `normalize` forces exactly 0 or 1. */
  private truthy(v: Val, n: any, normalize = false): Val {
    if (v.t === T.bool) return v
    if (v.k !== undefined && (v.t === INT || v.t.kind === 'int' || v.t.kind === 'ptr')) return this.kval(T.bool, v.k != 0)
    if (v.t.kind !== 'int' && v.t.kind !== 'ptr') this.err(`expected a condition, found ${v.t.name}`, n)
    if (v.t.w === I64) return { t: T.bool, c: [...v.c, 0x50, 0x45], pure: v.pure }
    return { t: T.bool, c: normalize ? [...v.c, 0x45, 0x45] : v.c, pure: v.pure }
  }

  // ---- expressions

  private local(name: string): Place | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const p = this.scopes[i].get(name); if (p) return p }
  }

  expr(n: any): Val {
    const r = this.ref(n)
    return 'p' in r ? this.load(r) : r
  }

  /** Evaluates to a place when `n` names one (so it can be assigned or projected), else to a value. */
  private ref(n: any): Val | Place {
    switch (n.n) {
      case 'id': {
        const local = this.local(n.name)
        if (local) return local
        const d = this.P.decls.get(n.name)
        if (!d) this.err(`unknown name '${n.name}'`, n)
        if (d.n === 'const') return { p: 'const', o: 0, ...this.P.constOf(d) }
        if (d.n === 'var') return { p: 'glob', t: this.P.varInfo(d).t, g: this.globalsOf(d), o: 0 }
        if (d.n === 'static') return this.kval(ptrTo(this.P.staticInfo(d).el), this.addr(d))
        if (d.n === 'fn') { const f = this.fn(d); this.elems.add(f); return { t: T.func, c: [0xd2, f], pure: true } }
        if (d.n === 'extern' && d.kind === 'val') {
          const t = d.ret ? this.P.type(d.ret, d.file) : T.ext
          return { t, c: [0x23, this.gimp('val', d.path, t.w)], pure: true }
        }
        return this.err(`'${n.name}' cannot be used as a value`, n)
      }
      case 'idx': {
        const b = this.expr(n.e)
        if (b.t.kind !== 'ptr') this.err(`cannot index ${b.t.name}`, n)
        const i = this.concrete(this.expr(n.i)), el = b.t.to!
        if (i.t.w !== I32 || i.t.kind !== 'int') this.err(`an index must be i32 or u32, found ${i.t.name}`, n)
        this.usesMem = true
        if (i.k !== undefined) {
          const off = i.k * el.size
          return off >= 0 ? { p: 'mem', t: el, base: b, off } : { p: 'mem', t: el, base: { t: T.i32, c: [...b.c, 0x41, ...sleb(off), 0x6a], pure: b.pure }, off: 0 }
        }
        // Indexing by a for-loop counter reads a second counter that advances by the element
        // size, instead of multiplying on every access.
        const counter = n.i.n === 'id' && el.size > 1 ? this.local(n.i.name) : undefined
        let scaled: Code
        if (counter?.p === 'loc' && counter.scaled) {
          let l = counter.scaled.get(el.size)
          if (l === undefined) counter.scaled.set(el.size, l = this.alloc(T.i32))
          scaled = localGet(l)
        } else {
          const shift = Math.log2(el.size)
          scaled = el.size === 1 ? i.c : Number.isInteger(shift) ? [...i.c, 0x41, shift, 0x74] : [...i.c, 0x41, ...sleb(el.size), 0x6c]
        }
        return b.k !== undefined
          ? { p: 'mem', t: el, base: { t: T.i32, c: scaled, pure: i.pure }, off: b.k }
          : { p: 'mem', t: el, base: { t: T.i32, c: [...b.c, ...scaled, 0x6a], pure: b.pure && i.pure }, off: 0 }
      }
      case 'fld': {
        const r = this.ref(n.e)
        let b: Place
        if ('p' in r && r.t.kind === 'struct') b = r
        else {
          const v = 'p' in r ? this.load(r) : r
          if (v.t.kind === 'ptr' && v.t.to!.kind === 'struct') { this.usesMem = true; b = { p: 'mem', t: v.t.to!, base: v, off: 0 } }
          else if (v.t.kind === 'struct') b = this.spill(v)
          else if (v.t === T.f32x4 && n.name.length === 1 && LANES.includes(n.name)) {
            const lane = LANES.indexOf(n.name)
            return v.k ? this.kval(T.f32, v.k[lane]) : { t: T.f32, c: [...v.c, ...simd(0x1f), lane], pure: v.pure }
          }
          else return this.err(`${v.t.name} has no field '${n.name}'`, n)
        }
        const f = b.t.fields!.find(f => f.name === n.name) ?? this.err(`${b.t.name} has no field '${n.name}'`, n)
        if (b.p === 'loc') return { ...b, t: f.t, i: b.i + f.slot }
        if (b.p === 'mem') return { ...b, t: f.t, off: b.off + f.off }
        return { ...b, t: f.t, o: b.o + f.slot }
      }
      case 'num': return { t: n.float ? FLOAT : INT, c: [], k: n.v, pure: true }
      case 'bool': return this.kval(T.bool, n.v)
      case 'null': return this.kval(T.ext, null)
      case 'str': return this.str(n.v)
      case 'bin': return n.op === '&&' || n.op === '||' ? this.logic(n) : this.arith(n.op, this.expr(n.a), this.expr(n.b), n)
      case 'un': return this.unary(n)
      case 'cast': return this.cast(n)
      case 'call': return this.call(n)
      case 'cond': return this.ternary(n)
      case 'comptime': {
        let v = this.P.comptime.get(n)                       // an inline function is compiled many times, evaluated once
        if (!v) this.P.comptime.set(n, v = this.P.evalConst(n.e, this.file))
        return this.load({ p: 'const', o: 0, ...v })
      }
      case 'addr': {
        const r = this.ref(n.e)
        if (!('p' in r) || r.p !== 'mem') return this.err('& needs something that lives in memory; locals have no address', n)
        const t = ptrTo(r.t), b = r.base
        if (b.k !== undefined && !r.pre) return this.kval(t, b.k + r.off)
        return { t, c: [...(r.pre ?? []), ...b.c, ...(r.off ? [0x41, ...sleb(r.off), 0x6a] : [])], pure: b.pure && !r.pre }
      }
      case 'obj': case 'arr': return this.literal(n)
    }
    return this.err('expected an expression', n)
  }

  /**
   * A JavaScript object or array literal, however deeply nested, becomes one imported function
   * that builds it in a single call. Constants are written into that function's source; only
   * values known at run time are passed as arguments.
   */
  private literal(n: any): Val {
    const args: Val[] = []
    const emit = (e: any): string => {
      if (e.n === 'obj') return `{${e.props.map(([k, x]: [string, any]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}:${emit(x)}`).join()}}`
      if (e.n === 'arr') return `[${e.items.map(emit).join()}]`
      const v = this.js(this.expr(e), e), k = v.k
      if (k === undefined || v.t.w === V128) return param(args.push(v) - 1)
      return k === null ? 'null' : typeof k === 'string' ? JSON.stringify(k) : typeof k === 'bigint' ? k + 'n' : v.t === T.bool ? String(!!k) : String(k)
    }
    const body = emit(n)
    return { t: T.ext, c: [...args.flatMap(v => v.c), 0x10, this.imp('js', `(${args.map((_, i) => param(i))})=>(${body})`, args.flatMap(v => v.t.flat), [EXT])] }
  }

  private arith(op: string, a: Val, b: Val, n: any): Val {
    const cmp = COMPARE.has(op)
    if (a.t.kind === 'lit' && b.t.kind === 'lit') {
      const t = a.t === FLOAT || b.t === FLOAT ? FLOAT : INT, k = fold(op, t, a.k, b.k)
      if (k === undefined) this.err(`cannot evaluate ${a.k} ${op} ${b.k}`, n)
      return this.kval(cmp ? T.bool : t, k)
    }
    if (a.t.kind === 'lit') a = this.coerce(a, b.t, n)
    else if (b.t.kind === 'lit') b = this.coerce(b, a.t, n)
    const t = a.t
    if (t !== b.t) this.err(`mismatched types: ${t.name} ${op} ${b.t.name}`, n)
    if (a.k !== undefined && b.k !== undefined) {
      const k = fold(op, t, a.k, b.k)
      if (k !== undefined) return this.kval(cmp ? T.bool : t, k)
    }
    let o: number | undefined
    const bad = (): never => this.err(`${t.name} does not support '${op}'`, n)
    if (t.kind === 'int' || (cmp && t.kind === 'ptr') || (t.kind === 'bool' && '==!=&|^'.includes(op))) {
      const e = INT_OPS[op]
      o = (typeof e === 'number' ? e : e[t.signed ? 0 : 1]) + (t.w === I64 ? (cmp ? 0x0b : 0x12) : 0)
    } else if (t.kind === 'float') {
      o = FLOAT_OPS[op] ?? bad()
      if (t === T.f64) o += cmp ? 6 : 0x0e
    } else if (t.kind === 'vec') {
      return { t, c: [...a.c, ...b.c, ...simd(VEC_OPS[op] ?? bad())], pure: a.pure && b.pure }
    } else bad()
    const traps = t.kind === 'int' && (op === '/' || op === '%')
    return { t: cmp ? T.bool : t, c: [...a.c, ...b.c, o!], pure: a.pure && b.pure && !traps }
  }

  private logic(n: any): Val {
    const and = n.op === '&&', a = this.truthy(this.expr(n.a), n.a, true)
    if (a.k !== undefined) return !!a.k === and ? this.truthy(this.expr(n.b), n.b, true) : a   // the other side is never compiled
    const b = this.truthy(this.expr(n.b), n.b, true)
    if (b.pure && b.c.length <= 32) return { t: T.bool, c: [...a.c, ...b.c, and ? 0x71 : 0x72], pure: a.pure }    // cheap and safe: no branch
    return { t: T.bool, c: and ? [...a.c, 0x04, I32, ...b.c, 0x05, 0x41, 0, 0x0b] : [...a.c, 0x04, I32, 0x41, 1, 0x05, ...b.c, 0x0b] }
  }

  private unary(n: any): Val {
    const v = this.expr(n.e), t = v.t
    if (n.op === '!') {
      const c = this.truthy(v, n)
      return c.k !== undefined ? this.kval(T.bool, !c.k) : { t: T.bool, c: [...c.c, 0x45], pure: c.pure }
    }
    if (t.kind === 'lit' && (n.op === '-' || t === INT)) return this.kval(t, n.op === '-' ? -v.k : ~v.k)
    if (n.op === '-') {
      if (t.kind === 'float') return v.k !== undefined ? this.kval(t, -v.k) : { t, c: [...v.c, t === T.f32 ? 0x8c : 0x9a], pure: v.pure }
      if (t.kind === 'vec') return { t, c: [...v.c, ...simd(0xe1)], pure: v.pure }
      if (t.kind === 'int') return this.arith('-', this.kval(t, 0), v, n)
    } else if (t.kind === 'int') {
      return this.arith('^', v, this.kval(t, -1), n)
    }
    return this.err(`${t.name} does not support unary '${n.op}'`, n)
  }

  private cast(n: any): Val {
    const v = this.expr(n.e), to = this.P.type(n.t, this.file), rt = valueType(to)
    const cls = (t: Type) => t.kind === 'float' ? t.w : t.kind === 'int' || t.kind === 'ptr' || t.kind === 'bool' ? t.w : 0
    const from = v.t === INT ? I32 : v.t === FLOAT ? F64 : cls(v.t), into = to.kind === 'bool' ? 0 : cls(to)
    if (!from || !into) this.err(`cannot cast ${v.t.name} to ${to.name}`, n)
    if (v.k !== undefined && into !== I64 && from !== I64) {     // fold
      let k = v.k
      if (into === I32) {
        if (from !== I32) k = Number.isNaN(k) ? 0 : Math.max(to.signed ? -(2 ** 31) : 0, Math.min(to.signed ? 2 ** 31 - 1 : 2 ** 32 - 1, Math.trunc(k)))
        if (to.size < 4) k = to.signed ? (k << (32 - 8 * to.size)) >> (32 - 8 * to.size) : k & (2 ** (8 * to.size) - 1)
      }
      return this.kval(rt, k)
    }
    if (v.t.kind === 'lit') return this.kval(rt, into === I64 ? BigInt(Math.trunc(v.k)) : v.k)
    const s = v.t.signed, c: number[] = []
    if (from === I32) c.push(...(into === I64 ? [s ? 0xac : 0xad] : into === F32 ? [s ? 0xb2 : 0xb3] : into === F64 ? [s ? 0xb7 : 0xb8] : []))
    else if (from === I64) c.push(...(into === I32 ? [0xa7] : into === F32 ? [s ? 0xb4 : 0xb5] : into === F64 ? [s ? 0xb9 : 0xba] : []))
    else if (from === F32) c.push(...(into === I32 ? [0xfc, to.signed ? 0 : 1] : into === I64 ? [0xfc, to.signed ? 4 : 5] : into === F64 ? [0xbb] : []))
    else c.push(...(into === I32 ? [0xfc, to.signed ? 2 : 3] : into === I64 ? [0xfc, to.signed ? 6 : 7] : into === F32 ? [0xb6] : []))
    if (to.kind === 'int' && to.size < 4) c.push(...(to.signed ? [to.size === 1 ? 0xc0 : 0xc1] : [0x41, ...sleb(2 ** (8 * to.size) - 1), 0x71]))
    return { t: rt, c: [...v.c, ...c], pure: v.pure }
  }

  private ternary(n: any): Val {
    const c = this.truthy(this.expr(n.c), n.c)
    if (c.k !== undefined) return this.expr(c.k ? n.a : n.b)           // the other branch is never compiled
    let a = this.expr(n.a), b = this.expr(n.b)
    if (a.t.kind === 'lit' && b.t.kind === 'lit') {
      const t = a.t === FLOAT || b.t === FLOAT ? T.f32 : T.i32
      a = this.kval(t, a.k); b = this.kval(t, b.k)
    } else if (a.t.kind === 'lit') a = this.coerce(a, b.t, n)
    else if (b.t.kind === 'lit') b = this.coerce(b, a.t, n)
    const t = a.t
    if (t !== b.t) this.err(`the branches differ: ${t.name} and ${b.t.name}`, n)
    if (a.pure && b.pure && t.flat.length === 1 && t.w !== EXT && t.w !== FUNC && a.c.length + b.c.length <= 24)
      return { t, c: [...a.c, ...b.c, ...c.c, 0x1b], pure: c.pure }     // branch-free select
    return { t, c: [...c.c, 0x04, ...this.blockType(t), ...a.c, 0x05, ...b.c, 0x0b] }
  }

  // ---- calls

  private call(n: any): Val {
    const d = this.P.decls.get(n.name)
    if (!d) return this.builtin(n)
    if (d.n === 'fn') return d.inline ? this.inline(d, n) : this.callFn(d, n)
    if (d.n === 'extern' && d.kind !== 'val') return this.callExtern(d, n)
    if (d.n === 'struct') {
      const t = this.P.struct(d)
      const vs = this.args(n, t.fields!.map(f => valueType(f.t)))
      const ks = vs.every(v => v.k !== undefined || v.ks) ? vs.flatMap(v => v.ks ?? [v.k]) : undefined
      return { t, c: vs.flatMap(v => v.c), ks, pure: vs.every(v => v.pure) }
    }
    return this.err(`'${n.name}' is not callable`, n)
  }

  private args(n: any, types: Type[]): Val[] {
    if (n.args.length !== types.length) this.err(`${n.name}() takes ${types.length} argument${types.length === 1 ? '' : 's'}, found ${n.args.length}`, n)
    return types.map((t, i) => this.coerce(this.expr(n.args[i]), t, n.args[i]))
  }

  private callFn(d: any, n: any): Val {
    const sig = this.P.sig(d)
    return { t: sig.ret, c: [...this.args(n, sig.params).flatMap(v => v.c), 0x10, this.fn(d)] }
  }

  private callExtern(d: any, n: any): Val {
    const self = d.kind === 'call' || d.kind === 'get' || d.kind === 'set'      // the receiver comes first
    const typed = (t: any) => t.name === 'any' ? null : valueType(this.P.type(t, d.file))     // null: pass as-is
    const setter = d.kind === 'set' && d.short                                                // `extern set A.b: T`
    const ret = setter ? VOID : d.ret ? typed(d.ret) ?? this.err("'any' cannot be a return type", n) : d.kind === 'get' || d.kind === 'new' ? T.ext : VOID
    const ps: (Type | null)[] = setter ? [d.ret ? typed(d.ret) : null] : d.params.map((p: any) => typed(p.t))
    if (self) ps.unshift(T.ext)
    if (n.args.length < ps.length || (n.args.length > ps.length && !d.variadic))
      this.err(`${n.name}() takes ${ps.length} argument${ps.length === 1 ? '' : 's'}, found ${n.args.length}`, n)
    const vs: Val[] = n.args.map((a: any, i: number) => ps[i] ? this.coerce(this.expr(a), ps[i]!, a) : this.js(this.expr(a), a))
    // The import's name is the JavaScript it binds to: a function value, or a one-line arrow
    // with exactly this call's arity, which the engine can inline and specialise like any other.
    const flat = vs.flatMap(v => v.t.flat), names = flat.map((_, i) => param(i)), member = d.path.slice(d.path.lastIndexOf('.') + 1)
    const source = d.kind === 'fn' ? d.path
      : d.kind === 'js' ? d.source
      : d.kind === 'new' ? `(${names})=>new ${d.path}(${names})`
      : d.kind === 'get' ? `a=>a.${member}`
      : d.kind === 'set' ? `(a,b)=>{a.${member}=b}`
      : `(${names})=>a.${member}(${names.slice(1)})`
    return { t: ret, c: [...vs.flatMap(v => v.c), 0x10, this.imp('js', source, flat, ret.flat)] }
  }

  /** Expands an `inline fn` in place. Constant arguments stay constant inside the body. */
  private inline(d: any, n: any): Val {
    if (++this.inlining > 64) this.err(`inline recursion in ${d.name}()`, n)
    const sig = this.P.sig(d), vs = this.args(n, sig.params)
    if (!d.assigned) { d.assigned = new Set(); walk(d.body, s => { if (s.n === 'assign') { let e = s.to; while (e.e) e = e.e; d.assigned.add(e.name) } }) }
    const pre: Code = [], scope = new Map<string, Place>()
    d.params.forEach((p: any, i: number) => {
      const v = vs[i]
      const pl: Place = d.assigned.has(p.name) || (v.k === undefined && !v.ks)
        ? { p: 'loc', t: v.t, i: this.alloc(v.t) }
        : { p: 'const', t: v.t, ks: v.ks ?? [v.k], o: 0 }
      if (pl.p === 'loc') pre.push(...v.c, ...this.sets(pl.i, v.t.flat.length))
      scope.set(p.name, pl)
    })
    const saved = [this.scopes, this.loops, this.ret, this.inl, this.file] as const
    this.scopes = [scope]; this.loops = []; this.ret = sig.ret; this.file = d.file
    let out: Val
    const only = d.body.length === 1 && d.body[0]
    if (only && only.n === 'return' && only.e) {
      const v = this.coerce(this.expr(only.e), sig.ret, only)
      out = pre.length ? { t: v.t, c: [...pre, ...v.c] } : v
    } else {
      d.early ??= (() => { let found = false; walk(d.body, s => { if (s.n === 'return' && s !== d.body.at(-1)) found = true }); return found })()
      if (d.early) this.depth++
      this.inl = { depth: this.depth }
      const c = this.body(d.body, sig.ret)
      if (d.early) this.depth--
      out = { t: sig.ret, c: d.early ? [...pre, 0x02, ...this.blockType(sig.ret), ...c, 0x0b] : [...pre, ...c] }
    }
    ;[this.scopes, this.loops, this.ret, this.inl, this.file] = saved
    this.inlining--
    return out
  }

  private builtin(n: any): Val {
    const a = n.args, nm = n.name as string
    const need = (count: number) => { if (a.length !== count) this.err(`${nm}() takes ${count} argument${count === 1 ? '' : 's'}`, n) }
    const word = (i: number) => {          // any i32-shaped value: an address or a count
      const v = this.concrete(this.expr(a[i]))
      return v.t.w === I32 && v.t.flat.length === 1 ? v : this.err(`expected an address or i32, found ${v.t.name}`, a[i])
    }
    if (nm in FLOAT_FNS) {
      need(1)
      const [op, vop, f] = FLOAT_FNS[nm], v = this.expr(a[0]), t = v.t
      if (v.k !== undefined && (t.kind === 'float' || t === FLOAT)) return this.kval(t, f(v.k))
      if (t.kind === 'float') return { t, c: [...v.c, op + (t === T.f64 ? 0x0e : 0)], pure: v.pure }
      if (t.kind === 'vec') return { t, c: [...v.c, ...simd(vop)], pure: v.pure }
      return this.err(`${nm}() needs a float, found ${t.name}`, n)
    }
    if (nm in BIT_FNS) {
      need(1)
      const v = this.concrete(this.expr(a[0]))
      if (v.t.kind !== 'int') this.err(`${nm}() needs an integer, found ${v.t.name}`, n)
      return { t: v.t, c: [...v.c, BIT_FNS[nm] + (v.t.w === I64 ? 0x12 : 0)], pure: v.pure }
    }
    switch (nm) {
      case 'min': case 'max': {
        need(2)
        let x = this.expr(a[0]), y = this.expr(a[1])
        const max = nm === 'max'
        if (x.t.kind === 'lit' && y.t.kind === 'lit') return this.kval(x.t === FLOAT || y.t === FLOAT ? FLOAT : INT, max ? Math.max(x.k, y.k) : Math.min(x.k, y.k))
        if (x.t.kind === 'lit') x = this.coerce(x, y.t, n); else y = this.coerce(y, x.t, n)
        const t = x.t, pure = x.pure && y.pure
        if (t.kind === 'float') return { t, c: [...x.c, ...y.c, (max ? 0x97 : 0x96) + (t === T.f64 ? 0x0e : 0)], pure }
        if (t.kind === 'vec') return { t, c: [...x.c, ...y.c, ...simd(max ? 0xe9 : 0xe8)], pure }
        if (t.kind !== 'int') this.err(`${nm}() does not support ${t.name}`, n)
        const [p1, x1] = this.stable(x), [p2, y1] = this.stable(y)
        return { t, c: [...p1, ...p2, ...x1.c, ...y1.c, ...this.arith(max ? '>' : '<', x1, y1, n).c, 0x1b], pure: pure && !p1.length && !p2.length }
      }
      case 'sizeof': need(1); return this.kval(INT, this.P.type({ n: 'tname', name: a[0].name, pos: a[0].pos }, this.file).size)
      case 'splat': {
        need(1)
        const v = this.coerce(this.expr(a[0]), T.f32, a[0])
        return v.k !== undefined ? this.kval(T.f32x4, [v.k, v.k, v.k, v.k]) : { t: T.f32x4, c: [...v.c, ...simd(0x13)], pure: v.pure }
      }
      case 'f32x4': {
        const vs = this.args(n, [T.f32, T.f32, T.f32, T.f32])
        if (vs.every(v => v.k !== undefined)) return this.kval(T.f32x4, vs.map(v => v.k))
        return { t: T.f32x4, c: [...vs[0].c, ...simd(0x13), ...[1, 2, 3].flatMap(i => [...vs[i].c, ...simd(0x20), i])], pure: vs.every(v => v.pure) }
      }
      case 'memcopy': need(3); this.usesMem = true; return { t: VOID, c: [...word(0).c, ...word(1).c, ...word(2).c, 0xfc, 0x0a, 0, 0] }
      case 'memfill': need(3); this.usesMem = true; return { t: VOID, c: [...word(0).c, ...word(1).c, ...word(2).c, 0xfc, 0x0b, 0] }
      case 'isnull': {
        need(1)
        const v = this.expr(a[0])
        if (v.t !== T.ext && v.t !== T.func) this.err(`isnull() needs ext or func, found ${v.t.name}`, n)
        return { t: T.bool, c: [...v.c, 0xd1], pure: v.pure }
      }
      case 'unreachable': need(0); return { t: VOID, c: [0x00] }
      case 'embed': {              // a file's text as a string constant
        need(1)
        if (a[0].n !== 'str') this.err('embed() takes a path string', n)
        const path = join(dirname(this.file.path), a[0].v)
        let text: string
        try { text = this.P.opts.read(path) } catch { return this.err(`cannot read '${path}'`, n) }
        if (!this.P.files.includes(path)) this.P.files.push(path)
        return this.str(path.endsWith('.wgsl') ? minifyWgsl(text) : text)
      }
    }
    return this.err(`unknown function '${nm}'`, n)
  }

  // ---- statements

  private block(stmts: any[]): Code {
    this.scopes.push(new Map())
    const c = stmts.flatMap(s => this.stmt(s))
    this.scopes.pop()
    return c
  }

  /** A function or inline body. A trailing `return` needs no branch: its value is simply left on the stack. */
  private body(stmts: any[], ret: Type): Code {
    this.scopes.push(new Map())
    const c = stmts.flatMap((s, i) => this.stmt(s, i === stmts.length - 1))
    this.scopes.pop()
    if (ret.flat.length && stmts.at(-1)?.n !== 'return') c.push(0x00)
    return c
  }

  private stmt(s: any, tail = false): Code {
    switch (s.n) {
      case 'let': {
        let v = this.expr(s.e)
        v = s.t ? this.coerce(v, valueType(this.P.type(s.t, this.file)), s.e) : this.concrete(v)
        if (!v.t.flat.length) this.err('this expression has no value', s.e)
        const i = this.alloc(v.t)
        this.scopes.at(-1)!.set(s.name, { p: 'loc', t: v.t, i })
        return [...v.c, ...this.sets(i, v.t.flat.length)]
      }
      case 'assign': {
        const r = this.ref(s.to)
        if (!('p' in r)) return this.err('cannot assign to this expression', s.to)
        if (r.p === 'loc' && r.scaled) this.err('a for-loop counter cannot be assigned', s.to)
        if (s.op === '=') return this.store(r, this.coerce(this.expr(s.e), r.t, s.e), s)
        let once: Code = r.pre ?? [], pl: Place = { ...r, pre: undefined }       // read and write the same place once
        if (pl.p === 'mem') { const [c, base] = this.stable(pl.base); once = [...once, ...c]; pl = { ...pl, base } }
        const v = this.arith(s.op.slice(0, -1), this.load(pl), this.expr(s.e), s)
        return [...once, ...this.store(pl, this.coerce(v, pl.t, s), s)]
      }
      case 'if': {
        const c = this.truthy(this.expr(s.c), s.c)
        if (c.k !== undefined) return c.k ? this.block(s.then) : s.else ? this.block(s.else) : []
        this.depth++
        const a = this.block(s.then), b = s.else ? [0x05, ...this.block(s.else)] : []
        this.depth--
        return [...c.c, 0x04, 0x40, ...a, ...b, 0x0b]
      }
      case 'while': {              // rotated: test once on entry, then again at the bottom of each iteration
        const c = this.truthy(this.expr(s.c), s.c), d = this.depth
        if (c.k !== undefined && !c.k) return []
        const forever = c.k !== undefined, cont = !forever && hasContinue(s.body)
        this.loops.push({ brk: d + 1, cont: cont ? d + 3 : d + 2 })
        this.depth = d + (cont ? 3 : 2)
        const body = this.block(s.body)
        this.depth = d
        this.loops.pop()
        if (forever) return [0x02, 0x40, 0x03, 0x40, ...body, 0x0c, 0, 0x0b, 0x0b]
        return [0x02, 0x40, ...c.c, 0x45, 0x0d, 0, 0x03, 0x40, ...(cont ? [0x02, 0x40, ...body, 0x0b] : body), ...c.c, 0x0d, 0, 0x0b, 0x0b]
      }
      case 'for': {
        let a = this.expr(s.a), b = this.expr(s.b)
        if (a.t.kind === 'lit') a = b.t.kind === 'lit' ? this.kval(T.i32, a.k) : this.coerce(a, b.t, s.a)
        b = this.coerce(b, a.t, s.b)
        const t = a.t
        if (t !== T.i32 && t !== T.u32) this.err(`a for range must be i32 or u32, found ${t.name}`, s)
        if (s.inline) {            // unrolled, with the counter a constant in each copy
          if (a.k === undefined || b.k === undefined) this.err('inline for needs constant bounds', s)
          const c: Code = [], loops = this.loops
          this.loops = []
          for (let k = a.k; k < b.k; k++) {
            this.scopes.push(new Map([[s.name, { p: 'const', t, ks: [k], o: 0 } as Place]]))
            c.push(...this.block(s.body))
            this.scopes.pop()
          }
          this.loops = loops
          return c
        }
        if (a.k !== undefined && b.k !== undefined && a.k >= b.k) return []
        const i = this.alloc(t), [once, end] = this.stable(b), d = this.depth, cont = hasContinue(s.body)
        const test = [...localGet(i), ...end.c, t.signed ? 0x48 : 0x49]
        this.loops.push({ brk: d + 1, cont: cont ? d + 3 : d + 2 })
        this.depth = d + (cont ? 3 : 2)
        const scaled = new Map<number, number>()            // element size → local holding counter * size
        this.scopes.push(new Map([[s.name, { p: 'loc', t, i, scaled } as Place]]))
        const body = this.block(s.body)
        this.scopes.pop()
        this.depth = d
        this.loops.pop()
        const guard = a.k !== undefined && b.k !== undefined ? [] : [...test, 0x45, 0x0d, 0]
        const init = [...scaled].flatMap(([size, l]) => [...(a.k !== undefined ? this.kval(T.i32, a.k * size).c : [...localGet(i), 0x41, ...sleb(size), 0x6c]), 0x21, ...uleb(l)])
        const step = [...scaled].flatMap(([size, l]) => [...localGet(l), 0x41, ...sleb(size), 0x6a, 0x21, ...uleb(l)])
        return [...a.c, 0x21, ...uleb(i), ...init, ...once, 0x02, 0x40, ...guard, 0x03, 0x40, ...(cont ? [0x02, 0x40, ...body, 0x0b] : body),
          ...localGet(i), 0x41, 1, 0x6a, 0x21, ...uleb(i), ...step, ...test, 0x0d, 0, 0x0b, 0x0b]
      }
      case 'break': case 'continue': {
        const l = this.loops.at(-1) ?? this.err(`${s.n} outside a loop`, s)
        return [0x0c, ...uleb(this.depth - (s.n === 'break' ? l.brk : l.cont))]
      }
      case 'return': {
        if (!s.e !== !this.ret.flat.length) this.err(s.e ? 'this function returns nothing' : `expected a ${this.ret.name} to return`, s)
        const c = s.e ? this.coerce(this.expr(s.e), this.ret, s.e).c : []
        return tail ? c : this.inl ? [...c, 0x0c, ...uleb(this.depth - this.inl.depth)] : [...c, 0x0f]
      }
      case 'expr': {
        const v = this.expr(s.e)
        return v.pure ? [] : [...v.c, ...v.t.flat.map(() => 0x1a)]
      }
    }
    return this.err('expected a statement', s)
  }

  // ---- output

  private compileFn(d: any): void {
    const f = this.fnOf.get(d)!, sig = this.P.sig(d)
    this.file = d.file; this.locals = []; this.depth = 0; this.loops = []; this.ret = sig.ret; this.inl = null
    const scope = new Map<string, Place>()
    let i = 0
    d.params.forEach((p: any, j: number) => { scope.set(p.name, { p: 'loc', t: sig.params[j], i }); i += sig.params[j].flat.length })
    this.nparam = i
    this.scopes = [scope]
    f.code = this.body(d.body, sig.ret)
    f.locals = this.locals
  }

  private drain(): void { while (this.queue.length) this.compileFn(this.queue.shift()) }

  /** Wraps a value in an exported function, instantiates the module in the compiler's own engine and returns its exports. */
  run(v: Val): WebAssembly.Exports {
    this.funcs.push({ idx: 0, type: this.functype([], v.t.flat), name: '__ct', exp: '__ct', locals: this.locals, code: v.c })
    return new WebAssembly.Instance(new WebAssembly.Module(this.finish(false)), this.P.host ??= runtime()).exports
  }

  finish(names: boolean): Uint8Array<ArrayBuffer> {
    this.drain()
    // Keep only what the exports can reach in the code that was actually emitted. Folding and
    // inlining leave things behind (a string that ended up inside a literal's source, say).
    const live = new Set<Func | Glob>(), todo: (Func | Glob)[] = this.funcs.filter(f => f.exp)
    for (let x; (x = todo.pop());) {
      if (live.has(x)) continue
      live.add(x)
      for (const y of 'w' in x ? x.init : x.code) if (typeof y !== 'number') todo.push(y)
    }
    const keep = <X extends Func | Glob>(xs: Iterable<X>) => [...xs].filter(x => live.has(x))
    const fimports = keep(this.fimports.values()), funcs = keep(this.funcs), elems = keep(this.elems)
    const gimports = keep(this.gimports.values()), globals = keep(this.globals)
    fimports.concat(funcs).forEach((f, i) => f.idx = i)
    gimports.concat(globals).forEach((g, i) => g.idx = i)

    const out: number[] = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]
    const put = (bytes: ArrayLike<number>) => { for (let j = 0; j < bytes.length; j++) out.push(bytes[j]) }
    const resolve = (code: Code) => { const b: number[] = []; for (const x of code) typeof x === 'number' ? b.push(x) : uleb(x.idx, b); return b }
    const section = (id: number, items: number[][]) => {
      if (!items.length) return
      const head = uleb(items.length)
      out.push(id); put(uleb(head.length + items.reduce((n, x) => n + x.length, 0))); put(head)
      for (const x of items) put(x)
    }
    const mem = this.usesMem || this.segs.length > 0

    section(1, this.typeDefs)
    section(2, [
      ...fimports.map(f => [...name(f.imp![0]), ...name(f.imp![1]), 0, ...uleb(f.type)]),
      ...gimports.map(g => [...name(g.imp![0]), ...name(g.imp![1]), 3, g.w, 0]),
    ])
    section(3, funcs.map(f => uleb(f.type)))
    if (mem) section(5, [[0, ...uleb(Math.ceil(this.P.top / 65536))]])
    section(6, globals.map(g => [g.w, +g.mut, ...resolve(g.init), 0x0b]))
    section(7, [
      ...(mem ? [[...name('memory'), 2, 0]] : []),
      ...funcs.filter(f => f.exp).map(f => [...name(f.exp!), 0, ...uleb(f.idx)]),
    ])
    if (elems.length) section(9, [[3, 0, ...uleb(elems.length), ...elems.flatMap(f => uleb(f.idx))]])   // declares ref.func targets
    section(10, funcs.map(f => {
      const groups: number[][] = []
      for (const w of f.locals) { const g = groups.at(-1); if (g && g[1] === w) g[0]++; else groups.push([1, w]) }
      const b = [...uleb(groups.length), ...groups.flatMap(([n, w]) => [...uleb(n), w]), ...resolve(f.code), 0x0b]
      return [...uleb(b.length), ...b]
    }))
    section(11, this.dataSegments().map(s => [0, 0x41, ...sleb(s.addr), 0x0b, ...uleb(s.bytes.length), ...s.bytes]))
    if (names) {
      const all = [...fimports, ...funcs].map(f => [...uleb(f.idx), ...name(f.name)])
      const sub = [...uleb(all.length), ...all.flat()]
      const body = [...name('name'), 1, ...uleb(sub.length), ...sub]
      out.push(0); put(uleb(body.length)); put(body)
    }
    return Uint8Array.from(out)
  }

  /** Static data with zero runs removed: zeroes are free in a fresh memory. */
  private dataSegments(): { addr: number; bytes: Uint8Array }[] {
    const out: { addr: number; bytes: Uint8Array }[] = []
    for (const s of [...this.segs].sort((a, b) => a.addr - b.addr)) {
      let lo = 0, hi = s.bytes.length
      while (lo < hi && !s.bytes[lo]) lo++
      while (hi > lo && !s.bytes[hi - 1]) hi--
      if (lo === hi) continue
      const prev = out.at(-1), addr = s.addr + lo, bytes = s.bytes.subarray(lo, hi)
      if (prev && addr - (prev.addr + prev.bytes.length) < 8) {       // a tiny gap costs less than a new segment
        const merged = new Uint8Array(addr + bytes.length - prev.addr)
        merged.set(prev.bytes); merged.set(bytes, addr - prev.addr)
        prev.bytes = merged
      } else out.push({ addr, bytes })
    }
    return out
  }
}

function hasContinue(body: any[]): boolean {
  let found = false
  walk(body, s => { if (s.n === 'continue') found = true })
  return found
}

// ---------------------------------------------------------------- entry point

export interface Output { wasm: Uint8Array<ArrayBuffer>; files: string[] }

/** Compiles the program rooted at `entry`. Every `export fn` becomes a WebAssembly export. */
export function compile(entry: string, opts: Options): Output {
  const P = new Program(opts)
  P.load(entry)
  const u = new Unit(P)
  for (const d of P.decls.values()) if (d.n === 'fn' && d.exported) u.fn(d)
  return { wasm: u.finish(!!opts.debug), files: P.files }
}
