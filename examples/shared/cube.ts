// A unit cube (corners at ±1) with face normals. The compiler runs these functions and ships
// the result as data: the page never builds it.

/** Floats per vertex: position x y z, normal x y z. */
export const VERTEX_FLOATS = 6

export const cubeVertices = buildVertices()
export const cubeIndices = buildIndices()

function buildVertices(): Float32Array {
  const out = new Float32Array(24 * VERTEX_FLOATS)
  for (let face = 0; face < 6; face++) {
    const axis = face >> 1, side = (face & 1) === 0 ? 1 : -1
    for (let corner = 0; corner < 4; corner++) {
      const v = (face * 4 + corner) * VERTEX_FLOATS
      const a = corner === 1 || corner === 2 ? 1 : -1, b = corner >= 2 ? 1 : -1
      out[v + axis] = side                        // position: the face's plane...
      out[v + (axis + 1) % 3] = a * side          // ...and a counter-clockwise walk around it
      out[v + (axis + 2) % 3] = b
      out[v + 3 + axis] = side                    // normal
    }
  }
  return out
}

function buildIndices(): Uint16Array {
  const out = new Uint16Array(36)
  for (let face = 0; face < 6; face++) {
    const v = face * 4, i = face * 6
    out[i] = v
    out[i + 1] = v + 1
    out[i + 2] = v + 2
    out[i + 3] = v
    out[i + 4] = v + 2
    out[i + 5] = v + 3
  }
  return out
}
