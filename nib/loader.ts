// The entire JavaScript runtime of a Nib program.
//
// A compiled module's import section is its binding manifest: the import *module* says how to
// bind, the import *field* says what to bind. `runtime` resolves every import generically, so
// it never grows with the application.
//
//   str  "any text"            the string itself
//   val  "document"            a global value, read once at startup
//   fn   "Math.sin"            a function, called with no receiver
//   new  "Uint8Array"          a constructor
//   call "GPUQueue.submit"     a method;           first argument: the receiver
//   get  "GPUDevice.queue"     an attribute getter; first argument: the receiver
//   set  "Node.textContent"    an attribute setter; arguments: the receiver, the value
//
// `call`, `get` and `set` look the member up on `A.prototype`, or on `A` itself when it is not
// there ("Promise.all", "performance.now"), and hand the engine
// `Function.prototype.call.bind(nativeFunction)`: no JavaScript wrapper sits between Wasm and
// the browser's own implementation.
//
// A binding the browser does not have becomes a function that throws when called, so a page
// still loads and can feature-detect.

export function runtime(G: any): WebAssembly.Imports {
  const call = Function.prototype.call
  const at = (path: string) => path.split('.').reduce((o, key) => o[key], G)
  const member = (path: string, kind: 'value' | 'get' | 'set') => {
    const dot = path.lastIndexOf('.'), name = path.slice(dot + 1)
    let o = at(path.slice(0, dot)), d
    if (o.prototype && name in o.prototype) o = o.prototype
    while (!(d = Object.getOwnPropertyDescriptor(o, name))) o = Object.getPrototypeOf(o)
    return call.bind(d[kind])
  }
  const bind = (resolve: (name: string) => any): any => new Proxy({}, {
    get: (_, name: string) => {
      try { return resolve(name) } catch { return () => { throw Error('nib: no ' + name) } }
    },
  })
  return {
    str: bind(text => text),
    val: bind(at),
    fn: bind(path => at(path) ?? member(path, 'value')),
    new: bind(path => { const C = at(path); return (...args: any[]) => new C(...args) }),
    call: bind(path => member(path, 'value')),
    get: bind(path => member(path, 'get')),
    set: bind(path => member(path, 'set')),
  }
}

/** The script that boots `url` in a browser. If the module exports `main`, it is called with the exports. */
export const boot = (url: string): string =>
  `WebAssembly.instantiateStreaming(fetch(${JSON.stringify(url)}),(${runtime})(self)).then(r=>r.instance.exports.main?.(r.instance.exports))`
