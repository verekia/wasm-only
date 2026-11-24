// The .rig file: one skinned mesh, its skeleton and its clips as flat arrays, which nib/skin
// copies into memory with no parsing. convert.ts writes one from a glTF binary; dummyRig()
// makes one from nothing, so the example and the tests need no asset.
//
//   Int32   header[16]   magic, joints, clips, frames, vertices, indices, name bytes
//   Int32   parent[joints]                  -1 for a root; a parent always comes before its children
//   Float32 inverseBind[joints * 16]
//   Int32   clipFirst[clips], clipFrames[clips], clipLoops[clips]
//   Float32 clipSeconds[clips]
//   Float32 frames[frames * joints * 12]    translation xyz1, rotation xyzw, scale xyz0
//   Uint8   vertices[vertices * 28]         position f32x3, normal i8x4, colour u8x4, joints u8x4, weights u8x4
//   Uint16  indices[indices]                padded to four bytes
//   Uint8   names[name bytes]               clip names, one a line

export const RIG_MAGIC = 0x4749524e, FRAME_FLOATS = 12, VERTEX_BYTES = 28

export type Vec = number[]
/** One joint at one moment. */
export interface Pose { t: Vec; q: Vec; s: Vec }
export interface Clip { name: string; seconds: number; loops: boolean; frames: Pose[][] }       // frames[frame][joint], evenly spaced
export interface Vertex { position: Vec; normal: Vec; colour: Vec; joints: Vec; weights: Vec }  // colour 0-255, weights any scale
export interface Rig { parent: number[]; inverseBind: ArrayLike<number>; clips: Clip[]; vertices: Vertex[]; indices: number[] }

export function packRig(rig: Rig): Uint8Array<ArrayBuffer> {
  const J = rig.parent.length, V = rig.vertices.length
  if (rig.parent.some((p, j) => p >= j)) throw new Error('a joint comes before its parent')
  if (V > 65536) throw new Error('more than 65536 vertices')

  const frames: number[] = [], first: number[] = []
  for (const clip of rig.clips) {
    if (clip.frames.length < 2) throw new Error(`clip '${clip.name}' needs two frames or more`)
    first.push(frames.length / (J * FRAME_FLOATS))
    clip.frames.forEach((frame, f) => frame.forEach(({ t, q, s }, j) => {
      // the short way round from the frame before, so the kernel can blend without a test
      const prev = f ? clip.frames[f - 1][j].q : q, flip = prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0
      if (flip) clip.frames[f][j].q = q = q.map(x => -x)
      frames.push(t[0], t[1], t[2], 1, q[0], q[1], q[2], q[3], s[0], s[1], s[2], 0)
    }))
  }

  const vertices = new Uint8Array(V * VERTEX_BYTES), dv = new DataView(vertices.buffer)
  rig.vertices.forEach((v, i) => {
    const o = i * VERTEX_BYTES, l = Math.hypot(...v.normal) || 1
    for (let c = 0; c < 3; c++) { dv.setFloat32(o + c * 4, v.position[c], true); dv.setInt8(o + 12 + c, Math.round(v.normal[c] / l * 127)) }
    vertices.set([v.colour[0], v.colour[1], v.colour[2], 255], o + 16)
    const sum = v.weights.reduce((a, b) => a + b, 0) || 1, bytes = [0, 1, 2, 3].map(c => Math.round((v.weights[c] ?? 0) / sum * 255))
    bytes[bytes.indexOf(Math.max(...bytes))] += 255 - (bytes[0] + bytes[1] + bytes[2] + bytes[3])           // exactly one in total
    for (let c = 0; c < 4; c++) { vertices[o + 20 + c] = bytes[c] ? v.joints[c] : 0; vertices[o + 24 + c] = bytes[c] }
  })

  const names = new TextEncoder().encode(rig.clips.map(c => c.name).join('\n'))
  const header = new Int32Array(16)
  header.set([RIG_MAGIC, J, rig.clips.length, frames.length / (J * FRAME_FLOATS), V, rig.indices.length, names.length])
  const padded = (b: Uint8Array) => { const out = new Uint8Array((b.length + 3) & -4); out.set(b); return out }
  const parts = [header, Int32Array.from(rig.parent), Float32Array.from(rig.inverseBind),
    Int32Array.from(first), Int32Array.from(rig.clips, c => c.frames.length), Int32Array.from(rig.clips, c => +c.loops), Float32Array.from(rig.clips, c => c.seconds),
    Float32Array.from(frames), vertices, padded(new Uint8Array(Uint16Array.from(rig.indices).buffer)), padded(names)]
    .map(p => new Uint8Array(p.buffer, p.byteOffset, p.byteLength))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0)
  return out
}

// ---- a figure made of boxes

const quatAbout = (axis: Vec, angle: number): Vec => { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)] }
const quatMul = (a: Vec, b: Vec): Vec => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1]

