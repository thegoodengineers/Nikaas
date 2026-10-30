import { useEffect, useMemo, useState } from 'react'
import qrcode from './vendor/qrcode/qrcode.mjs'
import ExitIcon from './ExitIcon.tsx'

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
type Node = { id: string; type: string; label?: string }
type Building = { name: string; nodes: Node[]; edges: unknown[] }
type Room = { exit: string; exit_label: string; distance_m: number; walk_s: number }
type State = { version: number; blocked: string[]; blocked_labels: string[]; total_time_s: number; room_labels: Record<string, string>; rooms: Record<string, Room>; changed: string[]
  people?: Record<string, number>; live?: Record<string, { count: number; design: number }> }

// Presenter screen for the Live Drill: judges scan the code, pick their room, and follow their phone.
export default function Drill() {
  const [building, setBuilding] = useState<Building>()
  const [state, setState] = useState<State>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const phoneUrl = `${location.origin}${location.pathname}#/me`
  const qr = useMemo(() => { const q = qrcode(0, 'M'); q.addData(phoneUrl); q.make(); return q.createSvgTag({ cellSize: 8, margin: 2, scalable: true }) }, [phoneUrl])

  useEffect(() => { fetch('data/iit_kgp_museum.json').then(r => r.json()).then(setBuilding) }, [])
  // poll: a camera (#/cam) can change a room's count and re-plan while this screen is open
  useEffect(() => {
    const load = () => fetch(`${API}/drill`).then(r => (r.ok ? r.json() : undefined)).then(s => s && setState(old => (old?.version === s.version ? old : s))).catch(() => {})
    load(); const id = setInterval(load, 2000)
    return () => clearInterval(id)
  }, [])

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

  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(phoneUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }
  const open = exits.length - blocked.length
  const base = `${location.origin}${location.pathname}`

  return (
    <div className="page drill">
      <header className="drill-head">
        <div>
          <p className="pf-eyebrow">Tools · presenter screen</p>
          <h1 className="page-title">Live drill</h1>
          <p className="lede">Put this on the big screen. Judges scan the code, choose their room, and their phone shows their own way out. Set a fire here and every phone heading that way is re-routed.</p>
        </div>
        <span className={`pf-chip drill-state ${state ? 'ok' : ''}`}><span className="pf-dot" />{state ? `Running · update ${state.version}` : 'Not started'}</span>
      </header>

      <div className="drill-grid">
        <section className="pf-card drill-join" aria-labelledby="drill-join-h">
          <p className="pf-eyebrow" id="drill-join-h">Join from your phone</p>
          <div className="drill-qr" role="img" dangerouslySetInnerHTML={{ __html: qr }} aria-label={`QR code for ${phoneUrl}`} />
          <ol className="drill-steps">
            <li><span>1</span>Scan the code with the phone camera</li>
            <li><span>2</span>Choose the room you are in</li>
            <li><span>3</span>Follow the arrows to your exit</li>
          </ol>
          <div className="drill-url"><code>{phoneUrl}</code><button type="button" className="pf-btn" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button></div>
        </section>

        <section className="drill-main">
          {!state ? (
            <div className="pf-card drill-start">
              <h2>Ready when you are</h2>
              <p className="pf-muted">Starting the drill plans every room of the IIT Kharagpur museum floor to its fastest exit. Phones that have joined get their route straight away.</p>
              <button className="pf-btn go drill-big" disabled={busy || !building} onClick={() => push([])}>{busy ? 'Starting…' : !building ? 'Loading the building…' : 'Start the drill'}</button>
            </div>
          ) : (
            <>
              <div className="drill-stats">
                <div className="pf-card"><span>Everyone out in</span><b>{state.total_time_s}<small> s</small></b></div>
                <div className="pf-card"><span>Exits open</span><b className={blocked.length ? 'bad' : ''}>{open}<small> of {exits.length}</small></b></div>
                <div className="pf-card"><span>Rooms just re-routed</span><b className={state.changed.length ? 'warn' : ''}>{state.changed.length}</b></div>
              </div>

              <div className="pf-card">
                <div className="drill-row-head">
                  <h2>Set a fire</h2>
                  <button className="pf-btn" disabled={busy} onClick={() => push([], true)}>Start over</button>
                </div>
                <p className="pf-muted pf-small">Tap an exit to block it, tap again to reopen it. At least one exit stays open.</p>
                <div className="drill-exits">
                  {exits.map(x => {
                    const fire = blocked.includes(x.id)
                    return (
                      <button key={x.id} className={fire ? 'fire' : ''} aria-pressed={fire} disabled={busy || (!fire && blocked.length + 1 >= exits.length)} onClick={() => toggle(x.id)}>
                        <ExitIcon color={fire ? '#fff' : 'var(--exit)'} />
                        <span><b>{x.label ?? x.id}</b><small>{fire ? 'Fire: blocked' : 'Open'}</small></span>
                      </button>
                    )
                  })}
                </div>
                {state.changed.length > 0 && <p className="pf-alert warn drill-changed" role="status">{state.changed.length} rooms were just re-routed. Their phones are vibrating.</p>}
              </div>

              <div className="pf-card">
                <h2>Rooms and their exits</h2>
                <div className="table-wrap">
                  <table className="data drill-table">
                    <thead><tr><th>Room</th><th className="num">People</th><th>Exit</th><th className="num">Walk</th></tr></thead>
                    <tbody>{Object.entries(state.rooms).map(([r, x]) => (
                      <tr key={r} className={state.changed.includes(r) ? 'changed' : ''}>
                        <td>{state.room_labels[r] ?? r}</td>
                        <td className="num">{state.people?.[r] ?? ''}{state.live?.[r] && <span className="live-badge" title={`Camera count; floor plan says ${state.live[r].design}`}>LIVE</span>}</td>
                        <td><span className="drill-exit-tag"><ExitIcon color="var(--exit)" />{x.exit_label}</span></td>
                        <td className="num">{x.distance_m} m</td>
                      </tr>))}</tbody>
                  </table>
                </div>
              </div>
            </>
          )}
          {err && <p className="pf-alert bad" role="alert">{err}</p>}
        </section>
      </div>

      <div className="drill-more">
        <a className="pf-card" href="#/sign"><b>Exit sign phones</b><span>Tape a phone beside each door: it shows a live green or red exit sign. {base}#/sign</span></a>
        <a className="pf-card" href="#/cam"><b>Room camera</b><span>Point a laptop camera at a room: the drill uses the people really there.</span></a>
      </div>
    </div>
  )
}
