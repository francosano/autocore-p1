// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/ReportShell.tsx
// AutoCore NPA — Tesorería Reports — shared shell
//
// Header bar with date range picker, ubicación multi-select, and export
// buttons. Each report page wraps its content in <ReportShell>.
//
// AutoCore brand: navy #0D2257 header, gold #C49A2A accents.
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useState, useEffect } from 'react'
import { ChevronLeft, Download, FileText, Calendar, Filter } from 'lucide-react'
import { useRouter } from 'next/navigation'
import AdminShell from './AdminShell'
import {
  type DateRange, type RangePresetKey,
  rangeForPreset, toISODate,
  type Ubicacion,
} from '../lib/tesoreriaReports'

interface ReportShellProps {
  title: string
  subtitle?: string
  range: DateRange
  onRangeChange: (r: DateRange) => void
  ubicaciones: Ubicacion[]
  selectedUbicacionIds: string[]
  onUbicacionChange: (ids: string[]) => void
  onExportExcel?: () => void
  onExportPDF?: () => void
  children: React.ReactNode
  backHref?: string
}

const NAVY = '#0D2257'
const GOLD = '#C49A2A'

export default function ReportShell({
  title, subtitle, range, onRangeChange,
  ubicaciones, selectedUbicacionIds, onUbicacionChange,
  onExportExcel, onExportPDF,
  children, backHref = '/tesoreria/reportes',
}: ReportShellProps) {
  const router = useRouter()
  const [ubicMenuOpen, setUbicMenuOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)

  // Close ubic menu on outside click
  useEffect(() => {
    if (!ubicMenuOpen) return
    function onClick(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (!t.closest('[data-ubic-menu]')) setUbicMenuOpen(false)
    }
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [ubicMenuOpen])

  const presetButton = (key: RangePresetKey, label: string) => (
    <button
      key={key}
      onClick={() => onRangeChange(rangeForPreset(key))}
      style={{
        padding: '6px 12px',
        background: range.preset === key ? NAVY : 'transparent',
        color: range.preset === key ? '#fff' : NAVY,
        border: '1px solid ' + NAVY,
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >{label}</button>
  )

  const allSelected = selectedUbicacionIds.length === 0 || selectedUbicacionIds.length === ubicaciones.length

  return (
    <AdminShell active="tesoreria">
    <div style={{ minHeight: '100vh', background: '#F5F1E8', fontFamily: 'sans-serif' }}>
      {/* Header bar */}
      <div style={{
        background: NAVY,
        color: '#fff',
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        borderBottom: '3px solid ' + GOLD,
      }}>
        <button
          onClick={() => router.push(backHref)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: 'transparent', border: 'none', color: '#fff',
            fontSize: 13, cursor: 'pointer',
          }}
        >
          <ChevronLeft size={16} /> Volver
        </button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: GOLD, textTransform: 'uppercase', letterSpacing: 2, fontWeight: 700 }}>
            Tesorería · Reportes
          </div>
          <div style={{ fontSize: 20, fontWeight: 800 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, opacity: 0.85, marginTop: 2 }}>{subtitle}</div>}
        </div>
        {onExportExcel && (
          <button onClick={onExportExcel} style={btnExport(GOLD)}>
            <Download size={14} /> Excel
          </button>
        )}
        {onExportPDF && (
          <button onClick={onExportPDF} style={btnExport('#fff')}>
            <FileText size={14} /> PDF
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div style={{
        background: '#fff',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        flexWrap: 'wrap',
        borderBottom: '1px solid #E5E2D8',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: NAVY }}>
          <Calendar size={14} />
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>Rango</span>
        </div>
        {presetButton('hoy', 'Hoy')}
        {presetButton('semana', 'Esta semana')}
        {presetButton('mes', 'Este mes')}
        {presetButton('quincena', 'Quincena')}
        {presetButton('mes_pasado', 'Mes pasado')}

        <button
          onClick={() => setCustomOpen(o => !o)}
          style={{
            padding: '6px 12px',
            background: range.preset === 'custom' ? NAVY : 'transparent',
            color: range.preset === 'custom' ? '#fff' : NAVY,
            border: '1px solid ' + NAVY,
            borderRadius: 6,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {range.preset === 'custom'
            ? `${formatRangeShort(range.from)} → ${formatRangeShort(range.to)}`
            : 'Custom'}
        </button>

        {customOpen && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={e => onRangeChange({ ...range, from: e.target.value, preset: 'custom' })}
              style={dateInput}
            />
            <span>→</span>
            <input
              type="date"
              value={range.to}
              min={range.from}
              max={toISODate(new Date())}
              onChange={e => onRangeChange({ ...range, to: e.target.value, preset: 'custom' })}
              style={dateInput}
            />
          </div>
        )}

        {/* Ubicación filter */}
        <div style={{ marginLeft: 'auto', position: 'relative' }} data-ubic-menu>
          <button
            onClick={() => setUbicMenuOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px',
              background: '#fff',
              color: NAVY,
              border: '1px solid ' + NAVY,
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <Filter size={14} />
            {allSelected
              ? 'Todas las ubicaciones'
              : `${selectedUbicacionIds.length} ubicación${selectedUbicacionIds.length === 1 ? '' : 'es'}`}
          </button>
          {ubicMenuOpen && (
            <div style={{
              position: 'absolute',
              top: '110%',
              right: 0,
              minWidth: 220,
              background: '#fff',
              border: '1px solid ' + NAVY,
              borderRadius: 6,
              padding: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              zIndex: 10,
            }}>
              <label style={ubicItem}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onUbicacionChange(allSelected ? [ubicaciones[0]?.id].filter(Boolean) as string[] : [])}
                /> Todas
              </label>
              <div style={{ borderTop: '1px solid #E5E2D8', margin: '6px 0' }} />
              {ubicaciones.map(u => {
                const checked = selectedUbicacionIds.length === 0 || selectedUbicacionIds.includes(u.id)
                return (
                  <label key={u.id} style={ubicItem}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        if (selectedUbicacionIds.length === 0) {
                          // "All" → uncheck this one
                          onUbicacionChange(ubicaciones.filter(x => x.id !== u.id).map(x => x.id))
                        } else if (checked) {
                          onUbicacionChange(selectedUbicacionIds.filter(id => id !== u.id))
                        } else {
                          onUbicacionChange([...selectedUbicacionIds, u.id])
                        }
                      }}
                    /> {u.codigo} · {u.nombre}
                  </label>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: '24px', maxWidth: 1400, margin: '0 auto' }}>
        {children}
      </div>
    </div>
    </AdminShell>
  )
}

function btnExport(border: string): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '6px 12px',
    background: 'transparent',
    color: '#fff',
    border: '1px solid ' + border,
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  }
}

const dateInput: React.CSSProperties = {
  padding: '4px 8px',
  border: '1px solid ' + NAVY,
  borderRadius: 4,
  fontSize: 12,
  fontFamily: 'inherit',
}

const ubicItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 4px',
  fontSize: 12,
  cursor: 'pointer',
}

function formatRangeShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
}