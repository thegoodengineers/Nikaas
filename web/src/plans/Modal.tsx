// A small dialog with a form: Enter submits, Escape cancels.
import { useEffect, useRef, type ReactNode } from 'react'

type Props = { title: string; children: ReactNode; onSubmit: () => void; onCancel: () => void; submit?: string; busy?: boolean; wide?: boolean }

export default function Modal({ title, children, onSubmit, onCancel, submit = 'OK', busy, wide }: Props) {
  const box = useRef<HTMLFormElement>(null)
  const cancel = useRef(onCancel)
  useEffect(() => { cancel.current = onCancel }, [onCancel])
  useEffect(() => {
    const first = box.current?.querySelector<HTMLElement>('input, select, textarea, button')
    first?.focus()
    if (first instanceof HTMLInputElement) first.select()
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); cancel.current() } }
    addEventListener('keydown', key, true)
    return () => removeEventListener('keydown', key, true)
  }, [])
  return (
    <div className="pl-modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onCancel() }}>
      <form ref={box} className={`pl-modal pf-card ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}
        onSubmit={e => { e.preventDefault(); if (!busy) onSubmit() }}>
        <h3>{title}</h3>
        <div className="pf-stack">{children}</div>
        <div className="pl-modal-actions">
          <button type="button" className="pf-btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="pf-btn primary" disabled={busy}>{busy ? 'Working…' : submit}</button>
        </div>
      </form>
    </div>
  )
}
