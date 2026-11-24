// How a compiled module reaches JavaScript.
//
// Wasm can only call what it imports. For each distinct use of a JavaScript value in the source
// (a DOM call, a property, an object literal) the compiler writes one arrow function, with
// constants written in and exactly the arguments that vary:
//
//   canvas.getContext('webgpu')                       (a)=>a.getContext("webgpu")
//   device.createBuffer({ size: n, usage: 72 })       (a,b)=>a.createBuffer({size:b,usage:72})
//
// They go into a table, with the memory, and the module imports from it by position. The table
// is plain script, so a page works under a Content-Security-Policy of
//
//   default-src 'self'; script-src 'self' 'wasm-unsafe-eval'

export type Export =
  | { name: string; kind: 'function'; wrap?: string }       // wrap: converts objects, booleans and arrays at the edge
  | { name: string; kind: 'value'; value: unknown }
  | { name: string; kind: 'view'; ctor: string; addr: number; length: number }

export interface Glue {
  key: string               // the import module name: a hash of the table, so a stale table cannot link
  entries: string[]         // JavaScript source of each binding
  pages: number             // memory size in 64 KiB pages; 0 for a module without memory
  start: boolean            // the module has top-level code to run
  exports: Export[]
}

const prelude = (g: Glue) => g.pages ? `const M$=new WebAssembly.Memory({initial:${g.pages}}),V$=(C,p,n)=>new C(M$.buffer,p,n)\n` : ''
const imports = (g: Glue) => g.entries.length ? `{${g.key}:[${g.entries.join()}]}` : '{}'
const exported = (e: Export) => e.kind === 'function' ? e.wrap ?? `X$.${e.name}` : e.kind === 'view' ? `V$(${e.ctor},${e.addr},${e.length})` : JSON.stringify(e.value)

/**
 * The ES module that stands in for the TypeScript file: it has the same exports. Functions are
 * the compiled ones, and typed arrays are views of the module's memory, so the rest of an
 * application reads and writes game state with no copies.
 */
export const moduleSource = (g: Glue, wasmUrl: string): string =>
  prelude(g) +
  `const X$=(await WebAssembly.instantiateStreaming(fetch(new URL(${JSON.stringify(wasmUrl)},import.meta.url)),${imports(g)})).instance.exports\n` +
  (g.start ? 'X$.__start()\n' : '') +
  (g.exports.length ? `export const ${g.exports.map(e => `${e.name}=${exported(e)}`).join()}\n` : '')

/** Instantiates a compiled module right here: for the compiler's build-time evaluation and for tests. */
export function instantiate(wasm: Uint8Array<ArrayBuffer>, g: Glue): any {
  const body = prelude(g) +
    `const X$=new WebAssembly.Instance(new WebAssembly.Module(bytes),${imports(g)}).exports\n` +
    (g.start ? 'X$.__start()\n' : '') +
    `return{...X$,${g.pages ? 'memory:M$,' : ''}${g.exports.map(e => `${e.name}:${exported(e)}`).join()}}`
  return new Function('bytes', body)(wasm)
}
