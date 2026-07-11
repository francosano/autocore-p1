// TARGET: autocore-npa/app/crm/fuentes.ts
// Single source of truth for lead `fuente` (crm_leads.fuente) across the CRM.
//
// Adding a new fuente is a ONE-LINE change here: add a row to FUENTE_DEFS.
//   • `selectable: true`  → appears in the manual create/edit + walk-in forms.
//   • `selectable: false` → ingestion/system source (Meta Ads, orgánico, …):
//     never offered in a manual dropdown, but still labeled/colored wherever
//     leads with that fuente are displayed or broken down.
// Labels/colors flow to campañas, dashboard and reportes via FUENTE_META /
// fuenteLabel — so nothing else needs editing.

export interface FuenteDef {
  key: string
  label: string
  color: string
  paid: boolean       // paid-acquisition channel (campañas ROI split)
  selectable: boolean // offered in manual create/edit/walk-in dropdowns
}

// Order matters only for the manual dropdowns (selectable rows render in this
// order). Breakdowns enumerate from live lead data, so their order is unaffected.
export const FUENTE_DEFS: FuenteDef[] = [
  { key: 'walk_in',   label: 'Walk-in',   color: '#8A93A0', paid: false, selectable: true },
  { key: 'whatsapp',  label: 'WhatsApp',  color: '#2FBF8F', paid: false, selectable: true },
  { key: 'instagram', label: 'Instagram', color: '#E5689A', paid: true,  selectable: true },
  { key: 'website',   label: 'Sitio Web', color: '#E0A23C', paid: false, selectable: true },
  { key: 'sgc',       label: 'SGC (Kia)', color: '#C56B4A', paid: false, selectable: true },
  { key: 'referido',  label: 'Referido',  color: '#57A6C9', paid: false, selectable: true },
  // ── ingestion / system sources (not manually selectable) ──
  { key: 'meta_ads',    label: 'Meta Ads',    color: '#5A8DEE', paid: true,  selectable: false },
  { key: 'facebook',    label: 'Facebook',    color: '#4267B2', paid: true,  selectable: false },
  { key: 'tiktok',      label: 'TikTok',      color: '#9B7DF0', paid: true,  selectable: false },
  { key: 'organico',    label: 'Orgánico',    color: '#8A93A0', paid: false, selectable: false },
  { key: 'desconocido', label: 'Desconocido', color: '#7B8694', paid: false, selectable: false },
]

// Lookup by key (label/color/paid).
export const FUENTE_META: Record<string, FuenteDef> =
  Object.fromEntries(FUENTE_DEFS.map(f => [f.key, f]))

// Options for the manual create/edit/walk-in <select>s.
export const FUENTES_SELECTABLE = FUENTE_DEFS.filter(f => f.selectable)

// Human label for any fuente string (falls back to the raw key / em dash).
export const fuenteLabel = (key: string | null | undefined) =>
  (key && FUENTE_META[key]?.label) || key || '—'
