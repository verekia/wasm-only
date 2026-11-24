#!/usr/bin/env bun
// nib build <site> [--out dist] [--debug]     compile a site: a folder, an .html file or a .ts file
// nib dev   <site> [--port 3000]              serve it: compiles on every request, reloads on save
//
// A page loads a program as it would load any module: <script type="module" src="main.ts">.
// The build compiles main.ts to main.wasm and writes main.js, an ES module with the same
// exports that loads it. In `nib dev`, adding ?js to a page's URL runs the TypeScript itself,
// uncompiled, to compare.

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { brotliCompressSync } from 'node:zlib'
import { compile } from './compiler.ts'
import { moduleSource } from './loader.ts'
import { NibError } from './syntax.ts'

const lib = resolve(import.meta.dir, '../lib')
const TAG = /<script\s+type="module"\s+src="([^"]+)\.ts"\s*>\s*<\/script>/g
// What the dev server sends, so a page that would break under a strict policy breaks here first.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'"

function compileFile(path: string, debug: boolean) {
  const t = performance.now()
  const out = compile(path, { read: p => readFileSync(p, 'utf8'), lib, debug })
  return { ...out, ms: performance.now() - t }
}

/** Rewrites a page. `emit` is given each program's source path and name, and returns the URLs to load. */
function page(path: string, emit: (source: string, name: string) => { wasm?: string; js: string }): string {
  return readFileSync(path, 'utf8').replace(TAG, (_, name: string) => {
    const { wasm, js } = emit(join(dirname(path), name + '.ts'), name)
    // the preload lets the module download while the script does, instead of after it
    return `${wasm ? `<link rel="preload" as="fetch" crossorigin href="${wasm}">` : ''}<script type="module" src="${js}"></script>`
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
  if (site.endsWith('.ts')) {                        // a lone program
    const r = compileFile(site, debug), name = basename(site, '.ts')
    write(join(out, name + '.wasm'), r.wasm, `compiled in ${r.ms.toFixed(1)} ms`)
    write(join(out, name + '.js'), moduleSource(r.glue, name + '.wasm'))
    return
  }
  const dir = site.endsWith('.html') ? dirname(site) : site
  const pages = site.endsWith('.html') ? [basename(site)] : [...new Bun.Glob('**/*.html').scanSync(dir)].sort()
  cpSync(dir, out, { recursive: true, filter: p => !/\.(ts|wgsl)$/.test(p) })
  for (const name of pages) {
    const html = page(join(dir, name), (source, program) => {
      // content-hashed names: both files can be cached forever, and can never be mismatched
      const r = compileFile(source, debug), wasm = `${program}-${hash(r.wasm)}.wasm`
      const script = moduleSource(r.glue, basename(wasm)), js = `${program}-${hash(script)}.js`
      write(join(out, dirname(name), wasm), r.wasm, `compiled in ${r.ms.toFixed(1)} ms`)
      write(join(out, dirname(name), js), script)
      return { wasm, js }
    })
    write(join(out, name), html)
  }
}

/** The TypeScript as the browser can run it with no compiler: types stripped, imports pointed at this server. */
function uncompiled(file: string): string {
  if (!file.endsWith('.ts')) return `export default ${JSON.stringify(readFileSync(file, 'utf8'))}`      // text imports
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(file, 'utf8'))
    .replace(/(from\s*)(["'])([^"']+)\2(\s*with\s*\{[^}]*\})?/g, (_, from, q, spec: string) => {
      const to = spec === 'nib' ? '/@nib/index.ts' : spec.startsWith('nib/') ? `/@nib/${spec.slice(4)}.ts` : /\.\w+$/.test(spec) ? spec : spec + '.ts'
      return `${from}${q}${to}?js${q}`
    })
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
      const url = new URL(req.url), raw = url.searchParams.has('js')
      let path = decodeURIComponent(url.pathname)
      if (path === '/__nib') return server.upgrade(req) ? undefined : send(null, undefined, 400)
      if (path === '/__nib.js') return send(reload, 'text/javascript')
      if (path.includes('..')) return send(null, undefined, 400)
      if (!path.endsWith('/') && existsSync(join(root, path)) && statSync(join(root, path)).isDirectory()) return Response.redirect(path + '/' + url.search)
      if (path.endsWith('/')) path += 'index.html'
      const file = path.startsWith('/@nib/') ? join(lib, path.slice(6)) : join(root, path)
      try {
        if (path.endsWith('.html') && existsSync(file)) {
          const html = page(file, (source, name) => raw ? { js: name + '.ts?js' } : (compileFile(source, true), { wasm: name + '.wasm', js: name + '.ts' }))
          return send(html + '<script src="/__nib.js"></script>', 'text/html;charset=utf-8')
        }
        if (raw && existsSync(file)) return send(uncompiled(file), 'text/javascript')
        const source = file.replace(/\.wasm$/, '.ts')
        if (/\.(ts|wasm)$/.test(path) && existsSync(source)) {
          const r = compileFile(source, true)
          if (path.endsWith('.ts')) return send(moduleSource(r.glue, basename(source, '.ts') + '.wasm'), 'text/javascript')
          console.log(`${path}  ${kb(r.wasm.length)}  ${r.ms.toFixed(1)} ms`)
          return send(r.wasm, 'application/wasm')
        }
      } catch (e) {
        if (!(e instanceof NibError)) throw e
        console.error(e.message)
        const text = e.message.replace(/[&<]/g, c => c === '&' ? '&amp;' : '&lt;')
        if (!path.endsWith('.html')) return send(`throw Error(${JSON.stringify(e.message)})`, 'text/javascript', 500)
        return send(`<!doctype html><title>nib: error</title><pre>${text}</pre><script src="/__nib.js"></script>`, 'text/html;charset=utf-8', 500)
      }
      return existsSync(file) && statSync(file).isFile() ? send(Bun.file(file)) : send('not found', 'text/plain', 404)
    },
    websocket: { open(ws) { ws.subscribe('reload') }, message() {} },
  })
  for (const dir of [root, lib]) watch(dir, { recursive: true }, () => server.publish('reload', ''))
  console.log(`nib dev  ${server.url}   (add ?js to a page to run its TypeScript uncompiled)`)
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
