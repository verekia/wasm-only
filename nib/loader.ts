// The entire JavaScript runtime of a Nib program.
//
// A compiled module's import section is its binding manifest. Each import names the JavaScript
// it wants, and this resolves them all the same way, so it never grows with the application.
//
//   module "str", field: any text                  the string itself
//   module "val", field: "document"                the value of that expression, read once
//   module "js",  field: "Math.sin"                a function to call, or a one-line arrow
//                        "(a,b)=>a.submit(b)"      the compiler wrote for one call shape
//
// Why arrows rather than binding native functions directly: measured in Chromium 158, a
// Wasm → JS-arrow → DOM call is as fast as hand-written glue, and 10–40% faster than
// `Function.prototype.call.bind(nativeMethod)`, because each arrow is ordinary JavaScript with
// its own inline caches. See bench/README.md.
//
// A binding the browser cannot provide becomes a function that throws when called, so a page
// still loads and can feature-detect. Evaluating source needs a Content-Security-Policy that
// allows 'unsafe-eval'.

export function runtime(): WebAssembly.Imports {
  const run = eval                       // called indirectly: sources see only the global scope
  const table = (resolve: (field: string) => unknown) => new Proxy({}, { get: (_, field: string) => resolve(field) })
  return {
    str: table(text => text),
    val: table(source => { try { return run(source) } catch { } }),
    js: table(source => {
      let f
      try { f = run(source) } catch { }
      return f ?? (() => { throw Error('nib: no ' + source) })
    }),
  }
}

/** The script that boots `url` in a browser. If the module exports `main`, it is called with the exports. */
export const boot = (url: string): string =>
  `WebAssembly.instantiateStreaming(fetch(${JSON.stringify(url)}),(${runtime})()).then(r=>r.instance.exports.main?.(r.instance.exports))`
