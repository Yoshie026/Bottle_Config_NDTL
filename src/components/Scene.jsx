import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Lightformer, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import Bottle from './Bottle'
import { LIGHTING, useDesign, useView } from '../store'
import { bridge } from '../exporter'

const PRESETS = {
  front: new THREE.Vector3(0, 0.32, 1),
  side: new THREE.Vector3(1, 0.32, 0),
  top: new THREE.Vector3(0, 1, 0.0001),
}

// Photographed studio lighting (Poly Haven, CC0) so chrome and glass get real reflections.
const HDRI = {
  studio: { file: '/hdri/studio_small_09_2k.hdr', intensity: 1, rotation: 0.6 },
  soft: { file: '/hdri/photo_studio_01_2k.hdr', intensity: 1.1, rotation: 0 },
}

// Dramatic: a dark room lit by one large window to the side — natural falloff, soft highlights,
// no hard strips — with a faint bounce on the opposite side so shadows keep some detail.
function DramaticStudio() {
  return (
    <Environment resolution={512} frames={1}>
      <color attach="background" args={['#0b0a09']} />
      <Lightformer form="rect" intensity={7} position={[-3.5, 1.6, 1.2]} rotation-y={Math.PI / 2.3} scale={[3.5, 4.5, 1]} color="#fff6ea" />
      <Lightformer form="rect" intensity={0.8} position={[3.5, 1, 0.5]} rotation-y={-Math.PI / 2} scale={[4, 4, 1]} />
      <Lightformer form="rect" intensity={0.6} position={[0, 1, 4]} scale={[5, 3, 1]} />
    </Environment>
  )
}

function Lights({ mode }) {
  if (mode === 'dramatic') {
    return (
      <>
        <DramaticStudio />
        <hemisphereLight args={['#fff6ea', '#1a1918', 0.8]} />
      </>
    )
  }
  const { file, intensity, rotation } = HDRI[mode]
  return (
    <>
      <Environment files={file} environmentIntensity={intensity} environmentRotation={[0, rotation, 0]} />
      {/* White-sweep bounce light: lifts diffuse surfaces (milky liquid, matte cap), not mirror reflections. */}
      <hemisphereLight args={['#ffffff', '#efedea', 1.6]} />
    </>
  )
}

// Dark seamless paper lit from the side: a gentle diagonal falloff, no spotlight pool. The glass
// refracts it, so tinted glass keeps some colour.
function useSpotlitBackdrop() {
  return useMemo(() => {
    const size = 1024
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, size, size * 0.6)
    g.addColorStop(0, '#5e5953')
    g.addColorStop(0.55, '#35312d')
    g.addColorStop(1, '#1b1917')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
  }, [])
}

function Backdrop({ lighting }) {
  const spotlit = useSpotlitBackdrop()
  const scene = useThree((s) => s.scene)
  useEffect(() => {
    scene.background = lighting === 'dramatic' ? spotlit : new THREE.Color(LIGHTING[lighting].background)
  }, [scene, lighting, spotlit])
  return null
}

// Soft shadow from an overhead key light onto an invisible, shadow-only floor.
function FloorShadow({ lighting }) {
  return (
    <>
      <directionalLight
        castShadow
        position={[0.8, 4, 1.2]}
        intensity={0}
        shadow-mapSize={[2048, 2048]}
        shadow-radius={14}
        shadow-blurSamples={20}
        shadow-bias={-0.0005}
        shadow-camera-left={-1.5}
        shadow-camera-right={1.5}
        shadow-camera-top={1.5}
        shadow-camera-bottom={-1.5}
        shadow-camera-near={1}
        shadow-camera-far={8}
      />
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[20, 20]} />
        <shadowMaterial transparent opacity={lighting === 'dramatic' ? 0.5 : 0.2} color={lighting === 'dramatic' ? '#000000' : '#1e1a16'} />
      </mesh>
    </>
  )
}

function CameraRig({ bounds }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls)
  const { view, viewNonce, zoomCmd } = useView()
  const anim = useRef(null)
  const base = useRef(3)

  const center = useCallback(() => {
    if (!bounds) return new THREE.Vector3(0, 0.55, 0)
    return bounds.getCenter(new THREE.Vector3())
  }, [bounds])

  // Distance that frames the whole bottle for the current pose.
  useEffect(() => {
    if (!bounds) return
    const size = bounds.getSize(new THREE.Vector3())
    const radius = size.length() / 2
    base.current = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.3
  }, [bounds, camera])

  useEffect(() => {
    if (!controls || view === 'free') return
    const target = center()
    const dir = PRESETS[view].clone().normalize()
    anim.current = { position: target.clone().addScaledVector(dir, base.current), target }
  }, [viewNonce, controls, bounds]) // eslint-disable-line react-hooks/exhaustive-deps

  // When the pose changes in free orbit, keep the angle but re-centre on the bottle.
  useEffect(() => {
    if (!controls || view !== 'free') return
    const target = center()
    const offset = camera.position.clone().sub(controls.target)
    anim.current = { position: target.clone().add(offset), target }
  }, [bounds]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!controls || !zoomCmd) return
    const offset = camera.position.clone().sub(controls.target).multiplyScalar(1 / zoomCmd.factor)
    anim.current = { position: controls.target.clone().add(offset), target: controls.target.clone() }
  }, [zoomCmd]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!controls) return
    const onStart = () => {
      anim.current = null
      if (useView.getState().view !== 'free') useView.getState().set({ view: 'free' })
    }
    const onChange = () => {
      const zoom = base.current / camera.position.distanceTo(controls.target)
      if (Math.abs(zoom - useView.getState().zoom) > 0.005) useView.getState().set({ zoom })
    }
    controls.addEventListener('start', onStart)
    controls.addEventListener('change', onChange)
    return () => {
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('change', onChange)
    }
  }, [controls, camera])

  useFrame((_, dt) => {
    if (!controls || !anim.current) return
    const k = 1 - Math.exp(-dt * 9)
    camera.position.lerp(anim.current.position, k)
    controls.target.lerp(anim.current.target, k)
    controls.update()
    if (camera.position.distanceTo(anim.current.position) < 1e-4) anim.current = null
  })

  return null
}

// Refreshed every frame so a hot-reloaded exporter module can never hold a stale or empty reference.
function ExportBridge() {
  useFrame((state) => {
    bridge.state = state
  })
  return null
}

export default function Scene() {
  const lighting = useDesign((s) => s.lighting)
  const [bounds, setBounds] = useState(null)

  return (
    <Canvas
      shadows="variance"
      dpr={[1, 2]}
      camera={{ position: [0, 0.75, 3.2], fov: 28, near: 0.05, far: 50 }}
      gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.NeutralToneMapping, localClippingEnabled: true }}
    >
      <Backdrop lighting={lighting} />
      <Suspense fallback={null}>
        <Bottle onBounds={setBounds} />
        <Lights mode={lighting} />
      </Suspense>
      <FloorShadow lighting={lighting} />
      <OrbitControls
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={0.4}
        maxDistance={10}
        maxPolarAngle={Math.PI * 0.495}
        target={[0, 0.55, 0]}
      />
      <CameraRig bounds={bounds} />
      <ExportBridge />
    </Canvas>
  )
}
