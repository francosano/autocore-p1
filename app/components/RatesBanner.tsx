// app/components/RatesBanner.tsx
//
// Live rates banner: BCV + Binance + Spread + last update
// Renders below NavBar on every page. Reads from autocore-rates worker.
// Refreshes every 5 minutes. Hides silently if fetch fails.

'use client'

import { useEffect, useState } from 'react'

const RATES_URL = 'https://autocore-rates.sano-franco.workers.dev/latest'
const REFRESH_INTERVAL_MS = 5 * 60 * 1000  // 5 minutes

interface RateRow {
  fecha: string
  rate_usdt_ves?: number
  rate_usd_ves?: number
  fetched_at: string
  source: string
}

interface RatesData {
  binance: RateRow | null
  bcv: RateRow | null
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffSec = Math.floor((now - then) / 1000)
  if (diffSec < 60) return `${diffSec}s`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  return `${Math.floor(diffHr / 24)}d`
}

function fmtRate(n: number | undefined): string {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function RatesBanner() {
  const [data, setData] = useState<RatesData | null>(null)
  const [error, setError] = useState(false)
  const [tick, setTick] = useState(0)  // forces re-render of relative time

  // Fetch on mount + every 5 minutes
  useEffect(() => {
    let mounted = true

    async function fetchRates() {
      try {
        const res = await fetch(RATES_URL, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (mounted) {
          setData(json)
          setError(false)
        }
      } catch (e) {
        if (mounted) setError(true)
      }
    }

    fetchRates()
    const interval = setInterval(fetchRates, REFRESH_INTERVAL_MS)
    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  // Tick every 30s to update "X minutes ago" display
  useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 30 * 1000)
    return () => clearInterval(t)
  }, [])

  // Silent hide on error or no data
  if (error || !data || (!data.binance && !data.bcv)) {
    return null
  }

  const bcvRate = data.bcv?.rate_usd_ves
  const binanceRate = data.binance?.rate_usdt_ves
  const spreadPct = (bcvRate && binanceRate && bcvRate > 0)
    ? ((binanceRate / bcvRate - 1) * 100)
    : null

  const spreadColor = spreadPct == null ? '#9CA3AF'
    : spreadPct >= 20 ? '#16A34A'
    : spreadPct >= 10 ? '#D97706'
    : '#BB162B'

  // Use the more recent of the two timestamps for "updated" indicator
  const newestFetch = [data.bcv?.fetched_at, data.binance?.fetched_at]
    .filter(Boolean)
    .sort()
    .reverse()[0]

  void tick  // satisfy linter (used for re-render only)

  return (
    <div style={{
      background: 'linear-gradient(90deg, #0D2257 0%, #1B4AAA 100%)',
      color: '#fff',
      padding: '6px 28px',
      display: 'flex',
      alignItems: 'center',
      gap: 24,
      fontSize: 12,
      fontFamily: 'system-ui, -apple-system, sans-serif',
      letterSpacing: '0.02em',
      borderBottom: '1px solid rgba(196, 154, 42, 0.3)',
      whiteSpace: 'nowrap',
      overflowX: 'auto',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ opacity: 0.7, fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>
          BCV
        </span>
        <span style={{ fontWeight: 700, color: '#F5ECC8' }}>
          {fmtRate(bcvRate)}
        </span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>Bs/USD</span>
      </div>

      <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ opacity: 0.7, fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>
          BINANCE
        </span>
        <span style={{ fontWeight: 700, color: '#F5ECC8' }}>
          {fmtRate(binanceRate)}
        </span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>Bs/USDT</span>
      </div>

      <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.2)' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ opacity: 0.7, fontSize: 10, letterSpacing: '0.1em', fontWeight: 600 }}>
          SPREAD
        </span>
        <span style={{
          fontWeight: 700,
          color: spreadColor,
          background: 'rgba(255,255,255,0.08)',
          padding: '2px 8px',
          borderRadius: 4,
        }}>
          {spreadPct == null ? '—' : `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}%`}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {newestFetch && (
        <div style={{
          opacity: 0.6,
          fontSize: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#16A34A',
            boxShadow: '0 0 6px rgba(22, 163, 74, 0.6)',
          }} />
          actualizado hace {timeAgo(newestFetch)}
        </div>
      )}
    </div>
  )
}