// How much does a call from Wasm into the DOM cost? Each export makes `n` calls of one kind.
// The values vary from call to call so every binding takes real arguments.

import type { i32 } from 'nib'

let sink: unknown

export function method(el: Element, name: string, n: i32): void { for (let i = 0; i < n; i++) sink = el.hasAttribute(name) }
export function getter(el: Node, n: i32): void { for (let i = 0; i < n; i++) sink = el.firstChild }
export function layoutGetter(el: Element, n: i32): number { let s: number = 0; for (let i = 0; i < n; i++) { const w: number = el.clientWidth; s += w } return s }
export function setter(el: Element, n: i32): void { for (let i = 0; i < n; i++) el.scrollTop = i & 1 }
export function noArguments(clock: Performance, n: i32): number { let s: number = 0; for (let i = 0; i < n; i++) { const t: number = clock.now(); s += t } return s }
export function plainFunction(x: number, n: i32): number { let s: number = 0; for (let i = 0; i < n; i++) { const h: number = Math.hypot(x, i); s += h } return s }
