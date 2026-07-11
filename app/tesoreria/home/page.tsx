// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/home/page.tsx
// AutoCore NPA — Tesorería Home (mobile-first)
//
// Phase 3 (2026-05-13). This is the landing page for tesorería-only users
// (Mirla, Angeles, Viviana). It's deliberately stripped down: no nav bar,
// no global chrome, no admin KPIs. Just:
//   - Greeting + role
//   - Live saldo of their assigned ubicación
//   - 3-5 big tappable tiles tailored to what they can do
//   - Salir button at the bottom
//
// Tile visibility by permission:
//   - 💵 Nuevo Ingreso         → anyone with tesoreria_can_register_cc_gasto
//                                or tesoreria_can_view_balance
//                                or tesoreria_admin
//   - 📷 Escanear QR / Pickup  → tesoreria_can_pickup
//   - 📋 Mis Comprobantes      → always
//   - 🧾 Registrar Gasto CC    → tesoreria_can_register_cc_gasto
//   - 💱 Cambio FX             → tesoreria_can_confirm_fx
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '../../supabase'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'
import { useIsMobile } from '../../components/useIsMobile'
import {
  Wallet, ScanLine, FileText, Receipt, ArrowLeftRight, ArrowUpRight, LogOut,
  BarChart3, Users,
} from 'lucide-react'

interface MyUbicacion {
  id: string
  codigo: string
  nombre: string
  tipo: string
  saldo_actual_usd: number
  saldo_objetivo_usd: number | null
}

