// Times each kernel in both modules. Plain JavaScript so it runs unchanged in Bun, Node and a browser.

export const KERNELS = [
  ['nbody', [200000]], ['mandelbrot', [400, 200]], ['particles', [2000]], ['particles_simd', [2000], 'particles'],
  ['mat4', [2000000]], ['sieve', [2000000]], ['hash', [20000000]], ['fib', [32]],
]

/** Returns rows of { name, c, nib, same }: best-of-`rounds` milliseconds per call, and whether results agree. */
export function measure(cBytes, nibBytes, rounds = 7) {
  const load = bytes => new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports
  const c = load(cBytes), nib = load(nibBytes)
  const best = (f, args) => {
    for (let i = 0; i < 3; i++) f(...args)             // let the engine reach its optimising tier
    let ms = Infinity, result
    for (let i = 0; i < rounds; i++) { const t = performance.now(); result = f(...args); ms = Math.min(ms, performance.now() - t) }
    return [ms, result]
  }
  return KERNELS.map(([name, args, cName = name]) => {
    const [cMs, cResult] = best(c[cName], args), [nibMs, nibResult] = best(nib[name], args)
    return { name, c: cMs, nib: nibMs, same: cResult === nibResult, result: nibResult }
  })
}

export function report(rows) {
  const lines = ['kernel            C -O3      Nib   Nib/C   results', '---------------------------------------------------']
  for (const r of rows) lines.push(`${r.name.padEnd(15)}${r.c.toFixed(1).padStart(8)}${r.nib.toFixed(1).padStart(9)}${(r.nib / r.c).toFixed(2).padStart(8)}   ${r.same ? 'identical' : 'DIFFER'}`)
  const geo = Math.exp(rows.reduce((s, r) => s + Math.log(r.nib / r.c), 0) / rows.length)
  lines.push(`${'geometric mean'.padEnd(32)}${geo.toFixed(2).padStart(8)}`)
  return lines.join('\n')
}
