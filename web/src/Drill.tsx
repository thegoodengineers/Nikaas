import { useEffect, useMemo, useState } from 'react'
import qrcode from './vendor/qrcode/qrcode.mjs'
import ExitIcon from './ExitIcon.tsx'

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
type Node = { id: string; type: string; label?: string }
type Building = { name: string; nodes: Node[]; edges: unknown[] }
type Room = { exit: string; exit_label: string; distance_m: number; walk_s: number }
type State = { version: number; blocked: string[]; blocked_labels: string[]; total_time_s: number; room_labels: Record<string, string>; rooms: Record<string, Room>; changed: string[] }

// Presenter screen for the Live Drill: judges scan the code, pick their room, and follow their phone.
export default function Drill() {
  const [building, setBuilding] = useState<Building>()
  const [state, setState] = useState<State>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const phoneUrl = `${location.origin}${location.pathname}#/me`
  const qr = useMemo(() => { const q = qrcode(0, 'M'); q.addData(phoneUrl); q.make(); return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }) }, [phoneUrl])

  useEffect(() => { fetch('data/iit_kgp_museum.json').then(r => r.json()).then(setBuilding) }, [])
  useEffect(() => { fetch(`${API}/drill`).then(r => (r.ok ? r.json() : undefined)).then(s => s && setState(s)).catch(() => {}) }, [])

  async function push(blocked: string[], reset = false) {
    if (!building) return
    setBusy(true); setErr('')
    try {
      const r = await fetch(`${API}/drill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ building, blocked, reset }) })
      if (!r.ok) throw new Error(`Server error ${r.status}`)
      setState(await r.json())
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const exits = building?.nodes.filter(n => n.type === 'exit') ?? []
  const blocked = state?.blocked ?? []
  const toggle = (id: string) => push(blocked.includes(id) ? blocked.filter(x => x !== id) : [...blocked, id])

  return (
    <div className="page drill">
      <div className="drill-grid">
        <div>
          <h1 className="page-title">Live drill</h1>
          <p className="lede">Scan with your phone and choose the room you are in. Your phone shows your own way out, and changes it the moment an exit is blocked.</p>
          <div className="drill-qr" role="img" dangerouslySetInnerHTML={{ __html: qr }} aria-label={`QR code for ${phoneUrl}`} />
          <p className="sources">{phoneUrl}</p>
          <p className="sources">Phones taped beside the doors become live exit signs: open {phoneUrl.replace('#/me', '#/sign')}</p>
        </div>
        <div className="drill-panel">
          {!state ? (
            <button className="cta" disabled={busy || !building} onClick={() => push([])}>{busy ? 'Starting…' : 'Start the drill'}</button>
          ) : (
            <>
              <div className="drill-status">
                <div><span>Everyone out in</span><b>{state.total_time_s} s</b></div>
                <div><span>Drill update</span><b>#{state.version}</b></div>
              </div>
              <h2 className="sub" style={{ marginTop: 20 }}>Set a fire</h2>
              <div className="drill-exits">
                {exits.map(x => (
                  <button key={x.id} className={blocked.includes(x.id) ? 'fire' : ''} disabled={busy || (!blocked.includes(x.id) && blocked.length + 1 >= exits.length)} onClick={() => toggle(x.id)}>
                    <ExitIcon color={blocked.includes(x.id) ? '#fff' : 'var(--exit)'} />{blocked.includes(x.id) ? `Fire at ${x.label ?? x.id}` : x.label ?? x.id}
                  </button>
                ))}
              </div>
              <button className="quiet" disabled={busy} onClick={() => push([], true)} style={{ marginTop: 10 }}>Start over (clear fires and alerts)</button>
              {state.changed.length > 0 && <p className="drill-changed">{state.changed.length} rooms were just re-routed. Their phones are vibrating.</p>}
              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table className="data">
                  <thead><tr><th>Room</th><th>Exit</th><th>Walk</th></tr></thead>
                  <tbody>{Object.entries(state.rooms).map(([r, x]) => (
                    <tr key={r} className={state.changed.includes(r) ? 'changed' : ''}><td>{state.room_labels[r] ?? r}</td><td>{x.exit_label}</td><td className="num">{x.distance_m} m</td></tr>))}</tbody>
                </table>
              </div>
            </>
          )}
          {err && <p role="alert" style={{ color: 'var(--alarm)' }}>{err}</p>}
        </div>
      </div>
    </div>
  )
}
