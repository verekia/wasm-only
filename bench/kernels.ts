// Kernels that are measured three ways: this file compiled to Wasm by Nib, this file run as
// plain JavaScript, and kernels.c compiled by clang. All three must return the same bits.

import { f32x4 } from 'nib'
import type { i32, u32 } from 'nib'

// ---- n-body: f64 arithmetic over rows in a typed array

const SOLAR = 4 * Math.PI * Math.PI, YEAR = 365.24
const BODY = 7                    // x y z, velocity x y z, mass
const bodies = new Float64Array(5 * BODY)
const START = new Float64Array([
  0, 0, 0, 0, 0, 0, SOLAR,
  4.84143144246472090, -1.16032004402742839, -0.103622044471123109, 0.00166007664274403694 * YEAR, 0.00769901118419740425 * YEAR, -0.0000690460016972063023 * YEAR, 0.000954791938424326609 * SOLAR,
  8.34336671824457987, 4.12479856412430479, -0.403523417114321381, -0.00276742510726862411 * YEAR, 0.00499852801234917238 * YEAR, 0.0000230417297573763929 * YEAR, 0.000285885980666130812 * SOLAR,
  12.8943695621391310, -15.1111514016986312, -0.223307578892655734, 0.00296460137564761618 * YEAR, 0.00237847173959480950 * YEAR, -0.0000296589568540237556 * YEAR, 0.0000436624404335156298 * SOLAR,
  15.3796971148509165, -25.9193146099879641, 0.179258772950371181, 0.00268067772490389322 * YEAR, 0.00162824170038242295 * YEAR, -0.0000951592254519715870 * YEAR, 0.0000515138902046611451 * SOLAR,
])

function energy(): number {
  let e = 0.5
  e = 0
  for (let i = 0; i < 5; i++) {
    const a = i * BODY
    e += 0.5 * bodies[a + 6] * (bodies[a + 3] * bodies[a + 3] + bodies[a + 4] * bodies[a + 4] + bodies[a + 5] * bodies[a + 5])
    for (let j = i + 1; j < 5; j++) {
      const b = j * BODY
      const dx = bodies[a] - bodies[b], dy = bodies[a + 1] - bodies[b + 1], dz = bodies[a + 2] - bodies[b + 2]
      e -= bodies[a + 6] * bodies[b + 6] / Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
  }
  return e
}

export function nbody(steps: i32): number {
  bodies.set(START)
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < 5; i++) {
      const a = i * BODY
      for (let j = i + 1; j < 5; j++) {
        const b = j * BODY
        const dx = bodies[a] - bodies[b], dy = bodies[a + 1] - bodies[b + 1], dz = bodies[a + 2] - bodies[b + 2]
        const d2 = dx * dx + dy * dy + dz * dz
        const mag = 0.01 / (d2 * Math.sqrt(d2))
        bodies[a + 3] -= dx * bodies[b + 6] * mag
        bodies[a + 4] -= dy * bodies[b + 6] * mag
        bodies[a + 5] -= dz * bodies[b + 6] * mag
        bodies[b + 3] += dx * bodies[a + 6] * mag
        bodies[b + 4] += dy * bodies[a + 6] * mag
        bodies[b + 5] += dz * bodies[a + 6] * mag
      }
    }
    for (let i = 0; i < 5; i++) {
      const b = i * BODY
      bodies[b] += 0.01 * bodies[b + 3]
      bodies[b + 1] += 0.01 * bodies[b + 4]
      bodies[b + 2] += 0.01 * bodies[b + 5]
    }
  }
  return energy()
}

// ---- mandelbrot: a branchy f64 loop held entirely in locals

export function mandelbrot(size: i32, limit: i32): i32 {
  let total = 0
  const scale = 2 / size
  for (let py = 0; py < size; py++) {
    const ci = py * scale - 1
    for (let px = 0; px < size; px++) {
      const cr = px * scale - 1.5
      let zr = 0.5, zi = 0.5, i = 0
      zr = 0
      zi = 0
      while (i < limit && zr * zr + zi * zi <= 4) {
        const t = zr * zr - zi * zi + cr
        zi = 2 * zr * zi + ci
        zr = t
        i++
      }
      total += i
    }
  }
  return total
}

// ---- particles on springs: float32 arrays, the shape of most game update loops

const COUNT = 4096
const X = new Float32Array(COUNT), Y = new Float32Array(COUNT), VX = new Float32Array(COUNT), VY = new Float32Array(COUNT)

function reset(): void {
  for (let i = 0; i < COUNT; i++) {
    X[i] = Math.fround((i & 63) * Math.fround(0.1)) - 3
    Y[i] = Math.fround((i >> 6) * Math.fround(0.1)) - 3
    VX[i] = 0
    VY[i] = 0
  }
}

