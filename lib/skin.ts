// Skeletal animation for crowds. Rigs, clips and characters live in flat arrays. One call a
// frame samples every clip, blends, walks every skeleton and leaves the skin matrices in one
// array, ready to upload. A .rig file (examples/crowd/convert.ts makes one from a glTF) is
// copied in as it is: nothing is parsed.

import { compiled, f32x4 } from 'nib'
import type { i32 } from 'nib'
import { cos, sin } from './math.ts'

const MAGIC = 0x4749524e, HEADER = 16
const FRAME = 12                         // floats a joint a frame: translation xyz1, rotation xyzw, scale xyz0
const STATE = 8                          // floats a character: time, time of the clip fading out, its weight, weight lost a second, speed
const MAX_RIGS = 32, MAX_JOINTS = 255
/** Bytes a vertex in a .rig file: position f32x3, normal i8x4, colour u8x4, joints u8x4, weights u8x4. */
export const RIG_VERTEX = 28

// ---- rigs

let rigs = 0, jointTotal = 0, clipTotal = 0, frameTotal = 0
const rigJoints = new Int32Array(MAX_RIGS)
const rigClips = new Int32Array(MAX_RIGS)
const rigJoint0 = new Int32Array(MAX_RIGS)       // where the rig starts in `parents` and `inverseBind`
const rigClip0 = new Int32Array(MAX_RIGS)        // and in the clip tables
let parents: Int32Array = new Int32Array(0)                  // -1 for a root; a parent comes before its children
let inverseBind: Float32Array = new Float32Array(0)
let clipAt: Int32Array = new Int32Array(0)                   // the clip's first frame, as an index into `frames`
let clipLast: Int32Array = new Int32Array(0)                 // the number of its last frame
let clipLoops: Int32Array = new Int32Array(0)
let clipSeconds: Float32Array = new Float32Array(0)
let clipRate: Float32Array = new Float32Array(0)               // frames a second
let frames: Float32Array = new Float32Array(0)

// ---- characters

let count = 0, slots = 0
let rigOf: Int32Array = new Int32Array(0)
let slotOf: Int32Array = new Int32Array(0)                   // the character's first matrix in `palette`
let clips: Int32Array = new Int32Array(0)                    // two a character: playing, and fading out
let state: Float32Array = new Float32Array(0)
let model: Float32Array = new Float32Array(0)                  // where the character stands: a 4x4 matrix
let palette: Float32Array = new Float32Array(0)                // the result: a 4x4 matrix a joint, every character in turn
const world = new Float32Array((MAX_JOINTS + 1) * 16)       // one skeleton being walked; slot 0 is the character's own matrix

function moreInts(a: Int32Array, n: i32): Int32Array {
  if (n <= a.length) return a
  const b = new Int32Array(Math.max(n, a.length * 2))
  b.set(a)
  return b
}
function moreFloats(a: Float32Array, n: i32): Float32Array {
  if (n <= a.length) return a
  const b = new Float32Array(Math.max(n, a.length * 2))
  b.set(a)
  return b
}

function rigMeshAt(file: ArrayBuffer): i32 {
  const h = new Int32Array(file, 0, HEADER), J: i32 = h[1], C: i32 = h[2], F: i32 = h[3]
  return HEADER * 4 + J * 68 + C * 16 + F * J * FRAME * 4
}
export function rigVertexCount(file: ArrayBuffer): i32 { return new Int32Array(file, 0, HEADER)[4] }
export function rigIndexCount(file: ArrayBuffer): i32 { return new Int32Array(file, 0, HEADER)[5] }
/** Where the vertices start in the file, in bytes. There are rigVertexCount() of RIG_VERTEX bytes each. */
export function rigVertexOffset(file: ArrayBuffer): i32 { return rigMeshAt(file) }
/** Where the 16-bit indices start in the file, in bytes. */
export function rigIndexOffset(file: ArrayBuffer): i32 { return rigMeshAt(file) + rigVertexCount(file) * RIG_VERTEX }
export function rigClipNames(file: ArrayBuffer): string[] {
  const at = rigIndexOffset(file) + ((rigIndexCount(file) * 2 + 3) & -4), bytes: i32 = new Int32Array(file, 0, HEADER)[6]
  return new TextDecoder().decode(new Uint8Array(file, at, bytes)).split('\n')
}

