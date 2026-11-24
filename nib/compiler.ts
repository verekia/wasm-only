// TypeScript (a strict subset) → WebAssembly. One pass from AST to bytes: type checking, constant
// folding, inlining and struct scalarisation all happen while emitting. The rule that shapes
// everything here: compiled code must compute what the same file computes when run as JavaScript.

import { parse, walk, fail, type File } from './syntax.ts'
import { instantiate, type Glue, type Export } from './loader.ts'

// ---------------------------------------------------------------- types

const I32 = 0x7f, F32 = 0x7d, F64 = 0x7c, V128 = 0x7b, FUNC = 0x70, EXT = 0x6f

interface Field { name: string; t: Type; slot: number }
interface Type {
  name: string
  kind: 'int' | 'float' | 'bool' | 'ext' | 'vec' | 'struct' | 'array' | 'fn' | 'void' | 'lit' | 'host' | 'fnref' | 'funcref'
  w: number                             // wasm value type (scalars only)
  size: number                          // bytes as a typed array element
  signed: boolean
  flat: number[]                        // the wasm values this type occupies
  leaves: Type[]                        // its scalars
  fields?: Field[]
  key?: string                          // structs: their shape, for structural identity
  el?: Type                             // typed arrays: the element
  ctor?: string                         // typed arrays: the JavaScript constructor
  sig?: { params: Type[]; ret: Type }   // function values
}

function prim(name: string, kind: Type['kind'], w: number, size: number, signed = false): Type {
  const t: Type = { name, kind, w, size, signed, flat: [w], leaves: [] }
  t.leaves = [t]
  return t
}
const T = {
  i32: prim('i32', 'int', I32, 4, true), u32: prim('u32', 'int', I32, 4),
  i8: prim('i8', 'int', I32, 1, true), u8: prim('u8', 'int', I32, 1),
  i16: prim('i16', 'int', I32, 2, true), u16: prim('u16', 'int', I32, 2),
  f32: prim('f32', 'float', F32, 4), f64: prim('number', 'float', F64, 8),
  bool: prim('boolean', 'bool', I32, 1),
  ext: prim('a JavaScript value', 'ext', EXT, 0),
  f32x4: prim('f32x4', 'vec', V128, 16),
  funcref: prim('function', 'funcref', FUNC, 0),
}
const NONE = { w: 0, size: 0, signed: false, flat: [] as number[], leaves: [] as Type[] }
const VOID: Type = { ...NONE, name: 'void', kind: 'void' }
const INT: Type = { ...NONE, name: 'integer', kind: 'lit' }            // untyped literals adapt to
const FLOAT: Type = { ...NONE, name: 'number', kind: 'lit' }           // whatever they meet
const HOST: Type = { ...NONE, name: 'a JavaScript value', kind: 'host' }   // an expression JavaScript will evaluate, not yet emitted
const FNREF: Type = { ...NONE, name: 'function', kind: 'fnref' }       // a function named in the source

const ARRAYS: Record<string, Type> = {}
for (const [ctor, el] of Object.entries({
  Float32Array: T.f32, Float64Array: T.f64, Int8Array: T.i8, Uint8Array: T.u8,
  Int16Array: T.i16, Uint16Array: T.u16, Int32Array: T.i32, Uint32Array: T.u32,
})) {
  ARRAYS[ctor] = { name: ctor, kind: 'array', w: 0, size: 0, signed: false, flat: [I32, I32], leaves: [T.i32, T.i32], el, ctor,
    fields: [{ name: 'ptr', t: T.i32, slot: 0 }, { name: 'length', t: T.i32, slot: 1 }] }
}
/** What reading an element gives: narrow integers widen to i32. */
const loaded = (el: Type): Type => el.kind === 'int' && el.size < 4 ? T.i32 : el
const isNum = (t: Type) => t.kind === 'int' || t.kind === 'float' || t.kind === 'lit'
const isJs = (t: Type) => t === HOST || t === T.ext

// ---------------------------------------------------------------- encoding

type Code = (number | Func | Glob)[]     // bytes, plus references resolved once indices are final
interface Func { idx: number; type: number; name: string; imp?: string; exp?: string; locals: number[]; code: Code }
interface Glob { idx: number; w: number; mut: boolean; imp?: string; init: Code }

