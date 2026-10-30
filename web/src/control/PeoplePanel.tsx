// People by what they need: help first, then not yet confirmed safe, then safe. Tokens are anonymous ids.
import { ago, type Control, type ControlPerson } from '../platform/api.ts'
import { NEED_LABEL, floorName } from './util.ts'
import { GroupTag } from './PlanPanel.tsx'

export default function PeoplePanel({ data }: { data: Control }) {
  const b = data.site.building
  const a = data.alarm
  const color = Object.fromEntries(data.exits.filter(x => x.group).map(x => [x.group!, x.color]))
  const safe = data.people.filter(p => p.status === 'safe')
  const inside = data.people.filter(p => p.status === 'inside')
  const where = (p: ControlPerson) => [p.room_label ?? 'Room not given', floorName(b, p.floor)].filter(Boolean).join(' · ')
  const help = [...data.help].sort((x, y) => needRank(x.need) - needRank(y.need) || x.updated_at - y.updated_at)

  return (
    <section className="pf-card cr-people" aria-labelledby="cr-people-h">
      <h2 id="cr-people-h">People</h2>

      <h3 className="cr-sub-h">Need help <span className={`pf-chip ${help.length ? 'bad' : ''}`}>{help.length}</span></h3>
      {help.length === 0 ? <p className="pf-empty">No one has asked for help.</p> : (
        <ul className="cr-list cr-help">
          {help.map((p, i) => (
            <li key={`${p.token}-${i}`} className="cr-help-item">
              <div className="cr-help-top">
                <strong>{p.need ? NEED_LABEL[p.need] ?? p.need : 'Help requested'}</strong>
                <span className="pf-muted pf-small">{ago(p.updated_at)}</span>
              </div>
              <div className="cr-help-where">{where(p)}</div>
              <div className="pf-muted pf-small">Phone <code className="cr-tok">{p.token}</code>{p.push ? '' : ' · no push alerts'}</div>
            </li>
          ))}
        </ul>
      )}

      {a ? (
        <>
          <h3 className="cr-sub-h">Not yet confirmed safe <span className={`pf-chip ${data.missing.length ? 'warn' : 'ok'}`}>{data.missing.length}</span></h3>
          {data.missing.length === 0 ? <p className="pf-empty">Everyone checked in is safe or has asked for help.</p> : (
            <ul className="cr-list cr-scroll">
              {[...data.missing].sort((x, y) => (x.floor ?? '').localeCompare(y.floor ?? '') || (x.room_label ?? '').localeCompare(y.room_label ?? '')).map((p, i) => (
                <li key={`${p.token}-${i}`} className="cr-li">
                  <code className="cr-tok">{p.token}</code>
                  <span className="cr-li-main">{where(p)}</span>
                  <span className="cr-li-meta pf-small pf-muted">{p.group && <GroupTag letter={p.group} color={color[p.group] ?? null} />} {ago(p.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <h3 className="cr-sub-h">Checked in <span className="pf-chip">{inside.length}</span></h3>
          {inside.length === 0 ? <p className="pf-empty">No phones checked in. People check in by scanning an entrance or room QR code.</p> : (
            <ul className="cr-list cr-scroll">
              {inside.map((p, i) => (
                <li key={`${p.token}-${i}`} className="cr-li">
                  <code className="cr-tok">{p.token}</code>
                  <span className="cr-li-main">{where(p)}</span>
                  <span className="cr-li-meta pf-small pf-muted">{ago(p.updated_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <h3 className="cr-sub-h">Safe <span className={`pf-chip ${safe.length ? 'ok' : ''}`}>{safe.length}</span></h3>
      {safe.length === 0 ? <p className="pf-empty">{a ? 'No one has marked themselves safe yet.' : 'People mark themselves safe at the assembly point during an alarm.'}</p> : (
        <ul className="cr-list cr-scroll">
          {safe.map((p, i) => (
            <li key={`${p.token}-${i}`} className="cr-li">
              <code className="cr-tok">{p.token}</code>
              <span className="cr-li-main">{p.room_label ? `From ${p.room_label}` : 'Room not given'}</span>
              <span className="cr-li-meta pf-small">{verified(p)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="pf-muted pf-small cr-foot">Phones are anonymous: each shows a short random id, never a name.</p>
    </section>
  )
}

const needRank = (n: string | null) => (n === 'trapped' ? 0 : n === 'medical' ? 1 : n === 'stairs' ? 2 : 3)

function verified(p: ControlPerson) {
  if (p.safe_verified) return <span className="cr-verified" title={p.safe_distance_m != null ? `${Math.round(p.safe_distance_m)} m from the assembly point` : undefined}>✓ GPS verified</span>
  if (p.safe_distance_m != null) return <span className="cr-t-warn">{Math.round(p.safe_distance_m)} m from the assembly point</span>
  return <span className="pf-muted">Self-reported</span>
}
