// Times each kernel three ways. Plain JavaScript so it runs unchanged in Bun, Node and a browser.
//   c:   kernels.c through clang -O3
//   nib: kernels.ts through Nib
//   js:  kernels.ts as it is

// [kernel in kernels.ts, its twin in kernels.c, arguments, note]
export const KERNELS = [
  ['hash', 'hash', [20000000]],
  ['sieve', 'sieve', [2000000]],
  ['mandelbrot', 'mandelbrot', [400, 200]],
  ['nbody', 'nbody', [200000]],
  ['fib', 'fib', [32]],
  ['mat4', 'mat4_f64', [2000000]],
  ['particles', 'particles_f64', [2000]],
  ['mat4Simd', 'mat4', [2000000], 'simd'],
  ['particlesSimd', 'particles', [2000], 'simd'],
]

function best(f, args, rounds) {
  for (let i = 0; i < Math.min(3, rounds); i++) f(...args)       // let the engine reach its optimising tier
  let ms = Infinity, result
  for (let i = 0; i < rounds; i++) { const t = performance.now(); result = f(...args); ms = Math.min(ms, performance.now() - t) }
  return [ms, result]
}

/** Rows of { name, c, nib, js, same }: best-of-`rounds` milliseconds per call, and whether all three results agree. */
export function measure(c, nib, js, rounds = 7) {
  return KERNELS.map(([name, twin, args, note]) => {
    const [cMs, cResult] = best(c[twin], args, rounds), [nibMs, nibResult] = best(nib[name], args, rounds)
    // the uncompiled f32x4 is a stand-in made of objects: it is run once, for its answer only
    const [jsMs, jsResult] = note === 'simd' ? [NaN, js[name](...args)] : best(js[name], args, rounds)
    const unsigned = x => name === 'hash' ? x >>> 0 : x
    return { name, c: cMs, nib: nibMs, js: jsMs, same: unsigned(cResult) === nibResult && nibResult === jsResult }
  })
}

export function report(rows) {
  const num = (x, w) => (Number.isNaN(x) ? '-' : x.toFixed(x < 10 ? 2 : 1)).padStart(w)
  const lines = ['kernel            C -O3      Nib  plain JS    Nib/C     JS/C   results', '-'.repeat(73)]
  for (const r of rows) lines.push(`${r.name.padEnd(15)}${num(r.c, 8)}${num(r.nib, 9)}${num(r.js, 10)}${num(r.nib / r.c, 9)}${num(r.js / r.c, 9)}   ${r.same ? 'identical' : 'DIFFER'}`)
  return lines.join('\n')
}
