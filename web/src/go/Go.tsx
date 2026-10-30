// The phone app (#/go): scan a QR code when you enter a building, get an alert in an emergency, follow your own
// way out step by step, get walking directions to the assembly point, and tell the control room you are safe.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ExitIcon from '../ExitIcon.tsx'
import PlanView, { FloorTabs } from '../platform/PlanView.tsx'
import {
  ALARM_LABEL, API, ApiError, api, directionsUrl, fmtTime, hashQuery, haversine, mapEmbedUrl, saved, token,
  type Me, type Route, type Site, type SiteSummary,
} from '../platform/api.ts'
import { enablePush, pushSupport, registerWorker, siren, unlockAudio, type PushState } from './alerts.ts'
import './go.css'

const TODO: Record<string, string> = {
  fire: 'Leave now by the route below. Do not use lifts. Close doors behind you. Stay low if there is smoke.',
  earthquake: 'Drop, cover and hold on until the shaking stops. Then leave by the route below. Keep away from windows.',
  collapse: 'Leave now by the route below. Keep away from damaged areas and do not go back for belongings.',
  gas: 'Leave now. Do not use light switches, lifts or flames. Leave doors open behind you.',
  drill: 'This is a drill. Leave by your route below as you would in a real emergency.',
  other: 'Leave the building now by the route below and follow staff instructions.',
}

export default function Go() {
  const [siteId, setSiteId] = useState(() => hashQuery().get('site') ?? saved.get('nikaas-site') ?? '')
  useEffect(() => {
    document.body.classList.add('go-mode')
    const on = () => { const s = hashQuery().get('site'); if (s) setSiteId(s) }
    addEventListener('hashchange', on)
    return () => { document.body.classList.remove('go-mode'); removeEventListener('hashchange', on) }
  }, [])
  if (!API) return <div className="go-app"><Brand /><div className="pf-alert bad">This app needs the live server.</div></div>
  if (!siteId) return <PickBuilding onPick={id => { saved.set('nikaas-site', id); location.hash = `#/go?site=${id}`; setSiteId(id) }} />
  return <SiteApp key={siteId} siteId={siteId} onChangeSite={() => { saved.set('nikaas-site', null); location.hash = '#/go'; setSiteId('') }} />
}

function Brand({ name, onSite }: { name?: string; onSite?: () => void }) {
  return (
    <header className="go-brand">
      <span className="go-logo"><ExitIcon color="#fff" /></span>
      <span className="go-brand-text"><b>Nikaas</b>{name && <span>{name}</span>}</span>
      {onSite && <button className="pf-btn ghost go-switch" onClick={onSite}>Change building</button>}
    </header>
  )
}

