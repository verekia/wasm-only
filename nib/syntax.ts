// Lexer and parser. Produces plain-object AST nodes: { n: kind, pos, ... }.

export interface File { path: string; src: string }
export class NibError extends Error {}

export function fail(msg: string, at?: { file?: File; pos: number }): never {
  if (!at?.file) throw new NibError(msg)
  const before = at.file.src.slice(0, at.pos)
  const line = before.split('\n').length, col = at.pos - before.lastIndexOf('\n')
  throw new NibError(`${at.file.path}:${line}:${col}: ${msg}`)
}

interface Tok { k: 'id' | 'num' | 'str' | 'op' | 'eof'; v: string; pos: number; nl: boolean }

const TOKEN = new RegExp([
  /[ \t\r]+|\/\/[^\n]*/,                                              // skipped
  /(\n)/,                                                              // 1 newline
  /([A-Za-z_]\w*)/,                                                    // 2 identifier
  /(0x[\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][-+]?\d+)?)/,          // 3 number
  /"((?:[^"\\\n]|\\.)*)"/,                                             // 4 string
  /`([^`]*)`/,                                                         // 5 raw string
  /(\.\.\.|<<=|>>=|\.\.|&&|\|\||<<|>>|[-+*\/%&|^=!<>]=|[-+*\/%&|^~!<>=(){}\[\],.:;?])/, // 6 operator
].map(r => r.source).join('|'), 'y')

function lex(file: File): Tok[] {
  const src = file.src, toks: Tok[] = []
  let pos = 0, nl = true
  while (pos < src.length) {
    TOKEN.lastIndex = pos
    const m = TOKEN.exec(src)
    if (!m) fail(`unexpected character '${src[pos]}'`, { file, pos })
    if (m[1]) nl = true
    else if (m[2] !== undefined) toks.push({ k: 'id', v: m[2], pos, nl })
    else if (m[3] !== undefined) toks.push({ k: 'num', v: m[3].replaceAll('_', ''), pos, nl })
    else if (m[4] !== undefined) toks.push({ k: 'str', v: JSON.parse(`"${m[4]}"`), pos, nl })
    else if (m[5] !== undefined) toks.push({ k: 'str', v: m[5], pos, nl })
    else if (m[6] !== undefined) toks.push({ k: 'op', v: m[6], pos, nl })
    if (m[0] !== '\n' && (m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6]) !== undefined) nl = false
    pos = TOKEN.lastIndex
  }
  toks.push({ k: 'eof', v: '<end of file>', pos, nl: true })
  return toks
}

const PREC: Record<string, number> = {
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '|': 4, '^': 5, '&': 6, '<<': 7, '>>': 7, '+': 8, '-': 8, '*': 9, '/': 9, '%': 9,
}
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='])
const EXTERN_KINDS = new Set(['fn', 'call', 'get', 'set', 'new', 'val', 'js'])

export function parse(file: File): { imports: { path: string; pos: number }[]; decls: any[] } {
  const toks = lex(file)
  let i = 0
  const peek = () => toks[i]
  const err = (msg: string, t = toks[i]): never => fail(msg, { file, pos: t.pos })
  const is = (v: string) => toks[i].v === v && toks[i].k !== 'str'
  const eat = (v: string) => is(v) && (i++, true)
  const expect = (v: string) => { if (!eat(v)) err(`expected '${v}', found '${toks[i].v}'`) }
  const ident = () => { const t = toks[i]; if (t.k !== 'id') err(`expected a name, found '${t.v}'`); i++; return t.v }
  const sep = () => { while (eat(',') || eat(';')); }

  function type(): any {
    const pos = peek().pos
    if (eat('*')) return { n: 'tptr', pos, to: type() }
    return { n: 'tname', pos, name: ident() }
  }

  // ---- expressions ----
  function expr(): any {
    const c = binary(1)
    if (!eat('?')) return c
    const a = expr(); expect(':')
    return { n: 'cond', pos: c.pos, c, a, b: expr() }
  }
  function binary(min: number): any {
    let a = unary()
    for (;;) {
      const t = peek(), p = t.k === 'op' && !t.nl ? PREC[t.v] : undefined   // an operator starting a line does not continue
      if (!p || p < min) return a
      i++
      a = { n: 'bin', pos: t.pos, op: t.v, a, b: binary(p + 1) }
    }
  }
  function unary(): any {           // `as` binds looser than prefix operators: `-x as f32` is `(-x) as f32`
    const pos = peek().pos
    let e = prefix()
    while (eat('as')) e = { n: 'cast', pos, e, t: type() }
    return e
  }
  function prefix(): any {
    const t = peek()
    if (t.k === 'op' && (t.v === '-' || t.v === '!' || t.v === '~')) { i++; return { n: 'un', pos: t.pos, op: t.v, e: prefix() } }
    if (t.k === 'op' && t.v === '&') { i++; return { n: 'addr', pos: t.pos, e: prefix() } }
    if (eat('comptime')) return { n: 'comptime', pos: t.pos, e: prefix() }
    return postfix()
  }
  function postfix(): any {
    let e = primary()
    for (;;) {
      const t = peek()
      if (t.k !== 'op') return e
      if (t.v === '(' && !t.nl && e.n === 'id') {
        i++
        const args: any[] = []
        while (!eat(')')) { args.push(expr()); if (!is(')')) expect(',') }
        e = { n: 'call', pos: e.pos, name: e.name, args }
      } else if (t.v === '[' && !t.nl) {
        i++
        const ix = expr(); expect(']')
        e = { n: 'idx', pos: t.pos, e, i: ix }
      } else if (t.v === '.') {
        i++
        e = { n: 'fld', pos: t.pos, e, name: ident() }
      } else return e
    }
  }
  function primary(): any {
    const t = toks[i++]
    switch (t.k) {
      case 'num': {
        const float = !t.v.startsWith('0x') && /[.eE]/.test(t.v)
        return { n: 'num', pos: t.pos, v: Number(t.v), float }
      }
      case 'str': return { n: 'str', pos: t.pos, v: t.v }
      case 'id':
        if (t.v === 'true' || t.v === 'false') return { n: 'bool', pos: t.pos, v: t.v === 'true' }
        if (t.v === 'null') return { n: 'null', pos: t.pos }
        return { n: 'id', pos: t.pos, name: t.v }
      case 'op':
        if (t.v === '(') { const e = expr(); expect(')'); return e }
        if (t.v === '{') {                         // JS object literal
          const props: [string, any][] = []
          for (sep(); !eat('}'); sep()) {
            const k = toks[i++]
            if (k.k !== 'id' && k.k !== 'str') err('expected a property name', k)
            props.push([k.v, eat(':') ? expr() : { n: 'id', pos: k.pos, name: k.v }])
          }
          return { n: 'obj', pos: t.pos, props }
        }
        if (t.v === '[') {                         // JS array literal
          const items: any[] = []
          for (sep(); !eat(']'); sep()) items.push(expr())
          return { n: 'arr', pos: t.pos, items }
        }
    }
    return err(`unexpected '${t.v}'`, t)
  }

  // ---- statements ----
  function block(): any[] {
    expect('{')
    const out: any[] = []
    for (sep(); !eat('}'); sep()) out.push(stmt())
    return out
  }
  function stmt(): any {
    const t = peek(), pos = t.pos
    if (eat('let')) {
      const name = ident(), ty = eat(':') ? type() : null
      expect('=')
      return { n: 'let', pos, name, t: ty, e: expr() }
    }
    if (eat('if')) {
      const c = expr(), then = block()
      const els = eat('else') ? (is('if') ? [stmt()] : block()) : null
      return { n: 'if', pos, c, then, else: els }
    }
    if (eat('while')) return { n: 'while', pos, c: expr(), body: block() }
    if (eat('loop')) return { n: 'while', pos, c: { n: 'bool', pos, v: true }, body: block() }
    if (is('for') || (is('inline') && toks[i + 1].v === 'for')) {
      const inline = eat('inline'); i++
      const name = ident(); expect('in')
      const a = expr(); expect('..')
      return { n: 'for', pos, inline, name, a, b: expr(), body: block() }
    }
    if (eat('break')) return { n: 'break', pos }
    if (eat('continue')) return { n: 'continue', pos }
    if (eat('return')) return { n: 'return', pos, e: peek().nl || is('}') ? null : expr() }
    const e = expr(), op = peek()
    if (op.k === 'op' && ASSIGN.has(op.v)) { i++; return { n: 'assign', pos, op: op.v, to: e, e: expr() } }
    return { n: 'expr', pos, e }
  }

  // ---- declarations ----
  function params(allowAny: boolean): { params: any[]; variadic: boolean } {
    const out: any[] = []
    let variadic = false
    expect('(')
    while (!eat(')')) {
      if (allowAny && eat('...')) { variadic = true; expect(')'); break }
      const name = ident(); expect(':')
      out.push({ name, t: type() })
      if (!is(')')) expect(',')
    }
    return { params: out, variadic }
  }
  function decl(): any {
    let exported = false, inline = false
    for (;;) { if (eat('export')) exported = true; else if (eat('inline')) inline = true; else break }
    const pos = peek().pos
    if (eat('fn')) {
      const name = ident(), p = params(false)
      return { n: 'fn', pos, name, exported, inline, params: p.params, ret: eat(':') ? type() : null, body: block() }
    }
    if (exported || inline) err("expected 'fn'")
    if (eat('const')) {
      const name = ident(), t = eat(':') ? type() : null
      expect('=')
      return { n: 'const', pos, name, t, e: expr() }
    }
    if (eat('var')) {
      const name = ident(), t = eat(':') ? type() : null
      return { n: 'var', pos, name, t, e: eat('=') ? expr() : t ? null : err('a var needs a type or an initializer') }
    }
    if (eat('static')) {
      const name = ident(); expect(':'); expect('[')
      const el = type(); expect(';')
      const count = expr(); expect(']')
      let init: any = null
      if (eat('=')) {
        if (eat('comptime')) init = { fn: ident() }
        else { expect('['); const items: any[] = []; for (sep(); !eat(']'); sep()) items.push(expr()); init = { items } }
      }
      return { n: 'static', pos, name, el, count, init }
    }
    if (eat('struct')) {
      const name = ident(), fields: any[] = []
      expect('{')
      for (sep(); !eat('}'); sep()) { const f = ident(); expect(':'); fields.push({ name: f, t: type() }) }
      return { n: 'struct', pos, name, fields }
    }
    if (eat('extern')) {
      const kind = ident()
      if (!EXTERN_KINDS.has(kind)) err(`unknown extern kind '${kind}' (expected fn, call, get, set, new, val or js)`)
      if (kind === 'js') {                         // extern js name(params): T = "any JavaScript expression that yields a function"
        const name = ident(), p = params(true), ret = eat(':') ? type() : null
        expect('=')
        const src = toks[i++]
        if (src.k !== 'str') err('expected the JavaScript source as a string', src)
        return { n: 'extern', pos, name, kind, path: name, source: src.v, short: false, params: p.params, variadic: p.variadic, ret }
      }
      let path = ident(), last = path
      while (eat('.')) path += '.' + (last = ident())
      const short = !is('('), p = short ? { params: [], variadic: false } : params(true)
      const ret = eat(':') ? type() : null
      const name = eat('as') ? ident() : kind === 'set' ? 'set_' + last : last
      return { n: 'extern', pos, name, kind, path, short, params: p.params, variadic: p.variadic, ret }
    }
    return err(`expected a declaration, found '${peek().v}'`)
  }

  const imports: { path: string; pos: number }[] = [], decls: any[] = []
  for (sep(); peek().k !== 'eof'; sep()) {
    const pos = peek().pos
    if (eat('import')) { const t = toks[i++]; if (t.k !== 'str') err('expected a path string', t); imports.push({ path: t.v, pos }) }
    else decls.push(decl())
  }
  return { imports, decls }
}

/** Calls `f` on every AST node under `node` (including `node`). */
export function walk(node: any, f: (n: any) => void): void {
  if (Array.isArray(node)) { for (const x of node) walk(x, f); return }
  if (!node || typeof node !== 'object') return
  if (node.n) f(node)
  for (const k in node) if (k !== 'file') walk(node[k], f)
}
