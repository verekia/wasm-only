// A crowd of skinned characters. nib/skin poses every skeleton, then crowd.wgsl bends the
// meshes on the GPU. The page draws a figure made of boxes, or the rigs that a rigs.json next
// to it lists (convert.ts makes a .rig from a glTF binary):
//
//   [["hero.rig", 1, 1.4, 4.5], ["wolf.rig", 0.8, 1.5, 6]]      file, scale, metres a second walking, and running

import { compiled, type i32 } from 'nib'
import { cos, sin, PI, TAU, random, randomSeed, mat4Mul, mat4Perspective } from 'nib/math'
import { gpuStart, gpuFit, device, queue, context, format, width, height } from 'nib/gpu'
import {
  RIG_VERTEX, rigVertexCount, rigVertexOffset, rigIndexCount, rigIndexOffset, rigClipNames,
  skinRig, skinRigClips, skinRigJoints, skinClipLoops, skinSpawn, skinClear, skinPlace, skinPlay, skinSeek, skinSlot, skinUpdate, skinMatrices,
} from 'nib/skin'
import shader from './crowd.wgsl' with { type: 'text' }

const MAX = 4000, MAX_RIGS = 2
const SPACING = 1.5                              // metres between characters when the crowd is made
const FOCAL = 1 / Math.tan(40 * PI / 360)

const uniforms = new Float32Array(20)            // crowd.wgsl's Scene: viewProjection, light
const projection = new Float32Array(16), view = new Float32Array(16)
const instances = new Uint32Array(MAX * 2)       // a character's first matrix, and its tint

// what each character is doing
const x = new Float32Array(MAX), y = new Float32Array(MAX), heading = new Float32Array(MAX)
const pace = new Float32Array(MAX)               // metres a second
const until = new Float32Array(MAX)              // seconds before it does something else

// a rig: its mesh on the GPU and how it is used here
const vertexBuffers: GPUBuffer[] = [], indexBuffers: GPUBuffer[] = []
const indexCount = new Int32Array(MAX_RIGS), walkClip = new Int32Array(MAX_RIGS), runClip = new Int32Array(MAX_RIGS)
const size = new Float32Array(MAX_RIGS), walkPace = new Float32Array(MAX_RIGS), runPace = new Float32Array(MAX_RIGS)
const first = new Int32Array(MAX_RIGS), members = new Int32Array(MAX_RIGS)       // its characters are first .. first + members
let rigs = 0, maxJoints = 0
let listed: any[][] = []                         // rigs.json

const fpsLabel = document.getElementById('fps')!, poseLabel = document.getElementById('pose')!
const countLabel = document.getElementById('count-label')!, jointsLabel = document.getElementById('joints')!
let pipeline: GPURenderPipeline
let bindGroup: GPUBindGroup
let uniformBuffer: GPUBuffer
let matrixBuffer: GPUBuffer
let instanceBuffer: GPUBuffer
let target: GPUTexture | undefined
let targetView: GPUTextureView
let depth: GPUTexture
let depthView: GPUTextureView

let count = 0, joints = 0
let field: number = 1                            // the side of the square the crowd lives on
let angle: number = 0.6
let lastTime: number = 0, statsTime: number = 0, poseTime: number = 0
let frames = 0

document.getElementById('mode')!.textContent = compiled ? 'Wasm, four floats at a time' : 'plain JavaScript'
gpuStart(document.getElementById('view') as HTMLCanvasElement, start, unsupported)

function unsupported(): void {
  document.getElementById('status')!.textContent = rigs === 0 && pipeline ? 'No rig could be read.' : 'WebGPU is not available in this browser.'
}

