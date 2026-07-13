// TARGET: autocore-p1/app/lib/phone.ts
// ═══════════════════════════════════════════════════════════════════════════
// Phone handling for the broker's two markets: US (+1, Miami) and Venezuela
// (+58). Numbers are STORED in E.164 (+13055551234 / +584121234567) so
// wa.me links, search, and dedup work regardless of how they were typed.
//
// Ambiguity note: a bare 10-digit number can be valid in BOTH countries
// (US area code 412 = Pittsburgh, VE 412 = Movilnet), so forms carry an
// explicit country selector; detectCountry() only claims the unambiguous
// shapes (+58/58…, +1/1…, 0-prefixed VE local).
// ═══════════════════════════════════════════════════════════════════════════

export type PhoneCountry = 'US' | 'VE'

export const PHONE_COUNTRIES: { key: PhoneCountry; label: string; prefix: string }[] = [
  { key: 'US', label: 'US +1', prefix: '+1' },
  { key: 'VE', label: 'VE +58', prefix: '+58' },
]

const digits = (v: string) => String(v || '').replace(/\D/g, '')

// Country detection for numbers whose shape is unambiguous; null otherwise.
export function detectCountry(raw: string): PhoneCountry | null {
  const t = String(raw || '').trim()
  const d = digits(t)
  if (t.startsWith('+58') || (d.length === 12 && d.startsWith('58'))) return 'VE'
  if (t.startsWith('+1') || (d.length === 11 && d.startsWith('1'))) return 'US'
  if (d.length === 11 && d.startsWith('0')) return 'VE' // 04121234567 local VE
  return null
}

// Normalize to E.164 under an explicit country. Returns null when the number
// cannot be a valid phone for that country.
export function toE164(raw: string, country: PhoneCountry): string | null {
  const t = String(raw || '').trim()
  const d = digits(t)
  if (!d) return null

  // Explicit international input ("+...") wins over the selector.
  if (t.startsWith('+')) {
    if (d.startsWith('58') && d.length === 12) return '+' + d
    if (d.startsWith('1') && d.length === 11) return '+' + d
    // Other countries: pass through if it looks like a plausible E.164.
    return d.length >= 8 && d.length <= 15 ? '+' + d : null
  }

  if (country === 'VE') {
    if (d.length === 12 && d.startsWith('58')) return '+' + d
    if (d.length === 11 && d.startsWith('0')) return '+58' + d.slice(1) // 0412…
    if (d.length === 10) return '+58' + d                               // 412…
    return null
  }
  // US
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  if (d.length === 10 && /[2-9]/.test(d[0])) return '+1' + d
  return null
}

// Detect when unambiguous, else fall back to the given default country.
export function normalizePhone(raw: string, dflt: PhoneCountry = 'US'): string | null {
  return toE164(raw, detectCountry(raw) || dflt)
}

// Digits-only international number for https://wa.me/<digits> links. For
// values that don't normalize (legacy/imported data), falls back to a bare
// digit strip so the link is at least as good as before.
export function waDigits(raw: string, dflt: PhoneCountry = 'US'): string {
  const e = normalizePhone(raw, dflt)
  return e ? e.slice(1) : digits(raw)
}

// Pretty display: +1 (305) 555-1234 · +58 412-123-4567 · raw fallback.
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const t = String(raw).trim()
  const d = digits(t)
  if ((t.startsWith('+58') || d.startsWith('58')) && d.length === 12) {
    return `+58 ${d.slice(2, 5)}-${d.slice(5, 8)}-${d.slice(8)}`
  }
  if ((t.startsWith('+1') && d.length === 11) || (d.length === 11 && d.startsWith('1'))) {
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  }
  return t
}
