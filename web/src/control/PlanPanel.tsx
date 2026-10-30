// Floor plan: rooms coloured by crowding or by exit group, people counts, hazards and blocked exits.
// Clicking a room, walkway, stair or exit opens its details and the "report here" actions.
import { useMemo, useState } from 'react'
import PlanView, { FloorTabs } from '../platform/PlanView.tsx'
import { ago, api } from '../platform/api.ts'
import { HAZARD_KINDS, HAZARD_LABEL, SOURCE_LABEL, floorName, floorsOf, mapOf, nodeKind, nodeLabel, type PanelProps } from './util.ts'

const FILL = { empty: '#ffffff', ok: '#e9f6ee', concern: '#fde68a', crush: '#fca5a5' }

type Props = PanelProps & { onOrigin: (id: string) => void; origin: string }

export default function PlanPanel({ data, siteId, act, notify, onOrigin, origin }: Props) {
  const b = data.site.building
  const floors = floorsOf(b)
  const map = useMemo(() => mapOf(b), [b])
  const labels = useMemo(() => Object.fromEntries(b.nodes.map(n => [n.id, n.label ?? n.id])), [b])
  const [floor, setFloor] = useState<string | null>(() => {
    const o = data.alarm?.origin ? b.nodes.find(n => n.id === data.alarm!.origin)?.floor_id : undefined
    return o ?? floors[0]?.id ?? null
  })
  const [mode, setMode] = useState<'crowd' | 'group'>('crowd')
  const [showLabels, setShowLabels] = useState(true)
  const [sel, setSel] = useState<string | null>(null)
  const groupColor = Object.fromEntries(data.exits.filter(x => x.group).map(x => [x.group!, x.color ?? '#5f6b77']))

  const fill: Record<string, string> = {}
  const badges: Record<string, string> = {}
  for (const [id, r] of Object.entries(data.rooms)) {
    const count = r.camera ?? r.people
    if (mode === 'crowd') fill[id] = r.level === 'ok' ? (count > 0 ? FILL.ok : FILL.empty) : FILL[r.level]
    else fill[id] = r.group && groupColor[r.group] ? `${groupColor[r.group]}40` : FILL.empty
    if (mode === 'group' && r.group) badges[id] = count > 0 ? `${r.group} · ${count}` : r.group
    else if (count > 0) badges[id] = String(count)
  }
  const hazardNodes = data.hazards.map(h => h.node)
  const blocked = data.exits.filter(x => x.blocked).map(x => x.id)
  const marks: Record<string, string> = {}
  for (const f of floors) {
    const n = data.hazards.filter(h => h.floor === f.id).length + data.help.filter(p => p.floor === f.id).length
    if (n) marks[f.id] = String(n)
  }
  const floorOf = (id: string) => b.nodes.find(n => n.id === id)?.floor_id ?? null

  const pick = (id: string) => {
    setSel(s => (s === id ? null : id))
    const f = floorOf(id)
    if (f && f !== floor) setFloor(f)
  }

  return (
    <section className="pf-card cr-plan" aria-labelledby="cr-plan-h">
      <div className="cr-card-head">
        <h2 id="cr-plan-h">Floor plan</h2>
        <FloorTabs floors={floors} value={floor} onChange={f => { setFloor(f); setSel(null) }} marks={marks} />
      </div>
      <div className="cr-plan-tools">
        <div className="cr-seg" role="group" aria-label="Colour rooms by">
          <button type="button" aria-pressed={mode === 'crowd'} className={mode === 'crowd' ? 'on' : ''} onClick={() => setMode('crowd')}>Crowding</button>
          <button type="button" aria-pressed={mode === 'group'} className={mode === 'group' ? 'on' : ''} onClick={() => setMode('group')} disabled={!data.alarm}
            title={data.alarm ? undefined : 'Exit groups are assigned when an alarm starts'}>Exit groups</button>
        </div>
        <label className="cr-check"><input type="checkbox" checked={showLabels} onChange={e => setShowLabels(e.target.checked)} /><span>Room names</span></label>
        <span className="pf-muted pf-small cr-plan-tip">Select a room, walkway or exit for details.</span>
      </div>
      <PlanView nodes={map.nodes} edges={map.edges} floor={floor} hazards={hazardNodes} roomFill={fill} badges={badges} blocked={blocked}
        onNode={pick} selected={sel} labels={labels} showLabels={showLabels}
        label={`Floor plan, ${floorName(b, floor) || 'building'}. ${data.hazards.length} hazards.`} className="cr-planview" />
      <Legend data={data} mode={mode} groupColor={groupColor} />
      {sel && <NodePanel id={sel} data={data} siteId={siteId} act={act} notify={notify} onClose={() => setSel(null)} onOrigin={onOrigin} origin={origin} />}
      <HazardList data={data} siteId={siteId} act={act} notify={notify} onPick={pick} />
    </section>
  )
}