function uleb(n: number, out: number[] = []): number[] {
  do { const b = n & 0x7f; n >>>= 7; out.push(n ? b | 0x80 : b) } while (n)
  return out
}
function sleb(n: number): number[] {
  const out: number[] = []
  for (let v = BigInt(Math.trunc(n)); ;) {
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
const localSet = (i: number) => [0x21, ...uleb(i)]
const i32const = (k: number) => [0x41, ...sleb(k | 0)]

const loadOp = (t: Type) => t.w === F32 ? [0x2a] : t.w === F64 ? [0x2b] : t.w === V128 ? [0xfd, 0]
  : t.size === 4 ? [0x28] : t.size === 2 ? [t.signed ? 0x2e : 0x2f] : [t.signed ? 0x2c : 0x2d]
const storeOp = (t: Type) => t.w === F32 ? [0x38] : t.w === F64 ? [0x39] : t.w === V128 ? [0xfd, 0x0b]
  : t.size === 4 ? [0x36] : t.size === 2 ? [0x3b] : [0x3a]
const memarg = (t: Type, off: number) => [t.w === V128 ? 2 : Math.log2(t.size), ...uleb(off)]

// i32 opcodes; pairs are [signed, unsigned]. The f64 ones follow.
const INT_OPS: Record<string, number | [number, number]> = {
  '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': [0x6d, 0x6e], '%': [0x6f, 0x70], '&': 0x71, '|': 0x72, '^': 0x73, '<<': 0x74, '>>': 0x75, '>>>': 0x76,
  '==': 0x46, '!=': 0x47, '<': [0x48, 0x49], '>': [0x4a, 0x4b], '<=': [0x4c, 0x4d], '>=': [0x4e, 0x4f],
}
const F64_OPS: Record<string, number> = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3, '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64, '<=': 0x65, '>=': 0x66 }
const F32_OPS: Record<string, number> = { '+': 0x92, '-': 0x93, '*': 0x94, '/': 0x95 }
const VEC_BINARY: Record<string, number> = { add: 0xe4, sub: 0xe5, mul: 0xe6, div: 0xe7, min: 0xe8, max: 0xe9 }
const VEC_UNARY: Record<string, number> = { abs: 0xe0, neg: 0xe1, sqrt: 0xe3 }
const COMPARE = new Set(['==', '!=', '<', '>', '<=', '>='])
const BITWISE = new Set(['&', '|', '^', '<<', '>>', '>>>'])
const STRICT: Record<string, string> = { '===': '==', '!==': '!=' }
const LANES = 'xyzw'
const param = (i: number) => i < 26 ? String.fromCharCode(97 + i) : 'a' + i          // names for generated JS parameters
const jsRound = (x: number) => { const t = Math.ceil(x); return t - 0.5 > x ? t - 1 : t }

/** What the operator gives in JavaScript, with integers wrapping where the compiled code wraps. */
function fold(op: string, t: Type, a: number, b: number): number | boolean | undefined {
  const wrap = (x: number) => t === T.i32 ? x | 0 : t === T.u32 ? x >>> 0 : x
  switch (op) {
    case '+': return wrap(a + b)
    case '-': return wrap(a - b)
    case '*': return t === T.i32 || t === T.u32 ? wrap(Math.imul(a, b)) : a * b
    case '/': return a / b
    case '%': return (t === T.i32 || t === T.u32) && b === 0 ? undefined : a % b
    case '&': return a & b
    case '|': return a | b
    case '^': return a ^ b
    case '<<': return a << b
    case '>>': return a >> b
    case '>>>': return a >>> b
    case '==': return a === b
    case '!=': return a !== b
    case '<': return a < b
    case '>': return a > b
    case '<=': return a <= b
    case '>=': return a >= b
  }
}

const dirname = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'
function join(dir: string, rel: string): string {
  const out: string[] = []
  for (const part of (rel.startsWith('/') ? rel : dir + '/' + rel).split('/')) {
    if (part === '..' && out.length && out.at(-1) !== '..' && out.at(-1) !== '') out.pop()
    else if (part !== '.' && (part !== '' || !out.length)) out.push(part)
  }
  return out.join('/') || '.'
}

// ---------------------------------------------------------------- JavaScript expressions

/**
 * Part of an expression that JavaScript evaluates: source text with numbered holes for the
 * values Wasm passes in. Parts fuse, so `ctx.getCurrentTexture().createView()` is one call
 * across the boundary, and constants are written into the text.
 */
interface Js {
  src: (string | number)[]
  params: Val[]
  ops: boolean            // does something when evaluated (a call, a property read)
  pure: boolean           // only Math functions: safe to run at build time
  prec: number            // 20 member/call/primary ... 3 conditional ... 2 assignment
  object?: boolean        // starts with `{`
  gives?: Type            // the operator settles the result: a - b is a number whatever a and b are
}
const jsText = (text: string, prec = 20): Js => ({ src: [text], params: [], ops: false, pure: true, prec })
function jsJoin(parts: (string | Js)[], prec: number, ops = false): Js {
  const out: Js = { src: [], params: [], ops, pure: true, prec }
  for (const p of parts) {
    if (typeof p === 'string') { out.src.push(p); continue }
    for (const s of p.src) out.src.push(typeof s === 'number' ? s + out.params.length : s)
    out.params.push(...p.params)
    out.ops ||= p.ops
    out.pure &&= p.pure
  }
  return out
}
const jsWrap = (j: Js, min: number): Js => j.prec >= min ? j : jsJoin(['(', j, ')'], 20)
const JS_PREC: Record<string, number> = {
  '??': 4, '||': 5, '&&': 6, '|': 7, '^': 8, '&': 9, '==': 10, '!=': 10, '===': 10, '!==': 10,
  '<': 11, '<=': 11, '>': 11, '>=': 11, '<<': 12, '>>': 12, '>>>': 12, '+': 13, '-': 13, '*': 14, '/': 14, '%': 14,
}

// ---------------------------------------------------------------- program

export interface Options {
  /** Reads a source file. */
  read(path: string): string
  /** Directory that `nib/...` imports resolve to. */
  lib?: string
  /** Emit a name section so stack traces and profiles show function names. */
  debug?: boolean
}

interface Val { t: Type; c: Code; k?: any; ks?: any[]; pure?: boolean; js?: Js; fn?: any }
type Place = { t: Type; pre?: Code } & (
  | { p: 'loc'; i: number; scaled?: Map<number, number>; node?: any }   // scaled: a loop counter's pre-multiplied copies. node: its `let`, when the type was inferred
  | { p: 'glob'; g: Glob[]; o: number; decl?: any }                     // decl: its top-level `let`, when the type was inferred
  | { p: 'mem'; base: Val; off: number }
  | { p: 'const'; ks: any[]; o: number })
const isPlace = (x: Val | Place): x is Place => 'p' in x

interface Module {
  file: File
  decls: Map<string, any>
  imports: Map<string, { mod?: Module; name: string; intrinsic?: boolean; text?: string }>
  top: any[]
}
interface VarInfo { t: Type; ks?: any[]; runtime?: boolean; data?: Uint8Array; bytes?: number; deps?: any[]; inferred?: boolean }
class NotConstant extends Error {}

/** Everything shared between compilation units: sources, declarations, resolved types, constants. */
class Program {
  modules = new Map<string, Module>()
  order: Module[] = []                   // the order JavaScript would evaluate them in
  files: string[] = []
  opts: Options
  private addrs = new Map<any, number>()
  private structs = new Map<string, Type>()
  private fns = new Map<string, Type>()
  wide: Set<string>                      // `let` declarations whose inferred integer type did not hold, as path:offset
  restart = false                        // a top-level one was found late: everything compiled so far may have used it as an integer
  top = 16                               // next free static address; address 0 stays unused
  constructor(opts: Options, wide: Set<string>) { this.opts = opts; this.wide = wide }
  isWide(mod: Module, node: any): boolean { return this.wide.has(mod.file.path + ':' + node.pos) }
  widen(mod: Module, node: any): void { this.wide.add(mod.file.path + ':' + node.pos) }

  load(path: string, from?: { file: File; pos: number }): Module {
    const known = this.modules.get(path)
    if (known) return known
    let src: string
    try { src = this.opts.read(path) } catch { return fail(`cannot read '${path}'`, from) }
    this.files.push(path)
    const file = { path, src }, ast = parse(file)
    const mod: Module = { file, decls: new Map(), imports: new Map(), top: ast.top }
    this.modules.set(path, mod)
    for (const imp of ast.imports) {
      const at = { file, pos: imp.pos }
      if (imp.from === 'nib') { for (const n of imp.names) mod.imports.set(n.as, { name: n.name, intrinsic: true }); continue }
      let p = imp.from.startsWith('nib/') ? join(this.opts.lib ?? 'lib', imp.from.slice(4)) : join(dirname(path), imp.from)
      if (!imp.from.startsWith('.') && !imp.from.startsWith('nib/')) fail(`cannot import the package '${imp.from}': only nib/* and relative files compile`, at)
      if (/\.(wgsl|glsl|txt|html|css|json|svg)$/.test(p)) {             // text, as `import x from './a.wgsl' with { type: 'text' }`
        let text: string
        try { text = this.opts.read(p) } catch { return fail(`cannot read '${p}'`, at) }
        if (!this.files.includes(p)) this.files.push(p)
        if (!imp.default) fail('a text file has only a default export', at)
        mod.imports.set(imp.default!, { name: 'default', text })
        continue
      }
      if (!/\.ts$/.test(p)) p += '.ts'
      const target = this.load(p, at)
      if (imp.default) fail('default imports are not supported: import by name', at)
      for (const n of imp.names) mod.imports.set(n.as, { mod: target, name: n.name })
    }
    for (const d of ast.top) {
      if (d.n === 'stmt') continue
      if (mod.decls.has(d.name) || mod.imports.has(d.name)) fail(`'${d.name}' is already declared`, { file, pos: d.pos })
      d.mod = mod
      mod.decls.set(d.name, d)
    }
    this.order.push(mod)
    return mod
  }

  /** The declaration a name refers to at the top level of `mod`, or undefined for a JavaScript global. */
  resolve(mod: Module, id: string): { d?: any; intrinsic?: string; text?: string } | undefined {
    const d = mod.decls.get(id)
    if (d) return { d }
    const imp = mod.imports.get(id)
    if (!imp) return undefined
    if (imp.intrinsic) return { intrinsic: imp.name }
    if (imp.text !== undefined) return { text: imp.text }
    const target = imp.mod!.decls.get(imp.name)
    if (!target) fail(`'${imp.name}' is not declared in ${imp.mod!.file.path}`)
    return { d: target }
  }

  type(n: any, mod: Module): Type {
    switch (n.n) {
      case 'tname': {
        switch (n.name) {
          case 'number': case 'f64': return T.f64
          case 'f32': return T.f32
          case 'i32': return T.i32
          case 'u32': return T.u32
          case 'boolean': return T.bool
          case 'void': case 'undefined': return VOID
          case 'f32x4': return T.f32x4
        }
        if (ARRAYS[n.name] && !mod.decls.has(n.name)) return ARRAYS[n.name]
        const r = this.resolve(mod, n.name)
        if (r?.d?.n !== 'alias') return T.ext                // HTMLElement, string, GPUDevice: JavaScript's business
        const d = r.d
        if (d.busy) fail(`type '${d.name}' contains itself`, { file: d.mod.file, pos: d.pos })
        d.busy = true
        d.type ??= this.type(d.t, d.mod)
        d.busy = false
        if (d.type.kind === 'struct' && d.type.name.startsWith('{')) d.type.name = d.name
        return d.type
      }
      case 'tobj': {
        const fields = n.fields.map((f: any) => ({ name: f.name as string, t: this.type(f.t, mod) }))
        const key = '{' + fields.map((f: any) => `${f.name}:${f.t.key ?? f.t.name}`).join() + '}'
        let t = this.structs.get(key)
        if (!t) {
          t = { ...NONE, name: `{ ${fields.map((f: any) => `${f.name}: ${f.t.name}`).join(', ')} }`, kind: 'struct', fields: [], key }
          for (const f of fields) {
            if (!f.t.flat.length) fail(`field '${f.name}' cannot be ${f.t.name}`, { file: mod.file, pos: n.pos })
            t.fields!.push({ name: f.name, t: f.t, slot: t.leaves.length })
            t.leaves = [...t.leaves, ...f.t.leaves]
          }
          t.flat = t.leaves.map(l => l.w)
          this.structs.set(key, t)
        }
        return t
      }
      case 'tfn': return this.fnType(n.params.map((p: any) => p.t ? this.type(p.t, mod) : T.ext), this.type(n.ret, mod))
      case 'tunion': {
        const ts = n.types.map((x: any) => this.type(x, mod))
        return ts.every((t: Type) => t === ts[0]) ? ts[0] : T.ext
      }
    }
    return T.ext
  }

  fnType(params: Type[], ret: Type): Type {
    const key = params.map(p => p.key ?? p.name).join() + '=>' + (ret.key ?? ret.name)
    let t = this.fns.get(key)
    if (!t) this.fns.set(key, t = { ...prim(`(${params.map(p => p.name).join(', ')}) => ${ret.name}`, 'fn', I32, 4), sig: { params, ret } })
    return t
  }

  sig(d: any): { params: Type[]; ret: Type } {
    if (d.sig) return d.sig
    let returns = false
    walk(d.body, s => { if (s.n === 'return' && s.e) returns = true })
    if (returns && !d.ret) fail(`function '${d.name}' needs a return type`, { file: d.mod.file, pos: d.pos })
    return d.sig = {
      params: d.params.map((p: any) => p.t ? this.type(p.t, d.mod) : T.ext),
      ret: d.ret ? this.type(d.ret, d.mod) : VOID,
    }
  }

  /**
   * Evaluates an expression at build time: folded if it is constant, otherwise compiled and run
   * here in the compiler's own engine. Throws NotConstant if it needs the page (the DOM, or
   * anything else that exists only when the program starts).
   */
  tryConst(e: any, mod: Module, want?: Type): { t: Type; ks: any[]; data?: Uint8Array; deps?: any[] } {
    for (;;) {
      const u = new Unit(this)
      u.mod = mod
      let v = u.expr(e, want)
      if (want) v = u.coerce(v, want, e)
      else if (v.t === HOST) { if (!v.js!.pure) throw new NotConstant(); v = u.force(v, T.f64, e) }
      if (u.demoted) continue
      if (u.impure) throw new NotConstant()
      if (v.fn) return fail('a function is not a value here', { file: mod.file, pos: e.pos })
      if (v.ks) return { t: v.t, ks: v.ks, deps: [...u.statics] }
      if (v.k !== undefined) return { t: v.t, ks: [v.k] }
      let ks: any[], memory: WebAssembly.Memory
      try {
        const x = u.run(v)
        const r = x.__ct()
        ks = v.t.flat.length === 1 ? [r] : [...(r ?? [])]
        memory = x.memory
      } catch (err: any) { return fail(`build-time evaluation failed: ${err.message}`, { file: mod.file, pos: e.pos }) }
      v.t.leaves.forEach((l, i) => { if (l === T.u32) ks[i] >>>= 0 })
      if (v.t.kind === 'array') return { t: v.t, ks, data: new Uint8Array(memory.buffer, ks[0], ks[1] * v.t.el!.size).slice() }
      return { t: v.t, ks }
    }
  }

  evalConst(e: any, mod: Module, want?: Type): { t: Type; ks: any[] } {
    try { return this.tryConst(e, mod, want) } catch (err) {
      if (!(err instanceof NotConstant)) throw err
      return fail('this must be known at build time', { file: mod.file, pos: e.pos })
    }
  }

  /** What a top-level `const` or `let` is: a build-time constant, static memory, or a global set at startup. */
  varInfo(d: any): VarInfo {
    if (d.info) return d.info
    const at = { file: d.mod.file, pos: d.pos }
    if (d.busy) fail(`'${d.name}' depends on itself`, at)
    d.busy = true
    const want = d.t ? this.type(d.t, d.mod) : undefined
    const done = (info: VarInfo) => { d.busy = false; return d.info = info }
    if (!d.e) return want ? done({ t: want }) : fail(`'${d.name}' needs a type or a value`, at)

    const array = d.e.n === 'new' && d.e.f.n === 'id' && !this.resolve(d.mod, d.e.f.name) ? ARRAYS[d.e.f.name] : undefined
    if (array && d.e.args.length === 1) {              // new Float32Array(n) or new Float32Array([...]): static memory
      const arg = d.e.args[0], el = array.el!
      if (arg.n === 'arr') {
        const data = new Uint8Array(arg.items.length * el.size), dv = new DataView(data.buffer)
        arg.items.forEach((item: any, i: number) => {
          const k = Number(this.evalConst(item, d.mod, T.f64).ks[0]), o = i * el.size
          if (el === T.f32) dv.setFloat32(o, k, true)
          else if (el === T.f64) dv.setFloat64(o, k, true)
          else if (el.size === 4) dv.setInt32(o, k, true)
          else if (el.size === 2) dv.setInt16(o, k, true)
          else dv.setInt8(o, k)
        })
        return done({ t: array, bytes: data.length, data, ks: [0, arg.items.length] })
      }
      try {
        const n = Number(this.tryConst(arg, d.mod, T.i32).ks[0])
        return done({ t: array, bytes: n * el.size, ks: [0, n] })
      } catch (err) { if (!(err instanceof NotConstant)) throw err }
    }
    try {
      const r = this.tryConst(d.e, d.mod, want)
      if (r.t.kind === 'array' && r.data) return done({ t: r.t, bytes: r.data.length, data: r.data, ks: [0, r.ks[1]] })
      if (r.t.kind === 'array') return done({ t: r.t, ks: r.ks, deps: r.deps })
      if (d.isConst) return done({ t: r.t, ks: r.ks })
      // `let n = 0`: an integer for as long as only integers are assigned to it
      const int = r.t === INT && Number.isInteger(r.ks[0]) && Math.abs(r.ks[0]) < 2 ** 31 && !this.isWide(d.mod, d)
      return done({ t: int ? T.i32 : r.t === INT || r.t === FLOAT ? T.f64 : r.t, ks: r.ks, inferred: int })
    } catch (err) {
      if (!(err instanceof NotConstant)) throw err
      const u = new Unit(this)                         // not constant: learn its type, and set it at startup
      u.mod = d.mod
      const v = u.expr(d.e, want)
      const t = want ?? (v.t === HOST ? v.js!.gives ?? T.ext : v.t === INT || v.t === FLOAT || v.t === T.f32 ? T.f64 : v.t === FNREF ? this.fnTypeOf(v.fn) : v.t)
      return done({ t, runtime: true })
    }
  }

  fnTypeOf(d: any): Type { const s = this.sig(d); return this.fnType(s.params, s.ret) }

  /** Where a static array lives. One address space serves every unit, so addresses computed at build time stay valid. */
  addr(d: any): number {
    let a = this.addrs.get(d)
    if (a === undefined) {
      a = (this.top + 15) & -16
      this.top = a + this.varInfo(d).bytes!
      this.addrs.set(d, a)
    }
    return a
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
  statics = new Set<any>()
  private segs: { addr: number; bytes: Uint8Array }[] = []
  private elems = new Set<Func>()
  private slots: Func[] = []             // functions used as values: their table index is position + 1
  private heap?: Glob
  private allocFn?: Func
  private queue: any[] = []
  private usesMem = false
  glue: Glue = { key: '', entries: [], pages: 0, start: false, exports: [] }
  impure = false                         // touched something that exists only at run time
  demoted = false                        // an inferred integer type did not hold: compile again

  // state of the function being compiled
  mod!: Module
  private locals: number[] = []
  private nparam = 0
  private scopes: Map<string, Place | Val>[] = [new Map()]
  private depth = 0                      // enclosing wasm labels
  private loops: { brk: number; cont: number }[] = []
  private ret: Type = VOID
  private inl: { depth: number } | null = null
  private inlining: any[] = []
  private arrows = 0

  P: Program
  constructor(program: Program) { this.P = program }

  private err(msg: string, n: any): never { return fail(msg, { file: this.mod.file, pos: n.pos }) }

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
  /** Imports the function that the JavaScript expression `source` evaluates to. */
  private imp(source: string, params: number[], results: number[], pure: boolean): Func {
    if (!pure) this.impure = true
    const type = this.functype(params, results), key = `${source}\0${type}`
    let f = this.fimports.get(key)
    if (!f) this.fimports.set(key, f = { idx: 0, type, name: source, imp: source, locals: [], code: [] })
    return f
  }
  /** Imports the value of a JavaScript literal as a constant global. */
  private gimp(source: string): Glob {
    let g = this.gimports.get(source)
    if (!g) this.gimports.set(source, g = { idx: 0, w: EXT, mut: false, imp: source, init: [] })
    return g
  }
  /** A JavaScript constant: usable as a value, and written into any JavaScript expression that takes it. */
  private literal(k: string | null | undefined): Val {
    if (k === null) return { t: T.ext, c: [0xd0, EXT], k, pure: true, js: jsText('null') }
    const text = k === undefined ? 'undefined' : JSON.stringify(k)
    return { t: T.ext, c: [0x23, this.gimp(text)], ...(k !== undefined && { k }), pure: true, js: jsText(text) }
  }

  fn(d: any): Func {
    let f = this.fnOf.get(d)
    if (!f) {
      const sig = this.P.sig(d)
      f = { idx: 0, type: this.functype(sig.params.flatMap(t => t.flat), sig.ret.flat), name: d.name, locals: [], code: [] }
      this.fnOf.set(d, f)
      this.funcs.push(f)
      this.queue.push(d)
    }
    return f
  }
  private slot(f: Func): number {
    let i = this.slots.indexOf(f)
    if (i < 0) i = this.slots.push(f) - 1
    return i + 1
  }
  private zero(t: Type): any { return t.w === V128 ? [0, 0, 0, 0] : t.w === EXT ? null : 0 }
  private globalsOf(d: any): Glob[] {
    let g = this.globOf.get(d)
    if (!g) {
      const info = this.P.varInfo(d)
      if (info.runtime) this.impure = true
      const ks = info.bytes !== undefined ? [this.addr(d), info.ks![1]] : info.runtime ? undefined : info.ks
      g = info.t.leaves.map((l, i) => ({ idx: 0, w: l.w, mut: true, init: this.kval(l, ks ? ks[i] : this.zero(l)).c }))
      this.globals.push(...g)
      this.globOf.set(d, g)
    }
    return g
  }
  /** The address of a static array, registering its initial bytes with this module. */
  private addr(d: any): number {
    const a = this.P.addr(d)
    if (!this.statics.has(d)) {
      this.statics.add(d)
      this.usesMem = true
      const data = this.P.varInfo(d).data
      if (data) this.segs.push({ addr: a, bytes: data })
    }
    return a
  }
  /** A bump allocator for `new Float32Array(n)` at run time: memory grows, nothing is freed. */
  private alloc$(): Func {
    if (this.allocFn) return this.allocFn
    this.usesMem = true
    this.globals.push(this.heap = { idx: 0, w: I32, mut: false, init: [] })
    const next: Glob = { idx: 0, w: I32, mut: true, init: [0x41, 0] }
    this.globals.push(next)
    const code: Code = [
      0x23, next, 0x45, 0x04, 0x40, 0x23, this.heap, 0x24, next, 0x0b,                       // first use: start at the heap's base
      0x23, next, 0x22, 1, 0x20, 0, 0x41, 15, 0x6a, 0x41, 0x70, 0x71, 0x6a, 0x22, 2,       // at = next; end = at + round16(bytes)
      0x3f, 0, 0x41, 16, 0x74, 0x4b, 0x04, 0x40,                                            // if end > pages << 16
      0x20, 2, 0x3f, 0, 0x41, 16, 0x74, 0x6b, 0x41, ...sleb(65535), 0x6a, 0x41, 16, 0x76,   //   needed pages...
      0x22, 3, 0x41, 16, 0x20, 3, 0x41, 16, 0x4b, 0x1b,                                     //   ...at least 1 MiB at a time
      0x40, 0, 0x41, 0x7f, 0x46, 0x04, 0x40, 0x00, 0x0b, 0x0b,                              //   grow, or trap when out of memory
      0x20, 2, 0x24, next, 0x20, 1,
    ]
    this.funcs.push(this.allocFn = { idx: 0, type: this.functype([I32], [I32]), name: 'allocate', locals: [I32, I32, I32], code })
    return this.allocFn
  }

  // ---- values

  private kval(t: Type, k: any): Val {
    if (t.kind === 'lit') return { t, c: [], k, pure: true }
    if (t.kind === 'fn') return { t, c: i32const(k), k, pure: true }
    switch (t.w) {
      case I32: k = t.kind === 'bool' ? +!!k : t.signed ? k | 0 : k >>> 0; return { t, c: i32const(k), k, pure: true }
      case F32: k = Math.fround(k); return { t, c: [0x43, ...f32bytes(k)], k, pure: true }
      case F64: return { t, c: [0x44, ...f64bytes(k)], k, pure: true }
      case V128: return { t, c: [0xfd, 0x0c, ...k.flatMap(f32bytes)], k, pure: true }
      default: return this.literal(k)
    }
  }
  private local$(t: Type): number {
    const i = this.nparam + this.locals.length
    this.locals.push(...t.flat)
    return i
  }
  private sets(i: number, n: number): Code {
    const c: Code = []
    for (let j = n - 1; j >= 0; j--) c.push(...localSet(i + j))
    return c
  }
  /** Moves a value into fresh locals so it can be read any number of times. */
  private spill(v: Val): Place {
    if (v.ks) return { p: 'const', t: v.t, ks: v.ks, o: 0 }
    if (v.k !== undefined && v.t.flat.length <= 1) return { p: 'const', t: v.t, ks: [v.k], o: 0 }
    const i = this.local$(v.t)
    return { p: 'loc', t: v.t, i, pre: [...v.c, ...this.sets(i, v.t.flat.length)] }
  }
  /** Splits a value into run-once code and a cheap, repeatable read. */
  private stable(v: Val): [Code, Val] {
    if (v.pure && v.c.length <= 8) return [[], v]
    const i = this.local$(v.t)
    return [[...v.c, ...localSet(i)], { t: v.t, c: localGet(i), pure: true }]
  }
  /** Each wasm value of `v` as a value of its own. Returns code to run first. */
  private parts(v: Val): [Code, Val[]] {
    const pl = this.spill(v)
    return [pl.pre ?? [], v.t.leaves.map((l, j) => this.load(this.project(pl, l, j)))]
  }
  /** A typed array's pointer and length as separate values, read in place when it is a variable. */
  private span(r: Val | Place): [Code, Val, Val] {
    if (isPlace(r) && r.p !== 'mem') return [r.pre ?? [], this.load(this.project(r, T.i32, 0)), this.load(this.project(r, T.i32, 1))]
    const v = isPlace(r) ? this.load(r) : r
    if (v.ks) return [[], this.kval(T.i32, v.ks[0]), this.kval(T.i32, v.ks[1])]
    const [pre, [ptr, len]] = this.parts(v)
    return [pre, ptr, len]
  }
  private project(pl: Place, t: Type, slot: number): Place {
    if (pl.p === 'loc') return { p: 'loc', t, i: pl.i + slot }
    if (pl.p === 'glob') return { p: 'glob', t, g: pl.g, o: pl.o + slot }
    if (pl.p === 'const') return { p: 'const', t, ks: pl.ks, o: pl.o + slot }
    return pl
  }

  private load(pl: Place): Val {
    const pre = pl.pre ?? [], n = pl.t.flat.length
    switch (pl.p) {
      case 'const': {
        if (pl.t.flat.length <= 1) return this.kval(pl.t, pl.ks[pl.o])
        const ks = pl.ks.slice(pl.o, pl.o + n)
        return { t: pl.t, c: ks.flatMap((k, i) => this.kval(pl.t.leaves[i], k).c), ks, pure: true }
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
      case 'mem': return { t: loaded(pl.t), c: [...pre, ...pl.base.c, ...loadOp(pl.t), ...memarg(pl.t, pl.off)] }
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
      case 'mem': return [...pre, ...pl.base.c, ...v.c, ...storeOp(pl.t), ...memarg(pl.t, pl.off)]
    }
  }

  // ---- conversions: each one is what JavaScript does to the same value

  private toF64(v: Val): Val {
    if (v.t === T.f64) return v
    if (v.k !== undefined) return this.kval(T.f64, Number(v.k))
    if (v.t === T.f32) return { t: T.f64, c: [...v.c, 0xbb], pure: v.pure }
    return { t: T.f64, c: [...v.c, v.t === T.u32 ? 0xb8 : 0xb7], pure: v.pure }
  }
  /** ToInt32: wraps modulo 2^32, exactly, for every finite value below 2^63. */
  private toI32(v: Val, t: Type = T.i32): Val {
    if (v.k !== undefined) return this.kval(t, t === T.u32 ? v.k >>> 0 : v.k | 0)
    if (v.t.w === I32) return { ...v, t }
    return { t, c: [...v.c, 0xfc, v.t === T.f32 ? 4 : 6, 0xa7], pure: v.pure }
  }
  private toF32(v: Val): Val {
    if (v.t === T.f32) return v
    if (v.k !== undefined) return this.kval(T.f32, Number(v.k))
    return { t: T.f32, c: [...v.c, v.t === T.f64 ? 0xb6 : v.t === T.u32 ? 0xb3 : 0xb2], pure: v.pure }
  }
  /** A float32 from an expression, with no detour through float64 when it already is one. */
  private single(n: any): Val {
    let v = this.expr(n)
    if (v.t === HOST) v = this.force(v, T.f32, n)
    if (!isNum(v.t)) this.err(`expected a number, found ${v.t.name}`, n)
    return this.toF32(v)
  }
  /** What a typed array stores when given `v`. */
  private toElement(v: Val, el: Type, n: any): Val {
    if (v.t === HOST) v = this.force(v, el.kind === 'float' ? T.f64 : T.i32, n)
    if (!isNum(v.t)) this.err(`cannot store ${v.t.name} in a ${el.name} element`, n)
    return el === T.f32 ? this.toF32(v) : el === T.f64 ? this.toF64(v) : this.toI32(v)
  }

  /** Converts `v` to type `t` where JavaScript would not notice the difference; otherwise an error. */
  coerce(v: Val, t: Type, n: any): Val {
    if (v.t === t) return v
    if (v.t === HOST) return this.force(v, t, n)
    if (t === T.ext || t === HOST) return this.force(this.lazy(this.js(v, n)), T.ext, n)     // hand a Wasm value to JavaScript
    if (v.t === T.ext && (isNum(t) || t === T.bool)) return this.force(this.lazy(this.js(v, n)), t, n)   // and read one back
    if (v.t === FNREF && t.kind === 'fn') {
      const s = this.P.sig(v.fn)
      if (this.P.fnType(s.params, s.ret) !== t) this.err(`'${v.fn.name}' is not a ${t.name}`, n)
      return this.kval(t, this.slot(this.fn(v.fn)))
    }
    if (v.t.kind === 'lit') {
      if (t === T.f64) return this.kval(t, v.k)
      if (t === T.f32 && Math.fround(v.k) === v.k) return this.kval(t, v.k)
      if (t.kind === 'int' && Number.isInteger(v.k) && (t === T.u32 ? v.k >= 0 && v.k < 2 ** 32 : v.k >= -(2 ** 31) && v.k < 2 ** 31)) return this.kval(t, v.k)
    } else if (t === T.f64 && (v.t.kind === 'int' || v.t === T.f32)) return this.toF64(v)
    const hint = t === T.i32 && isNum(v.t) ? ': write `| 0` to truncate'
      : t === T.u32 && isNum(v.t) ? ': write `>>> 0`'
      : t === T.f32 && isNum(v.t) ? ': write Math.fround(...)' : ''
    return this.err(`expected ${t.name}, found ${v.t.name}${hint}`, n)
  }
  /** The type an unannotated `let` gets from its first value. */
  private settle(v: Val, node: any): Val {
    if (v.t === HOST) return this.force(v, v.js!.gives ?? T.ext, node)
    if (v.t === FNREF) return this.coerce(v, this.P.fnTypeOf(v.fn), node)
    if (node && this.P.isWide(this.mod, node) && isNum(v.t)) return this.toF64(v)
    if (v.t === INT) return Number.isInteger(v.k) && Math.abs(v.k) < 2 ** 31 ? this.kval(T.i32, v.k) : this.kval(T.f64, v.k)
    if (v.t === FLOAT) return this.toF64(v)
    return v
  }
  /** A condition: non-zero is true. `normalize` forces exactly 0 or 1. */
  private truthy(v: Val, n: any, normalize = false): Val {
    if (v.t === T.bool) return v
    if (isJs(v.t)) return this.force(v.t === HOST ? v : this.lazy(this.js(v, n)), T.bool, n)
    if (v.k !== undefined && isNum(v.t)) return this.kval(T.bool, !!v.k)
    if (v.t.kind === 'int') return { t: T.bool, c: normalize ? [...v.c, 0x45, 0x45] : v.c, pure: v.pure }
    if (v.t === T.f64) return { t: T.bool, c: [...v.c, 0x99, 0x44, ...f64bytes(0), 0x64], pure: v.pure }     // |x| > 0: false for 0 and NaN
    if (v.t === T.f32) return { t: T.bool, c: [...v.c, 0x8b, 0x43, ...f32bytes(0), 0x5e], pure: v.pure }
    return this.err(`${v.t.name} cannot be a condition`, n)
  }

  // ---- JavaScript expressions

  private lazy(js: Js): Val { return { t: HOST, c: [], js } }

  /** Any value as part of a JavaScript expression: constants as text, the rest as arguments. */
  private js(v: Val, n: any): Js {
    if (v.js) return v.js
    if (v.t.kind === 'lit' || (v.k !== undefined && isNum(v.t))) return jsText(Object.is(v.k, -0) ? '-0' : String(v.k), v.k < 0 || Object.is(v.k, -0) ? 15 : 18)
    if (v.t === T.bool && v.k !== undefined) return jsText(v.k ? 'true' : 'false')
    const one = (x: Val, text: (string | number)[] = [0]): Js => ({ src: text, params: [x], ops: false, pure: true, prec: 20 })
    switch (v.t.kind) {
      case 'int': return v.t === T.u32 ? one(this.toF64(v)) : one(v)
      case 'float': case 'ext': return one(v)
      case 'bool': return { ...one(v, ['!!', 0]), prec: 15 }
      case 'fnref': { const f = this.fn(v.fn); this.elems.add(f); return one({ t: T.funcref, c: [0xd2, f], pure: true }) }
      case 'fn': return one({ t: T.funcref, c: [...v.c, 0x25, 0], pure: v.pure })
      case 'array': {
        const [pre, [ptr, len]] = this.parts(v)
        ptr.c = [...pre, ...ptr.c]
        if (pre.length) ptr.pure = false
        return jsJoin([`V$(${v.t.ctor},`, this.js(ptr, n), ',', this.js(len, n), ')'], 20)
      }
      case 'struct': {
        const [pre, vals] = this.parts(v)
        if (pre.length) { vals[0].c = [...pre, ...vals[0].c]; vals[0].pure = false }
        const build = (t: Type, at: number): Js => jsJoin(['{', ...t.fields!.flatMap((f, i) =>
          [i ? ',' : '', f.name + ':', f.t.kind === 'struct' ? build(f.t, at + f.slot) : this.js(vals[at + f.slot], n)]), '}'], 20)
        return { ...build(v.t, 0), object: true }
      }
    }
    return this.err(`cannot pass ${v.t.name} to JavaScript`, n)
  }

  /**
   * JavaScript evaluates its operands left to right. Fused into one function, the Wasm
   * arguments are all computed first; where that could be seen (an argument with an effect,
   * after a JavaScript operation), the earlier operations are done in calls of their own.
   */
  private ordered(parts: Js[], n: any): Js[] {
    let ops = false
    for (let i = 0; i < parts.length; i++) {
      if (ops && parts[i].params.some(x => !x.pure)) {
        for (let j = 0; j < i; j++) if (parts[j].ops) parts[j] = this.js(this.force(this.lazy(parts[j]), T.ext, n), n)
        ops = false
      }
      ops ||= parts[i].ops
    }
    return parts
  }

  /** Emits a JavaScript expression as one imported function and calls it, converting the result to `want`. */
  force(v: Val, want: Type, n: any): Val {
    let js = v.js!
    if (want === HOST) want = T.ext
    if (want === T.bool) js = jsJoin(['!!', jsWrap(js, 15)], 15)
    else if (want.kind === 'fn' || want.kind === 'struct' || want.kind === 'array' || want.kind === 'vec')
      this.err(`cannot read ${want.name} from a JavaScript value`, n)
    if (!js.params.length && !js.ops && want === T.ext && /^("|`|-?\d|null$|undefined$|true$|false$)/.test(js.src.join(''))) {
      return { t: T.ext, c: [0x23, this.gimp(js.src.join(''))], pure: true, js }          // a literal: no call needed
    }
    const body = js.object ? jsJoin(['(', js, ')'], 20) : js
    const source = `(${js.params.map((_, i) => param(i))})=>` + body.src.map(s => typeof s === 'number' ? param(s) : s).join('')
    const f = this.imp(source, js.params.flatMap(p => p.t.flat), want.flat, js.pure)
    return { t: want, c: [...js.params.flatMap(p => p.c), 0x10, f] }
  }

  private jsMember(obj: Js, n: any): Js {
    return jsJoin([jsWrap(obj, 19), n.opt ? '?.' : '.', n.name], 19, true)
  }
  private jsCall(callee: Js, args: any[], n: any, isNew = false): Js {
    const parts = this.ordered([callee, ...args.map(a => this.js(this.expr(a), a))], n)
    const text: (string | Js)[] = [isNew ? 'new ' : '', jsWrap(parts[0], 19), n.opt ? '?.(' : '(']
    parts.slice(1).forEach((p, i) => text.push(i ? ',' : '', jsWrap(p, 2)))
    const out = jsJoin([...text, ')'], 19, true)
    out.pure = /^Math\.\w+$/.test(callee.src.join('')) && out.pure
    return out
  }
  private jsBinary(op: string, a: Val, b: Val, n: any): Js {
    const p = JS_PREC[op], [x, y] = this.ordered([this.js(a, n), this.js(b, n)], n)
    const gives = '-*/%'.includes(op) ? T.f64 : op === '>>>' ? T.u32 : BITWISE.has(op) ? T.i32 : COMPARE.has(STRICT[op] ?? op) ? T.bool : undefined
    return { ...jsJoin([jsWrap(x, p), op, jsWrap(y, p + 1)], p), gives }
  }

  // ---- expressions

  /** The value of `n`. `want` is the type the context expects, when it has one: it decides what literals become. */
  expr(n: any, want?: Type): Val {
    const r = this.ref(n, want)
    return isPlace(r) ? this.load(r) : r
  }
  private value(n: any, t: Type): Val { return this.coerce(this.expr(n, t), t, n) }

  private local(id: string): Place | Val | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const p = this.scopes[i].get(id); if (p) return p }
  }
  private global(d: any): Place {
    const info = this.P.varInfo(d)
    for (const s of info.deps ?? []) this.addr(s)          // a view of another static: that one's data comes along
    if (info.ks && d.isConst) return { p: 'const', t: info.t, o: 0, ks: info.bytes !== undefined ? [this.addr(d), info.ks[1]] : info.ks }
    return { p: 'glob', t: info.t, g: this.globalsOf(d), o: 0, decl: info.inferred ? d : undefined }
  }

  /** Evaluates to a place when `n` names one (so it can be assigned or projected), else to a value. */
  private ref(n: any, want?: Type): Val | Place {
    switch (n.n) {
      case 'id': {
        const local = this.local(n.name)
        if (local) return local
        const r = this.P.resolve(this.mod, n.name)
        if (!r) {
          if (n.name === 'undefined') return this.literal(undefined)
          if (n.name === 'NaN' || n.name === 'Infinity') return this.kval(FLOAT, n.name === 'NaN' ? NaN : Infinity)
          return this.lazy({ ...jsText(n.name), pure: n.name === 'Math' })                 // a JavaScript global
        }
        if (r.text !== undefined) return this.literal(r.text)
        if (r.intrinsic) return this.err(`'${n.name}' is not a value: call it, or use its methods`, n)
        if (r.d.n === 'fn') return { t: FNREF, c: [], fn: r.d, pure: true }
        if (r.d.n === 'var') return this.global(r.d)
        return this.err(`'${n.name}' is a type`, n)
      }
      case 'idx': {
        const r = this.ref(n.e)
        if (r.t.kind === 'array') return this.element(r, n.i, r.t.el!, n)
        const o = isPlace(r) ? this.load(r) : r
        if (isJs(o.t)) return this.lazy(jsJoin([jsWrap(this.js(o, n), 19), n.opt ? '?.[' : '[', this.js(this.expr(n.i), n.i), ']'], 19, true))
        return this.err(`cannot index ${o.t.name}`, n)
      }
      case 'fld': {
        if (n.e.n === 'id' && n.e.name === 'Math' && !this.local('Math') && !this.P.resolve(this.mod, 'Math') && typeof (Math as any)[n.name] === 'number')
          return this.kval(FLOAT, (Math as any)[n.name])
        const r = this.ref(n.e)
        if (isPlace(r) && r.t.kind === 'struct') return this.field(r, n)
        const v = isPlace(r) ? this.load(r) : r
        if (v.t.kind === 'array') {
          if (n.name !== 'length' && n.name !== 'byteLength') this.err(`a typed array has no property '${n.name}' here`, n)
          const [pre, , len] = this.span(r), size = n.name === 'length' ? 1 : v.t.el!.size
          if (len.k !== undefined) return this.kval(T.i32, len.k * size)
          return { t: T.i32, c: [...pre, ...len.c, ...(size > 1 ? [...i32const(size), 0x6c] : [])], pure: !pre.length && len.pure }
        }
        if (v.t.kind === 'struct') return this.field(this.spill(v), n)
        if (v.t === T.f32x4 && n.name.length === 1 && LANES.includes(n.name)) {
          const lane = LANES.indexOf(n.name)
          return v.k ? this.kval(T.f32, v.k[lane]) : { t: T.f32, c: [...v.c, ...simd(0x1f), lane], pure: v.pure }
        }
        if (isJs(v.t)) return this.lazy(this.jsMember(this.js(v, n), n))
        return this.err(`${v.t.name} has no property '${n.name}'`, n)
      }
      case 'num': return { t: n.float ? FLOAT : INT, c: [], k: n.v, pure: true }
      case 'bool': return this.kval(T.bool, n.v)
      case 'null': return this.literal(null)
      case 'str': return this.literal(n.v)
      case 'tpl': {
        const parts: (string | Js)[] = ['`']
        const exprs = this.ordered(n.exprs.map((e: any) => this.js(this.expr(e), e)), n)
        n.quasis.forEach((q: string, i: number) => {
          parts.push(JSON.stringify(q).slice(1, -1).replace(/`/g, '\\`').replace(/\$\{/g, '\\${'))
          if (i < exprs.length) parts.push('${', exprs[i], '}')
        })
        return this.lazy(jsJoin([...parts, '`'], 20))
      }
      case 'bin': return this.binary(n)
      case 'un': return this.unary(n)
      case 'incr': return this.increment(n)
      case 'as': {
        const t = this.P.type(n.t, this.mod), v = this.expr(n.e, t)
        if (v.t === HOST) return isJs(t) ? v : this.force(v, t, n)          // `x as number`: read the JavaScript value as one
        if (v.t.kind === 'lit' && isNum(t)) return this.coerce(v, t, n)
        return v                                                           // otherwise a note for the type checker only
      }
      case 'call': return this.call(n)
      case 'new': return this.construct(n)
      case 'cond': return this.ternary(n, want)
      case 'obj': return want?.kind === 'struct' ? this.structLiteral(n, want) : this.lazy(this.jsObject(n))
      case 'arr': return this.lazy(jsJoin(['[', ...this.ordered(n.items.map((e: any) => jsWrap(this.js(this.expr(e), e), 3)), n).flatMap((p, i) => i ? [',', p] : [p]), ']'], 20))
      case 'arrow': return { t: FNREF, c: [], fn: this.liftArrow(n, want), pure: true }
    }
    return this.err('expected an expression', n)
  }

  private field(pl: Place, n: any): Place {
    const f = pl.t.fields!.find(f => f.name === n.name) ?? this.err(`${pl.t.name} has no property '${n.name}'`, n)
    return { ...this.project(pl, f.t, f.slot), pre: pl.pre }
  }

  /** The memory an element of a typed array occupies. */
  private element(arr: Val | Place, index: any, el: Type, n: any): Place {
    this.usesMem = true
    const [pre, ptr] = this.span(arr)
    let extra = 0
    if (index.n === 'bin' && index.op === '+') {          // a[i + 2]: the constant part goes into the load's offset
      const x = this.expr(index.a), y = this.expr(index.b)
      const k = (v: Val) => v.k !== undefined && isNum(v.t) && Number.isInteger(v.k) && v.k >= 0 && v.k < 2 ** 20
      if (k(y) && x.t === T.i32 && x.k === undefined) { index = index.a; extra = y.k * el.size }
      else if (k(x) && y.t === T.i32 && y.k === undefined) { index = index.b; extra = x.k * el.size }
    }
    let i = this.expr(index)
    if (i.t === HOST) i = this.force(i, T.i32, index)
    if (!isNum(i.t)) this.err(`an index must be a number, found ${i.t.name}`, index)
    i = this.toI32(i)
    if (i.k !== undefined) {
      const off = i.k * el.size
      if (off >= 0) return { p: 'mem', t: el, base: ptr, off, pre }
      return { p: 'mem', t: el, base: { t: T.i32, c: [...ptr.c, ...i32const(off), 0x6a], pure: ptr.pure }, off: 0, pre }
    }
    if (extra) {
      const at = this.element(arr, index, el, n) as Place & { p: 'mem' }
      return { ...at, off: at.off + extra }
    }
    // Indexing by a loop counter reads a second counter that advances by the element size,
    // instead of multiplying on every access.
    const counter = index.n === 'id' && el.size > 1 ? this.local(index.name) : undefined
    let scaled: Code
    if (counter && isPlace(counter) && counter.p === 'loc' && counter.scaled) {
      let l = counter.scaled.get(el.size)
      if (l === undefined) counter.scaled.set(el.size, l = this.local$(T.i32))
      scaled = localGet(l)
    } else {
      const shift = Math.log2(el.size)
      scaled = el.size === 1 ? i.c : Number.isInteger(shift) ? [...i.c, 0x41, shift, 0x74] : [...i.c, ...i32const(el.size), 0x6c]
    }
    return ptr.k !== undefined
      ? { p: 'mem', t: el, base: { t: T.i32, c: scaled, pure: i.pure }, off: ptr.k, pre }
      : { p: 'mem', t: el, base: { t: T.i32, c: [...ptr.c, ...scaled, 0x6a], pure: ptr.pure && i.pure }, off: 0, pre }
  }

  private structLiteral(n: any, t: Type): Val {
    const given = new Map<string, any>(n.props)
    for (const [k] of n.props) if (!t.fields!.some(f => f.name === k)) this.err(`${t.name} has no property '${k}'`, n)
    const vals = t.fields!.map(f => this.value(given.get(f.name) ?? this.err(`property '${f.name}' is missing`, n), f.t))
    const inOrder = n.props.every(([k]: [string], i: number) => t.fields![i]?.name === k) || vals.every(v => v.pure)
    if (!inOrder) this.err(`write the properties of ${t.name} in the order it declares them`, n)
    const ks = vals.every(v => v.k !== undefined || v.ks) ? vals.flatMap(v => v.ks ?? [v.k]) : undefined
    return { t, c: vals.flatMap(v => v.c), ks, pure: vals.every(v => v.pure) }
  }
  private jsObject(n: any): Js {
    const vals = this.ordered(n.props.map(([, e]: [string, any]) => jsWrap(this.js(this.expr(e), e), 3)), n)
    const parts: (string | Js)[] = ['{']
    n.props.forEach(([k]: [string], i: number) => parts.push(i ? ',' : '', /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k), ':', vals[i]))
    return { ...jsJoin([...parts, '}'], 20), object: true }
  }

  private binary(n: any): Val {
    if (n.op === '&&' || n.op === '||' || n.op === '??') return this.logic(n)
    // (a / b) | 0 is JavaScript's integer division
    if (n.a.n === 'bin' && n.a.op === '/' && (n.op === '|' || n.op === '>>>' || n.op === '>>') && n.b.n === 'num' && n.b.v === 0) {
      let x = this.expr(n.a.a), y = this.expr(n.a.b)
      if (x.t === INT && y.t.kind === 'int') x = this.coerce(x, y.t, n); else if (y.t === INT && x.t.kind === 'int') y = this.coerce(y, x.t, n)
      const t = n.op === '>>>' ? T.u32 : T.i32
      if (x.t === t && y.t === t && !(x.k !== undefined && y.k !== undefined))
        return { t, c: [...x.c, ...y.c, t === T.u32 ? 0x6e : 0x6d] }
      return this.arith(n.op, this.arith('/', x, y, n.a), this.expr(n.b), n)
    }
    return this.arith(n.op, this.expr(n.a), this.expr(n.b), n)
  }

  private arith(jsOp: string, a: Val, b: Val, n: any): Val {
    const op = STRICT[jsOp] ?? jsOp
    if (isJs(a.t) || isJs(b.t)) return this.lazy(this.jsBinary(jsOp, a, b, n))             // strings, DOM values: JavaScript's operator
    for (const v of [a, b]) if (!isNum(v.t) && !(v.t === T.bool && (op === '==' || op === '!='))) this.err(`${v.t.name} does not support '${jsOp}'`, n)
    const cmp = COMPARE.has(op)
    const constant = (t: Type) => {
      if (a.k === undefined || b.k === undefined) return undefined
      const k = fold(op, t, a.k, b.k)
      if (k === undefined) return undefined
      if (typeof k === 'boolean') return this.kval(T.bool, k)
      if (t.kind !== 'lit') return this.kval(t, k)
      return this.kval(BITWISE.has(op) || (Number.isInteger(k) && a.t === INT && b.t === INT) ? INT : FLOAT, k)
    }
    if (a.t.kind === 'lit' && b.t.kind === 'lit') return constant(INT) ?? this.err(`cannot evaluate ${a.k} ${jsOp} ${b.k}`, n)

    if (BITWISE.has(op)) {                               // operands become int32, as in JavaScript
      const t = op === '>>>' ? T.u32 : T.i32
      const x = this.toI32(a), y = this.toI32(b)
      if (x.k !== undefined && y.k !== undefined) return this.kval(t, fold(op, T.i32, x.k, y.k))
      if (y.k === 0 && op !== '&') return { ...x, t }    // x | 0, x >>> 0: only the conversion
      return { t, c: [...x.c, ...y.c, INT_OPS[op] as number], pure: x.pure && y.pure }
    }
    // a literal takes the other side's integer type when it fits
    if (a.t === INT && b.t.kind === 'int' && Number.isInteger(a.k) && (b.t === T.i32 ? Math.abs(a.k) < 2 ** 31 : a.k >= 0 && a.k < 2 ** 32)) a = this.kval(b.t, a.k)
    else if (b.t === INT && a.t.kind === 'int' && Number.isInteger(b.k) && (a.t === T.i32 ? Math.abs(b.k) < 2 ** 31 : b.k >= 0 && b.k < 2 ** 32)) b = this.kval(a.t, b.k)

    if (a.t === T.bool) {
      if (b.t !== T.bool) this.err(`cannot compare boolean with ${b.t.name}`, n)
      return constant(T.bool) ?? { t: T.bool, c: [...a.c, ...b.c, INT_OPS[op] as number], pure: a.pure && b.pure }
    }
    // i32 arithmetic stays i32 (it is assumed not to overflow); u32 values are large by nature, so
    // their + - * are done as numbers. / is always JavaScript's real division.
    if (a.t.kind === 'int' && a.t === b.t && op !== '/' && (a.t === T.i32 || cmp || op === '%')) {
      const e = INT_OPS[op], o = typeof e === 'number' ? e : e[a.t.signed ? 0 : 1]
      return constant(a.t) ?? { t: cmp ? T.bool : a.t, c: [...a.c, ...b.c, o], pure: a.pure && b.pure && op !== '%' }
    }
    if (op === '%') return this.force(this.lazy({ ...this.jsBinary('%', this.toF64(a), this.toF64(b), n), pure: true }), T.f64, n)
    let x = this.toF64(a), y = this.toF64(b)
    const folded = x.k !== undefined && y.k !== undefined ? fold(op, T.f64, x.k, y.k) : undefined
    if (folded !== undefined) return this.kval(cmp ? T.bool : T.f64, folded)
    if (op === '*' && x.k === 2) [x, y] = [y, x]
    if (op === '*' && y.k === 2) {                         // x * 2 → x + x: exact, and engines do not do it
      const [once, v] = this.stable(x)
      return { t: T.f64, c: [...once, ...v.c, ...v.c, 0xa0], pure: x.pure && !once.length }
    }
    let o = F64_OPS[op]
    const exp = op === '/' && y.k !== undefined ? Math.log2(Math.abs(y.k)) : NaN
    if (Number.isInteger(exp) && Math.abs(exp) < 1022) { o = 0xa2; y = this.kval(T.f64, 1 / y.k) }     // x / 2ⁿ → x * 2⁻ⁿ: exact
    return { t: cmp ? T.bool : T.f64, c: [...x.c, ...y.c, o], pure: x.pure && y.pure }
  }

  private logic(n: any): Val {
    const and = n.op === '&&'
    const a = this.expr(n.a)
    if (n.op === '??' || isJs(a.t)) return this.lazy(this.jsBinary(n.op, a, this.expr(n.b), n))
    const x = this.truthy(a, n.a, true)
    if (x.k !== undefined) {                              // the other side is never compiled
      if (!!x.k !== and) return x
      const b = this.expr(n.b)
      return isJs(b.t) ? b : this.truthy(b, n.b, true)
    }
    const b = this.expr(n.b)
    if (isJs(b.t)) return this.lazy(this.jsBinary(n.op, x, b, n))
    const y = this.truthy(b, n.b, true)
    if (y.pure && y.c.length <= 32) return { t: T.bool, c: [...x.c, ...y.c, and ? 0x71 : 0x72], pure: x.pure }    // cheap and safe: no branch
    return { t: T.bool, c: and ? [...x.c, 0x04, I32, ...y.c, 0x05, 0x41, 0, 0x0b] : [...x.c, 0x04, I32, 0x41, 1, 0x05, ...y.c, 0x0b] }
  }

  private unary(n: any): Val {
    const v = this.expr(n.e), t = v.t
    if (n.op === 'typeof ' || (isJs(t) && n.op !== '!'))
      return this.lazy({ ...jsJoin([n.op, jsWrap(this.js(v, n), 15)], 15), gives: n.op === '~' ? T.i32 : n.op === 'typeof ' ? undefined : T.f64 })
    if (n.op === '!') {
      const c = this.truthy(v, n)
      return c.k !== undefined ? this.kval(T.bool, !c.k) : { t: T.bool, c: [...c.c, 0x45], pure: c.pure }
    }
    if (!isNum(t)) this.err(`${t.name} does not support unary '${n.op}'`, n)
    if (n.op === '+') return v
    if (n.op === '~') return this.arith('^', this.toI32(v), this.kval(T.i32, -1), n)
    if (v.k !== undefined) return this.kval(t === T.u32 ? T.f64 : t, -v.k)
    if (t === T.i32) return { t, c: [0x41, 0, ...v.c, 0x6b], pure: v.pure }
    return { t: T.f64, c: [...this.toF64(v).c, 0x9a], pure: v.pure }
  }

  /** x++, ++x and the two decrements, as a value. */
  private increment(n: any): Val {
    const r = this.ref(n.e)
    if (!isPlace(r)) {
      if (r.t !== HOST) this.err('cannot increment this', n)
      const op = n.d > 0 ? '++' : '--'
      return this.lazy(jsJoin(n.prefix ? [op, r.js!] : [r.js!, op], 15, true))
    }
    if (r.p === 'const') this.err('cannot assign to a constant', n)
    if (!isNum(loaded(r.t))) this.err(`cannot increment ${r.t.name}`, n)
    let once: Code = r.pre ?? [], pl: Place = { ...r, pre: undefined }
    if (pl.p === 'mem') { const [c, base] = this.stable(pl.base); once = [...once, ...c]; pl = { ...pl, base } }
    const old = this.spill({ ...this.load(pl), k: undefined, pure: false }) as Place & { p: 'loc' }
    const before = this.load({ ...old, pre: undefined }), after = this.arith(n.d > 0 ? '+' : '-', before, this.kval(INT, 1), n)
    const stored = pl.p === 'mem' ? this.toElement(after, pl.t, n) : after
    return { t: before.t, c: [...once, ...old.pre!, ...this.store(pl, stored, n), ...(n.prefix ? after : before).c] }
  }

  private ternary(n: any, want?: Type): Val {
    const c = this.truthy(this.expr(n.c), n.c)
    if (c.k !== undefined) return this.expr(c.k ? n.a : n.b, want)           // the other branch is never compiled
    let a = this.expr(n.a, want), b = this.expr(n.b, want)
    if (isJs(a.t) || isJs(b.t)) return this.lazy(jsJoin([jsWrap(this.js(c, n), 4), '?', jsWrap(this.js(a, n), 3), ':', jsWrap(this.js(b, n), 3)], 3))
    if (a.t !== b.t || a.t.kind === 'lit' || a.t === FNREF) {               // settle on the type both fit in
      const t = want && want !== HOST && want !== VOID ? want
        : a.t.kind === 'lit' && b.t.kind === 'lit' ? (a.t === INT && b.t === INT ? T.i32 : T.f64)
        : a.t === INT && b.t.kind === 'int' ? b.t : b.t === INT && a.t.kind === 'int' ? a.t
        : isNum(a.t) && isNum(b.t) ? T.f64
        : a.t === FNREF ? (b.t === FNREF ? this.P.fnTypeOf(a.fn) : b.t) : a.t
      a = this.coerce(a, t, n.a); b = this.coerce(b, t, n.b)
    }
    const t = a.t
    if (a.pure && b.pure && t.flat.length === 1 && t.w !== EXT && a.c.length + b.c.length <= 24)
      return { t, c: [...a.c, ...b.c, ...c.c, 0x1b], pure: c.pure }          // branch-free select
    return { t, c: [...c.c, 0x04, ...this.blockType(t), ...a.c, 0x05, ...b.c, 0x0b] }
  }

  // ---- calls

  private call(n: any): Val {
    const f = n.f
    if (f.n === 'id') {
      const b = this.local(f.name)
      if (b) return this.callValue(isPlace(b) ? this.load(b) : b, n)
      const r = this.P.resolve(this.mod, f.name)
      if (r?.intrinsic === 'f32x4') {
        if (n.args.length !== 4) this.err('f32x4(x, y, z, w)', n)
        const vs: Val[] = n.args.map((a: any) => this.single(a))
        if (vs.every(v => v.k !== undefined)) return this.kval(T.f32x4, vs.map(v => v.k))
        return { t: T.f32x4, c: [...vs[0].c, ...simd(0x13), ...[1, 2, 3].flatMap(i => [...vs[i].c, ...simd(0x20), i])], pure: vs.every(v => v.pure) }
      }
      if (r?.d) return this.callValue(this.expr(f), n)
    } else if (f.n === 'fld' && f.e.n === 'id' && !this.local(f.e.name)) {
      const r = this.P.resolve(this.mod, f.e.name)
      if (!r && f.e.name === 'Math') { const v = this.math(f.name, n); if (v) return v }
      if (r?.intrinsic === 'f32x4') return this.simd(f.name, n)
    }
    if (f.n === 'fld') {
      const r = this.ref(f.e)
      if (r.t.kind === 'array') return this.arrayMethod(r, f.name, n)
      const o = isPlace(r) ? this.load(r) : r
      if (!isJs(o.t)) this.err(`${o.t.name} has no method '${f.name}'`, n)
      return this.lazy(this.jsCall(this.jsMember(this.js(o, f), f), n.args, n))
    }
    return this.callValue(this.expr(f), n)
  }

  private callValue(v: Val, n: any): Val {
    if (v.t === FNREF) return this.callFn(v.fn, n)
    if (v.t.kind === 'fn') {
      const sig = v.t.sig!
      return { t: sig.ret, c: [...this.args(n, sig.params).flatMap(a => a.c), ...v.c, 0x11, ...uleb(this.functype(sig.params.flatMap(t => t.flat), sig.ret.flat)), 0] }
    }
    if (!isJs(v.t)) this.err(`${v.t.name} is not a function`, n)
    return this.lazy(this.jsCall(this.js(v, n), n.args, n))
  }

  private args(n: any, types: Type[]): Val[] {
    if (n.args.length !== types.length) this.err(`expected ${types.length} argument${types.length === 1 ? '' : 's'}, found ${n.args.length}`, n)
    return types.map((t, i) => this.value(n.args[i], t))
  }

  private callFn(d: any, n: any): Val {
    const sig = this.P.sig(d)
    const single = d.body.length === 1 && d.body[0].n === 'return'
    if ((d.inline || single) && !this.inlining.includes(d) && this.inlining.length < 40) return this.inline(d, n)
    return { t: sig.ret, c: [...this.args(n, sig.params).flatMap(v => v.c), 0x10, this.fn(d)] }
  }

  /** Expands a function in place. Constant arguments stay constant inside the body. */
  private inline(d: any, n: any): Val {
    const sig = this.P.sig(d)
    if (n.args.length !== sig.params.length) this.err(`expected ${sig.params.length} argument${sig.params.length === 1 ? '' : 's'}, found ${n.args.length}`, n)
    const vs = sig.params.map((t, i) => {                 // a function passed by name stays a direct call inside
      const v = this.expr(n.args[i], t)
      return v.t === FNREF && t.kind === 'fn' ? v : this.coerce(v, t, n.args[i])
    })
    if (!d.assigned) {
      d.assigned = new Set()
      walk(d.body, s => { if (s.n === 'assign' && s.to.n === 'id') d.assigned.add(s.to.name); if (s.n === 'incr' && s.e.n === 'id') d.assigned.add(s.e.name) })
    }
    const pre: Code = [], scope = new Map<string, Place | Val>()
    d.params.forEach((p: any, i: number) => {
      const v = vs[i]
      if (!d.assigned.has(p.name) && v.t === FNREF) return scope.set(p.name, v)
      if (!d.assigned.has(p.name) && (v.ks || v.k !== undefined)) return scope.set(p.name, { p: 'const', t: v.t, ks: v.ks ?? [v.k], o: 0 })
      const pl: Place = { p: 'loc', t: v.t, i: this.local$(v.t) }
      pre.push(...v.c, ...this.sets(pl.i, v.t.flat.length))
      scope.set(p.name, pl)
    })
    const saved = [this.scopes, this.loops, this.ret, this.inl, this.mod] as const
    this.scopes = [scope]; this.loops = []; this.ret = sig.ret; this.mod = d.mod
    this.inlining.push(d)
    let out: Val
    const only = d.body.length === 1 && d.body[0]
    if (only && only.n === 'return' && only.e) {
      const v = this.value(only.e, sig.ret)
      out = pre.length ? { t: v.t, c: [...pre, ...v.c] } : v
    } else {
      d.early ??= (() => { let found = false; walk(d.body, s => { if (s.n === 'return' && s !== d.body.at(-1)) found = true }); return found })()
      if (d.early) this.depth++
      this.inl = { depth: this.depth }
      const c = this.body(d.body, sig.ret)
      if (d.early) this.depth--
      out = { t: sig.ret, c: d.early ? [...pre, 0x02, ...this.blockType(sig.ret), ...c, 0x0b] : [...pre, ...c] }
    }
    this.inlining.pop()
    ;[this.scopes, this.loops, this.ret, this.inl, this.mod] = saved
    return out
  }

  /** An arrow function becomes a function at the top of the file. It may use only its parameters and what the file declares. */
  private liftArrow(n: any, want?: Type): any {
    if (n.decl) return n.decl
    const own = new Set<string>(n.params.map((p: any) => p.name))
    walk(n.body ?? n.value, s => { if (s.n === 'let') own.add(s.name) })
    walk(n.body ?? n.value, s => {
      if (s.n === 'id' && !own.has(s.name) && this.local(s.name)) this.err(`'${s.name}' is a local of the enclosing function: closures are not supported`, s)
    })
    const sig = want?.kind === 'fn' ? want.sig! : undefined
    const d: any = {
      n: 'fn', pos: n.pos, name: `arrow${++this.arrows}`, mod: this.mod, params: n.params, ret: n.ret,
      body: n.body ?? [n.ret || (sig && sig.ret !== VOID) ? { n: 'return', pos: n.pos, e: n.value } : { n: 'expr', pos: n.pos, e: n.value }],
    }
    if (sig) d.sig = { params: n.params.map((p: any, i: number) => p.t ? this.P.type(p.t, this.mod) : sig.params[i] ?? T.ext), ret: n.ret ? this.P.type(n.ret, this.mod) : sig.ret }
    return n.decl = d
  }

  /** Math.*: the ones Wasm has become instructions; the rest are JavaScript calls. */
  private math(fn: string, n: any): Val | undefined {
    const a = n.args as any[]
    const vs = a.map(x => this.expr(x))
    if (vs.some(v => !isNum(v.t))) return undefined
    const need = (count: number) => { if (a.length !== count) this.err(`Math.${fn} takes ${count} argument${count === 1 ? '' : 's'}`, n) }
    const consts = vs.every(v => v.k !== undefined)
    const f64 = (i: number) => this.toF64(vs[i])
    const op1 = (op: number, js: (x: number) => number): Val => {
      need(1)
      if (consts) return this.kval(vs[0].t.kind === 'lit' ? (Number.isInteger(js(vs[0].k)) && vs[0].t === INT ? INT : FLOAT) : T.f64, js(vs[0].k))
      if (vs[0].t.kind === 'int' && fn !== 'sqrt') return vs[0]            // already whole
      const x = f64(0)
      return { t: T.f64, c: [...x.c, op], pure: x.pure }
    }
    switch (fn) {
      case 'sqrt': return op1(0x9f, Math.sqrt)
      case 'floor': return op1(0x9c, Math.floor)
      case 'ceil': return op1(0x9b, Math.ceil)
      case 'trunc': return op1(0x9d, Math.trunc)
      case 'abs': {
        need(1)
        if (consts) return this.kval(vs[0].t, Math.abs(vs[0].k))
        if (vs[0].t === T.u32) return vs[0]
        if (vs[0].t === T.i32) { const [once, x] = this.stable(vs[0]); return { t: T.i32, c: [...once, 0x41, 0, ...x.c, 0x6b, ...x.c, ...x.c, 0x41, 0, 0x48, 0x1b], pure: !once.length && x.pure } }
        const x = f64(0)
        return { t: T.f64, c: [...x.c, 0x99], pure: x.pure }
      }
      case 'round': {                                   // half rounds up, as in JavaScript: ceil, minus one if that overshot by more than a half
        need(1)
        if (consts) return this.kval(vs[0].t === INT ? INT : FLOAT, jsRound(vs[0].k))
        if (vs[0].t.kind === 'int') return vs[0]
        const [once, x] = this.stable(f64(0)), t = this.local$(T.f64)
        return { t: T.f64, c: [...once, ...x.c, 0x9b, ...localSet(t), ...localGet(t), 0x44, ...f64bytes(1), 0xa1, ...localGet(t), ...localGet(t), 0x44, ...f64bytes(0.5), 0xa1, ...x.c, 0x64, 0x1b] }
      }
      case 'min': case 'max': {
        if (a.length < 2) return undefined
        const max = fn === 'max'
        if (consts) return this.kval(vs.every(v => v.t === INT) ? INT : vs[0].t.kind === 'lit' ? FLOAT : T.f64, max ? Math.max(...vs.map(v => v.k)) : Math.min(...vs.map(v => v.k)))
        const int = vs.find(v => v.t.kind === 'int')?.t
        if (int && vs.every(v => v.t === int || (v.t === INT && Number.isInteger(v.k)))) {
          return vs.map(v => this.coerce(v, int, n)).reduce((x, y) => {
            const [p1, x1] = this.stable(x), [p2, y1] = this.stable(y)
            return { t: int, c: [...p1, ...p2, ...x1.c, ...y1.c, ...x1.c, ...y1.c, (INT_OPS[max ? '>' : '<'] as number[])[int.signed ? 0 : 1], 0x1b], pure: x.pure && y.pure && !p1.length && !p2.length }
          })
        }
        return vs.map(v => this.toF64(v)).reduce((x, y) => ({ t: T.f64, c: [...x.c, ...y.c, max ? 0xa5 : 0xa4], pure: x.pure && y.pure }))
      }
      case 'fround': {
        need(1)
        const e = a[0]
        // Math.fround(x op y) on float32 operands is exactly the float32 operation
        if (e.n === 'bin' && F32_OPS[e.op]) {
          const x = this.expr(e.a), y = this.expr(e.b)
          const single = (v: Val) => v.t === T.f32 || (v.k !== undefined && isNum(v.t) && Math.fround(v.k) === v.k)
          if (single(x) && single(y) && !(x.k !== undefined && y.k !== undefined)) {
            const p = this.toF32(x), q = this.toF32(y)
            return { t: T.f32, c: [...p.c, ...q.c, F32_OPS[e.op]], pure: p.pure && q.pure }
          }
        }
        if (e.n === 'call' && e.f.n === 'fld' && e.f.e.name === 'Math' && e.f.name === 'sqrt' && e.args.length === 1) {
          const x = this.expr(e.args[0])
          if (x.t === T.f32) return { t: T.f32, c: [...x.c, 0x91], pure: x.pure }
        }
        return this.toF32(vs[0])
      }
      case 'imul': {
        need(2)
        const x = this.toI32(vs[0]), y = this.toI32(vs[1])
        return consts ? this.kval(T.i32, Math.imul(x.k, y.k)) : { t: T.i32, c: [...x.c, ...y.c, 0x6c], pure: x.pure && y.pure }
      }
      case 'clz32': {
        need(1)
        const x = this.toI32(vs[0])
        return consts ? this.kval(T.i32, Math.clz32(x.k)) : { t: T.i32, c: [...x.c, 0x67], pure: x.pure }
      }
    }
    if (typeof (Math as any)[fn] !== 'function') this.err(`Math.${fn} does not exist`, n)
    const js = jsJoin([`Math.${fn}(`, ...vs.flatMap((v, i) => [i ? ',' : '', this.js(this.toF64(v), n)]), ')'], 19, true)
    js.pure = fn !== 'random'
    return this.force(this.lazy(js), T.f64, n)            // sin, pow, random...: JavaScript's own, also at build time
  }

  /** f32x4.*: four float32 lanes in one register. */
  private simd(fn: string, n: any): Val {
    const a = n.args as any[]
    const need = (count: number) => { if (a.length !== count) this.err(`f32x4.${fn} takes ${count} argument${count === 1 ? '' : 's'}`, n) }
    const vec = (i: number) => this.value(a[i], T.f32x4)
    const lanes = (i: number) => {
      const arr = this.ref(a[i])
      if (arr.t !== ARRAYS.Float32Array) this.err(`f32x4.${fn} needs a Float32Array, found ${arr.t.name}`, a[i])
      return this.element(arr, a[i + 1], T.f32, n)
    }
    if (fn === 'splat') {
      need(1)
      const v = this.single(a[0])
      return v.k !== undefined ? this.kval(T.f32x4, [v.k, v.k, v.k, v.k]) : { t: T.f32x4, c: [...v.c, ...simd(0x13)], pure: v.pure }
    }
    if (fn === 'load') { need(2); const pl = lanes(0); return { t: T.f32x4, c: [...(pl.pre ?? []), ...(pl as any).base.c, 0xfd, 0, 2, ...uleb((pl as any).off)] } }
    if (fn === 'store') {
      need(3)
      const pl = lanes(0) as Place & { p: 'mem' }, v = vec(2)
      return { t: VOID, c: [...(pl.pre ?? []), ...pl.base.c, ...v.c, 0xfd, 0x0b, 2, ...uleb(pl.off)] }
    }
    if (fn in VEC_BINARY) { need(2); const x = vec(0), y = vec(1); return { t: T.f32x4, c: [...x.c, ...y.c, ...simd(VEC_BINARY[fn])], pure: x.pure && y.pure } }
    if (fn in VEC_UNARY) { need(1); const x = vec(0); return { t: T.f32x4, c: [...x.c, ...simd(VEC_UNARY[fn])], pure: x.pure } }
    return this.err(`f32x4 has no method '${fn}'`, n)
  }

  private arrayMethod(arr: Val | Place, fn: string, n: any): Val {
    const a = n.args as any[], el = arr.t.el!, size = el.size
    this.usesMem = true
    const int = (i: number) => this.toI32(this.value(a[i], T.f64))
    const bytes = (v: Val): Val => v.k !== undefined ? this.kval(T.i32, v.k * size) : size === 1 ? v : { t: T.i32, c: [...v.c, ...i32const(size), 0x6c], pure: v.pure }
    const add = (x: Val, y: Val): Val => x.k !== undefined && y.k !== undefined ? this.kval(T.i32, x.k + y.k) : y.k === 0 ? x : { t: T.i32, c: [...x.c, ...y.c, 0x6a], pure: x.pure && y.pure }
    const sub = (x: Val, y: Val): Val => x.k !== undefined && y.k !== undefined ? this.kval(T.i32, x.k - y.k) : y.k === 0 ? x : { t: T.i32, c: [...x.c, ...y.c, 0x6b], pure: x.pure && y.pure }
    const [pre, ptr, len] = this.span(arr)
    switch (fn) {
      case 'subarray': {                                   // a view: the same memory, as in JavaScript
        const start = a.length > 0 ? int(0) : this.kval(T.i32, 0), end = a.length > 1 ? int(1) : len
        const p = add(ptr, bytes(start)), l = sub(end, start)
        if (p.k !== undefined && l.k !== undefined) return { t: arr.t, c: [...p.c, ...l.c], ks: [p.k, l.k], pure: true }
        return { t: arr.t, c: [...pre, ...p.c, ...l.c], pure: !pre.length && p.pure && l.pure }
      }
      case 'set': {
        const src = this.ref(a[0])
        if (src.t !== arr.t) this.err(`set() needs another ${arr.t.name}, found ${src.t.name}`, n)
        const [once, sp, sl] = this.span(src), at = a.length > 1 ? int(1) : this.kval(T.i32, 0)
        return { t: VOID, c: [...pre, ...once, ...add(ptr, bytes(at)).c, ...sp.c, ...bytes(sl).c, 0xfc, 0x0a, 0, 0] }
      }
      case 'copyWithin': {
        if (a.length < 2) this.err('copyWithin(target, start, end)', n)
        const target = int(0), start = int(1), end = a.length > 2 ? int(2) : len
        const [o1, s] = this.stable(start)
        return { t: VOID, c: [...pre, ...o1, ...add(ptr, bytes(target)).c, ...add(ptr, bytes(s)).c, ...bytes(sub(end, s)).c, 0xfc, 0x0a, 0, 0] }
      }
      case 'fill': {
        const v = this.toElement(this.expr(a[0]), el, n), start = a.length > 1 ? int(1) : this.kval(T.i32, 0), end = a.length > 2 ? int(2) : len
        if (size === 1 || v.k === 0) {
          const [o1, s] = this.stable(start)
          return { t: VOID, c: [...pre, ...o1, ...add(ptr, bytes(s)).c, ...(size === 1 ? v.c : [0x41, 0]), ...bytes(sub(end, s)).c, 0xfc, 0x0b, 0] }
        }
        const p = this.local$(T.i32), stop = this.local$(T.i32), [o1, value] = this.stable(v)
        return { t: VOID, c: [...pre, ...o1, ...add(ptr, bytes(start)).c, ...localSet(p), ...add(ptr, bytes(end)).c, ...localSet(stop),
          0x02, 0x40, 0x03, 0x40, ...localGet(p), ...localGet(stop), 0x4f, 0x0d, 1,
          ...localGet(p), ...value.c, ...storeOp(el), ...memarg(el, 0), ...localGet(p), ...i32const(size), 0x6a, ...localSet(p), 0x0c, 0, 0x0b, 0x0b] }
      }
    }
    return this.err(`${arr.t.name}.${fn}() is not supported`, n)
  }

  private construct(n: any): Val {
    const array = n.f.n === 'id' && !this.local(n.f.name) && !this.P.resolve(this.mod, n.f.name) ? ARRAYS[n.f.name] : undefined
    if (!array) {
      const callee = n.f.n === 'id' && !this.local(n.f.name) && !this.P.resolve(this.mod, n.f.name) ? jsText(n.f.name) : this.js(this.expr(n.f), n)
      return this.lazy({ ...this.jsCall(callee, n.args, n, true), prec: 19, pure: false })
    }
    if (n.args.length !== 1) this.err(`new ${array.name}(length) or new ${array.name}([values])`, n)
    const el = array.el!, len = this.local$(T.i32), ptr = this.local$(T.i32)
    if (n.args[0].n === 'arr') {
      const items = n.args[0].items as any[]
      const c: Code = [...i32const(items.length * el.size), 0x10, this.alloc$(), ...localSet(ptr)]
      items.forEach((e, i) => c.push(...localGet(ptr), ...this.toElement(this.expr(e), el, e).c, ...storeOp(el), ...memarg(el, i * el.size)))
      return { t: array, c: [...c, ...localGet(ptr), ...i32const(items.length)] }
    }
    const count = this.toI32(this.value(n.args[0], T.f64))
    return { t: array, c: [...count.c, ...localSet(len), ...localGet(len), ...i32const(el.size), 0x6c, 0x10, this.alloc$(), ...localGet(len)] }
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

  /** A value on its way into a variable whose integer type was inferred. If it does not fit, the variable becomes a number and the function is compiled again. */
  private fit(v: Val, pl: Place, n: any): Val {
    const inferred = pl.p === 'loc' ? pl.node : pl.p === 'glob' ? pl.decl : undefined
    if (inferred && (pl.t.kind === 'int' || pl.t === T.f32) && (isNum(v.t) || v.t === HOST)) {
      const fits = v.t === pl.t || (pl.t === T.f32 && v.t.kind === 'lit' && Math.fround(v.k) === v.k) || pl.t !== T.f32 && (v.t === INT && Number.isInteger(v.k) && (pl.t === T.u32 ? v.k >= 0 : true) && Math.abs(v.k) < 2 ** 31)
      if (!fits) {
        if (pl.p === 'glob') { this.P.widen(inferred.mod, inferred); this.P.restart = true }
        else { this.P.widen(this.mod, inferred); this.demoted = true }
        return v.t === HOST ? this.force(v, pl.t, n) : pl.t === T.f32 ? this.toF32(v) : this.toI32(v.t.kind === 'lit' ? this.kval(T.f64, v.k) : v, pl.t)
      }
    }
    if (pl.p === 'mem') return this.toElement(v, pl.t, n)
    return this.coerce(v, pl.t, n)
  }

  private stmt(s: any, tail = false): Code {
    switch (s.n) {
      case 'block': return this.block(s.body)
      case 'seq': return s.list.flatMap((x: any) => this.stmt(x))
      case 'let': {
        const want = s.t ? this.P.type(s.t, this.mod) : undefined
        let v: Val
        if (!s.e) {
          if (!want) this.err(`'${s.name}' needs a type or a value`, s)
          v = want.flat.length === 1 ? this.kval(want, this.zero(want)) : { t: want, c: want.leaves.flatMap(l => this.kval(l, this.zero(l)).c) }
        } else {
          v = this.expr(s.e, want)
          v = want ? this.coerce(v, want, s.e) : this.settle(v, s)
        }
        if (!v.t.flat.length) this.err('this expression has no value', s.e ?? s)
        if (s.isConst && (v.ks || v.k !== undefined)) {                       // a constant: no local needed, and it folds wherever it is used
          this.scopes.at(-1)!.set(s.name, { p: 'const', t: v.t, ks: v.ks ?? [v.k], o: 0 })
          return []
        }
        const i = this.local$(v.t)
        this.scopes.at(-1)!.set(s.name, { p: 'loc', t: v.t, i, node: want || s.isConst ? undefined : s })
        return [...v.c, ...this.sets(i, v.t.flat.length)]
      }
      case 'assign': {
        const r = this.ref(s.to)
        if (!isPlace(r)) {
          if (r.t !== HOST) this.err('cannot assign to this expression', s.to)
          return this.force(this.lazy(jsJoin([r.js!, s.op, jsWrap(this.js(this.expr(s.e), s.e), 3)], 2, true)), VOID, s).c    // el.textContent = ...
        }
        if (s.to.n === 'fld') this.err('objects are values here: assign a whole new one', s)
        if (s.op === '=') return this.store(r, this.fit(this.expr(s.e, r.t), r, s.e), s)
        let once: Code = r.pre ?? [], pl: Place = { ...r, pre: undefined }       // read and write the same place once
        if (pl.p === 'mem') { const [c, base] = this.stable(pl.base); once = [...once, ...c]; pl = { ...pl, base } }
        const v = this.arith(s.op.slice(0, -1), this.load(pl), this.expr(s.e), s)
        return [...once, ...this.store(pl, this.fit(v, pl, s), s)]
      }
      case 'if': {
        const c = this.truthy(this.expr(s.c), s.c)
        if (c.k !== undefined) return c.k ? this.block(s.then) : s.else ? this.block(s.else) : []
        this.depth++
        const a = this.block(s.then), b = s.else ? [0x05, ...this.block(s.else)] : []
        this.depth--
        return [...c.c, 0x04, 0x40, ...a, ...b, 0x0b]
      }
      case 'while': return this.loop(s.c, s.body, [], true)
      case 'dowhile': return this.loop(s.c, s.body, [], false)
      case 'for': {
        this.scopes.push(new Map())
        const c = this.counted(s) ?? [...s.init.flatMap((x: any) => this.stmt(x)), ...this.loop(s.c, s.body, s.update, true)]
        this.scopes.pop()
        return c
      }
      case 'break': case 'continue': {
        const l = this.loops.at(-1) ?? this.err(`${s.n} outside a loop`, s)
        return [0x0c, ...uleb(this.depth - (s.n === 'break' ? l.brk : l.cont))]
      }
      case 'return': {
        if (!s.e !== !this.ret.flat.length) this.err(s.e ? 'this function returns nothing' : `expected a ${this.ret.name} to return`, s)
        const c = s.e ? this.value(s.e, this.ret).c : []
        return tail ? c : this.inl ? [...c, 0x0c, ...uleb(this.depth - this.inl.depth)] : [...c, 0x0f]
      }
      case 'expr': {
        if (s.e.n === 'incr') return this.stmt({ n: 'assign', pos: s.pos, op: s.e.d > 0 ? '+=' : '-=', to: s.e.e, e: { n: 'num', pos: s.pos, v: 1 } })
        let v = this.expr(s.e)
        if (v.t === HOST) v = this.force(v, VOID, s)
        return v.pure ? [] : [...v.c, ...v.t.flat.map(() => 0x1a)]
      }
    }
    return this.err('expected a statement', s)
  }

  /** while, do-while and for. Rotated: the test runs once on entry, then at the bottom of each pass. */
  private loop(cond: any, bodyStmts: any[], update: any[], testFirst: boolean): Code {
    const c = cond ? this.truthy(this.expr(cond), cond) : this.kval(T.bool, true), d = this.depth
    if (c.k !== undefined && !c.k && testFirst) return []
    const forever = c.k !== undefined && !!c.k
    const cont = hasContinue(bodyStmts) && (!forever || update.length > 0 || !testFirst)
    this.loops.push({ brk: d + 1, cont: cont ? d + 3 : d + 2 })
    this.depth = d + (cont ? 3 : 2)
    const body = this.block(bodyStmts)
    this.depth = d + 2
    const step = update.flatMap(u => this.stmt(u))
    this.depth = d
    this.loops.pop()
    const again = forever ? [0x0c, 0] : c.k !== undefined ? [] : [...c.c, 0x0d, 0]
    return [0x02, 0x40, ...(testFirst && !forever ? [...c.c, 0x45, 0x0d, 0] : []), 0x03, 0x40,
      ...(cont ? [0x02, 0x40, ...body, 0x0b] : body), ...step, ...again, 0x0b, 0x0b]
  }

  /**
   * `for (let i = a; i < b; i++)` (or `i += 4`) over integers, when the body leaves `i` alone. The counter gets
   * pre-multiplied copies for array indexing, and a short loop with constant bounds is unrolled.
   */
  private counted(s: any): Code | undefined {
    const init = s.init[0], id = init?.name, step = s.update[0]
    if (s.init.length !== 1 || init.n !== 'let' || !init.e || s.update.length !== 1 || s.c?.n !== 'bin' || s.c.op !== '<' || s.c.a.n !== 'id' || s.c.a.name !== id) return
    const by: number = step.n === 'expr' && step.e.n === 'incr' && step.e.d === 1 && step.e.e.n === 'id' && step.e.e.name === id ? 1
      : step.n === 'assign' && step.op === '+=' && step.to.n === 'id' && step.to.name === id && step.e.n === 'num' && !step.e.float ? step.e.v : 0
    if (by < 1 || by > 4096) return
    let touched = false, jumps = false, size = 0
    walk(s.body, x => {
      size++
      if ((x.n === 'assign' && x.to.n === 'id' && x.to.name === id) || (x.n === 'incr' && x.e.n === 'id' && x.e.name === id)) touched = true
      if (x.n === 'break' || x.n === 'continue') jumps = true
    })
    if (touched || this.P.isWide(this.mod, init)) return
    const want = init.t ? this.P.type(init.t, this.mod) : undefined
    let a = this.expr(init.e, want)
    a = want ? this.coerce(a, want, init.e) : this.settle(a, init)
    const t = a.t
    if (t !== T.i32 && t !== T.u32) return
    let b = this.expr(s.c.b)
    if (b.t === INT && Number.isInteger(b.k)) b = this.kval(t, b.k)
    if (b.t !== t) return

    if (a.k !== undefined && b.k !== undefined) {
      if (a.k >= b.k) return []
      if ((b.k - a.k) / by <= 8 && !jumps && size <= 80) {      // unrolled, with the counter a constant in each copy
        const c: Code = []
        for (let k = a.k; k < b.k; k += by) {
          this.scopes.push(new Map([[id, { p: 'const', t, ks: [k], o: 0 } as Place]]))
          c.push(...this.block(s.body))
          this.scopes.pop()
        }
        return c
      }
    }
    const i = this.local$(t), [once, end] = this.stable(b), d = this.depth, cont = hasContinue(s.body)
    const test = [...localGet(i), ...end.c, t.signed ? 0x48 : 0x49]
    this.loops.push({ brk: d + 1, cont: cont ? d + 3 : d + 2 })
    this.depth = d + (cont ? 3 : 2)
    const scaled = new Map<number, number>()            // element size → local holding counter * size
    this.scopes.push(new Map([[id, { p: 'loc', t, i, scaled } as Place]]))
    const body = this.block(s.body)
    this.scopes.pop()
    this.depth = d
    this.loops.pop()
    const guard = a.k !== undefined && b.k !== undefined ? [] : [...test, 0x45, 0x0d, 0]
    const start = [...scaled].flatMap(([sz, l]) => [...(a.k !== undefined ? i32const(a.k * sz) : [...localGet(i), ...i32const(sz), 0x6c]), ...localSet(l)])
    const advance = [...scaled].flatMap(([sz, l]) => [...localGet(l), ...i32const(sz * by), 0x6a, ...localSet(l)])
    return [...a.c, ...localSet(i), ...start, ...once, 0x02, 0x40, ...guard, 0x03, 0x40, ...(cont ? [0x02, 0x40, ...body, 0x0b] : body),
      ...localGet(i), ...i32const(by), 0x6a, ...localSet(i), ...advance, ...test, 0x0d, 0, 0x0b, 0x0b]
  }

  // ---- output

  private reset(mod: Module, ret: Type): void {
    this.mod = mod; this.locals = []; this.nparam = 0; this.depth = 0; this.loops = []; this.ret = ret; this.inl = null
    this.scopes = [new Map()]; this.inlining = []; this.demoted = false
  }

  private compileFn(d: any): void {
    const f = this.fnOf.get(d)!, sig = this.P.sig(d)
    do {
      this.reset(d.mod, sig.ret)
      let i = 0
      d.params.forEach((p: any, j: number) => { this.scopes[0].set(p.name, { p: 'loc', t: sig.params[j], i }); i += sig.params[j].flat.length })
      this.nparam = i
      this.inlining = [d]
      f.code = this.body(d.body, sig.ret)
      f.locals = this.locals
    } while (this.demoted)
  }

  private drain(): void { while (this.queue.length) this.compileFn(this.queue.shift()) }

  /** What runs when the program loads: the top level of each file, in import order, minus what was already computed at build time. */
  private startup(): void {
    let code: Code, locals: number[]
    do {
      this.reset(this.P.order[0], VOID)
      code = []
      for (const mod of this.P.order) {
        this.mod = mod
        for (const item of mod.top) {
          if (item.n === 'stmt') code.push(...this.stmt(item.s))
          else if (item.n === 'var' && this.P.varInfo(item).runtime) code.push(...this.store(this.global(item), this.value(item.e, this.P.varInfo(item).t), item))
        }
      }
      locals = this.locals
    } while (this.demoted)
    if (!code.length) return
    this.funcs.push({ idx: 0, type: this.functype([], []), name: 'start', exp: '__start', locals, code })
    this.glue.start = true
  }

  /** Wraps a value in an exported function and instantiates the module in the compiler's own engine. */
  run(v: Val): any {
    this.funcs.push({ idx: 0, type: this.functype([], v.t.flat), name: '__ct', exp: '__ct', locals: this.locals, code: v.c })
    return instantiate(this.finish(false), this.glue)
  }

  /**
   * An exported function as JavaScript should see it: objects in and out instead of flattened
   * values, real booleans, unsigned numbers, typed arrays as views. Undefined when the Wasm
   * export already behaves that way.
   */
  private wrapper(d: any): string | undefined {
    const sig = this.P.sig(d), at = { file: d.mod.file, pos: d.pos }
    let plain = true
    const spread = (t: Type, e: string): string[] => {
      if (t.kind === 'struct') { plain = false; return t.fields!.flatMap(f => spread(f.t, `${e}.${f.name}`)) }
      if (t.kind === 'array' || t.kind === 'fn' || t.kind === 'vec') fail(`exported function '${d.name}' cannot take ${t.name} from JavaScript`, at)
      return [e]
    }
    const args = sig.params.flatMap((t, i) => spread(t, param(i)))
    const read = (t: Type, at: number, r: (i: number) => string): string =>
      t.kind === 'struct' ? `{${t.fields!.map(f => `${f.name}:${read(f.t, at + f.slot, r)}`).join()}}`
        : t.kind === 'array' ? `V$(${t.ctor},${r(at)},${r(at + 1)})`
        : t === T.bool ? `!!${r(at)}` : t === T.u32 ? `(${r(at)}>>>0)` : r(at)
    const call = `X$.${d.name}(${args})`, ret = sig.ret
    if (ret.kind === 'vec' || ret.kind === 'fn') fail(`exported function '${d.name}' cannot return ${ret.name} to JavaScript`, at)
    const result = ret.flat.length > 1 ? `(r$=>(${read(ret, 0, i => `r$[${i}]`)}))(${call})` : ret === T.bool || ret === T.u32 ? read(ret, 0, () => call) : call
    return plain && result === call ? undefined : `(${sig.params.map((_, i) => param(i))})=>${result}`
  }

  /** Compiles the program whose entry module is `entry`: its exports, and everything its top level does. */
  program(entry: Module, names: boolean): Uint8Array<ArrayBuffer> {
    for (const d of entry.decls.values()) {
      if (!d.exported) continue
      if (d.n === 'fn') { this.fn(d).exp = d.name; this.glue.exports.push({ name: d.name, kind: 'function', wrap: this.wrapper(d) }); continue }
      if (d.n !== 'var') continue
      const info = this.P.varInfo(d), at = { file: entry.file, pos: d.pos }
      if (info.bytes !== undefined && d.isConst) this.glue.exports.push({ name: d.name, kind: 'view', ctor: info.t.ctor!, addr: this.addr(d), length: info.ks![1] })
      else if (info.ks && d.isConst && info.t.flat.length <= 1 && info.t.kind !== 'fn') this.glue.exports.push({ name: d.name, kind: 'value', value: info.ks[0] })
      else fail(`'${d.name}' cannot be exported to JavaScript: export a constant, a typed array of fixed size, or a function that returns it`, at)
    }
    this.drain()
    this.startup()
    return this.finish(names)
  }

  finish(names: boolean): Uint8Array<ArrayBuffer> {
    this.drain()
    if (this.heap) this.heap.init = i32const((this.P.top + 15) & -16)
    // Keep only what the exports can reach in the code that was actually emitted.
    const live = new Set<Func | Glob>(), todo: (Func | Glob)[] = this.funcs.filter(f => f.exp)
    const mark = () => {
      for (let x; (x = todo.pop());) {
        if (live.has(x)) continue
        live.add(x)
        for (const y of 'w' in x ? x.init : x.code) if (typeof y !== 'number') todo.push(y)
      }
    }
    mark()
    const tabled = this.slots.length > 0
    if (tabled) { todo.push(...this.slots); mark() }
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
    const mem = this.usesMem || this.segs.length > 0, pages = Math.ceil(((this.P.top + 15) & -16) / 65536)

    // The binding table: one JavaScript expression per distinct import, plus the memory. Imports
    // refer to it by position, under a module name derived from its contents, so a module can
    // never be linked against a table from a different build.
    const slots = new Map<string, number>()
    const fields = [...fimports, ...gimports].map(x => {
      if (!slots.has(x.imp!)) slots.set(x.imp!, slots.size)
      return name(String(slots.get(x.imp!)))
    })
    if (mem) slots.set('M$', slots.size)
    const entries = [...slots.keys()]
    let hash = 0x811c9dc5
    for (const ch of entries.join('\n')) hash = Math.imul(hash ^ ch.codePointAt(0)!, 0x01000193)
    const key = 'n' + (hash >>> 0).toString(36), keyName = name(key)
    this.glue = { ...this.glue, key, entries, pages: mem ? pages : 0 }

    section(1, this.typeDefs)
    section(2, [
      ...fimports.map((f, i) => [...keyName, ...fields[i], 0, ...uleb(f.type)]),
      ...gimports.map((g, i) => [...keyName, ...fields[fimports.length + i], 3, g.w, 0]),
      ...(mem ? [[...keyName, ...name(String(slots.get('M$'))), 2, 0, ...uleb(pages)]] : []),
    ])
    section(3, funcs.map(f => uleb(f.type)))
    if (tabled) section(4, [[FUNC, 0, ...uleb(this.slots.length + 1)]])
    section(6, globals.map(g => [g.w, +g.mut, ...resolve(g.init), 0x0b]))
    section(7, funcs.filter(f => f.exp).map(f => [...name(f.exp!), 0, ...uleb(f.idx)]))
    section(9, [
      ...(tabled ? [[0, 0x41, 1, 0x0b, ...uleb(this.slots.length), ...this.slots.flatMap(f => uleb(f.idx))]] : []),     // function values, from index 1
      ...(elems.length ? [[3, 0, ...uleb(elems.length), ...elems.flatMap(f => uleb(f.idx))]] : []),                    // declares ref.func targets
    ])
    section(10, funcs.map(f => {
      const groups: number[][] = []
      for (const w of f.locals) { const g = groups.at(-1); if (g && g[1] === w) g[0]++; else groups.push([1, w]) }
      const b = [...uleb(groups.length), ...groups.flatMap(([n, w]) => [...uleb(n), w]), ...resolve(f.code), 0x0b]
      return [...uleb(b.length), ...b]
    }))
    section(11, this.dataSegments().map(s => [0, ...i32const(s.addr), 0x0b, ...uleb(s.bytes.length), ...s.bytes]))
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

export interface Output {
  wasm: Uint8Array<ArrayBuffer>
  /** What the JavaScript side needs: the bindings, the memory size and the exports. See loader.ts. */
  glue: Glue
  /** Every file that was read, for watchers. */
  files: string[]
}
export type { Glue, Export }

/** Compiles the program whose entry file is `entry`. Its exported functions become WebAssembly exports. */
export function compile(entry: string, opts: Options): Output {
  for (const wide = new Set<string>(); ;) {
    const P = new Program(opts, wide)
    const mod = P.load(entry)
    const u = new Unit(P)
    const wasm = u.program(mod, !!opts.debug)
    if (!P.restart) return { wasm, glue: u.glue, files: P.files }
  }
}
