import { useEffect, useRef, useState } from 'react'
import { INKS, RESOLUTIONS, useDesign, useView } from '../store'

const HEX = /^#[0-9a-f]{6}$/i

function Segmented({ value, options, onChange, variant = 'light' }) {
  return (
    <div className={`segmented ${variant}`}>
      {options.map((o) => (
        <button key={o.id} className={value === o.id ? 'active' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ColorField({ label, value, onChange }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (v) => {
    const hex = v.startsWith('#') ? v : `#${v}`
    if (HEX.test(hex)) onChange(hex.toUpperCase())
    else setDraft(value)
  }
  return (
    <label className="color-field">
      <span className="eyebrow">{label}</span>
      <span className="color-input">
        <span className="chip" style={{ background: value }}>
          <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
        </span>
        <input
          className="hex"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
          spellCheck={false}
        />
      </span>
    </label>
  )
}

// Opacity 0 is still a faint tint on the bottle, so keep a little colour in the preview.
const withAlpha = (hex, opacity) =>
  hex + Math.round((0.06 + Math.min(1, opacity * 2) * 0.94) * 255).toString(16).padStart(2, '0')

const MAX_STOPS = 6
const CHECKER = 'repeating-conic-gradient(#e6e3df 0% 25%, #ffffff 0% 50%) 0 0 / 12px 12px'

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()

// Colour and opacity of the ramp at a position (sRGB blend, matching the bottle).
function sampleRamp(stops, pos) {
  const ramp = [...stops].sort((a, b) => a.pos - b.pos)
  if (pos <= ramp[0].pos) return ramp[0]
  const last = ramp[ramp.length - 1]
  if (pos >= last.pos) return last
  let k = 0
  while (ramp[k + 1].pos < pos) k++
  const a = ramp[k]
  const b = ramp[k + 1]
  const t = (pos - a.pos) / (b.pos - a.pos || 1)
  const [ca, cb] = [hexToRgb(a.color), hexToRgb(b.color)]
  return { color: rgbToHex(ca.map((v, i) => v + (cb[i] - v) * t)), opacity: a.opacity + (b.opacity - a.opacity) * t }
}

// Multi-stop colour ramp for the glass: click the bar to add a stop, drag stops to move them,
// select a stop to edit its colour and opacity.
function RampEditor({ stops, onChange }) {
  const bar = useRef(null)
  const [selectedId, setSelectedId] = useState(stops[0].id)
  const selected = stops.find((s) => s.id === selectedId) ?? stops[0]
  const sorted = [...stops].sort((a, b) => a.pos - b.pos)
  const fill = `linear-gradient(90deg, ${sorted.map((s) => `${withAlpha(s.color, s.opacity)} ${s.pos * 100}%`).join(', ')})`

  const update = (id, patch) => onChange(stops.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  const posFromEvent = (e) => {
    const rect = bar.current.getBoundingClientRect()
    return Math.round(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)) * 100) / 100
  }

  const addStop = (e) => {
    if (stops.length >= MAX_STOPS) return
    const pos = posFromEvent(e)
    const id = Math.max(...stops.map((s) => s.id)) + 1
    onChange([...stops, { id, pos, ...sampleRamp(stops, pos) }])
    setSelectedId(id)
  }

  const drag = (id) => (e) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedId(id)
    const move = (ev) => update(id, { pos: posFromEvent(ev) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const remove = () => {
    if (stops.length <= 2) return
    const rest = stops.filter((s) => s.id !== selected.id)
    onChange(rest)
    setSelectedId(rest[0].id)
  }

  return (
    <>
      <div
        className="gradient-bar ramp"
        ref={bar}
        style={{ background: `${fill}, ${CHECKER}` }}
        onPointerDown={addStop}
        title={stops.length < MAX_STOPS ? 'Click to add a colour stop' : undefined}
      >
        {stops.map((s) => (
          <span
            key={s.id}
            className={`handle ${s.id === selected.id ? 'selected' : ''}`}
            style={{ left: `${s.pos * 100}%`, '--stop': s.color }}
            onPointerDown={drag(s.id)}
            title="Drag to move · click to edit"
          />
        ))}
      </div>
      <p className="hint-text ramp-hint">
        Top of the bottle on the left. Click the bar to add a stop (up to {MAX_STOPS}).
      </p>
      <div className="color-grid single">
        <ColorField label="STOP COLOUR" value={selected.color} onChange={(color) => update(selected.id, { color })} />
      </div>
      <Slider label="Stop position" value={selected.pos} onChange={(pos) => update(selected.id, { pos })} />
      <Slider label="Stop opacity" value={selected.opacity} onChange={(opacity) => update(selected.id, { opacity })} />
      <div className="field-row">
        <span className="label muted">
          {stops.length} stops
        </span>
        <button className="link-btn" onClick={remove} disabled={stops.length <= 2}>
          Remove stop
        </button>
      </div>
    </>
  )
}

function SolidSwatch({ color, opacity }) {
  return <div className="gradient-bar" style={{ background: `linear-gradient(${withAlpha(color, opacity)}, ${withAlpha(color, opacity)}), ${CHECKER}` }} />
}

function Section({ title, aside, children }) {
  return (
    <section className="panel-section">
      <div className="section-head">
        <h3>{title}</h3>
        {aside && <span className="aside">{aside}</span>}
      </div>
      {children}
    </section>
  )
}

// Number box you can type into; shows `value * scale` with a unit. Enter or blur applies,
// arrow keys nudge, out-of-range input is clamped.
function NumberInput({ value, onChange, min, max, step, scale = 100, unit = '%', decimals = 0 }) {
  const shown = (value * scale).toFixed(decimals)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const apply = (n) => onChange(Math.min(max, Math.max(min, n / scale)))
  const commit = () => {
    const n = parseFloat(draft)
    if (Number.isNaN(n)) setDraft(shown)
    else apply(n)
  }
  const onKeyDown = (e) => {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * scale * (e.shiftKey ? 10 : 1)
      apply(parseFloat(shown) + delta)
    }
  }
  return (
    <label className="value-input">
      <input
        inputMode="decimal"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.target.select()}
      />
      <span>{unit}</span>
    </label>
  )
}

function Slider({ label, value, onChange, min = 0, max = 1, step = 0.01, scale = 100, unit = '%', decimals = 0 }) {
  return (
    <div className="slider-row">
      <span className="label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <NumberInput
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        scale={scale}
        unit={unit}
        decimals={decimals}
      />
    </div>
  )
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span />
    </button>
  )
}

export default function Panel({ onExport, busy, error }) {
  const d = useDesign()
  const { set } = d
  const liquidMl = useView((s) => s.liquidMl)
  const formatLabel = { png: 'PNG', jpeg: 'JPEG', pdf: 'PDF', glb: 'GLB', fbx: 'FBX' }[d.exportFormat]
  const is3D = d.exportFormat === 'glb' || d.exportFormat === 'fbx'
  const res = RESOLUTIONS.find((r) => r.id === d.resolution)

  return (
    <aside className="panel">
      <Section title="Liquid colour" aside="Inside the glass">
        <div className="color-grid single">
          <ColorField label="COLOUR" value={d.liquidColor} onChange={(liquidColor) => set({ liquidColor })} />
        </div>
        <Slider label="Opacity" value={d.liquidOpacity} onChange={(liquidOpacity) => set({ liquidOpacity })} />
      </Section>

      <Section title="Colourway">
        <Segmented
          value={d.glassMode}
          options={[
            { id: 'solid', label: 'Solid' },
            { id: 'gradient', label: 'Gradient' },
          ]}
          onChange={(glassMode) => set({ glassMode })}
        />
        {d.glassMode === 'gradient' ? (
          <RampEditor stops={d.glassStops} onChange={(glassStops) => set({ glassStops })} />
        ) : (
          <>
            <SolidSwatch color={d.glassColor} opacity={d.glassOpacity} />
            <div className="color-grid single">
              <ColorField label="COLOUR" value={d.glassColor} onChange={(glassColor) => set({ glassColor })} />
            </div>
            <Slider label="Opacity" value={d.glassOpacity} onChange={(glassOpacity) => set({ glassOpacity })} />
          </>
        )}
        <p className="hint-text">Up to 50% tints the glass; above 50% it becomes an opaque coating.</p>
      </Section>

      <Section title="Glass">
        <div className="eyebrow field-label">LIQUID SHAPE</div>
        <Segmented
          value={d.liquidShape}
          options={[
            { id: 'sculpted', label: 'Sculpted glass' },
            { id: 'follow', label: 'Follows glass' },
          ]}
          onChange={(liquidShape) => set({ liquidShape })}
        />
        <p className="hint-text">
          {d.liquidShape === 'sculpted'
            ? 'Smooth inner cavity — the rocky relief stays solid clear glass.'
            : 'Liquid follows every contour of the outer glass.'}
        </p>
        <Slider
          label="Glass thickness"
          min={1}
          max={6}
          step={0.1}
          value={d.wall}
          onChange={(wall) => set({ wall })}
          scale={1}
          unit="mm"
          decimals={1}
        />
        <div className="field-row">
          <span className="label">Liquid volume</span>
          <span className="value-text">{liquidMl ? `≈ ${liquidMl.toFixed(0)} ml` : '—'}</span>
        </div>
        <div className="field-row">
          <span className="label">Dip tube</span>
          <Toggle checked={d.dipTube} onChange={(dipTube) => set({ dipTube })} />
        </div>
      </Section>

      <Section title="Cap finish">
        <Segmented
          value={d.cap}
          options={[
            { id: 'metallic', label: 'Metallic' },
            { id: 'matte', label: 'Matt black' },
          ]}
          onChange={(cap) => set({ cap })}
        />
      </Section>

      <Section
        title="Label print"
        aside={<Toggle checked={d.labelOn} onChange={(labelOn) => set({ labelOn })} />}
      >
        <div className={`label-fields ${d.labelOn ? '' : 'disabled'}`}>
          <label className="text-field">
            <span className="eyebrow">PRODUCT LINE</span>
            <input
              value={d.productLine}
              maxLength={16}
              placeholder="e.g. light, dark"
              onChange={(e) => set({ productLine: e.target.value })}
              disabled={!d.labelOn}
            />
          </label>
          <div className="ink-row">
            <span className="label">Ink</span>
            <div className="inks">
              {INKS.map((ink) => (
                <button
                  key={ink.id}
                  title={ink.label}
                  className={`ink ${d.labelInk === ink.id ? 'active' : ''}`}
                  style={{ background: ink.id }}
                  onClick={() => set({ labelInk: ink.id })}
                  disabled={!d.labelOn}
                />
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title="Export your creation">
        <p className="muted">{is3D ? 'Save the bottle as a 3D model, in millimetres.' : 'Save the current camera view.'}</p>
        <div className="eyebrow field-label">IMAGE</div>
        <Segmented
          variant="dark"
          value={d.exportFormat}
          options={[
            { id: 'png', label: 'PNG' },
            { id: 'jpeg', label: 'JPEG' },
            { id: 'pdf', label: 'PDF' },
          ]}
          onChange={(exportFormat) => set({ exportFormat })}
        />
        <div className="eyebrow field-label export-3d-label">3D MODEL</div>
        <Segmented
          variant="dark"
          value={d.exportFormat}
          options={[
            { id: 'glb', label: 'GLB (glTF)' },
            { id: 'fbx', label: 'FBX' },
          ]}
          onChange={(exportFormat) => set({ exportFormat })}
        />
        {is3D ? (
          <p className="hint-text">
            {d.exportFormat === 'glb'
              ? 'Physically based glass (transmission, IOR), liquid, cap and label prints. Opens in Blender, KeyShot, 3ds Max, Cinema 4D and web viewers.'
              : 'Meshes with embedded textures for 3ds Max, Maya, Cinema 4D and Blender. FBX has no real glass, so glass and liquid come in as transparent materials.'}
          </p>
        ) : (
          <>
          <div className="field-row">
            <span className="label">Resolution</span>
            <select value={d.resolution} onChange={(e) => set({ resolution: e.target.value })}>
              {RESOLUTIONS.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <span className={`label ${d.exportFormat === 'jpeg' ? 'muted' : ''}`}>
              Transparent background{d.exportFormat === 'jpeg' ? ' (not for JPEG)' : ''}
            </span>
            <Toggle
              checked={d.transparentBg && d.exportFormat !== 'jpeg'}
              onChange={(transparentBg) => set({ transparentBg })}
              disabled={d.exportFormat === 'jpeg'}
            />
          </div>
          <div className="field-row">
            <span className="label">Include colourway</span>
            <Toggle checked={d.exportColourway} onChange={(exportColourway) => set({ exportColourway })} />
          </div>
          </>
        )}
        <button className="btn dark block" onClick={onExport} disabled={busy}>
          {busy ? 'Exporting…' : is3D ? 'Export 3D model' : 'Export image'}
        </button>
        <p className="caption">
          {error ? (
            <span className="error">{error}</span>
          ) : is3D ? (
            `${formatLabel} · millimetres · current colourway`
          ) : (
            `High quality · ${formatLabel} · ${res?.label.split(' (')[0] ?? ''}${d.exportColourway ? ' + colourway' : ''}`
          )}
        </p>
      </Section>
    </aside>
  )
}
