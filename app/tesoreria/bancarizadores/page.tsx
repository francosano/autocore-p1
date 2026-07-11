// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/bancarizadores/page.tsx
// v1 (2026-05-26) — Bancarizadores hub.
//
// Lists every bancarizador with running saldo. Click → detail page with
// full movement history.
//
// Saldo convention:
//   > 0  → bancarizador nos debe (he hasn't deposited all the cash he received)
//   < 0  → le debemos (he deposited more than we gave him in cash)
//   = 0  → squared up
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, Plus, ChevronRight } from 'lucide-react'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import AdminShell from '../../components/AdminShell'
import {
  type Bancarizador, loadBancarizadores, fmtUSDsigned,
} from '../../lib/bancarizaciones'
import { supabase } from '../../supabase'

const NAVY = '#0D2257'
const GOLD = '#C49A2A'
const RED  = '#BB162B'
const GRN  = '#16A34A'
const MUTED = '#71717A'

export default function BancarizadoresHub() {
  const router = useRouter()
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_pickup ||
    p.tesoreria_admin ||
    p.npa_can_admin
  )

  const [list, setList] = useState<Bancarizador[]>([])
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newContacto, setNewContacto] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const reload = () => loadBancarizadores().then(setList).finally(() => setLoading(false))

  useEffect(() => {
    if (gate.status === 'denied') router.replace('/tesoreria/home')
  }, [gate.status, router])

  useEffect(() => {
    if (gate.status !== 'ok') return
    setLoading(true)
    reload()
  }, [gate.status])

  const filtered = list
    .filter(b => showInactive || b.activo)
    .filter(b => !search.trim() || b.nombre.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => {
      // Active first, then those with non-zero balance, then alphabetical
      if (a.activo !== b.activo) return a.activo ? -1 : 1
      const aHas = a.saldo_usd !== 0 ? 1 : 0
      const bHas = b.saldo_usd !== 0 ? 1 : 0
      if (aHas !== bHas) return bHas - aHas
      return a.nombre.localeCompare(b.nombre)
    })

  const totals = filtered.reduce((acc, b) => {
    if (b.saldo_usd > 0) acc.theyOweUs += b.saldo_usd
    else if (b.saldo_usd < 0) acc.weOweThem += -b.saldo_usd
    return acc
  }, { theyOweUs: 0, weOweThem: 0 })

  const handleCreate = async () => {
    if (!newName.trim()) { setErr('Nombre requerido'); return }
    setErr(null)
    // Generate a slug-style id from name
    const slug = 'BANC_' + newName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30)
    const { error } = await supabase.from('bancarizadores').insert({
      id: slug, nombre: newName.trim(), contacto: newContacto.trim() || null, activo: true,
    })
    if (error) { setErr(error.message); return }
    setCreating(false); setNewName(''); setNewContacto('')
    reload()
  }

  if (gate.status === 'loading') return <AdminShell active="tesoreria"><div style={{ padding: 60, textAlign: 'center', color: MUTED }}>Cargando…</div></AdminShell>
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status !== 'ok') return null

  return (
    <AdminShell active="tesoreria">
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px 80px' }}>
        <button onClick={() => router.push('/tesoreria/home')}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: NAVY, fontSize: 13, cursor: 'pointer', marginBottom: 16 }}>
          <ChevronLeft size={16} /> Volver al Dashboard
        </button>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700 }}>Tesorería</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: NAVY }}>Bancarizadores</div>
          <div style={{ fontSize: 13, color: '#52525B', marginTop: 4 }}>Cuenta corriente con cada bancarizador · histórico de cash y wires</div>
        </div>

        {/* Totals */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
          <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderLeft: '4px solid ' + GRN, borderRadius: 6, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>Nos deben</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: GRN, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>${totals.theyOweUs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderLeft: '4px solid ' + RED, borderRadius: 6, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>Les debemos</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: RED, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>${totals.weOweThem.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        </div>

        {/* Toolbar */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar bancarizador…"
            style={{ flex: 1, minWidth: 200, padding: '8px 12px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13, fontFamily: 'inherit', background: '#fff' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#52525B', cursor: 'pointer' }}>
            <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
            Mostrar inactivos
          </label>
          <button onClick={() => setCreating(true)}
            style={{ padding: '8px 14px', borderRadius: 6, background: NAVY, color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> Nuevo
          </button>
        </div>

        {/* List */}
        <div style={{ background: '#fff', border: '1px solid #E5E2D8', borderRadius: 8, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: MUTED }}>Cargando…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: MUTED, fontSize: 13 }}>Sin bancarizadores</div>
          ) : filtered.map((b, i) => (
            <div key={b.id} onClick={() => router.push('/tesoreria/bancarizadores/detail?id=' + b.id)}
              style={{
                padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                borderTop: i === 0 ? 'none' : '1px solid #E5E2D8', cursor: 'pointer', transition: 'background 0.1s',
                opacity: b.activo ? 1 : 0.55,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#F9F7F0' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: NAVY }}>{b.nombre}</div>
                {b.contacto && <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{b.contacto}</div>}
                {!b.activo && <div style={{ fontSize: 10, color: MUTED, marginTop: 2, fontStyle: 'italic' }}>Inactivo</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: b.saldo_usd > 0 ? GRN : b.saldo_usd < 0 ? RED : MUTED, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUSDsigned(b.saldo_usd)}
                  </div>
                  <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>
                    {b.saldo_usd > 0 ? 'nos debe' : b.saldo_usd < 0 ? 'le debemos' : 'en cero'}
                  </div>
                </div>
                <ChevronRight size={18} color={MUTED} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create modal */}
      {creating && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setCreating(false) }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 24, width: '100%', maxWidth: 420 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: NAVY, marginBottom: 16 }}>Nuevo bancarizador</div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Nombre *</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} autoFocus
                style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: MUTED, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>Contacto (opcional)</div>
              <input value={newContacto} onChange={e => setNewContacto(e.target.value)} placeholder="Teléfono / email"
                style={{ width: '100%', padding: '9px 12px', borderRadius: 6, border: '1px solid #D1D5DB', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }} />
            </div>
            {err && <div style={{ padding: 8, background: '#FEE2E2', color: '#991B1B', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => { setCreating(false); setErr(null); setNewName(''); setNewContacto('') }}
                style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #D1D5DB', background: 'transparent', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>
                Cancelar
              </button>
              <button onClick={handleCreate}
                style={{ padding: '8px 18px', borderRadius: 6, background: NAVY, color: '#fff', border: 'none', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                Crear
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminShell>
  )
}