function Legend({ data, mode, groupColor }: { data: PanelProps['data']; mode: 'crowd' | 'group'; groupColor: Record<string, string> }) {
  const t = data.thresholds
  return (
    <ul className="cr-legend" aria-label="Legend">
      {mode === 'crowd' ? (
        <>
          <li><i style={{ background: FILL.ok }} />Below {t.concern} people/m²</li>
          <li><i style={{ background: FILL.concern }} />Concern from {t.concern} p/m²</li>
          <li><i style={{ background: FILL.crush }} />Crush warning from {t.crush} p/m²</li>
        </>
      ) : data.exits.filter(x => x.group).map(x => (
        <li key={x.id}><i style={{ background: `${groupColor[x.group!]}40`, borderColor: groupColor[x.group!] }} />Group {x.group}: {x.label}</li>
      ))}
      <li><i className="cr-lg-dot exit" />Exit</li>
      <li><i className="cr-lg-dot blocked" />Blocked exit</li>
      <li><i className="cr-lg-dot hazard" />Hazard</li>
      <li><i className="cr-lg-stair" />Stair</li>
      <li className="pf-muted">Numbers: people (camera count when a camera sees the room)</li>
    </ul>
  )
}

type NodeProps = PanelProps & { id: string; onClose: () => void; onOrigin: (id: string) => void; origin: string }

function NodePanel({ id, data, siteId, act, onClose, onOrigin, origin }: NodeProps) {
  const b = data.site.building
  const n = b.nodes.find(x => x.id === id)
  if (!n) return null
  const label = nodeLabel(b, id)
  const kind = nodeKind(b, id)
  const room = data.rooms[id]
  const spot = data.spots.find(s => s.node === id)
  const exit = data.exits.find(x => x.id === id)
  const roomExit = room?.exit ? data.exits.find(x => x.id === room.exit) : undefined
  const here = data.hazards.filter(h => h.node === id)
  const report = (k: string) => act(() => api.post(`/sites/${encodeURIComponent(siteId)}/hazards`, { kind: k, node: id, source: 'manual' }, true),
    `${HAZARD_LABEL[k]} reported at ${label}. Routes are being re-planned.`)
  const level = room?.level ?? spot?.level
  return (
    <div className="cr-node" role="region" aria-label={`${label} details`}>
      <div className="cr-node-head">
        <div>
          <h3 className="cr-node-title">{label}</h3>
          <p className="pf-muted pf-small">{kind}{n.floor_id ? ` · ${floorName(b, n.floor_id)}` : ''}</p>
        </div>
        <button type="button" className="pf-btn ghost cr-node-x" onClick={onClose}>Close</button>
      </div>
      <dl className="cr-facts">
        {room && <>
          <div><dt>Phones inside</dt><dd>{room.people}</dd></div>
          <div><dt>Camera count</dt><dd>{room.camera ?? '–'}</dd></div>
          <div><dt>Design occupancy</dt><dd>{room.planned}</dd></div>
          <div><dt>Density</dt><dd>{room.density.toFixed(2)} p/m² <LevelChip level={room.level} /></dd></div>
          <div><dt>Area</dt><dd>{room.area_m2} m²</dd></div>
          <div><dt>Assigned exit</dt><dd>{roomExit ? <><GroupTag letter={roomExit.group} color={roomExit.color} /> {roomExit.label}</> : room.trapped ? <span className="pf-chip bad">No way out</span> : data.alarm ? '–' : 'Set when an alarm starts'}</dd></div>
        </>}
        {!room && spot && <>
          <div><dt>Camera count</dt><dd>{spot.people}</dd></div>
          <div><dt>Density</dt><dd>{spot.density.toFixed(2)} p/m² <LevelChip level={spot.level} /></dd></div>
        </>}
        {exit && <>
          <div><dt>Status</dt><dd>{exit.blocked ? <span className="pf-chip bad">Blocked</span> : <span className="pf-chip ok">Open</span>}</dd></div>
          <div><dt>Group</dt><dd>{exit.group ? <GroupTag letter={exit.group} color={exit.color} /> : '–'}</dd></div>
          <div><dt>Heading here</dt><dd>{exit.assigned}</dd></div>
          <div><dt>Out</dt><dd>{exit.out}</dd></div>
        </>}
        {!room && !spot && !exit && <div><dt>Camera</dt><dd>No camera here</dd></div>}
      </dl>
      {level && level !== 'ok' && <p className={`pf-alert ${level === 'crush' ? 'bad' : 'warn'} pf-small`}>{level === 'crush' ? 'Crush warning: stop more people entering and open other routes.' : 'Crowding concern: watch this space.'}</p>}

      {here.length > 0 && (
        <ul className="cr-node-hz">
          {here.map(h => (
            <li key={h.id}><span className="pf-chip bad">{HAZARD_LABEL[h.kind] ?? h.kind}</span><span className="pf-muted pf-small">{SOURCE_LABEL[h.source ?? 'manual'] ?? h.source}{h.at ? `, ${ago(h.at)}` : ''}</span>
              <button type="button" className="pf-btn cr-btn-s" onClick={() => act(() => api.del(`/sites/${encodeURIComponent(siteId)}/hazards/${encodeURIComponent(h.id)}`, true), `${HAZARD_LABEL[h.kind] ?? 'Hazard'} at ${label} cleared.`)}>Clear</button></li>
          ))}
        </ul>
      )}
      <p className="cr-node-sub">Report here</p>
      <div className="cr-node-actions">
        {HAZARD_KINDS.map(k => (
          <button key={k} type="button" className="pf-btn cr-btn-s cr-btn-hz" onClick={() => report(k)}>{HAZARD_LABEL[k]}</button>
        ))}
      </div>
      {!data.alarm && n.type !== 'exit' && (
        <div className="cr-node-origin">
          {origin === id
            ? <span className="pf-chip info">Alarm origin</span>
            : <button type="button" className="pf-btn cr-btn-s" onClick={() => onOrigin(id)}>Set as alarm origin</button>}
        </div>
      )}
    </div>
  )
}

