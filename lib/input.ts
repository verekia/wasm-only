// Keyboard and pointer state, read by polling.
//
// A game names its own actions as bits and maps physical keys onto them:
//
//   const LEFT = 1, JUMP = 2
//   inputInit(canvas, { ArrowLeft: LEFT, KeyA: LEFT, Space: JUMP })
//
//   if (held(LEFT)) ...          // down right now
//   if (hit(JUMP)) ...           // went down since the last inputEnd()
//
// The keys are KeyboardEvent.code values: they name positions, so WASD works on every layout.

import type { i32 } from 'nib'

let down: i32 = 0
let pressed: i32 = 0
let keys: Record<string, number>

/** In CSS pixels, from the surface's top left corner. */
export let pointerX: number = 0
export let pointerY: number = 0
export let pointerHeld = false
/** Went down since the last inputEnd(). */
export let pointerHit = false

export function held(actions: i32): boolean { return (down & actions) !== 0 }
export function hit(actions: i32): boolean { return (pressed & actions) !== 0 }

/** Forgets what was hit. Call after each update that looked at it. */
export function inputEnd(): void {
  pressed = 0
  pointerHit = false
}

export function inputInit(surface: HTMLElement, map: Record<string, number>): void {
  keys = map
  addEventListener('keydown', onKeyDown)
  addEventListener('keyup', onKeyUp)
  addEventListener('blur', release)                     // a key released in another window would stay held
  surface.addEventListener('pointerdown', onPointerDown)
  surface.addEventListener('pointermove', onPointerMove)
  surface.addEventListener('pointerup', onPointerUp)
  surface.addEventListener('pointercancel', onPointerUp)
}

function onKeyDown(e: KeyboardEvent): void {
  const action: i32 = keys[e.code] | 0                  // 0 for a key that is not mapped
  if (action === 0 || e.ctrlKey || e.metaKey) return    // leave browser shortcuts alone
  e.preventDefault()                                    // keep arrows and space from scrolling the page
  pressed |= action & ~down                             // held keys repeat; only the first press is a hit
  down |= action
}

function onKeyUp(e: KeyboardEvent): void { down &= ~(keys[e.code] | 0) }

function release(): void {
  down = 0
  pointerHeld = false
}

function onPointerMove(e: PointerEvent): void {
  pointerX = e.offsetX
  pointerY = e.offsetY
}

function onPointerDown(e: PointerEvent): void {
  (e.target as Element).setPointerCapture(e.pointerId)  // keep following a drag that leaves the surface
  onPointerMove(e)
  pointerHeld = true
  pointerHit = true
}

function onPointerUp(): void { pointerHeld = false }
