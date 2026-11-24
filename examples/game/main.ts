// A small arcade game: steer a cube around a floor, collect the bright cubes, avoid the dark
// ones. Each one collected makes the next harder.
//
// What it exercises: a fixed-timestep loop (nib/loop), keyboard and pointer input (nib/input),
// entities packed in typed arrays, and one instanced draw call for everything on screen.

import type { i32 } from 'nib'
import { f32x4 } from 'nib'
import { clamp, cos, mat4LookAt, mat4Mul, mat4Perspective, PI, random, randomSeed, sin, TAU } from 'nib/math'
import { context, device, format, gpuBuffer, gpuFit, gpuStart, height, queue, width } from 'nib/gpu'
import { held, hit, inputInit, pointerHeld, pointerHit, pointerX, pointerY } from 'nib/input'
import { loopStart } from 'nib/loop'
import { cubeIndices, cubeVertices, VERTEX_FLOATS } from '../shared/cube.ts'
import shader from './scene.wgsl' with { type: 'text' }

// ---- rules

const FIELD = 9                   // the floor reaches from -FIELD to +FIELD
const PLAYER_SIZE = 0.5
const PLAYER_SPEED = 11
const HAZARD_SIZE = 0.6
const ORB_SIZE = 0.28
const ORBS = 3
const MOST_HAZARDS = 40
const MOST_SPARKS = 400

const LEFT = 1, RIGHT = 2, UP = 4, DOWN = 8, START = 16      // actions: bits, so one key press can be tested in a mask
const READY = 0, PLAYING = 1, OVER = 2

// ---- state: each kind of entity is rows of floats in one array

const HAZARD = 6                  // x, z, velocity x, velocity z, and x, z one tick ago for drawing between ticks
const hazards = new Float32Array(MOST_HAZARDS * HAZARD)
let hazardCount = 0

const ORB = 2                     // x, z
const orbs = new Float32Array(ORBS * ORB)

const SPARK = 10                  // x, y, z, velocity x y z, life, colour r g b
const sparks = new Float32Array(MOST_SPARKS * SPARK)
let sparkCount = 0

let state = READY
let clock: number = 0
let score = 0
let best = 0
let playerX: number = 0, playerZ: number = 0
let playerVx: number = 0, playerVz: number = 0
let playerWasX: number = 0, playerWasZ: number = 0

const view = document.getElementById('view') as HTMLCanvasElement
const scoreLabel = document.getElementById('score')!
const bestLabel = document.getElementById('best')!
const message = document.getElementById('message')!

// ---- startup

randomSeed(Math.random() * 4294967295)
placeEverything()
inputInit(view, {
  ArrowLeft: LEFT, KeyA: LEFT, ArrowRight: RIGHT, KeyD: RIGHT,
  ArrowUp: UP, KeyW: UP, ArrowDown: DOWN, KeyS: DOWN,
  Enter: START, Space: START,
})
gpuStart(view, start, unsupported)

function unsupported(): void { message.textContent = 'WebGPU is not available in this browser.' }

function start(): void {
  sceneInit()
  loopStart(update, render)
}

// ---- the game

function placeEverything(): void {
  hazardCount = 0
  playerX = 0
  playerZ = 0
  playerVx = 0
  playerVz = 0
  playerWasX = 0
  playerWasZ = 0
  for (let i = 0; i < 3; i++) addHazard()
  for (let i = 0; i < ORBS; i++) placeOrb(i)
}

function restart(): void {
  score = 0
  scoreLabel.textContent = '0'
  message.textContent = ''
  placeEverything()
  state = PLAYING
}

function farFromPlayer(x: number, z: number, distance: number): boolean {
  const dx = x - playerX, dz = z - playerZ
  return dx * dx + dz * dz > distance * distance
}

function addHazard(): void {
  let x = 0.5, z = 0.5
  do {
    x = (random() * 2 - 1) * (FIELD - HAZARD_SIZE)
    z = (random() * 2 - 1) * (FIELD - HAZARD_SIZE)
  } while (!farFromPlayer(x, z, 7))
  const angle = random() * TAU, speed = 3.5 + score * 0.12
  const h = hazardCount * HAZARD
  hazardCount++
  hazards[h] = x
  hazards[h + 1] = z
  hazards[h + 2] = cos(angle) * speed
  hazards[h + 3] = sin(angle) * speed
  hazards[h + 4] = x
  hazards[h + 5] = z
}

