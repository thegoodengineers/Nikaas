import { useEffect, useRef, useState } from 'react'
import { DrillEngine, START_ROOMS, type HudState, type Scenario, type Tool } from './engine.ts'
import { ROOMS, LEVELS, LEVEL_NAMES } from './layout.ts'
import './sim3d.css'

type Opts = { scenario: Scenario; startRoom: string }
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const read = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1' } catch { return d } }
const write = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0') } catch { /* private mode */ } }

const SCENARIOS: { id: Scenario; title: string; text: string }[] = [
  { id: 'fire', title: 'Fire', text: 'A fire starts on the floor below. Smoke detectors raise the alarm.' },
  { id: 'quake', title: 'Earthquake', text: 'Strong shaking, falling plaster, and a stair cracks shut.' },
  { id: 'collapse', title: 'Roof collapse', text: 'Part of the ceiling comes down and cuts a corridor in two.' },
  { id: 'drill', title: 'False alarm', text: 'Someone pulls a call point. No fire, but everyone must leave.' },
]
const PHASES: [string, string][] = [['calm', 'Calm'], ['alarm', 'Alarm'], ['assess', 'Scan exits'], ['evacuate', 'Evacuate'], ['clear', 'All clear']]

const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
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
  flash: 'M13 2L4 14h7l-1 8 9-12h-7z', roof: 'M3 11l9-7 9 7M5 10v10h14V10',
}

export default function Sim3D() {
  const [run, setRun] = useState(0)
  const [opts, setOpts] = useState<Opts>({ scenario: 'fire', startRoom: 'seminar' })
  return <DrillRun key={run} opts={opts} onRestart={o => { setOpts(o); setRun(k => k + 1) }} />
}