/** The usual way to write it: numbers are doubles, the arrays round them to float32. */
export function particles(steps: i32): number {
  reset()
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < COUNT; i++) {
      const vx = (VX[i] - X[i] * 0.05) * 0.999, vy = (VY[i] - Y[i] * 0.05) * 0.999
      VX[i] = vx
      VY[i] = vy
      X[i] += vx * 0.016
      Y[i] += vy * 0.016
    }
  }
  let sum = 0.5
  sum = 0
  for (let i = 0; i < COUNT; i++) sum += X[i] + Y[i]
  return sum
}

/** The same update in float32, four particles at a time. */
export function particlesSimd(steps: i32): number {
  reset()
  const K = f32x4.splat(0.05), DAMP = f32x4.splat(0.999), DT = f32x4.splat(0.016)
  for (let s = 0; s < steps; s++) {
    for (let i = 0; i < COUNT; i += 4) {
      const x = f32x4.load(X, i), y = f32x4.load(Y, i)
      const u = f32x4.mul(f32x4.sub(f32x4.load(VX, i), f32x4.mul(x, K)), DAMP)
      const v = f32x4.mul(f32x4.sub(f32x4.load(VY, i), f32x4.mul(y, K)), DAMP)
      f32x4.store(VX, i, u)
      f32x4.store(VY, i, v)
      f32x4.store(X, i, f32x4.add(x, f32x4.mul(u, DT)))
      f32x4.store(Y, i, f32x4.add(y, f32x4.mul(v, DT)))
    }
  }
  let sum = Math.fround(0)
  for (let i = 0; i < COUNT; i++) sum = Math.fround(sum + Math.fround(X[i] + Y[i]))
  return sum
}

// ---- 4x4 matrix products

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
const TURN = new Float32Array([0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0, 0, 0, 1, 0, 0.001, 0.002, 0.003, 1])
const da = new Float64Array(16), db = new Float64Array(16)
const fa = new Float32Array(16), fb = new Float32Array(16)

/** The usual way to write it in JavaScript: doubles, unrolled by hand. */
export function mat4(n: i32): number {
  for (let i = 0; i < 16; i++) { da[i] = IDENTITY[i]; db[i] = TURN[i] }
  for (let i = 0; i < n; i++) {
    const a11 = da[0], a21 = da[1], a31 = da[2], a41 = da[3], a12 = da[4], a22 = da[5], a32 = da[6], a42 = da[7]
    const a13 = da[8], a23 = da[9], a33 = da[10], a43 = da[11], a14 = da[12], a24 = da[13], a34 = da[14], a44 = da[15]
    for (let j = 0; j < 16; j += 4) {
      const b1 = db[j], b2 = db[j + 1], b3 = db[j + 2], b4 = db[j + 3]
      da[j] = a11 * b1 + a12 * b2 + a13 * b3 + a14 * b4
      da[j + 1] = a21 * b1 + a22 * b2 + a23 * b3 + a24 * b4
      da[j + 2] = a31 * b1 + a32 * b2 + a33 * b3 + a34 * b4
      da[j + 3] = a41 * b1 + a42 * b2 + a43 * b3 + a44 * b4
    }
  }
  let sum = 0.5
  sum = 0
  for (let i = 0; i < 16; i++) sum += da[i]
  return sum
}

/** In float32, a column at a time. */
export function mat4Simd(n: i32): number {
  fa.set(IDENTITY)
  fb.set(TURN)
  for (let i = 0; i < n; i++) {
    const a0 = f32x4.load(fa, 0), a1 = f32x4.load(fa, 4), a2 = f32x4.load(fa, 8), a3 = f32x4.load(fa, 12)
    for (let j = 0; j < 4; j++) {
      const c = f32x4.load(fb, j * 4)
      f32x4.store(fa, j * 4, f32x4.add(f32x4.add(f32x4.add(
        f32x4.mul(a0, f32x4.splat(c.x)), f32x4.mul(a1, f32x4.splat(c.y))), f32x4.mul(a2, f32x4.splat(c.z))), f32x4.mul(a3, f32x4.splat(c.w))))
    }
  }
  const s = f32x4.add(f32x4.add(f32x4.add(f32x4.load(fa, 0), f32x4.load(fa, 4)), f32x4.load(fa, 8)), f32x4.load(fa, 12))
  return Math.fround(Math.fround(Math.fround(s.x + s.y) + s.z) + s.w)
}

// ---- sieve: byte loads and stores with a variable stride

const flags = new Uint8Array(2000000)

export function sieve(n: i32): i32 {
  flags.fill(1, 0, n)
  let count = 0
  for (let i = 2; i < n; i++) {
    if (flags[i] !== 0) {
      count++
      for (let j = i + i; j < n; j += i) flags[j] = 0
    }
  }
  return count
}

// ---- integer mixing

export function hash(n: i32): u32 {
  let h = 2166136261 | 0
  for (let i = 0; i < n; i++) {
    h = Math.imul(h ^ i, 16777619)
    h = h ^ (h >>> 13)
    h = ((h << 7 | h >>> 25) + i) | 0
  }
  return h >>> 0
}

// ---- calls

export function fib(n: i32): i32 { return n < 2 ? n : fib(n - 1) + fib(n - 2) }
