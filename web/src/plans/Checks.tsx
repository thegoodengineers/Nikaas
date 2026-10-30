// Checks: the validator's problems (must be fixed before saving) and the graph quality score with its
// warnings. Ids mentioned in a message are buttons that select that node.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Building } from '../platform/api.ts'
import { cleanBuilding, idsIn } from './model.ts'
import type { WidthIssue } from './widths.ts'

type QaWarning = { code: string; severity: string; message: string; elements?: string[]; suggestion?: string }
type Qa = { status: string; score: number; warnings: QaWarning[] }
type Result = { problems: string[]; qa: Qa | null; qaErr: string; of: Building }

type Props = { building: Building; onPick: (id: string) => void; label: (id: string) => string; widths?: WidthIssue[]; onPickEdge?: (i: number) => void }

export default function Checks({ building, onPick, label, widths = [], onPickEdge }: Props) {
  const [res, setRes] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const latest = useRef(building)
  useEffect(() => { latest.current = building }, [building])

  const run = useCallback(async () => {
    const b = latest.current
    setBusy(true); setErr('')
    try {
      const body = { building: cleanBuilding(b) }
      const [v, q] = await Promise.allSettled([api.post<{ ok: boolean; problems: string[] }>('/validate', body), api.post<Qa>('/qa', body)])
      if (v.status === 'rejected') throw v.reason
      setRes({ problems: v.value.problems, qa: q.status === 'fulfilled' ? q.value : null, qaErr: q.status === 'rejected' ? String(q.reason?.message ?? q.reason) : '', of: b })
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])
  useEffect(() => { void Promise.resolve().then(run) }, [run])

  const ids = new Set(building.nodes.map(n => n.id))
  const chips = (list: string[]) => list.filter(id => ids.has(id)).slice(0, 8).map(id => (
    <button key={id} className="pl-idchip" onClick={() => onPick(id)} title={id}>{label(id)}</button>
  ))
  const stale = res && res.of !== building
  const qa = res?.qa
  const tone = (s: string) => (s === 'critical' || s === 'error' ? 'bad' : s === 'warning' ? 'warn' : s === 'pass' || s === 'ok' ? 'ok' : 'info')

  return (
    <div className="pf-stack pl-checks">
      <div className="pf-row">
        {res && (res.problems.length ? <span className="pf-chip bad">{res.problems.length} to fix</span> : <span className="pf-chip ok">Valid</span>)}
        {qa && <span className={`pf-chip ${tone(qa.status)}`}>Quality {Math.round(qa.score)}/100</span>}
        <span className="pf-grow" />
        <button className="pf-btn" onClick={() => void run()} disabled={busy}>{busy ? 'Checking…' : stale ? 'Check again' : 'Check'}</button>
      </div>
      {stale && <p className="pf-small pf-muted">Edited since the last check.</p>}
      {err && <div className="pf-alert bad">{err}</div>}
      {res && res.problems.length > 0 && (
        <ul className="pl-issues">
          {res.problems.map((p, k) => <li key={k} className="bad"><p>{p}</p><div className="pl-chips">{chips(idsIn(p, ids))}</div></li>)}
        </ul>
      )}
      {res && res.problems.length === 0 && <p className="pf-small pf-muted">The building is valid and can be saved and simulated.</p>}
      {res?.qaErr && <p className="pf-small pf-muted">Quality check unavailable: {res.qaErr}</p>}
      {widths.length > 0 && (
        <>
          <p className="pf-eyebrow">Widths to look at ({widths.length})</p>
          <ul className="pl-issues">
            {widths.map((w, k) => (
              <li key={k} className={w.level}>
                <p>{w.text}</p>
                {onPickEdge && <div className="pl-chips"><button className="pl-idchip" onClick={() => onPickEdge(w.edge)}>Show link</button></div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {qa && qa.warnings.length > 0 && (
        <ul className="pl-issues">
          {qa.warnings.map((w, k) => (
            <li key={k} className={tone(w.severity)}>
              <p><span className={`pf-chip ${tone(w.severity)}`}>{w.severity}</span> {w.message}</p>
              {w.suggestion && <p className="pf-small pf-muted">{w.suggestion}</p>}
              <div className="pl-chips">{chips(w.elements?.length ? w.elements.flatMap(e => idsIn(String(e), ids)) : idsIn(w.message, ids))}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
