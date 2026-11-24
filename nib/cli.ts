#!/usr/bin/env bun
// nib build <site> [--out dist] [--debug]     compile a site: a folder, an .html file or a .nib file
// nib dev   <site> [--port 3000]              serve it: compiles on every request, reloads on save
//
// A page opts in with <script type="nib" src="main.nib"></script>. That tag becomes two files:
// main.wasm, and main.js, which holds the module's JavaScript bindings and starts it.

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { compile } from './compiler.ts'
import { boot } from './loader.ts'
import { NibError } from './syntax.ts'

const std = resolve(import.meta.dir, '../std')
const TAG = /<script\s+type="nib"\s+src="([^"]+)\.nib"\s*>\s*<\/script>/g
// What the dev server sends, so a page that would break under a strict policy breaks here first.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"

function compileFile(path: string, debug: boolean) {
  const t = performance.now()
  const out = compile(path, { read: p => readFileSync(p, 'utf8'), std, debug })
  return { ...out, ms: performance.now() - t }
}

/** Rewrites a page. `emit` is given each module's source path and name, and returns the URLs to load. */
function page(path: string, emit: (nib: string, name: string) => { wasm: string; js: string }): string {
  return readFileSync(path, 'utf8').replace(TAG, (_, name: string) => {
    const { wasm, js } = emit(join(dirname(path), name + '.nib'), name)
    // the preload lets the module download while the script does, instead of after it
    return `<link rel="preload" as="fetch" crossorigin href="${wasm}"><script defer src="${js}"></script>`
  })
}

const kb = (n: number) => n < 1000 ? `${n} B` : `${(n / 1000).toFixed(2)} kB`
const report = (path: string, data: Uint8Array | string, note = '') =>
  console.log(`${path.padEnd(36)} ${kb(data.length).padStart(9)} ${kb(brotliCompressSync(data).length).padStart(9)} brotli   ${note}`)
const hash = (data: Uint8Array | string) => Bun.hash(data).toString(36).slice(0, 8)

function build(site: string, out: string, debug: boolean) {
  const write = (path: string, data: Uint8Array | string, note?: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    report(path, data, note)
  }
  if (site.endsWith('.nib')) {                       // a lone module
    const r = compileFile(site, debug), name = basename(site, '.nib')
    write(join(out, name + '.wasm'), r.wasm, `compiled in ${r.ms.toFixed(1)} ms`)
    write(join(out, name + '.js'), boot(name + '.wasm', r.bindings))
    return
  }
  const dir = site.endsWith('.html') ? dirname(site) : site
  const pages = site.endsWith('.html') ? [basename(site)] : [...new Bun.Glob('**/*.html').scanSync(dir)].sort()
  cpSync(dir, out, { recursive: true, filter: p => !/\.(nib|wgsl)$/.test(p) })
  for (const name of pages) {
    const html = page(join(dir, name), (nib, module) => {
      // content-hashed names: both files can be cached forever, and can never be mismatched
      const r = compileFile(nib, debug), wasm = `${module}-${hash(r.wasm)}.wasm`
      const script = boot(wasm, r.bindings), js = `${module}-${hash(script)}.js`
      write(join(out, dirname(name), wasm), r.wasm, `compiled in ${r.ms.toFixed(1)} ms`)
      write(join(out, dirname(name), js), script)
      return { wasm, js }
    })
    write(join(out, name), html)
  }
}

function dev(site: string, port: number) {
  const root = resolve(site.endsWith('.html') ? dirname(site) : site)
  const reload = 'new WebSocket(`ws://${location.host}/__nib`).onmessage = () => location.reload()'
  const send = (body: any, type?: string, status = 200) =>
    new Response(body, { status, headers: { 'content-security-policy': CSP, 'cache-control': 'no-store', ...(type && { 'content-type': type }) } })
  const server = Bun.serve({
    port,
    hostname: 'localhost',
    fetch(req, server) {
      let path = decodeURIComponent(new URL(req.url).pathname)
      if (path === '/__nib') return server.upgrade(req) ? undefined : send(null, undefined, 400)
      if (path === '/__nib.js') return send(reload, 'text/javascript')
      if (path.includes('..')) return send(null, undefined, 400)
      if (!path.endsWith('/') && existsSync(join(root, path)) && statSync(join(root, path)).isDirectory()) return Response.redirect(path + '/')
      if (path.endsWith('/')) path += 'index.html'
      const file = join(root, path), nib = file.replace(/\.(wasm|js)$/, '.nib')
      try {
        if (path.endsWith('.html') && existsSync(file)) {
          const html = page(file, (nib, name) => (compileFile(nib, true), { wasm: name + '.wasm', js: name + '.js' }))
          return send(html + '<script src="/__nib.js"></script>', 'text/html;charset=utf-8')
        }
        if (nib !== file && !existsSync(file) && existsSync(nib)) {
          const r = compileFile(nib, true)
          if (path.endsWith('.js')) return send(boot(path.replace(/\.js$/, '.wasm'), r.bindings), 'text/javascript')
          console.log(`${path}  ${kb(r.wasm.length)}  ${r.ms.toFixed(1)} ms`)
          return send(r.wasm, 'application/wasm')
        }
      } catch (e) {
        if (!(e instanceof NibError)) throw e
        console.error(e.message)
        const text = e.message.replace(/[&<]/g, c => c === '&' ? '&amp;' : '&lt;')
        return send(`<!doctype html><title>nib: error</title><pre>${text}</pre><script src="/__nib.js"></script>`, 'text/html;charset=utf-8', 500)
      }
      return existsSync(file) && statSync(file).isFile() ? send(Bun.file(file)) : send('not found', 'text/plain', 404)
    },
    websocket: { open(ws) { ws.subscribe('reload') }, message() {} },
  })
  for (const dir of [root, std]) watch(dir, { recursive: true }, () => server.publish('reload', ''))
  console.log(`nib dev  ${server.url}`)
}

const [cmd, site, ...rest] = process.argv.slice(2)
const flag = (name: string) => { const i = rest.indexOf('--' + name); return i < 0 ? undefined : rest[i + 1] ?? '' }
try {
  if (cmd === 'build' && site) build(site, flag('out') ?? 'dist', flag('debug') !== undefined)
  else if (cmd === 'dev' && site) dev(site, Number(flag('port') ?? 3000))
  else { console.log('usage: nib build <site> [--out dist] [--debug]\n       nib dev <site> [--port 3000]'); process.exit(1) }
} catch (e) {
  if (!(e instanceof NibError)) throw e
  console.error(e.message)
  process.exit(1)
}
