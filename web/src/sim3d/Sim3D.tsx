import { useEffect, useRef, useState } from 'react'
import { DrillEngine, type HudState, type Scenario, type Tool } from './engine.ts'
import type { Plan } from './plan.ts'
import { BUNDLED_FILES, listSites, loadPlan, parseKey, sourceFromHash, sourceHash, sourceKey, type SiteItem, type Source } from './load.ts'
import './sim3d.css'

type Opts = { scenario: Scenario; startRoom: string }
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const read = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1' } catch { return d } }
const write = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0') } catch { /* private mode */ } }

const SCENARIOS: { id: Scenario; title: string; text: string }[] = [
  { id: 'fire', title: 'Fire', text: 'A fire starts on the floor below the start room. Smoke detection raises the alarm.' },
  { id: 'quake', title: 'Earthquake', text: 'Strong shaking, falling debris, and one stair is damaged.' },
  { id: 'collapse', title: 'Ceiling collapse', text: 'Part of a ceiling falls and blocks a corridor on the way out.' },
  { id: 'drill', title: 'False alarm', text: 'A manual call point is activated. No fire, full evacuation.' },
]
const PHASES: [string, string][] = [['calm', 'Normal'], ['alarm', 'Alarm'], ['assess', 'Exit check'], ['evacuate', 'Evacuation'], ['clear', 'Complete']]
const STATUS: Record<string, string> = { safe: 'Safe', smoke: 'Smoke', blocked: 'Blocked', cut: 'Cut off', unknown: 'Not checked' }

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)
const I = {
  fire: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1.2-3.6 2.4-4.6.2 1.6 1 2.6 2.1 3.1C11 9 11.2 6 12 3z',
  collapse: 'M3 5h18M6 5l2 4M12 5v3M18 5l-2 5M5 15l3-2 3 3-3 2zM13 14l4-1 1 4-4 1zM3 21h18',
  stairs: 'M3 20h4v-4h4v-4h4V8h4V4M14 15l5 5M19 15l-5 5',
  quake: 'M2 12h3l2-6 3 12 3-9 2 5 2-2h5',
  alarm: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4M4 4l2 2M20 4l-2 2',
  play: 'M7 4l13 8-13 8z', pause: 'M7 4h3v16H7zM14 4h3v16h-3z', restart: 'M4 4v6h6M20 12a8 8 0 1 1-2.3-5.7L20 9',
  sound: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11', mute: 'M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', help: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5', camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', back: 'M15 5l-7 7 7 7',
  flash: 'M13 2L4 14h7l-1 8 9-12h-7z', down: 'M6 9l6 6 6-6', building: 'M4 21V5l8-3 8 3v16M9 21v-4h6v4M8 8h2M14 8h2M8 12h2M14 12h2',
}

