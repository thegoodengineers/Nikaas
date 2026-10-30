// Site camera (#/cam?site=<id>): a laptop or phone camera watches one room or corridor. It counts people
// (crowding and the evacuation plan use the count) and checks every frame for fire or smoke. Video stays in the
// browser; only the count and scores are sent, plus one still image when fire or smoke is suspected so the
// server can confirm it with Amazon Rekognition.
import { useEffect, useRef, useState } from 'react'
import ExitIcon from '../ExitIcon.tsx'
import { API, ApiError, api, hashQuery, saved, setControlKey, type Control, type Site, type SiteSummary } from '../platform/api.ts'
import { FireCheck, getDetector, median, type Box } from './detector.ts'
import './camera.css'

type Report = { confirmed: boolean | null; hazard: string | null } & Control

export default function SiteCam() {
  const q = hashQuery()
  const [sites, setSites] = useState<SiteSummary[]>([])
  const [siteId, setSiteId] = useState(q.get('site') ?? 'office')
  const [site, setSite] = useState<Site>()
  const [node, setNode] = useState(q.get('node') ?? q.get('room') ?? '')
  const [phase, setPhase] = useState<'idle' | 'loading' | 'on'>('idle')
  const [people, setPeople] = useState(0)
  const [scores, setScores] = useState({ fire: 0, smoke: 0 })
  const [report, setReport] = useState<Report>()
  const [lastSent, setLastSent] = useState<{ at: number; image: boolean }>()
  const [confirm, setConfirm] = useState<{ ok: boolean; at: number }>()
  const [err, setErr] = useState('')
  const [needKey, setNeedKey] = useState(false)
  const [key, setKey] = useState('')
  const camId = useRef(saved.get('nikaas-camera-id') ?? `cam-${Math.random().toString(36).slice(2, 8)}`)
  const video = useRef<HTMLVideoElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const img = useRef<HTMLImageElement | null>(null)
  const stream = useRef<MediaStream | undefined>(undefined)
  const running = useRef(false)
  const hist = useRef<[number, number][]>([])
  const check = useRef(new FireCheck())
  const sent = useRef({ at: 0, people: -1, imageAt: 0, inFlight: false })
  const nodeRef = useRef(node), siteRef = useRef(siteId)
  nodeRef.current = node; siteRef.current = siteId

  useEffect(() => { saved.set('nikaas-camera-id', camId.current) }, [])
  useEffect(() => { api.get<SiteSummary[]>('/sites').then(setSites).catch(() => {}) }, [])
  useEffect(() => {
    api.get<Site>(`/sites/${siteId}`).then(s => {
      setSite(s)
      if (!s.building.nodes.some(n => n.id === nodeRef.current)) setNode(s.building.nodes.find(n => n.type === 'room')?.id ?? '')
    }).catch(e => setErr(String(e.message ?? e)))
  }, [siteId])
  useEffect(() => () => stop(), [])

  const floors = Object.fromEntries((site?.building.floors ?? []).map(f => [f.id, f.name]))
  const places = (site?.building.nodes ?? []).filter(n => n.type !== 'exit').map(n => ({ id: n.id, label: `${n.label ?? n.id}${n.floor_id && !(n.label ?? '').includes(floors[n.floor_id] ?? '§') ? `, ${floors[n.floor_id]}` : ''}`, room: n.type === 'room' }))
  const label = places.find(p => p.id === node)?.label ?? node

  async function send(count: number, s: { fire: number; smoke: number }, image?: string) {
    sent.current.inFlight = true
    try {
      const r = await api.post<Report>(`/sites/${siteRef.current}/cameras`, { camera_id: camId.current, node: nodeRef.current, people: count, fire: s.fire, smoke: s.smoke, image }, true)
      setReport(r); setErr(''); setNeedKey(false)
      if (r.confirmed !== null) setConfirm({ ok: r.confirmed, at: Date.now() })
      sent.current.at = performance.now(); sent.current.people = count
      setLastSent({ at: Date.now(), image: !!image })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setNeedKey(true); stop() }
      else setErr(e instanceof Error ? e.message : String(e))
    } finally { sent.current.inFlight = false }
  }

  function tick(src: HTMLVideoElement | HTMLImageElement, boxes: Box[], w: number, h: number) {
    const now = performance.now()
    const n = boxes.length
    hist.current.push([now, n])
    hist.current = hist.current.filter(([t]) => now - t <= 2000)
    const m = median(hist.current.map(([, c]) => c))
    setPeople(m)
    const s = check.current.measure(src)
    setScores(s)
    draw(boxes, w, h)
    const suspect = Math.max(s.fire, s.smoke) >= 0.6
    const due = now - sent.current.at > 4000 || m !== sent.current.people
    if (sent.current.inFlight) return
    if (suspect && now - sent.current.imageAt > 10000) {
      sent.current.imageAt = now
      void send(m, s, check.current.still(src, w, h))
    } else if (due && now - sent.current.at > 1500) void send(m, s)
  }

  function draw(boxes: Box[], w: number, h: number) {
    const c = canvas.current
    if (!c) return
    c.width = w; c.height = h
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    g.lineWidth = 3; g.strokeStyle = '#22c55e'
    for (const { bbox: [x, y, bw, bh] } of boxes) g.strokeRect(x, y, bw, bh)
  }

  async function startCamera() {
    setErr('')
    if (!window.isSecureContext || !navigator.mediaDevices) { setErr('The camera needs a secure (https) page.'); return }
    setPhase('loading')
    try {
      const [model, s] = await Promise.all([getDetector(), navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'environment' }, audio: false })])
      stream.current = s
      const v = video.current!
      v.srcObject = s; await v.play()
      begin(model, v)
    } catch (e) {
      setPhase('idle')
      setErr(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera permission was refused.' : `Could not start the camera: ${e instanceof Error ? e.message : e}`)
    }
  }

  async function startFile(file: File) {
    setErr(''); setPhase('loading')
    try {
      const model = await getDetector()
      const url = URL.createObjectURL(file)
      if (file.type.startsWith('video/')) {
        const v = video.current!
        v.srcObject = null; v.src = url; v.loop = true; v.muted = true; await v.play()
        begin(model, v)
      } else {
        const im = new Image(); im.src = url; await im.decode()
        img.current = im
        begin(model, im)
      }
    } catch (e) { setPhase('idle'); setErr(`Could not read that file: ${e instanceof Error ? e.message : e}`) }
  }

  function begin(model: Awaited<ReturnType<typeof getDetector>>, src: HTMLVideoElement | HTMLImageElement) {
    running.current = true; hist.current = []; check.current = new FireCheck(); sent.current = { at: 0, people: -1, imageAt: 0, inFlight: false }
    setPhase('on')
    const loop = async () => {
      if (!running.current) return
      const ready = src instanceof HTMLVideoElement ? src.readyState >= 2 : src.complete
      if (ready) {
        const w = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth, h = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight
        const boxes = (await model.detect(src, 60, 0.4)).filter(b => b.class === 'person')
        if (!running.current) return
        tick(src, boxes, w, h)
      }
      setTimeout(loop, 300)
    }
    void loop()
  }

  function stop() {
    running.current = false
    stream.current?.getTracks().forEach(t => t.stop())
    stream.current = undefined
    img.current = null
    if (video.current) { video.current.pause(); video.current.removeAttribute('src'); video.current.srcObject = null }
    setPhase('idle')
  }

  const room = report?.rooms[node]
  const spot = report?.spots.find(s => s.node === node)
  const density = room ? { d: room.density, level: room.level } : spot ? { d: spot.density, level: spot.level } : null
  const hazardHere = report?.hazards.find(h => h.node === node)
  const sus = Math.max(scores.fire, scores.smoke)
  return (
    <div className="page cam2">
      <header className="cam2-head">
        <a className="brand" href="#/control"><ExitIcon color="var(--exit)" />Site camera</a>
        <label className="pf-field">Building
          <select value={siteId} disabled={phase !== 'idle'} onChange={e => setSiteId(e.target.value)}>
            {(sites.length ? sites : [{ id: siteId, name: siteId } as SiteSummary]).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        <label className="pf-field">Camera watches
          <select value={node} disabled={phase !== 'idle'} onChange={e => setNode(e.target.value)}>
            {places.map(p => <option key={p.id} value={p.id}>{p.label}{p.room ? '' : ' (walkway)'}</option>)}
          </select></label>
      </header>
      {!API && <div className="pf-alert bad">This page needs the live API.</div>}
      {needKey && (
        <form className="pf-alert warn pf-row" onSubmit={e => { e.preventDefault(); setControlKey(key); setNeedKey(false) }}>
          <span className="pf-grow">Cameras report to the control room, which needs its key.</span>
          <input aria-label="Control key" value={key} onChange={e => setKey(e.target.value)} className="cam2-key" />
          <button className="pf-btn primary">Save key</button>
        </form>
      )}
      <div className="cam2-grid">
        <div className="cam2-stage">
          <video ref={video} muted playsInline className={stream.current ? 'mirror' : ''} />
          {phase === 'on' && img.current && <img src={img.current.src} alt="Test image the camera is checking" />}
          <canvas ref={canvas} className={stream.current ? 'mirror' : ''} />
          {phase !== 'on' && (
            <div className="cam2-cover">
              <p>Watch <b>{label || 'a place'}</b>: count people and look for fire or smoke.</p>
              <button className="pf-btn go" disabled={phase === 'loading' || !node} onClick={startCamera}>{phase === 'loading' ? 'Loading the detector…' : 'Start camera'}</button>
              <label className="pf-btn">Use a test image or video<input type="file" accept="image/*,video/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) void startFile(f); e.target.value = '' }} /></label>
            </div>
          )}
          {phase === 'on' && <span className={`cam2-live ${sus >= 0.6 ? 'bad' : ''}`}><i />{sus >= 0.6 ? 'CHECKING' : 'LIVE'}</span>}
        </div>
        <aside className="pf-stack">
          <div className="pf-card cam2-kpis">
            <div><span className="pf-muted pf-small">People here</span><b className="pf-num">{phase === 'on' ? people : '–'}</b></div>
            <div><span className="pf-muted pf-small">Crowding</span><b className="pf-num">{density ? density.d.toFixed(2) : '–'}</b><span className={`pf-chip ${density?.level === 'crush' ? 'bad' : density?.level === 'concern' ? 'warn' : 'ok'}`}>{density ? `${density.level === 'ok' ? 'normal' : density.level} · p/m²` : 'p/m²'}</span></div>
          </div>
          <div className="pf-card">
            <h3>Fire and smoke check</h3>
            <Meter label="Fire" v={scores.fire} />
            <Meter label="Smoke" v={scores.smoke} />
            <p className="pf-small pf-muted">Above 0.6 a still image goes to the server, which confirms it with Amazon Rekognition before raising a hazard.</p>
            {confirm?.ok === true && <div className="pf-alert bad">Confirmed by Amazon Rekognition at {new Date(confirm.at).toLocaleTimeString()}: hazard raised{report?.alarm ? ' and the alarm is on' : ''}.</div>}
            {confirm?.ok === false && <div className="pf-alert ok">Amazon Rekognition did not confirm fire or smoke in the last still ({new Date(confirm.at).toLocaleTimeString()}).</div>}
            {hazardHere && <div className="pf-alert bad">{hazardHere.kind} reported here ({hazardHere.source}).</div>}
          </div>
          <div className="pf-card pf-small">
            <div className="pf-row"><span className="pf-grow">Camera id</span><code>{camId.current}</code></div>
            <div className="pf-row"><span className="pf-grow">Last report</span><span>{lastSent ? `${new Date(lastSent.at).toLocaleTimeString()}${lastSent.image ? ' (with a still)' : ''}` : '–'}</span></div>
            <div className="pf-row"><span className="pf-grow">Alarm</span><span>{report?.alarm ? <span className="pf-chip bad">on</span> : <span className="pf-chip">off</span>}</span></div>
          </div>
          {phase === 'on' && <button className="pf-btn" onClick={stop}>Stop</button>}
          {err && <div className="pf-alert bad" role="alert">{err}</div>}
          <p className="pf-small pf-muted">Privacy: the person detector and the fire check run in this browser. Video is never uploaded; only counts and scores are sent, plus one still image when fire or smoke is suspected.</p>
        </aside>
      </div>
    </div>
  )
}

function Meter({ label, v }: { label: string; v: number }) {
  return (
    <div className="cam2-meter">
      <span>{label}</span>
      <div><i style={{ width: `${Math.round(v * 100)}%`, background: v >= 0.6 ? '#b91c1c' : v >= 0.3 ? '#b45309' : '#15803d' }} /></div>
      <b>{v.toFixed(2)}</b>
    </div>
  )
}
