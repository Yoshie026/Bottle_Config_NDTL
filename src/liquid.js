import * as THREE from 'three'
import { MarchingCubes } from 'three/examples/jsm/objects/MarchingCubes.js'

// The supplied model is only the outer glass, so the liquid part is derived from it as a solid:
// voxelise the bottle, measure every point's distance to the outer surface, and extract the
// liquid surface at "wall thickness" inside. Unlike pushing the surface inward, this can't fold
// over itself in tight creases. Units are millimetres (bottle ≈ 110 mm tall).
export const LIQUID_BOTTOM = -50 // flat bottom of the liquid (clear glass tip below)
export const LIQUID_TOP = 19 // fill line just under the shoulder
const MIN_WALL = 1.2 // the liquid never comes closer than this to the outer surface
const RES = 128 // voxels along the longest side (~0.7 mm)
const SMOOTH_SIGMA = { follow: 0.9, sculpted: 5 } // mm; how much of the outer relief the liquid ignores

// Inside/outside per voxel by ray parity along Y, then exact distance to the nearest outside voxel.
export function buildDistanceField(glass) {
  glass.computeBoundingBox()
  const box = glass.boundingBox.clone().expandByScalar(3)
  const center = box.getCenter(new THREE.Vector3())
  const extent = box.getSize(new THREE.Vector3())
  const size = Math.max(extent.x, extent.y, extent.z)
  const voxel = size / RES
  const origin = center.clone().subScalar(size / 2)
  // Tiny offset so sample columns never sit exactly on a triangle edge (which would break parity).
  const jx = voxel * 0.00137
  const jz = voxel * 0.00071

  const pos = glass.attributes.position
  const index = glass.index.array
  const columns = new Array(RES * RES)
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let t = 0; t < index.length; t += 3) {
    a.fromBufferAttribute(pos, index[t])
    b.fromBufferAttribute(pos, index[t + 1])
    c.fromBufferAttribute(pos, index[t + 2])
    const i0 = Math.max(0, Math.ceil((Math.min(a.x, b.x, c.x) - origin.x) / voxel))
    const i1 = Math.min(RES - 1, Math.floor((Math.max(a.x, b.x, c.x) - origin.x) / voxel))
    const k0 = Math.max(0, Math.ceil((Math.min(a.z, b.z, c.z) - origin.z) / voxel))
    const k1 = Math.min(RES - 1, Math.floor((Math.max(a.z, b.z, c.z) - origin.z) / voxel))
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z)
    if (Math.abs(det) < 1e-12) continue
    for (let i = i0; i <= i1; i++) {
      const x = origin.x + i * voxel + jx
      for (let k = k0; k <= k1; k++) {
        const z = origin.z + k * voxel + jz
        const w1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det
        const w2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det
        const w3 = 1 - w1 - w2
        if (w1 < 0 || w2 < 0 || w3 < 0) continue
        const col = i + k * RES
        ;(columns[col] ??= []).push(w1 * a.y + w2 * b.y + w3 * c.y)
      }
    }
  }

  const n3 = RES * RES * RES
  const at = (x, y, z) => x + y * RES + z * RES * RES // MarchingCubes field layout
  const sq = new Float32Array(n3) // squared distance in voxels; 0 = outside
  for (let k = 0; k < RES; k++)
    for (let i = 0; i < RES; i++) {
      const hits = columns[i + k * RES]
      if (!hits) continue
      hits.sort((p, q) => p - q)
      let h = 0
      for (let j = 0; j < RES; j++) {
        const y = origin.y + j * voxel
        while (h < hits.length && hits[h] < y) h++
        if (h % 2 === 1) sq[at(i, j, k)] = 1e10
      }
    }

  edt3d(sq)
  const dist = new Float32Array(n3)
  let insideCount = 0
  for (let q = 0; q < n3; q++) {
    if (sq[q] > 0) insideCount++
    dist[q] = sq[q] > 0 ? Math.max(0, Math.sqrt(sq[q]) - 0.5) * voxel : -voxel * 0.5
  }
  return { dist, origin, voxel, size, center, smoothed: {}, glassVolume: (insideCount * voxel ** 3) / 1000 }
}

// Felzenszwalb & Huttenlocher squared Euclidean distance transform, one axis at a time.
function edt1d(f, n, d, v, z) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    while (s <= z[k]) {
      k--
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
  }
}

function forEachLine(field, fn) {
  const n = RES
  const line = new Float64Array(n)
  const out = new Float64Array(n)
  const strides = [1, n, n * n]
  for (const stride of strides) {
    const [s1, s2] = strides.filter((s) => s !== stride)
    for (let u = 0; u < n; u++)
      for (let w = 0; w < n; w++) {
        const base = u * s1 + w * s2
        for (let i = 0; i < n; i++) line[i] = field[base + i * stride]
        fn(line, out)
        for (let i = 0; i < n; i++) field[base + i * stride] = out[i]
      }
  }
}

function edt3d(field) {
  const v = new Int32Array(RES)
  const z = new Float64Array(RES + 1)
  forEachLine(field, (line, out) => edt1d(line, RES, out, v, z))
}

function gaussianBlur(src, sigmaVoxels) {
  const r = Math.ceil(sigmaVoxels * 3)
  const kernel = new Float64Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += kernel[i + r] = Math.exp(-(i * i) / (2 * sigmaVoxels * sigmaVoxels))
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum
  const field = Float32Array.from(src)
  forEachLine(field, (line, out) => {
    for (let i = 0; i < RES; i++) {
      let acc = 0
      for (let o = -r; o <= r; o++) acc += kernel[o + r] * line[Math.min(RES - 1, Math.max(0, i + o))]
      out[i] = acc
    }
  })
  return field
}

