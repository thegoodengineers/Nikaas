// One floor of a building as a clean SVG plan: rooms, walkways, stair landings, exits, a route, hazards,
// and an optional colour per room (crowding, groups). Used by the phone, the control room and the editor.
import type { MapEdge, MapNode } from './api.ts'

type Props = {
  nodes: MapNode[]
  edges: MapEdge[]
  floor: string | null
  route?: string[]
  routeColor?: string
  hazards?: string[]
  here?: string | null
  target?: string | null
  roomFill?: Record<string, string>
  badges?: Record<string, string>
  blocked?: string[]
  onNode?: (id: string) => void
  selected?: string | null
  label?: string
  className?: string
  showLabels?: boolean
  labels?: Record<string, string>
  /** zoom to these nodes (those on the shown floor), with a margin; the whole building otherwise */
  focus?: string[]
  /** the node the current step leads to: marked with a pulsing ring */
  stepNode?: string | null
  /** moving dashes along the route */
  animate?: boolean
  targetLabel?: string
  /** only rooms react to taps (no walkway, stair or exit targets): choosing where you are */
  roomsOnly?: boolean
}

export default function PlanView({ nodes, edges, floor, route, routeColor = 'var(--exit)', hazards = [], here, target, roomFill, badges, blocked = [], onNode, selected, label, className, showLabels, labels, focus, stepNode, animate, targetLabel, roomsOnly }: Props) {
  const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const on = (n: MapNode) => floor === null || n[6] === floor || n[6] === null
  const pos = Object.fromEntries(nodes.map(n => [n[0], n]))
  // frame every floor the same way, so switching floors does not jump; or zoom to the nodes in `focus` on this floor
  const all = nodes.flatMap(n => [n[2] - n[4] / 2, n[2] + n[4] / 2]), allz = nodes.flatMap(n => [n[3] - n[5] / 2, n[3] + n[5] / 2])
  const unit = Math.max(Math.max(...all) - Math.min(...all), Math.max(...allz) - Math.min(...allz)) / 100 // strokes follow building size
  const fx = (focus ?? []).map(id => pos[id]).filter(n => n && on(n))
  const frame = fx.length ? fx : nodes
  const xs = frame.flatMap(n => [n[2] - n[4] / 2, n[2] + n[4] / 2]), zs = frame.flatMap(n => [n[3] - n[5] / 2, n[3] + n[5] / 2])
  const pad = fx.length ? Math.max(6, unit * 8) : 4
  let x0 = Math.min(...xs) - pad, z0 = Math.min(...zs) - pad, w = Math.max(...xs) + pad - x0, h = Math.max(...zs) + pad - z0
  const minSide = unit * 30 // never zoom so far in that the surroundings disappear
  if (w < minSide) { x0 -= (minSide - w) / 2; w = minSide }
  if (h < minSide * 0.7) { z0 -= (minSide * 0.7 - h) / 2; h = minSide * 0.7 }
  const vis = nodes.filter(on)
  const visIds = new Set(vis.map(n => n[0]))
  const landings = new Set(edges.filter(e => e[2] === 'stair').flatMap(e => [e[0], e[1]]))
  const segs: [MapNode, MapNode][] = []
  for (let k = 1; k < (route?.length ?? 0); k++) {
    const a = pos[route![k - 1]], b = pos[route![k]]
    if (a && b && on(a) && on(b)) segs.push([a, b])
  }
  const blockedSet = new Set([...blocked, ...hazards])
  return (
    <svg className={`plan ${className ?? ''}`} viewBox={`${x0} ${z0} ${w} ${h}`} role="img" aria-label={label ?? 'Floor plan'} style={{ ['--u' as string]: unit }}>
      <defs>
        <marker id="plan-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill={routeColor} />
        </marker>
      </defs>
      {edges.map(([a, b, kind], k) => {
        const A = pos[a], B = pos[b]
        if (!A || !B || !visIds.has(a) || !visIds.has(b) || kind === 'stair') return null
        return <line key={k} x1={A[2]} y1={A[3]} x2={B[2]} y2={B[3]} className={kind === 'door' ? 'plan-door' : 'plan-walk'} style={{ strokeWidth: (kind === 'door' ? 0.9 : 2.2) * unit }} />
      })}
      {vis.filter(n => n[1] === 'room').map(n => (
        <g key={n[0]} className={`plan-room ${n[0] === here ? 'is-here' : ''} ${n[0] === selected ? 'is-selected' : ''} ${onNode ? 'is-click' : ''}`}
          onClick={onNode ? () => onNode(n[0]) : undefined} role={onNode ? 'button' : undefined} tabIndex={onNode ? 0 : undefined}
          onKeyDown={onNode ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNode(n[0]) } } : undefined}
          aria-label={onNode ? labels?.[n[0]] ?? n[0] : undefined}>
          <rect x={n[2] - n[4] / 2} y={n[3] - n[5] / 2} width={Math.max(n[4], unit * 2)} height={Math.max(n[5], unit * 2)} rx={unit * 0.6}
            style={{ fill: roomFill?.[n[0]], strokeWidth: (n[0] === here || n[0] === selected ? 0.7 : 0.35) * unit }} />
          {showLabels && labels?.[n[0]] && n[4] > unit * 8 && <text x={n[2]} y={n[3]} className="plan-text" style={{ fontSize: Math.min(n[5] * 0.28, unit * 3.4, (n[4] * 0.9) / (labels[n[0]].length * 0.58)) }}>{labels[n[0]]}</text>}
          {badges?.[n[0]] && <text x={n[2]} y={n[3] + (showLabels ? Math.min(n[5] * 0.3, unit * 3.6) : 0)} className="plan-badge" style={{ fontSize: Math.min(n[5] * 0.32, unit * 3.8) }}>{badges[n[0]]}</text>}
        </g>
      ))}
      {vis.filter(n => n[1] !== 'room' && landings.has(n[0])).map(n => (
        <g key={n[0]} className={`plan-stair ${onNode && !roomsOnly ? 'is-click' : ''} ${n[0] === selected ? 'is-selected' : ''}`} onClick={onNode && !roomsOnly ? () => onNode(n[0]) : undefined}>
          <rect x={n[2] - unit * 2.2} y={n[3] - unit * 2.2} width={unit * 4.4} height={unit * 4.4} rx={unit * 0.5} style={{ strokeWidth: 0.35 * unit }} />
          {[0, 1, 2].map(k => <line key={k} x1={n[2] - unit * 1.4} x2={n[2] + unit * 1.4} y1={n[3] - unit * 1.1 + k * unit * 1.1} y2={n[3] - unit * 1.1 + k * unit * 1.1} style={{ strokeWidth: 0.3 * unit }} />)}
        </g>
      ))}
      {onNode && !roomsOnly && vis.filter(n => n[1] === 'corridor' && !landings.has(n[0])).map(n => (
        <circle key={n[0]} cx={n[2]} cy={n[3]} r={unit * 1.5} className={`plan-node is-click ${n[0] === selected ? 'is-selected' : ''}`} onClick={() => onNode(n[0])} />
      ))}
      {segs.map(([a, b], k) => (
        <line key={`r${k}`} x1={a[2]} y1={a[3]} x2={b[2]} y2={b[3]} className="plan-route" stroke={routeColor}
          style={{ strokeWidth: 1.4 * unit, strokeDasharray: animate ? `${unit * 2.4} ${unit * 1.6}` : undefined }} markerEnd={k === segs.length - 1 ? 'url(#plan-arrow)' : undefined}>
          {animate && !reduced && <animate attributeName="stroke-dashoffset" from="0" to={-unit * 4} dur="0.8s" repeatCount="indefinite" />}
        </line>
      ))}
      {vis.filter(n => n[1] === 'exit').map(n => {
        const off = blockedSet.has(n[0])
        return (
          <g key={n[0]} className={`plan-exit ${off ? 'is-blocked' : ''} ${n[0] === target ? 'is-target' : ''} ${onNode && !roomsOnly ? 'is-click' : ''}`} onClick={onNode && !roomsOnly ? () => onNode(n[0]) : undefined}>
            <circle cx={n[2]} cy={n[3]} r={unit * (n[0] === target ? 3 : 2.3)} />
            {off && <path d={`M${n[2] - unit} ${n[3] - unit}L${n[2] + unit} ${n[3] + unit}M${n[2] + unit} ${n[3] - unit}L${n[2] - unit} ${n[3] + unit}`} style={{ strokeWidth: 0.5 * unit }} />}
          </g>
        )
      })}
      {hazards.map(id => pos[id] && on(pos[id]) && (
        <g key={`h${id}`} className="plan-hazard">
          <circle cx={pos[id][2]} cy={pos[id][3]} r={unit * 4.5} className="plan-hazard-glow" />
          <circle cx={pos[id][2]} cy={pos[id][3]} r={unit * 1.8} />
        </g>
      ))}
      {target && targetLabel && pos[target] && on(pos[target]) && (
        <text x={pos[target][2]} y={pos[target][3] - unit * 4.2} className="plan-target-label" style={{ fontSize: unit * 3.2 }}>{targetLabel}</text>
      )}
      {stepNode && pos[stepNode] && on(pos[stepNode]) && stepNode !== here && (
        <circle cx={pos[stepNode][2]} cy={pos[stepNode][3]} r={unit * 3} className="plan-step" style={{ strokeWidth: unit * 0.6 }} />
      )}
      {here && pos[here] && on(pos[here]) && (
        <g className="plan-you">
          <circle cx={pos[here][2]} cy={pos[here][3]} r={unit * 3.2} className="plan-you-ring" />
          <circle cx={pos[here][2]} cy={pos[here][3]} r={unit * 1.4} />
        </g>
      )}
    </svg>
  )
}

export function FloorTabs({ floors, value, onChange, marks }: { floors: { id: string; name: string }[]; value: string | null; onChange: (id: string) => void; marks?: Record<string, string> }) {
  if (floors.length < 2) return null
  return (
    <div className="floor-tabs" role="tablist" aria-label="Floors">
      {[...floors].reverse().map(f => (
        <button key={f.id} role="tab" aria-selected={value === f.id} className={value === f.id ? 'on' : ''} onClick={() => onChange(f.id)}>
          {f.name}{marks?.[f.id] && <span className="floor-mark">{marks[f.id]}</span>}
        </button>
      ))}
    </div>
  )
}
