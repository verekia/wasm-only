// How a Nib module reaches JavaScript.
//
// Wasm can only call what it imports, so the compiler writes one line of JavaScript per distinct
// binding and collects them in a table:
//
//   {n1x9k2a:[(a,b)=>a.getElementById(b), (a)=>({size:a,usage:72}), globalThis.document, "input"]}
//
// The module imports from that table by position. The table is plain script: nothing is
// evaluated from strings at run time, so a page works under a Content-Security-Policy of
//
//   default-src 'self'; script-src 'self' 'wasm-unsafe-eval'
//
// Each arrow has exactly the arity of the call it serves. Measured in Chromium, that is as fast
// as hand-written glue and faster than binding native functions directly (see README.md).

/** The whole script a page loads: fetch, link against the bindings, call `main(exports)` if it is exported. */
export const boot = (wasmUrl: string, bindings: string): string =>
  `WebAssembly.instantiateStreaming(fetch(${JSON.stringify(wasmUrl)}),${bindings}).then(r=>r.instance.exports.main?.(r.instance.exports))\n`

/** Instantiates a compiled module in the current JavaScript environment: for the compiler itself and for tests. */
export const instantiate = (wasm: Uint8Array<ArrayBuffer>, bindings: string): WebAssembly.Instance =>
  new WebAssembly.Instance(new WebAssembly.Module(wasm), (0, eval)(`(${bindings})`))
