import { measureSkin, reportSkin } from './skin.js'
import * as nib from './out/skin.js'
import * as js from '/@nib/skin.ts?js'

const bytes = async path => (await fetch('out/' + path)).arrayBuffer()
const list = await (await fetch('out/rigs.json')).json()
const files = await Promise.all(list.map(async ([name, paths]) => [name, await Promise.all(paths.map(bytes))]))
document.getElementById('out').textContent = reportSkin(measureSkin(nib, js, files))
window.done = true
