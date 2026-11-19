// Moodboard-style colourway band appended under exported renders.
import { INKS } from './store'

const SERIF = '"Suisse Works", "Source Serif 4", Georgia, serif'
const INK = '#231f20'
const MUTED = '#8a8580'
const LINE = '#e7e3de'

// Colours in the glass colourway with the share of the bottle's height each one covers:
// every colour reaches halfway to its neighbours, the end colours run to the top and base.
export function colourwayRatios(design) {
  if (design.glassMode !== 'gradient') {
    return [{ color: design.glassColor, opacity: design.glassOpacity, ratio: 100 }]
  }
  const stops = [...design.glassStops].sort((a, b) => a.pos - b.pos)
  const shares = stops.map((s, i) => {
    const start = i === 0 ? 0 : (stops[i - 1].pos + s.pos) / 2
    const end = i === stops.length - 1 ? 1 : (s.pos + stops[i + 1].pos) / 2
    return Math.max(0, end - start)
  })
  // Whole percentages that still add up to exactly 100.
  const raw = shares.map((s) => s * 100)
  const ratios = raw.map(Math.floor)
  let remainder = 100 - ratios.reduce((a, b) => a + b, 0)
  raw
    .map((v, i) => [v - Math.floor(v), i])
    .sort((a, b) => b[0] - a[0])
    .forEach(([, i]) => remainder-- > 0 && ratios[i]++)
  return stops.map((s, i) => ({ color: s.color, opacity: s.opacity, ratio: ratios[i] }))
}

export function colourwayHeight(width) {
  return Math.round(width * 0.26)
}

function fitFont(ctx, text, weight, size, maxWidth) {
  ctx.font = `${weight} ${size}px ${SERIF}`
  while (ctx.measureText(text).width > maxWidth && size > 6) {
    size -= 1
    ctx.font = `${weight} ${size}px ${SERIF}`
  }
}

export async function drawColourway(ctx, x, y, width, height, design) {
  // allSettled: loading rejects when Suisse Works isn't installed; the fallback serif still applies.
  await Promise.allSettled([400, 500, 700].map((w) => document.fonts.load(`${w} 40px ${SERIF}`)))
  const u = width / 100 // layout unit
  const pad = 4 * u
  const inner = width - pad * 2
  const colours = colourwayRatios(design)

  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x, y, width, height)
  ctx.fillStyle = LINE
  ctx.fillRect(x + pad, y, inner, Math.max(1, u * 0.08))
  ctx.textBaseline = 'alphabetic'
  ctx.letterSpacing = '0px'

  // Heading: bottle name and section label.
  let cy = y + pad * 1.15
  ctx.fillStyle = INK
  fitFont(ctx, design.title || 'Untitled', 700, 2.6 * u, inner * 0.6)
  ctx.textAlign = 'left'
  ctx.fillText(design.title || 'Untitled', x + pad, cy)
  ctx.fillStyle = MUTED
  ctx.font = `500 ${1.25 * u}px ${SERIF}`
  ctx.letterSpacing = `${0.12 * u}px`
  ctx.textAlign = 'right'
  ctx.fillText('COLOURWAY', x + width - pad, cy)
  ctx.letterSpacing = '0px'

  // Proportion bar: each colour's width is its share of the bottle.
  cy += 2 * u
  const barH = 4.2 * u
  let bx = x + pad
  colours.forEach((c, i) => {
    const w = i === colours.length - 1 ? x + pad + inner - bx : (inner * c.ratio) / 100
    ctx.fillStyle = c.color
    ctx.fillRect(bx, cy, w, barH)
    bx += w
  })
  ctx.strokeStyle = 'rgba(0,0,0,0.08)'
  ctx.lineWidth = Math.max(1, u * 0.06)
  ctx.strokeRect(x + pad, cy, inner, barH)

  // Swatch cards: chip, hex, ratio and opacity, in equal columns so narrow shares stay legible.
  cy += barH + 2.4 * u
  const cols = colours.length
  const gap = 2 * u
  const colW = (inner - gap * (cols - 1)) / cols
  const chip = 3.2 * u
  colours.forEach((c, i) => {
    const cx = x + pad + i * (colW + gap)
    ctx.fillStyle = c.color
    ctx.fillRect(cx, cy, chip, chip)
    ctx.strokeRect(cx, cy, chip, chip)
    const tx = cx + chip + 1.2 * u
    const tw = colW - chip - 1.2 * u
    ctx.textAlign = 'left'
    ctx.fillStyle = INK
    fitFont(ctx, c.color.toUpperCase(), 500, 1.6 * u, tw)
    ctx.fillText(c.color.toUpperCase(), tx, cy + 1.35 * u)
    ctx.fillStyle = MUTED
    const detail = `${c.ratio}% · opacity ${Math.round(c.opacity * 100)}%`
    fitFont(ctx, detail, 400, 1.25 * u, tw)
    ctx.fillText(detail, tx, cy + 3 * u)
  })

  // Spec line: the rest of the build.
  const ink = INKS.find((i) => i.id === design.labelInk)?.label ?? design.labelInk
  const spec = [
    `Liquid ${design.liquidColor.toUpperCase()} · opacity ${Math.round(design.liquidOpacity * 100)}%`,
    `Cap ${design.cap === 'metallic' ? 'metallic' : 'matt black'}`,
    design.labelOn ? `Print ${ink.toLowerCase()}${design.productLine ? ` · “${design.productLine}”` : ''}` : 'No print',
    '30 ml',
  ].join('   ·   ')
  ctx.fillStyle = MUTED
  ctx.textAlign = 'left'
  fitFont(ctx, spec, 400, 1.2 * u, inner)
  ctx.fillText(spec, x + pad, y + height - pad * 0.7)
  ctx.restore()
}
