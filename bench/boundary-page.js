// Binds the same six DOM members three ways and times calls to each from Wasm.

import { key, pages, sources, entries } from './out/boundary.js'

const module = await WebAssembly.compileStreaming(fetch('out/boundary.wasm'))
const nib = entries(new WebAssembly.Memory({ initial: pages }))
// the compiler's table, with some entries swapped for another way of binding the same thing
const table = replacements => ({ [key]: sources.map((source, i) => replacements[source] ?? nib[i]) })

const bound = (C, name, kind) => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(C.prototype, name)[kind])
const get = name => o => o[name], set = name => (o, v) => { o[name] = v }, call = name => (o, ...args) => o[name](...args)

// The keys are the bindings the compiler wrote for boundary.ts.
const strategies = {
  'Nib: one arrow per call shape': table({}),
  'Function.prototype.call.bind(native)': table({
    '(a,b)=>a.hasAttribute(b)': bound(Element, 'hasAttribute', 'value'),
    '(a)=>a.firstChild': bound(Node, 'firstChild', 'get'),
    '(a)=>a.clientWidth': bound(Element, 'clientWidth', 'get'),
    '(a,b)=>a.scrollTop=b': bound(Element, 'scrollTop', 'set'),
    '(a)=>a.now()': bound(Performance, 'now', 'value'),
    '(a,b)=>Math.hypot(a,b)': Math.hypot,
  }),
  'One generic closure per kind': table({
    '(a,b)=>a.hasAttribute(b)': call('hasAttribute'),
    '(a)=>a.firstChild': get('firstChild'),
    '(a)=>a.clientWidth': get('clientWidth'),
    '(a,b)=>a.scrollTop=b': set('scrollTop'),
    '(a)=>a.now()': call('now'),
    '(a,b)=>Math.hypot(a,b)': (...args) => Math.hypot(...args),
  }),
}
const known = Object.keys(strategies['One generic closure per kind'][key]).length && ['(a,b)=>a.hasAttribute(b)', '(a)=>a.firstChild', '(a)=>a.clientWidth', '(a,b)=>a.scrollTop=b', '(a)=>a.now()', '(a,b)=>Math.hypot(a,b)', 'M$']
const missing = sources.filter(source => !known.includes(source))
if (missing.length) throw Error('boundary.ts compiled to bindings this page does not know: ' + missing.join('  '))

const el = document.createElement('div')
el.id = 'x'
el.append('text')
document.body.append(el)
const N = 2e6
const tests = {
  method: x => x.method(el, 'id', N), getter: x => x.getter(el, N), layoutGetter: x => x.layoutGetter(el, N), setter: x => x.setter(el, N),
  noArguments: x => x.noArguments(performance, N), plainFunction: x => x.plainFunction(3, N),
}
const rows = {}
for (const [label, imports] of Object.entries(strategies)) {
  const x = new WebAssembly.Instance(module, imports).exports
  rows[label] = {}
  for (const [name, test] of Object.entries(tests)) {
    test(x); test(x)
    let best = Infinity
    for (let i = 0; i < 5; i++) { const t = performance.now(); test(x); best = Math.min(best, performance.now() - t) }
    rows[label][name] = best / N * 1e6
  }
}
const names = Object.keys(tests)
document.getElementById('out').textContent = [
  ''.padEnd(40) + names.map(n => n.padStart(15)).join(''),
  ...Object.entries(rows).map(([label, r]) => label.padEnd(40) + names.map(n => r[n].toFixed(1).padStart(15)).join('')),
].join('\n')
window.done = true
