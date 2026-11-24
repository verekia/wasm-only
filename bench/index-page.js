import { measure, report } from './harness.js'

const bytes = async url => new Uint8Array(await (await fetch(url)).arrayBuffer())
document.getElementById('out').textContent = report(measure(await bytes('out/c.wasm'), await bytes('out/nib.wasm')))
window.done = true
