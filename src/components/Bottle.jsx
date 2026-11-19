import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLoader } from '@react-three/fiber'
import { MeshTransmissionMaterial } from '@react-three/drei'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'
import { useDesign, useView } from '../store'
import { bridge } from '../exporter'
import {
  LIQUID_BOTTOM,
  buildDistanceField,
  buildLiquid,
  paintRamp,
  paintLiquid,
  patchGlassMaterial,
  patchLiquidMaterial,
} from '../liquid'

// Model units are millimetres (bottle ≈ 110 mm tall). Scale to ~1.1 world units.
const SCALE = 0.01
// Direction the printed face of the bottle points to, in model space.
const FRONT = new THREE.Vector3(0, 0, 1)

// Placement measured from the product photography (ref/ref.png), in model units:
// logo 16.5 wide, centred on the cap axis 8.2 below the cap; product line 3.4 below the logo;
// ℮30ml on the front of the tip, slightly left of centre.
const CAP_AXIS_X = 0.256
const LOGO_WIDTH = 16.5
const LOGO_Y = 16.6
const PRODUCT_LINE_GAP = 3.4

const BRAND_CANVAS = [2048, 768]
const BRAND_WIDTH = 18
const PX_PER_UNIT = BRAND_CANVAS[0] / BRAND_WIDTH
const BRAND_HEIGHT = BRAND_CANVAS[1] / PX_PER_UNIT
const BRAND_LOGO_CENTER = 160 // px from the top of the brand canvas
const BRAND_LABEL = {
  x: CAP_AXIS_X,
  y: LOGO_Y - (BRAND_CANVAS[1] / 2 - BRAND_LOGO_CENTER) / PX_PER_UNIT,
  depth: 16, // the shoulder curves away ~5 mm at the logo ends; the body is ~46 mm deep here
  width: BRAND_WIDTH,
  height: BRAND_HEIGHT,
}
const VOLUME_TEXT = '℮30ml' // every bottle is 30 ml
const VOLUME_CANVAS = [1024, 384]
const VOLUME_WIDTH = 10.5
const VOLUME_LABEL = {
  x: -1.9,
  y: -55.5,
  depth: 6, // the tip is narrow, keep the print off the back face
  width: VOLUME_WIDTH,
  height: (VOLUME_WIDTH * VOLUME_CANVAS[1]) / VOLUME_CANVAS[0],
}

// The cap mesh has a stepped top with broken triangulation, so the cap is rebuilt as a
// lathe from its measured profile: outer radius 10.7, hollow underside, rounded top edge.
const CAP = { radius: 10.7, bottom: 24.8, top: 51.5, fillet: 0.55, innerRadius: 9.35, innerTop: 29.6 }

function buildCap() {
  const { radius, bottom, top, fillet, innerRadius, innerTop } = CAP
  const pts = [
    [0, innerTop],
    [innerRadius, innerTop],
    [innerRadius, bottom],
    [radius, bottom],
    [radius, top - fillet],
  ]
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2)
    pts.push([radius - fillet + Math.cos(a) * fillet, top - fillet + Math.sin(a) * fillet])
  }
  // Fine rings across the top keep the flat face well tessellated for reflections.
  for (let i = 1; i <= 40; i++) pts.push([(radius - fillet) * (1 - i / 40), top])
  const lathe = new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(r, y)),
    160,
  )
  // Keep the corners crisp (bottom rim, inner recess) while the fillet stays smooth.
  const geometry = toCreasedNormals(lathe, THREE.MathUtils.degToRad(30))
  geometry.translate(CAP_AXIS_X, 0, 0)
  return geometry
}

function firstGeometry(obj) {
  let geometry
  obj.traverse((o) => {
    if (o.isMesh && !geometry) geometry = o.geometry
  })
  return geometry
}

function smoothGeometry(source) {
  const g = source.clone()
  g.deleteAttribute('normal')
  g.deleteAttribute('uv')
  const merged = mergeVertices(g, 1e-4)
  merged.computeVertexNormals()
  merged.computeBoundingBox()
  return merged
}