/** Adds the skeleton and clips of a .rig file. Returns the rig's number, or -1 if the file is not one. */
export function skinRig(file: ArrayBuffer): i32 {
  const head = new Int32Array(file, 0, HEADER)
  const J: i32 = head[1], C: i32 = head[2], F: i32 = head[3]
  if (head[0] !== MAGIC || rigs === MAX_RIGS || J > MAX_JOINTS) return -1
  let at = HEADER * 4
  parents = moreInts(parents, jointTotal + J)
  parents.set(new Int32Array(file, at, J), jointTotal)
  at += J * 4
  inverseBind = moreFloats(inverseBind, (jointTotal + J) * 16)
  inverseBind.set(new Float32Array(file, at, J * 16), jointTotal * 16)
  at += J * 64

  clipAt = moreInts(clipAt, clipTotal + C)
  clipLast = moreInts(clipLast, clipTotal + C)
  clipLoops = moreInts(clipLoops, clipTotal + C)
  clipSeconds = moreFloats(clipSeconds, clipTotal + C)
  clipRate = moreFloats(clipRate, clipTotal + C)
  const first = new Int32Array(file, at, C), length = new Int32Array(file, at + C * 4, C)
  clipLoops.set(new Int32Array(file, at + C * 8, C), clipTotal)
  clipSeconds.set(new Float32Array(file, at + C * 12, C), clipTotal)
  for (let c = 0; c < C; c++) {
    const f: i32 = first[c], n: i32 = length[c]
    clipAt[clipTotal + c] = frameTotal + f * J * FRAME
    clipLast[clipTotal + c] = n - 1
    clipRate[clipTotal + c] = (n - 1) / clipSeconds[clipTotal + c]
  }
  at += C * 16
  frames = moreFloats(frames, frameTotal + F * J * FRAME)
  frames.set(new Float32Array(file, at, F * J * FRAME), frameTotal)

  rigJoints[rigs] = J
  rigClips[rigs] = C
  rigJoint0[rigs] = jointTotal
  rigClip0[rigs] = clipTotal
  jointTotal += J
  clipTotal += C
  frameTotal += F * J * FRAME
  return rigs++
}

export function skinRigJoints(rig: i32): i32 { return rigJoints[rig] }
export function skinRigClips(rig: i32): i32 { return rigClips[rig] }
/** Whether a clip of a rig ends as it starts, so it can repeat. */
export function skinClipLoops(rig: i32, clip: i32): boolean { return clipLoops[rigClip0[rig] + clip] !== 0 }
/** How long a clip of a rig lasts, in seconds. */
export function skinClipSeconds(rig: i32, clip: i32): number { return clipSeconds[rigClip0[rig] + clip] }

// ---- characters

/** Adds a character of a rig, standing at the origin and playing clip 0. Returns its number. */
export function skinSpawn(rig: i32): i32 {
  const i = count++
  rigOf = moreInts(rigOf, count)
  slotOf = moreInts(slotOf, count)
  clips = moreInts(clips, count * 2)
  state = moreFloats(state, count * STATE)
  model = moreFloats(model, count * 16)
  palette = moreFloats(palette, (slots + rigJoints[rig]) * 16)
  rigOf[i] = rig
  slotOf[i] = slots
  slots += rigJoints[rig]
  clips[i * 2] = rigClip0[rig]
  state.fill(0, i * STATE, i * STATE + STATE)
  state[i * STATE + 4] = 1
  skinPlace(i, 0, 0, 0, 0, 1)
  return i
}

/** Removes every character. Rigs stay. */
export function skinClear(): void { count = 0; slots = 0 }

export function skinCount(): i32 { return count }
/** The character's first matrix in skinMatrices(). It has one a joint. */
export function skinSlot(i: i32): i32 { return slotOf[i] }
/** The skin matrices of every character, as skinUpdate() left them: 16 floats each. */
export function skinMatrices(): Float32Array { return palette.subarray(0, slots * 16) }

/** Puts the character at (x, y, z), turned by `yaw` radians about the up axis (z). */
export function skinPlace(i: i32, x: number, y: number, z: number, yaw: number, scale: number): void {
  const m = i * 16, c = cos(yaw) * scale, s = sin(yaw) * scale
  model.fill(0, m, m + 16)
  model[m] = c; model[m + 1] = s
  model[m + 4] = -s; model[m + 5] = c
  model[m + 10] = scale
  model[m + 12] = x; model[m + 13] = y; model[m + 14] = z; model[m + 15] = 1
}

