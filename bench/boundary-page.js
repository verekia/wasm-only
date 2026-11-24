// Binds the same six DOM members three ways and times calls to each from Wasm.

import { table, bindings } from './out/boundary.js'

const module = await WebAssembly.compileStreaming(fetch('out/boundary.wasm'))
const key = Object.keys(bindings)[0], nib = bindings[key]
// the compiler's table, with some entries swapped for another way of binding the same thing
const swap = others => ({ [key]: table.map((source, i) => others[source] ?? nib[i]) })

const bound = (C, name, kind) => Function.prototype.call.bind(Object.getOwnPropertyDescriptor(C.prototype, name)[kind])
const get = name => o => o[name], set = name => (o, v) => { o[name] = v }, call = name => (o, ...args) => o[name](...args)

const strategies = {
  'Nib: one arrow per call shape': bindings,
  'Function.prototype.call.bind(native)': swap({
    '(a,b)=>a.hasAttribute(b)': bound(Element, 'hasAttribute', 'value'),
    'a=>a.firstChild': bound(Node, 'firstChild', 'get'),
    'a=>a.clientWidth': bound(Element, 'clientWidth', 'get'),
    '(a,b)=>{a.scrollTop=b}': bound(Element, 'scrollTop', 'set'),
    '(a)=>a.now()': bound(Performance, 'now', 'value'),
  }),
  'One generic closure per kind': swap({
    '(a,b)=>a.hasAttribute(b)': call('hasAttribute'),
    'a=>a.firstChild': get('firstChild'),
    'a=>a.clientWidth': get('clientWidth'),
    '(a,b)=>{a.scrollTop=b}': set('scrollTop'),
    '(a)=>a.now()': call('now'),
  }),
}

const el = document.createElement('div')
el.id = 'x'
el.append('text')
document.body.append(el)
const N = 2e6
const tests = {
  method: x => x.method(el, N), getter: x => x.getter(el, N), layout_getter: x => x.layout_getter(el, N), setter: x => x.setter(el, N),
  no_arguments: x => x.no_arguments(performance, N), plain_function: x => x.plain_function(N),
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
  ''.padEnd(40) + names.map(n => n.padStart(16)).join(''),
  ...Object.entries(rows).map(([label, r]) => label.padEnd(40) + names.map(n => r[n].toFixed(1).padStart(16)).join('')),
].join('\n')
window.done = true
