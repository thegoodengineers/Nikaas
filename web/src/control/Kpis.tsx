// The headcount strip (checked in, inside, safe, need help, with a bar of the three) and the per-floor table.
import type { Control } from '../platform/api.ts'

export default function Kpis({ data }: { data: Control }) {
  const c = data.counts, a = !!data.alarm
  const all = c.inside + c.safe + c.help
  const pc = (n: number) => `${all ? (n / all) * 100 : 0}%`
  const cells = [
    { k: 'all', n: c.checked_in, label: 'Checked in', note: 'phones on site' },
    { k: 'in', n: c.inside, label: a ? 'Still inside' : 'Inside', note: a ? 'not yet marked safe' : 'in the building' },
    { k: 'safe', n: c.safe, label: 'Safe', note: a ? 'at an assembly point' : 'counts during an alarm' },
    { k: 'help', n: c.help, label: 'Need help', note: c.help ? 'send a responder' : 'no requests' },
  ]
  return (
    <section className="cr-count" aria-label="Headcount">
      <div className="cr-count-cells">
        {cells.map(x => (
          <div key={x.k} className={`cr-cell ${x.k} ${x.k === 'help' && x.n ? 'on' : ''}`}>
            <b className="pf-num">{x.n}</b><span>{x.label}<small>{x.note}</small></span>
          </div>
        ))}
      </div>
      <div className="cr-count-bar" role="img" aria-label={`${c.safe} safe, ${c.help} need help, ${c.inside} inside`}>
        <i className="safe" style={{ width: pc(c.safe) }} /><i className="help" style={{ width: pc(c.help) }} /><i className="in" style={{ width: pc(c.inside) }} />
      </div>
    </section>
  )
}

export function FloorsTable({ data }: { data: Control }) {
  const phased = !!data.alarm?.phased && data.floors.length > 1
  const rows = [...data.floors].reverse() // top floor first, like the building
  return (
    <section className="pf-card" aria-labelledby="cr-floors-h">
      <h2 id="cr-floors-h">By floor</h2>
      <table className="pf-table cr-table">
        <thead>
          <tr><th scope="col">Floor</th><th scope="col" className="r">Inside</th><th scope="col" className="r">Safe</th><th scope="col" className="r">Help</th>{phased && <th scope="col" className="r">Wave</th>}</tr>
        </thead>
        <tbody>
          {rows.map(f => (
            <tr key={f.id ?? 'all'}>
              <th scope="row">{f.name}</th>
              <td className="r num">{f.inside}</td>
              <td className={`r num ${f.safe ? 'cr-t-ok' : ''}`}>{f.safe}</td>
              <td className={`r num ${f.help ? 'cr-t-bad' : ''}`}>{f.help}</td>
              {phased && <td className="r num">{f.wave + 1}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