function DrillRun({ opts, onRestart }: { opts: Opts; onRestart: (o: Opts) => void }) {
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

  useEffect(() => {
    const e = new DrillEngine(host.current!, labels.current!, setHud, { scenario: opts.scenario, startRoom: opts.startRoom, muted, flash })
    eng.current = e
    e.setMinimap(map.current)
    void e.init()
    return () => { e.dispose(); eng.current = null }
    // the engine lives for one run; restarts remount this component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const e = eng.current
  const phase = hud?.phase ?? 'briefing'
  const live = phase !== 'briefing'
  const tool = hud?.tool ?? null
  const setTool = (t: Tool) => { setStairMenu(false); e?.setTool(tool === t ? null : t) }

  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      const en = eng.current
      if (!en || (ev.target as HTMLElement)?.tagName === 'INPUT') return
      const k = ev.key
      if (k === 'Escape') { en.setTool(null); setStairMenu(false); setHelp(false); setBigMap(false); return }
      if (k === 'h' || k === 'H' || k === '?') { setHelp(v => !v); return }
      if (!live) { if (k === 'Enter') en.begin(); return }
      if (k === '1') en.setTool(hud?.tool === 'fire' ? null : 'fire')
      else if (k === '2') en.setTool(hud?.tool === 'collapse' ? null : 'collapse')
      else if (k === '3') setStairMenu(v => !v)
      else if (k === '4') en.earthquake()
      else if (k === '5') en.falseAlarm()
      else if (k === ' ') { ev.preventDefault(); en.setPaused(!hud?.paused) }
      else if (k === 'm' || k === 'M') setBigMap(v => !v)
      else if (k === 'x' || k === 'X') en.setExplode(!hud?.explode)
      else if (k === 'c' || k === 'C') en.setCinematic(!hud?.cinematic)
      else if (k === ']') en.setFocus(Math.min(LEVELS - 1, (hud?.focus ?? 2) + 1))
      else if (k === '[') en.setFocus(Math.max(0, (hud?.focus ?? 2) - 1))
    }
    addEventListener('keydown', on)
    return () => removeEventListener('keydown', on)
  }, [hud, live])

  const c = hud?.counts
  const pct = c ? Math.round((100 * c.out) / Math.max(1, c.total)) : 0
  const stepIndex = PHASES.findIndex(p => p[0] === phase)
  const startRooms = START_ROOMS.map(id => ROOMS.find(r => r.id === id)!)

  return (
    <div className={`sim3d ${hud?.alarm ? 'is-alarm' : ''} ${hud?.alarm && flash ? 'is-flash' : ''} ${hud?.quake ? 'is-quake' : ''} ${tool ? 'is-tool' : ''}`}>
      <div className="d-stage" ref={host} />
      <div className="d-labels" ref={labels} />
      <div className="d-alarm" aria-hidden="true" />

      {/* top bar */}
      <header className="d-top">
        <div className="d-brand">
          <a href="#/" className="d-back" aria-label="Back to Nikaas"><Icon d={I.back} size={18} /></a>
          <div>
            <div className="d-brand-name">NIKAAS <span>3D SIM</span></div>
            <div className="d-brand-sub">Block C · 3 storeys · {c?.total ?? '…'} people · 4 exits</div>
          </div>
        </div>
        <ol className="d-steps" aria-label="Drill phase">
          {PHASES.map(([id, label], k) => <li key={id} className={k < stepIndex ? 'done' : k === stepIndex ? 'now' : ''}>{label}</li>)}
        </ol>
        <div className="d-clock">
          <div className="d-clock-n">{hud?.elapsed != null ? `T+${fmt(hud.elapsed)}` : hud?.clock ?? '09:41:12'}</div>
          <div className="d-clock-l">{hud?.elapsed != null ? 'since alarm' : 'local time'}</div>
        </div>
      </header>

      {hud?.alarm && <div className="d-banner" role="status"><span className="d-dot" />{hud.quake ? 'EARTHQUAKE · DROP, COVER, HOLD ON' : 'FIRE ALARM · EVACUATE NOW'}</div>}

      {/* minimap */}
      <section className={`d-map ${bigMap ? 'big' : ''}`} aria-label="Floor plan">
        <div className="d-map-head">
          <b>{bigMap ? 'Tactical map · all floors' : 'Map'}</b>
          {!bigMap && <div className="d-seg small">{[2, 1, 0].map(L => <button key={L} className={hud?.mapLevel === L ? 'on' : ''} onClick={() => e?.setMapLevel(L)}>{L === 0 ? 'G' : L}</button>)}</div>}
          <button className="d-icon" onClick={() => setBigMap(v => !v)} aria-label={bigMap ? 'Shrink map' : 'Expand map'} title="Map (M)"><Icon d={I.expand} size={16} /></button>
        </div>
        <canvas ref={map} />
      </section>

      {/* left: occupancy and groups */}
      <aside className="d-left">
        <section className="d-panel">
          <div className="d-kicker">Evacuated</div>
          <div className="d-big"><b>{c?.out ?? 0}</b><span>/ {c?.total ?? 0}</span></div>
          <div className="d-bar"><i style={{ width: `${pct}%` }} /></div>
          <dl className="d-stats">
            <div><dt>Inside</dt><dd>{c?.inside ?? 0}</dd></div>
            <div><dt>On stairs</dt><dd>{c?.stairs ?? 0}</dd></div>
            <div><dt>Moving</dt><dd>{c?.moving ?? 0}</dd></div>
            <div className={c?.trapped ? 'bad' : ''}><dt>Need rescue</dt><dd>{c?.trapped ?? 0}</dd></div>
          </dl>
        </section>
        <section className="d-panel">
          <div className="d-kicker">Crowd groups {hud?.groups.length ? `· ${hud.groups.length}` : ''}</div>
          {!hud?.groups.length && <p className="d-muted">{live ? 'Groups form once the exits are scanned.' : `${hud?.startCount ?? ''} people in the ${hud?.startLabel ?? 'room'}.`}</p>}
          {hud?.groups.map(g => (
            <div className="d-group" key={g.letter} style={{ ['--g' as string]: g.css }}>
              <span className="d-badge">{g.letter}</span>
              <div className="d-group-main">
                <div className="d-group-top"><b>to {g.exitLabel}</b><span>{g.out}/{g.total}</span></div>
                <div className="d-bar thin"><i style={{ width: `${(100 * g.out) / Math.max(1, g.total)}%` }} /></div>
                {g.fromStart > 0 && <div className="d-group-sub">{g.fromStart} from the {hud.startLabel}</div>}
              </div>
            </div>
          ))}
        </section>
      </aside>

      {/* right: exits and log */}
      <aside className="d-right">
        <section className="d-panel">
          <div className="d-kicker">Exits <span className="d-muted">· click to jam or reopen</span></div>
          {hud?.exits.map(x => (
            <button className={`d-exit ${x.status}`} key={x.id} onClick={() => e?.toggleExit(x.id)} disabled={!live}>
              <span className="d-exit-n">{x.n}</span>
              <span className="d-exit-l">{x.label}<small>{x.out} out · {x.assigned} heading</small></span>
              <span className="d-chip">{{ safe: 'Safe', smoke: 'Smoke', blocked: 'Blocked', cut: 'Cut off', unknown: '—' }[x.status]}</span>
            </button>
          ))}
        </section>
        <section className="d-panel d-log-panel">
          <div className="d-kicker">Event feed</div>
          <ol className="d-log">
            {hud?.log.map(l => <li key={l.id} className={l.kind}><time>{l.t}</time><span>{l.text}</span></li>)}
          </ol>
        </section>
      </aside>

      {/* bottom: view controls, incident bar, time controls */}
      <footer className="d-bottom">
        <div className="d-view">
          <div className="d-seg" role="group" aria-label="Floors shown">
            <span className="d-seg-l"><Icon d={I.layers} size={15} /></span>
            {[...Array(LEVELS).keys()].reverse().map(L => (
              <button key={L} className={hud?.focus === L ? 'on' : ''} onClick={() => e?.setFocus(L)} title={L === LEVELS - 1 ? 'All floors' : `Up to ${LEVEL_NAMES[L]}`}>{L === LEVELS - 1 ? 'All' : L === 0 ? 'G' : L}</button>
            ))}
          </div>
          <div className="d-seg">
            <button className={hud?.explode ? 'on' : ''} onClick={() => e?.setExplode(!hud?.explode)} title="Pull floors apart (X)">Explode</button>
            <button className={hud?.roof ? 'on' : ''} onClick={() => e?.setRoof(!hud?.roof)} title="Show the roof">Roof</button>
            <button className={hud?.cinematic ? 'on' : ''} onClick={() => e?.setCinematic(!hud?.cinematic)} title="Automatic camera (C)">Auto cam</button>
          </div>
          <div className="d-seg">
            <span className="d-seg-l"><Icon d={I.camera} size={15} /></span>
            <button onClick={() => e?.view('room')}>Room</button>
            <button onClick={() => e?.view('overview')}>Overview</button>
            <button onClick={() => e?.view('top')}>Top</button>
          </div>
        </div>

        <div className="d-hotbar" role="toolbar" aria-label="Incidents">
          {hud?.hint && <div className="d-hint">{hud.hint}</div>}
          {stairMenu && live && (
            <div className="d-pop" role="menu">
              {hud?.stairs.map(s => <button key={s.id} role="menuitem" className={s.blocked ? 'on' : ''} onClick={() => { e?.toggleStair(s.id); setStairMenu(false) }}>{s.blocked ? 'Reopen' : 'Block'} {s.label}</button>)}
            </div>
          )}
          <Hot k="1" label="Fire" icon={I.fire} on={tool === 'fire'} disabled={!live} onClick={() => setTool('fire')} tone="fire" />
          <Hot k="2" label="Collapse" icon={I.collapse} on={tool === 'collapse'} disabled={!live} onClick={() => setTool('collapse')} tone="stone" />
          <Hot k="3" label="Block stair" icon={I.stairs} on={stairMenu} disabled={!live} onClick={() => { e?.setTool(null); setStairMenu(v => !v) }} tone="stair" />
          <Hot k="4" label="Earthquake" icon={I.quake} disabled={!live || !!hud?.quake} onClick={() => e?.earthquake()} tone="quake" />
          <Hot k="5" label="False alarm" icon={I.alarm} disabled={!live || !!hud?.alarm} onClick={() => e?.falseAlarm()} tone="alarm" />
        </div>

        <div className="d-time">
          <button className="d-icon" onClick={() => e?.setPaused(!hud?.paused)} aria-label={hud?.paused ? 'Play' : 'Pause'} title="Pause (Space)" disabled={!live}><Icon d={hud?.paused ? I.play : I.pause} size={18} /></button>
          <div className="d-seg">{[1, 2, 4].map(s => <button key={s} className={hud?.speed === s ? 'on' : ''} onClick={() => e?.setSpeed(s)}>{s}×</button>)}</div>
          <button className="d-icon" onClick={() => onRestart({ scenario, startRoom: room })} aria-label="Restart" title="Restart"><Icon d={I.restart} size={18} /></button>
          <button className="d-icon" onClick={() => { const m = !muted; setMuted(m); write('nikaas-sim3d-muted', m); e?.setMuted(m) }} aria-label={muted ? 'Sound on' : 'Mute'} title="Sound"><Icon d={muted ? I.mute : I.sound} size={18} /></button>
          <button className={`d-icon ${flash ? '' : 'off'}`} onClick={() => { const f = !flash; setFlash(f); write('nikaas-sim3d-flash', f); e?.setFlash(f) }} aria-label={flash ? 'Turn off screen flashing' : 'Turn on screen flashing'} title="Red alarm flashing"><Icon d={I.flash} size={18} /></button>
          <button className="d-icon" onClick={() => setHelp(v => !v)} aria-label="Controls" title="Controls (H)"><Icon d={I.help} size={18} /></button>
        </div>
      </footer>

      {/* briefing */}
      {phase === 'briefing' && (
        <div className="d-overlay">
          <div className="d-card d-brief">
            <div className="d-kicker">Evacuation digital twin</div>
            <h1>Evacuation sim</h1>
            <p className="d-lede">A calm morning in a three-storey teaching block. Pick what goes wrong and where the crowd starts. Then watch the alarm, the exit scan, and the crowd split into groups that use different exits so no single door is rushed.</p>
            <div className="d-kicker">What happens</div>
            <div className="d-scen">
              {SCENARIOS.map(s => (
                <button key={s.id} className={scenario === s.id ? 'on' : ''} onClick={() => { setScenario(s.id); e?.setScenario(s.id) }}>
                  <span className={`d-scen-i ${s.id}`}><Icon d={{ fire: I.fire, quake: I.quake, collapse: I.collapse, drill: I.alarm }[s.id]} size={26} /></span>
                  <b>{s.title}</b><span>{s.text}</span>
                </button>
              ))}
            </div>
            <div className="d-kicker">Crowd starts in</div>
            <div className="d-rooms">
              {startRooms.map(r => (
                <button key={r.id} className={room === r.id ? 'on' : ''} onClick={() => { setRoom(r.id); e?.setStartRoom(r.id) }}>
                  {r.label}<small>{LEVEL_NAMES[r.level]} · {r.people}</small>
                </button>
              ))}
            </div>
            <div className="d-brief-foot">
              <button className="d-go" onClick={() => e?.begin()} disabled={!hud?.ready}>{hud?.ready ? 'Begin simulation' : 'Building the twin…'}</button>
              <span className="d-muted">Sound on recommended. Drag to orbit, right-drag to pan, scroll to zoom, WASD to move.</span>
            </div>
          </div>
        </div>
      )}

      {/* end */}
      {phase === 'clear' && hud?.summary && (
        <div className="d-overlay soft">
          <div className="d-card d-sum">
            <div className={`d-kicker ${hud.summary.trapped ? 'warn' : 'good'}`}>{hud.summary.trapped ? 'Evacuation ended' : 'Building clear'}</div>
            <div className="d-sum-time">{fmt(hud.summary.time)}<span>from alarm to the last person out</span></div>
            <div className="d-sum-grid">
              <div><b>{hud.summary.out}</b><span>of {hud.summary.total} out safely</span></div>
              <div className={hud.summary.trapped ? 'bad' : ''}><b>{hud.summary.trapped}</b><span>waiting for rescue</span></div>
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
          <div className="d-card d-help" onClick={ev => ev.stopPropagation()}>
            <div className="d-kicker">Controls</div>
            <dl>
              <div><dt>Left drag</dt><dd>Orbit</dd></div><div><dt>Right drag</dt><dd>Pan</dd></div><div><dt>Scroll</dt><dd>Zoom</dd></div>
              <div><dt>W A S D</dt><dd>Move</dd></div><div><dt>Q / E</dt><dd>Turn</dd></div><div><dt>R / F</dt><dd>Up / down</dd></div>
              <div><dt>1 – 5</dt><dd>Incidents</dd></div><div><dt>[ / ]</dt><dd>Floors shown</dd></div><div><dt>X</dt><dd>Pull floors apart</dd></div>
              <div><dt>M</dt><dd>Tactical map</dd></div><div><dt>Space</dt><dd>Pause</dd></div><div><dt>Click exit beam</dt><dd>Jam / reopen exit</dd></div>
            </dl>
            <button className="d-go small" onClick={() => setHelp(false)}>Close</button>
          </div>
        </div>
      )}
      {!hud?.ready && <div className="d-loading"><span />Building the twin…</div>}
    </div>
  )
}

function Hot({ k, label, icon, on, disabled, onClick, tone }: { k: string; label: string; icon: string; on?: boolean; disabled?: boolean; onClick: () => void; tone: string }) {
  return (
    <button className={`d-hot ${tone} ${on ? 'on' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={on}>
      <kbd>{k}</kbd><Icon d={icon} size={26} /><span>{label}</span>
    </button>
  )
}
