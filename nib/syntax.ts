// Lexer and parser for the subset of TypeScript that Nib compiles. Produces plain-object AST
// nodes: { n: kind, pos, ... }. Anything outside the subset is a syntax error here, so a file
// that parses is also valid TypeScript.

export interface File { path: string; src: string }
export class NibError extends Error {}

export function fail(msg: string, at?: { file?: File; pos: number }): never {
  if (!at?.file) throw new NibError(msg)
  const before = at.file.src.slice(0, at.pos)
  const line = before.split('\n').length, col = at.pos - before.lastIndexOf('\n')
  throw new NibError(`${at.file.path}:${line}:${col}: ${msg}`)
}

interface Tok {
  k: 'id' | 'num' | 'str' | 'tpl' | 'op' | 'eof'
  v: string
  pos: number
  nl: boolean                 // a line break came before this token
  inline?: boolean            // a comment with @inline came before this token
  quasis?: string[]           // template literal: the text parts...
  holes?: { src: string; pos: number }[]   // ...and the source of each ${ }
}

const TOKEN = new RegExp([
  /[ \t\r]+/,                                                                          // skipped
  /(\n)/,                                                                               // 1 newline
  /(\/\/[^\n]*|\/\*[^]*?\*\/)/,                                                         // 2 comment
  /([A-Za-z_$][\w$]*)/,                                                                 // 3 identifier
  /(0[xX][\da-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?)/, // 4 number
  /'((?:[^'\\\n]|\\[^])*)'/,                                                            // 5 string
  /"((?:[^"\\\n]|\\[^])*)"/,                                                            // 6 string
  /(>>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.(?!\d)|\+\+|--|[-+*\/%&|^]=|<<|>>|\*\*|[{}()\[\];,<>+\-*\/%&|^!~?:=.@])/, // 7 operator
].map(r => r.source).join('|'), 'y')

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
const unescape = (s: string) => s.replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|\r?\n|([^]))/g,
  (_, u1, u2, x, c) => u1 ?? u2 ?? x ? String.fromCodePoint(parseInt(u1 ?? u2 ?? x, 16)) : c === undefined ? '' : ESCAPES[c] ?? c)

function lex(file: File, src = file.src, base = 0): Tok[] {
  const toks: Tok[] = []
  let pos = 0, nl = true, inline = false
  const push = (t: Omit<Tok, 'nl' | 'pos'>, at: number) => { toks.push({ ...t, pos: base + at, nl, ...(inline && { inline }) }); nl = inline = false }
  while (pos < src.length) {
    if (src[pos] === '`') {                       // template literal: split text and ${ } holes by hand
      const quasis: string[] = [], holes: { src: string; pos: number }[] = [], start = pos
      let text = ''
      for (pos++; ; pos++) {
        if (pos >= src.length) fail('unterminated template literal', { file, pos: base + start })
        const c = src[pos]
        if (c === '`') break
        if (c === '\\') { text += src[pos] + src[++pos]; continue }
        if (c === '$' && src[pos + 1] === '{') {
          let depth = 1, i = pos + 2
          for (; depth; i++) {
            if (i >= src.length) fail('unterminated ${ in a template literal', { file, pos: base + pos })
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
          }
          quasis.push(unescape(text)); text = ''
          holes.push({ src: src.slice(pos + 2, i - 1), pos: base + pos + 2 })
          pos = i - 1
          continue
        }
        text += c
      }
      quasis.push(unescape(text))
      push({ k: 'tpl', v: '`', quasis, holes }, start)
      pos++
      continue
    }
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(src)
    if (!m) fail(`unexpected character '${src[pos]}'`, { file, pos: base + pos })
    if (m[1]) nl = true
    else if (m[2]) { if (m[2].includes('\n')) nl = true; if (m[2].includes('@inline')) inline = true }
    else if (m[3] !== undefined) push({ k: 'id', v: m[3] }, pos)
    else if (m[4] !== undefined) push({ k: 'num', v: m[4].replaceAll('_', '') }, pos)
    else if (m[5] !== undefined || m[6] !== undefined) push({ k: 'str', v: unescape(m[5] ?? m[6]) }, pos)
    else if (m[7] !== undefined) push({ k: 'op', v: m[7] }, pos)
    pos = TOKEN.lastIndex
  }
  toks.push({ k: 'eof', v: '<end of file>', pos: base + src.length, nl: true })
  return toks
}

