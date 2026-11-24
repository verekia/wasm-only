// bun bench/run.ts            build both modules, then time them here (JavaScriptCore) and in Node (V8)
// Needs clang with the wasm32 target and wasm-ld.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { compile } from '../nib/compiler.ts'
import { runtime } from '../nib/loader.ts'
import { measure, report } from './harness.js'

const dir = import.meta.dir, out = dir + '/out'
mkdirSync(out, { recursive: true })

const clang = Bun.spawnSync(['clang', '--target=wasm32', '-O3', '-msimd128', '-mbulk-memory', '-nostdlib', '-Wl,--no-entry', '-Wl,--strip-all',
  '-o', out + '/c.wasm', dir + '/kernels.c'], { stderr: 'inherit' })
if (clang.exitCode) process.exit(1)

let ms = Infinity, wasm!: Uint8Array<ArrayBuffer>
for (let i = 0; i < 20; i++) {
  const t = performance.now()
  wasm = compile(dir + '/kernels.nib', { read: p => readFileSync(p, 'utf8'), std: dir + '/../std' }).wasm
  ms = Math.min(ms, performance.now() - t)
}
writeFileSync(out + '/nib.wasm', wasm)
const c = readFileSync(out + '/c.wasm')
console.log(`clang -O3: ${c.length} bytes     nib: ${wasm.length} bytes, compiled in ${ms.toFixed(2)} ms\n`)

// for boundary.html, which measures calls into the DOM and so needs a browser
writeFileSync(out + '/boundary.wasm', compile(dir + '/boundary.nib', { read: p => readFileSync(p, 'utf8'), std: dir + '/../std' }).wasm)
writeFileSync(out + '/runtime.js', `export ${runtime}\n`)

if (process.argv.includes('--build-only')) process.exit(0)
console.log(`JavaScriptCore (Bun ${Bun.version}), ms per call\n${report(measure(c, wasm))}\n`)

const node = Bun.spawnSync(['node', '--input-type=module', '-e', `
  import { readFileSync } from 'node:fs'
  import { measure, report } from ${JSON.stringify(dir + '/harness.js')}
  console.log('V8 (Node ' + process.versions.node + ', V8 ' + process.versions.v8 + '), ms per call\\n' + report(measure(readFileSync(${JSON.stringify(out + '/c.wasm')}), readFileSync(${JSON.stringify(out + '/nib.wasm')}))))
`], { stdout: 'inherit', stderr: 'inherit' })
if (node.exitCode) console.log('(Node not available: skipped the V8 run)')
