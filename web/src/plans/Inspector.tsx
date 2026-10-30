// Properties of the selected node or link. Each field is one undo step: the change starts when the field
// gets focus and ends when it loses it.
import { useState } from 'react'
import type { Building, BuildingEdge, BuildingNode } from '../platform/api.ts'
import { dist, edgeKind, isStair, nodeMap, patchEdge, patchNode, round1, WIDTH } from './model.ts'

export type Sel = { kind: 'node'; id: string } | { kind: 'edge'; i: number } | null
export type Edit = { begin: () => void; change: (fn: (b: Building) => Building) => void; end: () => void; commit: (fn: (b: Building) => Building) => void }

type Props = {
  building: Building; sel: Sel; edit: Edit; floorName: (id: string | undefined) => string
  onSelect: (s: Sel) => void; onPickNode: (id: string) => void; onDelete: () => void; onMeasure: (i: number) => void; measuring: boolean
}

export default function Inspector({ building, sel, edit, floorName, onSelect, onPickNode, onDelete, onMeasure, measuring }: Props) {
  const by = nodeMap(building)
  if (!sel) return <p className="pf-empty">Select a room, point, exit or link to see its details. Shortcuts: V select, R room, C walkway, E exit, S stair, L connect, D delete, F fit.</p>
  if (sel.kind === 'node') {
    const n = by[sel.id]
    if (!n) return <p className="pf-empty">Nothing selected.</p>
    const set = (patch: Record<string, unknown>) => edit.change(b => patchNode(b, n.id, patch))
    const links = building.edges.map((e, i) => [e, i] as const).filter(([e]) => e.from === n.id || e.to === n.id)
    const changeType = (t: BuildingNode['type']) => edit.commit(b => patchNode(b, n.id, t === 'room'
      ? { type: t, w: n.w ?? 4, d: n.d ?? 4, people: n.people ?? 10, stair: undefined }
      : { type: t, w: undefined, d: undefined, people: undefined, use: undefined, stair: t === 'exit' ? undefined : n.stair, label: n.label ?? (t === 'exit' ? 'Exit' : undefined) }))
    return (
      <div className="pf-stack pl-insp">
        <div className="pl-insp-id"><span className="pf-muted pf-small">ID</span><code>{n.id}</code>{n.floor_id && <span className="pf-chip">{floorName(n.floor_id)}</span>}</div>
        <TextField label="Label" value={n.label ?? ''} edit={edit} onChange={v => set({ label: v || undefined })} />
        <label className="pf-field">Type
          <select value={n.type} onChange={e => changeType(e.target.value as BuildingNode['type'])}>
            <option value="room">Room</option><option value="corridor">Walkway point</option><option value="exit">Exit</option>
          </select>
        </label>
        {n.type === 'room' && (
          <div className="pl-grid2">
            <NumField label="People" value={n.people ?? 0} step={1} min={0} edit={edit} onChange={v => set({ people: Math.max(0, Math.round(v)) })} />
            <span />
            <NumField label="Width w (m)" value={n.w ?? 0} step={0.1} min={0.5} edit={edit} onChange={v => set({ w: Math.max(0.5, round1(v)) })} />
            <NumField label="Depth d (m)" value={n.d ?? 0} step={0.1} min={0.5} edit={edit} onChange={v => set({ d: Math.max(0.5, round1(v)) })} />
          </div>
        )}
        {n.type === 'corridor' && (
          <label className="pl-check"><input type="checkbox" checked={n.stair === true} onChange={e => edit.commit(b => patchNode(b, n.id, { stair: e.target.checked || undefined }))} />
            Stair landing (joined to the floors above and below by Link stairs)</label>
        )}
        {n.type === 'corridor' && n.stair !== true && isStair(n) && <p className="pf-small pf-muted">Counts as a stair landing because its name contains “stair”.</p>}
        <div className="pl-grid2">
          <NumField label="x (m)" value={n.x} step={0.1} edit={edit} onChange={v => set({ x: round1(v) })} />
          <NumField label="z (m)" value={n.z} step={0.1} edit={edit} onChange={v => set({ z: round1(v) })} />
        </div>
        <div>
          <p className="pf-eyebrow">Links ({links.length})</p>
          {links.length === 0 && <p className="pf-small pl-status bad">Not connected. Use Connect (L) to join it to a walkway.</p>}
          <ul className="pl-links">
            {links.map(([e, i]) => {
              const other = e.from === n.id ? e.to : e.from
              return (
                <li key={i}><button className="pl-linkbtn" onClick={() => onSelect({ kind: 'edge', i })}>
                  <span className="pf-chip">{edgeKind(building, e)}</span>{by[other]?.label ?? other}<span className="pf-muted">{e.width} m</span>
                  {by[other]?.floor_id !== n.floor_id && <span className="pf-muted">· {floorName(by[other]?.floor_id)}</span>}
                </button></li>
              )
            })}
          </ul>
        </div>
        <button className="pf-btn danger" onClick={onDelete}>Delete {n.type === 'room' ? 'room' : n.type === 'exit' ? 'exit' : 'point'}</button>
      </div>
    )
  }
  const e = building.edges[sel.i]
  if (!e) return <p className="pf-empty">Nothing selected.</p>
  const A = by[e.from], B = by[e.to]
  const kind = edgeKind(building, e)
  const cross = (A?.floor_id ?? null) !== (B?.floor_id ?? null)
  const set = (patch: Record<string, unknown>) => edit.change(b => patchEdge(b, sel.i, patch))
  const straight = A && B ? round1(dist(A, B)) : 0
  return (
    <div className="pf-stack pl-insp">
      <div className="pl-insp-ends">
        {[A, B].map((x, k) => x && (
          <button key={k} className="pl-linkbtn" onClick={() => onPickNode(x.id)}>
            <span className="pf-muted pf-small">{k ? 'To' : 'From'}</span><b>{x.label ?? x.id}</b><span className="pf-muted pf-small">{floorName(x.floor_id)}</span>
          </button>
        ))}
      </div>
      <label className="pf-field">Kind
        <select value={kind} onChange={ev => {
          const k = ev.target.value as NonNullable<BuildingEdge['kind']>
          edit.commit(b => patchEdge(b, sel.i, { kind: k, capacity_group: k === 'stair' ? e.capacity_group : undefined, length: k === 'stair' ? e.length ?? 6.5 : e.length }))
        }}>
          <option value="door" disabled={cross}>Door</option><option value="corridor" disabled={cross}>Corridor</option><option value="stair">Stair</option>
        </select>
      </label>
      <div className="pl-measure-row">
        <NumField label="Clear width (m)" value={e.width} step={0.1} min={0.1} edit={edit} onChange={v => set({ width: Math.max(0.1, round1(v)) })} />
        <button className={`pf-btn ${measuring ? 'primary' : ''}`} onClick={() => onMeasure(sel.i)} title="Click two points across the corridor or door on the plan">Measure width</button>
      </div>
      <p className="pf-small pf-muted">Typical: door {WIDTH.door} m, corridor {WIDTH.corridor} m. Measure on the plan picture after setting the scale.</p>
      {kind === 'stair' || e.length !== undefined ? (
        <NumField label={kind === 'stair' ? 'Walking length on the stairs (m)' : 'Length (m)'} value={e.length ?? straight} step={0.1} min={0.1} edit={edit}
          onChange={v => set({ length: Math.max(0.1, round1(v)) })} />
      ) : (
        <p className="pf-small pf-muted">Length: {straight} m (straight line). <button className="pl-textbtn" onClick={() => edit.commit(b => patchEdge(b, sel.i, { length: straight }))}>Set a length</button></p>
      )}
      {kind !== 'stair' && e.length !== undefined && <button className="pl-textbtn pf-small" onClick={() => edit.commit(b => patchEdge(b, sel.i, { length: undefined }))}>Use straight-line length ({straight} m)</button>}
      {kind === 'stair' && <TextField label="Stair shaft (capacity group)" value={e.capacity_group ?? ''} edit={edit} onChange={v => set({ capacity_group: v.trim() || undefined })} placeholder="e.g. stair_north" />}
      {cross && kind !== 'stair' && <p className="pf-small pl-status bad">Links between floors must be stairs.</p>}
      <button className="pf-btn danger" onClick={onDelete}>Delete link</button>
    </div>
  )
}

export function TextField({ label, value, onChange, edit, placeholder }: { label: string; value: string; onChange: (v: string) => void; edit: Edit; placeholder?: string }) {
  return (
    <label className="pf-field">{label}
      <input value={value} placeholder={placeholder} onFocus={edit.begin} onBlur={edit.end} onChange={e => onChange(e.target.value)} />
    </label>
  )
}

/** A number box that keeps what is typed (e.g. "1.") until it is a number, and follows outside changes otherwise. */
export function NumField({ label, value, onChange, edit, step, min }: { label: string; value: number; onChange: (v: number) => void; edit: Edit; step?: number; min?: number }) {
  const [text, setText] = useState<string | null>(null)
  return (
    <label className="pf-field">{label}
      <input type="number" inputMode="decimal" step={step} min={min} value={text ?? String(value)}
        onFocus={() => { setText(String(value)); edit.begin() }}
        onBlur={() => { setText(null); edit.end() }}
        onChange={e => { setText(e.target.value); const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(v) }} />
    </label>
  )
}
