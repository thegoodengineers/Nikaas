// The phone app (#/go). One QR code per building: scan it, register your mobile number (verified with a code by SMS).
// When the control room raises the alarm, every registered phone gets a text with its own link; opening it asks which
// room you are in and then guides you out step by step on a small map, to the exit planned for your room.
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
const TOKEN_RE = /^[A-Za-z0-9-]{8,64}$/
type MeV = Me & { verify?: 'sandbox' | 'code' | 'none' }

export default function Go() {
  // A link from an emergency text carries this person's id (p): adopt it, then drop it from the address bar.
  const [siteId, setSiteId] = useState(() => {
    const q = hashQuery(), s = q.get('site'), p = q.get('p')
    if (s && p && TOKEN_RE.test(p)) {
      saved.set('nikaas-token', p); saved.set(`nikaas-in-${s}`, '1'); saved.set('nikaas-site', s)
      history.replaceState(null, '', `${location.pathname}${location.search}#/go?site=${encodeURIComponent(s)}`)
    }
    return s ?? saved.get('nikaas-site') ?? ''
  })
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

// ---------- pick a building (opened without the QR code) ----------
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
  const roomParam = hashQuery().get('room')
  const checkKey = `nikaas-in-${siteId}`, cacheKey = `nikaas-me-${siteId}`
  const [registered, setRegistered] = useState(() => saved.get(checkKey) === '1')
  const [site, setSite] = useState<Site>()
  const [me, setMe] = useState<Me | null>(() => { try { return JSON.parse(saved.get(cacheKey) ?? 'null') } catch { return null } })
  const [err, setErr] = useState('')
  const [offline, setOffline] = useState(false)
  const [pushState, setPushState] = useState<PushState | null>(() => pushSupport())
  const [busy, setBusy] = useState(false)
  const [allClear, setAllClear] = useState(false)
  const [silenced, setSilenced] = useState('')
  const [editing, setEditing] = useState(false)
  const lastAlarm = useRef<string | null>(null)

  useEffect(() => { void registerWorker() }, [])
  useEffect(() => { api.get<Site>(`/sites/${siteId}`).then(setSite).catch(e => setErr(e instanceof ApiError && e.status === 404 ? 'This building is not on Nikaas any more.' : String(e.message ?? e))) }, [siteId])

  const keep = useCallback((m: Me) => { setMe(m); saved.set(cacheKey, JSON.stringify(m)) }, [cacheKey])
  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>(`/sites/${siteId}/me?token=${encodeURIComponent(tok)}`)
      keep(m); setOffline(false); setErr('')
      return m
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { saved.set(checkKey, null); saved.set(cacheKey, null); setRegistered(false); setMe(null); return null }
      setOffline(true)
      return null
    }
  }, [siteId, tok, checkKey, cacheKey, keep])

  const alarmOn = !!me?.alarm
  useEffect(() => {
    if (!registered) return
    void refresh()
    const id = setInterval(refresh, alarmOn ? 3000 : 10000)
    const onMsg = (e: MessageEvent) => { if (e.data?.type === 'nikaas-push') void refresh() }
    navigator.serviceWorker?.addEventListener('message', onMsg)
    const onVis = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); navigator.serviceWorker?.removeEventListener('message', onMsg); document.removeEventListener('visibilitychange', onVis) }
  }, [registered, alarmOn, refresh])

  // siren while the page is open and an alarm starts; all-clear notice when it ends
  useEffect(() => {
    const id = me?.alarm?.id ?? null
    if (id && id !== lastAlarm.current && silenced !== id && me?.person.status !== 'safe') siren(true)
    if (!id && lastAlarm.current) { siren(false); setAllClear(true) }
    if (id) setAllClear(false)
    lastAlarm.current = id
  }, [me?.alarm?.id, me?.person.status, silenced])
  useEffect(() => () => siren(false), [])

  const done = (m: Me) => { unlockAudio(); keep(m); saved.set(checkKey, '1'); saved.set('nikaas-site', siteId); setRegistered(true); setEditing(false) }
  const unregister = async () => {
    setBusy(true)
    try { await api.post(`/sites/${siteId}/checkout`, { token: tok }) } catch { /* already gone */ }
    saved.set(checkKey, null); saved.set(cacheKey, null); setRegistered(false); setMe(null); setBusy(false); siren(false)
  }
  const setRoom = async (room: string) => {
    const m = await api.post<Me>(`/sites/${siteId}/checkin`, { token: tok, room }).catch(() => null)
    if (m) keep(m)
  }

  const name = site?.name ?? me?.site.name
  if (!registered || editing) {
    return (
      <div className="go-app">
        <Brand name={name} onSite={registered ? undefined : onChangeSite} />
        {err && <div className="pf-alert bad">{err}</div>}
        {site ? <Register site={site} tok={tok} roomParam={roomParam} onDone={done} onCancel={editing ? () => setEditing(false) : undefined} />
          : !err && <p className="pf-muted">Loading the building…</p>}
      </div>
    )
  }
  if (!me) return <div className="go-app"><Brand name={name} />{offline ? <div className="pf-alert warn">No connection yet. Retrying…</div> : <p className="pf-muted">Loading…</p>}</div>

  return (
    <div className={`go-app ${me.alarm ? 'go-alarm' : ''}`}>
      <Brand name={me.site.name} />
      {offline && <div className="pf-alert warn" role="status">Offline. Showing your last known route. It updates when the connection is back.</div>}
      {allClear && !me.alarm && <div className="pf-alert ok" role="status"><b>All clear.</b> The emergency is over. Follow staff instructions before going back in. <button className="pf-btn ghost" onClick={() => setAllClear(false)}>Dismiss</button></div>}
      {me.alarm ? (
        <Emergency me={me} siteId={siteId} tok={tok} onUpdate={keep} onSilence={() => { siren(false); setSilenced(me.alarm!.id) }} silenced={silenced === me.alarm.id} onRoom={setRoom} />
      ) : (
        <Registered me={me} pushState={pushState} onPush={async () => { unlockAudio(); try { setPushState(await enablePush(siteId, tok)) } catch { setPushState('off') } }}
          onRoom={setRoom} onChangeNumber={() => setEditing(true)} onUnregister={unregister} busy={busy} />
      )}
    </div>
  )
}

