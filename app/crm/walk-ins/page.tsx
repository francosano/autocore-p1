// TARGET: autocore-npa/app/crm/walk-ins/page.tsx
'use client'

import { useEffect, useMemo, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'

const ETAPA_LABEL: Record<string, string> = {
  nuevo: 'Nuevo', contactado: 'Contactado', cita_agendada: 'Cita agendada',
  visita_showroom: 'Visita showroom', oferta_presentada: 'Oferta presentada',
  financiamiento: 'Financiamiento', cerrado_ganado: 'Vendido', cerrado_perdido: 'Perdido',
}
const ETAPA_COLOR: Record<string, string> = {
  nuevo: '#8A93A0', contactado: '#5A8DEE', cita_agendada: '#9B7DF0',
  visita_showroom: '#E0A23C', oferta_presentada: '#E5689A',
  financiamiento: '#2FBF8F', cerrado_ganado: '#15A06E', cerrado_perdido: '#E5556A',
}

interface Lead {
  id: string
  nombre: string
  apellidos: string
  telefono: string
  fuente: string
  asignado_nombre: string | null
  modelo_interes: string | null
  presupuesto_usd: number | null
  etapa: string
  created_at: string
  archived_at: string | null
}

type Rango = '7' | '30' | '90' | 'mes' | 'todo'

const RANGOS: { key: Rango; label: string }[] = [
  { key: '7', label: '7 días' },
  { key: '30', label: '30 días' },
  { key: '90', label: '90 días' },
  { key: 'mes', label: 'Este mes' },
  { key: 'todo', label: 'Todo' },
]

const fmtFecha = (iso: string) =>
  iso ? new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'

function rangoDesde(r: Rango): number {
  const now = new Date()
  if (r === 'todo') return 0
  if (r === 'mes') return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  const dias = parseInt(r, 10)
  return now.getTime() - dias * 86400000
}

export default function WalkInsPage() {
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [rows, setRows] = useState<Lead[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [rango, setRango] = useState<Rango>('30')
  const [asesor, setAsesor] = useState('')
  const [verArchivados, setVerArchivados] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const { data, error } = await supabase
        .from('crm_leads')
        .select('id,nombre,apellidos,telefono,fuente,asignado_nombre,modelo_interes,presupuesto_usd,etapa,created_at,archived_at')
        .eq('fuente', 'walk_in')
        .order('created_at', { ascending: false })
        .limit(5000)
      if (error) throw error
      setRows((data as any) || [])
    } catch (e: any) {
      setErr(e?.message || 'Error cargando walk-ins')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (!permsLoading && permissions.npa_can_view_crm) load() }, [permsLoading, permissions.npa_can_view_crm, load])

  const all = rows || []
  const asesores = useMemo(
    () => Array.from(new Set(all.map(r => r.asignado_nombre).filter(Boolean))).sort() as string[],
    [all]
  )

  const desde = rangoDesde(rango)
  const list = useMemo(() => all.filter(r => {
    if (!verArchivados && r.archived_at) return false
    if (desde && new Date(r.created_at).getTime() < desde) return false
    if (asesor && r.asignado_nombre !== asesor) return false
    return true
  }), [all, desde, asesor, verArchivados])

  const total = list.length
  const vendidos = list.filter(r => r.etapa === 'cerrado_ganado').length
  const enPipeline = list.filter(r => !['cerrado_ganado', 'cerrado_perdido'].includes(r.etapa)).length
  const conv = total > 0 ? Math.round((vendidos / total) * 100) : 0
  const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime()
  const esteMes = all.filter(r => (!r.archived_at || verArchivados) && new Date(r.created_at).getTime() >= inicioMes).length

  const exportCSV = () => {
    const head = ['Nombre', 'Apellidos', 'Teléfono', 'Fecha registro', 'Asesor', 'Modelo', 'Presupuesto USD', 'Etapa']
    const esc = (v: any) => {
      const s = String(v ?? '')
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const lines = list.map(r => [
      r.nombre, r.apellidos, r.telefono, fmtFecha(r.created_at),
      r.asignado_nombre || '', r.modelo_interes || '',
      r.presupuesto_usd ?? '', ETAPA_LABEL[r.etapa] || r.etapa,
    ].map(esc).join(','))
    const csv = [head.join(','), ...lines].join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `walk-ins-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (permsLoading) return <Shell><div style={s.muted}>Cargando…</div></Shell>
  if (!permissions.npa_can_view_crm) return <Shell><div style={s.muted}>No tienes acceso al CRM.</div></Shell>

  return (
    <Shell>
      <div style={s.headRow}>
        <div>
          <div style={s.eyebrow}>CRM · Reporte</div>
          <h1 style={s.title}>Walk-ins</h1>
          <div style={s.sub}>Clientes que llegaron directo al concesionario, sin interacción previa (fuente: Walk-in).</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button style={s.btnPrimary} onClick={exportCSV} disabled={list.length === 0}>⭳ Exportar CSV</button>
          <button style={s.btnGhost} onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
        </div>
      </div>

      <div style={s.controls}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {RANGOS.map(r => (
            <button key={r.key} onClick={() => setRango(r.key)}
              style={{ ...s.chip, ...(rango === r.key ? s.chipOn : {}) }}>{r.label}</button>
          ))}
        </div>
        {asesores.length > 0 && (
          <select value={asesor} onChange={e => setAsesor(e.target.value)} style={s.select}>
            <option value="">Todos los asesores</option>
            {asesores.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <label style={s.check}>
          <input type="checkbox" checked={verArchivados} onChange={e => setVerArchivados(e.target.checked)} />
          Ver archivados
        </label>
      </div>

      {err && <div style={s.error}>{err}</div>}
      {loading && !rows && <div style={s.muted}>Cargando walk-ins…</div>}

      {rows && (
        <>
          <div style={s.kpiRow}>
            <Kpi n={total} label="Walk-ins (rango)" />
            <Kpi n={esteMes} label="Este mes" />
            <Kpi n={enPipeline} label="En pipeline" color="var(--warn)" />
            <Kpi n={vendidos} label="Vendidos" color="var(--ok)" />
            <Kpi n={`${conv}%`} label="Conversión" color={conv >= 20 ? 'var(--ok)' : conv >= 10 ? 'var(--warn)' : 'var(--text-primary)'} />
          </div>

          {list.length === 0 ? (
            <div style={s.card}>
              <div style={{ fontSize: 15, color: 'var(--text-secondary)', fontWeight: 700 }}>Sin walk-ins en este rango</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>Prueba con un rango más amplio o quita el filtro de asesor.</div>
            </div>
          ) : (
            <div style={s.tableWrap}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Cliente', 'Fecha', 'Asesor', 'Modelo', 'Presupuesto', 'Etapa', ''].map(h => (
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.map(r => (
                    <tr key={r.id} style={s.tr}>
                      <td style={s.td}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{r.nombre} {r.apellidos}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.telefono?.startsWith('kommo_') ? '—' : r.telefono}</div>
                      </td>
                      <td style={{ ...s.td, fontSize: 12, color: 'var(--text-secondary)' }}>{fmtFecha(r.created_at)}</td>
                      <td style={{ ...s.td, fontSize: 12, color: 'var(--text-secondary)' }}>{r.asignado_nombre || '—'}</td>
                      <td style={{ ...s.td, fontSize: 12, color: 'var(--text-secondary)' }}>{r.modelo_interes || '—'}</td>
                      <td style={{ ...s.td, fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{r.presupuesto_usd ? '$' + r.presupuesto_usd.toLocaleString() : '—'}</td>
                      <td style={s.td}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 4, background: (ETAPA_COLOR[r.etapa] || '#8A93A0') + '22', color: ETAPA_COLOR[r.etapa] || '#8A93A0' }}>
                          {ETAPA_LABEL[r.etapa] || r.etapa}
                        </span>
                      </td>
                      <td style={s.td}>
                        <a href={`/crm?lead=${r.id}`} style={s.verBtn}>Ver →</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Shell>
  )
}

function Kpi({ n, label, color }: { n: number | string; label: string; color?: string }) {
  return (
    <div style={s.kpi}>
      <div style={{ ...s.kpiNum, color: color || 'var(--text-primary)' }}>{n}</div>
      <div style={s.kpiLabel}>{label}</div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <CrmShell active="walk-ins" maxWidth={1200}>{children}</CrmShell>
}

const s: Record<string, React.CSSProperties> = {
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 12, flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  title: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  sub: { fontSize: 13, color: 'var(--text-muted)', marginTop: 6, maxWidth: 640 },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '40px 0', textAlign: 'center' },
  error: { background: 'rgba(229,85,106,0.12)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  controls: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 18 },
  chip: { padding: '6px 12px', borderRadius: 999, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  chipOn: { background: 'var(--accent-soft)', borderColor: 'var(--accent)', color: 'var(--accent)' },
  select: { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' },
  check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' },
  btnPrimary: { padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--accent-solid)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  btnGhost: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' },
  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' },
  kpiNum: { fontSize: 28, fontWeight: 800, lineHeight: 1, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  kpiLabel: { fontSize: 11, color: 'var(--text-muted)', marginTop: 6, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' },
  tableWrap: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' as const },
  th: { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-muted)', padding: '10px 14px', textAlign: 'left' as const, borderBottom: '1px solid var(--border)', textTransform: 'uppercase' as const },
  tr: { borderBottom: '1px solid var(--border)' },
  td: { padding: '12px 14px', verticalAlign: 'top' as const },
  verBtn: { fontSize: 13, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' as const },
}