// JavaScript's binary operators, loosest first.
const PREC: Record<string, number> = {
  '??': 1, '||': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '==': 7, '!=': 7, '===': 7, '!==': 7,
  '<': 8, '<=': 8, '>': 8, '>=': 8, '<<': 9, '>>': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11,
}
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>='])
const RESERVED = new Set(['function', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue',
  'import', 'export', 'new', 'typeof', 'class', 'switch', 'throw', 'try', 'interface', 'type', 'async', 'await', 'yield', 'delete', 'in', 'of'])

export interface Ast {
  imports: { names: { name: string; as: string }[]; default?: string; from: string; pos: number }[]
  top: any[]                 // declarations and statements, in source order
}

export function parse(file: File): Ast {
  return new Parser(file, lex(file)).program()
}

class Parser {
  private i = 0
  constructor(private file: File, private toks: Tok[]) {}

  private get t() { return this.toks[this.i] }
  private err(msg: string, t = this.t): never { return fail(msg, { file: this.file, pos: t.pos }) }
  private is(v: string, ahead = 0) { const t = this.toks[this.i + ahead]; return t.v === v && (t.k === 'op' || t.k === 'id') }
  private eat(v: string) { return this.is(v) && (this.i++, true) }
  private expect(v: string) { if (!this.eat(v)) this.err(`expected '${v}', found '${this.t.v}'`) }
  private ident() { const t = this.t; if (t.k !== 'id') this.err(`expected a name, found '${t.v}'`); this.i++; return t.v }
  private semi() { while (this.eat(';')); }
  /** Runs `f`; if it throws a syntax error, rewinds and returns undefined. */
  private attempt<X>(f: () => X): X | undefined {
    const at = this.i
    try { return f() } catch (e) { if (!(e instanceof NibError)) throw e; this.i = at; return undefined }
  }

  // ---- types

  type(): any {
    const pos = this.t.pos
    this.eat('|')
    const parts = [this.typePostfix()]
    while (this.is('|') || this.is('&')) { this.i++; parts.push(this.typePostfix()) }
    return parts.length === 1 ? parts[0] : { n: 'tunion', pos, types: parts }
  }
  private typePostfix(): any {
    let t = this.typePrimary()
    while (this.is('[') && this.is(']', 1)) { this.i += 2; t = { n: 'tother', pos: t.pos } }     // T[] is a JavaScript array
    return t
  }
  private typePrimary(): any {
    const t = this.t, pos = t.pos
    if (t.k === 'str' || t.k === 'num' || t.k === 'tpl') { this.i++; return { n: 'tother', pos } }
    if (this.eat('{')) {
      const fields: any[] = []
      while (!this.eat('}')) {
        this.eat('readonly')
        const name = this.ident(), optional = this.eat('?')
        this.expect(':')
        fields.push({ name, t: optional ? { n: 'tother', pos } : this.type() })
        if (!this.eat(',')) this.eat(';')
      }
      return { n: 'tobj', pos, fields }
    }
    if (this.is('(')) {
      const fn = this.attempt(() => { const params = this.params(); this.expect('=>'); return { n: 'tfn', pos, params, ret: this.type() } })
      if (fn) return fn
      this.i++
      const inner = this.type()
      this.expect(')')
      return inner
    }
    if (this.eat('[')) { while (!this.eat(']')) { this.type(); this.eat(',') } return { n: 'tother', pos } }
    if (this.eat('typeof') || this.eat('keyof') || this.eat('readonly')) { this.typePostfix(); return { n: 'tother', pos } }
    let name = this.ident()
    while (this.eat('.')) name += '.' + this.ident()
    if (this.eat('<')) { do this.type(); while (this.eat(',')); this.expect('>') }
    return { n: 'tname', pos, name }
  }
  private params(): any[] {
    const out: any[] = []
    this.expect('(')
    while (!this.eat(')')) {
      const pos = this.t.pos, name = this.ident()
      if (this.is('?') || this.is('=')) this.err('optional and default parameters are not supported')
      out.push({ name, pos, t: this.eat(':') ? this.type() : null })
      if (!this.is(')')) this.expect(',')
    }
    return out
  }

  // ---- expressions

