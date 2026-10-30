// A modal confirm step for actions that reach every phone (start alarm, all clear).
import { useEffect, useId, useRef, type ReactNode } from 'react'

type Props = {
  open: boolean
  title: string
  children?: ReactNode
  confirmLabel: string
  tone?: 'danger' | 'go' | 'primary'
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  className?: string
}

export default function Confirm({ open, title, children, confirmLabel, tone = 'primary', busy, onConfirm, onCancel, className }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className={`cr-dialog ${className ?? ''}`} aria-labelledby={`${id}-t`} onClose={onCancel} onCancel={onCancel}>
      <h2 id={`${id}-t`} className="cr-dialog-title">{title}</h2>
      <div className="cr-dialog-body">{children}</div>
      <div className="cr-dialog-actions">
        <button type="button" className="pf-btn" onClick={onCancel} autoFocus>Cancel</button>
        <button type="button" className={`pf-btn ${tone}`} onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </dialog>
  )
}