/**
 * Liquid part for the given shape and wall thickness.
 *  - 'follow': the liquid tracks the outer glass closely.
 *  - 'sculpted': the distance field is blurred, so the rocky relief stays solid clear glass.
 * Returns the geometry and its volume in ml.
 */
export function buildLiquid(volume, shape, wall) {
  const { dist, origin, voxel, size, center, smoothed } = volume
  smoothed[shape] ??= gaussianBlur(dist, SMOOTH_SIGMA[shape] / voxel)
  const smooth = smoothed[shape]

  const mc = new MarchingCubes(RES, new THREE.MeshBasicMaterial(), false, false, 400000)
  mc.isolation = 0
  const field = mc.field
  let filled = 0
  for (let z = 0; z < RES; z++)
    for (let y = 0; y < RES; y++) {
      const my = origin.y + y * voxel
      const fill = Math.min(LIQUID_TOP - my, my - LIQUID_BOTTOM)
      for (let x = 0; x < RES; x++) {
        const q = x + y * RES + z * RES * RES
        const edge = x === 0 || y === 0 || z === 0 || x === RES - 1 || y === RES - 1 || z === RES - 1
        const f = edge ? -1 : Math.min(dist[q] - MIN_WALL, smooth[q] - wall, fill)
        field[q] = f
        if (f > 0) filled++
      }
    }
  mc.normal_cache.fill(0)
  mc.update()

  const count = mc.count
  const half = size / 2
  const positions = new Float32Array(count * 3)
  const normals = new Float32Array(count * 3)
  const n = new THREE.Vector3()
  for (let i = 0; i < count; i++) {
    positions[i * 3] = center.x + mc.positionArray[i * 3] * half
    positions[i * 3 + 1] = center.y + mc.positionArray[i * 3 + 1] * half
    positions[i * 3 + 2] = center.z + mc.positionArray[i * 3 + 2] * half
    n.fromArray(mc.normalArray, i * 3).normalize()
    n.toArray(normals, i * 3)
  }
  mc.geometry.dispose()

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  // RGBA: rgb = liquid colour, a = opacity (drives transmission in the shader patch below).
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 4), 4))
  geometry.computeBoundingBox()
  return { geometry, ml: (filled * voxel ** 3) / 1000 }
}

// Colour ramp sampler. Stops are { pos, color, opacity } with pos 0 = top and 1 = bottom.
// Colours blend in sRGB (how the eye and the CSS preview blend), not linear light — otherwise the
// midpoint lands visually much closer to the lighter colour. Returns sRGB colour + opacity.
export function rampSampler(stops) {
  const ramp = [...stops]
    .sort((p, q) => p.pos - q.pos)
    .map((s) => ({ pos: s.pos, color: new THREE.Color(s.color).convertLinearToSRGB(), opacity: s.opacity }))
  const first = ramp[0]
  const last = ramp[ramp.length - 1]
  return (u, out = new THREE.Color()) => {
    if (u <= first.pos) return { color: out.copy(first.color), opacity: first.opacity }
    if (u >= last.pos) return { color: out.copy(last.color), opacity: last.opacity }
    let k = 0
    while (ramp[k + 1].pos < u) k++
    const a = ramp[k]
    const b = ramp[k + 1]
    const t = (u - a.pos) / (b.pos - a.pos || 1)
    return { color: out.lerpColors(a.color, b.color, t), opacity: THREE.MathUtils.lerp(a.opacity, b.opacity, t) }
  }
}

// Vertical colour ramp as RGBA vertex colours over the height `range` (top of range = pos 0).
export function paintRamp(geometry, stops, [minY, maxY]) {
  const pos = geometry.attributes.position
  const col = geometry.attributes.color
  const sample = rampSampler(stops)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const u = THREE.MathUtils.clamp(1 - (pos.getY(i) - minY) / (maxY - minY), 0, 1)
    const { opacity } = sample(u, c)
    c.convertSRGBToLinear()
    col.setXYZW(i, c.r, c.g, c.b, opacity)
  }
  col.needsUpdate = true
}

// The liquid is always one colour.
export function paintLiquid(liquid, { liquidColor, liquidOpacity }) {
  const { min, max } = liquid.boundingBox
  paintRamp(liquid, [{ pos: 0, color: liquidColor, opacity: liquidOpacity }], [min.y, max.y])
}

// Liquid: per-vertex opacity — an opaque vertex has no transmission, a clear one is fully transmissive.
export function patchLiquidMaterial(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <transmission_fragment>',
    THREE.ShaderChunk.transmission_fragment.replace(
      'material.transmission = transmission;',
      'material.transmission = transmission * ( 1.0 - vColor.a );',
    ),
  )
  // The alpha channel is opacity, not coverage.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n\tdiffuseColor.a = opacity;',
  )
}

// Glass (drei MeshTransmissionMaterial): opacity 0–50% tints clear glass toward the colour,
// 50–100% turns it into an opaque coating (e.g. the black sprayed top of "dark").
export function patchGlassMaterial(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    'material.transmission = _transmission;',
    'material.transmission = _transmission * ( 1.0 - clamp( vColor.a * 2.0 - 1.0, 0.0, 1.0 ) );',
  )
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
\tdiffuseColor.rgb = diffuse * mix( vec3( 1.0 ), vColor.rgb, clamp( vColor.a * 2.0, 0.0, 1.0 ) );
\tdiffuseColor.a = opacity;`,
  )
}
