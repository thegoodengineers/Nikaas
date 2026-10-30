// Print one part of the page: the content is rendered into a layer on <body>, everything else is hidden
// while the print dialog is open (see .cr-print in control.css).
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export default function usePrint() {
  const [job, setJob] = useState<{ node: ReactNode; kind: string } | null>(null)
  useEffect(() => {
    if (!job) return
    const body = document.body
    body.classList.add('cr-printing')
    const done = () => setJob(null)
    addEventListener('afterprint', done)
    const t = setTimeout(() => window.print(), 80) // let the layer render and the QR images lay out first
    return () => { clearTimeout(t); removeEventListener('afterprint', done); body.classList.remove('cr-printing') }
  }, [job])
  const layer = job ? createPortal(<div className={`cr-print cr-print-${job.kind}`}>{job.node}</div>, document.body) : null
  const print = (node: ReactNode, kind = 'sheet') => setJob({ node, kind })
  return [layer, print] as const
}