/** Loads the building named in the URL, then runs the drill on it. */
export default function Sim3D() {
  const [src, setSrc] = useState<Source>(() => sourceFromHash())
  const key = sourceKey(src)
  const [loaded, setLoaded] = useState<{ key: string; plan?: Plan; error?: string } | null>(null)
  const [run, setRun] = useState(0)
  const [opts, setOpts] = useState<Opts>({ scenario: 'fire', startRoom: '' })
  useEffect(() => {
    const on = () => setSrc(s => { const n = sourceFromHash(); return sourceKey(n) === sourceKey(s) ? s : n })
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  useEffect(() => {
    let dead = false
    loadPlan(parseKey(key)).then(
      plan => { if (!dead) setLoaded({ key, plan }) },
      (e: unknown) => { if (!dead) setLoaded({ key, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { dead = true }
  }, [key])

  if (!loaded || loaded.key !== key) return <div className="sim3d"><div className="d-loading" role="status"><span />Loading the building…</div></div>
  if (!loaded.plan) {
    return (
      <div className="sim3d">
        <div className="d-overlay">
          <div className="d-card d-error" role="alert">
            <div className="d-kicker">Building not loaded</div>
            <h1>We could not open this building</h1>
            <p className="d-lede">{loaded.error}</p>
            <div className="d-brief-foot"><a className="d-go" href="#/sim">Open the demo block</a><a className="d-link" href="#/">Back to Nikaas</a></div>
          </div>
        </div>
      </div>
    )
  }
  const plan = loaded.plan
  const startRoom = plan.rooms.some(r => r.id === opts.startRoom) ? opts.startRoom : plan.defaultStart
  return <DrillRun key={`${key}#${run}`} plan={plan} source={src} opts={{ scenario: opts.scenario, startRoom }} onRestart={o => { setOpts(o); setRun(k => k + 1) }} />
}

function DrillRun({ plan, source, opts, onRestart }: { plan: Plan; source: Source; opts: Opts; onRestart: (o: Opts) => void }) {
  const host = useRef<HTMLDivElement>(null), labels = useRef<HTMLDivElement>(null), map = useRef<HTMLCanvasElement>(null)
  const eng = useRef<DrillEngine | null>(null)
  const [hud, setHud] = useState<HudState | null>(null)
  const [scenario, setScenario] = useState<Scenario>(opts.scenario)
  const [room, setRoom] = useState(opts.startRoom)
  const [bigMap, setBigMap] = useState(false)
  const [help, setHelp] = useState(false)
  const [stairMenu, setStairMenu] = useState(false)
  const [muted, setMuted] = useState(() => read('nikaas-sim3d-muted', false))
  const [flash, setFlash] = useState(() => read('nikaas-sim3d-flash', !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches))
  const LV = plan.levels

  useEffect(() => {
    const e = new DrillEngine(host.current!, labels.current!, setHud, { plan, scenario: opts.scenario, startRoom: opts.startRoom, muted, flash })
    eng.current = e
    e.setMinimap(map.current)
    void e.init()
    return () => { e.dispose(); eng.current = null }
    // the engine lives for one run; restarts and building changes remount this component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const e = eng.current
  const phase = hud?.phase ?? 'briefing'
  const live = phase !== 'briefing'
  const tool = hud?.tool ?? null
  const setTool = (t: Tool) => { setStairMenu(false); e?.setTool(tool === t ? null : t) }
  const hasStairs = plan.stairs.length > 0

  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      const en = eng.current, tag = (ev.target as HTMLElement)?.tagName
      if (!en || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const k = ev.key
      if (k === 'Escape') { en.setTool(null); setStairMenu(false); setHelp(false); setBigMap(false); return }
      if (k === 'h' || k === 'H' || k === '?') { setHelp(v => !v); return }
      if (!live) { if (k === 'Enter' && tag !== 'BUTTON' && tag !== 'A') en.begin(); return }
      if (k === '1') en.setTool(hud?.tool === 'fire' ? null : 'fire')
      else if (k === '2') en.setTool(hud?.tool === 'collapse' ? null : 'collapse')
      else if (k === '3' && hasStairs) setStairMenu(v => !v)
      else if (k === '4') en.earthquake()
      else if (k === '5') en.falseAlarm()
      else if (k === ' ' && tag !== 'BUTTON') { ev.preventDefault(); en.setPaused(!hud?.paused) }
      else if (k === 'm' || k === 'M') setBigMap(v => !v)
      else if (k === 'x' || k === 'X') en.setExplode(!hud?.explode)
      else if (k === 'c' || k === 'C') en.setCinematic(!hud?.cinematic)
      else if (k === ']') en.setFocus(Math.min(LV - 1, (hud?.focus ?? LV - 1) + 1))
      else if (k === '[') en.setFocus(Math.max(0, (hud?.focus ?? LV - 1) - 1))
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [hud, live, LV, hasStairs])

  const c = hud?.counts
  const pct = c ? Math.round((100 * c.out) / Math.max(1, c.total)) : 0
  const stepIndex = PHASES.findIndex(p => p[0] === phase)
  const startRooms = plan.startRooms.map(id => plan.rooms.find(r => r.id === id)!).filter(Boolean)
  const levelShort = (L: number) => (L === 0 ? 'G' : String(L))
  const levelsDown = [...Array(LV).keys()].reverse()

  return (
    <div className={`sim3d ${hud?.alarm ? 'is-alarm' : ''} ${hud?.alarm && flash ? 'is-flash' : ''} ${hud?.quake ? 'is-quake' : ''} ${tool ? 'is-tool' : ''}`}>
      <div className="d-stage" ref={host} />
      <div className="d-labels" ref={labels} />
      <div className="d-alarm" aria-hidden="true" />

      <header className="d-top">
        <div className="d-brand d-panel">
          <a href="#/" className="d-back" aria-label="Back to Nikaas"><Icon d={I.back} size={18} /></a>
          <div className="d-brand-text">
            <div className="d-brand-name">Evacuation simulation</div>
            <div className="d-brand-sub">{plan.name} · {plan.sub} · {c?.total ?? '…'} people</div>
          </div>
        </div>
        <ol className="d-steps d-panel" aria-label="Simulation phase">
          {PHASES.map(([id, label], k) => <li key={id} className={k < stepIndex ? 'done' : k === stepIndex ? 'now' : ''} aria-current={k === stepIndex ? 'step' : undefined}>{label}</li>)}
        </ol>
        <div className="d-clock d-panel">
          <div className="d-clock-n">{hud?.elapsed != null ? `T+${fmt(hud.elapsed)}` : hud?.clock ?? '09:41:12'}</div>
          <div className="d-clock-l">{hud?.elapsed != null ? 'Since alarm · illustration' : 'Local time'}</div>
        </div>
      </header>

      {hud?.alarm && <div className="d-banner" role="status"><span className="d-dot" aria-hidden="true" />{hud.quake ? 'Earthquake · Drop, cover, hold on' : 'Alarm activated · Evacuate'}</div>}

      <section className={`d-map d-panel ${bigMap ? 'big' : ''}`} aria-label="Floor plan">
        <div className="d-map-head">
          <h2>{bigMap ? 'Floor plans' : 'Floor plan'}</h2>
          {!bigMap && LV > 1 && (
            <div className="d-seg small" role="group" aria-label="Floor shown on the plan">
              {levelsDown.map(L => <button key={L} className={hud?.mapLevel === L ? 'on' : ''} aria-pressed={hud?.mapLevel === L} onClick={() => e?.setMapLevel(L)} title={plan.levelNames[L]}>{levelShort(L)}</button>)}
            </div>
          )}
          <button className="d-icon small" onClick={() => setBigMap(v => !v)} aria-label={bigMap ? 'Shrink floor plan' : 'Expand floor plan'} title="Floor plans (M)"><Icon d={I.expand} size={15} /></button>
        </div>
        <canvas ref={map} role="img" aria-label="Floor plan with people, exits and hazards" />
      </section>

      <aside className="d-left">
        <section className="d-panel" aria-label="Occupancy">
          <h2 className="d-kicker">Evacuated</h2>
          <div className="d-big"><b>{c?.out ?? 0}</b><span>of {c?.total ?? 0}</span><em>{pct}%</em></div>
          <div className="d-bar" role="progressbar" aria-label="Share evacuated" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          <dl className="d-stats">
            <div><dt>Inside</dt><dd>{c?.inside ?? 0}</dd></div>
            <div><dt>On stairs</dt><dd>{c?.stairs ?? 0}</dd></div>
            <div><dt>Moving</dt><dd>{c?.moving ?? 0}</dd></div>
            <div className={c?.trapped ? 'bad' : ''}><dt>Needs rescue</dt><dd>{c?.trapped ?? 0}</dd></div>
          </dl>
        </section>
        <section className="d-panel d-groups" aria-label="Groups">
          <h2 className="d-kicker">Groups{hud?.groups.length ? <span className="d-count">{hud.groups.length}</span> : null}</h2>
          {!hud?.groups.length && <p className="d-muted">{live ? 'Groups are assigned after the exit check.' : `${hud?.startCount ?? '…'} people in ${hud?.startLabel ?? 'the start room'}.`}</p>}
          {hud?.groups.map(g => (
            <div className="d-group" key={g.letter} style={{ ['--g' as string]: g.css }}>
              <span className="d-badge" aria-hidden="true">{g.letter}</span>
              <div className="d-group-main">
                <div className="d-group-top"><b><span className="d-sr">Group {g.letter}, </span>to {g.exitLabel}</b><span>{g.out}/{g.total}</span></div>
                <div className="d-bar thin"><i style={{ width: `${(100 * g.out) / Math.max(1, g.total)}%` }} /></div>
                {g.fromStart > 0 && <div className="d-group-sub">{g.fromStart} from {hud.startLabel}</div>}
              </div>
            </div>
          ))}
        </section>
      </aside>

      <aside className="d-right">
        <section className="d-panel" aria-label="Exits">
          <h2 className="d-kicker">Exits <span className="d-muted">Select to block or reopen</span></h2>
          <div className="d-exits">
            {hud?.exits.map(x => (
              <button className={`d-exit ${x.status}`} key={x.id} onClick={() => e?.toggleExit(x.id)} disabled={!live} aria-label={`Exit ${x.n}, ${x.label}: ${STATUS[x.status]}. ${x.out} out, ${x.assigned} heading there. ${x.closed ? 'Reopen' : 'Block'} this exit.`}>
                <span className="d-exit-n">{x.n}</span>
                <span className="d-exit-l">{x.label}<small>{x.out} out · {x.assigned} heading</small></span>
                <span className="d-chip">{STATUS[x.status]}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="d-panel d-log-panel" aria-label="Event log">
          <h2 className="d-kicker">Event log</h2>
          <ol className="d-log" aria-live="polite">
            {hud?.log.map(l => <li key={l.id} className={l.kind}><time>{l.t}</time><span>{l.text}</span></li>)}
          </ol>
        </section>
      </aside>

      <footer className="d-bottom">
        <div className="d-view d-panel">
          {LV > 1 && (
            <div className="d-seg" role="group" aria-label="Floors shown">
              <span className="d-seg-l" title="Floors shown"><Icon d={I.layers} size={15} /></span>
              {levelsDown.map(L => (
                <button key={L} className={hud?.focus === L ? 'on' : ''} aria-pressed={hud?.focus === L} onClick={() => e?.setFocus(L)} title={L === LV - 1 ? 'All floors' : `Up to ${plan.levelNames[L]}`}>{L === LV - 1 ? 'All' : levelShort(L)}</button>
              ))}
            </div>
          )}
          <div className="d-seg" role="group" aria-label="View options">
            {LV > 1 && <button className={hud?.explode ? 'on' : ''} aria-pressed={!!hud?.explode} onClick={() => e?.setExplode(!hud?.explode)} title="Separate the floors (X)">Separate floors</button>}
            <button className={hud?.roof ? 'on' : ''} aria-pressed={!!hud?.roof} onClick={() => e?.setRoof(!hud?.roof)}>Roof</button>
            <button className={hud?.cinematic ? 'on' : ''} aria-pressed={!!hud?.cinematic} onClick={() => e?.setCinematic(!hud?.cinematic)} title="Automatic camera (C)">Auto camera</button>
          </div>
          <div className="d-seg d-cams" role="group" aria-label="Camera">
            <span className="d-seg-l" title="Camera"><Icon d={I.camera} size={15} /></span>
            <button onClick={() => e?.view('room')}>Room</button>
            <button onClick={() => e?.view('overview')}>Overview</button>
            <button onClick={() => e?.view('top')}>Plan</button>
          </div>
        </div>

        <div className="d-incidents d-panel" role="toolbar" aria-label="Incidents">
          {hud?.hint && <div className="d-hint" role="status">{hud.hint}</div>}
          {stairMenu && live && (
            <div className="d-pop" role="menu" aria-label="Stairs">
              {hud?.stairs.map(s => <button key={s.id} role="menuitem" className={s.blocked ? 'on' : ''} onClick={() => { e?.toggleStair(s.id); setStairMenu(false) }}>{s.blocked ? 'Reopen' : 'Block'} {s.label}</button>)}
            </div>
          )}
          <span className="d-tb-label">Incidents</span>
          <ToolButton label="Fire" icon={I.fire} on={tool === 'fire'} disabled={!live} onClick={() => setTool('fire')} />
          <ToolButton label="Ceiling collapse" short="Collapse" icon={I.collapse} on={tool === 'collapse'} disabled={!live} onClick={() => setTool('collapse')} />
          <ToolButton label="Block stair" icon={I.stairs} on={stairMenu} menu disabled={!live || !hasStairs} title={hasStairs ? undefined : 'This building has no stairs'} onClick={() => { e?.setTool(null); setStairMenu(v => !v) }} />
          <ToolButton label="Earthquake" icon={I.quake} disabled={!live || !!hud?.quake} onClick={() => e?.earthquake()} />
          <ToolButton label="False alarm" icon={I.alarm} disabled={!live || !!hud?.alarm} onClick={() => e?.falseAlarm()} />
        </div>

        <div className="d-time d-panel" role="group" aria-label="Playback">
          <button className="d-icon" onClick={() => e?.setPaused(!hud?.paused)} aria-label={hud?.paused ? 'Resume' : 'Pause'} title="Pause (Space)" disabled={!live}><Icon d={hud?.paused ? I.play : I.pause} size={17} /></button>
          <div className="d-seg" role="group" aria-label="Speed">{[1, 2, 4].map(s => <button key={s} className={hud?.speed === s ? 'on' : ''} aria-pressed={hud?.speed === s} onClick={() => e?.setSpeed(s)}>{s}×</button>)}</div>
          <button className="d-icon" onClick={() => onRestart({ scenario, startRoom: room })} aria-label="Restart simulation" title="Restart"><Icon d={I.restart} size={17} /></button>
          <button className="d-icon" onClick={() => { const m = !muted; setMuted(m); write('nikaas-sim3d-muted', m); e?.setMuted(m) }} aria-label={muted ? 'Turn sound on' : 'Turn sound off'} aria-pressed={!muted} title="Sound"><Icon d={muted ? I.mute : I.sound} size={17} /></button>
          <button className={`d-icon ${flash ? '' : 'off'}`} onClick={() => { const f = !flash; setFlash(f); write('nikaas-sim3d-flash', f); e?.setFlash(f) }} aria-label={flash ? 'Turn off the alarm frame' : 'Turn on the alarm frame'} aria-pressed={flash} title="Red alarm frame"><Icon d={I.flash} size={17} /></button>
          <button className="d-icon" onClick={() => setHelp(v => !v)} aria-label="Controls" title="Controls (H)"><Icon d={I.help} size={17} /></button>
        </div>
      </footer>

      {phase === 'briefing' && (
        <div className="d-overlay">
          <div className="d-card d-brief" role="dialog" aria-modal="false" aria-labelledby="d-brief-title">
            <div className="d-kicker">Evacuation simulation</div>
            <h1 id="d-brief-title">{plan.name}</h1>
            <p className="d-lede">
              {plan.kind === 'demo' ? 'A three-storey teaching block during a normal morning. ' : `${plan.sub}, ${c?.total ?? '…'} occupants from the building plan. `}
              Choose an incident and where the main group starts, then follow the alarm, the exit check, and the evacuation group by group.
            </p>
            <BuildingPicker source={source} plan={plan} />
            <fieldset className="d-field">
              <legend className="d-kicker">Incident</legend>
              <div className="d-scen">
                {SCENARIOS.map(s => (
                  <label key={s.id} className={scenario === s.id ? 'on' : ''}>
                    <input type="radio" name="d-scenario" value={s.id} checked={scenario === s.id} onChange={() => { setScenario(s.id); e?.setScenario(s.id) }} />
                    <span className="d-scen-i"><Icon d={{ fire: I.fire, quake: I.quake, collapse: I.collapse, drill: I.alarm }[s.id]} size={18} /></span>
                    <b>{s.title}</b><span className="d-scen-t">{s.text}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="d-field">
              <legend className="d-kicker">Start room</legend>
              <div className="d-rooms">
                {startRooms.map(r => (
                  <label key={r.id} className={room === r.id ? 'on' : ''}>
                    <input type="radio" name="d-room" value={r.id} checked={room === r.id} onChange={() => { setRoom(r.id); e?.setStartRoom(r.id) }} />
                    <span>{r.label}</span><small>{plan.levelNames[r.level]} · {r.people} people</small>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="d-brief-foot">
              <button className="d-go" onClick={() => e?.begin()} disabled={!hud?.ready}>{hud?.ready ? 'Start simulation' : 'Preparing the model…'}</button>
              <span className="d-muted">Drag to orbit, right-drag to pan, scroll to zoom. Times shown are illustrative.</span>
            </div>
          </div>
        </div>
      )}

      {phase === 'clear' && hud?.summary && (
        <div className="d-overlay soft">
          <div className="d-card d-sum" role="dialog" aria-modal="false" aria-labelledby="d-sum-title">
            <div className={`d-kicker ${hud.summary.trapped ? 'warn' : 'good'}`} id="d-sum-title">{hud.summary.trapped ? 'Evacuation ended' : 'Evacuation complete'}</div>
            <div className="d-sum-time">{fmt(hud.summary.time)}<span>from alarm to the last person out, in this illustration</span></div>
            {/* this view walks free agents with no door or stair flow limits; judges must not mistake its times for ours */}
            <p className="d-sum-note">
              Illustration: free walkers with no door or stair flow limits. Validated evacuation times are on
              the <a href="#/twin">Twin</a> and <a href="#/evidence">Evidence</a> pages.
            </p>
            <div className="d-sum-grid">
              <div><b>{hud.summary.out}</b><span>of {hud.summary.total} evacuated</span></div>
              <div className={hud.summary.trapped ? 'bad' : ''}><b>{hud.summary.trapped}</b><span>need rescue</span></div>
              <div><b>{hud.summary.groups}</b><span>groups, {hud.summary.reroutes} re-routed</span></div>
              <div><b>{hud.summary.incidents}</b><span>incidents</span></div>
            </div>
            <div className="d-sum-exits">
              {hud.summary.perExit.map(x => (
                <div key={x.label}><span>{x.label}</span><i style={{ width: `${(100 * x.n) / Math.max(1, hud.summary!.out)}%` }} /><b>{x.n}</b></div>
              ))}
            </div>
            <div className="d-brief-foot">
              <button className="d-go" onClick={() => onRestart({ scenario, startRoom: room })}>Run again</button>
              <span className="d-muted">The scene stays live: keep exploring, or add incidents and watch who re-routes.</span>
            </div>
          </div>
        </div>
      )}

      {help && (
        <div className="d-overlay" onClick={() => setHelp(false)}>
          <div className="d-card d-help" role="dialog" aria-modal="true" aria-labelledby="d-help-title" onClick={ev => ev.stopPropagation()}>
            <h2 className="d-kicker" id="d-help-title">Controls</h2>
            <dl>
              <div><dt>Left drag</dt><dd>Orbit</dd></div><div><dt>Right drag</dt><dd>Pan</dd></div><div><dt>Scroll</dt><dd>Zoom</dd></div>
              <div><dt><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></dt><dd>Move</dd></div><div><dt><kbd>Q</kbd> / <kbd>E</kbd></dt><dd>Turn</dd></div><div><dt><kbd>R</kbd> / <kbd>F</kbd></dt><dd>Up / down</dd></div>
              <div><dt><kbd>1</kbd> Fire · <kbd>2</kbd> Collapse</dt><dd>Place an incident</dd></div><div><dt><kbd>3</kbd> Stair · <kbd>4</kbd> Quake · <kbd>5</kbd> Alarm</dt><dd>Other incidents</dd></div>
              <div><dt><kbd>[</kbd> / <kbd>]</kbd></dt><dd>Floors shown</dd></div><div><dt><kbd>X</kbd></dt><dd>Separate floors</dd></div>
              <div><dt><kbd>C</kbd></dt><dd>Auto camera</dd></div><div><dt><kbd>M</kbd></dt><dd>Floor plans</dd></div><div><dt><kbd>Space</kbd></dt><dd>Pause</dd></div>
              <div><dt>Select an exit beam</dt><dd>Block / reopen exit</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Cancel / close</dd></div>
            </dl>
            <button className="d-go small" onClick={() => setHelp(false)} autoFocus>Close</button>
          </div>
        </div>
      )}
      {!hud?.ready && <div className="d-loading" role="status"><span />Preparing the model…</div>}
    </div>
  )
}

function ToolButton({ label, short, icon, on, menu, disabled, title, onClick }: { label: string; short?: string; icon: string; on?: boolean; menu?: boolean; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button className={`d-tb ${on ? 'on' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={menu ? undefined : !!on} aria-expanded={menu ? !!on : undefined} aria-haspopup={menu ? 'menu' : undefined} aria-label={label} title={title ?? label}>
      <Icon d={icon} size={16} /><span className="d-tb-t">{short ?? label}</span>{menu && <Icon d={I.down} size={12} />}
    </button>
  )
}

/** Demo block, the API's sites when it answers, otherwise the example buildings shipped with the app. */
function BuildingPicker({ source, plan }: { source: Source; plan: Plan }) {
  const [sites, setSites] = useState<SiteItem[] | null>(null)
  useEffect(() => {
    let dead = false
    listSites().then(s => { if (!dead) setSites(s) }, () => { if (!dead) setSites([]) })
    return () => { dead = true }
  }, [])
  const cur = sourceKey(source)
  const opts: { key: string; label: string }[] = [{ key: 'demo', label: 'Demo block (3 storeys)' }]
  if (sites?.length) for (const s of sites) opts.push({ key: `site:${s.id}`, label: `${s.name}${s.floors ? ` (${s.floors} ${s.floors === 1 ? 'floor' : 'floors'})` : ''}` })
  else for (const f of BUNDLED_FILES) opts.push({ key: `file:${f.path}`, label: f.label })
  if (!opts.some(o => o.key === cur)) opts.push({ key: cur, label: plan.name })
  return (
    <div className="d-field">
      <label className="d-kicker" htmlFor="d-building">Building</label>
      <div className="d-select">
        <Icon d={I.building} size={16} />
        <select id="d-building" value={cur} onChange={ev => { location.hash = sourceHash(parseKey(ev.target.value)) }}>
          {opts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <Icon d={I.down} size={14} />
      </div>
      {sites === null && <span className="d-muted d-inline">Looking for saved sites…</span>}
    </div>
  )
}