function start(): void {
  const module = device.createShaderModule({ code: shader })
  pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      buffers: [{
        arrayStride: RIG_VERTEX,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'snorm8x4' },
          { shaderLocation: 2, offset: 16, format: 'unorm8x4' },
          { shaderLocation: 3, offset: 20, format: 'uint8x4' },
          { shaderLocation: 4, offset: 24, format: 'unorm8x4' },
        ],
      }, {
        arrayStride: 8,
        stepMode: 'instance',
        attributes: [
          { shaderLocation: 5, offset: 0, format: 'uint32' },
          { shaderLocation: 6, offset: 4, format: 'unorm8x4' },
        ],
      }],
    },
    fragment: { module, targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: 4 },
  })
  uniformBuffer = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  instanceBuffer = device.createBuffer({ size: instances.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  uniforms[16] = 0.45; uniforms[17] = -0.35; uniforms[18] = 0.82
  fetch('rigs.json').then(listOf).then(fetchAll).then(loaded)
}

function listOf(response: Response): any { return response.ok ? response.json() : [['dummy.rig', 1, 1.3, 4]] }
function fetchAll(list: any[][]): Promise<ArrayBuffer[]> {
  listed = list
  return Promise.all(list.map(fetchRig))
}
function fetchRig(entry: any[]): Promise<ArrayBuffer> { return fetch(entry[0]).then(bytesOf) }
function bytesOf(response: Response): Promise<ArrayBuffer> { return response.arrayBuffer() }

function loaded(files: ArrayBuffer[]): void {
  for (let i = 0; i < files.length; i++) addRig(files[i], listed[i][1], listed[i][2], listed[i][3])
  if (rigs === 0) { unsupported(); return }
  matrixBuffer = device.createBuffer({ size: MAX * maxJoints * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }, { binding: 1, resource: { buffer: matrixBuffer } }],
  })
  addEventListener('resize', resize)
  resize()
  const slider = document.getElementById('count') as HTMLInputElement
  slider.addEventListener('input', recount)
  populate(slider.valueAsNumber)
  requestAnimationFrame(frame)
}

