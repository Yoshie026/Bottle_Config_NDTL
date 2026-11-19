import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { bridge } from './exporter'
import { rampSampler } from './liquid'
import { writeFBX } from './fbx'

// The colourway is a vertical ramp, so it bakes into a 1-D texture: U runs from the top of the
// glass (0) to the base (1). Base colour = tint, transmission = 1 – coating (the same 0–50% tint /
// 50–100% coating rule as the viewport).
function bakeColourway(design) {
  const stops =
    design.glassMode === 'gradient' ? design.glassStops : [{ pos: 0, color: design.glassColor, opacity: design.glassOpacity }]
  const sample = rampSampler(stops)
  const width = 256
  const color = document.createElement('canvas')
  const transmission = document.createElement('canvas')
  color.width = transmission.width = width
  color.height = transmission.height = 4
  const withAlpha = document.createElement('canvas')
  withAlpha.width = width
  withAlpha.height = 4
  const cc = color.getContext('2d')
  const tc = transmission.getContext('2d')
  const ac = withAlpha.getContext('2d')
  const c = new THREE.Color()
  for (let x = 0; x < width; x++) {
    const { opacity } = sample(x / (width - 1), c)
    const tint = Math.min(1, opacity * 2)
    const coat = Math.min(1, Math.max(0, opacity * 2 - 1))
    const rgb = [c.r, c.g, c.b].map((v) => Math.round((1 + (v - 1) * tint) * 255))
    cc.fillStyle = `rgb(${rgb.join(',')})`
    cc.fillRect(x, 0, 1, 4)
    // Alpha copy for FBX, where transparency comes from the texture: clear glass ≈ 25% opaque.
    ac.fillStyle = `rgba(${rgb.join(',')},${(0.25 + 0.75 * coat).toFixed(3)})`
    ac.fillRect(x, 0, 1, 4)
    const t = Math.round((1 - coat) * 255)
    tc.fillStyle = `rgb(${t},${t},${t})`
    tc.fillRect(x, 0, 1, 4)
  }
  return { color, transmission, withAlpha }
}

