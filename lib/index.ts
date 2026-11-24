// What `import ... from 'nib'` gives a file when it runs as plain JavaScript. The compiler
// knows these names itself and never reads this file.

/**
 * Number types. To JavaScript and to the type checker they are all `number`. To the compiler
 * they pick the machine type of a variable, a parameter or a result.
 */
export type i32 = number
export type u32 = number
export type f32 = number
export type f64 = number

const { fround, min, max, abs, sqrt } = Math

/** Four float32 values that are computed together. In Wasm, one SIMD register. */
export interface f32x4 { readonly x: number; readonly y: number; readonly z: number; readonly w: number }

class Lanes implements f32x4 {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly w: number
  constructor(x: number, y: number, z: number, w: number) {
    this.x = fround(x); this.y = fround(y); this.z = fround(z); this.w = fround(w)
  }
}
const each = (f: (a: number, b: number) => number) => (a: f32x4, b: f32x4): f32x4 => new Lanes(f(a.x, b.x), f(a.y, b.y), f(a.z, b.z), f(a.w, b.w))
const map = (f: (a: number) => number) => (a: f32x4): f32x4 => new Lanes(f(a.x), f(a.y), f(a.z), f(a.w))

export const f32x4 = Object.assign((x: number, y: number, z: number, w: number): f32x4 => new Lanes(x, y, z, w), {
  splat: (x: number): f32x4 => new Lanes(x, x, x, x),
  /** The four elements of `a` starting at `i`. */
  load: (a: Float32Array, i: number): f32x4 => new Lanes(a[i], a[i + 1], a[i + 2], a[i + 3]),
  store: (a: Float32Array, i: number, v: f32x4): void => { a[i] = v.x; a[i + 1] = v.y; a[i + 2] = v.z; a[i + 3] = v.w },
  add: each((a, b) => a + b),
  sub: each((a, b) => a - b),
  mul: each((a, b) => a * b),
  div: each((a, b) => a / b),
  min: each(min),
  max: each(max),
  abs: map(abs),
  neg: map(a => -a),
  sqrt: map(sqrt),
})
