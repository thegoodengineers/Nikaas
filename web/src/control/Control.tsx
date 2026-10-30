// Control room (#/control?site=<id>): live operations for one site. Polls GET /sites/{id}/control every 3 s
// (docs/PLATFORM.md) and drives the alarm, hazards, simulated sensors, site setup and printed QR codes.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API, ALARM_LABEL, ApiError, api, hashQuery, setControlKey, type Control as ControlData, type SiteSummary } from '../platform/api.ts'
import { errText, setServerTime, type Act, type Notify } from './util.ts'
import Header from './Header.tsx'
import AlarmPanel from './AlarmPanel.tsx'
import Kpis, { FloorsTable } from './Kpis.tsx'
import PlanPanel from './PlanPanel.tsx'
import PeoplePanel from './PeoplePanel.tsx'
import SmsPanel from './SmsPanel.tsx'
import ExitsPanel from './ExitsPanel.tsx'
import WavesPanel from './WavesPanel.tsx'
import SensorsPanel from './SensorsPanel.tsx'
import CamerasPanel from './CamerasPanel.tsx'
import EventFeed from './EventFeed.tsx'
import SiteSetup from './SiteSetup.tsx'
import QrCodes from './QrCodes.tsx'
import './control.css'

type Tab = 'live' | 'setup' | 'qr'
const TABS: [Tab, string][] = [['live', 'Live operations'], ['setup', 'Site setup'], ['qr', 'QR codes']]
const POLL_MS = 3000