function HazardList({ data, siteId, act, onPick }: PanelProps & { onPick: (id: string) => void }) {
  const b = data.site.building
  return (
    <section className="cr-hz" aria-labelledby="cr-hz-h">
      <h3 id="cr-hz-h" className="cr-sub-h">Hazards <span className={`pf-chip ${data.hazards.length ? 'bad' : ''}`}>{data.hazards.length}</span></h3>
      {data.hazards.length === 0 ? <p className="pf-empty">No hazards reported. Routes use every exit.</p> : (
        <ul className="cr-list">
          {[...data.hazards].reverse().map(h => (
            <li key={h.id} className="cr-li">
              <span className="pf-chip bad">{HAZARD_LABEL[h.kind] ?? h.kind}</span>
              <button type="button" className="cr-link" onClick={() => onPick(h.node)}>{h.label || nodeLabel(b, h.node)}</button>
              <span className="pf-muted pf-small cr-li-meta">{SOURCE_LABEL[h.source ?? 'manual'] ?? h.source}{h.confidence != null ? ` ${Math.round(h.confidence * 100)}%` : ''}{h.at ? ` · ${ago(h.at)}` : ''}</span>
              <button type="button" className="pf-btn cr-btn-s" onClick={() => act(() => api.del(`/sites/${encodeURIComponent(siteId)}/hazards/${encodeURIComponent(h.id)}`, true), 'Hazard cleared. Routes are being re-planned.')}>Clear</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function LevelChip({ level }: { level: string }) {
  return level === 'crush' ? <span className="pf-chip bad">Crush warning</span> : level === 'concern' ? <span className="pf-chip warn">Concern</span> : <span className="pf-chip ok">OK</span>
}

export function GroupTag({ letter, color }: { letter: string | null; color: string | null }) {
  if (!letter) return null
  return <span className="cr-group" style={{ background: color ?? '#5f6b77' }} aria-label={`Group ${letter}`}>{letter}</span>
}