function placeOrb(index: i32): void {
  const o = index * ORB
  do {
    orbs[o] = (random() * 2 - 1) * (FIELD - 1)
    orbs[o + 1] = (random() * 2 - 1) * (FIELD - 1)
  } while (!farFromPlayer(orbs[o], orbs[o + 1], 4))
}

function burst(x: number, z: number, count: i32, r: number, g: number, b: number): void {
  for (let i = 0; i < count; i++) {
    if (sparkCount === MOST_SPARKS) return
    const angle = random() * TAU, out = 2 + random() * 5
    const s = sparkCount * SPARK
    sparkCount++
    sparks[s] = x
    sparks[s + 1] = 0.4
    sparks[s + 2] = z
    sparks[s + 3] = cos(angle) * out
    sparks[s + 4] = 4 + random() * 6
    sparks[s + 5] = sin(angle) * out
    sparks[s + 6] = 0.5 + random() * 0.6
    sparks[s + 7] = r
    sparks[s + 8] = g
    sparks[s + 9] = b
  }
}

function gameOver(): void {
  state = OVER
  burst(playerX, playerZ, 80, 0.91, 0.38, 0.23)
  if (score > best) {
    best = score
    bestLabel.textContent = String(best)
  }
  message.textContent = 'Game over. Press Enter or tap to play again.'
}

/** One tick. Called by nib/loop at a fixed rate, whatever the display's refresh rate. */
function update(dt: number): void {
  clock += dt
  updateSparks(dt)
  if (state !== PLAYING) {
    if (hit(START) || pointerHit) restart()
    return
  }

  // steer with the keys, or towards the spot on the floor under a held pointer
  let ax: number = (held(RIGHT) ? 1 : 0) - (held(LEFT) ? 1 : 0)
  let az: number = (held(DOWN) ? 1 : 0) - (held(UP) ? 1 : 0)
  if (pointerHeld && aim()) {
    ax = (aimX - playerX) * 2
    az = (aimZ - playerZ) * 2
  }
  const length = Math.sqrt(ax * ax + az * az)
  if (length > 1) {
    ax /= length
    az /= length
  }
  const ease = Math.min(dt * 12, 1)
  playerVx += (ax * PLAYER_SPEED - playerVx) * ease
  playerVz += (az * PLAYER_SPEED - playerVz) * ease
  playerWasX = playerX
  playerWasZ = playerZ
  playerX = clamp(playerX + playerVx * dt, PLAYER_SIZE - FIELD, FIELD - PLAYER_SIZE)
  playerZ = clamp(playerZ + playerVz * dt, PLAYER_SIZE - FIELD, FIELD - PLAYER_SIZE)

  const wall = FIELD - HAZARD_SIZE
  const reach = PLAYER_SIZE + HAZARD_SIZE - 0.15           // a little forgiving
  for (let i = 0; i < hazardCount; i++) {
    const h = i * HAZARD
    let x = hazards[h], z = hazards[h + 1]
    hazards[h + 4] = x
    hazards[h + 5] = z
    x += hazards[h + 2] * dt
    z += hazards[h + 3] * dt
    if (Math.abs(x) > wall) {
      x = x > 0 ? wall : -wall
      hazards[h + 2] = -hazards[h + 2]
    }
    if (Math.abs(z) > wall) {
      z = z > 0 ? wall : -wall
      hazards[h + 3] = -hazards[h + 3]
    }
    hazards[h] = x
    hazards[h + 1] = z
    if (Math.abs(x - playerX) < reach && Math.abs(z - playerZ) < reach) {
      gameOver()
      return
    }
  }

  const grab = PLAYER_SIZE + ORB_SIZE + 0.1
  for (let i = 0; i < ORBS; i++) {
    const x = orbs[i * ORB], z = orbs[i * ORB + 1]
    if (Math.abs(x - playerX) < grab && Math.abs(z - playerZ) < grab) {
      burst(x, z, 14, 1, 0.85, 0.3)
      placeOrb(i)
      score++
      scoreLabel.textContent = String(score)
      if (score % 3 === 0 && hazardCount < MOST_HAZARDS) addHazard()
    }
  }
}