/** Starts a clip of the character's rig. The one playing fades out over `fade` seconds. */
export function skinPlay(i: i32, clip: i32, fade: number): void {
  const s = i * STATE
  if (fade > 0) {
    clips[i * 2 + 1] = clips[i * 2]
    state[s + 1] = state[s]
    state[s + 2] = 1
    state[s + 3] = 1 / fade
  } else state[s + 2] = 0
  clips[i * 2] = rigClip0[rigOf[i]] + clip
  state[s] = 0
}

/** Moves the playing clip to `seconds` from its start. */
export function skinSeek(i: i32, seconds: number): void { state[i * STATE] = wrapped(clips[i * 2], seconds) }
/** 1 plays the character's clips as they were made. */
export function skinSpeed(i: i32, speed: number): void { state[i * STATE + 4] = speed }

function wrapped(clip: i32, t: number): number {
  const d = clipSeconds[clip]
  if (t < d) return t
  return clipLoops[clip] ? t - d * Math.floor(t / d) : d
}

function advance(i: i32, dt: number): void {
  const s = i * STATE, step = dt * state[s + 4], w = state[s + 2]
  state[s] = wrapped(clips[i * 2], state[s] + step)
  if (w > 0) {
    state[s + 1] = wrapped(clips[i * 2 + 1], state[s + 1] + step)
    state[s + 2] = Math.max(0, w - dt * state[s + 3])
  }
}

/** Advances every character by `dt` seconds and computes its skin matrices. */
export function skinUpdate(dt: number): void {
  if (compiled) skinUpdateSimd(dt)
  else skinUpdateScalar(dt)
}

export function skinUpdateScalar(dt: number): void {
  for (let i = 0; i < count; i++) { advance(i, dt); poseScalar(i) }
}

/** The same with four floats at a time. As JavaScript it is slow: it is there to check answers. */
export function skinUpdateSimd(dt: number): void {
  for (let i = 0; i < count; i++) { advance(i, dt); poseSimd(i) }
}

function mix(a: number, b: number, t: number): number { return a + (b - a) * t }

