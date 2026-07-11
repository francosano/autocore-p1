// TARGET: autocore-npa/app/crm/pendientes/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import { supabase } from '../../supabase'
import CrmShell from '../CrmShell'
import { useNPAPermissions } from '../../components/useNPAPermissions'

// Supervisor IA: rule-based "next best action" suggestions (Elliott cadence) with
// one-tap Crear recordatorio / Marcar perdido, plus the legacy conversation
// findings (crm_supervisor_findings via crm_mis_pendientes).

const FIND_TIPO: Record<string, string> = {
  pregunta_sin_responder: 'Pregunta sin responder',
  promesa_incumplida: 'Promesa incumplida',
  senal_compra_ignorada: 'Señal de compra ignorada',
  hilo_frio: 'Hilo frío',
  molestia_cliente: 'Cliente molesto',
  etapa_desfasada: 'Etapa desfasada',
}
const URG: Record<string, string> = { alta: 'var(--danger)', media: 'var(--warn)', baja: 'var(--text-muted)' }
const URG_LABEL: Record<string, string> = { alta: 'Alta', media: 'Media', baja: 'Baja' }

interface Sug {
  lead_id: string; lead_nombre: string; lead_telefono: string | null
  asignado_a: string | null; asignado_nombre: string | null
  tipo: 'seguimiento' | 'perdido'; urgencia: string; titulo: string; detalle: string | null
  suggested_tipo: string | null; suggested_remind_at: string | null
  heat_score: number; dias: number
}
interface Finding {
  id: string; lead_id: string | null; lead_nombre: string | null
  asesor: string; asesor_id: string | null
  tipo: string; detalle: string | null; accion: string | null
  urgencia: string; created_at: string
}

