// TARGET: autocore-npa/app/components/NavBar.tsx

// ═══════════════════════════════════════════════════════════════════════════

// TARGET: autocore-npa/app/components/NavBar.tsx

// v6 (2026-05-13) — Phase 3 isolation:

//   - Tesorería-only users (no admin/audit/inventory/cobranza perms but has

//     any tesoreria_* flag) get NO global nav at all. They live in /tesoreria/*.

//   - Cobranza link REMOVED entirely from the global nav. Portal access lives

//     in the admin's Cobranza tile on /dashboard, gated by npa_can_admin.

//   - All other behavior unchanged from v5.

//

// History:

// v5 — Admin dropdown, Tesorería + Caja Chica + Banco moved inside,

//      Cobranza was external link to Portal (opens in new tab).

// ═══════════════════════════════════════════════════════════════════════════

'use client'

import { useRouter, usePathname } from 'next/navigation'

import { useEffect, useState, useRef, useCallback } from 'react'

import { supabase } from '../supabase'

import { useNPAPermissions } from './useNPAPermissions'

import RatesBanner from './RatesBanner'



// ────────────────────────────────────────────────────────────────────────────

// Global Search Overlay (unchanged from v4 — kept verbatim)

// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────

// Global Search v2 (2026-05-15) — multi-entity, role + location aware

//

// Searches 6 entity types in parallel:

//   • deals                         — sale negotiations

//   • crm_leads                     — sales pipeline

//   • cobranza_contratos            — loan portfolio

//   • inventory_units               — vehicle stock (VIN/placa)

//   • compromisos_inicial_diferida  — deferred initial payments

//   • bank_transactions             — bank statement reconciliation lookup

//

// Click routing:

//   • Deals: respects current location first (/admin vs /auditoria),

//     then falls back to role: admin → /admin, else → /auditoria

//   • Cobranza: NPA stays in /cobranza; external link to Portal in side button

//   • Inventory: /inventario?vin=XXX

//   • Bank: /banco?tx=ID

//   • Compromiso: /inicial-diferida?id=ID

//   • Lead: /crm?search_lead=ID

//

// Recent searches: last 5 queries stored in localStorage. Shown when search

// opens empty.

// ────────────────────────────────────────────────────────────────────────────

interface DealResult {

  id: string

  type: 'deal'

  negocio_num: string

  cliente_nombre: string

  cliente_apellidos?: string

  cliente_rif?: string

  vendedor?: string

  banco?: string

  resultado_tipo?: string

  status?: string

  fecha_entrega?: string

}

interface LeadResult {

  id: string

  type: 'lead'

  nombre: string

  apellidos: string

  telefono: string

  email?: string

  modelo_interes?: string

  etapa: string

  heat_score: number

  asignado_nombre?: string

}

interface CobranzaResult {

  id: string

  type: 'cobranza'

  cliente_nombre: string

  cliente_cedula: string

  modelo?: string

  placa?: string

  factura_numero?: string

  saldo_pendiente?: number

  status?: string

}

interface InventoryResult {

  id: string

  type: 'inventory'

  vin: string

  placa?: string

  modelo: string

  estado?: string

  ano?: number

  color?: string

}

interface CompromisoResult {

  id: string

  type: 'compromiso'

  cliente_nombre: string

  cliente_rif?: string

  monto_usd: number

  saldo_pendiente: number

  estado: string

}

interface BankResult {

  id: string

  type: 'bank'

  fecha: string

  monto_usd?: number | null

  monto_bs?: number | null

  sender_name?: string

  referencia: string

  referencia_alt?: string

  cuenta: string

  matched?: boolean

  deal_id?: string | null

  flujo?: string

}

type AnyResult = DealResult | LeadResult | CobranzaResult | InventoryResult | CompromisoResult | BankResult



const ETAPA_COLORS: Record<string, string> = {

  nuevo: '#6B7280', contactado: '#3B82F6', cita_agendada: '#8B5CF6',

  visita_showroom: '#F59E0B', oferta_presentada: '#EC4899',

  financiamiento: '#10B981', cerrado_ganado: '#059669', cerrado_perdido: '#EF4444',

}

const ETAPA_LABELS: Record<string, string> = {

  nuevo: 'Nuevo', contactado: 'Contactado', cita_agendada: 'Cita',

  visita_showroom: 'Showroom', oferta_presentada: 'Oferta',

  financiamiento: 'Financiamiento', cerrado_ganado: 'Cerrado ✓', cerrado_perdido: 'Perdido',

}

const heatColor = (s: number) => s >= 75 ? '#EF4444' : s >= 50 ? '#F59E0B' : s >= 25 ? '#3B82F6' : '#6B7280'



// Type-specific accents

const TYPE_META: Record<string, { label: string; color: string; icon: string }> = {

  deal:       { label: 'NEGOCIO',     color: '#BB162B', icon: '📦' },

  lead:       { label: 'LEAD',        color: '#3B82F6', icon: '🎯' },

  cobranza:   { label: 'COBRANZA',    color: '#14B8A6', icon: '💰' },

  inventory:  { label: 'INVENTARIO',  color: '#F59E0B', icon: '🚗' },

  compromiso: { label: 'COMPROMISO',  color: '#8B5CF6', icon: '📋' },

  bank:       { label: 'BANCO',       color: '#10B981', icon: '🏦' },

}



// ─── localStorage helpers for recent searches ──────────────────────────────

const RECENT_KEY = 'autocore.recent_searches.v1'

const loadRecent = (): string[] => {

  if (typeof window === 'undefined') return []

  try {

    const raw = window.localStorage.getItem(RECENT_KEY)

    return raw ? (JSON.parse(raw) as string[]).filter(Boolean).slice(0, 5) : []

  } catch { return [] }

}

const saveRecent = (q: string) => {

  if (typeof window === 'undefined' || !q.trim() || q.length < 2) return

  try {

    const existing = loadRecent().filter(x => x.toLowerCase() !== q.toLowerCase())

    const updated = [q, ...existing].slice(0, 5)

    window.localStorage.setItem(RECENT_KEY, JSON.stringify(updated))

  } catch {}

}



