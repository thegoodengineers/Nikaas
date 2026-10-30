// Simulated heat and smoke detectors for the demo: sliders post readings like a real IoT detector would.
import { useEffect, useRef, useState } from 'react'
import { ago, api, type Control } from '../platform/api.ts'
import { floorName, nodeGroups, nodeLabel, useBusy, type PanelProps } from './util.ts'

const T_MIN = 20, T_MAX = 90, SMOKE_AT = 0.5
type Sensor = Control['sensors'][number]

export default function SensorsPanel({ data, siteId, act }: PanelProps) {
  const b = data.site.building
  const groups = nodeGroups(b)
  const [node, setNode] = useState(() => b.nodes.find(n => n.type === 'room')?.id ?? groups[0]?.nodes[0]?.id ?? '')
  const heat = data.thresholds.heat_c
  const [busy, run] = useBusy()

  const add = () => {
    if (!node) return
    let k = 1
    const ids = new Set(data.sensors.map(s => s.sensor_id))
    while (ids.has(`sim-${node}-${k}`)) k++
    void run('add', () => act(() => api.post(`/sites/${encodeURIComponent(siteId)}/sensors`, { sensor_id: `sim-${node}-${k}`, node, temp_c: 22, smoke: 0 }, true),
      `Sensor added in ${nodeLabel(b, node)}.`))
  }

  return (
    <section className="pf-card" aria-labelledby="cr-sens-h">
      <h2 id="cr-sens-h">Sensors <span className="pf-chip info cr-h-chip">Simulated</span></h2>
      <p className="pf-muted pf-small cr-hint">
        Demo heat and smoke detectors. A reading at or above {heat} °C (fixed-temperature heat detector rating) or smoke {SMOKE_AT} raises
        a hazard at the sensor and, if no alarm is running, starts a fire alarm.
      </p>
      <form className="cr-sens-add" onSubmit={e => { e.preventDefault(); add() }}>
        <label className="pf-field pf-grow">Place a sensor in
          <select value={node} onChange={e => setNode(e.target.value)}>
            {groups.map(g => (
              <optgroup key={g.id ?? 'all'} label={g.name}>
                {g.nodes.map(n => <option key={n.id} value={n.id}>{n.label ?? n.id}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <button type="submit" className="pf-btn" disabled={!!busy}>{busy ? 'Adding…' : 'Add sensor'}</button>
      </form>
      {data.sensors.length === 0 ? <p className="pf-empty">No sensors yet.</p> : (
        <ul className="cr-list cr-sensors">
          {data.sensors.map(s => <SensorRow key={s.sensor_id} s={s} data={data} siteId={siteId} act={act} heat={heat} />)}
        </ul>
      )}
    </section>
  )
}

function SensorRow({ s, data, siteId, act, heat }: { s: Sensor; data: Control; siteId: string; act: PanelProps['act']; heat: number }) {
  const b = data.site.building
  const [draft, setDraft] = useState<{ temp_c: number; smoke: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const temp = draft?.temp_c ?? s.temp_c ?? T_MIN
  const smoke = draft?.smoke ?? s.smoke ?? 0
  const label = nodeLabel(b, s.node)
  const hot = temp >= heat || smoke >= SMOKE_AT
  const hasHazard = data.hazards.some(h => h.node === s.node)

  const send = (v: { temp_c: number; smoke: number }) => {
    setDraft(v)
    clearTimeout(timer.current)
    const my = ++seq.current
    const known = new Set(data.hazards.map(h => h.id))
    timer.current = setTimeout(async () => {
      await act(() => api.post<{ hazard?: string | null }>(`/sites/${encodeURIComponent(siteId)}/sensors`, { sensor_id: s.sensor_id, node: s.node, ...v }, true),
        r => (r?.hazard && !known.has(r.hazard) ? `${label}: reading over the threshold. Hazard raised${data.alarm ? '' : ' and fire alarm started'}.` : null))
      if (seq.current === my) setDraft(null)
    }, 400)
  }
  const tMark = (heat - T_MIN) / (T_MAX - T_MIN)
  const id = `cr-s-${s.sensor_id}`
  return (
    <li className={`cr-sensor ${hot ? 'is-hot' : ''}`}>
      <div className="cr-sensor-top">
        <div>
          <strong>{label}</strong>
          <span className="pf-muted pf-small"> · {floorName(b, b.nodes.find(n => n.id === s.node)?.floor_id) || 'Building'}</span>
        </div>
        {hot ? <span className="pf-chip bad">{hasHazard ? 'Hazard raised' : 'Over threshold'}</span> : temp >= heat - 12 ? <span className="pf-chip warn">Warm</span> : <span className="pf-chip ok">Normal</span>}
      </div>
      <div className="cr-range-row">
        <label htmlFor={`${id}-t`}>Temperature</label>
        <output htmlFor={`${id}-t`} className="num">{Math.round(temp)} °C</output>
      </div>
      <div className="cr-range" style={{ ['--mark' as string]: tMark }}>
        <input id={`${id}-t`} type="range" min={T_MIN} max={T_MAX} step={1} value={temp} onChange={e => send({ temp_c: Number(e.target.value), smoke })}
          aria-valuetext={`${Math.round(temp)} degrees Celsius`} />
        <span className="cr-range-mark" aria-hidden="true"><span>{heat} °C</span></span>
      </div>
      <div className="cr-range-row">
        <label htmlFor={`${id}-s`}>Smoke</label>
        <output htmlFor={`${id}-s`} className="num">{smoke.toFixed(2)}</output>
      </div>
      <div className="cr-range" style={{ ['--mark' as string]: SMOKE_AT }}>
        <input id={`${id}-s`} type="range" min={0} max={1} step={0.05} value={smoke} onChange={e => send({ temp_c: temp, smoke: Number(e.target.value) })} />
        <span className="cr-range-mark" aria-hidden="true"><span>{SMOKE_AT}</span></span>
      </div>
      <p className="pf-muted pf-small"><code className="cr-tok">{s.sensor_id}</code> · last reading {ago(s.at)}</p>
    </li>
  )
}
