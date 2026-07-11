// TARGET: autocore-npa/app/crm/dashboard/page.tsx
'use client'
// ═══════════════════════════════════════════════════════════════════════════
// CRM — Dashboard (landing page del módulo, DealerCenter-style)
//
// Página de entrada del CRM: KPIs + métricas gerenciales (crm_dashboard_stats,
// la RPC devuelve error='forbidden' para asesores → se ocultan esas secciones),
// pendientes del Supervisor IA (crm_mis_pendientes, visible para todos) y
// accesos rápidos a las secciones del módulo.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'
import { fuenteLabel } from '../fuentes'

const ACCENT = '#1B6EC2'
const GREEN = '#188A55'
const RED = '#C0392B'
const AMBER = '#B8720A'

const ETAPA_LABEL: Record<string, string> = {
  nuevo: 'Nuevo', contactado: 'Contactado', cita_agendada: 'Cita agendada',
  visita_showroom: 'Visita showroom', oferta_presentada: 'Oferta presentada',
  financiamiento: 'Financiamiento', cerrado_ganado: 'Cerrado ganado',
}
const SRC_COLORS = ['#5A8DEE', '#2FBF8F', '#E0A23C', '#E5689A', '#9B7DF0', '#8A93A0']

type Stats = {
  totals?: { leads: number; ganados: number; perdidos: number; activos: number }
  sources?: { fuente: string; leads: number; ganados: number; perdidos: number; conv_pct: number }[]
  funnel?: { stage: string; label: string; reached: number }[]
  execs?: { nombre: string; leads: number; ganados: number; activos: number; conv_pct: number }[]
  velocity?: { stage: string; leads: number; avg_days: number }[]
  error?: string
}

// ── corporate tokens ──────────────────────────────────────────────────────────
const s: Record<string, any> = {
  panel: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '16px', overflow: 'hidden' },
  panelHead: { padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-deep)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' },
  panelTitle: { fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' as const, letterSpacing: '1.2px' },
  panelBody: { padding: '14px 16px' },
  btnGhost: { padding: '7px 14px', borderRadius: '4px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
  barRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '6px 0' },
  barLabel: { width: '96px', flexShrink: 0, fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const },
  barTrack: { flex: 1, height: '18px', background: 'var(--bg-deep)', borderRadius: '3px', overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: '3px', minWidth: '2px', transition: 'width 0.3s' },
  barMeta: { width: '118px', flexShrink: 0, textAlign: 'right' as const, display: 'flex', flexDirection: 'column' as const, gap: '1px' },
  barNum: { fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' as const },
  barSub: { fontSize: '10.5px', color: 'var(--text-muted)' },
}

function Kpi({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderLeft: `3px solid ${color}`, borderRadius: '6px', padding: '14px 16px' }}>
      <div style={{ fontSize: '26px', fontWeight: 800, lineHeight: 1, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{(value ?? 0).toLocaleString()}</div>
      <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '6px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase' }}>{label}</div>
    </div>
  )
}

