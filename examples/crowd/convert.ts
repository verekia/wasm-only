// Turns one skinned mesh of a glTF binary and its clips into a .rig file (see rig.ts).
//
//   bun examples/crowd/convert.ts <file.glb> <out.rig> --mesh <node name> [--clips <name prefix>] [--rate 24]
//
// Reads plain and meshopt-compressed buffers, quantized attributes, and linear and step clips.
import { MeshoptDecoder } from 'meshoptimizer'
import { packRig, type Clip, type Pose, type Vertex } from './rig.ts'

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
const READ: Record<number, ['getInt8' | 'getUint8' | 'getInt16' | 'getUint16' | 'getUint32' | 'getFloat32', number, number]> = {
  5120: ['getInt8', 1, 127], 5121: ['getUint8', 1, 255], 5122: ['getInt16', 2, 32767], 5123: ['getUint16', 2, 65535], 5125: ['getUint32', 4, 1], 5126: ['getFloat32', 4, 1],
}
/** Stand-in colours, one a material slot. */
const SLOT_COLOURS = [[214, 170, 140], [96, 78, 64], [62, 66, 78], [146, 124, 98], [186, 182, 172], [84, 98, 114], [124, 94, 70], [72, 72, 84]]

async function readGlb(path: string) {
  const file = new Uint8Array(await Bun.file(path).arrayBuffer()), dv = new DataView(file.buffer)
  const jsonLength = dv.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength)))
  const bin = file.subarray(28 + jsonLength, 28 + jsonLength + dv.getUint32(20 + jsonLength, true))
  await MeshoptDecoder.ready
  const views = new Map<number, Uint8Array>()
  const view = (i: number): Uint8Array => {
    let out = views.get(i)
    if (out) return out
    const v = json.bufferViews[i], packed = v.extensions?.KHR_meshopt_compression ?? v.extensions?.EXT_meshopt_compression
    if (packed) {
      out = new Uint8Array(packed.count * packed.byteStride)
      MeshoptDecoder.decodeGltfBuffer(out, packed.count, packed.byteStride, bin.subarray(packed.byteOffset ?? 0, (packed.byteOffset ?? 0) + packed.byteLength), packed.mode, packed.filter)
    } else out = bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
    views.set(i, out)
    return out
  }
  /** An accessor as plain numbers, `width` to an element. Normalized integers become fractions. */
  const read = (i: number): { data: Float64Array; width: number; count: number } => {
    const a = json.accessors[i], width = COMPONENTS[a.type], [get, size, scale] = READ[a.componentType]
    const bytes = view(a.bufferView), stride = json.bufferViews[a.bufferView].byteStride ?? width * size
    const dv = new DataView(bytes.buffer, bytes.byteOffset + (a.byteOffset ?? 0)), data = new Float64Array(a.count * width)
    for (let e = 0; e < a.count; e++) for (let c = 0; c < width; c++) data[e * width + c] = dv[get](e * stride + c * size, true) / (a.normalized ? scale : 1)
    return { data, width, count: a.count }
  }
  return { json, read }
}

const slerp = (a: number[], b: number[], t: number): number[] => {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const s = dot < 0 ? -1 : 1
  dot = Math.abs(dot)
  if (dot > 0.9995) { const q = a.map((x, i) => x + (b[i] * s - x) * t), l = Math.hypot(...q); return q.map(x => x / l) }
  const angle = Math.acos(dot), ka = Math.sin((1 - t) * angle) / Math.sin(angle), kb = Math.sin(t * angle) / Math.sin(angle) * s
  return a.map((x, i) => x * ka + b[i] * kb)
}

