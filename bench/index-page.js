import { measure, report } from './harness.js'
import * as nib from './out/nib.js'
import * as js from './kernels.ts?js'

const c = (await WebAssembly.instantiateStreaming(fetch('out/c.wasm'), {})).instance.exports
document.getElementById('out').textContent = report(measure(c, nib, js))
window.done = true