  expr(): any {
    const c = this.binary(1)
    if (!this.eat('?')) return c
    const a = this.expr()
    this.expect(':')
    return { n: 'cond', pos: c.pos, c, a, b: this.expr() }
  }
  private binary(min: number): any {
    let a = this.unary()
    for (;;) {
      const t = this.t
      if (t.k === 'id' && (t.v === 'as' || t.v === 'satisfies') && min <= 8) {        // binds like a comparison
        this.i++
        a = t.v === 'as' ? { n: 'as', pos: t.pos, e: a, t: this.type() } : (this.type(), a)
        continue
      }
      const p = t.k === 'op' ? PREC[t.v] : undefined
      if (!p || p < min) return a
      this.i++
      a = { n: 'bin', pos: t.pos, op: t.v, a, b: this.binary(p + 1) }
    }
  }
  private unary(): any {
    const t = this.t
    if (t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~')) { this.i++; return { n: 'un', pos: t.pos, op: t.v, e: this.unary() } }
    if (t.k === 'op' && (t.v === '++' || t.v === '--')) { this.i++; return { n: 'incr', pos: t.pos, e: this.unary(), d: t.v === '++' ? 1 : -1, prefix: true } }
    if (t.k === 'id' && t.v === 'typeof') { this.i++; return { n: 'un', pos: t.pos, op: 'typeof ', e: this.unary() } }
    if (t.k === 'id' && (t.v === 'await' || t.v === 'delete' || t.v === 'void')) this.err(`'${t.v}' is not supported`)
    const e = this.postfix()
    const p = this.t
    if (p.k === 'op' && (p.v === '++' || p.v === '--') && !p.nl) { this.i++; return { n: 'incr', pos: p.pos, e, d: p.v === '++' ? 1 : -1, prefix: false } }
    return e
  }
  private args(): any[] {
    const out: any[] = []
    while (!this.eat(')')) {
      if (this.is('...')) this.err('spread arguments are not supported')
      out.push(this.expr())
      if (!this.is(')')) this.expect(',')
    }
    return out
  }
  private postfix(): any {
    let e = this.primary()
    for (;;) {
      const t = this.t
      if (t.k === 'tpl') this.err('tagged templates are not supported')
      if (t.k !== 'op') return e
      if (t.v === '(') { this.i++; e = { n: 'call', pos: e.pos, f: e, args: this.args() } }
      else if (t.v === '[') { this.i++; const ix = this.expr(); this.expect(']'); e = { n: 'idx', pos: t.pos, e, i: ix } }
      else if (t.v === '.') { this.i++; e = { n: 'fld', pos: t.pos, e, name: this.ident() } }
      else if (t.v === '?.') {
        this.i++
        if (this.eat('(')) e = { n: 'call', pos: e.pos, f: e, args: this.args(), opt: true }
        else if (this.eat('[')) { const ix = this.expr(); this.expect(']'); e = { n: 'idx', pos: t.pos, e, i: ix, opt: true } }
        else e = { n: 'fld', pos: t.pos, e, name: this.ident(), opt: true }
      }
      else if (t.v === '!' && !t.nl && !this.is('=', 1)) this.i++                     // non-null assertion: types only
      else if (t.v === '<') {                                                        // f<T>(x): type arguments, if it parses as such
        const typed = this.attempt(() => { this.i++; do this.type(); while (this.eat(',')); this.expect('>'); if (!this.is('(')) this.err('not a call'); return true })
        if (!typed) return e
      }
      else return e
    }
  }
  private arrow(pos: number): any {
    const params = this.is('(') ? this.params() : [{ name: this.ident(), pos, t: null }]
    const ret = this.eat(':') ? this.type() : null
    this.expect('=>')
    return this.is('{') ? { n: 'arrow', pos, params, ret, body: this.block() } : { n: 'arrow', pos, params, ret, value: this.expr() }
  }
  private primary(): any {
    const t = this.t, pos = t.pos
    if (t.k === 'id' && this.is('=>', 1) && !RESERVED.has(t.v)) return this.arrow(pos)
    if (t.k === 'op' && t.v === '(') {
      const fn = this.attempt(() => this.arrow(pos))
      if (fn) return fn
    }
    this.i++
    switch (t.k) {
      case 'num': {
        if (/^\d.*n$/.test(t.v) || this.t.v === 'n' && this.t.pos === pos + t.v.length) this.err('bigint is not supported', t)
        const float = !/^0[xXbB]/.test(t.v) && /[.eE]/.test(t.v)
        return { n: 'num', pos, v: Number(t.v), float }
      }
      case 'str': return { n: 'str', pos, v: t.v }
      case 'tpl': return { n: 'tpl', pos, quasis: t.quasis, exprs: t.holes!.map(h => new Parser(this.file, lex(this.file, h.src, h.pos)).whole()) }
      case 'id':
        if (t.v === 'true' || t.v === 'false') return { n: 'bool', pos, v: t.v === 'true' }
        if (t.v === 'null') return { n: 'null', pos }
        if (t.v === 'new') {
          let f: any = { n: 'id', pos: this.t.pos, name: this.ident() }
          while (this.eat('.')) f = { n: 'fld', pos, e: f, name: this.ident() }
          if (this.is('<')) this.attempt(() => { this.i++; do this.type(); while (this.eat(',')); this.expect('>') })
          return { n: 'new', pos, f, args: this.eat('(') ? this.args() : [] }
        }
        if (t.v === 'function') this.err('function expressions are not supported: use an arrow or a declaration', t)
        if (RESERVED.has(t.v)) this.err(`unexpected '${t.v}'`, t)
        return { n: 'id', pos, name: t.v }
      case 'op':
        if (t.v === '(') { const e = this.expr(); this.expect(')'); return e }
        if (t.v === '{') {
          const props: [string, any][] = []
          while (!this.eat('}')) {
            const k = this.toks[this.i++]
            if (k.k !== 'id' && k.k !== 'str' && k.k !== 'num') this.err('expected a property name', k)
            props.push([k.v, this.eat(':') ? this.expr() : k.k === 'id' ? { n: 'id', pos: k.pos, name: k.v } : this.err('expected :')])
            if (!this.is('}')) this.expect(',')
          }
          return { n: 'obj', pos, props }
        }
        if (t.v === '[') {
          const items: any[] = []
          while (!this.eat(']')) { items.push(this.expr()); if (!this.is(']')) this.expect(',') }
          return { n: 'arr', pos, items }
        }
    }
    return this.err(`unexpected '${t.v}'`, t)
  }
  /** A whole token stream as one expression: the inside of a template's ${ }. */
  whole(): any { const e = this.expr(); if (this.t.k !== 'eof') this.err(`unexpected '${this.t.v}'`); return e }

  // ---- statements

  block(): any[] {
    this.expect('{')
    const out: any[] = []
    for (this.semi(); !this.eat('}'); this.semi()) out.push(this.stmt())
    return out
  }
  private body(): any[] { return this.is('{') ? this.block() : [this.stmt()] }
  /** An expression, an assignment or an increment: what a statement or a for clause may be. */
  private simple(): any {
    const pos = this.t.pos, e = this.expr(), op = this.t
    if (op.k === 'op' && ASSIGN.has(op.v)) {
      this.i++
      const value = this.expr()
      if (this.t.k === 'op' && ASSIGN.has(this.t.v)) this.err('chained assignment is not supported')
      return { n: 'assign', pos, op: op.v, to: e, e: value }
    }
    return { n: 'expr', pos, e }
  }
  private declarations(): any[] {
    const isConst = this.t.v === 'const'
    if (this.t.v === 'var') this.err("use 'let' or 'const'")
    this.i++
    const out: any[] = []
    do {
      const pos = this.t.pos
      if (this.is('{') || this.is('[')) this.err('destructuring is not supported')
      const name = this.ident(), t = this.eat(':') ? this.type() : null
      out.push({ n: 'let', pos, name, t, e: this.eat('=') ? this.expr() : null, isConst })
    } while (this.eat(','))
    return out
  }
  stmt(): any {
    const t = this.t, pos = t.pos
    if (this.is('{')) return { n: 'block', pos, body: this.block() }
    if (t.k !== 'id') return this.simple()
    switch (t.v) {
      case 'const': case 'let': case 'var': { const d = this.declarations(); return d.length === 1 ? d[0] : { n: 'seq', pos, list: d } }
      case 'if': {
        this.i++; this.expect('(')
        const c = this.expr(); this.expect(')')
        const then = this.body()
        this.semi()
        return { n: 'if', pos, c, then, else: this.eat('else') ? this.body() : null }
      }
      case 'while': { this.i++; this.expect('('); const c = this.expr(); this.expect(')'); return { n: 'while', pos, c, body: this.body() } }
      case 'do': {
        this.i++
        const body = this.body()
        this.expect('while'); this.expect('(')
        const c = this.expr(); this.expect(')')
        return { n: 'dowhile', pos, c, body }
      }
      case 'for': {
        this.i++; this.expect('(')
        let init: any[] = []
        if (!this.is(';')) init = this.is('let') || this.is('const') ? this.declarations() : [this.simple()]
        if (this.is('of') || this.is('in')) this.err('for...of and for...in are not supported: use an index')
        this.expect(';')
        const c = this.is(';') ? null : this.expr()
        this.expect(';')
        const update: any[] = []
        while (!this.is(')')) { update.push(this.simple()); if (!this.is(')')) this.expect(',') }
        this.expect(')')
        return { n: 'for', pos, init, c, update, body: this.body() }
      }
      case 'break': case 'continue': this.i++; if (this.t.k === 'id' && !this.t.nl) this.err('labels are not supported'); return { n: t.v, pos }
      case 'return': this.i++; return { n: 'return', pos, e: this.t.nl || this.is('}') || this.is(';') ? null : this.expr() }
      case 'function': this.err('nested functions are not supported: declare it at the top of the file')
      case 'switch': case 'throw': case 'try': case 'class': this.err(`'${t.v}' is not supported`)
    }
    return this.simple()
  }

  // ---- top level

  program(): Ast {
    const imports: Ast['imports'] = [], top: any[] = []
    for (this.semi(); this.t.k !== 'eof'; this.semi()) {
      const t = this.t, pos = t.pos
      if (this.is('import') && !this.is('(', 1)) {
        this.i++
        const typeOnly = this.is('type') && !this.is('from', 1) && !this.is(',', 1) && this.eat('type')
        const imp: Ast['imports'][number] = { names: [], from: '', pos }
        if (this.t.k === 'id') { imp.default = this.ident(); this.eat(',') }
        if (this.eat('{')) {
          while (!this.eat('}')) {
            const one = this.is('type') && !this.is(',', 1) && !this.is('}', 1) && !this.is('as', 1) && this.eat('type')
            const name = this.ident(), as = this.eat('as') ? this.ident() : name
            if (!typeOnly && !one) imp.names.push({ name, as })
            else imp.names.push({ name, as })                    // a type import still names a declaration
            if (!this.is('}')) this.expect(',')
          }
        }
        if (this.is('*')) this.err('namespace imports are not supported: name what you import')
        this.expect('from')
        if (this.t.k !== 'str') this.err('expected a module path')
        imp.from = this.toks[this.i++].v
        if (this.eat('with')) this.primary()                     // import attributes
        imports.push(imp)
        continue
      }
      const exported = this.eat('export')
      if (exported && this.eat('default')) this.err('default exports are not supported: export by name')
      const inline = !!t.inline || !!this.t.inline
      if (this.eat('declare')) {                                 // a promise about JavaScript: for the type checker only
        if (this.eat('function')) { this.ident(); this.params(); if (this.eat(':')) this.type() }
        else if (this.eat('const') || this.eat('let') || this.eat('var')) do { this.ident(); if (this.eat(':')) this.type() } while (this.eat(','))
        else this.err("only 'declare const' and 'declare function' are supported")
        continue
      }
      if (this.eat('function')) {
        const name = this.ident(), params = this.params()
        for (const p of params) if (!p.t) this.err(`parameter '${p.name}' needs a type`, t)
        top.push({ n: 'fn', pos, name, exported, inline, params, ret: this.eat(':') ? this.type() : null, body: this.block() })
      } else if (this.is('const') || this.is('let') || this.is('var')) {
        for (const d of this.declarations()) top.push({ ...d, n: 'var', exported })
      } else if (this.eat('interface')) {
        const name = this.ident()
        if (this.is('extends') || this.is('<')) this.err('interfaces that extend or take type parameters are not supported')
        const body = this.typePrimary()
        top.push({ n: 'alias', pos, name, exported, t: body })
      } else if (this.is('type') && this.toks[this.i + 1].k === 'id' && this.is('=', 2)) {
        this.i++
        const name = this.ident()
        this.expect('=')
        top.push({ n: 'alias', pos, name, exported, t: this.type() })
      } else if (exported) this.err('expected a declaration to export')
      else top.push({ n: 'stmt', pos, s: this.stmt() })
    }
    return { imports, top }
  }
}

/** Calls `f` on every AST node under `node` (including `node`). */
export function walk(node: any, f: (n: any) => void): void {
  if (Array.isArray(node)) { for (const x of node) walk(x, f); return }
  if (!node || typeof node !== 'object') return
  if (node.n) f(node)
  for (const k in node) if (k !== 'mod') walk(node[k], f)
}