// ── Pendientes del Supervisor IA (crm_mis_pendientes) ────────────────────────
function MisPendientes() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<string>('')
  useEffect(() => {
    let alive = true
    supabase.rpc('crm_mis_pendientes').then(({ data, error }: any) => {
      if (!alive) return
      if (error) setErr(error.message); else setRows(Array.isArray(data) ? data : [])
    })
    return () => { alive = false }
  }, [])

  const TIPO: Record<string, string> = {
    pregunta_sin_responder: 'Pregunta sin responder',
    promesa_incumplida: 'Promesa incumplida',
    senal_compra_ignorada: 'Señal de compra ignorada',
    hilo_frio: 'Hilo frío',
    molestia_cliente: 'Cliente molesto',
    etapa_desfasada: 'Etapa desfasada',
  }
  const URG: Record<string, string> = { alta: RED, media: AMBER, baja: '#5b6573' }

  const hace = (iso: string) => {
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
    if (m < 60) return `hace ${m} min`
    if (m < 1440) return `hace ${Math.floor(m / 60)} h`
    return `hace ${Math.floor(m / 1440)} d`
  }

  const all = rows || []
  const asesores = Array.from(new Set(all.map(r => r.asesor))).sort()
  const manyAsesores = asesores.length > 1
  const list = filtro ? all.filter(r => r.asesor === filtro) : all

  return (
    <section style={s.panel}>
      <div style={s.panelHead}>
        <div style={s.panelTitle}>
          Supervisor IA — {manyAsesores ? 'Pendientes del equipo' : 'Mis pendientes'}
          {all.length > 0 && <span style={{ marginLeft: '6px', color: 'var(--text-muted)', letterSpacing: 0 }}>({list.length})</span>}
        </div>
        {manyAsesores && (
          <select value={filtro} onChange={e => setFiltro(e.target.value)}
            style={{ fontSize: '12px', padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none' }}>
            <option value="">Todos los asesores</option>
            {asesores.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
      </div>
      <div style={{ padding: '4px 16px 10px' }}>
        {err && <div style={{ fontSize: '12px', color: RED, padding: '10px 0' }}>{err}</div>}
        {!rows && !err && <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px 0' }}>Cargando...</div>}
        {rows && list.length === 0 && <div style={{ fontSize: '13px', color: GREEN, fontWeight: 600, padding: '10px 0' }}>Todo al día — sin pendientes</div>}
        {list.map((r: any) => (
          <div key={r.id} style={{ display: 'flex', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ flex: '0 0 8px', width: '8px', height: '8px', borderRadius: '8px', marginTop: '5px', background: URG[r.urgencia] || '#5b6573' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12.5px' }}>
                <b style={{ color: URG[r.urgencia] || 'var(--text-primary)' }}>{TIPO[r.tipo] || r.tipo}</b>
                <span style={{ color: 'var(--text-primary)' }}> · {r.lead_nombre || 'cliente'}</span>
                {manyAsesores && <span style={{ color: 'var(--text-muted)' }}> · {r.asesor}</span>}
              </div>
              {r.detalle && <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>{r.detalle}</div>}
              {r.accion && <div style={{ fontSize: '11.5px', color: GREEN, marginTop: '2px' }}>Acción: {r.accion}</div>}
              <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '3px' }}>{hace(r.created_at)}</div>
            </div>
            {r.lead_id && (
              <a href={`/crm?lead=${r.lead_id}`} style={{ flex: '0 0 auto', alignSelf: 'center', fontSize: '12px', fontWeight: 600, color: ACCENT, textDecoration: 'none', whiteSpace: 'nowrap' }}>Ver</a>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Accesos rápidos ───────────────────────────────────────────────────────────
const QUICK_LINKS = [
  { label: 'Pipeline',   desc: 'Tablero de leads por etapa',      path: '/crm' },
  { label: 'Tareas',     desc: 'Seguimientos y llamadas de hoy',  path: '/crm/tareas' },
  { label: 'Calendario', desc: 'Citas y visitas agendadas',       path: '/crm/calendario' },
  { label: 'Chats',      desc: 'Conversaciones de WhatsApp',      path: '/crm/chats' },
  { label: 'Recepción',  desc: 'Registrar visita walk-in',        path: '/crm/recepcion' },
  { label: 'Reportes',   desc: 'Métricas y desempeño',            path: '/crm/reportes' },
]

function AccesosRapidos() {
  return (
    <section style={s.panel}>
      <div style={s.panelHead}><div style={s.panelTitle}>Accesos rápidos</div></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', padding: '12px 16px 16px' }}>
        {QUICK_LINKS.map(q => (
          <button
            key={q.path}
            onClick={() => { window.location.href = q.path }}
            style={{ textAlign: 'left', padding: '10px 12px', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '4px', cursor: 'pointer' }}
          >
            <div style={{ fontSize: '12.5px', fontWeight: 700, color: ACCENT }}>{q.label}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.4 }}>{q.desc}</div>
          </button>
        ))}
      </div>
    </section>
  )
}

// ── PAGE ──────────────────────────────────────────────────────────────────────
export default function CrmDashboardPage() {
  const { permissions, ready } = useNPAPermissions()
  const [data, setData] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const { data: res, error } = await supabase.rpc('crm_dashboard_stats')
      if (error) throw new Error(error.message)
      setData((res || {}) as Stats)
    } catch (e: any) {
      setErr(e?.message || 'No se pudieron cargar las métricas.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (ready && permissions.npa_can_view_crm) load() }, [ready, permissions.npa_can_view_crm, load])

  if (!ready) return <CrmShell active="dashboard"><div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '40px 0', textAlign: 'center' }}>Cargando...</div></CrmShell>
  if (!permissions.npa_can_view_crm) return <CrmShell active="dashboard"><div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '40px 0', textAlign: 'center' }}>No tienes acceso al CRM.</div></CrmShell>

  const fLabel = (k: string) => fuenteLabel(k)
  const eLabel = (k: string) => ETAPA_LABEL[k] || k

  // La RPC gerencial devuelve error='forbidden' para asesores — no es un error
  // de la página: simplemente se ocultan las secciones gerenciales.
  const gerencial = !!data && data.error !== 'forbidden'
  const t = gerencial ? data?.totals : undefined
  const sources = (gerencial && data?.sources) || []
  const funnel = (gerencial && data?.funnel) || []
  const execs = (gerencial && data?.execs) || []
  const velocity = (gerencial && data?.velocity) || []
  const maxSrc = Math.max(1, ...sources.map(x => x.leads))
  const funnelTop = Math.max(1, ...funnel.map(x => x.reached))
  const maxVel = Math.max(1, ...velocity.map(x => x.avg_days || 0))

  return (
    <CrmShell active="dashboard" maxWidth={1200}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '16px', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
            CRM <span style={{ margin: '0 4px' }}>/</span> <span style={{ color: 'var(--text-secondary)' }}>Dashboard</span>
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>Dashboard CRM</div>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button style={s.btnGhost} onClick={load} disabled={loading}>{loading ? 'Actualizando...' : 'Actualizar'}</button>
          <button
            style={{ padding: '7px 14px', borderRadius: '4px', border: 'none', background: ACCENT, color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
            onClick={() => { window.location.href = '/crm' }}
          >Ir al Pipeline</button>
        </div>
      </div>

      {err && <div style={{ background: `${RED}14`, border: `1px solid ${RED}66`, color: RED, borderRadius: '4px', padding: '10px 14px', fontSize: '12.5px', marginBottom: '16px' }}>{err}</div>}

      {/* KPIs (gerencial) */}
      {t && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginBottom: '16px' }}>
          <Kpi label="Leads totales" value={t.leads} color={ACCENT} />
          <Kpi label="Activos" value={t.activos} color="#5A8DEE" />
          <Kpi label="Ganados" value={t.ganados} color={GREEN} />
          <Kpi label="Perdidos" value={t.perdidos} color={RED} />
        </div>
      )}

      {/* two-column: métricas | pendientes + accesos */}
      <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 560px', minWidth: 0 }}>
          {loading && !data && <div style={{ ...s.panel, padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Cargando métricas...</div>}

          {sources.length > 0 && (
            <section style={s.panel}>
              <div style={s.panelHead}><div style={s.panelTitle}>Fuentes — qué está funcionando</div></div>
              <div style={s.panelBody}>
                {sources.map((x, i) => (
                  <div key={x.fuente} style={s.barRow}>
                    <div style={s.barLabel}>{fLabel(x.fuente)}</div>
                    <div style={s.barTrack}>
                      <div style={{ ...s.barFill, width: `${Math.round(100 * x.leads / maxSrc)}%`, background: SRC_COLORS[i % SRC_COLORS.length] }} />
                    </div>
                    <div style={s.barMeta}>
                      <span style={s.barNum}>{x.leads.toLocaleString()}</span>
                      <span style={s.barSub}>{x.ganados} ganados · {x.conv_pct}% conv.</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {funnel.length > 0 && (
            <section style={s.panel}>
              <div style={s.panelHead}><div style={s.panelTitle}>Embudo de conversión</div></div>
              <div style={s.panelBody}>
                {funnel.map((x, i) => {
                  const prev = i > 0 ? funnel[i - 1].reached : x.reached
                  const drop = prev > 0 ? Math.round(100 * (prev - x.reached) / prev) : 0
                  return (
                    <div key={x.stage} style={s.barRow}>
                      <div style={s.barLabel}>{eLabel(x.stage)}</div>
                      <div style={s.barTrack}>
                        <div style={{ ...s.barFill, width: `${Math.round(100 * x.reached / funnelTop)}%`, background: '#5A8DEE' }} />
                      </div>
                      <div style={s.barMeta}>
                        <span style={s.barNum}>{x.reached.toLocaleString()}</span>
                        {i > 0 && <span style={{ ...s.barSub, color: drop > 50 ? RED : 'var(--text-muted)' }}>-{drop}% vs. anterior</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {execs.length > 0 && (
            <section style={s.panel}>
              <div style={s.panelHead}><div style={s.panelTitle}>Ranking de ejecutivos</div></div>
              <div style={{ padding: '4px 16px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', padding: '8px 0 6px', borderBottom: '2px solid var(--border)', fontSize: '10px', fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                  <span style={{ flex: 2 }}>Ejecutivo</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Leads</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Activos</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Ganados</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Conv.</span>
                </div>
                {execs.map((x, i) => (
                  <div key={x.nombre} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                    <span style={{ flex: 2, fontWeight: 600, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {i < 3 && x.nombre !== 'Sin asignar' && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '18px', height: '18px', borderRadius: '3px', fontSize: '10px', fontWeight: 800, background: `${ACCENT}1A`, color: ACCENT, border: `1px solid ${ACCENT}40` }}>{i + 1}</span>
                      )}
                      {x.nombre}
                    </span>
                    <span style={{ flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{x.leads.toLocaleString()}</span>
                    <span style={{ flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{x.activos}</span>
                    <span style={{ flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: GREEN, fontWeight: 700 }}>{x.ganados}</span>
                    <span style={{ flex: 1, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{x.conv_pct}%</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {velocity.length > 0 && (
            <section style={s.panel}>
              <div style={s.panelHead}><div style={s.panelTitle}>Velocidad — días promedio por etapa</div></div>
              <div style={s.panelBody}>
                {velocity.map((x) => (
                  <div key={x.stage} style={s.barRow}>
                    <div style={s.barLabel}>{eLabel(x.stage)}</div>
                    <div style={s.barTrack}>
                      <div style={{ ...s.barFill, width: `${Math.round(100 * (x.avg_days || 0) / maxVel)}%`, background: (x.avg_days || 0) > 14 ? RED : AMBER }} />
                    </div>
                    <div style={s.barMeta}>
                      <span style={s.barNum}>{x.avg_days ?? 0} d</span>
                      <span style={s.barSub}>{x.leads.toLocaleString()} leads</span>
                    </div>
                  </div>
                ))}
                <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '10px', fontStyle: 'italic' }}>
                  Aproximado: días desde la última actualización del lead en su etapa actual.
                </div>
              </div>
            </section>
          )}
        </div>

        <div style={{ flex: '1 1 340px', minWidth: '300px', maxWidth: '440px' }}>
          <MisPendientes />
          <AccesosRapidos />
        </div>
      </div>
    </CrmShell>
  )
}