// Find where a ray from the front hits the glass at a given height.
function surfaceHit(glassMesh, x, y) {
  const origin = new THREE.Vector3(x, y, 0).addScaledVector(FRONT, 200)
  const ray = new THREE.Raycaster(origin, FRONT.clone().negate())
  const hit = ray.intersectObject(glassMesh, false)[0]
  if (!hit) return null
  return hit.point
}

function decalGeometry(glassMesh, label) {
  const point = surfaceHit(glassMesh, label.x, label.y)
  if (!point) return null
  // Project straight along the front axis, keeping the text level with the bottle's up axis.
  const orientation = new THREE.Euler().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(FRONT, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)),
  )
  const size = new THREE.Vector3(label.width, label.height, label.depth)
  return new DecalGeometry(glassMesh, point, orientation, size)
}

// Brand typefaces (see styles.css). Suisse Works when installed, otherwise the open fallback.
const SERIF = '"Suisse Works", "Source Serif 4", Georgia, serif'

// Draws into a canvas texture, and redraws once the webfonts have loaded.
function useCanvasTexture(width, height, draw, deps) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const t = new THREE.CanvasTexture(canvas)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    return t
  }, [width, height])

  useEffect(() => {
    let alive = true
    const paint = () => {
      if (!alive) return
      const ctx = texture.image.getContext('2d')
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#ffffff'
      draw(ctx, width, height)
      texture.needsUpdate = true
    }
    paint()
    // allSettled: loading rejects when Suisse Works isn't installed; the fallback serif still applies.
    Promise.allSettled([
      document.fonts.load(`400 100px ${SERIF}`),
      document.fonts.load(`500 100px ${SERIF}`),
    ]).then(paint)
    return () => {
      alive = false
    }
  }, [texture, ...deps]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => texture.dispose(), [texture])
  return texture
}

function fitText(ctx, text, weight, size, maxWidth) {
  ctx.font = `${weight} ${size}px ${SERIF}`
  while (ctx.measureText(text).width > maxWidth && size > 8) {
    size -= 4
    ctx.font = `${weight} ${size}px ${SERIF}`
  }
}

// Logo lockup from the style guide: wordmark artwork, product line set in Suisse Works Medium below.
function drawBrand(logo, productLine) {
  return (ctx, w) => {
    const logoW = LOGO_WIDTH * PX_PER_UNIT
    const logoH = (logo.height / logo.width) * logoW
    const x = (w - logoW) / 2
    ctx.drawImage(logo, x, BRAND_LOGO_CENTER - logoH / 2, logoW, logoH)
    // Recolour the black artwork to white; the material colour then sets the ink.
    ctx.globalCompositeOperation = 'source-in'
    ctx.fillRect(0, 0, w, BRAND_LOGO_CENTER + logoH / 2 + 2)
    ctx.globalCompositeOperation = 'source-over'
    if (productLine) {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.letterSpacing = '4px'
      fitText(ctx, productLine, 500, 270, w * 0.9)
      ctx.fillText(productLine, w / 2, BRAND_LOGO_CENTER + PRODUCT_LINE_GAP * PX_PER_UNIT)
    }
  }
}

function drawVolume(text) {
  return (ctx, w, h) => {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.letterSpacing = '2px'
    fitText(ctx, text, 400, 300, w * 0.96)
    ctx.fillText(text, w / 2, h / 2)
  }
}

// drei's transmission material builds its own shader; wrap it once per instance to add the glass tint.
const patchedGlass = new WeakSet()
function patchGlass(material) {
  if (!material || patchedGlass.has(material)) return
  patchedGlass.add(material)
  const base = material.onBeforeCompile
  material.onBeforeCompile = function (shader, renderer) {
    base.call(this, shader, renderer)
    patchGlassMaterial(shader)
  }
  material.needsUpdate = true
}

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

