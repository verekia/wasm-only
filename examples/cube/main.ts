// A spinning, Lambert-lit cube. This file and cube.wgsl are the whole application.
// It is ordinary TypeScript: `nib dev` can also run it uncompiled (add ?js to the page URL).

import { cos, sin, PI, quatSpin, mat4FromQuat, mat4Mul, mat4Perspective, mat4Translation, type Quat } from 'nib/math'
import { gpuStart, gpuFit, gpuBuffer, device, queue, context, format, width, height } from 'nib/gpu'
import { cubeVertices, cubeIndices, VERTEX_FLOATS } from '../shared/cube.ts'
import shader from './cube.wgsl' with { type: 'text' }

const FOCAL = 1 / Math.tan(50 * PI / 360)       // a 50 degree field of view. The compiler evaluates this.

// What the shader reads, in cube.wgsl's layout: mvp (16 floats), model (16), light (4), color (4).
const uniforms = new Float32Array(40)
const mvp = uniforms.subarray(0, 16), model = uniforms.subarray(16, 32)
const projection = new Float32Array(16), view = new Float32Array(16), viewProjection = new Float32Array(16)

const fpsLabel = document.getElementById('fps')!
let pipeline: GPURenderPipeline
let bindGroup: GPUBindGroup
let vertexBuffer: GPUBuffer
let indexBuffer: GPUBuffer
let uniformBuffer: GPUBuffer
let target: GPUTexture | undefined              // the multisampled texture the cube is drawn into
let targetView: GPUTextureView

let rotation: Quat = { x: 0, y: 0, z: 0, w: 1 }
let speed: number = 1
let lastTime: number = 0
let fpsTime: number = 0
let frames = 0

gpuStart(document.getElementById('view') as HTMLCanvasElement, start, unsupported)

function unsupported(): void {
  document.getElementById('status')!.textContent = 'WebGPU is not available in this browser.'
}

function start(): void {
  const module = device.createShaderModule({ code: shader })
  pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      buffers: [{
        arrayStride: VERTEX_FLOATS * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ],
      }],
    },
    fragment: { module, targets: [{ format }] },
    primitive: { cullMode: 'back' },              // a convex shape needs no depth buffer, only culling
    multisample: { count: 4 },
  })
  vertexBuffer = gpuBuffer(cubeVertices, GPUBufferUsage.VERTEX)
  indexBuffer = gpuBuffer(cubeIndices, GPUBufferUsage.INDEX)
  uniformBuffer = device.createBuffer({ size: uniforms.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })

  mat4Translation(view, 0, 0, -5)
  addEventListener('resize', resize)
  resize()
  bindInput('speed', setSpeed)
  bindInput('light', setLight)
  bindInput('color', setColor)
  requestAnimationFrame(frame)
}

// ---- the page drives the scene: each control's current value is applied, then followed

function bindInput(id: string, handler: (e: Event) => void): void {
  const input = document.getElementById(id)!
  input.addEventListener('input', handler)
  input.dispatchEvent(new Event('input'))
}

function setSpeed(e: Event): void { speed = (e.target as HTMLInputElement).valueAsNumber }

function setLight(e: Event): void {
  const angle = (e.target as HTMLInputElement).valueAsNumber * PI / 180
  uniforms[32] = cos(angle) * 0.8
  uniforms[33] = 0.6
  uniforms[34] = sin(angle) * 0.8
}

function setColor(e: Event): void {
  const rgb: number = parseInt((e.target as HTMLInputElement).value.slice(1), 16)       // "#rrggbb"
  uniforms[36] = (rgb >> 16) / 255
  uniforms[37] = ((rgb >> 8) & 255) / 255
  uniforms[38] = (rgb & 255) / 255
  uniforms[39] = 1
}

function resize(): void {
  gpuFit()
  if (target) target.destroy()
  target = device.createTexture({ size: [width, height], sampleCount: 4, format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
  targetView = target.createView()
  mat4Perspective(projection, FOCAL, width / height, 0.1, 100)
  mat4Mul(viewProjection, projection, view)
}

// ---- every frame

function frame(now: number): void {
  const dt = Math.min((now - lastTime) * 0.001, 0.1)
  lastTime = now

  rotation = quatSpin(rotation, 0.5 * speed, 1.1 * speed, 0.3 * speed, dt)
  mat4FromQuat(model, rotation)
  mat4Mul(mvp, viewProjection, model)
  queue.writeBuffer(uniformBuffer, 0, uniforms)

  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: targetView,
      resolveTarget: context.getCurrentTexture().createView(),
      clearValue: [0.035, 0.04, 0.055, 1],
      loadOp: 'clear',
      storeOp: 'discard',
    }],
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.setVertexBuffer(0, vertexBuffer)
  pass.setIndexBuffer(indexBuffer, 'uint16')
  pass.drawIndexed(36)
  pass.end()
  queue.submit([encoder.finish()])

  frames++
  if (now - fpsTime >= 500) {
    fpsLabel.textContent = String(Math.round(frames * 1000 / (now - fpsTime)))
    frames = 0
    fpsTime = now
  }
  requestAnimationFrame(frame)
}
