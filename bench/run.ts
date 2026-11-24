// bun bench/run.ts            build everything, then time it here (JavaScriptCore) and in Node (V8)
// Needs clang with the wasm32 target and wasm-ld. For a browser: `nib dev bench`, then open it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../nib/compiler.ts'
import { instantiate, moduleSource } from '../nib/loader.ts'
// @ts-ignore: plain JavaScript, shared with the browser page
import { measure, report } from './harness.js'
import * as js from './kernels.ts'

const dir = import.meta.dir, out = dir + '/out', read = (p: string) => readFileSync(p, 'utf8'), lib = dir + '/../lib'
mkdirSync(out, { recursive: true })

const clang = Bun.spawnSync(['clang', '--target=wasm32', '-O3', '-msimd128', '-mbulk-memory', '-nostdlib', '-Wl,--no-entry', '-Wl,--strip-all',
  '-o', out + '/c.wasm', dir + '/kernels.c'], { stderr: 'inherit' })
if (clang.exitCode) process.exit(1)

let ms = Infinity, kernels = compile(dir + '/kernels.ts', { read, lib })
for (let i = 0; i < 20; i++) {
  const t = performance.now()
  kernels = compile(dir + '/kernels.ts', { read, lib })
  ms = Math.min(ms, performance.now() - t)
}
const c = readFileSync(out + '/c.wasm')
writeFileSync(out + '/nib.wasm', kernels.wasm)
writeFileSync(out + '/nib.js', moduleSource(kernels.glue, 'nib.wasm'))
writeFileSync(out + '/nib.glue.json', JSON.stringify(kernels.glue))
console.log(`clang -O3: ${c.length} bytes     nib: ${kernels.wasm.length} bytes, compiled in ${ms.toFixed(2)} ms\n`)

// for boundary.html, which measures calls into the DOM and so needs a browser
const boundary = compile(dir + '/boundary.ts', { read, lib })
writeFileSync(out + '/boundary.wasm', boundary.wasm)
const g = boundary.glue                       // the table as real code, so the page needs no eval
writeFileSync(out + '/boundary.js', `export const key = ${JSON.stringify(g.key)}, pages = ${g.pages || 1}, sources = ${JSON.stringify(g.entries)}\n` +
  `export const entries = M$ => { const V$ = (C, p, n) => new C(M$.buffer, p, n); return [${g.entries.join()}] }\n`)

if (process.argv.includes('--build-only')) process.exit(0)
const cExports = new WebAssembly.Instance(new WebAssembly.Module(c), {}).exports
console.log(`JavaScriptCore (Bun ${Bun.version}), ms per call\n${report(measure(cExports, instantiate(kernels.wasm, kernels.glue), js))}\n`)

const node = Bun.spawnSync(['node', '--input-type=module', '-e', `
  import { readFileSync } from 'node:fs'
  import { measure, report } from ${JSON.stringify(dir + '/harness.js')}
  import { instantiate } from ${JSON.stringify(dir + '/../nib/loader.ts')}
  import * as js from ${JSON.stringify(dir + '/kernels.ts')}
  const c = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(${JSON.stringify(out + '/c.wasm')})), {}).exports
  const nib = instantiate(readFileSync(${JSON.stringify(out + '/nib.wasm')}), JSON.parse(readFileSync(${JSON.stringify(out + '/nib.glue.json')}, 'utf8')))
  console.log('V8 (Node ' + process.versions.node + ', V8 ' + process.versions.v8 + '), ms per call\\n' + report(measure(c, nib, js)))
`], { stdout: 'inherit', stderr: 'inherit' })
if (node.exitCode) console.log('(Node not available: skipped the V8 run)')