// ---------- register: phone number, then the code from the text message ----------
function Register({ site, tok, roomParam, onDone, onCancel }: { site: Site; tok: string; roomParam: string | null; onDone: (m: Me) => void; onCancel?: () => void }) {
  const [stage, setStage] = useState<'phone' | 'code'>('phone')
  const [phone, setPhone] = useState('')
  const [agree, setAgree] = useState(false)
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [sentAt, setSentAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const room = roomParam ? site.building.nodes.find(n => n.id === roomParam && n.type === 'room') : undefined

  const send = async () => {
    setBusy(true); setErr('')
    try {
      const m = await api.post<MeV>(`/sites/${site.id}/register`, { token: tok, phone })
      if (room) await api.post(`/sites/${site.id}/checkin`, { token: tok, room: room.id }).catch(() => {})
      if (m.verify === 'none') { onDone(m); return }
      setSentTo(m.person.phone ?? phone); setSentAt(Date.now()); setStage('code'); setCode('')
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const verify = async () => {
    setBusy(true); setErr('')
    try { onDone(await api.post<Me>(`/sites/${site.id}/verify`, { token: tok, code })) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const withoutPhone = async () => {
    setBusy(true); setErr('')
    try { onDone(await api.post<Me>(`/sites/${site.id}/checkin`, { token: tok, room: room?.id ?? null })) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const wait = Math.max(0, 30 - Math.floor((now - sentAt) / 1000))

  if (stage === 'code') return (
    <form className="go-stack" onSubmit={e => { e.preventDefault(); void verify() }}>
      <div>
        <p className="pf-eyebrow">Step 2 of 2</p>
        <h1 className="go-title">Enter the code</h1>
        <p className="pf-muted">We sent a text message with a 6-digit code to <b>{sentTo}</b>. It can take up to a minute.</p>
      </div>
      <label className="pf-field">Code from the text message
        <input className="go-code" aria-label="Code from the text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoFocus aria-describedby="code-help" />
      </label>
      {err && <div className="pf-alert bad" role="alert">{err}</div>}
      <button className="pf-btn go big" disabled={busy || code.length < 4}>{busy ? 'Checking…' : 'Verify and register'}</button>
      <div className="pf-row" id="code-help">
        <button type="button" className="pf-btn ghost" onClick={() => void send()} disabled={busy || wait > 0}>{wait > 0 ? `Send again in ${wait} s` : 'Send the code again'}</button>
        <button type="button" className="pf-btn ghost" onClick={() => { setStage('phone'); setErr('') }}>Change number</button>
      </div>
    </form>
  )
  return (
    <form className="go-stack" onSubmit={e => { e.preventDefault(); void send() }}>
      <div>
        <p className="pf-eyebrow">{onCancel ? 'Change number' : 'Emergency alerts · step 1 of 2'}</p>
        <h1 className="go-title">Welcome to {site.name}</h1>
        <p className="pf-muted">Register your mobile number. If there is a fire or another emergency while you are here, you get a text message with your own way out.</p>
      </div>
      <label className="pf-field">Mobile number
        <span className="go-phone"><span aria-hidden="true">+91</span>
          <input type="tel" aria-label="Mobile number" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={phone} onChange={e => setPhone(e.target.value)} required aria-describedby="phone-help" /></span>
      </label>
      <span id="phone-help" className="pf-small pf-muted">Not an Indian number? Start with + and your country code.</span>
      <label className="go-consent"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} />
        <span>Text me emergency alerts for {site.name}. My number is used only for this and deleted 24 hours after my last update.</span></label>
      {err && <div className="pf-alert bad" role="alert">{err}</div>}
      <button className="pf-btn go big" disabled={busy || !agree || phone.replace(/\D/g, '').length < 8}>{busy ? 'Sending the code…' : 'Send me a code'}</button>
      {onCancel ? <button type="button" className="pf-btn ghost" onClick={onCancel}>Keep my current number</button>
        : <button type="button" className="pf-btn ghost" onClick={() => void withoutPhone()} disabled={busy}>Continue without a phone number</button>}
      {!onCancel && <p className="pf-small pf-muted">Without a number, alerts only reach you while this page is open.</p>}
    </form>
  )
}

// ---------- registered, no emergency ----------
function Registered({ me, pushState, onPush, onRoom, onChangeNumber, onUnregister, busy }: { me: Me; pushState: PushState | null; onPush: () => void; onRoom: (r: string) => void; onChangeNumber: () => void; onUnregister: () => void; busy: boolean }) {
  const [rooms, setRooms] = useState(false)
  const p = me.person
  return (
    <section className="go-stack">
      <div className="pf-card go-status">
        {p.phone_verified ? <span className="pf-chip ok"><span className="pf-dot" />Registered for SMS alerts</span>
          : p.verify_pending ? <span className="pf-chip warn"><span className="pf-dot" />Number not verified yet</span>
            : <span className="pf-chip"><span className="pf-dot" />Registered without a phone number</span>}
        <b className="go-room">{p.phone ?? me.site.name}</b>
        <span className="pf-muted">{p.phone_verified ? 'If there is an emergency, you will get a text message with a link to your own exit route. You do not need to keep this page open.'
          : p.verify_pending ? 'Finish verifying your number to get text messages.' : 'Keep this page open while you are in the building, or add a number for text alerts.'}</span>
        <div className="pf-row">
          <button className="pf-btn" onClick={onChangeNumber}>{p.phone ? 'Change number' : 'Add a phone number'}</button>
          <button className="pf-btn ghost" onClick={onUnregister} disabled={busy}>Unregister</button>
        </div>
      </div>
      {!p.phone_verified && <PushNote state={pushState} onEnable={onPush} />}
      <div className="pf-card">
        <p className="pf-eyebrow">Optional</p>
        <b>{p.room_label ? `You said you are in ${p.room_label}` : 'Know which room you will be in?'}</b>
        <p className="pf-muted pf-small">In an emergency the app asks for your room anyway. Setting it now saves a few seconds.</p>
        <button className="pf-btn" onClick={() => setRooms(v => !v)}>{rooms ? 'Done' : p.room ? 'Change room' : 'Choose room'}</button>
        {rooms && <RoomList me={me} onPick={r => { onRoom(r); setRooms(false) }} />}
        {me.route && !rooms && <ExitLine route={me.route} />}
      </div>
      {me.hazards.length > 0 && <div className="pf-alert warn">Reported hazards: {me.hazards.map(h => h.label).join(', ')}.</div>}
    </section>
  )
}

function RoomList({ me, onPick, big }: { me: Me; onPick: (id: string) => void; big?: boolean }) {
  const [q, setQ] = useState('')
  const floors = me.site.floors.length ? [...me.site.floors].reverse() : [{ id: null as string | null, name: '' }]
  const match = (label: string) => label.toLowerCase().includes(q.trim().toLowerCase())
  return (
    <div className={`go-stack ${big ? 'go-rooms-big' : ''}`}>
      {me.site.rooms.length > 8 && <label className="pf-field"><span className="pf-sr">Search rooms</span><input type="search" placeholder="Search rooms" value={q} onChange={e => setQ(e.target.value)} /></label>}
      {floors.map(f => {
        const list = me.site.rooms.filter(r => (!me.site.floors.length || r[2] === f.id) && match(r[1]))
        return list.length ? (
          <div key={f.id ?? 'all'} className="go-rooms">
            {f.name && <p className="pf-eyebrow">{f.name}</p>}
            {list.map(r => <button key={r[0]} className={`go-room-btn ${me.person.room === r[0] ? 'on' : ''}`} aria-pressed={me.person.room === r[0]} onClick={() => onPick(r[0])}>{r[1]}</button>)}
          </div>
        ) : null
      })}
    </div>
  )
}

function PushNote({ state, onEnable }: { state: PushState | null; onEnable: () => void }) {
  if (state === 'on') return <div className="pf-alert ok">Browser alerts are on for this phone.</div>
  if (state === 'needs-install' || state === 'unsupported' || state === 'denied') return null
  return <div className="pf-alert info pf-row"><span className="pf-grow">Also alert this browser, even with the page closed?</span><button className="pf-btn primary" onClick={onEnable}>Turn on</button></div>
}

// ---------- emergency ----------
function Emergency({ me, siteId, tok, onUpdate, onSilence, silenced, onRoom }: { me: Me; siteId: string; tok: string; onUpdate: (m: Me) => void; onSilence: () => void; silenced: boolean; onRoom: (r: string) => void }) {
  const a = me.alarm!, route = me.route, p = me.person
  const [now, setNow] = useState(Date.now() / 1000)
  const [changedAt, setChangedAt] = useState(0)
  const [help, setHelp] = useState(false)
  const [outside, setOutside] = useState(false)
  const [working, setWorking] = useState('')
  const [at, setAt] = useState(0)
  const [picking, setPicking] = useState(false)
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(id) }, [])
  useEffect(() => { if (route?.changed) { setChangedAt(Date.now()); navigator.vibrate?.([300, 100, 300]) } }, [route?.changed, route?.exit])
  useEffect(() => setAt(0), [route?.exit, route?.mode, p.room])
  const status = async (status: 'safe' | 'help' | 'inside', need?: string) => {
    setWorking(status)
    const send = (extra: object = {}) => api.post<Me>(`/sites/${siteId}/status`, { token: tok, status, need, ...extra }).then(onUpdate).finally(() => setWorking(''))
    if (status === 'safe' && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(g => void send({ lat: g.coords.latitude, lng: g.coords.longitude, accuracy: g.coords.accuracy }), () => void send(), { enableHighAccuracy: true, timeout: 8000, maximumAge: 20000 })
    } else void send()
  }
  const wait = route ? a.started_at + route.release_at - now : 0
  const type = ALARM_LABEL[a.type] ?? 'Emergency'
  const needRoom = (!p.room || picking) && p.status !== 'safe'
  return (
    <section className="go-stack">
      <div className="go-alarm-head" role="alert">
        <div className="pf-row"><span className="go-pulse" aria-hidden="true" /><b>{type.toUpperCase()}</b><span className="go-elapsed">{fmtTime(now - a.started_at)}</span></div>
        <p>{TODO[a.type] ?? TODO.other}</p>
        {a.message && <p className="go-msg">{a.message}</p>}
        {!silenced && <button className="pf-btn go-silence" onClick={onSilence}>Silence alarm sound</button>}
      </div>
      {p.status === 'safe' ? <SafeCard me={me} onBack={() => status('inside')} /> : needRoom ? (
        <div className="pf-card go-pick">
          <h1 className="go-title">Which room are you in?</h1>
          <p className="pf-muted">Your exit depends on your room: each room is sent to the exit that keeps the stairs and doors from crowding.</p>
          <RoomList me={me} big onPick={r => { setPicking(false); onRoom(r) }} />
        </div>
      ) : !route ? (
        <div className="pf-alert warn">Working out your route…</div>
      ) : (
        <>
          {Date.now() - changedAt < 30000 && changedAt > 0 && <div className="pf-alert warn" role="alert"><b>Your route has changed.</b> Go to {route.exit_label ?? 'the refuge point'} instead.</div>}
          {route.mode === 'exit' ? (
            <div className="go-exit" style={{ ['--g' as string]: route.group_color ?? 'var(--exit)' }}>
              <ExitIcon color="#fff" />
              <div>
                <span>{p.room_label} · {route.group ? `group ${route.group} · go to` : 'go to'}</span>
                <b>{route.exit_label}</b>
                <span>{Math.round(route.distance_m)} m · about {fmtTime(route.walk_s)} walking</span>
              </div>
            </div>
          ) : (
            <div className="go-refuge"><b>Go to the stair landing and wait</b><span>The control room can see you. Rescue teams are told where you are.</span></div>
          )}
          <button className="pf-btn ghost go-wrong-room" onClick={() => setPicking(true)}>Not in {p.room_label}? Change room</button>
          {wait > 0 && route.mode === 'exit' && (
            <div className="go-wait" role="timer">
              <b>Wait here: your floor leaves in {fmtTime(wait)}</b>
              <span>Floors leave in turn so the stairs do not jam. Leave earlier if you see smoke or fire.</span>
            </div>
          )}
          <Guide me={me} route={route} at={at} setAt={setAt} />
          {route.assembly && <Outside route={route} open={outside} onOpen={() => setOutside(true)} />}
        </>
      )}
      {p.status !== 'safe' && !needRoom && (
        <div className="go-actions">
          <button className="pf-btn go big" onClick={() => status('safe')} disabled={!!working}>{working === 'safe' ? 'Checking your location…' : "I'm out and safe"}</button>
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
  return <p className="go-exit-line"><ExitIcon color="var(--exit)" /><span><b>{route.exit_label ?? 'Refuge'}</b><span className="pf-muted">{Math.round(route.distance_m)} m · about {fmtTime(route.walk_s)}</span></span></p>
}

const ICON: Record<string, string> = { start: '●', walk: '↑', turn: '↱', stairs: '⇣', exit: '⇥', outside: '⚑', refuge: '■' }

/** Step-by-step guide: the current step in big type, the map zoomed to it, and the full list below. */
function Guide({ me, route, at, setAt }: { me: Me; route: Route; at: number; setAt: (f: (i: number) => number) => void }) {
  const steps = route.steps
  const floorOf = (id: string | null) => (id ? me.map.nodes.find(n => n[0] === id)?.[6] ?? null : null)
  // the floor to show: the current step's floor, or the last floor seen before it (outside steps have none)
  const stepFloor = (() => { for (let k = at; k >= 0; k--) { const f = steps[k].floor ?? floorOf(steps[k].node); if (f) return f } return floorOf(me.person.room) })()
  const [floor, setFloor] = useState<string | null>(stepFloor)
  useEffect(() => setFloor(stepFloor), [stepFloor])
  const shown = me.site.floors.length ? floor : null
  const onFloor = route.path.filter(id => !me.site.floors.length || floorOf(id) === shown)
  const target = route.mode === 'exit' ? route.exit : route.path[route.path.length - 1]
  const marks: Record<string, string> = {}
  for (const h of me.hazards) if (h.floor) marks[h.floor] = String((Number(marks[h.floor]) || 0) + 1)
  const onRoute = new Set(route.path.map(floorOf))
  const cur = steps[Math.min(at, steps.length - 1)]
  return (
    <div className="pf-card go-guide">
      <div className="go-now" aria-live="polite">
        <span className="go-now-n">Step {Math.min(at + 1, steps.length)} of {steps.length}</span>
        <b><span className="go-step-ico big" aria-hidden="true">{ICON[cur.kind]}</span>{cur.text}</b>
      </div>
      <div className="go-map">
        {me.site.floors.length > 1 && <FloorTabs floors={me.site.floors.filter(f => onRoute.has(f.id) || f.id === floor)} value={floor} onChange={setFloor} marks={marks} />}
        <PlanView nodes={me.map.nodes} edges={me.map.edges} floor={shown} route={route.path} routeColor={route.group_color ?? 'var(--exit)'} animate
          hazards={me.hazards.map(h => h.node)} here={me.person.room} target={target} targetLabel={route.mode === 'exit' ? 'EXIT' : 'WAIT'}
          focus={onFloor} stepNode={cur.node} label={`Your route on ${me.site.floors.find(f => f.id === floor)?.name ?? 'the plan'}`} />
        <p className="pf-muted pf-small go-legend"><span className="lg-you" /> You <span className="lg-exit" /> Exit <span className="lg-fire" /> Hazard</p>
      </div>
      <div className="pf-row go-steps-head">
        <button className="pf-btn big-ish" onClick={() => setAt(i => Math.max(0, i - 1))} disabled={at === 0}>Back</button>
        <button className="pf-btn primary go-next" onClick={() => setAt(i => Math.min(steps.length - 1, i + 1))} disabled={at >= steps.length - 1}>Next step</button>
      </div>
      <ol className="go-steps">
        {steps.map((s, k) => (
          <li key={k} className={`go-step ${s.kind} ${k === at ? 'now' : ''} ${k < at ? 'done' : ''}`} onClick={() => setAt(() => k)}>
            <span className="go-step-ico" aria-hidden="true">{ICON[s.kind]}</span>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
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
