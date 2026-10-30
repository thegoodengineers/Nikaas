// The alarm bar under the site name: "No alarm" with the Start button, or the red strip of a running alarm
// with its clock and "All clear". Starting asks what is happening and where in one window, then confirms.
import { useState } from 'react'
import { ALARM_LABEL, api, fmtTime } from '../platform/api.ts'
import Confirm from './Confirm.tsx'
import { ALARM_TYPES, duration, floorName, floorsOf, nodeGroups, nodeLabel, useNow, type PanelProps } from './util.ts'

type Props = PanelProps & { origin: string; setOrigin: (id: string) => void; asking: boolean; setAsking: (on: boolean) => void }

// one line icon per alarm type for the type picker (24-unit paths)
const GLYPH: Record<string, string> = {
  fire: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1.2-3.6 2.4-4.6.2 1.6 1 2.6 2.1 3.1C11 9 11.2 6 12 3z',
  earthquake: 'M2 12h3l2-6 3 12 3-9 2 5 2-2h5',
  collapse: 'M3 5h18M6 5l2 4M12 5v3M18 5l-2 5M5 15l3-2 3 3-3 2zM13 14l4-1 1 4-4 1zM3 21h18',
  gas: 'M8 21h8M12 17v4M7 10a5 5 0 0 1 10 0c0 3-2 4-2 7H9c0-3-2-4-2-7zM12 3v2',
  drill: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  other: 'M12 3l10 18H2zM12 10v5M12 18v.01',
}
const SHORT: Record<string, string> = { collapse: 'Collapse', drill: 'Drill', other: 'Other' }

export default function AlarmPanel(p: Props) {
  return p.data.alarm ? <Running {...p} /> : <Standby {...p} />
}

