// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/useIsMobile.ts
// v1 (2026-05-19) — Tesorería mobile-hardening.
//
// The Tesorería module is used mostly on phone browsers (tesorero, manager,
// admin). The dashboard / comprobante / ingreso / egreso pages were built
// desktop-first with fixed multi-column grids that overflow on ~380px
// screens. Rather than pull in a CSS framework, pages read this hook and
// pick layout values (grid columns, max-width, whether to show the desktop
// NavBar) from a single boolean.
//
// SSR-safe: returns false during server render / first paint, then corrects
// on mount. That's fine — a brief desktop-layout flash on a phone is far
// better than a hydration mismatch crash.
//
// USAGE:
//   const isMobile = useIsMobile()          // default breakpoint 640px
//   const isMobile = useIsMobile(768)       // custom breakpoint
//   <div style={{ gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
// ═══════════════════════════════════════════════════════════════════════════
'use client'

import { useEffect, useState } from 'react'

export function useIsMobile(breakpointPx: number = 640): boolean {
  // Start false — server render and first client paint agree (no hydration
  // mismatch). Corrected synchronously on mount before paint where possible.
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return

    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`)
    const apply = () => setIsMobile(mq.matches)

    apply() // correct immediately on mount

    // Browser back/forward can restore a page from the bfcache WITHOUT remounting
    // the component, so the effect above doesn't re-run and the layout can be
    // left stale (e.g. a desktop page showing the narrow mobile layout). pageshow
    // fires on every bfcache restore — re-measure there too.
    const onPageShow = () => apply()
    window.addEventListener('pageshow', onPageShow)

    // addEventListener is the modern API; older Safari used addListener.
    if (mq.addEventListener) {
      mq.addEventListener('change', apply)
      return () => { window.removeEventListener('pageshow', onPageShow); mq.removeEventListener('change', apply) }
    } else {
      // @ts-ignore — legacy fallback
      mq.addListener(apply)
      // @ts-ignore
      return () => { window.removeEventListener('pageshow', onPageShow); mq.removeListener(apply) }
    }
  }, [breakpointPx])

  return isMobile
}