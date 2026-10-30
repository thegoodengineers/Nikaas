// Headcount tiles and the per-floor table.
import type { Control } from '../platform/api.ts'

export default function Kpis({ data }: { data: Control }) {
  const c = data.counts
  const a = data.alarm
  const pct = (n: number) => (c.checked_in ? `${Math.round((n / c.checked_in) * 100)}% of checked in` : 'No one checked in')
  const tiles: { label: string; value: string; note: string; tone?: string }[] = [
    { label: 'Checked in', value: String(c.checked_in), note: 'Phones on site' },
    { label: 'Inside', value: String(c.inside), note: a ? 'Not yet out' : 'In the building' },
    { label: 'Safe', value: String(c.safe), note: a ? pct(c.safe) : 'Marked safe outside', tone: c.safe ? 'ok' : undefined },
    { label: 'Need help', value: String(c.help), note: c.help ? 'Send a responder' : 'No requests', tone: c.help ? 'bad' : undefined },
    { label: 'Missing', value: a ? String(c.missing) : '–', note: a ? 'Not confirmed safe' : 'Counts during an alarm', tone: a && c.missing ? 'warn' : undefined },
  ]
  return (
    <section className="cr-kpis cr-gap" aria-label="Headcount">
      {tiles.map(t => (
        <div key={t.label} className={`cr-kpi ${t.tone ?? ''}`}>
          <p className="cr-kpi-label">{t.label}</p>
          <p className="cr-kpi-num">{t.value}</p>
          <p className="cr-kpi-note">{t.note}</p>
        </div>
      ))}
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