const hace = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (m < 60) return `hace ${m} min`
  if (m < 1440) return `hace ${Math.floor(m / 60)} h`
  return `hace ${Math.floor(m / 1440)} d`
}
const fmtWhen = (iso: string | null) => iso
  ? new Date(iso).toLocaleString('es-VE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  : 'ahora'

export default function CrmPendientesPage() {
  const { permissions, loading: permsLoading } = useNPAPermissions()
  const [sugs, setSugs] = useState<Sug[] | null>(null)
  const [finds, setFinds] = useState<Finding[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [me, setMe] = useState<{ id: string; nombre: string } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmLost, setConfirmLost] = useState<string | null>(null)
  const [filtro, setFiltro] = useState<string>('')
  const [recomputing, setRecomputing] = useState(false)
  // Active CRM team (asesores + BDC + supervisor) — source of truth for the
  // asesor filter and the +Tarea / Delegar a BDC assignee pickers.
  const [crmUsers, setCrmUsers] = useState<{ user_id: string; full_name: string; crm_role: string }[]>([])
  // Inline "+ Tarea" editor state (which finding, chosen assignee, título).
  const [taskFor, setTaskFor] = useState<string | null>(null)
  const [taskAsignado, setTaskAsignado] = useState<string>('')
  const [taskTitulo, setTaskTitulo] = useState<string>('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user
      if (u) setMe({ id: u.id, nombre: (u.user_metadata as any)?.full_name || u.email || 'Yo' })
    })
  }, [])

  // Full active CRM roster (same source as /crm main page) so the BDC always
  // appears in the filter and can be delegated to even without loaded findings.
  useEffect(() => {
    supabase.from('user_roles').select('user_id, full_name, crm_role')
      .eq('npa_can_view_crm', true).eq('is_active', true)
      .then(({ data }) => setCrmUsers(Array.isArray(data) ? (data as any).filter((u: any) => u.full_name) : []))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const [sRes, fRes] = await Promise.all([
        supabase.rpc('crm_reminder_suggestions', { p_all: showAll }),
        supabase.rpc('crm_mis_pendientes'),
      ])
      if (sRes.error) throw sRes.error
      setSugs(Array.isArray(sRes.data) ? sRes.data : [])
      setFinds(!fRes.error && Array.isArray(fRes.data) ? fRes.data : [])
    } catch (e: any) {
      setErr(e?.message || 'Error cargando pendientes')
    } finally {
      setLoading(false)
    }
  }, [showAll])

  useEffect(() => { if (!permsLoading && permissions.npa_can_view_crm) load() }, [permsLoading, permissions.npa_can_view_crm, load])

  const recompute = async (leadId: string) => {
    try { await supabase.rpc('crm_recompute_heat', { p_lead_id: leadId }) } catch { /* non-fatal */ }
  }

  const crearRecordatorio = async (g: Sug) => {
    if (!me) return
    setBusyId(g.lead_id)
    try {
      await supabase.from('crm_tareas').insert({
        lead_id: g.lead_id,
        asignado_a: g.asignado_a || me.id,
        asignado_nombre: g.asignado_nombre || null,
        titulo: g.titulo,
        tipo: g.suggested_tipo || 'seguimiento',
        remind_at: g.suggested_remind_at || new Date(Date.now() + 2 * 3600000).toISOString(),
        origen: 'supervisor', created_by: me.id,
      })
      await recompute(g.lead_id)
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo crear el recordatorio') } finally { setBusyId(null) }
  }

  const marcarPerdido = async (g: Sug) => {
    setBusyId(g.lead_id)
    try {
      await supabase.from('crm_leads').update({
        etapa: 'cerrado_perdido', motivo_perdido: g.titulo, updated_at: new Date().toISOString(),
      }).eq('id', g.lead_id)
      supabase.from('crm_stage_history').insert({
        lead_id: g.lead_id, to_etapa: 'cerrado_perdido', source: 'supervisor', changed_by: me?.id || null,
      }).then(() => {}, () => {})
      await recompute(g.lead_id)
      setConfirmLost(null)
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo marcar como perdido') } finally { setBusyId(null) }
  }

  // Resuelve el responsable por defecto de un hallazgo dentro del equipo CRM.
  const resolveAsesorId = (r: Finding): string => {
    if (r.asesor_id && crmUsers.some(u => u.user_id === r.asesor_id)) return r.asesor_id
    const byName = crmUsers.find(u => u.full_name === r.asesor)
    if (byName) return byName.user_id
    return r.asesor_id || me?.id || ''
  }

  // Abre el editor inline de "+ Tarea" con el asesor del hallazgo por defecto.
  const openTaskForm = (r: Finding) => {
    setTaskFor(r.id)
    setTaskAsignado(resolveAsesorId(r))
    setTaskTitulo(r.accion || FIND_TIPO[r.tipo] || r.tipo)
  }

  // Núcleo: convierte un hallazgo en una tarea para el responsable indicado.
  const insertTareaFromFinding = async (r: Finding, asignadoId: string, asignadoNombre: string | null, titulo: string) => {
    if (!me) return
    setBusyId('f' + r.id)
    try {
      await supabase.from('crm_tareas').insert({
        lead_id: r.lead_id || null,
        asignado_a: asignadoId || me.id,
        asignado_nombre: asignadoNombre,
        titulo: (titulo || '').trim() || FIND_TIPO[r.tipo] || r.tipo,
        tipo: 'seguimiento',
        remind_at: new Date(Date.now() + 2 * 3600000).toISOString(),
        origen: 'supervisor', created_by: me.id,
      })
      supabase.from('crm_supervisor_findings').update({
        estado: 'resolved', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', r.id).then(() => {}, () => {})
      if (r.lead_id) await recompute(r.lead_id)
      setTaskFor(null)
      await load()
    } catch (e: any) { setErr(e?.message || 'No se pudo crear la tarea') } finally { setBusyId(null) }
  }

  // Confirma el editor "+ Tarea": usa el asesor elegido en el picker.
  const submitTaskForm = (r: Finding) => {
    const u = crmUsers.find(x => x.user_id === taskAsignado)
    insertTareaFromFinding(r, taskAsignado || resolveAsesorId(r), u?.full_name || r.asesor || null, taskTitulo)
  }

  // Atajo: delega el hallazgo directamente a la BDC en un clic.
  const delegarBDC = (r: Finding, bdc: { user_id: string; full_name: string }) =>
    insertTareaFromFinding(r, bdc.user_id, bdc.full_name, r.accion || FIND_TIPO[r.tipo] || r.tipo)

  // Genera un reporte imprimible (Guardar como PDF) para reenviar al equipo.
  const descargarPDF = () => {
    const allSug = sugs || []
    const seg = allSug.filter(g => g.tipo === 'seguimiento')
    const lost = allSug.filter(g => g.tipo === 'perdido')
    const allFinds = finds || []
    const findList = filtro ? allFinds.filter(r => r.asesor === filtro) : allFinds
    const fecha = new Date().toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    const scope = showAll ? 'Equipo completo' : 'Mis pendientes'
    const esc = (t: any) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const section = (title: string, headers: string[], rows: string[]) => rows.length
      ? `<h2>${title} · ${rows.length}</h2><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
      : `<h2>${title}</h2><div class="empty">Sin elementos.</div>`
    const segRows = seg.map(g => `<tr><td><b>${esc(g.titulo)}</b></td><td>${esc(g.lead_nombre)}</td><td>${esc(g.asignado_nombre || '—')}</td><td>${esc(g.detalle || '')}</td></tr>`)
    const lostRows = lost.map(g => `<tr><td><b>${esc(g.titulo)}</b></td><td>${esc(g.lead_nombre)}</td><td>${esc(g.asignado_nombre || '—')}</td><td>${esc(g.detalle || '')}</td></tr>`)
    const findRows = findList.map(r => `<tr><td><b>${esc(FIND_TIPO[r.tipo] || r.tipo)}</b></td><td>${esc(r.lead_nombre || 'cliente')}</td><td>${esc(r.asesor || '—')}</td><td>${esc(r.accion || r.detalle || '')}</td></tr>`)
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Pendientes CRM - ${fecha}</title><style>
      body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1F2933;margin:32px;}
      .eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#5A6570;font-weight:700;}
      h1{font-size:22px;margin:2px 0 2px;} .sub{color:#163C7D;font-weight:600;margin:0 0 2px;font-size:13px;}
      .meta{color:#5A6570;font-size:12px;margin:0 0 8px;}
      h2{font-size:14px;color:#163C7D;border-bottom:1px solid #C7CDD8;padding-bottom:4px;margin:22px 0 8px;}
      table{width:100%;border-collapse:collapse;font-size:12px;} th,td{border:1px solid #D7DBE0;padding:6px 8px;text-align:left;vertical-align:top;}
      th{background:#E8ECF3;font-weight:700;} .empty{color:#5A6570;font-size:12px;font-style:italic;}
      .foot{margin-top:26px;color:#5A6570;font-size:11px;font-style:italic;border-top:1px solid #D7DBE0;padding-top:8px;}
      @media print{body{margin:0;} @page{size:A4;margin:14mm;}}
    </style></head><body>
      <div class="eyebrow">AUTOCORE P1 · PRIME ONE AUTO SALES</div>
      <h1>Pendientes del CRM</h1>
      <div class="sub">${esc(scope)}${filtro ? ' · ' + esc(filtro) : ''}</div>
      <div class="meta">Generado el ${fecha}</div>
      ${section('Seguimientos sugeridos', ['Acción sugerida', 'Cliente', 'Asesor', 'Detalle'], segRows)}
      ${section('Candidatos a marcar perdido', ['Motivo', 'Cliente', 'Asesor', 'Detalle'], lostRows)}
      ${section('Alertas de conversación', ['Alerta', 'Cliente', 'Asesor', 'Acción'], findRows)}
      <div class="foot">Reporte generado por AutoCore P1 para el equipo de Prime One Auto Sales.</div>
    </body></html>`
    const w = window.open('', '_blank')
    if (!w) { setErr('Permite ventanas emergentes para descargar el PDF.'); return }
    w.document.open(); w.document.write(html); w.document.close(); w.focus()
    setTimeout(() => { try { w.print() } catch (_) { /* no-op */ } }, 400)
  }

  // Recalcula la temperatura de TODOS los leads activos desde sus actividades.
  const reanalizar = async () => {
    setRecomputing(true); setErr(null)
    try { await supabase.rpc('crm_recompute_all_heat'); await load() }
    catch (e: any) { setErr(e?.message || 'No se pudo re-analizar la temperatura') }
    finally { setRecomputing(false) }
  }

  if (permsLoading) return <Shell><div style={s.muted}>Cargando…</div></Shell>
  if (!permissions.npa_can_view_crm) return <Shell><div style={s.muted}>No tienes acceso al CRM.</div></Shell>

  const allSug = sugs || []
  const seg = allSug.filter(g => g.tipo === 'seguimiento')
  const lost = allSug.filter(g => g.tipo === 'perdido')

  const allFinds = finds || []
  // Filter options = every active CRM member (so the BDC is always selectable),
  // plus any asesor present in loaded findings that isn't on the roster.
  const asesorOpts = Array.from(new Set(
    [...crmUsers.map(u => u.full_name), ...allFinds.map(r => r.asesor)].filter(Boolean)
  )).sort()
  const manyAsesores = new Set(allFinds.map(r => r.asesor)).size > 1
  const bdc = crmUsers.find(u => u.crm_role === 'bdc') || null
  const findList = filtro ? allFinds.filter(r => r.asesor === filtro) : allFinds

  return (
    <Shell>
      <div style={s.headRow}>
        <div>
          <div style={s.eyebrow}>CRM · Supervisor IA</div>
          <h1 style={s.title}>{showAll ? 'Pendientes del equipo' : 'Mis pendientes'}</h1>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {permissions.npa_can_admin && (
            <button style={showAll ? s.btnActive : s.btnGhost} onClick={() => setShowAll(v => !v)}>
              {showAll ? 'Solo las mías' : 'Todo el equipo'}
            </button>
          )}
          {permissions.npa_can_admin && (
            <button style={s.btnGhost} onClick={reanalizar} disabled={recomputing}>
              {recomputing ? 'Analizando…' : 'Re-analizar temperatura'}
            </button>
          )}
          <button style={s.btnGhost} onClick={descargarPDF}>Descargar PDF</button>
          <a href="/crm/tareas" style={s.btnGhost}>Mis tareas →</a>
          <button style={s.btnGhost} onClick={load} disabled={loading}>{loading ? '…' : '↻'}</button>
        </div>
      </div>

      {err && <div style={s.error}>{err}</div>}
      {loading && !sugs && <div style={s.muted}>Analizando leads…</div>}

      <div style={s.kpiRow}>
        <Kpi n={seg.length} label="Seguimientos sugeridos" color={seg.length ? 'var(--warn)' : 'var(--ok)'} />
        <Kpi n={lost.length} label="Candidatos a perdido" color={lost.length ? 'var(--danger)' : 'var(--text-primary)'} />
        <Kpi n={findList.length} label="Alertas de conversación" color={findList.length ? 'var(--text-primary)' : 'var(--ok)'} />
      </div>

      {/* ── SEGUIMIENTOS SUGERIDOS ─────────────────────────────────── */}
      {seg.length > 0 && <div style={s.sectionHead}>Seguimientos sugeridos · {seg.length}</div>}
      {seg.map(g => (
        <div key={'s' + g.lead_id} style={s.card}>
          <span style={{ flex: '0 0 10px', width: 10, height: 10, borderRadius: 10, marginTop: 6, background: URG[g.urgencia] || 'var(--warn)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14 }}>
              <b style={{ color: URG[g.urgencia] || 'var(--warn)' }}>{g.titulo}</b>
              <span style={{ color: 'var(--text-primary)' }}> · {g.lead_nombre}</span>
              {showAll && g.asignado_nombre && <span style={{ color: 'var(--text-muted)' }}> · {g.asignado_nombre}</span>}
            </div>
            {g.detalle && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{g.detalle}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
              Heat {g.heat_score} · {g.dias >= 999 ? 'sin contacto' : `hace ${g.dias}d`} · recordatorio: {fmtWhen(g.suggested_remind_at)}
            </div>
          </div>
          <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            <button style={s.doBtn} disabled={busyId === g.lead_id} onClick={() => crearRecordatorio(g)}>
              {busyId === g.lead_id ? '…' : '+ Recordatorio'}
            </button>
            <a href={`/crm?lead=${g.lead_id}`} style={s.verBtn}>Ver lead →</a>
          </div>
        </div>
      ))}

      {/* ── CANDIDATOS A PERDIDO ───────────────────────────────────── */}
      {lost.length > 0 && <div style={{ ...s.sectionHead, marginTop: 20 }}>Candidatos a marcar perdido · {lost.length}</div>}
      {lost.map(g => (
        <div key={'l' + g.lead_id} style={s.card}>
          <span style={{ flex: '0 0 10px', width: 10, height: 10, borderRadius: 10, marginTop: 6, background: 'var(--danger)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14 }}>
              <b style={{ color: 'var(--danger)' }}>{g.titulo}</b>
              <span style={{ color: 'var(--text-primary)' }}> · {g.lead_nombre}</span>
              {showAll && g.asignado_nombre && <span style={{ color: 'var(--text-muted)' }}> · {g.asignado_nombre}</span>}
            </div>
            {g.detalle && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{g.detalle}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>Heat {g.heat_score} · hace {g.dias}d sin contacto efectivo</div>
          </div>
          <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            {permissions.npa_can_mark_lost ? (
              confirmLost === g.lead_id ? (
                <div style={{ display: 'flex', gap: 5 }}>
                  <button style={s.lostBtn} disabled={busyId === g.lead_id} onClick={() => marcarPerdido(g)}>
                    {busyId === g.lead_id ? '…' : 'Confirmar'}
                  </button>
                  <button style={s.miniBtn} onClick={() => setConfirmLost(null)}>Cancelar</button>
                </div>
              ) : (
                <button style={s.lostBtnGhost} onClick={() => setConfirmLost(g.lead_id)}>Marcar perdido</button>
              )
            ) : (
              <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Solo supervisor</span>
            )}
            <a href={`/crm?lead=${g.lead_id}`} style={s.verBtn}>Ver lead →</a>
          </div>
        </div>
      ))}

      {sugs && seg.length === 0 && lost.length === 0 && (
        <div style={s.emptyCard}>
          <div style={{ fontSize: 15, color: 'var(--ok)', fontWeight: 700 }}>Sin sugerencias — todo al día ✓</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>No hay leads que requieran un próximo toque ni candidatos a cerrar ahora mismo.</div>
        </div>
      )}

      {/* ── ALERTAS DE CONVERSACIÓN (findings) ─────────────────────── */}
      {allFinds.length > 0 && (
        <>
          <div style={{ ...s.sectionHead, marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Alertas de conversación · {findList.length}</span>
            {asesorOpts.length > 1 && (
              <select value={filtro} onChange={e => setFiltro(e.target.value)} style={s.dateInput}>
                <option value="">Todos los asesores</option>
                {asesorOpts.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            )}
          </div>
          {findList.map(r => (
            <div key={r.id} style={s.card}>
              <span style={{ flex: '0 0 10px', width: 10, height: 10, borderRadius: 10, marginTop: 6, background: URG[r.urgencia] || 'var(--text-muted)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14 }}>
                  <b style={{ color: URG[r.urgencia] || 'var(--text-primary)' }}>{FIND_TIPO[r.tipo] || r.tipo}</b>
                  <span style={{ color: 'var(--text-primary)' }}> · {r.lead_nombre || 'cliente'}</span>
                  {manyAsesores && <span style={{ color: 'var(--text-muted)' }}> · {r.asesor}</span>}
                </div>
                {r.detalle && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 3 }}>{r.detalle}</div>}
                {r.accion && <div style={{ fontSize: 13, color: 'var(--ok)', marginTop: 3 }}>→ {r.accion}</div>}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>{URG_LABEL[r.urgencia] || r.urgencia} · {hace(r.created_at)}</div>
              </div>
              {taskFor === r.id ? (
                <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6, width: 230 }}>
                  <input
                    value={taskTitulo}
                    onChange={e => setTaskTitulo(e.target.value)}
                    placeholder="Título de la tarea"
                    style={s.taskInput}
                  />
                  <select value={taskAsignado} onChange={e => setTaskAsignado(e.target.value)} style={s.taskInput}>
                    {!crmUsers.some(u => u.user_id === taskAsignado) && taskAsignado && (
                      <option value={taskAsignado}>{r.asesor || 'Asesor del hallazgo'}</option>
                    )}
                    {crmUsers.map(u => (
                      <option key={u.user_id} value={u.user_id}>
                        {u.full_name}{u.crm_role === 'bdc' ? ' · BDC' : ''}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end' }}>
                    <button style={s.doBtn} disabled={busyId === 'f' + r.id} onClick={() => submitTaskForm(r)}>
                      {busyId === 'f' + r.id ? '…' : 'Crear tarea'}
                    </button>
                    <button style={s.miniBtn} onClick={() => setTaskFor(null)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                  <button style={s.doBtn} disabled={busyId === 'f' + r.id} onClick={() => openTaskForm(r)}>
                    {busyId === 'f' + r.id ? '…' : '+ Tarea'}
                  </button>
                  {bdc && bdc.user_id !== r.asesor_id && (
                    <button style={s.bdcBtn} disabled={busyId === 'f' + r.id} onClick={() => delegarBDC(r, bdc)}>
                      Delegar a BDC
                    </button>
                  )}
                  {r.lead_id && <a href={`/crm?lead=${r.lead_id}`} style={s.verBtn}>Ver →</a>}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </Shell>
  )
}

function Kpi({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={s.kpi}>
      <div style={{ ...s.kpiNum, color }}>{n}</div>
      <div style={s.kpiLabel}>{label}</div>
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return <CrmShell active="pendientes" maxWidth={1100}>{children}</CrmShell>
}

const s: Record<string, React.CSSProperties> = {
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 18, gap: 12, flexWrap: 'wrap' },
  eyebrow: { fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' },
  title: { fontSize: 26, fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0 0', fontFamily: 'var(--font-inter), Inter, sans-serif' },
  muted: { color: 'var(--text-muted)', fontSize: 14, padding: '40px 0', textAlign: 'center' },
  error: { background: 'rgba(229,85,106,0.12)', border: '1px solid var(--danger)', color: 'var(--danger)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 },
  btnGhost: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none' },
  btnActive: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' },
  dateInput: { padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit' },
  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 18 },
  kpi: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px' },
  kpiNum: { fontSize: 30, fontWeight: 800, lineHeight: 1, fontFamily: 'var(--font-inter), Inter, sans-serif' },
  kpiLabel: { fontSize: 12, color: 'var(--text-muted)', marginTop: 6, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' },
  sectionHead: { fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px 2px' },
  card: { display: 'flex', gap: 12, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', marginBottom: 10, alignItems: 'flex-start', flexWrap: 'wrap' },
  emptyCard: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', marginBottom: 16 },
  doBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  bdcBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid #3B82F6', background: 'transparent', color: '#3B82F6', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  taskInput: { width: '100%', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit', boxSizing: 'border-box' },
  lostBtnGhost: { padding: '6px 12px', borderRadius: 8, border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  lostBtn: { padding: '6px 12px', borderRadius: 8, border: 'none', background: 'var(--danger)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  miniBtn: { padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  verBtn: { flex: '0 0 auto', fontSize: 12, fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', whiteSpace: 'nowrap' },
}