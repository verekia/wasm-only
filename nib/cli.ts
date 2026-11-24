#!/usr/bin/env bun
// nib build <site> [--out dist] [--debug]     compile a site (a folder, an .html or a .nib file)
// nib dev   <site> [--port 3000]              serve it, recompiling on every request, reloading on save

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { compile } from './compiler.ts'
import { boot } from './loader.ts'
import { NibError } from './syntax.ts'

const std = resolve(import.meta.dir, '../std')
const SCRIPT = /<script\s+type="nib"\s+src="([^"]+)"\s*>\s*<\/script>/g

function compileFile(path: string, debug: boolean) {
  const t = performance.now()
  const out = compile(path, { read: p => readFileSync(p, 'utf8'), std, debug })
  return { ...out, ms: performance.now() - t }
}

/** Minifies the loader with Bun's bundler. It is the same few hundred bytes for every program. */
const boots = new Map<string, Promise<string>>()
function bootScript(url: string): Promise<string> {
  let p = boots.get(url)
  if (!p) boots.set(url, p = Bun.build({ entrypoints: ['/boot.js'], files: { '/boot.js': boot(url) }, minify: true })
    .then(r => r.outputs[0].text()).then(s => s.trim().replace(/;$/, '')))
  return p
}

/** Replaces each <script type="nib" src="x.nib"> with the inline loader for x.wasm. */
async function page(path: string, each: (nib: string, wasm: string) => void): Promise<string> {
  let html = readFileSync(path, 'utf8')
  for (const [tag, src] of [...html.matchAll(SCRIPT)]) {
    const wasm = src.replace(/\.nib$/, '') + '.wasm'
    each(join(dirname(path), src), wasm)
    const script = await bootScript(wasm)
    html = html.replace(tag, () => `<script>${script}</script>`)
  }
  return html
}

const kb = (n: number) => n < 1000 ? `${n} B` : `${(n / 1000).toFixed(2)} kB`
const sizes = (b: Uint8Array | string) => `${kb(b.length).padStart(9)}  ${kb(gzipSync(b).length).padStart(9)} gzip  ${kb(brotliCompressSync(b).length).padStart(9)} brotli`

async function build(site: string, out: string, debug: boolean) {
  if (site.endsWith('.nib')) {                       // a lone module
    const r = compileFile(site, debug), to = join(out, basename(site, '.nib') + '.wasm')
    mkdirSync(out, { recursive: true })
    writeFileSync(to, r.wasm)
    console.log(`${to.padEnd(28)} ${sizes(r.wasm)}   ${r.ms.toFixed(1)} ms`)
    return
  }
  const dir = site.endsWith('.html') ? dirname(site) : site
  const pages = site.endsWith('.html') ? [basename(site)] : [...new Bun.Glob('**/*.html').scanSync(dir)]
  cpSync(dir, out, { recursive: true, filter: p => !/\.(nib|wgsl)$/.test(p) })
  for (const name of pages) {
    const html = await page(join(dir, name), (nib, wasm) => {
      const r = compileFile(nib, debug), to = join(out, dirname(name), wasm)
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, r.wasm)
      console.log(`${to.padEnd(28)} ${sizes(r.wasm)}   compiled in ${r.ms.toFixed(1)} ms`)
    })
    writeFileSync(join(out, name), html)
    console.log(`${join(out, name).padEnd(28)} ${sizes(html)}`)
  }
}

function dev(site: string, port: number) {
  const root = resolve(site.endsWith('.html') ? dirname(site) : site)
  const reload = '<script>new WebSocket(`ws://${location.host}/__nib`).onmessage=()=>location.reload()</script>'
  const text = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html;charset=utf-8' } })
  const server = Bun.serve({
    port,
    hostname: 'localhost',
    async fetch(req, server) {
      let path = decodeURIComponent(new URL(req.url).pathname)
      if (path === '/__nib') return server.upgrade(req) ? undefined : new Response(null, { status: 400 })
      if (path.includes('..')) return new Response(null, { status: 400 })
      if (path.endsWith('/')) path += 'index.html'
      const file = join(root, path)
      try {
        if (path.endsWith('.html') && existsSync(file)) return text(await page(file, nib => compileFile(nib, true)) + reload)
        const nib = file.replace(/\.wasm$/, '.nib')
        if (path.endsWith('.wasm') && existsSync(nib)) {
          const r = compileFile(nib, true)
          console.log(`${path}  ${kb(r.wasm.length)}  ${r.ms.toFixed(1)} ms`)
          return new Response(r.wasm, { headers: { 'content-type': 'application/wasm' } })
        }
      } catch (e) {
        if (!(e instanceof NibError)) throw e
        console.error(e.message)
        return text(`<pre style="font:14px ui-monospace,monospace;padding:2rem;color:#c33">${e.message.replace(/[&<]/g, c => c === '&' ? '&amp;' : '&lt;')}</pre>${reload}`, 500)
      }
      return existsSync(file) && statSync(file).isFile() ? new Response(Bun.file(file)) : new Response('not found', { status: 404 })
    },
    websocket: { open(ws) { ws.subscribe('reload') }, message() {} },
  })
  for (const dir of [root, std]) watch(dir, { recursive: true }, () => server.publish('reload', ''))
  console.log(`nib dev  ${server.url}`)
}

const [cmd, site, ...rest] = process.argv.slice(2)
const flag = (name: string) => { const i = rest.indexOf('--' + name); return i < 0 ? undefined : rest[i + 1] ?? '' }
try {
  if (cmd === 'build' && site) await build(site, flag('out') ?? 'dist', flag('debug') !== undefined)
  else if (cmd === 'dev' && site) dev(site, Number(flag('port') ?? 3000))
  else { console.log('usage: nib build <site> [--out dist] [--debug]\n       nib dev <site> [--port 3000]'); process.exit(1) }
} catch (e) {
  if (!(e instanceof NibError)) throw e
  console.error(e.message)
  process.exit(1)
}
