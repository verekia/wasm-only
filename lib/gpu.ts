// WebGPU setup. The API itself needs no wrapping: call it as in any TypeScript, with the
// types from @webgpu/types. Each call compiles to one crossing into JavaScript.

import type { i32 } from 'nib'

export let canvas: HTMLCanvasElement
export let device: GPUDevice
export let queue: GPUQueue
export let context: GPUCanvasContext
export let format: GPUTextureFormat
/** The canvas size in device pixels, kept by gpuFit(). */
export let width: i32 = 1
export let height: i32 = 1

/**
 * Asks for a device and configures `target` for it, then calls `ready`. If anything is missing
 * (no WebGPU, no adapter) it calls `failed` instead.
 */
export function gpuStart(target: HTMLCanvasElement, ready: () => void, failed: () => void): void {
  canvas = target
  // each step runs inside the promise chain, so whatever is missing rejects it and lands in `failed`
  Promise.resolve(navigator.gpu).then(adapterOf).then(deviceOf).then(configure).then(ready).catch(failed)
}

function adapterOf(gpu: GPU): Promise<GPUAdapter | null> {
  format = gpu.getPreferredCanvasFormat()
  return gpu.requestAdapter()
}

function deviceOf(adapter: GPUAdapter | null): Promise<GPUDevice> { return adapter!.requestDevice() }

function configure(ready: GPUDevice): void {
  device = ready
  queue = ready.queue
  context = canvas.getContext('webgpu')!
  context.configure({ device, format })
}

/** Matches the canvas's pixel size to its size on screen. Call at start and on window "resize". */
export function gpuFit(): void {
  width = Math.max(1, (canvas.clientWidth * devicePixelRatio) | 0)
  height = Math.max(1, (canvas.clientHeight * devicePixelRatio) | 0)
  canvas.width = width
  canvas.height = height
}

/** A GPU buffer holding a copy of `data`. */
export function gpuBuffer(data: Float32Array | Uint16Array, usage: number): GPUBuffer {
  const buffer = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST })
  queue.writeBuffer(buffer, 0, data)
  return buffer
}
