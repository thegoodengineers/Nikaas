// Every link's clear width next to the width read from the traced walls, with its confidence and what it
// means for capacity. Nothing changes until a row is accepted.
import type { Building } from '../platform/api.ts'
import { edgeKind, nodeMap } from './model.ts'
import { fmtLen, numU, type Units } from './units.ts'
import { CONF_TONE, edgeKey, perMin, suggests, type Measure } from './widths.ts'

type Props = {
  building: Building; measured: Record<string, Measure>; ignored: Set<string>; units: Units; selected: number | null
  onPick: (i: number) => void; onAccept: (i: number, w: number) => void; onAcceptHigh: () => void; onIgnore: (key: string) => void
  onMeasureAll: () => void; canMeasure: boolean; floorName: (id: string | undefined) => string
}

export default function WidthsPanel({ building: b, measured, ignored, units: u, selected, onPick, onAccept, onAcceptHigh, onIgnore, onMeasureAll, canMeasure, floorName }: Props) {
  const by = nodeMap(b)
  const label = (id: string) => by[id]?.label ?? id
  const any = Object.keys(measured).length > 0
  const high = b.edges.filter(e => { const m = measured[edgeKey(e)]; return m?.conf === 'high' && suggests(m, e.width) && !ignored.has(edgeKey(e)) }).length
  const rows = b.edges.map((e, i) => ({ e, i, m: measured[edgeKey(e)], kind: edgeKind(b, e) }))
  const counts = { high: 0, medium: 0, low: 0 }
  for (const r of rows) if (r.m) counts[r.m.conf]++
  const multi = (b.floors?.length ?? 0) > 1
  return (
    <div className="pf-stack pl-widths">
      <p className="pf-small pf-muted">Corridors: rays across the walkway at several points. Doors: the gap where the link crosses the room's wall. Exits: the gap in the wall at the exit.</p>
      <div className="pf-row">
        <button className="pf-btn" onClick={onMeasureAll} disabled={!canMeasure} title={canMeasure ? '' : 'Trace walls first'}>{any ? 'Measure again' : 'Measure all widths'}</button>
        {high > 0 && <button className="pf-btn primary" onClick={onAcceptHigh}>Accept {high} high-confidence</button>}
      </div>
      {!canMeasure && <p className="pf-small pf-muted">Trace walls from the plan picture first (Floor panel).</p>}
      {any && <p className="pf-small">{counts.high} high · {counts.medium} medium · <span className="pl-status bad" style={{ display: 'inline' }}>{counts.low} low confidence</span> (check those by hand)</p>}
      {any && (
        <div className="pl-wtable-wrap">
          <table className="pf-table pl-wtable">
            <thead><tr><th>Link</th><th>Now ({u})</th><th>Walls ({u})</th><th /></tr></thead>
            <tbody>
              {rows.map(({ e, i, m, kind }) => {
                const key = edgeKey(e)
                const ign = ignored.has(key)
                const diff = suggests(m, e.width)
                return (
                  <tr key={i} className={`${selected === i ? 'sel' : ''} ${m && m.conf === 'low' ? 'low' : ''} ${ign ? 'ign' : ''}`}>
                    <td>
                      <button className="pl-textlink" onClick={() => onPick(i)} title={m?.note ?? ''}>{label(e.from)} → {label(e.to)}</button>
                      <span className="pf-muted pf-small"> {kind}{multi ? ` · ${floorName(by[e.from]?.floor_id)}` : ''}</span>
                    </td>
                    <td className="num">{numU(e.width, u)}<span className="pf-muted pf-small"><br />{perMin(kind, e.width)}/min</span></td>
                    <td className="num">
                      {m?.width ? <>{numU(m.width, u)} <span className={`pf-chip ${CONF_TONE[m.conf]}`} title={m.note}>{m.conf}</span><span className="pf-muted pf-small"><br />{perMin(kind, m.width)}/min</span></>
                        : m ? <span className="pf-small pl-status bad" title={m.note}>none</span> : <span className="pf-muted">–</span>}
                    </td>
                    <td className="act">
                      {diff && !ign && <button className="pf-btn" onClick={() => onAccept(i, m!.width!)} title={`Set ${fmtLen(m!.width!, u)}`}>Use</button>}
                      {diff && !ign && <button className="pl-textbtn pf-small" onClick={() => onIgnore(key)}>ignore</button>}
                      {ign && <button className="pl-textbtn pf-small" onClick={() => onIgnore(key)}>ignored</button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
