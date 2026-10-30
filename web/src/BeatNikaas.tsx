import { useEffect, useState } from 'react'

type Node = { id: string; type: string; label?: string }
type Props = { api: string; building: { nodes: Node[] }; blocked: string[]; startPlan?: Record<string, string> }
type Result = { judge_time_s: number; nikaas_time_s: number; lower_bound_s: number; gap_s: number; beat_nikaas: boolean }

// "Beat Nikaas": a judge assigns every room an exit by hand; POST /beat times it against the optimiser.
export default function BeatNikaas({ api, building, blocked, startPlan }: Props) {
  const rooms = building.nodes.filter(n => n.type === 'room')
  const exits = building.nodes.filter(n => n.type === 'exit' && !blocked.includes(n.id))
  const [plan, setPlan] = useState<Record<string, string>>({})
  const [res, setRes] = useState<Result>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    // start from today's nearest-exit plan, dropping any exit that is now blocked
    const p: Record<string, string> = {}
    for (const r of rooms) {
      const e = startPlan?.[r.id]
      p[r.id] = e && !blocked.includes(e) ? e : exits[0]?.id
    }
    setPlan(p); setRes(undefined); setErr('')
  }, [building, blocked.join('+'), startPlan]) // eslint-disable-line react-hooks/exhaustive-deps

  async function run() {
    setBusy(true); setErr(''); setRes(undefined)
    try {
      const r = await fetch(`${api}/beat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ building, plan, blocked }) })
      if (!r.ok) throw new Error(`Server error ${r.status}`)
      setRes(await r.json())
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  if (!api) return null
  return (
    <section style={{ background: 'var(--card)', border: '1px solid var(--line)', padding: 16, marginTop: 16 }}>
      <h2 className="sub" style={{ fontFamily: 'var(--serif)', fontSize: 28, margin: '0 0 4px' }}>Beat Nikaas</h2>
      <p style={{ color: 'var(--muted)', margin: '0 0 12px' }}>Send each room to an exit yourself. Can you empty the building faster than the optimiser?</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
        {rooms.map(r => (
          <label key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 14, alignItems: 'center' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label ?? r.id}</span>
            <select value={plan[r.id] ?? ''} onChange={e => setPlan(p => ({ ...p, [r.id]: e.target.value }))} style={{ font: 'inherit', padding: 4 }}>
              {exits.map(x => <option key={x.id} value={x.id}>{x.label ?? x.id}</option>)}
            </select>
          </label>
        ))}
      </div>
      <button className="on" style={{ marginTop: 12 }} disabled={busy} onClick={run}>{busy ? 'Timing your plan…' : 'Time my plan'}</button>
      {err && <p role="alert" style={{ color: 'var(--queue)' }}>{err}</p>}
      {res && (
        <div style={{ marginTop: 12, fontSize: 16 }}>
          <b style={{ fontFamily: 'var(--serif)', fontSize: 24, color: res.beat_nikaas ? 'var(--accent)' : 'var(--ink)' }}>
            {res.beat_nikaas ? 'You beat Nikaas!' : `Nikaas wins by ${res.gap_s} s`}
          </b>
          <div style={{ fontFamily: 'var(--mono)', marginTop: 4 }}>
            your plan {res.judge_time_s} s · Nikaas {res.nikaas_time_s} s · fastest possible ≥ {res.lower_bound_s} s
          </div>
        </div>
      )}
    </section>
  )
}
