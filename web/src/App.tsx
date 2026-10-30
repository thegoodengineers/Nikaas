import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import View3D from './View3D.tsx'
import BeatNikaas from './BeatNikaas.tsx'

type Node = { id: string; type: 'room' | 'corridor' | 'exit'; x: number; z: number; w?: number; d?: number; label?: string }
type Building = { name: string; nodes: Node[]; edges: { from: string; to: string; width: number }[] }
type Frame = { t: number; people: [number, number, string][] }
type Run = {
  total_time_s: number; p95_time_s?: number; per_exit: Record<string, number>; bottleneck: string; peak_queue: number; edge_load?: Record<string, number>
  frames: Frame[]; door_routes?: Record<string, string[][]>
  lower_bound_s?: number; nearest_s?: number // set for Nikaas plans
  plan?: Record<string, string>; compliance?: number; profile?: string
}

type CompareResult = { label: string; compliance: number; run: Run }

const PROFILES: { id: string; label: string; compliance: number; desc: string }[] = [
  { id: 'guidance', label: 'Guided (90%)', compliance: 0.9, desc: '9 in 10 follow the plan' },
  { id: 'mixed',    label: 'Mixed (65%)',  compliance: 0.65, desc: '35% take the familiar exit' },
  { id: 'panic',    label: 'Panic (30%)',  compliance: 0.3,  desc: '70% ignore the plan — real crowd' },
]

// Live API (AWS). Without it the page falls back to saved runs, so ?demo=1 and offline demos still work.
const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const DEMO = new URLSearchParams(location.search).has('demo')
// The same museum floor digitised by hand and read from the photo by Amazon Nova Pro (nikaas/vision.py), plus a stadium and a tower
const SOURCES = [
  { id: 'hand', label: 'Hand-digitised', file: 'data/iit_kgp_museum.json',
    saved: { '': 'data/frames_iit_kgp_nearest.json', MAIN: 'data/frames_iit_kgp_blockedMAIN.json',
      'nikaas:': 'data/frames_iit_kgp_nikaas.json', 'nikaas:MAIN': 'data/frames_iit_kgp_nikaas_blockedMAIN.json' } as Record<string, string> },
  { id: 'vision', label: 'Read from the photo (Amazon Nova Pro)', file: 'data/vision_nova_pro.json',
    saved: { '': 'data/frames_vision_nova_pro_nearest.json' } as Record<string, string> },
  // the scale story: Bhumika's representative stadium scaled to 2,001 people. Its runs are precomputed
  // (scripts/precompute_stadium.py): the optimiser takes ~13 s here, too slow for a live call.
  { id: 'stadium', label: 'Stadium gates (2,001 people)', file: 'data/stadium_scaled.json', offline: true, frameEvery: 5,
    saved: { '': 'data/frames_stadium_nearest.json', 'nikaas:': 'data/frames_stadium_nikaas.json',
      ...Object.fromEntries(['GATE_N', 'GATE_S', 'GATE_E', 'GATE_W', 'GATE_NE', 'GATE_VIP'].map(g => [`nikaas:${g}`, `data/frames_stadium_nikaas_blocked${g}.json`])) } as Record<string, string> },
  // Ayush's multi-floor engine: five floors sharing two stairwells (scripts/precompute_frames.py; totals as runs/multi_floor.csv)
  { id: 'tower', label: '5-floor tower (450 people)', file: 'data/tower.json', offline: true, frameEvery: 2,
    saved: { '': 'data/frames_tower_nearest.json', 'nikaas:': 'data/frames_tower_nikaas.json' } as Record<string, string> },
]

const STATE_VAR: Record<string, string> = { walking: '--walk', queuing: '--queue', stairs: '--stairs', inside: '--inside' }
const LEGEND: [string, string, string][] = [
  ['out', 'Evacuated', '--ink'], ['stairs', 'On the stairs', '--stairs'], ['queuing', 'Queuing', '--queue'],
  ['walking', 'Walking', '--walk'], ['inside', 'Still inside', '--inside'],
]
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const cssVar = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim()

async function post(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`Server error ${r.status} on ${path}`)
  return r.json()
}