function Standby({ data, siteId, act, origin, setOrigin, asking, setAsking }: Props) {
  const b = data.site.building
  const multi = floorsOf(b).length > 1
  const [type, setType] = useState('fire')
  const [message, setMessage] = useState('')
  const [phased, setPhased] = useState(false)
  const [gap, setGap] = useState(60)
  const [busy, setBusy] = useState(false)
  const groups = nodeGroups(b)
  const n = data.counts.checked_in
  const alerts = data.push?.on ?? 0
  const where = origin ? `${nodeLabel(b, origin)}${floorName(b, b.nodes.find(x => x.id === origin)?.floor_id) ? `, ${floorName(b, b.nodes.find(x => x.id === origin)?.floor_id)}` : ''}` : ''

  const start = async () => {
    setBusy(true)
    const r = await act(() => api.post(`/sites/${encodeURIComponent(siteId)}/alarm`, {
      type, message: message.trim(), origin: origin || null, phased: multi && phased, wave_gap_s: gap,
    }, true), `${ALARM_LABEL[type]} alarm started. ${alerts ? `Notifying ${alerts} ${alerts === 1 ? 'phone' : 'phones'}.` : 'No phone has notifications on.'}`)
    setBusy(false)
    setAsking(false)
    if (r) { setMessage(''); setOrigin('') }
  }

  return (
    <section className="cr-state calm" aria-labelledby="cr-state-h">
      <span className="cr-state-dot" aria-hidden="true" />
      <div className="cr-state-main">
        <h2 id="cr-state-h">No alarm</h2>
        <p>{n} {n === 1 ? 'phone' : 'phones'} checked in, {alerts} with notifications on. Each gets an alert and its own route out the moment you start one.</p>
      </div>
      <button type="button" className="pf-btn danger cr-start-btn" onClick={() => setAsking(true)}>Start alarm…</button>

      <Confirm open={asking} title="Start an alarm" confirmLabel={`Start ${ALARM_LABEL[type].toLowerCase()} alarm`} tone="danger" busy={busy}
        onConfirm={start} onCancel={() => setAsking(false)} className="cr-dialog-wide">
        <div className="pf-field"><span>What is happening</span>
          <div className="cr-types" role="radiogroup" aria-label="Alarm type">
            {ALARM_TYPES.map(t => (
              <button key={t} type="button" role="radio" aria-checked={type === t} className={`cr-type ${type === t ? 'on' : ''}`} onClick={() => setType(t)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d={GLYPH[t]} /></svg>{SHORT[t] ?? ALARM_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        {alerts === 0 && <p className="pf-alert warn pf-small">No phone in this building has notifications on, so nobody gets a pop-up. Phones see the alarm only while their page is open. Scan this building's QR code (QR codes tab) and tap Turn on alerts.</p>}
        <label className="pf-field"><span>Where it started <span className="cr-opt">optional, routes keep away from it</span></span>
          <select value={origin} onChange={e => setOrigin(e.target.value)}>
            <option value="">Not known</option>
            {groups.map(g => (
              <optgroup key={g.id ?? 'all'} label={g.name}>
                {g.nodes.map(x => <option key={x.id} value={x.id}>{nodeLabel(b, x.id)}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="pf-field"><span>Message to phones <span className="cr-opt">optional</span></span>
          <input value={message} maxLength={200} onChange={e => setMessage(e.target.value)} placeholder="e.g. Smoke on the first floor, east side" />
        </label>
        {multi && (
          <div className="cr-start-phase">
            <label className="cr-check">
              <input type="checkbox" checked={phased} onChange={e => setPhased(e.target.checked)} />
              <span>Phased release: the incident floor and the one above leave first (BS 9999)</span>
            </label>
            {phased && (
              <label className="pf-field cr-wavegap"><span>Seconds between waves</span>
                <input type="number" min={10} max={600} step={10} value={gap} onChange={e => setGap(Math.max(10, Math.min(600, Number(e.target.value) || 60)))} />
              </label>
            )}
          </div>
        )}
        <p className="cr-sum">
          {n ? `All ${n} checked-in ${n === 1 ? 'phone' : 'phones'} at ${data.site.name} get a ${ALARM_LABEL[type].toLowerCase()} alert with their own route out` : `No phones are checked in at ${data.site.name} yet. The alarm still starts and the plan is made`}
          {where ? `, keeping away from ${where}.` : '.'}
        </p>
      </Confirm>
    </section>
  )
}

function Running({ data, siteId, act }: Props) {
  const a = data.alarm!
  const b = data.site.building
  const now = useNow(1000)
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const clear = async () => {
    setBusy(true)
    await act(() => api.del(`/sites/${encodeURIComponent(siteId)}/alarm`, true), 'All clear sent.')
    setBusy(false)
    setAsk(false)
  }
  const started = new Date(a.started_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <section className={`cr-state alarm ${a.type === 'drill' ? 'is-drill' : ''}`} aria-labelledby="cr-state-h">
      <span className="cr-state-dot cr-pulse" aria-hidden="true" />
      <div className="cr-state-main">
        <h2 id="cr-state-h">{ALARM_LABEL[a.type] ?? 'Emergency'} alarm</h2>
        <p>Started {started}{a.origin ? ` · at ${nodeLabel(b, a.origin)}` : ''}{a.message ? ` · “${a.message}”` : ''}</p>
      </div>
      <dl className="cr-state-stats">
        <div><dt>Elapsed</dt><dd className="pf-num">{fmtTime(now - a.started_at)}</dd></div>
        <div><dt>Estimated clear</dt><dd className="pf-num">{a.time_s != null ? fmtTime(a.time_s) : '–'}</dd></div>
        <div><dt>Plan</dt><dd>{a.method && a.method !== 'none' ? a.method : 'No plan'}, {a.phased ? `waves ${duration(a.wave_gap_s)} apart` : 'everyone at once'}</dd></div>
      </dl>
      <button type="button" className="pf-btn cr-allclear" onClick={() => setAsk(true)}>All clear…</button>
      <Confirm open={ask} title="Send all clear?" confirmLabel="All clear" tone="go" busy={busy} onConfirm={clear} onCancel={() => setAsk(false)}>
        <p>Every checked-in phone gets an all-clear message, and everyone's status (safe, help) resets. Only do this when the building is safe again.</p>
      </Confirm>
    </section>
  )
}
