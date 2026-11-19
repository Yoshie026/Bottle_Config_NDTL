import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Label print inks.
export const INKS = [
  { id: '#A9A9AB', label: 'Grey' },
  { id: '#DCCBA9', label: 'Champagne' },
]

export const LIGHTING = {
  studio: { label: 'Studio lighting', background: '#ffffff' },
  soft: { label: 'Soft daylight', background: '#ffffff' },
  dramatic: { label: 'Dramatic', background: '#1b1917' }, // flat fallback; the viewport uses a spotlit gradient
}

export const RESOLUTIONS = [
  { id: '1200', label: '1200 × 1200 px', w: 1200, h: 1200 },
  { id: '2400', label: '2400 × 2400 px', w: 2400, h: 2400 },
  { id: '4000', label: '4000 × 4000 px', w: 4000, h: 4000 },
  { id: '3000x2000', label: '3000 × 2000 px (3:2)', w: 3000, h: 2000 },
  { id: '2000x3000', label: '2000 × 3000 px (2:3)', w: 2000, h: 3000 },
  { id: 'view', label: 'Match viewport (2×)', w: 0, h: 0 },
]

export const DEFAULT_DESIGN = {
  title: 'Bottle Title Here',
  liquidColor: '#9270BB', // the liquid is always one colour
  liquidOpacity: 0.35, // 0 = clear tint, 1 = opaque
  glassMode: 'solid', // 'solid' | 'gradient'
  glassColor: '#FFFFFF', // solid glass colour
  glassOpacity: 0, // 0 = clear, 0.5 = fully tinted see-through, 1 = opaque coating
  // Gradient ramp, top (pos 0) to bottom (pos 1); any number of stops, at least two.
  glassStops: [
    { id: 1, pos: 0, color: '#E8607F', opacity: 0.45 },
    { id: 2, pos: 1, color: '#5B2FD6', opacity: 0.45 },
  ],
  liquidShape: 'sculpted', // 'sculpted' | 'follow'
  wall: 3.5, // glass wall thickness around the liquid, mm (3.5 sculpted ≈ 30 ml fill)
  dipTube: false,
  cap: 'metallic', // 'metallic' | 'matte'
  labelOn: true,
  productLine: '', // secondary line under the logo, e.g. 'light' / 'dark'
  labelInk: '#A9A9AB',
  pose: 'upright', // 'upright' | 'flat'
  lighting: 'studio',
  exportFormat: 'png', // 'png' | 'jpeg' | 'pdf'
  resolution: '2400',
  transparentBg: false,
  exportColourway: true, // moodboard band with hex values and ratios under the render
}

export const useDesign = create(
  persist(
    (set) => ({
      ...DEFAULT_DESIGN,
      set: (patch) => set(patch),
      reset: () => set(DEFAULT_DESIGN),
    }),
    {
      name: 'bottle-studio-design',
      version: 5,
      // v2 limited the inks to grey/champagne and dropped the typed brand text.
      // v3 added the liquid shape controls; v4 made the liquid one colour and moved the gradient to the glass;
      // v5 turned the two-colour glass gradient into a multi-stop ramp.
      migrate: (state) => ({
        ...DEFAULT_DESIGN,
        ...state,
        glassColor: state.glassColor ?? state.glassColor1 ?? DEFAULT_DESIGN.glassColor,
        glassOpacity: state.glassOpacity ?? state.glassOpacity1 ?? DEFAULT_DESIGN.glassOpacity,
        glassStops:
          state.glassStops ??
          (state.glassColor1
            ? [
                { id: 1, pos: state.glassStop1 ?? 0, color: state.glassColor1, opacity: state.glassOpacity1 ?? 0 },
                { id: 2, pos: state.glassStop2 ?? 1, color: state.glassColor2 ?? state.glassColor1, opacity: state.glassOpacity2 ?? 0 },
              ]
            : DEFAULT_DESIGN.glassStops),
        liquidColor: state.liquidColor ?? state.color2 ?? state.color1 ?? DEFAULT_DESIGN.liquidColor,
        liquidOpacity: state.liquidOpacity ?? state.opacity1 ?? state.density ?? DEFAULT_DESIGN.liquidOpacity,
        labelInk: INKS.some((i) => i.id === state.labelInk) ? state.labelInk : DEFAULT_DESIGN.labelInk,
        productLine: state.productLine ?? '',
      }),
      partialize: ({ set, reset, ...rest }) => rest,
    },
  ),
)

// Transient viewport state (not persisted).
export const useView = create((set) => ({
  view: 'front', // 'free' | 'front' | 'side' | 'top'
  viewNonce: 0,
  zoom: 1,
  zoomCmd: null, // { factor, nonce }
  exporting: false,
  liquidMl: null, // computed fill of the current liquid part
  setView: (view) => set((s) => ({ view, viewNonce: s.viewNonce + 1 })),
  zoomBy: (factor) => set({ zoomCmd: { factor, nonce: Math.random() } }),
  set: (patch) => set(patch),
}))