function poseScalar(i: i32): void {
  const rig = rigOf[i], J = rigJoints[rig], j0 = rigJoint0[rig], row = J * FRAME, s = i * STATE
  const a = clips[i * 2], fa = state[s] * clipRate[a], ka = Math.min(fa | 0, clipLast[a] - 1), ta = fa - ka
  const pa = clipAt[a] + ka * row
  const w = state[s + 2]
  let pb = 0, tb: number = 0
  if (w > 0) {
    const b = clips[i * 2 + 1], fb = state[s + 1] * clipRate[b], kb = Math.min(fb | 0, clipLast[b] - 1)
    tb = fb - kb
    pb = clipAt[b] + kb * row
  }
  world.set(model.subarray(i * 16, i * 16 + 16))
  let out = slotOf[i] * 16
  for (let j = 0; j < J; j++) {
    const o = pa + j * FRAME, n = o + row
    let tx = mix(frames[o], frames[n], ta), ty = mix(frames[o + 1], frames[n + 1], ta), tz = mix(frames[o + 2], frames[n + 2], ta)
    let qx = mix(frames[o + 4], frames[n + 4], ta), qy = mix(frames[o + 5], frames[n + 5], ta), qz = mix(frames[o + 6], frames[n + 6], ta), qw = mix(frames[o + 7], frames[n + 7], ta)
    let sx = mix(frames[o + 8], frames[n + 8], ta), sy = mix(frames[o + 9], frames[n + 9], ta), sz = mix(frames[o + 10], frames[n + 10], ta)
    if (w > 0) {                                           // towards the clip that is fading out, the short way round
      const p = pb + j * FRAME, m = p + row
      const ux = mix(frames[p + 4], frames[m + 4], tb), uy = mix(frames[p + 5], frames[m + 5], tb), uz = mix(frames[p + 6], frames[m + 6], tb), uw = mix(frames[p + 7], frames[m + 7], tb)
      const k = qx * ux + qy * uy + qz * uz + qw * uw < 0 ? -1 : 1
      tx = mix(tx, mix(frames[p], frames[m], tb), w); ty = mix(ty, mix(frames[p + 1], frames[m + 1], tb), w); tz = mix(tz, mix(frames[p + 2], frames[m + 2], tb), w)
      qx = mix(qx, ux * k, w); qy = mix(qy, uy * k, w); qz = mix(qz, uz * k, w); qw = mix(qw, uw * k, w)
      sx = mix(sx, mix(frames[p + 8], frames[m + 8], tb), w); sy = mix(sy, mix(frames[p + 9], frames[m + 9], tb), w); sz = mix(sz, mix(frames[p + 10], frames[m + 10], tb), w)
    }
    const inv = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
    qx *= inv; qy *= inv; qz *= inv; qw *= inv

    // the joint's own matrix, from its rotation and scale
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz
    const xx = qx * x2, yy = qy * y2, zz = qz * z2, xy = qx * y2, xz = qx * z2, yz = qy * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2
    const l00 = (1 - yy - zz) * sx, l10 = (xy + wz) * sx, l20 = (xz - wy) * sx
    const l01 = (xy - wz) * sy, l11 = (1 - xx - zz) * sy, l21 = (yz + wx) * sy
    const l02 = (xz + wy) * sz, l12 = (yz - wx) * sz, l22 = (1 - xx - yy) * sz

    // in the world: its parent's matrix times its own
    const p = (parents[j0 + j] + 1) * 16
    const p00 = world[p], p10 = world[p + 1], p20 = world[p + 2], p01 = world[p + 4], p11 = world[p + 5], p21 = world[p + 6]
    const p02 = world[p + 8], p12 = world[p + 9], p22 = world[p + 10], p03 = world[p + 12], p13 = world[p + 13], p23 = world[p + 14]
    const w00 = p00 * l00 + p01 * l10 + p02 * l20, w10 = p10 * l00 + p11 * l10 + p12 * l20, w20 = p20 * l00 + p21 * l10 + p22 * l20
    const w01 = p00 * l01 + p01 * l11 + p02 * l21, w11 = p10 * l01 + p11 * l11 + p12 * l21, w21 = p20 * l01 + p21 * l11 + p22 * l21
    const w02 = p00 * l02 + p01 * l12 + p02 * l22, w12 = p10 * l02 + p11 * l12 + p12 * l22, w22 = p20 * l02 + p21 * l12 + p22 * l22
    const w03 = p00 * tx + p01 * ty + p02 * tz + p03, w13 = p10 * tx + p11 * ty + p12 * tz + p13, w23 = p20 * tx + p21 * ty + p22 * tz + p23
    const v = (j + 1) * 16
    world[v] = w00; world[v + 1] = w10; world[v + 2] = w20; world[v + 3] = 0
    world[v + 4] = w01; world[v + 5] = w11; world[v + 6] = w21; world[v + 7] = 0
    world[v + 8] = w02; world[v + 9] = w12; world[v + 10] = w22; world[v + 11] = 0
    world[v + 12] = w03; world[v + 13] = w13; world[v + 14] = w23; world[v + 15] = 1

    // the skin matrix: from the mesh as it was bound, to where the joint is now
    const b = (j0 + j) * 16
    for (let c = 0; c < 16; c += 4) {                      // a bind matrix ends each column with 0, the last with 1
      const bx = inverseBind[b + c], by = inverseBind[b + c + 1], bz = inverseBind[b + c + 2]
      palette[out + c] = w00 * bx + w01 * by + w02 * bz
      palette[out + c + 1] = w10 * bx + w11 * by + w12 * bz
      palette[out + c + 2] = w20 * bx + w21 * by + w22 * bz
      palette[out + c + 3] = 0
    }
    palette[out + 12] += w03; palette[out + 13] += w13; palette[out + 14] += w23; palette[out + 15] = 1
    out += 16
  }
}

function lerp(a: f32x4, b: f32x4, t: f32x4): f32x4 { return f32x4.add(a, f32x4.mul(f32x4.sub(b, a), t)) }

/** c0 * x + c1 * y + c2 * z, each of x, y and z in all four lanes. */
function span(c0: f32x4, x: f32x4, c1: f32x4, y: f32x4, c2: f32x4, z: f32x4): f32x4 {
  return f32x4.add(f32x4.add(f32x4.mul(c0, x), f32x4.mul(c1, y)), f32x4.mul(c2, z))
}
function lane0(v: f32x4): f32x4 { return f32x4.shuffle(v, v, 0, 0, 0, 0) }
function lane1(v: f32x4): f32x4 { return f32x4.shuffle(v, v, 1, 1, 1, 1) }
function lane2(v: f32x4): f32x4 { return f32x4.shuffle(v, v, 2, 2, 2, 2) }

