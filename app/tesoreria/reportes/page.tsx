// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/tesoreria/reportes/page.tsx
// AutoCore NPA — Tesorería Reports — hub
//
// Tiles for each of the 5 reports. Permission gate:
//   tesoreria_can_view_balance OR tesoreria_can_pickup OR tesoreria_admin OR npa_can_admin
// Angeles + Deisi are EXCLUDED (they have only tesoreria_can_register_ingreso).
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  BookOpen, TrendingUp, Building2, Wallet, CheckSquare, ChevronLeft,
} from 'lucide-react'
import AdminShell from '../../components/AdminShell'
import { useAuthGate } from '../../components/useAuthGate'
import SessionErrorScreen from '../../components/SessionErrorScreen'

const NAVY = '#0D2257'
const GOLD = '#C49A2A'

interface Tile {
  href: string
  icon: React.ReactNode
  title: string
  subtitle: string
}

const TILES: Tile[] = [
  {
    href: '/tesoreria/reportes/movimientos',
    icon: <BookOpen size={26} strokeWidth={2} />,
    title: 'Movimientos',
    subtitle: 'Libro de ingresos y egresos · filtros · export',
  },
  {
    href: '/tesoreria/reportes/posicion',
    icon: <TrendingUp size={26} strokeWidth={2} />,
    title: 'Posición de Caja',
    subtitle: 'Evolución de saldos · diaria, semanal, mensual',
  },
  {
    href: '/tesoreria/reportes/bancarizaciones',
    icon: <Building2 size={26} strokeWidth={2} />,
    title: 'Bancarizaciones',
    subtitle: 'Depósitos por banco · tiempo en tránsito · estado',
  },
  {
    href: '/tesoreria/reportes/caja-chica',
    icon: <Wallet size={26} strokeWidth={2} />,
    title: 'Caja Chica',
    subtitle: 'Gastos del mes por categoría · reposiciones',
  },
  {
    href: '/tesoreria/reportes/reconciliacion',
    icon: <CheckSquare size={26} strokeWidth={2} />,
    title: 'Reconciliación',
    subtitle: 'Teórico vs físico vs banco · cierre de periodo',
  },
]

export default function TesoreriaReportesHub() {
  const router = useRouter()
  const gate = useAuthGate(p =>
    p.tesoreria_can_view_balance ||
    p.tesoreria_can_pickup ||
    p.tesoreria_admin ||
    p.npa_can_admin
  )

  useEffect(() => {
    if (gate.status === 'denied') {
      router.replace('/tesoreria/home')
    }
  }, [gate.status, router])

  if (gate.status === 'loading') {
    return (
      <AdminShell active="tesoreria">
        <div style={{ padding: 60, textAlign: 'center', color: '#71717A' }}>Cargando…</div>
      </AdminShell>
    )
  }
  if (gate.status === 'error') return <SessionErrorScreen homeHref="/tesoreria/home" />
  if (gate.status !== 'ok') return null

  return (
    <AdminShell active="tesoreria">
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 24px' }}>
        <button
          onClick={() => router.push('/tesoreria/home')}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'transparent', border: 'none', color: NAVY,
            fontSize: 13, cursor: 'pointer', marginBottom: 16,
          }}
        >
          <ChevronLeft size={16} /> Volver al Dashboard
        </button>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700 }}>
            Tesorería
          </div>
          <div style={{ fontSize: 28, fontWeight: 800, color: NAVY }}>Reportes</div>
          <div style={{ fontSize: 13, color: '#52525B', marginTop: 4 }}>
            Análisis y consulta histórica de la operación de caja.
          </div>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 16,
        }}>
          {TILES.map(t => (
            <button
              key={t.href}
              onClick={() => router.push(t.href)}
              style={{
                background: '#fff',
                border: '1px solid #E5E2D8',
                borderLeft: '4px solid ' + GOLD,
                borderRadius: 8,
                padding: '20px 18px',
                textAlign: 'left',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                transition: 'transform 0.12s, box-shadow 0.12s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'
                ;(e.currentTarget as HTMLElement).style.boxShadow = '0 6px 18px rgba(0,0,0,0.08)'
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'
                ;(e.currentTarget as HTMLElement).style.boxShadow = 'none'
              }}
            >
              <div style={{ color: NAVY }}>{t.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: NAVY }}>{t.title}</div>
              <div style={{ fontSize: 12, color: '#52525B', lineHeight: 1.4 }}>{t.subtitle}</div>
            </button>
          ))}
        </div>
      </div>
    </AdminShell>
  )
}