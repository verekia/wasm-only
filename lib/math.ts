// Math for graphics. Plain TypeScript: it gives the same digits compiled and as JavaScript,
// in every browser, and none of it calls out of Wasm.

import { f32x4 } from 'nib'
import type { i32 } from 'nib'

export const PI = Math.PI
export const TAU = Math.PI * 2

/** Sine by range reduction and an odd polynomial. Error below 1e-9. */
export function sin(x: number): number {
  let r = x - TAU * Math.floor(x * (1 / TAU) + 0.5)               // wrap into [-pi, pi]
  if (Math.abs(r) > PI * 0.5) r = (r > 0 ? PI : -PI) - r          // fold into [-pi/2, pi/2]
  const s = r * r
  return r * (1 + s * (-1 / 6 + s * (1 / 120 + s * (-1 / 5040 + s * (1 / 362880 + s * (-1 / 39916800 + s * (1 / 6227020800)))))))
}
export function cos(x: number): number { return sin(x + PI * 0.5) }

export function clamp(x: number, low: number, high: number): number { return Math.min(Math.max(x, low), high) }

// ---- random numbers: xorshift, fast and repeatable from a seed

let randomState: i32 = 0x9e3779b9 | 0

export function randomSeed(seed: number): void { randomState = seed | 1 }

/** Uniform in [0, 1). */
export function random(): number {
  let x = randomState
  x ^= x << 13
  x ^= x >>> 17
  x ^= x << 5
  randomState = x
  return (x >>> 8) / 16777216
}

// ---- quaternions (rotations)

export interface Quat { readonly x: number; readonly y: number; readonly z: number; readonly w: number }

export function quatNormalize(q: Quat): Quat {
  const s = 1 / Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w)
  return { x: q.x * s, y: q.y * s, z: q.z * s, w: q.w * s }
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/**
 * Turns `q` by the angular velocity (wx, wy, wz), in radians per second, for `dt` seconds.
 * Integrating the rotation directly needs a square root and no trigonometry.
 */
export function quatSpin(q: Quat, wx: number, wy: number, wz: number, dt: number): Quat {
  const h = dt * 0.5
  return quatNormalize({
    x: q.x + h * (wx * q.w + wy * q.z - wz * q.y),
    y: q.y + h * (wy * q.w + wz * q.x - wx * q.z),
    z: q.z + h * (wz * q.w + wx * q.y - wy * q.x),
    w: q.w - h * (wx * q.x + wy * q.y + wz * q.z),
  })
}

// ---- 4x4 matrices: sixteen float32, column by column, the layout WGSL's mat4x4f expects.
// Pass a Float32Array(16), or a 16-element subarray of something bigger.

/** out = a * b. `out` may be `a` or `b`. @inline */
export function mat4Mul(out: Float32Array, a: Float32Array, b: Float32Array): void {
  const a0 = f32x4.load(a, 0), a1 = f32x4.load(a, 4), a2 = f32x4.load(a, 8), a3 = f32x4.load(a, 12)
  for (let j = 0; j < 4; j++) {
    const c = f32x4.load(b, j * 4)
    f32x4.store(out, j * 4, f32x4.add(
      f32x4.add(f32x4.mul(a0, f32x4.splat(c.x)), f32x4.mul(a1, f32x4.splat(c.y))),
      f32x4.add(f32x4.mul(a2, f32x4.splat(c.z)), f32x4.mul(a3, f32x4.splat(c.w)))))
  }
}

/** @inline */
export function mat4FromQuat(out: Float32Array, q: Quat): void {
  const x2 = q.x + q.x, y2 = q.y + q.y, z2 = q.z + q.z
  const xx = q.x * x2, xy = q.x * y2, xz = q.x * z2
  const yy = q.y * y2, yz = q.y * z2, zz = q.z * z2
  const wx = q.w * x2, wy = q.w * y2, wz = q.w * z2
  f32x4.store(out, 0, f32x4(1 - (yy + zz), xy + wz, xz - wy, 0))
  f32x4.store(out, 4, f32x4(xy - wz, 1 - (xx + zz), yz + wx, 0))
  f32x4.store(out, 8, f32x4(xz + wy, yz - wx, 1 - (xx + yy), 0))
  f32x4.store(out, 12, f32x4(0, 0, 0, 1))
}

/** @inline */
export function mat4Translation(out: Float32Array, x: number, y: number, z: number): void {
  f32x4.store(out, 0, f32x4(1, 0, 0, 0))
  f32x4.store(out, 4, f32x4(0, 1, 0, 0))
  f32x4.store(out, 8, f32x4(0, 0, 1, 0))
  f32x4.store(out, 12, f32x4(x, y, z, 1))
}

/** The view matrix of a camera at (ex, ey, ez) looking at (tx, ty, tz), with +y up. @inline */
export function mat4LookAt(out: Float32Array, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number): void {
  const dx = tx - ex, dy = ty - ey, dz = tz - ez
  const d = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz)
  const fx = dx * d, fy = dy * d, fz = dz * d                 // forward
  const s = 1 / Math.sqrt(fx * fx + fz * fz)
  const sx = -fz * s, sz = fx * s                             // side = forward × up
  const ux = -sz * fy, uy = sz * fx - sx * fz, uz = sx * fy   // up = side × forward
  f32x4.store(out, 0, f32x4(sx, ux, -fx, 0))
  f32x4.store(out, 4, f32x4(0, uy, -fy, 0))
  f32x4.store(out, 8, f32x4(sz, uz, -fz, 0))
  f32x4.store(out, 12, f32x4(-(sx * ex + sz * ez), -(ux * ex + uy * ey + uz * ez), fx * ex + fy * ey + fz * ez, 1))
}

/** Right-handed, looking down -z, depth 0..1 (WebGPU clip space). `focal` is 1 / tan(fov / 2). @inline */
export function mat4Perspective(out: Float32Array, focal: number, aspect: number, near: number, far: number): void {
  const r = 1 / (near - far)
  f32x4.store(out, 0, f32x4(focal / aspect, 0, 0, 0))
  f32x4.store(out, 4, f32x4(0, focal, 0, 0))
  f32x4.store(out, 8, f32x4(0, 0, far * r, -1))
  f32x4.store(out, 12, f32x4(0, 0, near * far * r, 0))
}