export default function Control() {
  const [siteId, setSiteId] = useState(() => hashQuery().get('site') || 'office')
  const [sites, setSites] = useState<SiteSummary[]>([])
  const [data, setData] = useState<ControlData | null>(null)
  const [err, setErr] = useState<{ status: number; text: string } | null>(null)
  const [needKey, setNeedKey] = useState(false)
  const [lastOk, setLastOk] = useState(0)
  const [retry, setRetry] = useState(0)
  const [tab, setTab] = useState<Tab>('live')
  const [origin, setOrigin] = useState('')
  const [notice, setNotice] = useState<{ kind: string; text: string; id: number } | null>(null)
  const siteRef = useRef(siteId)
  siteRef.current = siteId

  // the site can also change from the address bar
  useEffect(() => {
    const on = () => { const s = hashQuery().get('site'); if (s) setSiteId(s) }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  useEffect(() => {
    if (!API) return
    api.get<SiteSummary[]>('/sites').then(setSites).catch(() => {})
  }, [retry])

  useEffect(() => {
    if (!API) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const c = await api.get<ControlData>(`/sites/${encodeURIComponent(siteId)}/control`, true)
        if (!alive) return
        setServerTime(c.server_time); setData(c); setErr(null); setNeedKey(false); setLastOk(Date.now() / 1000)
      } catch (e) {
        if (!alive) return
        const status = e instanceof ApiError ? e.status : 0
        if (status === 401) { setNeedKey(true); return } // wait for a key before polling again
        setErr({ status, text: status === 404 ? `There is no site called “${siteId}”.` : errText(e) })
      }
      if (alive) timer = setTimeout(load, POLL_MS)
    }
    load()
    return () => { alive = false; clearTimeout(timer) }
  }, [siteId, retry])

  const notify: Notify = useCallback((kind, text) => setNotice({ kind, text, id: Date.now() }), [])
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), notice.kind === 'bad' ? 7000 : 4000)
    return () => clearTimeout(t)
  }, [notice])

  const act: Act = useCallback(async (fn, ok) => {
    const sid = siteRef.current
    try {
      const r = await fn()
      if (r && typeof r === 'object' && 'counts' in r && 'rooms' in r && siteRef.current === sid) setData(r as unknown as ControlData)
      const msg = typeof ok === 'function' ? ok(r) : ok
      if (msg) notify('ok', msg)
      return r
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedKey(true)
      notify('bad', errText(e))
      return undefined
    }
  }, [notify])

  const choose = (id: string) => {
    if (id === siteId) return
    history.replaceState(null, '', `#/control?site=${encodeURIComponent(id)}`)
    setData(null); setErr(null); setOrigin(''); setSiteId(id)
  }

  if (!API) {
    return (
      <div className="pf cr">
        <section className="pf-card cr-narrow">
          <p className="pf-eyebrow">Control room</p>
          <h1 className="cr-title">This page needs the Nikaas API</h1>
          <p>The control room shows live check-ins, alarms and hazards from the platform API, and this build was made without one.
            Set <code>VITE_API_URL</code> to the API address and rebuild (for a local run:
            <code>VITE_API_URL=http://localhost:8013 npx vite</code>).</p>
        </section>
      </div>
    )
  }

  const alarm = data?.alarm ?? null
  const live = alarm ? `${ALARM_LABEL[alarm.type] ?? 'Emergency'} alarm running at ${data?.site.name}` : data ? 'No alarm running' : ''

  return (
    <div className="pf cr">
      <Header sites={sites} siteId={siteId} onSite={choose} data={data} lastOk={lastOk} err={err?.text ?? null} />
      <div className="cr-sr" aria-live="assertive" role="status">{live}</div>

      {needKey && <KeyForm onSave={() => { setNeedKey(false); setRetry(r => r + 1) }} />}
      {err && !needKey && (
        <div className={`pf-alert ${data ? 'warn' : 'bad'} cr-gap`} role="alert">
          {data ? `Lost contact with the server; showing the last update. ${err.text}` : err.text}
          {err.status === 404 && sites.length > 0 && <> Pick a site above.</>}
        </div>
      )}

      {!data && !err && !needKey && <p className="pf-muted cr-gap">Loading the control room…</p>}

      {data && (
        <>
          <div className="cr-tabs" role="tablist" aria-label="Control room sections">
            {TABS.map(([k, label]) => (
              <button key={k} role="tab" id={`cr-tab-${k}`} aria-controls={`cr-panel-${k}`} aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          <div role="tabpanel" key={siteId} id={`cr-panel-${tab}`} aria-labelledby={`cr-tab-${tab}`}>
            {tab === 'live' && (
              <>
                <AlarmPanel data={data} siteId={siteId} act={act} notify={notify} origin={origin} setOrigin={setOrigin} />
                <Kpis data={data} />
                <div className="cr-grid">
                  <div className="cr-col cr-col-main">
                    <PlanPanel data={data} siteId={siteId} act={act} notify={notify} onOrigin={id => { setOrigin(id); notify('info', 'Set as the alarm origin. Start the alarm above.') }} origin={origin} />
                    <ExitsPanel data={data} siteId={siteId} act={act} notify={notify} />
                  </div>
                  <div className="cr-col">
                    <FloorsTable data={data} />
                    <PeoplePanel data={data} />
                    <SmsPanel data={data} siteId={siteId} act={act} notify={notify} />
                  </div>
                  <div className="cr-col cr-col-side">
                    <WavesPanel data={data} />
                    <EventFeed data={data} />
                    <SensorsPanel data={data} siteId={siteId} act={act} notify={notify} />
                    <CamerasPanel data={data} siteId={siteId} />
                  </div>
                </div>
              </>
            )}
            {tab === 'setup' && <SiteSetup key={siteId} data={data} siteId={siteId} act={act} notify={notify} />}
            {tab === 'qr' && <QrCodes data={data} siteId={siteId} />}
          </div>
        </>
      )}

      {notice && <div key={notice.id} className={`cr-notice ${notice.kind}`} role={notice.kind === 'bad' ? 'alert' : 'status'}>
        <span>{notice.text}</span>
        <button type="button" className="cr-x" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
      </div>}
    </div>
  )
}

function KeyForm({ onSave }: { onSave: () => void }) {
  const [v, setV] = useState('')
  return (
    <form className="pf-card cr-key cr-gap" onSubmit={e => { e.preventDefault(); setControlKey(v.trim() || null); onSave() }}>
      <h2>Control key needed</h2>
      <p className="pf-muted pf-small">This server only lets staff with the control key see the dashboard. The key is kept in this browser.</p>
      <div className="pf-row">
        <label className="pf-field pf-grow">Control key
          <input type="password" autoComplete="current-password" value={v} onChange={e => setV(e.target.value)} required />
        </label>
        <button className="pf-btn primary cr-key-btn" type="submit">Connect</button>
      </div>
    </form>
  )
}
