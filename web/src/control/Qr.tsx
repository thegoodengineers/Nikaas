// A QR code as inline SVG (vendored generator, no network).
import { useMemo } from 'react'
import qrcode from '../vendor/qrcode/qrcode.mjs'

export default function Qr({ url, label, className }: { url: string; label: string; className?: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M')
    q.addData(url)
    q.make()
    return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }) as string
  }, [url])
  return <span className={`cr-qr ${className ?? ''}`} role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />
}
