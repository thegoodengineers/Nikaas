import { useEffect, useRef, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
type MapNode = [string, string, number, number, number, number] // id, type, x, z, w, d
type Me = {
  version: number; updated: boolean; room: string; room_label: string; exit: string; exit_label: string
  distance_m: number; walk_s: number; path: string[]; alert: boolean; blocked: string[]; blocked_labels: string[]
  map?: { nodes: MapNode[]; edges: [string, string][] }
}
type State = { room_labels: Record<string, string>; version: number }

// The judge's phone during a Live Drill: pick your room, get your own exit, re-routed live.
export default function Phone() {
  const [room, setRoom] = useState(() => { try { return localStorage.getItem('nikaas-room') ?? '' } catch { return '' } })
  const [rooms, setRooms] = useState<Record<string, string>>()
  const [me, setMe] = useState<Me>()
  const [flash, setFlash] = useState(false)
  const [err, setErr] = useState('')
  const seen = useRef(0)

  useEffect(() => { document.body.classList.add('phone-mode'); return () => document.body.classList.remove('phone-mode') }, [])
  useEffect(() => {
    if (room) return
    // judges often scan before the presenter starts the drill: keep checking until the room list appears
    let alive = true, id = 0
    const load = () => fetch(`${API}/drill`).then(r => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((s: State) => { if (alive) { setRooms(s.room_labels); setErr(''); clearInterval(id) } })
      .catch(() => { if (alive) setErr('No drill is running yet. Keep this page open; it starts in a moment.') })
    load(); id = window.setInterval(load, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [room])
  useEffect(() => {
    if (!room) return
    let alive = true
    const poll = async () => {
      try {
        const r = await fetch(`${API}/drill?room=${encodeURIComponent(room)}&since=${seen.current}`)
        if (!r.ok) throw new Error(String(r.status))
        const m: Me = await r.json()
        if (!alive) return
        if (m.version > seen.current && seen.current > 0 && m.alert) {
          setFlash(true); navigator.vibrate?.([300, 120, 300, 120, 700])
          setTimeout(() => setFlash(false), 4500)
        }
        seen.current = m.version; setMe(m); setErr('')
      } catch { if (alive) setErr('Waiting for the drill…') }
    }
    poll(); const id = setInterval(poll, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [room])

  function choose(r: string) { try { localStorage.setItem('nikaas-room', r) } catch { /* private mode */ } seen.current = 0; setRoom(r) }

  if (!room) return (
    <div className="phone">
      <div className="phone-brand"><ExitIcon color="var(--exit)" /> Nikaas live drill</div>
      <h1>Which room are you in?</h1>
      {err && <p className="phone-note">{err}</p>}
      <div className="phone-rooms">
        {Object.entries(rooms ?? {}).map(([id, label]) => <button key={id} onClick={() => choose(id)}>{label}</button>)}
      </div>
    </div>
  )

  return (
    <div className={`phone ${flash ? 'phone-alarm' : ''}`}>
      <div className="phone-brand"><ExitIcon color={flash ? '#fff' : 'var(--exit)'} /> {me?.room_label ?? '…'}
        <button className="phone-change" onClick={() => choose('')}>Change room</button></div>
      {flash && me && <div className="phone-fire">Fire at {me.blocked_labels.join(', ')}. Your exit has changed.</div>}
      {me ? (
        <>
          <div className="phone-exit">
            <ExitIcon />
            <div><span>Your exit</span><b>{me.exit_label}</b></div>
          </div>
          <p className="phone-walk">{me.distance_m} m · about {me.walk_s} s walking</p>
          {me.blocked_labels.length > 0 && !flash && <p className="phone-note">Avoid: {me.blocked_labels.join(', ')} (blocked)</p>}
          {me.map && <MiniMap me={me} />}
        </>
      ) : <p className="phone-note">{err || 'Connecting…'}</p>}
    </div>
  )
}

function MiniMap({ me }: { me: Me }) {
  const m = me.map!
  const pos = Object.fromEntries(m.nodes.map(n => [n[0], n]))
  const xs = m.nodes.map(n => n[2]), zs = m.nodes.map(n => n[3])
  const x0 = Math.min(...xs) - 4, z0 = Math.min(...zs) - 4, w = Math.max(...xs) + 4 - x0, h = Math.max(...zs) + 4 - z0
  const pts = me.path.map(id => pos[id]).filter(Boolean).map(n => `${n[2]},${n[3]}`).join(' ')
  const here = pos[me.room], exit = pos[me.exit]
  return (
    <svg className="phone-map" viewBox={`${x0} ${z0} ${w} ${h}`} role="img" aria-label={`Map: your route from ${me.room_label} to ${me.exit_label}`}>
      {m.edges.map(([a, b], k) => pos[a] && pos[b] && <line key={k} x1={pos[a][2]} y1={pos[a][3]} x2={pos[b][2]} y2={pos[b][3]} className="pm-walk" />)}
      {m.nodes.filter(n => n[1] === 'room').map(n => <rect key={n[0]} x={n[2] - n[4] / 2} y={n[3] - n[5] / 2} width={n[4]} height={n[5]} className={n[0] === me.room ? 'pm-room pm-here' : 'pm-room'} />)}
      <polyline points={pts} className="pm-route" />
      {m.nodes.filter(n => n[1] === 'exit').map(n => <circle key={n[0]} cx={n[2]} cy={n[3]} r={2.2} className={n[0] === me.exit ? 'pm-exit pm-mine' : me.blocked?.includes(n[0]) ? 'pm-exit pm-fire' : 'pm-exit'} />)}
      {here && <circle cx={here[2]} cy={here[3]} r={1.8} className="pm-me" />}
      {exit && <circle cx={exit[2]} cy={exit[3]} r={3.4} className="pm-target" />}
    </svg>
  )
}
