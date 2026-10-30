// Phased release timeline: which floors leave in each wave, with a countdown to each release.
import { fmtTime, type Control } from '../platform/api.ts'
import { floorName, useNow } from './util.ts'

export default function WavesPanel({ data }: { data: Control }) {
  const a = data.alarm
  const now = useNow(1000)
  if (!a?.phased || data.waves.length < 2) return null
  const b = data.site.building
  return (
    <section className="pf-card" aria-labelledby="cr-waves-h">
      <h2 id="cr-waves-h">Phased release</h2>
      <ol className="cr-waves">
        {data.waves.map(w => {
          const at = a.started_at + w.release_at
          const left = at - now
          const done = left <= 0
          const pct = w.release_at > 0 ? Math.min(100, Math.max(0, ((now - a.started_at) / w.release_at) * 100)) : 100
          return (
            <li key={w.wave} className={`cr-wave ${done ? 'is-done' : ''}`}>
              <div className="cr-wave-top">
                <strong>Wave {w.wave + 1}</strong>
                {done
                  ? <span className="pf-chip ok">Released{w.release_at > 0 ? ` ${fmtTime(-left)} ago` : ''}</span>
                  : <span className="pf-chip warn">Releases in <span className="num">{fmtTime(left)}</span></span>}
              </div>
              <div className="pf-small">{w.floors.map(f => floorName(b, f)).join(', ')}</div>
              <div className="cr-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
            </li>
          )
        })}
      </ol>
      <p className="pf-muted pf-small cr-foot">Phones on later floors are told to wait and get a second alert when their wave is released.</p>
    </section>
  )
}