const fmt = (n: number) =>
  `$${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const s: any = {
  // Mobile-first: max-width 480, single column, big touch targets.
  page: {
    minHeight: '100vh',
    background: 'var(--bg-page)',
    fontFamily: 'sans-serif',
    paddingBottom: 40,
  },
  topBar: {
    background: '#BB162B',
    color: '#fff',
    padding: '14px 20px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    position: 'sticky' as const,
    top: 0,
    zIndex: 50,
    boxShadow: '0 2px 6px rgba(0,0,0,0.15)',
  },
  topBarTitle: { fontSize: 15, fontWeight: 700, letterSpacing: 0.5 },
  topBarLogout: {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.4)',
    color: '#fff',
    borderRadius: 6,
    padding: '5px 12px',
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  content: {
    padding: '20px 16px',
    maxWidth: 480,
    margin: '0 auto',
  },
  greeting: {
    marginBottom: 20,
  },
  greetingHello: {
    fontSize: 22,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 4,
  },
  greetingSub: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: 1.5,
  },
  saldoCard: {
    background: 'linear-gradient(135deg, #0A0F1E 0%, #0D2257 100%)',
    border: '1px solid rgba(187,22,43,0.3)',
    borderRadius: 14,
    padding: '20px 22px',
    marginBottom: 24,
    color: '#fff',
    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
  },
  saldoLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.6)',
    textTransform: 'uppercase' as const,
    letterSpacing: 2,
    marginBottom: 6,
  },
  saldoAmount: {
    fontSize: 36,
    fontWeight: 800,
    fontFamily: 'monospace',
    letterSpacing: -1,
    lineHeight: 1.1,
  },
  saldoFooter: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: '1px solid rgba(255,255,255,0.15)',
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    display: 'flex',
    justifyContent: 'space-between',
  },
  tilesGrid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
  },
  tile: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '16px 18px',
    cursor: 'pointer',
    textAlign: 'left' as const,
    width: '100%',
    transition: 'transform 0.08s, border-color 0.15s',
    minHeight: 72,
  },
  tileIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(187,22,43,0.1)',
    color: '#BB162B',
    flexShrink: 0,
  },
  tileBody: { flex: 1, minWidth: 0 },
  tileTitle: {
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 2,
  },
  tileSubtitle: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.4,
  },
  tileChevron: {
    color: 'var(--text-muted)',
    fontSize: 22,
    fontWeight: 300,
    flexShrink: 0,
  },
  loading: {
    padding: 40,
    textAlign: 'center' as const,
    color: 'var(--text-secondary)',
    fontSize: 13,
  },
}

export default function TesoreriaHomePage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  // Layer 2: auth gate. Tile visibility below still reads `permissions`.
  const gate = useAuthGate(p =>
    p.tesoreria_can_pickup ||
    p.tesoreria_can_dispatch ||
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_replenish_cc ||
    p.tesoreria_can_confirm_fx ||
    p.tesoreria_can_request_salida ||
    p.tesoreria_can_approve_salida ||
    p.tesoreria_can_register_cc_gasto ||
    p.tesoreria_admin ||
    (p as any).tesoreria_can_register_ingreso === true ||
    p.npa_can_admin
  )
  const { permissions, role, userId } = gate
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [ubicacion, setUbicacion] = useState<MyUbicacion | null>(null)
const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)
  // Bancarizaciones snapshot (NEW 2026-05-26)
  const [bancEnTransito, setBancEnTransito] = useState<{ count: number; total: number }>({ count: 0, total: 0 })
  const [bancSaldoNeto, setBancSaldoNeto] = useState<number>(0)  // Bancarizaciones snapshot (NEW 2026-05-26)
  useEffect(() => {
    if (gate.status === 'denied') {
      router.replace('/dashboard')
      return
    }
    if (gate.status === 'ok') {
      loadEverything()
    }
  // eslint-disable-next-line
  }, [gate.status, userId])

  async function loadEverything() {
    setLoading(true)
    try {
      // 1. User identity (email + a friendly display name from auth metadata if present)
      const { data: userData } = await supabase.auth.getUser()
      if (userData.user) {
        setEmail(userData.user.email || '')
        const meta = userData.user.user_metadata || {}
        setDisplayName(meta.full_name || meta.name || (userData.user.email || '').split('@')[0])
      }

      // 2. Find this user's assigned ubicación (where they're custodio)
      const { data: ubics } = await supabase
        .from('tesoreria_ubicaciones')
        .select('id, codigo, nombre, tipo, custodio_user_id, saldo_actual_usd, saldo_objetivo_usd')
        .eq('activa', true)
        .order('codigo')

      if (ubics && ubics.length > 0) {
        // Prefer the ubicación where this user is custodio.
        // Fall back to PC_MIRLA for users who aren't a designated custodio.
        const ownByUser = ubics.find((u: any) => u.custodio_user_id === userId)
        const fallback  = ubics.find((u: any) => u.codigo === 'PC_MIRLA') || ubics[0]
        setUbicacion((ownByUser || fallback) as MyUbicacion)
      }

      // 3. Pending comprobantes for the queue tile subtitle
      //    Anyone with view_balance can see all PENDIENTE_PICKUP.
      //    Pickup-permission users see this count in the Escanear QR tile.
      const { count } = await supabase
        .from('tesoreria_comprobantes')
        .select('id', { count: 'exact', head: true })
        .eq('estado', 'PENDIENTE_PICKUP')
      setPendingCount(count || 0)
 
      // 4. Bancarizaciones snapshot — en tránsito + saldo neto
      const { data: enTransito } = await supabase
        .from('tesoreria_comprobantes')
        .select('monto_usd, monto_depositado, estado')
        .eq('egreso_tipo', 'BANCARIZACION')
        .in('estado', ['ENTREGADO_BANCARIZADOR', 'EN_PODER_MIRLA', 'SOLICITADO', 'DEPOSITADO_PARCIAL'])
      if (enTransito) {
        // DEPOSITADO_PARCIAL: only the un-deposited remainder is en transito.
        const total = enTransito.reduce((s: number, r: any) =>
          s + Math.max(0, (Number(r.monto_usd) || 0) - (r.estado === 'DEPOSITADO_PARCIAL' ? (Number(r.monto_depositado) || 0) : 0)), 0)
        setBancEnTransito({ count: enTransito.length, total })
      }
      const { data: bancs } = await supabase
        .from('bancarizadores')
        .select('saldo_usd')
        .eq('activo', true)
      if (bancs) {
        const saldo = bancs.reduce((s: number, r: any) => s + (Number(r.saldo_usd) || 0), 0)
        setBancSaldoNeto(saldo)
      }
    } catch (e) {
      // Non-fatal — let the page render with degraded data
      console.warn('[tesoreria/home] partial load failure:', e)
    }
    setLoading(false)
  }

  async function handleLogout() {
    try { await supabase.auth.signOut() } catch { /* ignore */ }
    try {
      Object.keys(localStorage).forEach(k => {
        if (k.startsWith('sb-')) localStorage.removeItem(k)
      })
    } catch { /* ignore */ }
    window.location.href = '/'
  }

  if (gate.status === 'error') {
    return <SessionErrorScreen homeHref="/" />
  }
  if (gate.status === 'loading' || gate.status === 'denied' || loading) {
    return (
      <div style={s.page}>
        <div style={s.topBar}>
          <div style={s.topBarTitle}>Motocentro Tesorería</div>
        </div>
        <div style={s.loading}>Cargando…</div>
      </div>
    )
  }

  // ── Build the tile set based on permissions ─────────────────────────────
  type Tile = {
    icon: React.ReactNode
    title: string
    subtitle: string
    onClick: () => void
    show: boolean
  }
  const tiles: Tile[] = [
    {
      icon: <Wallet size={22} strokeWidth={2.2} />,
      title: 'Nuevo Ingreso',
      subtitle: 'Recibir efectivo de un cliente',
      onClick: () => router.push('/tesoreria/ingresos/nuevo'),
      // NOTE: register_cc_gasto (Caja Chica only) intentionally does NOT grant
      // this — logging a petty-cash expense must not imply registering income.
      show: permissions.tesoreria_admin
         || permissions.tesoreria_can_view_balance
         || (permissions as any).tesoreria_can_register_ingreso === true
         || permissions.npa_can_admin,
    },
    {
      icon: <ArrowUpRight size={22} strokeWidth={2.2} />,
      title: 'Registrar Egreso',
      subtitle: 'Bancarización, caja chica, pagos',
      onClick: () => router.push('/tesoreria/egresos/nuevo'),
      // NOTE: register_cc_gasto (Caja Chica only) intentionally does NOT grant
      // this — the general egreso/bancarización flow is separate from petty cash.
      show: permissions.tesoreria_admin
         || permissions.tesoreria_can_view_balance
         || permissions.npa_can_admin
         || (permissions as any).tesoreria_can_request_salida === true,
    },
    {
      icon: <ScanLine size={22} strokeWidth={2.2} />,
      title: 'Escanear QR',
      subtitle: pendingCount > 0
        ? `${pendingCount} comprobante${pendingCount === 1 ? '' : 's'} pendiente${pendingCount === 1 ? '' : 's'} de pickup`
        : 'Confirmar recogida de efectivo',
      onClick: () => router.push('/tesoreria/scan'),
      show: permissions.tesoreria_can_pickup || permissions.tesoreria_admin || permissions.npa_can_admin,
    },
    {
      icon: <FileText size={22} strokeWidth={2.2} />,
      title: 'Mis Comprobantes',
      subtitle: 'Historial de ingresos y movimientos',
      onClick: () => router.push('/tesoreria/comprobantes'),
      show: true, // always
    },
    {
      icon: <Receipt size={22} strokeWidth={2.2} />,
      title: 'Registrar Gasto Caja Chica',
      subtitle: 'Café, papelería, mensajería…',
      onClick: () => router.push('/tesoreria/caja-chica'),
      show: permissions.tesoreria_can_register_cc_gasto || permissions.tesoreria_admin || permissions.npa_can_admin,
    },
    {
      icon: <ArrowLeftRight size={22} strokeWidth={2.2} />,
      title: 'Confirmar Cambio FX',
      subtitle: 'USD ↔ Bs · tasa pactada vs recibida',
      onClick: () => router.push('/tesoreria'), // TODO Phase 3.x: dedicated FX page
      show: permissions.tesoreria_can_confirm_fx || permissions.tesoreria_admin || permissions.npa_can_admin,
    },
    {
      icon: <Users size={22} strokeWidth={2.2} />,
      title: 'Bancarizadores',
      subtitle: 'Cuenta corriente · saldos · histórico',
      onClick: () => router.push('/tesoreria/bancarizadores'),
      show: permissions.tesoreria_can_view_balance
         || permissions.tesoreria_can_pickup
         || permissions.tesoreria_admin
         || permissions.npa_can_admin,
    },
    {
      icon: <BarChart3 size={22} strokeWidth={2.2} />,
      title: 'Reportes',
      subtitle: 'Movimientos · saldos · bancarizaciones · reconciliación',
      onClick: () => router.push('/tesoreria/reportes'),
      show: permissions.tesoreria_can_view_balance
         || permissions.tesoreria_can_pickup
         || permissions.tesoreria_admin
         || permissions.npa_can_admin,
    },
  ]
  const visibleTiles = tiles.filter(t => t.show)

  return (
    <div style={s.page}>

      {/* Top bar — minimal, no navigation */}
      <div style={s.topBar}>
        <div style={s.topBarTitle}>Motocentro Tesorería</div>
        <button onClick={handleLogout} style={s.topBarLogout} aria-label="Cerrar sesión">
          <LogOut size={12} strokeWidth={2.5} />
          Salir
        </button>
      </div>

      <div style={{ ...s.content, maxWidth: isMobile ? 480 : 900 }}>

        {/* Greeting */}
        <div style={s.greeting}>
          <div style={s.greetingHello}>
            Hola, {displayName || email || 'usuario'} 👋
          </div>
          {ubicacion && (
            <div style={s.greetingSub}>
              {ubicacion.nombre}
            </div>
          )}
        </div>

         {/* Saldo card — only show if user can view balance */}
        {ubicacion && (permissions.tesoreria_can_view_balance || permissions.tesoreria_admin || permissions.npa_can_admin) && (
          <div style={s.saldoCard}>
            <div style={s.saldoLabel}>Saldo actual · {ubicacion.codigo}</div>
            <div style={s.saldoAmount}>
              {fmt(ubicacion.saldo_actual_usd)}
            </div>
            <div style={s.saldoFooter}>
              <span>USD</span>
              {ubicacion.saldo_objetivo_usd && ubicacion.saldo_objetivo_usd > 0 && (
                <span>Objetivo: {fmt(ubicacion.saldo_objetivo_usd)}</span>
              )}
            </div>
          </div>
        )}
 
        {/* Bancarizaciones snapshot (NEW 2026-05-26) */}
        {(permissions.tesoreria_can_view_balance || permissions.tesoreria_admin || permissions.npa_can_admin) && (
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16,
          }}>
            <button
              onClick={() => router.push('/tesoreria/reportes/bancarizaciones')}
              style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderLeft: '4px solid #D97706', borderRadius: 10, padding: '12px 14px',
                cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>
                En tránsito
              </div>
              <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--text-primary)', marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                {fmt(bancEnTransito.total)}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                {bancEnTransito.count} bancarizacion{bancEnTransito.count === 1 ? '' : 'es'} pendiente{bancEnTransito.count === 1 ? '' : 's'}
              </div>
            </button>
            <button
              onClick={() => router.push('/tesoreria/bancarizadores')}
              style={{
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderLeft: '4px solid ' + (bancSaldoNeto > 0 ? '#16A34A' : bancSaldoNeto < 0 ? '#BB162B' : 'var(--text-muted)'),
                borderRadius: 10, padding: '12px 14px',
                cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
              }}
            >
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1.2, fontWeight: 700 }}>
                Saldo bancarizadores
              </div>
              <div style={{
                fontSize: 20, fontWeight: 800,
                color: bancSaldoNeto > 0 ? '#16A34A' : bancSaldoNeto < 0 ? '#BB162B' : 'var(--text-primary)',
                marginTop: 2, fontVariantNumeric: 'tabular-nums',
              }}>
                {bancSaldoNeto >= 0 ? '+' : '-'}${Math.abs(bancSaldoNeto).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                {bancSaldoNeto > 0 ? 'nos deben' : bancSaldoNeto < 0 ? 'les debemos' : 'sin saldo abierto'}
              </div>
            </button>
          </div>
        )}
 
        {/* Action tiles */}

        <div style={isMobile ? s.tilesGrid : { ...s.tilesGrid, display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
          {visibleTiles.map((tile, i) => (
            <button
              key={i}
              onClick={tile.onClick}
              style={s.tile}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = '#BB162B66' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)' }}
            >
              <div style={s.tileIcon}>{tile.icon}</div>
              <div style={s.tileBody}>
                <div style={s.tileTitle}>{tile.title}</div>
                <div style={s.tileSubtitle}>{tile.subtitle}</div>
              </div>
              <div style={s.tileChevron}>›</div>
            </button>
          ))}
        </div>

        {/* Admin escape hatch — treasury PWA users who are also admins can
            reach the full desktop dashboard from their phone if needed. */}
        {(permissions.npa_can_admin || permissions.tesoreria_admin) && (
          <button
            onClick={() => router.push('/dashboard')}
            style={{
              marginTop: 18, width: '100%', padding: '12px',
              background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 10, fontSize: 13, fontWeight: 600,
              color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >
            Ir al Dashboard completo ›
          </button>
        )}

      </div>
    </div>
  )
}