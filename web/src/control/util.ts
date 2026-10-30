// Shared helpers for the control room: map data from the building, labels, clocks, printing.
import { useEffect, useRef, useState } from 'react'
import type { Building, Control, MapEdge, MapNode } from '../platform/api.ts'

export type Ctl = Control
/** Run a control action: errors become a notice, a Control answer replaces the dashboard data. */
export type Act = <T = Control>(fn: () => Promise<T>, ok?: string | ((r: T) => string | null | undefined)) => Promise<T | undefined>
export type Notify = (kind: 'ok' | 'bad' | 'info' | 'warn', text: string) => void
/** Props every live panel gets. */
export type PanelProps = { data: Control; siteId: string; act: Act; notify: Notify }

/** Control actions take a few seconds while the server re-plans: `run(key, fn)` runs one at a time and `busy`
 * says which, so its button can show it is working and a second click cannot send it twice. */
export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null)
  const running = useRef(false)
  const run = async (key: string, fn: () => Promise<unknown>) => {
    if (running.current) return
    running.current = true; setBusy(key)
    try { await fn() } finally { running.current = false; setBusy(null) }
  }
  return [busy, run] as const
}

export const ALARM_TYPES = ['fire', 'earthquake', 'collapse', 'gas', 'drill', 'other'] as const
export const HAZARD_KINDS = ['fire', 'smoke', 'heat', 'collapse', 'blocked'] as const
export const HAZARD_LABEL: Record<string, string> = { fire: 'Fire', smoke: 'Smoke', heat: 'Heat', collapse: 'Collapse', blocked: 'Blocked' }
export const NEED_LABEL: Record<string, string> = { stairs: 'Cannot use stairs', medical: 'Medical', trapped: 'Trapped' }
export const SOURCE_LABEL: Record<string, string> = { manual: 'Manual', sensor: 'Sensor', camera: 'Camera' }

export function mapOf(b: Building): { nodes: MapNode[]; edges: MapEdge[] } {
  return {
    nodes: b.nodes.map(n => [n.id, n.type, n.x, n.z, n.w ?? 0, n.d ?? 0, n.floor_id ?? null] as MapNode),
    edges: b.edges.map(e => [e.from, e.to, e.kind ?? 'corridor'] as MapEdge),
  }
}

/** A place's name. Walkway points drawn without one are named after the nearest named room or exit on their floor. */
export const nodeLabel = (b: Building, id: string | null | undefined) => {
  if (!id) return ''
  const n = b.nodes.find(x => x.id === id)
  if (!n || n.label) return n?.label ?? id.replace(/_/g, ' ')
  const near = b.nodes.filter(x => x.label && (x.floor_id ?? null) === (n.floor_id ?? null))
    .sort((p, q) => Math.hypot(p.x - n.x, p.z - n.z) - Math.hypot(q.x - n.x, q.z - n.z))[0]
  return near ? `Walkway by ${near.label}` : id.replace(/_/g, ' ')
}

/** Stair landings are corridor nodes joined by a stair edge. */
export const stairNodes = (b: Building) => new Set(b.edges.filter(e => e.kind === 'stair').flatMap(e => [e.from, e.to]))

export function nodeKind(b: Building, id: string): string {
  const n = b.nodes.find(x => x.id === id)
  if (!n) return 'Location'
  if (n.type === 'room') return 'Room'
  if (n.type === 'exit') return 'Exit'
  return stairNodes(b).has(id) ? 'Stair landing' : 'Corridor'
}

export const floorsOf = (b: Building) => [...(b.floors ?? [])].sort((a, c) => a.elevation_m - c.elevation_m)
export const floorName = (b: Building, id: string | null | undefined) => (id ? b.floors?.find(f => f.id === id)?.name ?? id : '')

/** Rooms and walkways grouped by floor, for pickers. */
export function nodeGroups(b: Building, types: string[] = ['room', 'corridor']) {
  const floors = floorsOf(b)
  const pick = b.nodes.filter(n => types.includes(n.type))
  if (!floors.length) return [{ id: null as string | null, name: 'Building', nodes: pick }]
  return floors.map(f => ({ id: f.id as string | null, name: f.name, nodes: pick.filter(n => n.floor_id === f.id) })).filter(g => g.nodes.length)
}

// server clock minus this computer's clock: elapsed times and countdowns follow the server, not a wrong local clock
let skew = 0
export const setServerTime = (t: number | undefined) => { if (t) skew = t - Date.now() / 1000 }
const serverNow = () => Date.now() / 1000 + skew

/** Seconds since the epoch on the server's clock, refreshed on an interval. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export const clock = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const duration = (s: number | null | undefined) => {
  if (s === null || s === undefined || !isFinite(s)) return '–'
  const v = Math.max(0, Math.round(s))
  return v < 60 ? `${v} s` : v % 60 === 0 ? `${v / 60} min` : `${Math.floor(v / 60)} min ${String(v % 60).padStart(2, '0')} s`
}
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