// Soft-touch plastic micro-grain for the matte cap (drives roughness and bump).
function grainTexture() {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(size, size)
  let seed = 1337
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let i = 0; i < size * size; i++) {
    const v = (0.85 + (rand() - 0.5) * 0.3) * 255
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 8
  texture.repeat.set(3, 3)
  return texture
}

// Print sits on the outer surface, so keep it out of the glass refraction buffer
// (offscreen passes) — otherwise it shows up twice, refracted through the bottle.
function hideOffscreen(renderer) {
  if (renderer.getRenderTarget() !== null) this.matrixWorld.makeScale(0, 0, 0)
}

function Label({ geometry, ink, map }) {
  if (!geometry) return null
  return (
    <mesh geometry={geometry} renderOrder={2} onBeforeRender={hideOffscreen}>
      <meshStandardMaterial
        map={map}
        color={ink}
        transparent
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-4}
        roughness={0.35}
        metalness={0}
        alphaTest={0.02}
      />
    </mesh>
  )
}

export default function Bottle({ onBounds }) {
  const glassObj = useLoader(OBJLoader, '/models/glass.obj')
  const logo = useLoader(THREE.ImageLoader, '/brand/logo.png')

  const design = useDesign()
  const brandMap = useCanvasTexture(...BRAND_CANVAS, drawBrand(logo, design.productLine.trim()), [
    logo,
    design.productLine,
  ])
  const volumeMap = useCanvasTexture(...VOLUME_CANVAS, drawVolume(VOLUME_TEXT), [])
  const exporting = useView((s) => s.exporting)
  const capTextures = useMemo(() => ({ grain: grainTexture() }), [])

  const { glass, cap, brandGeo, volumeGeo } = useMemo(() => {
    const glass = smoothGeometry(firstGeometry(glassObj))
    const cap = buildCap()

    const probe = new THREE.Mesh(glass)
    probe.updateMatrixWorld(true)
    return {
      glass,
      cap,
      brandGeo: decalGeometry(probe, BRAND_LABEL),
      volumeGeo: decalGeometry(probe, VOLUME_LABEL),
    }
  }, [glassObj])

  // Inner liquid part: its own solid, recoloured independently of the glass.
  const volume = useMemo(() => buildDistanceField(glass), [glass])
  const wall = useDebounced(design.wall, 120)
  const { geometry: liquid, ml } = useMemo(() => {
    const built = buildLiquid(volume, design.liquidShape, wall)
    paintLiquid(built.geometry, useDesign.getState())
    return built
  }, [volume, design.liquidShape, wall])
  useEffect(() => {
    useView.getState().set({ liquidMl: ml })
    return () => liquid.dispose()
  }, [liquid, ml])

  useEffect(() => {
    paintLiquid(liquid, design)
  }, [liquid, design.liquidColor, design.liquidOpacity]) // eslint-disable-line react-hooks/exhaustive-deps

  // Glass colour: solid or vertical gradient over the visible body (base to shoulder, under the cap).
  useLayoutEffect(() => {
    if (!glass.attributes.color) {
      glass.setAttribute('color', new THREE.BufferAttribute(new Float32Array(glass.attributes.position.count * 4), 4))
    }
    const stops =
      design.glassMode === 'gradient'
        ? design.glassStops
        : [{ pos: 0, color: design.glassColor, opacity: design.glassOpacity }]
    paintRamp(glass, stops, [glass.boundingBox.min.y, CAP.bottom])
  }, [glass, design.glassMode, design.glassColor, design.glassOpacity, design.glassStops])

  // Current parts in model space (mm), for the 3D (GLB/FBX) export.
  useEffect(() => {
    bridge.parts = {
      glass,
      liquid,
      cap,
      brandGeo,
      volumeGeo,
      brandMap,
      volumeMap,
      glassRange: [glass.boundingBox.min.y, CAP.bottom],
      tube: { x: CAP_AXIS_X, y: (CAP.innerTop + LIQUID_BOTTOM + 1) / 2, height: CAP.innerTop - LIQUID_BOTTOM - 1, radius: 0.9 },
    }
  }, [glass, liquid, cap, brandGeo, volumeGeo, brandMap, volumeMap])

  const outer = useRef()
  const flat = design.pose === 'flat'

  // Sit the bottle on the floor and report its bounds for the camera.
  useLayoutEffect(() => {
    const g = outer.current
    g.position.set(0, 0, 0)
    g.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(g, true)
    const center = box.getCenter(new THREE.Vector3())
    g.position.set(-center.x, -box.min.y, -center.z)
    g.updateWorldMatrix(true, true)
    onBounds?.(new THREE.Box3().setFromObject(g, true))
  }, [flat, glass, onBounds])

  const density = design.liquidOpacity

  return (
    <group ref={outer}>
      <group rotation={flat ? [0, 0.6, 0] : [0, 0, 0]}>
        <group rotation={flat ? [-Math.PI / 2, 0, 0] : [0, 0, 0]} scale={SCALE}>
          <mesh geometry={glass} castShadow>
            {/* Real glass reflects ~4% face-on and only turns mirror-like at grazing angles, so keep
                reflections modest and the refraction gentle; a faint green-blue body tint where thickest. */}
            <MeshTransmissionMaterial
              ref={patchGlass}
              vertexColors
              resolution={exporting ? 3072 : 2048}
              samples={exporting ? 12 : 8}
              transmission={1}
              thickness={26}
              roughness={0}
              ior={1.5}
              chromaticAberration={0.03}
              anisotropicBlur={0}
              distortion={0}
              clearcoat={0}
              backside
              backsideThickness={6}
              backsideEnvMapIntensity={0.7}
              color="#ffffff"
              attenuationColor="#e4f0ea"
              attenuationDistance={2}
              specularIntensity={0.9}
              envMapIntensity={0.8}
            />
          </mesh>

          <mesh geometry={liquid}>
            <meshPhysicalMaterial
              vertexColors
              transmission={1}
              thickness={30}
              roughness={0.08 + density * 0.1}
              ior={1.34}
              clearcoat={density}
              clearcoatRoughness={0.1}
              // Opaque liquids (milk, ink) need more light to read true to colour on white.
              envMapIntensity={0.8 + density * 0.9}
              onBeforeCompile={patchLiquidMaterial}
            />
          </mesh>

          {design.dipTube && (
            <mesh position={[CAP_AXIS_X, (CAP.innerTop + LIQUID_BOTTOM + 1) / 2, 0]}>
              <cylinderGeometry args={[0.9, 0.9, CAP.innerTop - LIQUID_BOTTOM - 1, 24, 1, true]} />
              {/* Opaque on purpose: transmissive objects can't see each other through the glass and liquid. */}
              <meshPhysicalMaterial color="#e9e9ea" roughness={0.3} clearcoat={0.6} side={THREE.DoubleSide} />
            </mesh>
          )}

          {design.labelOn && (
            <>
              <Label geometry={brandGeo} ink={design.labelInk} map={brandMap} />
              <Label geometry={volumeGeo} ink={design.labelInk} map={volumeMap} />
            </>
          )}

          <mesh geometry={cap} castShadow>
            {design.cap === 'metallic' ? (
              // Polished chrome: a near-perfect mirror of the studio HDRI.
              <meshPhysicalMaterial key="metal" color="#f4f4f6" metalness={1} roughness={0.035} envMapIntensity={1.25} />
            ) : (
              <meshPhysicalMaterial
                key="matte"
                color="#151516"
                metalness={0}
                roughness={0.62}
                roughnessMap={capTextures.grain}
                bumpMap={capTextures.grain}
                bumpScale={0.006}
                sheen={0.35}
                sheenColor="#5a5a5c"
                sheenRoughness={0.6}
                envMapIntensity={0.9}
              />
            )}
          </mesh>
        </group>
      </group>
    </group>
  )
}