// ---------- pick a building (no QR code) ----------
function PickBuilding({ onPick }: { onPick: (id: string) => void }) {
  const [sites, setSites] = useState<SiteSummary[]>()
  const [err, setErr] = useState('')
  const [pos, setPos] = useState<{ lat: number; lng: number }>()
  const [locating, setLocating] = useState(false)
  useEffect(() => { api.get<SiteSummary[]>('/sites').then(setSites).catch(e => setErr(String(e.message ?? e))) }, [])
  const locate = () => {
    if (!navigator.geolocation) { setErr('This phone cannot share its location.'); return }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(p => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setLocating(false) },
      () => { setLocating(false); setErr('Location is off. Pick your building from the list.') }, { enableHighAccuracy: true, timeout: 10000 })
  }
  const list = useMemo(() => {
    const dist = (s: SiteSummary) => (pos && s.geo ? haversine(pos.lat, pos.lng, s.geo.lat, s.geo.lng) : Infinity)
    return [...(sites ?? [])].sort((a, b) => dist(a) - dist(b)).map(s => ({ s, d: dist(s) }))
  }, [sites, pos])
  const nearest = list.find(x => x.s.geo)
  return (
    <div className="go-app">
      <Brand />
      <h1 className="go-title">Which building are you in?</h1>
      <p className="pf-muted">Scanning the QR code at the entrance does this for you.</p>
      <button className="pf-btn" onClick={locate} disabled={locating}>{locating ? 'Finding you…' : 'Sort by my location'}</button>
      {err && <div className="pf-alert warn">{err}</div>}
      {pos && nearest && isFinite(nearest.d) && nearest.s.geo && (
        <iframe className="go-map-embed" title={`Map of ${nearest.s.name}`} src={mapEmbedUrl(nearest.s.geo.lat, nearest.s.geo.lng, 16)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
      )}
      <div className="go-list">
        {!sites && !err && <p className="pf-muted">Loading buildings…</p>}
        {list.map(({ s, d }) => (
          <button key={s.id} className="go-site" onClick={() => onPick(s.id)}>
            <b>{s.name}</b>
            <span>{s.floors} floor{s.floors === 1 ? '' : 's'} · {s.rooms} rooms{isFinite(d) ? ` · ${d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`} away` : ''}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------- one building ----------
function SiteApp({ siteId, onChangeSite }: { siteId: string; onChangeSite: () => void }) {
  const tok = useMemo(token, [])
  const q = hashQuery()
  const roomParam = q.get('room'), gateParam = q.get('gate')
  const checkKey = `nikaas-in-${siteId}`, cacheKey = `nikaas-me-${siteId}`
  const [checkedIn, setCheckedIn] = useState(() => saved.get(checkKey) === '1')
  const [site, setSite] = useState<Site>()
  const [me, setMe] = useState<Me | null>(() => { try { return JSON.parse(saved.get(cacheKey) ?? 'null') } catch { return null } })
  const [err, setErr] = useState('')
  const [offline, setOffline] = useState(false)
  const [pushState, setPushState] = useState<PushState | null>(() => pushSupport())
  const [leaving, setLeaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [allClear, setAllClear] = useState(false)
  const [silenced, setSilenced] = useState('')
  const lastAlarm = useRef<string | null>(null)

  useEffect(() => { void registerWorker() }, [])
  useEffect(() => { api.get<Site>(`/sites/${siteId}`).then(setSite).catch(e => setErr(e instanceof ApiError && e.status === 404 ? 'This building is not on Nikaas any more.' : String(e.message ?? e))) }, [siteId])

  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>(`/sites/${siteId}/me?token=${encodeURIComponent(tok)}`)
      setMe(m); setOffline(false); setErr('')
      saved.set(cacheKey, JSON.stringify(m))
      return m
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { saved.set(checkKey, null); saved.set(cacheKey, null); setCheckedIn(false); setMe(null); return null }
      setOffline(true)
      return null
    }
  }, [siteId, tok, checkKey, cacheKey])

  // a room sticker scanned while already checked in moves you to that room; an entrance scan asks if you are leaving
  const handledScan = useRef(false)
  useEffect(() => {
    if (!checkedIn || handledScan.current) return
    handledScan.current = true
    if (roomParam && roomParam !== me?.person.room) void api.post<Me>(`/sites/${siteId}/checkin`, { token: tok, room: roomParam }).then(setMe).catch(() => {})
    else if (gateParam && !me?.alarm) setLeaving(true)
  }, [checkedIn, roomParam, gateParam, me, siteId, tok])

  const alarmOn = !!me?.alarm
  useEffect(() => {
    if (!checkedIn) return
    void refresh()
    const id = setInterval(refresh, alarmOn ? 3000 : 8000)
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'nikaas-push') void refresh() }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    const onVis = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); navigator.serviceWorker?.removeEventListener('message', onMsg); document.removeEventListener('visibilitychange', onVis) }
  }, [checkedIn, alarmOn, refresh])

  // siren when an alarm starts while the page is open; all-clear notice when it ends
  useEffect(() => {
    const id = me?.alarm?.id ?? null
    if (id && id !== lastAlarm.current && silenced !== id && me?.person.status !== 'safe') siren(true)
    if (!id && lastAlarm.current) { siren(false); setAllClear(true) }
    if (id) setAllClear(false)
    lastAlarm.current = id
  }, [me?.alarm?.id, me?.person.status, silenced])
  useEffect(() => () => siren(false), [])

  const checkIn = async (room: string | null) => {
    unlockAudio()
    setBusy(true); setErr('')
    try {
      const m = await api.post<Me>(`/sites/${siteId}/checkin`, { token: tok, room, gate: gateParam })
      setMe(m); saved.set(checkKey, '1'); saved.set('nikaas-site', siteId); setCheckedIn(true)
      handledScan.current = true
      try { setPushState(await enablePush(siteId, tok)) } catch { setPushState('off') }
    } catch (e) { setErr(String((e as Error).message ?? e)) } finally { setBusy(false) }
  }
  const checkOut = async () => {
    setBusy(true)
    try { await api.post(`/sites/${siteId}/checkout`, { token: tok }) } catch { /* expired already */ }
    saved.set(checkKey, null); saved.set(cacheKey, null); setCheckedIn(false); setMe(null); setLeaving(false); setBusy(false); siren(false)
  }
  const setRoom = async (room: string) => {
    const m = await api.post<Me>(`/sites/${siteId}/checkin`, { token: tok, room }).catch(() => null)
    if (m) setMe(m)
  }

  const name = site?.name ?? me?.site.name
  if (!checkedIn) {
    return (
      <div className="go-app">
        <Brand name={name} onSite={onChangeSite} />
        {err && <div className="pf-alert bad">{err}</div>}
        {site ? <CheckIn site={site} roomParam={roomParam} gateParam={gateParam} busy={busy} onCheckIn={checkIn} /> : !err && <p className="pf-muted">Loading the building…</p>}
      </div>
    )
  }
  if (!me) return <div className="go-app"><Brand name={name} />{offline ? <div className="pf-alert warn">No connection yet. Retrying…</div> : <p className="pf-muted">Loading…</p>}</div>

  return (
    <div className={`go-app ${me.alarm ? 'go-alarm' : ''}`}>
      <Brand name={me.site.name} />
      {offline && <div className="pf-alert warn" role="status">Offline. Showing your last known route. It updates when the connection is back.</div>}
      {allClear && !me.alarm && <div className="pf-alert ok" role="status"><b>All clear.</b> The emergency is over. Follow staff instructions before going back in. <button className="pf-btn ghost" onClick={() => setAllClear(false)}>Dismiss</button></div>}
      {leaving && !me.alarm ? (
        <section className="pf-card go-center">
          <h1 className="go-title">Leaving {me.site.name}?</h1>
          <p className="pf-muted">You scanned an entrance code while checked in.</p>
          <button className="pf-btn primary big" onClick={checkOut} disabled={busy}>Check out</button>
          <button className="pf-btn big" onClick={() => setLeaving(false)}>I'm still inside</button>
        </section>
      ) : me.alarm ? (
        <Emergency me={me} siteId={siteId} tok={tok} onUpdate={setMe} onSilence={() => { siren(false); setSilenced(me.alarm!.id) }} silenced={silenced === me.alarm.id} onRoom={setRoom} />
      ) : (
        <Everyday me={me} pushState={pushState} onPush={async () => { unlockAudio(); try { setPushState(await enablePush(siteId, tok)) } catch { setPushState('off') } }} onRoom={setRoom} onCheckOut={checkOut} busy={busy} />
      )}
    </div>
  )
}

// ---------- check in ----------
function CheckIn({ site, roomParam, gateParam, busy, onCheckIn }: { site: Site; roomParam: string | null; gateParam: string | null; busy: boolean; onCheckIn: (room: string | null) => void }) {
  const nodes = site.building.nodes
  const room = roomParam ? nodes.find(n => n.id === roomParam && n.type === 'room') : undefined
  const gate = gateParam ? nodes.find(n => n.id === gateParam) : undefined
  const [pick, setPick] = useState<string | null>(room?.id ?? null)
  const floors = site.building.floors ?? []
  const fname = (f?: string) => floors.find(x => x.id === f)?.name
  return (
    <section className="go-stack">
      <div>
        <p className="pf-eyebrow">{gate ? `Entrance: ${gate.label ?? gate.id}` : room ? 'Room code' : 'Check in'}</p>
        <h1 className="go-title">Welcome to {site.name}</h1>
        <p className="pf-muted">Check in to get an alert and your own way out if there is an emergency while you are here.</p>
      </div>
      {room ? (
        <div className="pf-card"><span className="pf-muted pf-small">Your location</span><b className="go-room">{room.label ?? room.id}</b>{fname(room.floor_id) && <span className="pf-muted">{fname(room.floor_id)}</span>}</div>
      ) : (
        <RoomPicker site={site} value={pick} onChange={setPick} />
      )}
      <button className="pf-btn go big" onClick={() => onCheckIn(pick)} disabled={busy}>{busy ? 'Checking in…' : 'Check in and turn on alerts'}</button>
      <p className="pf-muted pf-small">Anonymous: no name or phone number. Your check-in is deleted 24 hours after your last update. Your location is only used when you tap "I'm safe".</p>
    </section>
  )
}

function RoomPicker({ site, value, onChange }: { site: Site; value: string | null; onChange: (id: string) => void }) {
  const [q, setQ] = useState('')
  const floors = [...(site.building.floors ?? [{ id: '', name: '', elevation_m: 0 }])].sort((a, b) => b.elevation_m - a.elevation_m)
  const rooms = site.building.nodes.filter(n => n.type === 'room' && (n.label ?? n.id).toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="go-stack">
      <label className="pf-field">Where are you now?
        {site.building.nodes.filter(n => n.type === 'room').length > 8 && <input type="search" placeholder="Search rooms" value={q} onChange={e => setQ(e.target.value)} />}
      </label>
      {floors.map(f => {
        const list = rooms.filter(r => (r.floor_id ?? '') === f.id || !site.building.floors)
        if (!list.length) return null
        return (
          <div key={f.id || 'all'} className="go-rooms">
            {f.name && <p className="pf-eyebrow">{f.name}</p>}
            {list.map(r => <button key={r.id} className={`go-room-btn ${value === r.id ? 'on' : ''}`} aria-pressed={value === r.id} onClick={() => onChange(r.id)}>{r.label ?? r.id}</button>)}
          </div>
        )
      })}
    </div>
  )
}

// ---------- normal day ----------
function Everyday({ me, pushState, onPush, onRoom, onCheckOut, busy }: { me: Me; pushState: PushState | null; onPush: () => void; onRoom: (r: string) => void; onCheckOut: () => void; busy: boolean }) {
  const [changing, setChanging] = useState(!me.person.room)
  const p = me.person
  const fname = me.site.floors.find(f => f.id === p.floor)?.name
  return (
    <section className="go-stack">
      <div className="pf-card go-status">
        <span className="pf-chip ok"><span className="pf-dot" />Checked in</span>
        <b className="go-room">{p.room_label ?? 'Room not set'}</b>
        <span className="pf-muted">{fname ? `${fname} · ` : ''}{me.site.name}</span>
        <div className="pf-row"><button className="pf-btn" onClick={() => setChanging(v => !v)}>{changing ? 'Done' : 'Change room'}</button></div>
      </div>
      {changing && <div className="pf-card"><RoomPickerFromMe me={me} onPick={r => { onRoom(r); setChanging(false) }} /></div>}
      <PushNote state={pushState} onEnable={onPush} />
      {me.route && (
        <div className="pf-card">
          <p className="pf-eyebrow">Your way out</p>
          <ExitLine route={me.route} />
          <details className="go-details"><summary>Show the route</summary><Steps route={me.route} /><RouteMap me={me} route={me.route} /></details>
        </div>
      )}
      {me.hazards.length > 0 && <div className="pf-alert warn">Reported hazards: {me.hazards.map(h => h.label).join(', ')}. Your route avoids them.</div>}
      <button className="pf-btn big" onClick={onCheckOut} disabled={busy}>Check out</button>
    </section>
  )
}

function RoomPickerFromMe({ me, onPick }: { me: Me; onPick: (id: string) => void }) {
  const floors = me.site.floors.length ? [...me.site.floors].reverse() : [{ id: null as string | null, name: '' }]
  return (
    <div className="go-stack">
      <p className="pf-eyebrow">Where are you now?</p>
      {floors.map(f => {
        const list = me.site.rooms.filter(r => !me.site.floors.length || r[2] === f.id)
        return list.length ? (
          <div key={f.id ?? 'all'} className="go-rooms">
            {f.name && <span className="pf-muted pf-small">{f.name}</span>}
            {list.map(r => <button key={r[0]} className={`go-room-btn ${me.person.room === r[0] ? 'on' : ''}`} onClick={() => onPick(r[0])}>{r[1]}</button>)}
          </div>
        ) : null
      })}
    </div>
  )
}

function PushNote({ state, onEnable }: { state: PushState | null; onEnable: () => void }) {
  if (state === 'on') return <div className="pf-alert ok">Alerts are on. Your phone will alert you even if this page is closed.</div>
  if (state === 'needs-install') return <div className="pf-alert info">On iPhone, tap Share, then <b>Add to Home Screen</b>, and open Nikaas from there to get alerts when the page is closed. Until then, keep this page open.</div>
  if (state === 'denied') return <div className="pf-alert warn">Notifications are blocked for this site. Keep this page open, or allow notifications in your browser settings.</div>
  if (state === 'unsupported') return <div className="pf-alert info">This browser cannot receive alerts in the background. Keep this page open while you are in the building.</div>
  return <div className="pf-alert info pf-row"><span className="pf-grow">Turn on alerts so your phone can warn you even when this page is closed.</span><button className="pf-btn primary" onClick={onEnable}>Turn on</button></div>
}

// ---------- emergency ----------
function Emergency({ me, siteId, tok, onUpdate, onSilence, silenced, onRoom }: { me: Me; siteId: string; tok: string; onUpdate: (m: Me) => void; onSilence: () => void; silenced: boolean; onRoom: (r: string) => void }) {
  const a = me.alarm!, route = me.route, p = me.person
  const [now, setNow] = useState(Date.now() / 1000)
  const [changedAt, setChangedAt] = useState(0)
  const [help, setHelp] = useState(false)
  const [outside, setOutside] = useState(false)
  const [working, setWorking] = useState('')
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(id) }, [])
  useEffect(() => { if (route?.changed) { setChangedAt(Date.now()); navigator.vibrate?.([300, 100, 300]) } }, [route?.changed, route?.exit])
  const status = async (status: 'safe' | 'help' | 'inside', need?: string) => {
    setWorking(status)
    const send = (extra: object = {}) => api.post<Me>(`/sites/${siteId}/status`, { token: tok, status, need, ...extra }).then(onUpdate).finally(() => setWorking(''))
    if (status === 'safe' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(g => void send({ lat: g.coords.latitude, lng: g.coords.longitude, accuracy: g.coords.accuracy }), () => void send(), { enableHighAccuracy: true, timeout: 8000, maximumAge: 20000 })
    } else void send()
  }
  const wait = route ? a.started_at + route.release_at - now : 0
  const type = ALARM_LABEL[a.type] ?? 'Emergency'
  return (
    <section className="go-stack">
      <div className="go-alarm-head" role="alert">
        <div className="pf-row"><span className="go-pulse" aria-hidden="true" /><b>{type.toUpperCase()}</b><span className="go-elapsed">{fmtTime(now - a.started_at)}</span></div>
        <p>{TODO[a.type] ?? TODO.other}</p>
        {a.message && <p className="go-msg">{a.message}</p>}
        {!silenced && <button className="pf-btn go-silence" onClick={onSilence}>Silence alarm sound</button>}
      </div>
      {p.status === 'safe' ? <SafeCard me={me} onBack={() => status('inside')} /> : !route ? (
        p.room ? <div className="pf-alert warn">Working out your route…</div> : <div className="pf-card"><RoomPickerFromMe me={me} onPick={onRoom} /></div>
      ) : (
        <>
          {Date.now() - changedAt < 30000 && changedAt > 0 && <div className="pf-alert warn" role="alert"><b>Your route has changed.</b> Go to {route.exit_label ?? 'the refuge point'} instead.</div>}
          {route.mode === 'exit' ? (
            <div className="go-exit" style={{ ['--g' as string]: route.group_color ?? 'var(--exit)' }}>
              <ExitIcon color="#fff" />
              <div>
                <span>{route.group ? `Group ${route.group} · go to` : 'Go to'}</span>
                <b>{route.exit_label}</b>
                <span>{Math.round(route.distance_m)} m · about {fmtTime(route.walk_s)} walking</span>
              </div>
            </div>
          ) : (
            <div className="go-refuge"><b>Go to the stair landing and wait</b><span>The control room can see you. Rescue teams are told where you are.</span></div>
          )}
          {wait > 0 && route.mode === 'exit' && (
            <div className="go-wait" role="timer">
              <b>Wait here: your floor leaves in {fmtTime(wait)}</b>
              <span>Floors leave in turn so the stairs do not jam. Leave earlier if you see smoke or fire.</span>
            </div>
          )}
          <Steps route={route} live />
          <RouteMap me={me} route={route} />
          {route.assembly && <Outside route={route} open={outside} onOpen={() => setOutside(true)} />}
        </>
      )}
      {p.status !== 'safe' && (
        <div className="go-actions">
          <button className="pf-btn go big" onClick={() => status('safe')} disabled={!!working}>{working === 'safe' ? 'Checking your location…' : "I'm safe"}</button>
          <button className="pf-btn big go-help-btn" onClick={() => setHelp(true)} disabled={!!working}>{p.status === 'help' ? 'Help requested · update' : 'I need help'}</button>
        </div>
      )}
      {p.status === 'help' && <div className="pf-alert bad" role="status">Help requested{p.need === 'stairs' ? ': you cannot use stairs' : p.need === 'medical' ? ': medical help' : p.need === 'trapped' ? ': you are trapped' : ''}. The control room can see you.</div>}
      {help && (
        <div className="go-sheet" role="dialog" aria-modal="true" aria-label="Ask for help">
          <div className="go-sheet-card">
            <h2>What do you need?</h2>
            <button className="pf-btn big" onClick={() => { setHelp(false); void status('help', 'stairs') }}>I can't use the stairs</button>
            <button className="pf-btn big" onClick={() => { setHelp(false); void status('help', 'medical') }}>Medical help</button>
            <button className="pf-btn big" onClick={() => { setHelp(false); void status('help', 'trapped') }}>I'm trapped</button>
            {p.status === 'help' && <button className="pf-btn big" onClick={() => { setHelp(false); void status('inside') }}>I'm OK now</button>}
            <button className="pf-btn ghost big" onClick={() => setHelp(false)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  )
}

function ExitLine({ route }: { route: Route }) {
  return <p className="go-exit-line"><ExitIcon color="var(--exit)" /><span><b>{route.exit_label}</b><span className="pf-muted">{Math.round(route.distance_m)} m · about {fmtTime(route.walk_s)}</span></span></p>
}

function Steps({ route, live }: { route: Route; live?: boolean }) {
  const [at, setAt] = useState(0)
  useEffect(() => setAt(0), [route.exit, route.mode])
  const steps = route.steps
  return (
    <div className="pf-card go-steps">
      {live && <div className="pf-row go-steps-head"><b className="pf-grow">Step {Math.min(at + 1, steps.length)} of {steps.length}</b>
        <button className="pf-btn" onClick={() => setAt(i => Math.max(0, i - 1))} disabled={at === 0} aria-label="Previous step">Back</button>
        <button className="pf-btn primary" onClick={() => setAt(i => Math.min(steps.length - 1, i + 1))} disabled={at >= steps.length - 1}>Next step</button></div>}
      <ol>
        {steps.map((s, k) => (
          <li key={k} className={`go-step ${s.kind} ${live && k === at ? 'now' : ''} ${live && k < at ? 'done' : ''}`} onClick={live ? () => setAt(k) : undefined}>
            <span className="go-step-ico" aria-hidden="true">{{ start: '●', walk: '↑', turn: '↱', stairs: '⇣', exit: '⇥', outside: '⚑', refuge: '■' }[s.kind]}</span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function RouteMap({ me, route }: { me: Me; route: Route }) {
  const floorOf = (id: string | null) => me.map.nodes.find(n => n[0] === id)?.[6] ?? null
  const start = floorOf(me.person.room)
  const [floor, setFloor] = useState<string | null>(start ?? me.site.floors[0]?.id ?? null)
  const target = route.mode === 'exit' ? route.exit : route.path[route.path.length - 1]
  const marks: Record<string, string> = {}
  for (const h of me.hazards) if (h.floor) marks[h.floor] = String((Number(marks[h.floor]) || 0) + 1)
  const onRoute = new Set(route.path.map(floorOf))
  return (
    <div className="pf-card go-map">
      <div className="pf-row"><b className="pf-grow">Map</b><FloorTabs floors={me.site.floors.filter(f => onRoute.has(f.id) || f.id === floor)} value={floor} onChange={setFloor} marks={marks} /></div>
      <PlanView nodes={me.map.nodes} edges={me.map.edges} floor={me.site.floors.length ? floor : null} route={route.path} routeColor={route.group_color ?? 'var(--exit)'}
        hazards={me.hazards.map(h => h.node)} here={me.person.room} target={target} label={`Your route on ${me.site.floors.find(f => f.id === floor)?.name ?? 'the plan'}`} />
      <p className="pf-muted pf-small go-legend"><span className="lg-you" /> You <span className="lg-exit" /> Exit <span className="lg-fire" /> Hazard</p>
    </div>
  )
}

function Outside({ route, open, onOpen }: { route: Route; open: boolean; onOpen: () => void }) {
  const a = route.assembly!
  const [pos, setPos] = useState<{ lat: number; lng: number; acc: number }>()
  useEffect(() => {
    if (!open || !navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(g => setPos({ lat: g.coords.latitude, lng: g.coords.longitude, acc: g.coords.accuracy }), () => {}, { enableHighAccuracy: true, maximumAge: 5000 })
    return () => navigator.geolocation.clearWatch(id)
  }, [open])
  const has = a.lat != null && a.lng != null
  const d = pos && has ? haversine(pos.lat, pos.lng, a.lat!, a.lng!) : null
  return (
    <div className="pf-card go-outside">
      <p className="pf-eyebrow">Once you are outside</p>
      <b>{a.label}</b>
      {!open ? <button className="pf-btn primary big" onClick={onOpen}>I'm outside: show directions</button> : has ? (
        <>
          {d !== null && <p className="go-out-dist">{d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`} away · about {fmtTime(d / 1.2)} walking{pos && pos.acc > 60 ? ` (GPS within ${Math.round(pos.acc)} m)` : ''}</p>}
          <a className="pf-btn go big" href={directionsUrl(a.lat!, a.lng!)} target="_blank" rel="noopener noreferrer">Walking directions in Google Maps</a>
          <iframe className="go-map-embed" title={`Map of ${a.label}`} src={mapEmbedUrl(a.lat!, a.lng!)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
        </>
      ) : <p className="pf-muted">The control room has not put this assembly point on the map yet. Follow the signs and the marshals.</p>}
    </div>
  )
}

function SafeCard({ me, onBack }: { me: Me; onBack: () => void }) {
  const p = me.person
  return (
    <div className="go-safe" role="status">
      <b>You're marked safe</b>
      <span>{p.safe_verified === true ? 'Your location matches the assembly point.' : p.safe_verified === false ? `Your location is about ${p.safe_distance_m} m from the assembly point. Please go there so marshals can count you.` : 'The control room can see you are out.'}</span>
      <span>Do not go back in until the all clear.</span>
      <button className="pf-btn" onClick={onBack}>I'm not out yet</button>
    </div>
  )
}
