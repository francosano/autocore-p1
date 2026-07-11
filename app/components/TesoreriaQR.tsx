// ═══════════════════════════════════════════════════════════════════════════
// TARGET: autocore-npa/app/components/TesoreriaQR.tsx
// Renders a QR code as inline SVG. Uses `qrcode-generator` (~10KB).
//
// INSTALL FIRST: cd autocore-npa && npm i qrcode-generator
// ═══════════════════════════════════════════════════════════════════════════
'use client'
import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

interface Props {
  payload: string
  size?: number       // pixel size of rendered SVG (default 200)
  margin?: number     // quiet-zone modules around the QR (default 2)
}

export default function TesoreriaQR({ payload, size = 200, margin = 2 }: Props) {
  const { matrix, count } = useMemo(() => {
    try {
      const qr = qrcode(0, 'M')
      qr.addData(payload)
      qr.make()
      const c = qr.getModuleCount()
      const m: boolean[][] = []
      for (let y = 0; y < c; y++) {
        m[y] = []
        for (let x = 0; x < c; x++) m[y][x] = qr.isDark(y, x)
      }
      return { matrix: m, count: c }
    } catch (e) {
      console.error('QR encode failed:', e)
      return { matrix: [] as boolean[][], count: 0 }
    }
  }, [payload])

  if (!count) {
    return (
      <div style={{
        width: size, height: size,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#fff', color: '#BB162B', border: '2px solid #BB162B',
        borderRadius: 8, fontSize: 12,
      }}>
        Error generando QR
      </div>
    )
  }

  const totalSize = count + margin * 2

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${totalSize} ${totalSize}`}
      shapeRendering="crispEdges"
      style={{ background: '#fff', borderRadius: 8, display: 'block' }}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x={0} y={0} width={totalSize} height={totalSize} fill="#fff" />
      {matrix.flatMap((row, y) =>
        row.map((dark, x) =>
          dark ? (
            <rect key={`${x}-${y}`} x={x + margin} y={y + margin} width={1} height={1} fill="#000" />
          ) : null
        )
      )}
    </svg>
  )
}