// name, parent, offset from the parent, the box's centre from the joint, its half size, its colour. z is up; the figure faces -y.
const SKIN = [224, 172, 138], SHIRT = [196, 74, 58], TROUSERS = [54, 66, 96]
const PARTS: [string, number, Vec, Vec, Vec, Vec][] = [
  ['hips', -1, [0, 0, 0.95], [0, 0, 0.05], [0.16, 0.1, 0.1], TROUSERS],
  ['chest', 0, [0, 0, 0.15], [0, 0, 0.2], [0.18, 0.11, 0.2], SHIRT],
  ['head', 1, [0, 0, 0.45], [0, 0, 0.13], [0.11, 0.11, 0.12], SKIN],
  ['upperArmL', 1, [0.24, 0, 0.36], [0, 0, -0.14], [0.05, 0.05, 0.14], SHIRT],
  ['lowerArmL', 3, [0, 0, -0.28], [0, 0, -0.14], [0.045, 0.045, 0.14], SKIN],
  ['upperArmR', 1, [-0.24, 0, 0.36], [0, 0, -0.14], [0.05, 0.05, 0.14], SHIRT],
  ['lowerArmR', 5, [0, 0, -0.28], [0, 0, -0.14], [0.045, 0.045, 0.14], SKIN],
  ['upperLegL', 0, [0.09, 0, -0.02], [0, 0, -0.22], [0.07, 0.07, 0.22], TROUSERS],
  ['lowerLegL', 7, [0, 0, -0.44], [0, 0, -0.24], [0.06, 0.06, 0.24], TROUSERS],
  ['upperLegR', 0, [-0.09, 0, -0.02], [0, 0, -0.22], [0.07, 0.07, 0.22], TROUSERS],
  ['lowerLegR', 9, [0, 0, -0.44], [0, 0, -0.24], [0.06, 0.06, 0.24], TROUSERS],
]
const [HIPS, CHEST, HEAD, UPPER_ARM_L, LOWER_ARM_L, UPPER_ARM_R, LOWER_ARM_R, UPPER_LEG_L, LOWER_LEG_L, UPPER_LEG_R, LOWER_LEG_R] = PARTS.map((_, i) => i)

/** A clip from a function of the phase (0 to 1) that turns joints and lifts the hips. */
function dummyClip(name: string, seconds: number, frames: number, pose: (phase: number, turn: (joint: number, axis: Vec, angle: number) => void, lift: (z: number) => void) => void): Clip {
  const out: Pose[][] = []
  for (let f = 0; f <= frames; f++) {
    const frame: Pose[] = PARTS.map(p => ({ t: [...p[2]], q: [0, 0, 0, 1], s: [1, 1, 1] }))
    pose(f / frames, (j, axis, angle) => { frame[j].q = quatMul(frame[j].q, quatAbout(axis, angle)) }, z => { frame[HIPS].t[2] += z })
    out.push(frame)
  }
  return { name, seconds, loops: true, frames: out }
}

/** A figure of eleven boxes with four clips: Idle, Walk, Run and Wave. */
export function dummyRig(): Uint8Array<ArrayBuffer> {
  const TAU = Math.PI * 2, wave = (p: number) => Math.sin(p * TAU), bend = (p: number) => Math.max(0, Math.sin(p * TAU))
  const stride = (reach: number, knee: number, arm: number, elbow: number, lean: number, bob: number) =>
    (p: number, turn: (joint: number, axis: Vec, angle: number) => void, lift: (z: number) => void) => {
      turn(CHEST, X, -lean); turn(CHEST, Z, wave(p) * 0.12)
      turn(UPPER_LEG_L, X, wave(p) * reach); turn(UPPER_LEG_R, X, -wave(p) * reach)
      turn(LOWER_LEG_L, X, -bend(p + 0.25) * knee); turn(LOWER_LEG_R, X, -bend(p + 0.75) * knee)
      turn(UPPER_ARM_L, X, -wave(p) * arm); turn(UPPER_ARM_R, X, wave(p) * arm)
      turn(LOWER_ARM_L, X, elbow); turn(LOWER_ARM_R, X, elbow)
      lift(Math.abs(wave(p)) * bob - bob)
    }
  const clips = [
    dummyClip('Idle', 2, 16, (p, turn, lift) => {
      turn(CHEST, Y, wave(p) * 0.03); turn(HEAD, Z, wave(p) * 0.2)
      turn(UPPER_ARM_L, Y, 0.06 + wave(p) * 0.03); turn(UPPER_ARM_R, Y, -0.06 - wave(p) * 0.03)
      lift(wave(p * 2) * 0.006)
    }),
    dummyClip('Walk', 1, 16, stride(0.5, 0.7, 0.4, 0.25, 0.03, 0.02)),
    dummyClip('Run', 0.6, 12, stride(0.95, 1.5, 0.9, 1.3, 0.2, 0.06)),
    dummyClip('Wave', 1.5, 16, (p, turn) => {
      turn(UPPER_ARM_R, Y, -2.5); turn(LOWER_ARM_R, Y, wave(p * 2) * 0.5 - 0.3); turn(HEAD, Y, -0.1)
      turn(UPPER_ARM_L, Y, 0.06); turn(CHEST, Y, 0.04)
    }),
  ]

  const at: Vec[] = [], inverseBind: number[] = [], vertices: Vertex[] = [], indices: number[] = []
  PARTS.forEach(([, parent, offset, centre, half, colour], j) => {
    at.push(parent < 0 ? offset : at[parent].map((x, c) => x + offset[c]))
    inverseBind.push(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -at[j][0], -at[j][1], -at[j][2], 1)
    for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3, base = vertices.length, normal = [0, 0, 0]
      normal[axis] = side
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const position = at[j].map((x, c) => x + centre[c])
        position[axis] += side * half[axis]; position[u] += a * half[u]; position[v] += b * half[v]
        vertices.push({ position, normal, colour, joints: [j, 0, 0, 0], weights: [1, 0, 0, 0] })
      }
      indices.push(...(side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map(i => base + i))
    }
  })
  return packRig({ parent: PARTS.map(p => p[1]), inverseBind, clips, vertices, indices })
}

if (import.meta.main) {
  const out = process.argv[2] ?? import.meta.dir + '/dummy.rig', bytes = dummyRig()
  await Bun.write(out, bytes)
  console.log(`${out}: ${(bytes.length / 1024).toFixed(1)} kB`)
}