// Where the pointer's ray meets the floor.
let aimX: number = 0, aimZ: number = 0

/** False when the pointer is above the horizon. */
function aim(): boolean {
  const nx = (pointerX / viewWidth * 2 - 1) * viewAspect / viewFocal
  const ny = (1 - pointerY / viewHeight * 2) / viewFocal
  // the rows of a view matrix are the camera's side, up and backward axes
  const dx = camera[0] * nx + camera[1] * ny - camera[2]
  const dy = camera[4] * nx + camera[5] * ny - camera[6]
  const dz = camera[8] * nx + camera[9] * ny - camera[10]
  if (dy > -0.01) return false
  const t = EYE_Y / -dy
  aimX = dx * t
  aimZ = EYE_Z + dz * t
  return true
}

function updateSparks(dt: number): void {
  for (let i = sparkCount - 1; i >= 0; i--) {      // backwards, because removing moves the last one into the gap
    const s = i * SPARK
    const life = sparks[s + 6] - dt
    if (life <= 0) {
      sparkCount--
      sparks.copyWithin(s, sparkCount * SPARK, sparkCount * SPARK + SPARK)
      continue
    }
    sparks[s + 6] = life
    sparks[s + 4] -= 22 * dt
    sparks[s] += sparks[s + 3] * dt
    sparks[s + 1] += sparks[s + 4] * dt
    sparks[s + 2] += sparks[s + 5] * dt
    if (sparks[s + 1] < 0.06) {
      sparks[s + 1] = 0.06
      sparks[s + 4] *= -0.45
    }
  }
}

// ---- drawing: every object is one instance of the cube

const INSTANCE = 12               // place x y z and turn, size x y z and a spare, colour r g b and glow: three vec4 in scene.wgsl
const MOST_INSTANCES = 8 + MOST_HAZARDS + ORBS + MOST_SPARKS
const instances = new Float32Array(MOST_INSTANCES * INSTANCE)
let instanceCount = 0

const FOCAL = 1 / Math.tan(42 * PI / 360)
const EYE_Y = 23                  // the camera sits above and behind the floor's near edge
const EYE_Z = 15

const scene = new Float32Array(20)      // view-projection (16 floats), light (4): mirrors scene.wgsl
const projection = new Float32Array(16), camera = new Float32Array(16)

let viewWidth: number = 1, viewHeight: number = 1      // the canvas in CSS pixels, the unit pointer positions come in
let viewAspect: number = 1, viewFocal: number = 1

let pipeline: GPURenderPipeline
let bindGroup: GPUBindGroup
let vertexBuffer: GPUBuffer
let indexBuffer: GPUBuffer
let instanceBuffer: GPUBuffer
let sceneBuffer: GPUBuffer
let colorTarget: GPUTexture | undefined
let depthTarget: GPUTexture | undefined
let colorView: GPUTextureView
let depthView: GPUTextureView

function sceneInit(): void {
  const module = device.createShaderModule({ code: shader })
  pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      buffers: [
        { arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
        ] },
        { arrayStride: INSTANCE * 4, stepMode: 'instance', attributes: [
          { shaderLocation: 2, offset: 0, format: 'float32x4' },
          { shaderLocation: 3, offset: 16, format: 'float32x4' },
          { shaderLocation: 4, offset: 32, format: 'float32x4' },
        ] },
      ],
    },
    fragment: { module, targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    multisample: { count: 4 },
  })
  vertexBuffer = gpuBuffer(cubeVertices, GPUBufferUsage.VERTEX)
  indexBuffer = gpuBuffer(cubeIndices, GPUBufferUsage.INDEX)
  instanceBuffer = device.createBuffer({ size: instances.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  sceneBuffer = device.createBuffer({ size: scene.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: sceneBuffer } }],
  })
  mat4LookAt(camera, 0, EYE_Y, EYE_Z, 0, 0, 1.2)
  scene[16] = 0.35
  scene[17] = 0.85
  scene[18] = 0.4
  addEventListener('resize', sceneResize)
  sceneResize()
}