export async function convert(glb: string, opts: { mesh: string; clips: string; rate: number }): Promise<Uint8Array> {
  const { json, read } = await readGlb(glb)
  const node = json.nodes.find((n: any) => n.name === opts.mesh && n.skin !== undefined)
  if (!node) throw new Error(`${glb} has no skinned mesh named '${opts.mesh}'`)
  const skin = json.skins[node.skin], primitive = json.meshes[node.mesh].primitives[0]

  // joints, parents first
  const parentOf = new Map<number, number>()
  json.nodes.forEach((n: any, i: number) => (n.children ?? []).forEach((c: number) => parentOf.set(c, i)))
  const isJoint = new Set<number>(skin.joints), order: number[] = []
  const visit = (j: number) => { if (order.includes(j)) return; const p = parentOf.get(j); if (p !== undefined && isJoint.has(p)) visit(p); order.push(j) }
  skin.joints.forEach(visit)
  const slot = new Map(order.map((j, i) => [j, i])), J = order.length
  for (const j of order) {                              // whatever sits above a root joint must not move it
    for (let p = parentOf.get(j); p !== undefined && !isJoint.has(p); p = parentOf.get(p)) {
      const n = json.nodes[p]
      if (n.translation || n.rotation || n.scale || n.matrix) throw new Error(`'${n.name}' above joint '${json.nodes[j].name}' has a transform: apply it to the rig first`)
    }
  }
  const bind = read(skin.inverseBindMatrices).data, inverseBind = new Float32Array(J * 16)
  order.forEach((j, i) => { const from = skin.joints.indexOf(j) * 16; inverseBind.set(bind.subarray(from, from + 16), i * 16) })

  // clips, sampled at a fixed rate
  const rest = order.map(j => ({ translation: json.nodes[j].translation ?? [0, 0, 0], rotation: json.nodes[j].rotation ?? [0, 0, 0, 1], scale: json.nodes[j].scale ?? [1, 1, 1] }))
  const clips: Clip[] = []
  for (const a of (json.animations ?? []).filter((a: any) => a.name.startsWith(opts.clips))) {
    const tracks = new Map<string, { times: Float64Array; values: Float64Array; width: number; step: boolean }>()
    let seconds = 0
    for (const ch of a.channels) {
      if (!slot.has(ch.target.node)) continue
      const s = a.samplers[ch.sampler], times = read(s.input).data, out = read(s.output)
      if (s.interpolation === 'CUBICSPLINE') throw new Error(`clip '${a.name}' uses cubic splines: bake it to linear keys`)
      tracks.set(`${slot.get(ch.target.node)}:${ch.target.path}`, { times, values: out.data, width: out.width, step: s.interpolation === 'STEP' })
      seconds = Math.max(seconds, times[times.length - 1])
    }
    const sample = (joint: number, path: 'translation' | 'rotation' | 'scale', time: number): number[] => {
      const t = tracks.get(`${joint}:${path}`)
      if (!t) return rest[joint][path]
      const at = (i: number) => [...t.values.subarray(i * t.width, (i + 1) * t.width)], last = t.times.length - 1
      if (time <= t.times[0]) return at(0)
      if (time >= t.times[last]) return at(last)
      let k = 0
      while (t.times[k + 1] <= time) k++
      const f = t.step ? 0 : (time - t.times[k]) / (t.times[k + 1] - t.times[k]), x = at(k), y = at(k + 1)
      return path === 'rotation' ? slerp(x, y, f) : x.map((v, i) => v + (y[i] - v) * f)
    }
    const count = Math.max(1, Math.round(seconds * opts.rate)) + 1, frames: Pose[][] = []
    for (let f = 0; f < count; f++) {
      const time = seconds * f / (count - 1)
      frames.push(order.map((_, j) => ({ t: sample(j, 'translation', time), q: sample(j, 'rotation', time), s: sample(j, 'scale', time) })))
    }
    const near = (x: number[], y: number[]) => x.every((v, i) => Math.abs(v - y[i]) < 0.02)
    const loops = seconds > 0 && frames[0].every((p, j) => { const e = frames[count - 1][j]; return near(p.t, e.t) && near(p.s, e.s) && (near(p.q, e.q) || near(p.q, e.q.map(v => -v))) })
    clips.push({ name: a.name.slice(opts.clips.length), seconds: seconds || 1, loops, frames })
  }

  // the mesh
  const attr = (name: string) => primitive.attributes[name] === undefined ? undefined : read(primitive.attributes[name])
  const position = attr('POSITION')!, normal = attr('NORMAL'), colour = attr('COLOR_0'), slots = attr('_MATERIALINDEX'), joints = attr('JOINTS_0')!, weights = attr('WEIGHTS_0')!
  const grid = primitive.extras?.meshopt?.dequantize?.POSITION as number[] | undefined         // [x, y, z, step] of a quantization grid
  const indices = [...read(primitive.indices).data]
  const places = Array.from({ length: position.count }, (_, v) => [0, 1, 2].map(c => grid ? position.data[v * 3 + c] * grid[3] + grid[c] : position.data[v * 3 + c]))
  const normals = normal ? normal.data : faceNormals(places, indices)
  const vertices: Vertex[] = places.map((place, v) => ({
    position: place,
    normal: [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]],
    colour: slots || !colour ? SLOT_COLOURS[(slots ? slots.data[v] : 0) % SLOT_COLOURS.length] : [0, 1, 2].map(c => Math.round(colour.data[v * colour.width + c] * 255)),
    joints: [0, 1, 2, 3].map(c => slot.get(skin.joints[joints.data[v * 4 + c]])!),
    weights: [0, 1, 2, 3].map(c => weights.data[v * 4 + c]),
  }))
  return packRig({ parent: order.map(j => slot.get(parentOf.get(j)!) ?? -1), inverseBind, clips, vertices, indices })
}

function faceNormals(places: number[][], indices: number[]): Float64Array {
  const out = new Float64Array(places.length * 3)
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [places[indices[i]], places[indices[i + 1]], places[indices[i + 2]]]
    const u = [0, 1, 2].map(k => b[k] - a[k]), v = [0, 1, 2].map(k => c[k] - a[k])
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    for (let k = 0; k < 3; k++) for (let e = 0; e < 3; e++) out[indices[i + k] * 3 + e] += n[e]
  }
  return out
}

if (import.meta.main) {
  const [glb, out, ...rest] = process.argv.slice(2)
  const flag = (name: string, otherwise: string) => { const i = rest.indexOf(`--${name}`); return i < 0 ? otherwise : rest[i + 1] }
  if (!glb || !out || !flag('mesh', '')) { console.error('usage: bun examples/crowd/convert.ts <file.glb> <out.rig> --mesh <node name> [--clips <name prefix>] [--rate 24]'); process.exit(1) }
  const bytes = await convert(glb, { mesh: flag('mesh', ''), clips: flag('clips', ''), rate: Number(flag('rate', '24')) })
  await Bun.write(out, bytes)
  const h = new Int32Array(bytes.buffer, 0, 16)
  console.log(`${out}: ${h[1]} joints, ${h[2]} clips, ${h[3]} frames, ${h[4]} vertices, ${h[5] / 3} triangles, ${(bytes.length / 1024).toFixed(0)} kB`)
}