// plan 'nearest' = today's rule; 'nikaas' = Ayush's optimiser (/optimise), then simulated with that plan
async function fetchRun(building: Building, blocked: string[], src: typeof SOURCES[number], plan: string, compliance = 1.0): Promise<Run> {
  const SAVED = src.saved, frame_every = src.frameEvery ?? 1
  const b = blocked.slice().sort().join('+')
  const key = plan === 'nikaas' ? `nikaas:${b}` : b
  // saved runs are always 100% compliance; use live API for compliance < 1
  if (compliance >= 1.0 && (!API || DEMO || src.offline) && key in SAVED) return (await fetch(SAVED[key])).json()
  if (!API) throw new Error('This scenario needs the live API (set VITE_API_URL).')
  if (plan !== 'nikaas') return post('/simulate', { building, blocked, frame_every, compliance })
  const [opt, nearest] = await Promise.all([
    post('/optimise', { building, blocked, simulate: true, frame_every }),
    post('/simulate', { building, blocked, frame_every: 1e6 }),
  ])
  const run = opt.run ?? await post('/simulate', { building, blocked, plan: opt.plan, frame_every, compliance })
  return { ...run, lower_bound_s: opt.lower_bound_s, nearest_s: nearest.total_time_s }
}

export default function App() {
  const [building, setBuilding] = useState<Building>()
  const [source, setSource] = useState(SOURCES[0])
  const [blocked, setBlocked] = useState<string[]>([])
  const [run, setRun] = useState<Run>()
  const [baseline, setBaseline] = useState<Record<string, number>>({}) // all-exits-open time per plan
  const [error, setError] = useState('')
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(4)
  const [mode3d, setMode3d] = useState(true)
  const [plan, setPlan] = useState<'nearest' | 'nikaas'>('nearest')
  const [compliance, setCompliance] = useState(1.0)
  const [qa, setQa] = useState<{ score: number; status: string; warnings: { severity: string; message: string }[] }>()
  const [comparing, setComparing] = useState(false)
  const [compareResults, setCompareResults] = useState<CompareResult[]>([])
  useEffect(() => { fetch('data/vision_nova_pro_qa.json').then(r => r.json()).then(setQa).catch(() => {}) }, [])
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => { setBuilding(undefined); setRun(undefined); setBlocked([]); setBaseline({}); fetch(source.file).then(r => r.json()).then(setBuilding) }, [source])
  useEffect(() => {
    if (!building) return
    let live = true
    setRun(undefined); setError(''); setI(0)
    fetchRun(building, blocked, source, plan, compliance)
      .then(r => { if (live) { setRun(r); if (!blocked.length) setBaseline(b => ({ ...b, [plan]: r.total_time_s })) } })
      .catch(e => live && setError(String(e.message ?? e)))
    return () => { live = false }
  }, [building, blocked, plan, compliance])
  useEffect(() => {
    if (!run || !playing) return
    const id = setInterval(() => setI(k => Math.min(k + 1, run.frames.length - 1)), 1000 / speed)
    return () => clearInterval(id)
  }, [run, playing, speed])

  // ?demo=1: a hands-free story for the demo video. Landing for 4 s, then the nearest-exit run,
  // then the main entrance is blocked and the re-planned run plays. Uses saved runs only (no network).
  const [caption, setCaption] = useState('')
  useEffect(() => {
    if (!DEMO || !run) return
    if (plan === 'nearest') setCaption('Today: everyone takes the nearest exit. Watch where the queues form.')
    else if (!blocked.length) setCaption('Nikaas plan: each room gets the exit that empties the building fastest.')
    else setCaption('The main entrance is blocked. Nikaas re-plans for the two exits left.')
    if (i < run.frames.length - 1) return
    const next = plan === 'nearest' ? () => setPlan('nikaas') : !blocked.length ? () => setBlocked(['MAIN']) : undefined
    if (!next) return
    const t = setTimeout(next, 2500)
    return () => clearTimeout(t)
  }, [run, i, blocked, plan])

  const view = useMemo(() => {
    if (!building) return undefined
    const xs = building.nodes.map(n => n.x), zs = building.nodes.map(n => n.z)
    return { x0: Math.min(...xs) - 6, z0: Math.min(...zs) - 6, x1: Math.max(...xs) + 6, z1: Math.max(...zs) + 6 }
  }, [building])
  const scale = (c: HTMLCanvasElement) => view ? Math.min(c.width / (view.x1 - view.x0), c.height / (view.z1 - view.z0)) : 1
  const exits = building?.nodes.filter(n => n.type === 'exit') ?? []
  const f = run?.frames[i]

  const toggleExit = useCallback((id: string) => {
    setBlocked(b => {
      if (b.includes(id)) return b.filter(x => x !== id)
      if (b.length + 1 >= exits.length) { setError('At least one exit must stay open.'); return b }
      return [...b, id]
    })
  }, [exits.length])

  function onCanvasClick(ev: React.MouseEvent<HTMLCanvasElement>) {
    const c = canvas.current
    if (!c || !view) return
    const rect = c.getBoundingClientRect(), s = scale(c)
    const px = (ev.clientX - rect.left) * (c.width / rect.width), pz = (ev.clientY - rect.top) * (c.height / rect.height)
    const hit = exits.find(n => Math.hypot((n.x - view.x0) * s - px, (n.z - view.z0) * s - pz) < 22)
    if (hit) toggleExit(hit.id)
  }

  useEffect(() => {
    const c = canvas.current, g = c?.getContext('2d')
    if (!c || !g || !building || !view) return
    const s = scale(c)
    const P = (x: number, z: number): [number, number] => [(x - view.x0) * s, (z - view.z0) * s]
    const byId = Object.fromEntries(building.nodes.map(n => [n.id, n]))
    g.clearRect(0, 0, c.width, c.height)
    g.lineCap = 'round'; g.lineJoin = 'round'
    for (const e of building.edges) {
      const [ax, az] = P(byId[e.from].x, byId[e.from].z), [bx, bz] = P(byId[e.to].x, byId[e.to].z)
      // jammed corridors turn red by their peak queue (idea from Bhumika's first version)
      const load = run?.edge_load?.[`${e.from}-${e.to}`] ?? run?.edge_load?.[`${e.to}-${e.from}`] ?? 0
      const jam = Math.min(1, load / Math.max(1, run?.peak_queue ?? 1))
      g.strokeStyle = jam > 0.15 ? `rgba(200, 30, 30, ${0.25 + 0.6 * jam})` : '#e2e6ea'; g.lineWidth = Math.max(2, e.width * s)
      g.beginPath(); g.moveTo(ax, az); g.lineTo(bx, bz); g.stroke()
    }
    // escape routes: one ribbon per door of each room, to its assigned exit
    g.strokeStyle = cssVar('--route'); g.globalAlpha = 0.55; g.lineWidth = 3
    for (const paths of Object.values(run?.door_routes ?? {})) for (const path of paths) {
      if (!path.every(id => byId[id])) continue // run from another building: skip
      g.beginPath(); path.forEach((id, k) => { const [x, z] = P(byId[id].x, byId[id].z); if (k) g.lineTo(x, z); else g.moveTo(x, z) }); g.stroke()
    }
    g.globalAlpha = 1
    for (const n of building.nodes.filter(n => n.type === 'room')) {
      const w = n.w ?? 4, d = n.d ?? 4, [x, z] = P(n.x - w / 2, n.z - d / 2)
      g.fillStyle = '#fff'; g.strokeStyle = cssVar('--wall'); g.lineWidth = 2
      g.fillRect(x, z, w * s, d * s); g.strokeRect(x, z, w * s, d * s)
      g.fillStyle = cssVar('--muted'); g.font = '12px Segoe UI'; g.fillText(n.label ?? n.id, x + 4, z + 14, w * s - 8)
    }
    for (const n of exits) {
      const [x, z] = P(n.x, n.z), off = blocked.includes(n.id)
      g.fillStyle = cssVar(off ? '--queue' : '--accent'); g.beginPath(); g.arc(x, z, 11, 0, 7); g.fill()
      if (off) { g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.moveTo(x - 6, z - 6); g.lineTo(x + 6, z + 6); g.moveTo(x + 6, z - 6); g.lineTo(x - 6, z + 6); g.stroke() }
      g.fillStyle = cssVar('--ink'); g.font = '600 12px Segoe UI'; g.textAlign = x > c.width * 0.8 ? 'right' : 'left'
      g.fillText((off ? 'BLOCKED: ' : '') + (n.label ?? n.id), x + (g.textAlign === 'right' ? -16 : 16), z + 4); g.textAlign = 'left'
    }
    const f = run?.frames[i]
    if (f) for (const [x, z, st] of f.people) {
      if (st === 'out') continue
      const [px, pz] = P(x, z)
      g.fillStyle = cssVar(STATE_VAR[st] ?? '--inside'); g.beginPath(); g.arc(px, pz, 2.6, 0, 7); g.fill()
    }
  }, [building, view, run, i, blocked, mode3d])

  const counts: Record<string, number> = {}
  for (const p of f?.people ?? []) counts[p[2]] = (counts[p[2]] ?? 0) + 1
  // compare a blocked run with the same plan with all exits open (never across plans)
  const delta = run && baseline[plan] !== undefined && blocked.length ? run.total_time_s - baseline[plan] : undefined

  return (
    <div className="page">
      <h1 className="page-title" style={{ marginBottom: 4 }}>The twin</h1>
      <p style={{ color: 'var(--muted)', margin: '6px 0 16px' }}>{building?.name}</p>
      <div className="ctl-row">
        <div className="ctl"><span>Building</span>
          <div className="seg">{SOURCES.map(src => <button key={src.id} className={src.id === source.id ? 'on' : ''} onClick={() => setSource(src)}>{src.label}</button>)}</div></div>
        <div className="ctl"><span>Plan</span>
          <div className="seg">
            <button className={plan === 'nearest' ? 'on' : ''} onClick={() => setPlan('nearest')}>Today: nearest exit</button>
            <button className={plan === 'nikaas' ? 'on' : ''} onClick={() => setPlan('nikaas')}>Nikaas plan</button>
          </div></div>
      </div>
      {source.id === 'vision' && building && (
        <div style={{ background: '#fff8e6', border: '1px solid #e8c56a', padding: '8px 12px', marginBottom: 12, fontSize: 14 }}>
          Read from the photo in one model call: {building.nodes.filter(n => n.type === 'room').length} rooms and{' '}
          {exits.length} exit{exits.length === 1 ? '' : 's'} found. Missing exits make everyone queue at one door, so exits need a
          human check before the times are trusted (hand-digitised: 3 exits). Details: <code>runs/vision_check.md</code>.
          {qa && <div style={{ marginTop: 6 }}>
            Graph check (<code>/qa</code>): score {qa.score} of 100, {qa.status}.{' '}
            {qa.warnings.filter(w => w.severity === 'warning').slice(0, 2).map(w => w.message).join(' ')}
          </div>}
        </div>
      )}
      <div className="ctl-row">
        <div className="ctl">
          <span>Crowd behaviour — how many follow the plan?</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            <div className="seg">
              {PROFILES.map(p => (
                <button key={p.id} title={p.desc}
                  className={compliance === p.compliance ? 'on' : ''}
                  onClick={() => setCompliance(p.compliance)}>
                  {p.label}
                </button>
              ))}
              <button className={compliance === 1.0 ? 'on' : ''} onClick={() => setCompliance(1.0)}>Full (100%)</button>
            </div>
            <input type="range" min={0} max={100} step={5} value={Math.round(compliance * 100)}
              style={{ width: 120 }}
              aria-label="Compliance percentage"
              onChange={e => setCompliance(Number(e.target.value) / 100)} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, minWidth: 36 }}>{Math.round(compliance * 100)}%</span>
          </div>
          {compliance < 1.0 && (
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {Math.round((1 - compliance) * 100)}% of occupants ignore the plan and take the nearest exit instead.
              {' '}The Nikaas plan routes the remaining {Math.round(compliance * 100)}% to compensate.
            </div>
          )}
          <button
            disabled={comparing || !building || !API}
            style={{ marginTop: 10, padding: '7px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: comparing || !API ? 0.6 : 1 }}
            onClick={async () => {
              if (!building) return
              setComparing(true); setCompareResults([])
              try {
                const scenarios = [
                  { label: 'Panic (30%)', compliance: 0.3 },
                  { label: 'Guided (90%)', compliance: 0.9 },
                  { label: 'Full plan (100%)', compliance: 1.0 },
                ]
                const results = await Promise.all(
                  scenarios.map(s => fetchRun(building, blocked, source, plan, s.compliance).then(run => ({ ...s, run })))
                )
                setCompareResults(results)
              } catch (e) { setError(String((e as Error).message ?? e)) }
              finally { setComparing(false) }
            }}
          >
            {comparing ? 'Running comparison…' : 'Compare Panic / Guided / Full side by side'}
          </button>
          {!API && <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 10 }}>Live API required</span>}
        </div>
      </div>
      <div className="ctl-row">
        <div className="ctl"><span>Block an exit (or tap one on the map)</span>
          <div className="chips">
            {exits.map(n => <button key={n.id} className={blocked.includes(n.id) ? 'fire' : ''} aria-pressed={blocked.includes(n.id)} onClick={() => toggleExit(n.id)}>{n.label ?? n.id}</button>)}
            {blocked.length > 0 && <button className="quiet" onClick={() => setBlocked([])}>Clear fires</button>}
          </div></div>
      </div>
      {DEMO && caption && <div style={{ background: '#111417', color: '#fff', padding: '12px 16px', marginBottom: 12, fontSize: 20 }}>{caption}</div>}
      {error && <div role="alert" style={{ background: '#fdecec', border: '1px solid var(--queue)', padding: '8px 12px', marginBottom: 12 }}>{error}</div>}
      <div className="layout">
        <div style={{ position: 'relative' }}>
          {mode3d && building
            ? <View3D building={building} frame={f} blocked={blocked} routes={run?.door_routes} edgeLoad={run?.edge_load} bottleneck={run?.bottleneck} peakQueue={run?.peak_queue} onExit={toggleExit} />
            : <canvas ref={canvas} width={1000} height={560} onClick={onCanvasClick}
                style={{ width: '100%', background: 'var(--card)', border: '1px solid var(--line)', cursor: 'pointer' }} />}
          {!run && !error && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Simulating {building?.nodes.reduce((n, x) => n + ((x as { people?: number }).people ?? 0), 0) ?? ''} people…</div>}
          <div className="player">
            <button className="play" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? '❚❚' : '▶'}</button>
            <button className="quiet" onClick={() => setI(0)}>Restart</button>
            <span className="t">{fmt(f?.t ?? 0)}</span>
            <input type="range" min={0} max={Math.max(0, (run?.frames.length ?? 1) - 1)} value={i} aria-label="Evacuation timeline" disabled={!run}
              onChange={e => { setPlaying(false); setI(Number(e.target.value)) }} />
            <span className="t">{run ? fmt(run.total_time_s) : '--:--'}</span>
            <div className="seg small">{[1, 2, 4, 8].map(v => <button key={v} className={v === speed ? 'on' : ''} onClick={() => setSpeed(v)}>{v}×</button>)}</div>
            <div className="seg small">
              <button className={mode3d ? 'on' : ''} onClick={() => setMode3d(true)}>3D</button>
              <button className={mode3d ? '' : 'on'} onClick={() => setMode3d(false)}>2D</button>
            </div>
          </div>
        </div>
        <aside style={{ background: 'var(--card)', border: '1px solid var(--line)', padding: 16 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 56, lineHeight: 1 }}>{fmt(f?.t ?? 0)}</div>
          <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>simulated time</div>
          {LEGEND.map(([k, label, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 14, padding: '3px 0' }}>
              <span style={{ fontFamily: 'var(--sans)' }}><b style={{ display: 'inline-block', width: 10, height: 10, background: `var(${v})`, marginRight: 8 }} />{label}</span>
              <span>{counts[k] ?? 0}</span>
            </div>
          ))}
          <hr style={{ border: 0, borderTop: '1px solid var(--line)' }} />
          <Stat label="Total evacuation" value={run ? `${run.total_time_s} s${delta !== undefined ? `  (${delta >= 0 ? '+' : ''}${delta.toFixed(1)} s vs all exits open)` : ''}` : '…'} />
          {run?.p95_time_s !== undefined && <Stat label="95th-percentile (last 5% out)" value={`${run.p95_time_s} s`} />}
          {run?.compliance !== undefined && run.compliance < 1.0 && (
            <Stat label="Compliance modelled" value={`${Math.round(run.compliance * 100)}% follow plan · ${Math.round((1 - run.compliance) * 100)}% take nearest exit`} />
          )}
          {run?.nearest_s !== undefined && (
            <div style={{ background: '#ecfdf3', border: '1px solid var(--accent)', padding: '8px 10px', marginTop: 8 }}>
              <div style={{ fontFamily: 'var(--serif)', fontSize: 26, color: 'var(--accent)' }}>
                {(run.nearest_s - run.total_time_s).toFixed(1)} s faster
              </div>
              <div style={{ fontSize: 13 }}>than the nearest-exit rule ({run.nearest_s} s), {(100 * (run.nearest_s - run.total_time_s) / run.nearest_s).toFixed(1)}% saved</div>
              {run.lower_bound_s !== undefined && <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 4 }}>
                within {(run.total_time_s - run.lower_bound_s).toFixed(1)} s of the fastest possible ({run.lower_bound_s} s, proven lower bound)</div>}
            </div>
          )}
          <Stat label="Bottleneck (peak queue)" value={run ? `${run.bottleneck} (${run.peak_queue})` : '…'} />
          <Stat label="People per exit" value={run ? Object.entries(run.per_exit).map(([k, v]) => `${k} ${v}`).join(' · ') : '…'} />
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
            {!API || DEMO ? 'Saved runs (demo mode).' : source.offline && !blocked.length ? 'Precomputed run (saved from the simulator); blocking an exit simulates it live on AWS.' : 'Live: simulated on AWS for every change.'} Simulator validated against the SFPE handbook example.
          </div>
        </aside>
      </div>
      {building && !DEMO && <BeatNikaas api={API} building={building} blocked={blocked} startPlan={plan === 'nearest' ? run?.plan : undefined} />}
      {compareResults.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22, margin: 0 }}>Side-by-side comparison</h2>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>Same building · Same plan · Same blocked exits</span>
            <button className="quiet" style={{ marginLeft: 'auto' }} onClick={() => setCompareResults([])}>✕ Close</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${compareResults.length}, 1fr)`, gap: 12 }}>
            {compareResults.map((cr, idx) => {
              const best = compareResults.reduce((a, b) => a.run.total_time_s < b.run.total_time_s ? a : b)
              const isBest = cr === best
              const worstTime = Math.max(...compareResults.map(r => r.run.total_time_s))
              const pct = worstTime > 0 ? (cr.run.total_time_s / worstTime) * 100 : 100
              return (
                <div key={idx} style={{ background: isBest ? '#ecfdf3' : 'var(--card)', border: `2px solid ${isBest ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 10, padding: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{cr.label}</div>
                  {isBest && <div style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600, marginBottom: 8 }}>✓ Fastest evacuation</div>}
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 42, lineHeight: 1, color: isBest ? 'var(--accent)' : 'var(--ink)', marginBottom: 4 }}>
                    {fmt(cr.run.total_time_s)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 10 }}>total evacuation time</div>
                  <div style={{ height: 6, background: 'var(--line)', borderRadius: 3, marginBottom: 12 }}>
                    <div style={{ height: 6, width: `${pct}%`, background: isBest ? 'var(--accent)' : 'var(--queue)', borderRadius: 3 }} />
                  </div>
                  {cr.run.p95_time_s !== undefined && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>95th-percentile movement time</div>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: 15 }}>{cr.run.p95_time_s} s</div>
                    </div>
                  )}
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>Peak queue size</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 15 }}>{cr.run.peak_queue}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--muted)' }}>People per exit</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}>
                      {Object.entries(cr.run.per_exit).map(([k, v]) => <div key={k}>{k}: {v}</div>)}
                    </div>
                  </div>
                  {idx > 0 && (() => {
                    const diff = compareResults[0].run.total_time_s - cr.run.total_time_s
                    return diff !== 0 ? (
                      <div style={{ marginTop: 10, fontSize: 13, color: diff > 0 ? 'var(--accent)' : 'var(--queue)', fontWeight: 600 }}>
                        {diff > 0 ? `${diff.toFixed(1)} s faster` : `${Math.abs(diff).toFixed(1)} s slower`} than Panic
                      </div>
                    ) : null
                  })()}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 15 }}>{value}</div>
    </div>
  )
}