function sceneResize(): void {
  gpuFit()
  if (colorTarget) colorTarget.destroy()
  if (depthTarget) depthTarget.destroy()
  colorTarget = device.createTexture({ size: [width, height], sampleCount: 4, format, usage: GPUTextureUsage.RENDER_ATTACHMENT })
  depthTarget = device.createTexture({ size: [width, height], sampleCount: 4, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT })
  colorView = colorTarget.createView()
  depthView = depthTarget.createView()

  viewWidth = view.clientWidth
  viewHeight = view.clientHeight
  viewAspect = width / height
  viewFocal = viewAspect < 1.25 ? FOCAL * viewAspect / 1.25 : FOCAL      // on a narrow screen, zoom out to keep the floor in view
  mat4Perspective(projection, viewFocal, viewAspect, 1, 100)
  mat4Mul(scene, projection, camera)
  queue.writeBuffer(sceneBuffer, 0, scene)
}

/** Adds one cube to this frame. @inline */
function put(x: number, y: number, z: number, turn: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, glow: number): void {
  const at = instanceCount * INSTANCE
  f32x4.store(instances, at, f32x4(x, y, z, turn))
  f32x4.store(instances, at + 4, f32x4(sx, sy, sz, 0))
  f32x4.store(instances, at + 8, f32x4(r, g, b, glow))
  instanceCount++
}

/** Called by nib/loop once per displayed frame. `blend` is how far we are between two ticks. */
function render(blend: number): void {
  if (state !== PLAYING) blend = 1          // nothing is moving: draw where things are
  instanceCount = 0

  put(0, -0.1, 0, 0, FIELD, 0.1, FIELD, 0.13, 0.15, 0.21, 0)                       // floor
  put(0, 0.15, -FIELD - 0.2, 0, FIELD + 0.4, 0.35, 0.2, 0.2, 0.23, 0.32, 0)        // walls
  put(0, 0.15, FIELD + 0.2, 0, FIELD + 0.4, 0.35, 0.2, 0.2, 0.23, 0.32, 0)
  put(-FIELD - 0.2, 0.15, 0, 0, 0.2, 0.35, FIELD, 0.2, 0.23, 0.32, 0)
  put(FIELD + 0.2, 0.15, 0, 0, 0.2, 0.35, FIELD, 0.2, 0.23, 0.32, 0)

  if (state !== OVER) {
    const x = playerWasX + (playerX - playerWasX) * blend, z = playerWasZ + (playerZ - playerWasZ) * blend
    put(x, PLAYER_SIZE, z, playerVx * -0.04, PLAYER_SIZE, PLAYER_SIZE, PLAYER_SIZE, 0.91, 0.38, 0.23, 0.05)
  }
  for (let i = 0; i < hazardCount; i++) {
    const h = i * HAZARD
    const x = hazards[h + 4] + (hazards[h] - hazards[h + 4]) * blend, z = hazards[h + 5] + (hazards[h + 1] - hazards[h + 5]) * blend
    put(x, HAZARD_SIZE, z, clock * 1.3 + i, HAZARD_SIZE, HAZARD_SIZE, HAZARD_SIZE, 0.28, 0.2, 0.42, 0)
  }
  for (let i = 0; i < ORBS; i++) {
    const bob = sin(clock * 3 + i * 2) * 0.12
    put(orbs[i * ORB], 0.55 + bob, orbs[i * ORB + 1], clock * 2, ORB_SIZE, ORB_SIZE, ORB_SIZE, 1, 0.85, 0.3, 0.55)
  }
  for (let i = 0; i < sparkCount; i++) {
    const s = i * SPARK, size = Math.min(sparks[s + 6], 0.4) * 0.22
    put(sparks[s], sparks[s + 1], sparks[s + 2], sparks[s + 6] * 9, size, size, size, sparks[s + 7], sparks[s + 8], sparks[s + 9], 0.6)
  }

  queue.writeBuffer(instanceBuffer, 0, instances, 0, instanceCount * INSTANCE)
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: colorView,
      resolveTarget: context.getCurrentTexture().createView(),
      clearValue: [0.035, 0.04, 0.055, 1],
      loadOp: 'clear',
      storeOp: 'discard',
    }],
    depthStencilAttachment: { view: depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  pass.setVertexBuffer(0, vertexBuffer)
  pass.setVertexBuffer(1, instanceBuffer)
  pass.setIndexBuffer(indexBuffer, 'uint16')
  pass.drawIndexed(36, instanceCount)
  pass.end()
  queue.submit([encoder.finish()])
}
