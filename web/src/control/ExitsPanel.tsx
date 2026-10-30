// One card per exit: its group, whether it is open, how many are heading there and out, the estimated
// time to clear, and the marshal list of rooms. Each card prints as a marshal sheet.
import type { Control } from '../platform/api.ts'
import { duration, floorName, type PanelProps } from './util.ts'
import usePrint from './usePrint.tsx'
import { GroupTag } from './PlanPanel.tsx'

type Exit = Control['exits'][number]

export default function ExitsPanel({ data }: PanelProps) {
  const [layer, print] = usePrint()
  const a = data.alarm
  return (
    <section className="pf-card" aria-labelledby="cr-exits-h">
      <div className="cr-card-head">
        <h2 id="cr-exits-h">Exits and marshals</h2>
        {!a && <span className="pf-muted pf-small">Groups and marshal lists are assigned when an alarm starts.</span>}
      </div>
      <div className="cr-exits">
        {data.exits.map(x => {
          const total = x.assigned + x.out
          return (
            <article key={x.id} className={`cr-exit ${x.blocked ? 'is-blocked' : ''}`} style={{ ['--g' as string]: x.color ?? '#aeb7c1' }}>
              <header className="cr-exit-head">
                <GroupTag letter={x.group} color={x.color} />
                <h3 className="cr-exit-title">{x.label}</h3>
                {x.blocked ? <span className="pf-chip bad">Blocked</span> : <span className="pf-chip ok">Open</span>}
              </header>
              <dl className="cr-exit-stats">
                <div><dt>Planned</dt><dd>{x.planned}</dd></div>
                <div><dt>Phones heading</dt><dd>{x.assigned}</dd></div>
                <div><dt>Out</dt><dd>{x.out}</dd></div>
                <div><dt>Est. clear</dt><dd>{x.eta_s != null ? duration(x.eta_s) : '–'}</dd></div>
              </dl>
              {total > 0 && (
                <div className="cr-bar" role="img" aria-label={`${x.out} of ${total} phones out`}><span style={{ width: `${(x.out / total) * 100}%` }} /></div>
              )}
              <p className="cr-exit-sub">Rooms heading here</p>
              {x.room_labels.length
                ? <ul className="cr-tags">{x.room_labels.map((r, i) => <li key={x.rooms[i] ?? r}>{r}</li>)}</ul>
                : <p className="pf-empty">{x.blocked ? 'No rooms: this exit is blocked.' : a ? 'No rooms assigned.' : 'Assigned when an alarm starts.'}</p>}
              <button type="button" className="pf-btn cr-btn-s" disabled={!x.rooms.length} onClick={() => print(<MarshalSheet data={data} exit={x} />, 'marshal')}>Print marshal sheet</button>
            </article>
          )
        })}
      </div>
      {layer}
    </section>
  )
}

function MarshalSheet({ data, exit }: { data: Control; exit: Exit }) {
  const b = data.site.building
  const point = data.site.assembly.find(p => p.exits?.includes(exit.id))
  return (
    <div className="cr-sheet">
      <header className="cr-sheet-head">
        <div>
          <p className="cr-sheet-eyebrow">Marshal sheet · {data.site.name}</p>
          <h1>{exit.label}</h1>
          {point && <p>Assembly point: <strong>{point.label}</strong></p>}
        </div>
        {exit.group && <div className="cr-sheet-group" style={{ background: exit.color ?? '#15191e' }}>Group {exit.group}</div>}
      </header>
      <p className="cr-sheet-meta">Printed {new Date().toLocaleString()} · Planned {exit.planned} people · Estimated time to clear {duration(exit.eta_s)}</p>
      <table className="cr-sheet-table">
        <thead><tr><th>Room</th><th>Floor</th><th>Planned</th><th>Phones checked in</th><th>Room cleared</th></tr></thead>
        <tbody>
          {exit.rooms.map((rid, i) => {
            const r = data.rooms[rid]
            return (
              <tr key={rid}>
                <td>{exit.room_labels[i] ?? rid}</td>
                <td>{floorName(b, r?.floor)}</td>
                <td>{r?.planned ?? ''}</td>
                <td>{r ? r.people : ''}</td>
                <td><span className="cr-sheet-box" /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="cr-sheet-foot">Sweep each room, tick it when empty, and report anyone who needs help to the control room.</p>
    </div>
  )
}