function GlobalSearch({ onClose }: { onClose: () => void }) {

  const router   = useRouter()

  const pathname = usePathname()

  const { permissions } = useNPAPermissions()

  const isAdmin = !!(permissions as any).npa_can_admin



  const [query, setQuery]     = useState('')

  const [deals, setDeals]     = useState<DealResult[]>([])

  const [leads, setLeads]     = useState<LeadResult[]>([])

  const [cobranzas, setCobranzas] = useState<CobranzaResult[]>([])

  const [inventory, setInventory] = useState<InventoryResult[]>([])

  const [compromisos, setCompromisos] = useState<CompromisoResult[]>([])

  const [bankTxs, setBankTxs] = useState<BankResult[]>([])

  const [loading, setLoading] = useState(false)

  const [selected, setSelected] = useState(0)

  const [recents, setRecents] = useState<string[]>([])

  const inputRef  = useRef<HTMLInputElement>(null)

  const timerRef  = useRef<any>(null)



  const inCRM       = pathname.startsWith('/crm')

  const inAuditoria = pathname.startsWith('/auditoria')

  const inAdmin     = pathname.startsWith('/admin')

  const inCobranza  = pathname.startsWith('/cobranza')

  const inDealCtx   = inAuditoria || inAdmin



  useEffect(() => {

    inputRef.current?.focus()

    setRecents(loadRecent())

  }, [])



  // Order results by section. CRM context bubbles leads first.

  const allResults: AnyResult[] = inCRM

    ? [...leads, ...deals, ...cobranzas, ...inventory, ...compromisos, ...bankTxs]

    : inCobranza

    ? [...cobranzas, ...compromisos, ...deals, ...leads, ...inventory, ...bankTxs]

    : [...deals, ...cobranzas, ...leads, ...inventory, ...compromisos, ...bankTxs]



  useEffect(() => {

    const handler = (e: KeyboardEvent) => {

      if (e.key === 'Escape') onClose()

      if (e.key === 'ArrowDown') setSelected(s => Math.min(s + 1, allResults.length - 1))

      if (e.key === 'ArrowUp') setSelected(s => Math.max(s - 1, 0))

      if (e.key === 'Enter' && allResults[selected]) openResult(allResults[selected])

    }

    window.addEventListener('keydown', handler)

    return () => window.removeEventListener('keydown', handler)

    // eslint-disable-next-line

  }, [allResults, selected])



  const search = useCallback(async (q: string) => {

    if (!q.trim() || q.length < 2) {

      setDeals([]); setLeads([]); setCobranzas([]); setInventory([]); setCompromisos([]); setBankTxs([])

      return

    }

    setLoading(true)

    const clean = q.trim()

    const cleanDigits = clean.replace(/\D/g, '')

    const isPhone  = /^[\d\+\-\s]+$/.test(clean) && cleanDigits.length >= 4

    const isEmail  = clean.includes('@')

    const isVin    = /^[A-Za-z0-9]{17}$/.test(clean)

    const isRef    = /^[A-Za-z0-9]{6,}$/.test(clean) && !isVin  // alphanumeric ref-like (Zelle conf, etc.)

    const words = clean.split(/\s+/).filter(w => w.length >= 2)



    // ── Deals ─────────────────────────────────────────────────────────────

    const dealsPromise = (async () => {

      let dq = supabase.from('deals')

        .select('id, negocio_num, cliente_nombre, cliente_apellidos, cliente_rif, cliente_telefono, cliente_email, vendedor, banco, resultado_tipo, status, fecha_entrega, vehiculo_modelo, vehiculo_placa, vin')

      if (isPhone) {

        const digits = cleanDigits.slice(-7)

        dq = dq.or(`cliente_telefono.ilike.%${digits}%,cliente_rif.ilike.%${digits}%`)

      } else if (isEmail) {

        dq = dq.ilike('cliente_email', `%${clean}%`)

      } else if (isVin) {

        dq = dq.eq('vin', clean.toUpperCase())

      } else {

        const cols = ['cliente_nombre','cliente_apellidos','negocio_num','cliente_rif','vendedor','banco','vehiculo_modelo','vehiculo_placa','vin','cliente_email','cliente_telefono']

        for (const word of words) dq = dq.or(cols.map(c => `${c}.ilike.%${word}%`).join(','))

      }

      const { data } = await dq.order('created_at', { ascending: false }).limit(10)

      return (data || []).map((d: any) => ({ ...d, type: 'deal' as const }))

    })()



    // ── Leads ─────────────────────────────────────────────────────────────

    const leadsPromise = (async () => {

      let lq = supabase.from('crm_leads')

        .select('id, nombre, apellidos, telefono, email, modelo_interes, etapa, heat_score, asignado_nombre')

      if (isPhone) lq = lq.ilike('telefono', `%${cleanDigits.slice(-8)}%`)

      else if (isEmail) lq = lq.ilike('email', `%${clean}%`)

      else {

        for (const word of words) lq = lq.or(`nombre.ilike.%${word}%,apellidos.ilike.%${word}%,modelo_interes.ilike.%${word}%,telefono.ilike.%${word}%`)

      }

      const { data } = await lq.order('heat_score', { ascending: false }).limit(6)

      return (data || []).map((d: any) => ({ ...d, type: 'lead' as const }))

    })()



    // ── Cobranza ──────────────────────────────────────────────────────────

    const cobranzaPromise = (async () => {

      let cq = supabase.from('cobranza_contratos')

        .select('id, cliente_nombre, cliente_cedula, modelo, placa, factura_numero, saldo_pendiente, status')

      if (isPhone) cq = cq.ilike('cliente_cedula', `%${cleanDigits.slice(-7)}%`)

      else if (isVin) cq = cq.eq('vin', clean.toUpperCase()) as any

      else {

        for (const word of words) cq = cq.or(`cliente_nombre.ilike.%${word}%,cliente_cedula.ilike.%${word}%,modelo.ilike.%${word}%,placa.ilike.%${word}%,factura_numero.ilike.%${word}%`)

      }

      const { data } = await cq.order('created_at', { ascending: false }).limit(6)

      return (data || []).map((d: any) => ({ ...d, type: 'cobranza' as const }))

    })()



    // ── Inventory ─────────────────────────────────────────────────────────

    const inventoryPromise = (async () => {

      let iq = (supabase.from('inventory_units').select('vin, placa, modelo, estado, ano, color') as any)

      if (isVin) iq = iq.eq('vin', clean.toUpperCase())

      else {

        for (const word of words) iq = iq.or(`vin.ilike.%${word}%,placa.ilike.%${word}%,modelo.ilike.%${word}%`)

      }

      const { data } = await iq.limit(6)

      // VIN is the primary key — use it as 'id' for the result

      return (data || []).map((u: any) => ({ ...u, id: u.vin, type: 'inventory' as const }))

    })()



    // ── Compromisos Inicial Diferida ──────────────────────────────────────

    const compromisoPromise = (async () => {

      let mq = supabase.from('compromisos_inicial_diferida')

        .select('id, cliente_nombre, cliente_rif, monto_usd, saldo_pendiente, estado')

      if (isPhone) mq = mq.ilike('cliente_rif', `%${cleanDigits.slice(-7)}%`)

      else {

        for (const word of words) mq = mq.or(`cliente_nombre.ilike.%${word}%,cliente_rif.ilike.%${word}%`)

      }

      const { data } = await mq.order('created_at', { ascending: false }).limit(4)

      return (data || []).map((c: any) => ({ ...c, type: 'compromiso' as const }))

    })()



    // ── Bank transactions ─────────────────────────────────────────────────

    // Triggered most aggressively when query looks like a reference number,

    // but also runs name search against sender_name.

    const bankPromise = (async () => {

      let bq = supabase.from('bank_transactions')

        .select('id, fecha, monto_usd, monto_bs, sender_name, referencia, referencia_alt, cuenta, matched, deal_id, flujo')

      if (isRef) {

        bq = bq.or(`referencia.ilike.%${clean}%,referencia_alt.ilike.%${clean}%`)

      } else if (isPhone) {

        // Phone is unlikely to be a bank ref but skip

        bq = bq.or(`sender_name.ilike.%${clean}%`)

      } else {

        for (const word of words) bq = bq.or(`sender_name.ilike.%${word}%,referencia.ilike.%${word}%,referencia_alt.ilike.%${word}%`)

      }

      const { data } = await bq.order('fecha', { ascending: false }).limit(6)

      return (data || []).map((b: any) => ({ ...b, type: 'bank' as const }))

    })()



    const [dD, lD, cD, iD, mD, bD] = await Promise.all([

      dealsPromise, leadsPromise, cobranzaPromise, inventoryPromise, compromisoPromise, bankPromise

    ])

    setDeals(dD)

    setLeads(lD)

    setCobranzas(cD)

    setInventory(iD)

    setCompromisos(mD)

    setBankTxs(bD)

    setSelected(0)

    setLoading(false)

  }, [])



  useEffect(() => {

    clearTimeout(timerRef.current)

    timerRef.current = setTimeout(() => search(query), 250)

    return () => clearTimeout(timerRef.current)

  }, [query, search])



  // ── Routing ─────────────────────────────────────────────────────────────

  const openResult = (result: AnyResult) => {

    saveRecent(query)

    onClose()

    if (result.type === 'deal') {

      // Stay in current context if it's a deal-capable page; otherwise role-aware default.

      let dest = '/auditoria'

      if (inAdmin) dest = '/admin'

      else if (inAuditoria) dest = '/auditoria'

      else if (isAdmin) dest = '/admin'

      router.push(`${dest}?open_deal=${result.id}`)

    } else if (result.type === 'lead') {

      router.push('/crm?search_lead=' + result.id)

    } else if (result.type === 'cobranza') {

      router.push('/cobranza?open_contrato=' + result.id)

    } else if (result.type === 'inventory') {

      router.push('/inventario?vin=' + encodeURIComponent(result.vin))

    } else if (result.type === 'compromiso') {

      router.push('/inicial-diferida?id=' + result.id)

    } else if (result.type === 'bank') {

      router.push('/banco?tx=' + result.id)

    }

  }



  // Secondary action for cobranza results — open in Portal (new tab)

  const openInPortal = (result: CobranzaResult, e: any) => {

    e.stopPropagation()

    saveRecent(query)

    window.open('https://portal.motocentro2.com/prestamo/detail?id=' + result.id, '_blank', 'noopener')

  }



  const fmtDate = (iso: string) => { if (!iso) return ''; const [y,m,d] = iso.split('-'); return `${d}/${m}/${y}` }

  const fmt$ = (n: number | null | undefined) => `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

  const resultColor = (tipo?: string) => tipo === 'CUADRADO' ? '#2ecc8a' : tipo === 'FALTANTE' ? '#BB162B' : tipo === 'SOBRANTE' ? '#b8720a' : '#6B7280'



  const totalResults = allResults.length

  const showRecents = !query.trim() && recents.length > 0



  return (

    <div

      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '80px' }}

      onClick={e => { if (e.target === e.currentTarget) onClose() }}

    >

      <div style={{ width: '100%', maxWidth: '660px', background: 'var(--bg-card)', borderRadius: '14px', border: '1px solid var(--border)', boxShadow: '0 24px 80px rgba(0,0,0,0.5)', overflow: 'hidden' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px', borderBottom: totalResults > 0 || loading ? '1px solid var(--border)' : 'none' }}>

          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2.5">

            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>

          </svg>

          <input

            ref={inputRef}

            value={query}

            onChange={e => setQuery(e.target.value)}

            placeholder={inCRM ? 'Buscar leads, negocios, clientes...' : inCobranza ? 'Buscar contratos, clientes, cédulas...' : 'Buscar todo: clientes, ref. bancarias, VIN, modelo...'}

            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '16px', color: 'var(--text-primary)', fontFamily: 'inherit' }}

          />

          {loading && <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Buscando...</div>}

          <kbd style={{ fontSize: '10px', color: 'var(--text-muted)', background: 'var(--bg-deep)', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px 6px', fontFamily: 'monospace' }}>ESC</kbd>

        </div>



        {/* Recent searches when empty */}

        {showRecents && (

          <div style={{ padding: '12px 0' }}>

            <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.5, padding: '0 20px 8px' }}>

              Búsquedas recientes

            </div>

            {recents.map((r, idx) => (

              <div key={idx}

                onClick={() => setQuery(r)}

                style={{ padding: '10px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-primary)', fontSize: 13, transition: 'background 0.1s' }}

                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.05)' }}

                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>

                <span style={{ color: 'var(--text-muted)' }}>↻</span>

                <span>{r}</span>

              </div>

            ))}

          </div>

        )}



        {/* No results hint */}

        {!showRecents && query.trim().length >= 2 && totalResults === 0 && !loading && (

          <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>

            Sin resultados para "<strong style={{ color: 'var(--text-primary)' }}>{query}</strong>"

          </div>

        )}



        {/* Results, grouped by category with headers */}

        {totalResults > 0 && (

          <div style={{ maxHeight: '480px', overflowY: 'auto' }}>

            {(() => {

              // Group results by type in the same order as allResults

              const grouped: { type: string; items: AnyResult[]; startIdx: number }[] = []

              let cursor = 0

              for (const r of allResults) {

                const lastGroup = grouped[grouped.length - 1]

                if (lastGroup && lastGroup.type === r.type) {

                  lastGroup.items.push(r)

                } else {

                  grouped.push({ type: r.type, items: [r], startIdx: cursor })

                }

                cursor++

              }

              return grouped.map((group, gIdx) => {

                const meta = TYPE_META[group.type]

                return (

                  <div key={gIdx}>

                    <div style={{

                      fontSize: 10, fontWeight: 700, color: meta.color,

                      textTransform: 'uppercase', letterSpacing: 1.5,

                      padding: '10px 20px 6px', background: 'var(--bg-deep)',

                      borderTop: gIdx > 0 ? '1px solid var(--border)' : 'none',

                      display: 'flex', alignItems: 'center', gap: 6,

                    }}>

                      <span>{meta.icon}</span>

                      <span>{meta.label}</span>

                      <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontWeight: 500 }}>{group.items.length}</span>

                    </div>

                    {group.items.map((result, localIdx) => {

                      const idx = group.startIdx + localIdx

                      const isSelected = idx === selected

                      return (

                        <div

                          key={`${result.type}-${result.id}`}

                          onClick={() => openResult(result)}

                          onMouseEnter={() => setSelected(idx)}

                          style={{

                            padding: '12px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px',

                            background: isSelected ? 'rgba(187,22,43,0.08)' : 'transparent',

                            borderLeft: isSelected ? `3px solid ${meta.color}` : '3px solid transparent',

                            borderBottom: '1px solid var(--border)',

                          }}

                        >

                          {(() => {

                            switch (result.type) {

                              case 'deal': {

                                const r = result as DealResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: resultColor(r.resultado_tipo) + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', color: resultColor(r.resultado_tipo), fontSize: '11px', fontWeight: 800 }}>

                                    #{r.negocio_num}

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.cliente_nombre} {r.cliente_apellidos}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>

                                      {r.vendedor || '—'} · {r.banco || '—'} · {fmtDate(r.fecha_entrega || '')}

                                    </div>

                                  </div>

                                </>)

                              }

                              case 'lead': {

                                const r = result as LeadResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: heatColor(r.heat_score) + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', color: heatColor(r.heat_score), fontSize: '13px', fontWeight: 800 }}>

                                    {r.heat_score}

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.nombre} {r.apellidos}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>

                                      {ETAPA_LABELS[r.etapa] || r.etapa} · {r.modelo_interes || '—'} · {r.asignado_nombre || 'Sin asignar'}

                                    </div>

                                  </div>

                                </>)

                              }

                              case 'cobranza': {

                                const r = result as CobranzaResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: meta.color + '22', color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>

                                    💰

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.cliente_nombre}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>

                                      C.I {r.cliente_cedula || '—'} · {r.modelo || '—'} · {r.placa || 'sin placa'}

                                      {r.saldo_pendiente != null && r.saldo_pendiente > 0 ? ` · Saldo ${fmt$(r.saldo_pendiente)}` : ''}

                                    </div>

                                  </div>

                                  <button

                                    onClick={(e) => openInPortal(r, e)}

                                    title="Abrir en Portal de Cobranza (nueva pestaña)"

                                    style={{ padding: '5px 9px', borderRadius: 6, border: `1px solid ${meta.color}55`, background: meta.color + '15', color: meta.color, fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>

                                    Portal ↗

                                  </button>

                                </>)

                              }

                              case 'inventory': {

                                const r = result as InventoryResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: meta.color + '22', color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>

                                    🚗

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.modelo} {r.ano ? `· ${r.ano}` : ''} {r.color ? `· ${r.color}` : ''}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>

                                      VIN {r.vin} {r.placa ? ` · ${r.placa}` : ''} {r.estado ? ` · ${r.estado}` : ''}

                                    </div>

                                  </div>

                                </>)

                              }

                              case 'compromiso': {

                                const r = result as CompromisoResult

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: meta.color + '22', color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>

                                    📋

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.cliente_nombre}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>

                                      RIF {r.cliente_rif || '—'} · Compromiso {fmt$(r.monto_usd)} · Saldo {fmt$(r.saldo_pendiente)} · {r.estado}

                                    </div>

                                  </div>

                                </>)

                              }

                              case 'bank': {

                                const r = result as BankResult

                                const cuentaLabel = r.cuenta?.charAt(0).toUpperCase() + r.cuenta?.slice(1)

                                return (<>

                                  <div style={{ width: '36px', height: '36px', borderRadius: '8px', background: meta.color + '22', color: meta.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15 }}>

                                    🏦

                                  </div>

                                  <div style={{ flex: 1, minWidth: 0 }}>

                                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>

                                      {r.sender_name || '—'} · {fmt$(r.monto_usd)}

                                      {r.flujo === 'egreso' && <span style={{ marginLeft: 6, fontSize: 10, padding: '1px 5px', borderRadius: 3, background: '#BB162B22', color: '#BB162B' }}>SALIDA</span>}

                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>

                                      Ref {r.referencia} · {cuentaLabel} · {fmtDate(r.fecha)}

                                      {r.matched && <span style={{ marginLeft: 6, color: '#10B981' }}>✓ Conciliado</span>}

                                    </div>

                                  </div>

                                </>)

                              }

                            }

                          })()}

                        </div>

                      )

                    })}

                  </div>

                )

              })

            })()}

          </div>

        )}

      </div>

    </div>

  )

}



// ────────────────────────────────────────────────────────────────────────────

// Admin Dropdown

// ────────────────────────────────────────────────────────────────────────────

interface DropdownItem {

  label: string

  path: string

  show: boolean

  badge?: number

}



function NavDropdown({ items, isActive, label }: { items: DropdownItem[]; isActive: boolean; label: string }) {

  const router = useRouter()

  const [open, setOpen] = useState(false)

  const ref = useRef<HTMLDivElement>(null)



  useEffect(() => {

    const handler = (e: MouseEvent) => {

      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)

    }

    document.addEventListener('mousedown', handler)

    return () => document.removeEventListener('mousedown', handler)

  }, [])



  const visibleItems = items.filter(i => i.show)

  const alertCount = visibleItems.reduce((n, i) => n + (i.badge || 0), 0)

  if (visibleItems.length === 0) return null



  return (

    <div ref={ref} style={{ position: 'relative' }}>

      <button

        onClick={() => setOpen(o => !o)}

        style={{

          fontFamily: 'Rajdhani, sans-serif',

          fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em', textTransform: 'uppercase',

          padding: '5px 14px',

          border: isActive ? '1px solid rgba(187,22,43,0.35)' : '1px solid transparent',

          borderRadius: '6px',

          background: isActive || open ? 'rgba(187,22,43,0.12)' : 'transparent',

          color: isActive || open ? '#BB162B' : 'var(--text-secondary)',

          cursor: 'pointer',

          transition: 'all 0.15s',

          display: 'flex', alignItems: 'center', gap: 6,

        }}

      >

        {label}
        {alertCount > 0 && (

          <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: '#BB162B', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>{alertCount}</span>

        )}

        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"

          style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>

          <polyline points="6 9 12 15 18 9"/>

        </svg>

      </button>



      {open && (

        <div style={{

          position: 'absolute', top: 'calc(100% + 4px)', left: 0,

          minWidth: '220px',

          background: 'var(--bg-card)',

          border: '1px solid var(--border)',

          borderRadius: '8px',

          boxShadow: '0 8px 24px rgba(0,0,0,0.18)',

          padding: '6px',

          zIndex: 200,

        }}>

          {visibleItems.map(item => (

            <button

              key={item.path}

              onClick={() => { setOpen(false); router.push(item.path) }}

              style={{

                width: '100%', textAlign: 'left',

                padding: '9px 14px',

                background: 'transparent',

                border: 'none',

                borderRadius: '6px',

                color: 'var(--text-primary)',

                fontSize: '13px',

                fontWeight: 500,

                cursor: 'pointer',

                fontFamily: 'inherit',

                transition: 'background 0.12s',

              }}

              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.08)' }}

              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}

            >

              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>

                <span>{item.label}</span>

                {item.badge ? <span style={{ minWidth: 20, height: 20, padding: '0 6px', borderRadius: 999, background: '#BB162B', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>{item.badge}</span> : null}

              </span>

            </button>

          ))}

        </div>

      )}

    </div>

  )

}



// ────────────────────────────────────────────────────────────────────────────

// External-link icon

// ────────────────────────────────────────────────────────────────────────────

function ExtIcon() {

  return (

    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 4, opacity: 0.75 }}>

      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>

      <polyline points="15 3 21 3 21 9"/>

      <line x1="10" y1="14" x2="21" y2="3"/>

    </svg>

  )

}



// ────────────────────────────────────────────────────────────────────────────

// MAIN NAVBAR

// ────────────────────────────────────────────────────────────────────────────

export default function NavBar() {

  const router   = useRouter()

  const pathname = usePathname()

  const [email, setEmail] = useState<string>('')

  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  const [searchOpen, setSearchOpen] = useState(false)

  const { permissions, loading: permsLoading } = useNPAPermissions()

  // ── "Pagos por confirmar" badge so reviewers spot pending work on any page.
  //    Single fetch on mount; only for users who can confirm (Mirla / admins).
  const [porConfirmar, setPorConfirmar] = useState(0)
  const canConfirm = permissions.tesoreria_can_confirm_fx || permissions.tesoreria_admin
  useEffect(() => {
    if (!canConfirm) { setPorConfirmar(0); return }
    let alive = true
    ;(async () => {
      try {
        const [compRes, cuotaRes, difRes] = await Promise.all([
          (supabase.from('tesoreria_comprobantes').select('numero').eq('tipo', 'INGRESO').eq('revision_estado', 'pendiente') as any),
          (supabase.from('cobranza_cuota_pagos').select('referencia_pago').eq('status', 'pending_review').eq('is_reversal', false) as any),
          (supabase.from('compromisos_inicial_diferida_pagos').select('referencia').eq('status', 'pending_review').eq('is_reversal', false) as any),
        ])
        const compRows = Array.isArray(compRes.data) ? compRes.data : []
        const pendingNums = new Set(compRows.map((c: any) => c.numero).filter(Boolean))
        const cuotas = Array.isArray(cuotaRes.data) ? cuotaRes.data : []
        const difs = Array.isArray(difRes.data) ? difRes.data : []
        const sc = cuotas.filter((p: any) => !(p.referencia_pago && pendingNums.has(p.referencia_pago))).length
        const sd = difs.filter((p: any) => !(p.referencia && pendingNums.has(p.referencia))).length
        if (alive) setPorConfirmar(compRows.length + sc + sd)
      } catch { /* non-fatal — badge just won't show */ }
    })()
    return () => { alive = false }
  }, [canConfirm])

  // ── CRM "Tareas" badge: due/overdue reminders for the current rep. ──────────
  const [tareasDue, setTareasDue] = useState(0)
  useEffect(() => {
    if (!permissions.npa_can_view_crm) { setTareasDue(0); return }
    let alive = true
    ;(async () => {
      try {
        const { data } = await supabase.rpc('crm_tareas_pendientes_count')
        if (alive) setTareasDue(typeof data === 'number' ? data : 0)
      } catch { /* non-fatal — badge just won't show */ }
    })()
    return () => { alive = false }
  }, [permissions.npa_can_view_crm])



  // ── Top-level items ──────────────────────────────────────────────────────

  const TOP_NAV = [

    { label: 'Dashboard',   path: '/dashboard',  show: permissions.npa_can_view_dashboard },

    { label: 'CRM',         path: '/crm',        show: permissions.npa_can_view_crm },

    // Admin dropdown gets rendered separately below (special handling)

    { label: 'Inventario',  path: '/inventario', show: permissions.can_view_inventory || permissions.can_manage_inventory },

    { label: 'Clientes',    path: '/clientes',   show: permissions.npa_can_view_clientes },

    // Cobranza is now an EXTERNAL link to Portal — handled below

    { label: 'Reportes',    path: '/reportes/',  show: permissions.npa_can_view_management_pnl },

    { label: 'Configuración', path: '/settings', show: permissions.npa_can_admin },

  ]



  // ── Admin dropdown items ─────────────────────────────────────────────────

  const ADMIN_ITEMS: DropdownItem[] = [

    { label: 'Administración de Negocios', path: '/admin',

      show: permissions.npa_can_admin },

    { label: 'Auditoría',                  path: '/auditoria',

      show: permissions.npa_can_audit_deals },

    { label: 'Ingresos',                   path: '/ingresos',

      show: permissions.npa_can_admin

         || permissions.npa_can_audit_deals

         || permissions.npa_can_approve_deals

         || permissions.tesoreria_admin

         || permissions.tesoreria_can_view_balance },

    { label: 'Inicial Diferida',           path: '/inicial-diferida',

      show: permissions.npa_can_audit_deals || permissions.npa_can_admin },

    { label: 'Tesorería',                  path: '/tesoreria',

      show: permissions.tesoreria_can_view_balance

         || permissions.tesoreria_can_pickup

         || permissions.tesoreria_can_dispatch

         || permissions.tesoreria_can_approve_salida

         || permissions.tesoreria_admin },

    { label: 'Por confirmar',              path: '/tesoreria/confirmar',

      show: permissions.tesoreria_can_confirm_fx || permissions.tesoreria_admin, badge: porConfirmar },

    { label: 'Caja Chica',                 path: '/tesoreria/caja-chica',

      show: permissions.tesoreria_can_register_cc_gasto || permissions.tesoreria_admin },

    { label: 'Banco',                      path: '/banco',

      show: permissions.npa_can_admin },

    { label: 'Conciliación',               path: '/conciliacion',

      show: permissions.npa_can_admin },

  ]

  const adminActive = ADMIN_ITEMS.some(i => i.show && (pathname === i.path || pathname.startsWith(i.path + '/')))

  // Admin es ahora un LINK directo (la navegación interna vive en el sidebar
  // AdminShell). Destino: la primera sección visible según permisos. El badge
  // agregado del viejo dropdown se conserva sobre el botón.
  const adminHome = (ADMIN_ITEMS.find(i => i.show) || { path: '/admin' }).path
  const adminBadgeTotal = ADMIN_ITEMS.reduce((n, i) => n + ((i.show && i.badge) || 0), 0)

  // ── CRM dropdown items ───────────────────────────────────────────────────
  const CRM_ITEMS: DropdownItem[] = [
    { label: 'Dashboard',  path: '/crm/dashboard',  show: permissions.npa_can_view_crm },
    { label: 'Pipeline',   path: '/crm',            show: permissions.npa_can_view_crm },
    { label: 'Campañas',   path: '/crm/campanas',   show: permissions.npa_can_view_crm },
    { label: 'Calendario', path: '/crm/calendario', show: permissions.npa_can_view_crm },
    { label: 'Tareas',     path: '/crm/tareas',     show: permissions.npa_can_view_crm, badge: tareasDue },
    { label: 'Recepción',  path: '/crm/recepcion',  show: permissions.npa_can_view_crm },
    { label: 'Reportes',   path: '/crm/reportes',   show: permissions.npa_can_view_crm },
    { label: 'Pulso',      path: '/crm/pulso',      show: permissions.npa_can_view_crm },
    { label: 'Pendientes', path: '/crm/pendientes', show: permissions.npa_can_view_crm },
    { label: 'Walk-ins', path: '/crm/walk-ins', show: permissions.npa_can_view_crm },
  ]
  const crmActive = pathname === '/crm' || pathname.startsWith('/crm/')

  // CRM es un LINK directo al dashboard del módulo (sidebar CrmShell navega
  // dentro). El badge de tareas vencidas se conserva sobre el botón.
  const crmBadgeTotal = CRM_ITEMS.reduce((n, i) => n + ((i.show && i.badge) || 0), 0)



  // v6: Cobranza external link REMOVED from global nav. The Portal lives only

  // behind the admin's Cobranza tile on /dashboard. Tesorería users have no

  // direct path to it from inside NPA.



  // v6: Tesorería-only users see NO global nav. Heuristic: they have at least

  // one tesoreria_* permission but no admin/audit/CRM/inventory permission.

  // (Admins keep the full nav even though they also have tesoreria_admin.)

  const hasAnyTesoreriaPerm =

    permissions.tesoreria_can_pickup ||

    permissions.tesoreria_can_dispatch ||

    permissions.tesoreria_can_view_balance ||

    permissions.tesoreria_can_replenish_cc ||

    permissions.tesoreria_can_confirm_fx ||

    permissions.tesoreria_can_request_salida ||

    permissions.tesoreria_can_approve_salida ||

    permissions.tesoreria_can_register_cc_gasto ||

    permissions.tesoreria_admin

  const hasAnyNonTesoreriaPerm =

    permissions.npa_can_admin ||

    permissions.npa_can_audit_deals ||

    permissions.npa_can_view_crm ||

    permissions.npa_can_view_clientes ||

    permissions.npa_can_view_management_pnl ||

    permissions.can_view_inventory ||

    permissions.can_manage_inventory

  const isTesoreriaOnlyUser = !permsLoading && hasAnyTesoreriaPerm && !hasAnyNonTesoreriaPerm



  useEffect(() => {

    const saved = (localStorage.getItem('autocore-theme') as 'dark' | 'light') || 'dark'

    setTheme(saved)

    document.documentElement.setAttribute('data-theme', saved)

  }, [])



  useEffect(() => {

    supabase.auth.getUser().then(({ data }) => {

      if (data.user?.email) setEmail(data.user.email)

    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {

      if (event === 'SIGNED_IN' && session?.user) {

        await supabase.from('activity_log').insert({

          user_id: session.user.id, user_email: session.user.email,

          action: 'user_login', target_type: 'session', target_id: session.user.id,

          details: { email: session.user.email, login_at: new Date().toISOString() },

        })

      }

    })

    return () => subscription.unsubscribe()

  }, [])



  useEffect(() => {

    const handler = (e: KeyboardEvent) => {

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {

        e.preventDefault()

        setSearchOpen(true)

      }

    }

    window.addEventListener('keydown', handler)

    return () => window.removeEventListener('keydown', handler)

  }, [])



  const toggleTheme = () => {

    const next = theme === 'dark' ? 'light' : 'dark'

    setTheme(next)

    document.documentElement.setAttribute('data-theme', next)

    localStorage.setItem('autocore-theme', next)

  }



  // bfcache guard: when this page is restored from the browser's back/forward

  // cache, force a fresh load so auth re-bootstraps instead of restoring a

  // frozen, half-permissioned snapshot (the empty-dashboard-on-back symptom).

  useEffect(() => {

    const onPageShow = (e: PageTransitionEvent) => {

      if (e.persisted) window.location.reload()

    }

    window.addEventListener('pageshow', onPageShow)

    return () => window.removeEventListener('pageshow', onPageShow)

  }, [])



  const handleLogout = async () => {

    // Clear the local session FIRST so logout always takes effect even if the

    // network signOut stalls under multi-tab Web-Lock contention — the bug where

    // "Salir" looked dead and left you on the same page. Then fire signOut

    // time-boxed, and hard-REPLACE to '/' so this page leaves history and a

    // browser-back can't return into a stale/half-loaded screen.

    try {

      Object.keys(localStorage).forEach(k => {

        if (k.startsWith('sb-')) localStorage.removeItem(k)

      })

    } catch {}

    try {

      await Promise.race([

        supabase.auth.signOut(),

        new Promise(res => setTimeout(res, 1500)),

      ])

    } catch { /* ignore */ }

    window.location.replace('/')

  }



  const handleBack = () => {

    // Universal "go back" that survives the permission-gated nav being hidden.

    // Uses in-app history when there is somewhere to return to, else falls back

    // to the dashboard (e.g. opened via a deep link or a fresh tab).

    if (typeof window !== 'undefined' && window.history.length > 1) {

      window.history.back()

    } else {

      window.location.href = '/dashboard'

    }

  }



  const navBtnStyle = (isActive: boolean) => ({

    fontFamily: 'Rajdhani, sans-serif',

    fontWeight: 600, fontSize: '12px', letterSpacing: '0.08em',

    textTransform: 'uppercase' as const,

    padding: '5px 14px',

    border: isActive ? '1px solid rgba(187,22,43,0.35)' : '1px solid transparent',

    background: isActive ? 'rgba(187,22,43,0.12)' : 'transparent',

    color: isActive ? '#BB162B' : 'var(--text-secondary)',

    cursor: 'pointer', transition: 'all 0.15s',

    borderRadius: '6px',

    display: 'flex', alignItems: 'center',

  })



  return (

    <>

      {/* v6: Tesorería-only users get no nav. They live in /tesoreria/* with

          page-level chrome. This avoids leaking admin/cobranza/reportes links

          to cashier-style accounts. */}

      {isTesoreriaOnlyUser ? null : (

        <>

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}



      <nav style={{

        background: 'var(--bg-nav)', borderBottom: '1px solid var(--border)',

        padding: '0 28px', display: 'flex', alignItems: 'center',

        height: '52px', gap: '24px', position: 'sticky', top: 0, zIndex: 100,

        transition: 'background 0.35s ease, border-color 0.35s ease',

      }}>

        <button

          onClick={() => router.push('/dashboard')}

          title="Ir al Dashboard"

          style={{

            fontFamily: 'Rajdhani, sans-serif', fontWeight: 700, fontSize: '18px',

            letterSpacing: '0.04em', color: 'var(--text-primary)', whiteSpace: 'nowrap',

            flexShrink: 0, background: 'transparent', border: 'none',

            padding: '4px 6px', borderRadius: '4px', cursor: 'pointer',

            transition: 'opacity 0.15s ease, background 0.15s ease',

          }}

          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.08)' }}

          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}

        >

          AUTOCORE <span style={{ color: '#BB162B' }}>NPA</span>

        </button>



        <div style={{ width: '1px', height: '22px', background: 'var(--border)', flexShrink: 0 }} />



        {/* Universal back button — NOT permission-gated, so it works even when

            the nav menu is hidden / permissions are still settling. Hidden on

            the dashboard (home) where "back" has no meaning. */}

        {pathname !== '/dashboard' && (

          <button

            onClick={handleBack}

            title="Atrás"

            aria-label="Atrás"

            style={{

              flexShrink: 0, display: 'flex', alignItems: 'center', gap: '5px',

              background: 'transparent', border: '1px solid var(--border)',

              color: 'var(--text-secondary)', borderRadius: '7px',

              padding: '6px 11px', cursor: 'pointer', fontSize: '13px', fontWeight: 600,

              fontFamily: 'var(--font-inter), Inter, sans-serif',

              transition: 'background 0.15s ease',

            }}

            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(187,22,43,0.08)' }}

            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}

          >

            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">

              <path d="M19 12H5" />

              <path d="M12 19l-7-7 7-7" />

            </svg>

            Atrás

          </button>

        )}



        <div style={{ display: 'flex', gap: '4px', flex: 1, alignItems: 'center' }}>

          {!permsLoading && (

            <>

              {/* Dashboard */}

              {TOP_NAV[0].show && (

                <button onClick={() => router.push('/dashboard')}

                  style={navBtnStyle(pathname === '/dashboard')}>

                  Dashboard

                </button>

              )}

              {/* CRM — link directo al dashboard del módulo (sidebar CrmShell navega dentro) */}
              {TOP_NAV[1].show && (
                <button
                  onClick={() => router.push('/crm/dashboard')}
                  style={{ ...navBtnStyle(crmActive), display: 'flex', alignItems: 'center', gap: 6 }}>
                  CRM
                  {crmBadgeTotal > 0 && (
                    <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: '#BB162B', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>{crmBadgeTotal}</span>
                  )}
                </button>
              )}
              {/* Admin — link directo al módulo (sidebar AdminShell navega dentro) */}
              {ADMIN_ITEMS.some(i => i.show) && (
                <button
                  onClick={() => router.push(adminHome)}
                  style={{ ...navBtnStyle(adminActive), display: 'flex', alignItems: 'center', gap: 6 }}>
                  Admin
                  {adminBadgeTotal > 0 && (
                    <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, background: '#BB162B', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>{adminBadgeTotal}</span>
                  )}
                </button>
              )}

              {/* Inventario */}

              {TOP_NAV[2].show && (

                <button onClick={() => router.push('/inventario')}

                  style={navBtnStyle(pathname === '/inventario' || pathname.startsWith('/inventario/'))}>

                  Inventario

                </button>

              )}

              {/* Clientes */}

              {TOP_NAV[3].show && (

                <button onClick={() => router.push('/clientes')}

                  style={navBtnStyle(pathname === '/clientes' || pathname.startsWith('/clientes/'))}>

                  Clientes

                </button>

              )}

              {/* v6: Cobranza link removed from global nav. Portal access lives

                  behind the admin's Cobranza tile on /dashboard. */}

              {/* Reportes */}

              {TOP_NAV[4].show && (

                <button onClick={() => router.push('/reportes/')}

                  style={navBtnStyle(pathname.startsWith('/reportes'))}>

                  Reportes

                </button>

              )}

              {/* Configuración */}

              {TOP_NAV[5].show && (

                <button onClick={() => router.push('/settings')}

                  style={navBtnStyle(pathname === '/settings' || pathname.startsWith('/settings/'))}>

                  Configuración

                </button>

              )}

            </>

          )}

        </div>



        {/* Right side */}

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: 'auto' }}>

          <button

            onClick={() => setSearchOpen(true)}

            style={{

              display: 'flex', alignItems: 'center', gap: '8px',

              background: 'var(--bg-deep)', border: '1px solid var(--border)',

              borderRadius: '8px', padding: '5px 12px', cursor: 'pointer',

              color: 'var(--text-muted)', fontSize: '12px', fontFamily: 'Rajdhani, sans-serif',

              letterSpacing: '0.05em', transition: 'all 0.2s',

            }}

            onMouseEnter={e => { e.currentTarget.style.borderColor = '#BB162B44'; e.currentTarget.style.color = 'var(--text-primary)' }}

            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)' }}

          >

            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">

              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>

            </svg>

            <span>Buscar</span>

            <kbd style={{

              fontSize: '9px', background: 'var(--bg-card)', border: '1px solid var(--border)',

              borderRadius: '3px', padding: '1px 5px', fontFamily: 'monospace', color: 'var(--text-muted)',

            }}>⌘K</kbd>

          </button>



          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>

            {email}

          </span>



          <button className="theme-toggle" onClick={toggleTheme} title="Cambiar tema">

            <span className="theme-toggle-icon" style={{ opacity: theme === 'dark' ? 1 : 0.3 }}>🌙</span>

            <div className="theme-toggle-track"><div className="theme-toggle-thumb" /></div>

            <span className="theme-toggle-label">{theme === 'dark' ? 'OSCURO' : 'CLARO'}</span>

            <span className="theme-toggle-icon" style={{ opacity: theme === 'light' ? 1 : 0.3 }}>☀</span>

          </button>



          <button onClick={handleLogout}

            style={{

              background: 'transparent', border: '1px solid var(--border)',

              borderRadius: '6px', padding: '5px 12px', cursor: 'pointer',

              color: 'var(--text-secondary)', fontSize: '11px',

              fontFamily: 'Rajdhani, sans-serif', fontWeight: 600,

              letterSpacing: '0.05em', textTransform: 'uppercase',

              transition: 'all 0.15s',

            }}

            onMouseEnter={e => { e.currentTarget.style.borderColor = '#BB162B'; e.currentTarget.style.color = '#BB162B' }}

            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)' }}

          >

            Salir

          </button>

        </div>

      </nav>



      <RatesBanner />

        </>

      )}

    </>

  )

}