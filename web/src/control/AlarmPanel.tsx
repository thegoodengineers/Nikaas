// Start an alarm (with a confirm step) or, while one runs, the red status strip with "All clear".
import { useState } from 'react'
import { ALARM_LABEL, api, fmtTime } from '../platform/api.ts'
import Confirm from './Confirm.tsx'
import { ALARM_TYPES, duration, floorName, floorsOf, nodeGroups, nodeLabel, useNow, type PanelProps } from './util.ts'

type Props = PanelProps & { origin: string; setOrigin: (id: string) => void }

export default function AlarmPanel(p: Props) {
  return p.data.alarm ? <Running {...p} /> : <StartForm {...p} />
}

function StartForm({ data, siteId, act, origin, setOrigin }: Props) {
  const b = data.site.building
  const multi = floorsOf(b).length > 1
  const [type, setType] = useState('fire')
  const [message, setMessage] = useState('')
  const [phased, setPhased] = useState(false)
  const [gap, setGap] = useState(60)
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const groups = nodeGroups(b)

  const start = async () => {
    setBusy(true)
    const r = await act(() => api.post(`/sites/${encodeURIComponent(siteId)}/alarm`, {
      type, message: message.trim(), origin: origin || null, phased: multi && phased, wave_gap_s: gap,
    }, true), `${ALARM_LABEL[type]} alarm started. Phones are being alerted.`)
    setBusy(false)
    setAsk(false)
    if (r) { setMessage(''); setOrigin('') }
  }

  return (
    <section className="pf-card cr-start cr-gap" aria-labelledby="cr-start-h">
      <div className="cr-start-head">
        <h2 id="cr-start-h">Alarm</h2>
        <span className="pf-muted pf-small">No alarm running. {data.counts.checked_in} {data.counts.checked_in === 1 ? 'phone is' : 'phones are'} checked in.</span>
      </div>
      <form className="cr-start-form" onSubmit={e => { e.preventDefault(); setAsk(true) }}>
        <label className="pf-field"><span>Type</span>
          <select value={type} onChange={e => setType(e.target.value)}>
            {ALARM_TYPES.map(t => <option key={t} value={t}>{ALARM_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="pf-field"><span>Origin <span className="cr-opt">optional</span></span>
          <select value={origin} onChange={e => setOrigin(e.target.value)}>
            <option value="">Not known</option>
            {groups.map(g => (
              <optgroup key={g.id ?? 'all'} label={g.name}>
                {g.nodes.map(n => <option key={n.id} value={n.id}>{n.label ?? n.id}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="pf-field cr-start-msg"><span>Message to phones <span className="cr-opt">optional</span></span>
          <input value={message} maxLength={200} onChange={e => setMessage(e.target.value)} placeholder="e.g. Smoke on the first floor, east side" />
        </label>
        {multi && (
          <div className="cr-start-phase">
            <label className="cr-check">
              <input type="checkbox" checked={phased} onChange={e => setPhased(e.target.checked)} />
              <span>Phased release</span>
            </label>
            {phased && (
              <label className="pf-field cr-wavegap"><span>Wave gap (s)</span>
                <input type="number" min={10} max={600} step={10} value={gap} onChange={e => setGap(Math.max(10, Math.min(600, Number(e.target.value) || 60)))} />
              </label>
            )}
          </div>
        )}
        <button type="submit" className="pf-btn danger cr-start-btn">Start alarm…</button>
      </form>
      {multi && phased && <p className="pf-muted pf-small cr-hint">The incident floor and the floor above leave first; other floors follow in waves {gap} s apart (phased evacuation, BS 9999).</p>}

      <Confirm open={ask} title={`Start a ${ALARM_LABEL[type].toLowerCase()} alarm?`} confirmLabel="Start alarm" tone="danger" busy={busy}
        onConfirm={start} onCancel={() => setAsk(false)}>
        <p>Every checked-in phone at <strong>{data.site.name}</strong> ({data.counts.checked_in}) gets an alert and its own route out.</p>
        <ul className="cr-dl">
          <li><span>Type</span><strong>{ALARM_LABEL[type]}</strong></li>
          <li><span>Origin</span><strong>{origin ? `${nodeLabel(b, origin)}${floorName(b, b.nodes.find(n => n.id === origin)?.floor_id) ? `, ${floorName(b, b.nodes.find(n => n.id === origin)?.floor_id)}` : ''}` : 'Not known'}</strong></li>
          {message.trim() && <li><span>Message</span><strong>{message.trim()}</strong></li>}
          {multi && <li><span>Release</span><strong>{phased ? `Phased, waves ${gap} s apart` : 'Everyone at once'}</strong></li>}
        </ul>
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
  const drill = a.type === 'drill'
  return (
    <section className={`cr-alarm cr-gap ${drill ? 'is-drill' : ''}`} aria-labelledby="cr-alarm-h">
      <div className="cr-alarm-top">
        <div>
          <p className="cr-alarm-eyebrow"><span className="cr-pulse" aria-hidden="true" />Alarm running</p>
          <h2 id="cr-alarm-h" className="cr-alarm-title">{ALARM_LABEL[a.type] ?? 'Emergency'}</h2>
          {a.message && <p className="cr-alarm-msg">“{a.message}”</p>}
        </div>
        <button type="button" className="pf-btn cr-allclear" onClick={() => setAsk(true)}>All clear…</button>
      </div>
      <dl className="cr-alarm-stats">
        <div><dt>Elapsed</dt><dd className="pf-num">{fmtTime(now - a.started_at)}</dd></div>
        <div><dt>Estimated clearing time</dt><dd className="pf-num">{a.time_s != null ? fmtTime(a.time_s) : '–'}</dd><dd className="cr-alarm-note">Simulator estimate for this plan</dd></div>
        <div><dt>Plan</dt><dd>{a.method && a.method !== 'none' ? a.method : 'No plan'}</dd><dd className="cr-alarm-note">{a.phased ? `Phased, ${duration(a.wave_gap_s)} between waves` : 'Everyone leaves at once'}</dd></div>
        <div><dt>Origin</dt><dd>{a.origin ? nodeLabel(b, a.origin) : 'Not known'}</dd><dd className="cr-alarm-note">Started {new Date(a.started_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd></div>
      </dl>
      {a.trapped.length > 0 && (
        <p className="cr-alarm-trap" role="alert"><strong>No way out from:</strong> {a.trapped.map(id => nodeLabel(b, id)).join(', ')}. Those phones are told to go to a refuge and wait for rescue.</p>
      )}
      <Confirm open={ask} title="Send all clear?" confirmLabel="All clear" tone="go" busy={busy} onConfirm={clear} onCancel={() => setAsk(false)}>
        <p>Every checked-in phone gets an all-clear message, and everyone's status (safe, help) resets. Only do this when the building is safe again.</p>
      </Confirm>
    </section>
  )
}
