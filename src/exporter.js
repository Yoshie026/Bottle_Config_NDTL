import * as THREE from 'three'
import { LIGHTING, RESOLUTIONS, useDesign, useView } from './store'
import { colourwayHeight, drawColourway } from './moodboard'

// Filled in by <ExportBridge /> inside the Canvas.
export const bridge = { state: null }

const nextFrames = (n) =>
  new Promise((resolve) => {
    let i = 0
    const tick = () => (++i >= n ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })

// File names: <bottle name>_<width>x<height> for images, <bottle name> for 3D models.
const bottleName = (title) => title.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-') || 'bottle'
const fileStem = (title, w, h) => `${bottleName(title)}_${w}x${h}`

function download(url, filename) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// Renders the current camera view at the requested resolution, off the visible canvas size.
async function renderView(width, height, transparent) {
  const { gl, scene, camera } = bridge.state
  const view = useView.getState()

  view.set({ exporting: true })
  const prevSize = gl.getSize(new THREE.Vector2())
  const prevRatio = gl.getPixelRatio()
  const prevAspect = camera.aspect
  const prevBackground = scene.background

  try {
    gl.setPixelRatio(1)
    gl.setSize(width, height, false)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    if (transparent) scene.background = null

    // Let the transmission buffers re-render at the new size.
    await nextFrames(4)
    gl.render(scene, camera)

    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    out.getContext('2d').drawImage(gl.domElement, 0, 0, width, height)
    return out
  } finally {
    scene.background = prevBackground
    gl.setPixelRatio(prevRatio)
    gl.setSize(prevSize.x, prevSize.y, false)
    camera.aspect = prevAspect
    camera.updateProjectionMatrix()
    view.set({ exporting: false })
  }
}

async function exportModel(design) {
  const { export3D } = await import('./export3d')
  const stem = bottleName(design.title)
  const { bytes, ext, mime } = await export3D(design, design.exportFormat, stem)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  download(url, `${stem}.${ext}`)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export async function exportImage() {
  if (!bridge.state) throw new Error('Viewport is not ready yet')
  const design = useDesign.getState()
  const format = design.exportFormat
  if (format === 'glb' || format === 'fbx') return exportModel(design)
  const transparent = design.transparentBg && format !== 'jpeg'

  let { w, h } = RESOLUTIONS.find((r) => r.id === design.resolution) ?? RESOLUTIONS[1]
  if (!w) {
    const size = bridge.state.size
    w = Math.round(size.width * 2)
    h = Math.round(size.height * 2)
  }

  let canvas = await renderView(w, h, transparent)

  if (!transparent) {
    // Flatten onto the studio colour so JPEG/PDF never show black where alpha was.
    const flat = document.createElement('canvas')
    flat.width = w
    flat.height = h
    const ctx = flat.getContext('2d')
    ctx.fillStyle = LIGHTING[design.lighting].background
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(canvas, 0, 0)
    canvas.getContext('2d').drawImage(flat, 0, 0)
  }

  if (design.exportColourway) {
    // Moodboard band under the render: hex values and ratios of the colourway.
    const band = colourwayHeight(w)
    const sheet = document.createElement('canvas')
    sheet.width = w
    sheet.height = h + band
    const ctx = sheet.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    await drawColourway(ctx, 0, h, w, band, design)
    canvas = sheet
    h += band
  }

  const name = fileStem(design.title, w, h)

  if (format === 'pdf') {
    const { jsPDF } = await import('jspdf')
    const pdf = new jsPDF({
      orientation: w >= h ? 'landscape' : 'portrait',
      unit: 'px',
      format: [w, h],
      hotfixes: ['px_scaling'],
      compress: true,
    })
    const data = transparent ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.95)
    pdf.addImage(data, transparent ? 'PNG' : 'JPEG', 0, 0, w, h, undefined, 'FAST')
    pdf.setProperties({ title: design.title, creator: 'Neandertal Bottle Studio' })
    pdf.save(`${name}.pdf`)
    return
  }

  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.95))
  const url = URL.createObjectURL(blob)
  download(url, `${name}.${format === 'jpeg' ? 'jpg' : 'png'}`)
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
