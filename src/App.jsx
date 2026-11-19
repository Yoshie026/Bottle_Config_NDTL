import { useEffect, useState } from 'react'
import { useProgress } from '@react-three/drei'
import Scene from './components/Scene'
import Panel from './components/Panel'
import { LIGHTING, useDesign, useView } from './store'
import { exportImage } from './exporter'

const LIGHTING_ORDER = Object.keys(LIGHTING)

function useExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await exportImage()
    } catch (e) {
      console.error(e)
      setError(e.message || 'Export failed')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function SavedIndicator() {
  const design = useDesign()
  const [saved, setSaved] = useState(true)
  useEffect(() => {
    setSaved(false)
    const t = setTimeout(() => setSaved(true), 400)
    return () => clearTimeout(t)
  }, [design])
  return <span className="saved">{saved ? 'All changes saved' : 'Saving…'}</span>
}

function Header({ onExport, busy }) {
  const title = useDesign((s) => s.title)
  const set = useDesign((s) => s.set)
  const reset = useDesign((s) => s.reset)
  const setView = useView((s) => s.setView)
  return (
    <header className="header">
      <div className="brand">
        <img className="wordmark" src="/brand/logo-registered.png" alt="Neandertal®" />
        <span className="divider" />
        <span className="product">BOTTLE STUDIO PRO</span>
      </div>
      <div className="title">
        <input
          value={title}
          onChange={(e) => set({ title: e.target.value })}
          aria-label="Bottle title"
          spellCheck={false}
        />
        <SavedIndicator />
      </div>
      <div className="header-actions">
        <button
          className="btn ghost"
          onClick={() => {
            reset()
            setView('front')
          }}
        >
          Reset design
        </button>
        <button className="btn dark" onClick={onExport} disabled={busy}>
          {busy ? 'Exporting…' : 'Export'}
        </button>
      </div>
    </header>
  )
}

function PoseCard() {
  const pose = useDesign((s) => s.pose)
  const set = useDesign((s) => s.set)
  const options = [
    { id: 'upright', label: 'Upright' },
    { id: 'flat', label: 'Lying flat' },
  ]
  return (
    <div className="overlay pose-card">
      <div className="eyebrow">BOTTLE POSITION</div>
      <div className="pose-options">
        {options.map(({ id, label }) => (
          <button key={id} className={`pose ${pose === id ? 'active' : ''}`} onClick={() => set({ pose: id })}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function ViewToolbar() {
  const { view, setView, zoom, zoomBy } = useView()
  const views = [
    { id: 'free', label: 'Free orbit' },
    { id: 'front', label: 'Front' },
    { id: 'side', label: 'Side' },
    { id: 'top', label: 'Top' },
  ]
  return (
    <div className="toolbar-wrap">
      <div className="overlay toolbar">
        {views.map((v) => (
          <button
            key={v.id}
            className={`tool ${view === v.id ? 'active' : ''}`}
            onClick={() => (v.id === 'free' ? useView.getState().set({ view: 'free' }) : setView(v.id))}
          >
            {v.label}
          </button>
        ))}
        <span className="tool-sep" />
        <button className="tool icon" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
          –
        </button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button className="tool icon" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <button className="tool icon" onClick={() => setView('front')} aria-label="Reset view" title="Reset view">
          ↺
        </button>
      </div>
      <div className="hint">Drag to rotate · Scroll to zoom · Shift + drag to pan</div>
    </div>
  )
}

function Loader() {
  const { active, progress } = useProgress()
  if (!active) return null
  return <div className="loader">Loading bottle… {progress.toFixed(0)}%</div>
}

function Viewport({ busy }) {
  const lighting = useDesign((s) => s.lighting)
  const set = useDesign((s) => s.set)
  const next = LIGHTING_ORDER[(LIGHTING_ORDER.indexOf(lighting) + 1) % LIGHTING_ORDER.length]
  return (
    <section className={`viewport lighting-${lighting}`} style={{ background: LIGHTING[lighting].background }}>
      <Scene />
      <Loader />
      <PoseCard />
      <button
        className="overlay lighting-btn"
        onClick={() => set({ lighting: next })}
        title={`Switch to ${LIGHTING[next].label.toLowerCase()}`}
      >
        {LIGHTING[lighting].label}
      </button>
      <div className="essence">
        <div className="eyebrow">01 / ESSENCE</div>
        <div>30 ml · Eau de parfum</div>
      </div>
      <ViewToolbar />
      {busy && <div className="exporting">Rendering high-resolution image…</div>}
    </section>
  )
}

export default function App() {
  const { busy, error, run } = useExport()
  return (
    <div className="app">
      <Header onExport={run} busy={busy} />
      <main className="main">
        <Viewport busy={busy} />
        <Panel onExport={run} busy={busy} error={error} />
      </main>
    </div>
  )
}
