// Times nib/skin three ways on one crowd. Plain JavaScript so it runs unchanged in Bun, Node and a browser.
//   js:         lib/skin.ts as it is
//   nib scalar: the same functions, compiled
//   nib f32x4:  the four-floats-at-a-time path, compiled

export const CROWD = 1000

/** The same crowd in any build of nib/skin: clips, phases and speeds from a fixed seed, one character in four blending two clips. */
export function crowd(m, rigs, n = CROWD) {
  m.skinClear()
  let seed = 12345
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296
  let joints = 0
  for (let i = 0; i < n; i++) {
    const rig = rigs[i % rigs.length], c = m.skinSpawn(rig), clips = m.skinRigClips(rig)
    m.skinPlace(c, random() * 60, random() * 60, 0, random() * 6, 1)
    m.skinPlay(c, (random() * clips) | 0, 0)
    m.skinSeek(c, random() * 2)
    if (i % 4 === 0) m.skinPlay(c, (random() * clips) | 0, 1e6)      // a fade that never ends: it blends in every frame
    m.skinSpeed(c, 0.5 + random())
    joints += m.skinRigJoints(rig)
  }
  return joints
}

function time(m, update, rigs, rounds) {
  crowd(m, rigs)
  for (let i = 0; i < 200; i++) m[update](1 / 60)
  let best = Infinity
  for (let r = 0; r < rounds; r++) {
    const t = performance.now()
    for (let i = 0; i < 20; i++) m[update](1 / 60)
    best = Math.min(best, (performance.now() - t) / 20)
  }
  return best * 1000
}

function matrices(m, update, rigs) {
  crowd(m, rigs, 200)
  for (let i = 0; i < 30; i++) m[update](1 / 60)
  return Float32Array.from(m.skinMatrices())
}

/** `files` is [[name, [ArrayBuffer of a .rig, ...]], ...]. Rows of microseconds a frame for CROWD characters. */
export function measureSkin(nib, js, files, rounds = 15) {
  return files.map(([name, buffers]) => {
    const inNib = buffers.map(b => nib.skinRig(b)), inJs = buffers.map(b => js.skinRig(b))
    const joints = crowd(js, inJs)
    const a = matrices(js, 'skinUpdateScalar', inJs), b = matrices(nib, 'skinUpdateScalar', inNib), c = matrices(nib, 'skinUpdateSimd', inNib)
    let drift = 0
    for (let i = 0; i < a.length; i++) drift = Math.max(drift, Math.abs(a[i] - c[i]))
    return {
      name, joints, drift, same: a.length === b.length && a.every((x, i) => Object.is(x, b[i])),
      js: time(js, 'skinUpdateScalar', inJs, rounds), scalar: time(nib, 'skinUpdateScalar', inNib, rounds), simd: time(nib, 'skinUpdateSimd', inNib, rounds),
    }
  })
}

export function reportSkin(rows) {
  const num = (x, w) => x.toFixed(x < 100 ? 1 : 0).padStart(w)
  const lines = [`${CROWD} characters          joints  plain JS  Nib scalar  Nib f32x4   JS/f32x4   scalar results    f32x4 against scalar`, '-'.repeat(112)]
  for (const r of rows) lines.push(`${r.name.padEnd(22)}${String(r.joints).padStart(8)}${num(r.js, 10)}${num(r.scalar, 12)}${num(r.simd, 11)}${(r.js / r.simd).toFixed(2).padStart(11)}   ${(r.same ? 'identical' : 'DIFFER').padEnd(17)} within ${r.drift.toExponential(1)}`)
  return lines.join('\n')
}
