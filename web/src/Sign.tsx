import { useEffect, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
type State = { version: number; blocked: string[]; instead: Record<string, string>; exit_labels: Record<string, string>; rooms: Record<string, { exit: string }>; room_labels: Record<string, string> }

// A phone or tablet taped beside a real door during the Live Drill: a green exit sign that turns into a
// red "do not use" the moment the presenter sets a fire there, and points to the nearest open exit instead.
export default function Sign() {
  const [exit, setExit] = useState(() => { try { return localStorage.getItem('nikaas-sign') ?? '' } catch { return '' } })
  const [s, setS] = useState<State>()
  const [err, setErr] = useState('')

  useEffect(() => { document.body.classList.add('phone-mode'); return () => document.body.classList.remove('phone-mode') }, [])
  useEffect(() => {
    let alive = true, was = false
    const poll = async () => {
      try {
        const r = await fetch(`${API}/drill`)
        if (!r.ok) throw new Error(String(r.status))
        const st: State | null = await r.json()
        if (!st) throw new Error('no drill yet') // the API answers null until the presenter starts one
        if (!alive) return
        const now = !!exit && st.blocked.includes(exit)
        if (now && !was) navigator.vibrate?.([500, 150, 500])
        was = now; setS(st); setErr('')
      } catch { if (alive) setErr('Waiting for the drill to start…') }
    }
    poll(); const id = setInterval(poll, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [exit])

  function choose(x: string) { try { localStorage.setItem('nikaas-sign', x) } catch { /* private mode */ } setExit(x) }

  if (!exit || !s) return (
    <main className="phone">
      <div className="phone-brand"><ExitIcon color="var(--exit)" /> Nikaas exit sign</div>
      <h1>Which door is this phone next to?</h1>
      {err && <p className="phone-note">{err}</p>}
      <div className="phone-rooms">
        {Object.entries(s?.exit_labels ?? {}).map(([id, label]) => <button key={id} onClick={() => choose(id)}>{label}</button>)}
      </div>
    </main>
  )

  const label = s.exit_labels[exit] ?? exit
  const fire = s.blocked.includes(exit)
  const rooms = Object.values(s.rooms).filter(r => r.exit === exit).length
  const instead = s.instead?.[exit] // open exit with the shortest walk from this door

  return (
    <main className={`sign ${fire ? 'sign-fire' : ''}`} onDoubleClick={() => choose('')}>
      {fire ? (
        <>
          <svg className="sign-x" viewBox="0 0 64 64" aria-hidden="true"><path d="M12 12 L52 52 M52 12 L12 52" /></svg>
          <h1>Do not use</h1>
          <p>Fire at {label}.</p>
          {instead && <p className="sign-go">Go to {s.exit_labels[instead] ?? instead}</p>}
        </>
      ) : (
        <>
          <div className="sign-icon"><ExitIcon /></div>
          <h1>{label}</h1>
          <p>{rooms} {rooms === 1 ? 'room is' : 'rooms are'} sent to this exit</p>
        </>
      )}
      <small>Live drill update #{s.version} · double-tap to change door</small>
    </main>
  )
}