// Label prints with the ink colour baked in (white artwork × ink), keeping the alpha.
function inkCanvas(source, ink) {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = ink
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

function glassWithUVs(glass, [minY, maxY]) {
  const g = new THREE.BufferGeometry()
  g.setIndex(glass.index.clone())
  g.setAttribute('position', glass.attributes.position.clone())
  g.setAttribute('normal', glass.attributes.normal.clone())
  const pos = g.attributes.position
  const uv = new Float32Array(pos.count * 2)
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = THREE.MathUtils.clamp(1 - (pos.getY(i) - minY) / (maxY - minY), 0, 1)
    uv[i * 2 + 1] = 0.5
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

const strip = (geometry, keepUV) => {
  const g = new THREE.BufferGeometry()
  if (geometry.index) g.setIndex(geometry.index.clone())
  g.setAttribute('position', geometry.attributes.position.clone())
  g.setAttribute('normal', geometry.attributes.normal.clone())
  if (keepUV && geometry.attributes.uv) g.setAttribute('uv', geometry.attributes.uv.clone())
  return g
}

// Neutral description of every part (geometry in mm + physical material) shared by GLB and FBX.
function buildParts(design) {
  const p = bridge.parts
  if (!p) throw new Error('The bottle is still loading')
  const colourway = bakeColourway(design)
  const parts = [
    {
      name: 'Glass',
      geometry: glassWithUVs(p.glass, p.glassRange),
      material: {
        kind: 'glass',
        color: '#ffffff',
        map: colourway.color,
        mapWithAlpha: colourway.withAlpha,
        transmissionMap: colourway.transmission,
        transmission: 1,
        ior: 1.5,
        roughness: 0,
        metalness: 0,
        thickness: 20,
      },
    },
  ]
  if (design.liquidOpacity > 0 || design.liquidColor.toUpperCase() !== '#FFFFFF') {
    parts.push({
      name: 'Liquid',
      geometry: strip(p.liquid),
      material: {
        kind: 'liquid',
        color: design.liquidColor,
        transmission: 1 - design.liquidOpacity,
        ior: 1.34,
        roughness: 0.08,
        metalness: 0,
        thickness: 30,
      },
    })
  }
  parts.push({
    name: 'Cap',
    geometry: strip(p.cap, true),
    material:
      design.cap === 'metallic'
        ? { kind: 'chrome', color: '#f4f4f6', metalness: 1, roughness: 0.035 }
        : { kind: 'plastic', color: '#151516', metalness: 0, roughness: 0.62 },
  })
  if (design.labelOn) {
    for (const [name, geo, map] of [
      ['Label_Logo', p.brandGeo, p.brandMap],
      ['Label_Volume', p.volumeGeo, p.volumeMap],
    ]) {
      if (!geo) continue
      parts.push({
        name,
        geometry: strip(geo, true),
        material: { kind: 'print', color: '#ffffff', map: inkCanvas(map.image, design.labelInk), transparent: true, roughness: 0.35, metalness: 0 },
      })
    }
  }
  if (design.dipTube) {
    const { x, y, height, radius } = p.tube
    const tube = new THREE.CylinderGeometry(radius, radius, height, 24, 1, true).translate(x, y, 0)
    parts.push({ name: 'DipTube', geometry: tube, material: { kind: 'plastic', color: '#e9e9ea', metalness: 0, roughness: 0.3 } })
  }
  return parts
}

// Same orientation as the viewport textures (flipY); GLTFExporter flips the image to match glTF UVs.
function canvasTexture(canvas, srgb) {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  return t
}

async function toGLB(parts, title) {
  const root = new THREE.Group()
  root.name = title
  root.scale.setScalar(0.001) // glTF is in metres; the model is in millimetres
  for (const { name, geometry, material: m } of parts) {
    const material = new THREE.MeshPhysicalMaterial({
      name,
      color: m.color,
      metalness: m.metalness ?? 0,
      roughness: m.roughness ?? 0.5,
      transmission: m.transmission ?? 0,
      ior: m.ior ?? 1.5,
      thickness: m.thickness ?? 0,
      transparent: !!m.transparent,
      side: m.kind === 'plastic' && name === 'DipTube' ? THREE.DoubleSide : THREE.FrontSide,
    })
    if (m.map) material.map = canvasTexture(m.map, true)
    if (m.transmissionMap) material.transmissionMap = canvasTexture(m.transmissionMap, false)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    root.add(mesh)
  }
  const scene = new THREE.Scene()
  scene.add(root)
  const result = await new GLTFExporter().parseAsync(scene, { binary: true })
  return new Uint8Array(result)
}

const canvasPNG = (canvas) =>
  new Promise((resolve) => canvas.toBlob(async (b) => resolve(new Uint8Array(await b.arrayBuffer())), 'image/png'))

// FBX has no physically-based glass, so glass/liquid become transparent Phong materials.
async function toFBX(parts, title, stem) {
  const meshes = []
  for (const { name, geometry, material: m } of parts) {
    const g = geometry
    const color = new THREE.Color(m.color)
    const opacity = m.kind === 'glass' ? 0.25 : m.kind === 'liquid' ? 0.35 + 0.65 * (1 - m.transmission) : 1
    meshes.push({
      name,
      positions: g.attributes.position.array,
      normals: g.attributes.normal.array,
      uvs: g.attributes.uv ? g.attributes.uv.array : null, // FBX and three share bottom-left UVs
      index: g.index ? g.index.array : null,
      material: {
        name,
        color: [color.r, color.g, color.b],
        opacity,
        specular: m.kind === 'plastic' ? 0.2 : 1,
        shininess: m.kind === 'plastic' ? 12 : 96,
        reflection: m.kind === 'chrome' ? 0.9 : m.kind === 'glass' ? 0.1 : 0,
        texture: m.map ? { name: `${stem}_${name}`, png: await canvasPNG(m.mapWithAlpha ?? m.map) } : null,
      },
    })
  }
  return writeFBX(meshes, { title })
}

export async function export3D(design, format, stem) {
  const parts = buildParts(design)
  const title = design.title || 'Bottle'
  if (format === 'glb') return { bytes: await toGLB(parts, title), ext: 'glb', mime: 'model/gltf-binary' }
  return { bytes: await toFBX(parts, title, stem), ext: 'fbx', mime: 'application/octet-stream' }
}