/** Takes a .rig file: the skeleton and clips go to nib/skin, the mesh to the GPU. */
function addRig(file: ArrayBuffer, scale: number, walk: number, run: number): void {
  const rig = skinRig(file)
  if (rig < 0 || rig >= MAX_RIGS) return
  const vertexBytes = rigVertexCount(file) * RIG_VERTEX, indexBytes = (rigIndexCount(file) * 2 + 3) & -4
  const vertices = device.createBuffer({ size: vertexBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  const indices = device.createBuffer({ size: indexBytes, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST })
  queue.writeBuffer(vertices, 0, file, rigVertexOffset(file), vertexBytes)
  queue.writeBuffer(indices, 0, file, rigIndexOffset(file), indexBytes)
  vertexBuffers.push(vertices)
  indexBuffers.push(indices)
  const names = rigClipNames(file)
  indexCount[rig] = rigIndexCount(file)
  walkClip[rig] = names.indexOf('Walk')
  runClip[rig] = names.indexOf('Run')
  size[rig] = scale
  walkPace[rig] = walk
  runPace[rig] = run
  maxJoints = Math.max(maxJoints, skinRigJoints(rig))
  rigs = rig + 1
}

function recount(e: Event): void { populate((e.target as HTMLInputElement).valueAsNumber) }

/** Makes a crowd of `n`: one in five is of the second rig, when there is one. */
function populate(n: i32): void {
  const side = Math.ceil(Math.sqrt(n)) | 0
  skinClear()
  randomSeed(7)
  count = n
  field = side * SPACING
  members[1] = rigs > 1 ? (n / 5) | 0 : 0
  members[0] = n - members[1]
  first[1] = members[0]
  joints = 0
  for (let i = 0; i < n; i++) {
    const rig = rigOf(i), cell = (i * 7919) % (side * side)          // scattered over the grid, each in a cell of its own
    skinSpawn(rig)
    x[i] = ((cell % side) + 0.2 + random() * 0.6) * SPACING - field * 0.5
    y[i] = (((cell / side) | 0) + 0.2 + random() * 0.6) * SPACING - field * 0.5
    heading[i] = random() * TAU
    choose(i, 0)
    skinSeek(i, random() * 2)
    skinPlace(i, x[i], y[i], 0, heading[i], size[rig])
    const r = 200 + random() * 55, g = 200 + random() * 55, b = 200 + random() * 55
    instances[i * 2] = skinSlot(i)
    instances[i * 2 + 1] = (r | 0) | ((g | 0) << 8) | ((b | 0) << 16)
    joints += skinRigJoints(rig)
  }
  queue.writeBuffer(instanceBuffer, 0, instances, 0, n * 2)
  countLabel.textContent = String(count)
  jointsLabel.textContent = String(joints)
}

function rigOf(i: i32): i32 { return i < first[1] ? 0 : 1 }

/** Gives a character something to do: walk, run, or one of its other repeating clips on the spot. */
function choose(i: i32, fade: number): void {
  const rig = rigOf(i), dice = random()
  let clip = (random() * skinRigClips(rig)) | 0
  for (let tries = 0; tries < 8 && !skinClipLoops(rig, clip); tries++) clip = (random() * skinRigClips(rig)) | 0
  if (dice < 0.35 && walkClip[rig] >= 0) clip = walkClip[rig]
  else if (dice < 0.6 && runClip[rig] >= 0) clip = runClip[rig]
  skinPlay(i, clip, fade)
  pace[i] = clip === walkClip[rig] ? walkPace[rig] : clip === runClip[rig] ? runPace[rig] : 0
  until[i] = 1.5 + random() * 4
}

function resize(): void {
  gpuFit()
  if (target) { target.destroy(); depth.destroy() }
  target = device.createTexture({ size: [width, height], sampleCount: 4, format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
  targetView = target.createView()
  depth = device.createTexture({ size: [width, height], sampleCount: 4, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT })
  depthView = depth.createView()
}

/** A camera at (ex, ey, ez) looking at (tx, ty, tz), with +z up. */
function lookAt(out: Float32Array, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number): void {
  const dx = tx - ex, dy = ty - ey, dz = tz - ez, d = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz)
  const fx = dx * d, fy = dy * d, fz = dz * d, s = 1 / Math.sqrt(fx * fx + fy * fy)
  const sx = fy * s, sy = -fx * s                                     // side = forward × up
  const ux = sy * fz, uy = -sx * fz, uz = sx * fy - sy * fx           // up = side × forward
  out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0
  out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0
  out[8] = 0; out[9] = uz; out[10] = -fz; out[11] = 0
  out[12] = -(sx * ex + sy * ey); out[13] = -(ux * ex + uy * ey + uz * ez); out[14] = fx * ex + fy * ey + fz * ez; out[15] = 1
}

function frame(now: number): void {
  const dt = Math.min((now - lastTime) * 0.001, 0.1), half = field * 0.5
  lastTime = now

  for (let i = 0; i < count; i++) {
    until[i] -= dt
    if (until[i] <= 0) {
      heading[i] += random() * 2 - 1
      choose(i, 0.3)
    }
    if (pace[i] > 0) {                                                // at no turn, a figure faces -y
      x[i] += sin(heading[i]) * pace[i] * dt
      y[i] -= cos(heading[i]) * pace[i] * dt
      if (x[i] > half) x[i] -= field
      if (x[i] < -half) x[i] += field
      if (y[i] > half) y[i] -= field
      if (y[i] < -half) y[i] += field
    }
    skinPlace(i, x[i], y[i], 0, heading[i], size[rigOf(i)])
  }

  const before = performance.now()
  skinUpdate(dt)
  poseTime += performance.now() - before

  angle += dt * 0.08
  const reach = field * 0.62 + 5
  lookAt(view, cos(angle) * reach, sin(angle) * reach, reach * 0.55, 0, 0, 0.8)
  mat4Perspective(projection, FOCAL, width / height, 0.5, 600)
  mat4Mul(uniforms, projection, view)
  queue.writeBuffer(uniformBuffer, 0, uniforms)
  queue.writeBuffer(matrixBuffer, 0, skinMatrices())

  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: targetView,
      resolveTarget: context.getCurrentTexture().createView(),
      clearValue: [0.05, 0.06, 0.08, 1],
      loadOp: 'clear',
      storeOp: 'discard',
    }],
    depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.setVertexBuffer(1, instanceBuffer)
  for (let rig = 0; rig < rigs; rig++) {
    if (members[rig] === 0) continue
    pass.setVertexBuffer(0, vertexBuffers[rig])
    pass.setIndexBuffer(indexBuffers[rig], 'uint16')
    pass.drawIndexed(indexCount[rig], members[rig], 0, 0, first[rig])
  }
  pass.end()
  queue.submit([encoder.finish()])

  frames++
  if (now - statsTime >= 500) {
    fpsLabel.textContent = String(Math.round(frames * 1000 / (now - statsTime)))
    poseLabel.textContent = (poseTime / frames).toFixed(2)
    frames = 0
    poseTime = 0
    statsTime = now
  }
  requestAnimationFrame(frame)
}
