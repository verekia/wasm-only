// A fixed-timestep game loop.
//
//   loopStart(update, render)
//
//   function update(dt: number): void       advance the game by one tick; dt is always TICK
//   function render(blend: number): void    draw; blend in 0..1 says how far the display is past the last tick
//
// Updating in fixed steps keeps the simulation identical on a 60 Hz and a 144 Hz display.
// Drawing between ticks (position = previous + (current - previous) * blend) keeps motion smooth.

import { inputEnd } from './input.ts'

export const TICK = 1 / 120

let update: (dt: number) => void
let render: (blend: number) => void
let last: number = 0
let owed: number = 0                   // time the simulation has not caught up with yet

export function loopStart(onUpdate: (dt: number) => void, onRender: (blend: number) => void): void {
  update = onUpdate
  render = onRender
  requestAnimationFrame(first)
}

function first(now: number): void {
  last = now
  requestAnimationFrame(frame)
}

function frame(now: number): void {
  owed += Math.min((now - last) * 0.001, 0.1)     // after a pause, resume rather than replay it
  last = now
  while (owed >= TICK) {
    update(TICK)
    inputEnd()
    owed -= TICK
  }
  render(owed / TICK)
  requestAnimationFrame(frame)
}
