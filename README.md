# Nib

A compiler from TypeScript to WebAssembly, for the parts of a website or game that must be
fast. There is no new language: a file Nib compiles is an ordinary `.ts` file. It type-checks
with `tsc`, it runs as plain JavaScript, and it means the same thing both ways.

| | |
|---|---|
| ![A lit cube with speed, light and colour controls](docs/cube.png) | ![A small arcade game drawn with instanced cubes](docs/game.png) |
| [`examples/cube`](examples/cube): a Lambert-lit cube with DOM controls | [`examples/game`](examples/game): game loop, input, entity arrays, instancing |
| ![A crowd of animated figures](docs/crowd.png) | |
| [`examples/crowd`](examples/crowd): skinned characters, every skeleton posed in Wasm | |

| Shipped | Wasm | Bindings module | HTML |
|---|---|---|---|
| Cube | 4.01 kB (1.51 kB brotli) | 3.28 kB (1.34 kB) | 0.74 kB |
| Game | 8.28 kB (3.18 kB brotli) | 4.86 kB (1.75 kB) | 0.66 kB |
| Crowd | 10.07 kB (4.32 kB brotli) | 5.60 kB (1.90 kB) | 0.76 kB |

All three run under `Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'`.

## Run it

Needs [Bun](https://bun.sh). `bun install` is only for the type checker.

```sh
bun run dev      # http://localhost:3000: compiles on every request, reloads on save
bun run build    # writes dist/ with content-hashed file names
bun run check    # tsc over the compiler, the library, the examples and the tests
bun test         # every test program runs compiled and as plain TypeScript; results must match
bun run bench    # needs clang with the wasm32 target and wasm-ld
```

A page loads a program the way it loads any module:

```html
<script type="module" src="main.ts"></script>
```

The build compiles `main.ts` to `main-<hash>.wasm` and writes `main-<hash>.js`, an ES module
with the same exports that loads it. In `nib dev`, add `?js` to a page's URL to run the same
TypeScript uncompiled, for comparison.

## What it compiles

```ts
import { f32x4, type i32 } from 'nib'
import { sin } from 'nib/math'

const COUNT = 4096
const x = new Float32Array(COUNT), vx = new Float32Array(COUNT)     // memory: fixed addresses in the module
const table = buildTable()                                          // run by the compiler; ships as data

interface Vec2 { readonly x: number; readonly y: number }           // a value: two locals, never an allocation
let score = 0                                                        // an integer, because only integers go in
const label = document.getElementById('score')!                      // a JavaScript value, set at startup

function buildTable(): Float32Array {
  const out = new Float32Array(256)
  for (let i = 0; i < out.length; i++) out[i] = sin(i / 256 * Math.PI)
  return out
}

function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y } }

export function update(dt: number, steps: i32): void {
  const k = f32x4.splat(dt)
  for (let i = 0; i < COUNT; i += 4) f32x4.store(x, i, f32x4.add(f32x4.load(x, i), f32x4.mul(f32x4.load(vx, i), k)))
  score += steps
  label.textContent = `Score ${score}`                               // one call into JavaScript
}
```

- **Numbers.** `number` is a 64-bit float, as in JavaScript. `i32`, `u32` and `f32` are aliases of
  `number` from `nib` that pick a machine type. A `let` with no annotation is an integer for as
  long as only integers are assigned to it, and a number otherwise.
- **Operators do what JavaScript does.** `a / b` is real division; `(a / b) | 0` is integer
  division. `x | 0`, `x >>> 0`, `Math.imul`, `Math.fround` and the rest of `Math` compile to the
  matching instructions, or to a call when Wasm has none (`Math.sin`).
- **Typed arrays are the memory.** One declared at the top of a file has a fixed address, so
  `x[i]` is a load with a constant offset. `subarray` is a view of the same memory. A typed
  array built by a function at the top level is computed at build time and shipped as data.
- **Objects with fixed fields are values.** They live in locals and return as several Wasm
  values. They are immutable: assign a whole new one.
- **Functions**, function-typed variables and parameters, and arrow functions that capture
  nothing. Small functions are inlined; `/** @inline */` forces it. Short loops with constant
  bounds are unrolled.
- **`f32x4`** is four float32 lanes in one SIMD register: arithmetic, `min`, `max`, `sqrt`, and
  `shuffle` to pick lanes.
- **`compiled`**, from `nib`, is `true` in Wasm and `false` in JavaScript. The branch not taken is
  not compiled, so one file can hold a path for each.
- **Modules.** Relative imports, `nib/*`, and text files. Top-level code runs at startup, in
  import order, except what the compiler could already compute.

Not compiled: classes, closures, exceptions, generics, destructuring, `for...of`, `async`,
strings as Wasm data. A file that needs them stays a normal TypeScript file and imports the
compiled one.

## JavaScript values

Anything that is not one of the types above is a JavaScript value: a string, a DOM node, a
`GPUDevice`. Nib needs no declarations for them. It reads the expression as written and turns
it into one arrow function, with constants written in and whole call chains fused:

```ts
device.createBuffer({ size: n * 4, usage: GPUBufferUsage.VERTEX })
// (a,b)=>a.createBuffer({size:b,usage:GPUBufferUsage.VERTEX})

queue.submit([encoder.finish()])
// (a,b)=>a.submit([b.finish()])

pass = encoder.beginRenderPass({ colorAttachments: [{ view, resolveTarget: context.getCurrentTexture().createView(), ... }] })
// one call, where hand-written glue usually makes three
```

A typed array passed to JavaScript arrives as a view of the module's memory, so
`queue.writeBuffer(buffer, 0, vertices)` uploads with no copy on the Wasm side. A Nib function
passed to JavaScript is a callback.

Data comes in the other way through JavaScript's own arrays. `new Float32Array(n)` is memory;
`new Float32Array(buffer, offset, length)`, over a fetched file for example, is a JavaScript
value, and `set` copies it in:

```ts
let frames: Float32Array = new Float32Array(0)

export function load(file: ArrayBuffer, count: i32): void {
  frames = new Float32Array(count)                       // memory
  frames.set(new Float32Array(file, 64, count))          // (a,b,c,d,e)=>V$(Float32Array,a,b).set(new Float32Array(c,d,e))
}
```

A typed array method that Nib does not compile itself (`join`, `indexOf`, `sort`) is
JavaScript's, called on the view.

The arrows go into a table in the generated module, and the Wasm imports from it by position.
The table's name is a hash of its contents, so a module cannot link against a table from
another build. Nothing is evaluated from strings.

## The generated module

`main.js` exports what `main.ts` exports: functions, constants, and typed arrays as live
views. Other code imports it like the TypeScript file it replaces:

```ts
import { update, positions } from './sim.js'     // was './sim.ts'
update(1 / 60, 1)
gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW)       // the module's own memory, no copy
```

That is the way into an existing engine: move one kernel and its data to a file, keep
everything else.

## Where compiled and plain differ

The two agree bit for bit except here. Each is a place where JavaScript's answer is a number
that no fast integer can hold.

- **`i32` arithmetic wraps** past ±2³¹; JavaScript keeps counting. Write `Math.imul` or `| 0`
  where you mean to wrap, and use `number` where values can be large. (`u32` arithmetic is done
  in doubles, so it is exact.)
- **Integer zero has no sign**: `-i` is `0`, not `-0`.
- **Integer division or remainder by zero traps** instead of giving `Infinity` or `NaN`.
- **Reading past the end of an array** gives whatever is there, not `undefined`.
- **Float to integer** (`x | 0`) is exact for finite values below 2⁶³; beyond that and for
  `Infinity` it differs.
- **`new Float32Array(n)` inside a function** takes memory that is never returned.

## The library

Plain TypeScript in [`lib/`](lib), about 690 lines. It runs uncompiled too.

| | |
|---|---|
| `nib` | The number types and `f32x4` |
| `nib/math` | `sin`, `cos`, `clamp`, `random`; quaternions; 4×4 matrices on `Float32Array` |
| `nib/input` | Keys mapped to action bits, `held(LEFT)` and `hit(JUMP)`, the pointer |
| `nib/loop` | `loopStart(update, render)`: a fixed 120 Hz update with interpolated drawing |
| `nib/gpu` | `gpuStart(canvas, ready, failed)`, `gpuFit()`, `gpuBuffer(data, usage)` |
| `nib/skin` | Skeletal animation for crowds: `skinRig(file)`, `skinSpawn(rig)`, `skinPlay(i, clip, fade)`, `skinUpdate(dt)`, `skinMatrices()` |

There are no DOM or WebGPU bindings to maintain: the examples call both directly, typed by
`lib.dom.d.ts` and `@webgpu/types`.

## Measurements

One shared 4-core x86-64 machine; treat a few percent as noise.

### One source, three ways

[`bench/kernels.ts`](bench/kernels.ts) compiled by Nib, the same file run as JavaScript, and
[`bench/kernels.c`](bench/kernels.c) through `clang -O3`. All three return identical bits on
every kernel. Chromium 158, milliseconds per call, best of 7:

| Kernel | clang -O3 | Nib | plain JS | Nib / C | JS / C |
|---|---|---|---|---|---|
| hash: integer mixing | 47.4 | 41.6 | 120.9 | 0.88 | 2.55 |
| sieve: byte loads and stores | 6.7 | 6.3 | 8.6 | 0.94 | 1.28 |
| mandelbrot: doubles in locals | 29.5 | 30.2 | 30.7 | 1.02 | 1.04 |
| particles: doubles, float32 arrays | 24.1 | 25.4 | 27.7 | 1.05 | 1.15 |
| nbody: doubles in an array | 8.5 | 10.3 | 19.4 | 1.21 | 2.28 |
| fib: recursion | 7.6 | 13.2 | 16.6 | 1.74 | 2.18 |
| mat4: doubles, unrolled by hand | 12.8 | 24.1 | 33.8 | 1.88 | 2.64 |
| mat4 with `f32x4` | 12.6 | 10.9 | n/a | 0.87 | |
| particles with `f32x4` | 2.6 | 2.6 | n/a | 1.00 | |

- Compiled, the same TypeScript is 1.0× to 2.9× faster than it is as JavaScript.
- Written with `f32x4`, the particle update is 10× faster than the plain loop, in the same
  language. JavaScript has no equivalent, so `f32x4` uncompiled is a slow stand-in used only
  to check answers.
- clang still wins where it restructures code: it turns one of `fib`'s calls into a loop, and
  it keeps the matrix in registers across iterations. Nib compiles what is written.

Bun (JavaScriptCore) and Node (V8 12.4) give the same picture; `bun run bench` prints both.

### Posing a crowd

[`lib/skin.ts`](lib/skin.ts) keeps rigs, clips and characters in flat arrays. `skinUpdate(dt)`
advances every character, samples its clip (two while one fades into the next), walks the
skeleton and writes one skin matrix a joint into one array, which the page uploads as it is.
The file holds the loop twice: with numbers, and with `f32x4`. `compiled` picks between them.

1,000 characters, microseconds a frame, best of 15 (`bench/skin.html`). One character in four
is between two clips.

| Chromium 158 | joints | plain JS | Nib, numbers | Nib, `f32x4` | JS / `f32x4` |
|---|---|---|---|---|---|
| The figure of boxes in `examples/crowd` | 11,000 | 740 | 585 | 180 | 4.1 |
| Two game characters, 24 and 26 joints | 25,000 | 1,640 | 1,330 | 415 | 4.0 |

| Two game characters | plain JS | Nib, numbers | Nib, `f32x4` | JS / `f32x4` |
|---|---|---|---|---|
| Node 22 (V8 12.4) | 2,060 | 1,390 | 446 | 4.6 |
| Bun 1.4 (JavaScriptCore) | 1,418 | 1,405 | 466 | 3.0 |

- That is 17 ns a joint. A crowd of 1,000 costs 0.4 ms of a 16.7 ms frame; the example page
  shows the same figure live, and 1.9 ms with `?js`.
- Compiled and plain give the same bits, on both paths. The two paths differ from each other
  by less than 1e-5, because one rounds to float32 at every step and the other at the end.
- The layout does most of the work before the compiler does any: the plain JavaScript column
  is already this file, with no objects. Compiling the number path gains 1.0× to 1.5×. The
  rest comes from four lanes.
- [`examples/crowd/convert.ts`](examples/crowd/convert.ts) turns a skinned mesh of a glTF
  binary and its clips into a `.rig` file, which `skinRig` copies into memory without parsing:
  `bun examples/crowd/convert.ts model.glb hero.rig --mesh Body`.

### Calling the DOM from Wasm

Three ways to bind the same DOM members, nanoseconds per call, Chromium 158
(`bench/boundary.html`):

| Binding | method | getter | method, no arguments | plain function |
|---|---|---|---|---|
| Nib: one arrow per call shape | 29 | 9 | 60 | 12.5 |
| `Function.prototype.call.bind(native)` | 33 | 15 | 68–73 | 11.5–14 |
| One generic closure per kind | 34 | 9 | 72 | 15.5 |

Setters and layout-dependent getters cost 215–250 ns under every scheme.

### Compile time

| | |
|---|---|
| The cube: 360 lines with the library it imports | 4.4 ms |
| The game: 740 lines with the library it imports | 10 ms |
| The crowd: 900 lines with the library it imports | 12 ms |
| `nib build examples`, all three sites, from a cold start | about 200 ms |

The compiler is one pass from syntax tree to bytes, about 2,300 lines of TypeScript with no
dependencies.

## Limits

- No auto-vectorisation, no alias analysis, no loop restructuring: see the table.
- No scalar fallback for `f32x4` yet, so a compiled module that uses it needs Wasm SIMD
  (Safari 16.4 or later).
- Memory is typed arrays of fixed size, plus allocation that is never freed. There is no
  garbage collector and no `free`.
- Exported functions take numbers, booleans, JavaScript values and value objects; they cannot
  take a typed array or a function from JavaScript.
- `nib/skin` plays one clip a character and fades from the one before: no layers, no additive
  clips, no inverse kinematics. Clips are sampled at a fixed rate when the `.rig` is made, and
  frames are blended in a straight line. The example bends the mesh in the vertex shader from
  a storage buffer, which needs WebGPU.
- Verified in Chromium 158 with WebGPU on a software adapter, compiled and uncompiled,
  including keyboard and pointer play and the strict policy above. Everything without a DOM
  also runs in Bun and Node. Not yet run in Firefox or Safari, or on a real GPU or touch screen.

## Layout

```
nib/        syntax.ts (parser)   compiler.ts (checker, emitter)   loader.ts   cli.ts
lib/        index.ts   math.ts   input.ts   loop.ts   gpu.ts   skin.ts
examples/   cube/   game/   crowd/ (main.ts, rig.ts, convert.ts)   shared/cube.ts
bench/      kernels.ts   kernels.c   boundary.ts   harness.js   skin.js   run.ts   *.html
test/       compiler.test.ts
```
