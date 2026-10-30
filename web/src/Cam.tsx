import { useEffect, useRef, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'

// Nikaas Live: a laptop camera counts the people in one room and the drill re-plans with that number.
// The person detector (COCO-SSD, TensorFlow.js) runs in this browser tab: video never leaves the laptop,
// only the head count is sent to POST /occupancy.

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const BASE = import.meta.env.BASE_URL
type Box = { bbox: [number, number, number, number]; class: string; score: number }
type Detector = { detect: (v: HTMLVideoElement, maxBoxes?: number, minScore?: number) => Promise<Box[]> }
declare global { interface Window { cocoSsd?: { load: (o: { base: string; modelUrl: string }) => Promise<Detector> } } }
type Room = { exit: string; exit_label: string; distance_m: number }
type State = {
  version: number; total_time_s: number; room_labels: Record<string, string>; rooms: Record<string, Room>; changed: string[]
  people?: Record<string, number>; live?: Record<string, { count: number; design: number }>
}
type Node = { id: string; type: string; label?: string; people?: number }

const SMOOTH_MS = 2000 // median of the last 2 s of counts: one missed or doubled detection does not re-plan
const HOLD_MS = 1500 // a new count must hold this long before it is sent
const MIN_GAP_MS = 3000 // at most one re-plan every 3 s (each takes 1.5-4 s on AWS)

function loadScript(src: string) {
  return new Promise<void>((ok, fail) => {
    if (document.querySelector(`script[src="${src}"]`)) return ok()
    const s = document.createElement('script')
    s.src = src; s.onload = () => ok(); s.onerror = () => fail(new Error(`Could not load ${src}`))
    document.head.appendChild(s)
  })
}
let detector: Promise<Detector> | undefined
function getDetector() {
  detector ??= (async () => {
    await loadScript(`${BASE}vendor/tfjs/tf.min.js`)
    await loadScript(`${BASE}vendor/coco-ssd/coco-ssd.min.js`)
    return window.cocoSsd!.load({ base: 'lite_mobilenet_v2', modelUrl: `${BASE}vendor/coco-ssd/model.json` })
  })()
  detector.catch(() => { detector = undefined })
  return detector
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

export default function Cam() {
  const [rooms, setRooms] = useState<Node[]>([])
  const [building, setBuilding] = useState<unknown>()
  const [room, setRoom] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('room') ?? 'study')
  const [phase, setPhase] = useState<'idle' | 'loading' | 'on'>('idle')
  const [count, setCount] = useState(0) // smoothed count shown big
  const [raw, setRaw] = useState(0)
  const [sent, setSent] = useState<number>()
  const [state, setState] = useState<State>()
  const [noDrill, setNoDrill] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stream = useRef<MediaStream | undefined>(undefined)
  const hist = useRef<[number, number][]>([]) // [time, count]
  const pending = useRef({ value: -1, since: 0 })
  const last = useRef({ value: -1, at: 0, inFlight: false })
  const roomRef = useRef(room)
  roomRef.current = room

  useEffect(() => {
    fetch('data/iit_kgp_museum.json').then(r => r.json()).then(b => { setBuilding(b); setRooms(b.nodes.filter((n: Node) => n.type === 'room')) })
    fetch(`${API}/drill`).then(r => { setNoDrill(r.status === 404); return r.ok ? r.json() : undefined }).then(s => s && setState(s)).catch(() => {})
    return () => stop() // leaving the page: the room goes back to the floor-plan number (no stale LIVE count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function send(value: number | null) {
    last.current.inFlight = true; setBusy(true)
    try {
      const r = await fetch(`${API}/occupancy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: roomRef.current, count: value }) })
      if (r.status === 404 && (await r.clone().text()).includes('no drill')) { setNoDrill(true); throw new Error('No drill is running. Start it below.') }
      if (!r.ok) throw new Error(`Server error ${r.status}`)
      const s = await r.json()
      setState(s); setNoDrill(false); setErr('')
      setSent(value ?? undefined)
      last.current.value = value ?? -1; last.current.at = performance.now()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { last.current.inFlight = false; setBusy(false) }
  }

  // called for each detection: smooth, hold, then send when the number really changed
  function onCount(n: number) {
    const now = performance.now()
    hist.current.push([now, n])
    hist.current = hist.current.filter(([t]) => now - t <= SMOOTH_MS)
    const m = median(hist.current.map(([, c]) => c))
    setRaw(n); setCount(m)
    if (m !== pending.current.value) pending.current = { value: m, since: now }
    const l = last.current
    if (!l.inFlight && m !== l.value && now - pending.current.since >= HOLD_MS && now - l.at >= MIN_GAP_MS) send(m)
  }

  async function startCam() {
    setErr('')
    if (!window.isSecureContext || !navigator.mediaDevices) { setErr('The camera needs https or localhost. Open this page from the local dev server (npm run dev).'); return }
    setPhase('loading')
    try {
      const [model, s] = await Promise.all([getDetector(), navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false })])
      stream.current = s
      const v = video.current!
      v.srcObject = s; await v.play()
      last.current = { value: -1, at: 0, inFlight: false }; hist.current = []
      setPhase('on')
      const loop = async () => {
        if (!stream.current) return
        if (v.readyState >= 2) {
          const people = (await model.detect(v, 60, 0.4)).filter(b => b.class === 'person')
          if (!stream.current) return // stopped while detecting
          draw(people)
          onCount(people.length)
        }
        setTimeout(loop, 120)
      }
      loop()
    } catch (e) {
      setPhase('idle')
      setErr(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission was refused. Allow the camera for this site and try again.' : `Could not start the camera: ${e instanceof Error ? e.message : e}`)
    }
  }

  function draw(people: Box[]) {
    const c = canvas.current, v = video.current
    if (!c || !v) return
    c.width = v.videoWidth; c.height = v.videoHeight
    const g = c.getContext('2d')!
    g.clearRect(0, 0, c.width, c.height)
    g.lineWidth = 4; g.strokeStyle = '#22c55e'; g.fillStyle = '#22c55e'; g.font = '700 18px system-ui'
    people.forEach(({ bbox: [x, y, w, h], score }, k) => {
      g.strokeRect(x, y, w, h)
      g.save(); g.translate(x + w, y); g.scale(-1, 1) // the canvas is mirrored with the video; keep labels readable
      g.fillRect(0, 0, 64, 26); g.fillStyle = '#fff'; g.fillText(`${k + 1} · ${Math.round(score * 100)}%`, 6, 19); g.restore()
      g.fillStyle = '#22c55e'
    })
  }

  function stop(reset = true) {
    stream.current?.getTracks().forEach(t => t.stop())
    stream.current = undefined
    const c = canvas.current
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    setPhase('idle')
    if (reset && last.current.value >= 0) send(null) // back to the floor-plan number
  }

  async function startDrill() {
    if (!building) return
    setBusy(true)
    try {
      const r = await fetch(`${API}/drill`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ building, blocked: [] }) })
      if (!r.ok) throw new Error(`Server error ${r.status}`)
      setState(await r.json()); setNoDrill(false); setErr('')
      last.current = { value: -1, at: 0, inFlight: false }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const label = rooms.find(r => r.id === room)?.label ?? room
  const design = rooms.find(r => r.id === room)?.people
  const mine = state?.rooms[room]
  const changed = (state?.changed ?? []).map(r => state!.room_labels[r] ?? r)

  return (
    <div className="page cam">
      <div className="cam-head">
        <a className="brand" href="#/drill"><ExitIcon color="var(--exit)" />Nikaas Live</a>
        <label>Camera is in <select value={room} disabled={phase !== 'idle'} onChange={e => setRoom(e.target.value)}>
          {rooms.map(r => <option key={r.id} value={r.id}>{r.label ?? r.id}</option>)}
        </select></label>
      </div>
      <div className="cam-grid">
        <div className="cam-stage">
          <video ref={video} muted playsInline />
          <canvas ref={canvas} />
          {phase !== 'on' && (
            <div className="cam-cover">
              <p>Count the people in <b>{label}</b> and plan the evacuation for who is really there.</p>
              <button className="cta" disabled={phase === 'loading'} onClick={startCam}>{phase === 'loading' ? 'Loading the person detector…' : 'Start camera'}</button>
            </div>
          )}
          {phase === 'on' && <span className="cam-live"><i className="pulse" />LIVE</span>}
        </div>
        <div className="drill-panel cam-panel">
          <div className="drill-status">
            <div><span>People in {label} now</span><b className="cam-count">{phase === 'on' ? count : '–'}</b></div>
            <div><span>Floor plan assumes</span><b>{design ?? '–'}</b></div>
          </div>
          {phase === 'on' && <p className="sources">This frame: {raw} · smoothed over 2 s · {busy ? 're-planning…' : sent !== undefined ? `drill planned for ${sent}` : 'waiting for a steady count'}</p>}
          {noDrill ? (
            <div style={{ marginTop: 18 }}>
              <p>No drill is running, so there is no plan to update.</p>
              <button className="cta" disabled={busy || !building} onClick={startDrill}>{busy ? 'Starting…' : 'Start the drill'}</button>
            </div>
          ) : state && (
            <>
              <div className="drill-status" style={{ marginTop: 18 }}>
                <div><span>Everyone out in</span><b>{state.total_time_s} s</b></div>
                <div><span>Drill update</span><b>#{state.version}</b></div>
              </div>
              {mine && <p className="cam-exit"><ExitIcon color="var(--exit)" /><span>{label} leaves by <b>{mine.exit_label}</b> ({mine.distance_m} m)</span></p>}
              {changed.length > 0 && <p className="drill-changed">Re-routed just now: {changed.join(', ')}. Their phones are alerting.</p>}
            </>
          )}
          {phase === 'on' && <button style={{ marginTop: 14 }} onClick={() => stop()}>Stop camera (use the floor-plan number)</button>}
          {err && <p role="alert" style={{ color: 'var(--alarm)' }}>{err}</p>}
          <p className="sources">Privacy: the person detector (COCO-SSD) runs in this browser. Video never leaves the laptop; only the number is sent. It can miss people hidden behind others, so treat the count as a lower bound.</p>
        </div>
      </div>
    </div>
  )
}