function poseSimd(i: i32): void {
  const rig = rigOf[i], J = rigJoints[rig], j0 = rigJoint0[rig], row = J * FRAME, s = i * STATE
  const a = clips[i * 2], fa = state[s] * clipRate[a], ka = Math.min(fa | 0, clipLast[a] - 1)
  const pa = clipAt[a] + ka * row, va = f32x4.splat(fa - ka)
  const w = state[s + 2], vw = f32x4.splat(w)
  let pb = 0, vb = va
  if (w > 0) {
    const b = clips[i * 2 + 1], fb = state[s + 1] * clipRate[b], kb = Math.min(fb | 0, clipLast[b] - 1)
    vb = f32x4.splat(fb - kb)
    pb = clipAt[b] + kb * row
  }
  for (let c = 0; c < 16; c += 4) f32x4.store(world, c, f32x4.load(model, i * 16 + c))
  const one = f32x4.splat(1)
  let out = slotOf[i] * 16
  for (let j = 0; j < J; j++) {
    const o = pa + j * FRAME, n = o + row
    let t = lerp(f32x4.load(frames, o), f32x4.load(frames, n), va)
    let q = lerp(f32x4.load(frames, o + 4), f32x4.load(frames, n + 4), va)
    let scale = lerp(f32x4.load(frames, o + 8), f32x4.load(frames, n + 8), va)
    if (w > 0) {
      const p = pb + j * FRAME, m = p + row
      let u = lerp(f32x4.load(frames, p + 4), f32x4.load(frames, m + 4), vb)
      const d = f32x4.mul(q, u)
      if (d.x + d.y + d.z + d.w < 0) u = f32x4.neg(u)
      t = lerp(t, lerp(f32x4.load(frames, p), f32x4.load(frames, m), vb), vw)
      q = lerp(q, u, vw)
      scale = lerp(scale, lerp(f32x4.load(frames, p + 8), f32x4.load(frames, m + 8), vb), vw)
    }
    const qq = f32x4.mul(q, q), half = f32x4.add(qq, f32x4.shuffle(qq, qq, 1, 0, 3, 2))
    q = f32x4.div(q, f32x4.sqrt(f32x4.add(half, f32x4.shuffle(half, half, 2, 3, 0, 1))))

    // the rotation's nine terms, three at a time:
    //   diagonal = (m00, m11, m22)    plus = (m10, m21, m02)    minus = (m01, m12, m20)
    const q2 = f32x4.add(q, q), yzx = f32x4.shuffle(q, q, 1, 2, 0, 3), zxy = f32x4.shuffle(q, q, 2, 0, 1, 3)
    const yzx2 = f32x4.shuffle(q2, q2, 1, 2, 0, 3), zxy2 = f32x4.shuffle(q2, q2, 2, 0, 1, 3)
    const diagonal = f32x4.sub(one, f32x4.add(f32x4.mul(yzx, yzx2), f32x4.mul(zxy, zxy2)))
    const pairs = f32x4.mul(q, yzx2), withW = f32x4.mul(f32x4.shuffle(q, q, 3, 3, 3, 3), zxy2)
    const plus = f32x4.add(pairs, withW), minus = f32x4.sub(pairs, withW)

    // in the world: the parent's matrix times this joint's, a column at a time, with no matrix of its own in between
    const p = (parents[j0 + j] + 1) * 16
    const p0 = f32x4.load(world, p), p1 = f32x4.load(world, p + 4), p2 = f32x4.load(world, p + 8)
    const w0 = f32x4.mul(span(p0, lane0(diagonal), p1, lane0(plus), p2, lane2(minus)), lane0(scale))
    const w1 = f32x4.mul(span(p0, lane0(minus), p1, lane1(diagonal), p2, lane1(plus)), lane1(scale))
    const w2 = f32x4.mul(span(p0, lane2(plus), p1, lane1(minus), p2, lane2(diagonal)), lane2(scale))
    const w3 = f32x4.add(span(p0, lane0(t), p1, lane1(t), p2, lane2(t)), f32x4.load(world, p + 12))
    const v = (j + 1) * 16
    f32x4.store(world, v, w0)
    f32x4.store(world, v + 4, w1)
    f32x4.store(world, v + 8, w2)
    f32x4.store(world, v + 12, w3)

    const b = (j0 + j) * 16
    for (let c = 0; c < 12; c += 4) {
      f32x4.store(palette, out + c, span(w0, f32x4.splat(inverseBind[b + c]), w1, f32x4.splat(inverseBind[b + c + 1]), w2, f32x4.splat(inverseBind[b + c + 2])))
    }
    f32x4.store(palette, out + 12, f32x4.add(span(w0, f32x4.splat(inverseBind[b + 12]), w1, f32x4.splat(inverseBind[b + 13]), w2, f32x4.splat(inverseBind[b + 14])), w3))
    out += 16
  }
}
