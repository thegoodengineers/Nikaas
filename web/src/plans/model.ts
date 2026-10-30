// Building editing helpers: floors, ids, edge defaults, merging per-floor plans into one building.
import type { Building, BuildingEdge, BuildingNode } from '../platform/api.ts'
import type { WallGrid } from '../platform/walls.ts'

export type FloorDef = { id: string; name: string; elevation_m: number }
/** A plan image drawn under one floor, placed in building metres (top-left corner, width, height). */
export type Underlay = { src: string; x: number; z: number; w: number; h: number }
/** Everything the editor can undo: the building, where each floor's plan image sits and the walls traced from it. */
export type Doc = { building: Building; underlays: Record<string, Underlay>; walls?: Record<string, WallGrid> }
/** Where the building came from, so Save knows whether to update it or make a copy. */
export type Origin = { id?: string; demo?: boolean; name: string; address: string; geo: unknown; assembly: unknown[] }

export const SINGLE = '_' // floor key for a building without floors
export const STAIR_LENGTH = 6.5
export const WIDTH = { door: 1.2, corridor: 2.0, stair: 1.2 } as const

export const floorName = (i: number) => (i === 0 ? 'Ground Floor' : `Floor ${i}`)
export const floorId = (i: number) => (i === 0 ? 'GF' : `F${i}`)
export const round1 = (v: number) => Math.round(v * 10) / 10
export const round2 = (v: number) => Math.round(v * 100) / 100

export const floorsOf = (b: Building): FloorDef[] => [...(b.floors ?? [])].map(f => ({ ...f, elevation_m: f.elevation_m ?? 0 }))
export const keyOf = (b: Building, n: BuildingNode) => (b.floors?.length ? n.floor_id ?? SINGLE : SINGLE)
/** Nodes drawn on a floor tab. Nodes without a floor show on every floor. */
export const onFloor = (b: Building, n: BuildingNode, floor: string) => !b.floors?.length || !n.floor_id || n.floor_id === floor

/** A stair landing, the way the server's link_floors sees it: marked stair, or "stair" in its id or label. */
export function isStair(n: BuildingNode) {
  if (n.type !== 'corridor') return false
  return n.stair === true || `${n.id} ${n.label ?? ''}`.toLowerCase().includes('stair')
}

export function edgeKind(b: Building, e: BuildingEdge): 'door' | 'corridor' | 'stair' {
  if (e.kind) return e.kind
  const by = nodeMap(b)
  return by[e.from]?.type === 'room' || by[e.to]?.type === 'room' ? 'door' : 'corridor'
}

export const nodeMap = (b: Building) => Object.fromEntries(b.nodes.map(n => [n.id, n])) as Record<string, BuildingNode>

/** The kind and width a new connection between two nodes gets. */
export function defaultEdge(a: BuildingNode, c: BuildingNode): { kind: 'door' | 'corridor' | 'stair'; width: number } {
  if ((a.floor_id ?? null) !== (c.floor_id ?? null)) return { kind: 'stair', width: WIDTH.stair }
  if (a.type === 'room' || c.type === 'room') return { kind: 'door', width: WIDTH.door }
  return { kind: 'corridor', width: WIDTH.corridor }
}

/** A fresh node id like GF_room_3 that is not taken yet. */
export function newId(b: Building, floor: string, stem: string) {
  const have = new Set(b.nodes.map(n => n.id))
  const pre = floor === SINGLE ? '' : `${floor}_`
  let k = 1
  while (have.has(`${pre}${stem}_${k}`)) k++
  return `${pre}${stem}_${k}`
}

export function newGroup(b: Building) {
  const have = new Set(b.edges.map(e => e.capacity_group).filter(Boolean))
  let k = 1
  while (have.has(`stair_${k}`)) k++
  return `stair_${k}`
}

export const clone = <T,>(v: T): T => structuredClone(v)

/** Bounding box of a set of nodes and rectangles, in metres. */
export function bounds(nodes: BuildingNode[], extra: { x: number; z: number; w: number; h: number }[] = []) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
  for (const n of nodes) {
    const hw = (n.type === 'room' ? n.w ?? 0 : 0) / 2, hd = (n.type === 'room' ? n.d ?? 0 : 0) / 2
    x0 = Math.min(x0, n.x - hw); x1 = Math.max(x1, n.x + hw); z0 = Math.min(z0, n.z - hd); z1 = Math.max(z1, n.z + hd)
  }
  for (const r of extra) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.w); z0 = Math.min(z0, r.z); z1 = Math.max(z1, r.z + r.h) }
  if (!isFinite(x0)) return { x0: 0, z0: 0, x1: 40, z1: 30 }
  if (x1 - x0 < 4) { x0 -= 2; x1 += 2 }
  if (z1 - z0 < 4) { z0 -= 2; z1 += 2 }
  return { x0, z0, x1, z1 }
}

export type VisionFloor = { floor: FloorDef; building: Building | null }

/** Join per-floor plans into one building: node ids get the floor id in front (GF_p1), nodes get floor_id. */
export function mergeFloors(name: string, parts: VisionFloor[]): Building {
  const nodes: BuildingNode[] = [], edges: BuildingEdge[] = []
  for (const { floor, building } of parts) {
    if (!building) continue
    const pre = `${floor.id}_`
    const id = (s: string) => (s.startsWith(pre) ? s : pre + s)
    for (const n of building.nodes) nodes.push({ ...n, id: id(n.id), floor_id: floor.id })
    for (const e of building.edges) {
      const c: BuildingEdge & { inferred?: boolean; source?: string } = { ...e, from: id(e.from), to: id(e.to) }
      delete c.inferred; delete c.source
      edges.push(c)
    }
  }
  return { name, units: 'm', floors: parts.map(p => ({ id: p.floor.id, name: p.floor.name, elevation_m: p.floor.elevation_m })), nodes, edges }
}

/** Remove editor-only and stale fields before a building goes to the server. */
export function cleanBuilding(b: Building): Building {
  const out = clone(b)
  delete out.vision
  if (!out.floors?.length) delete out.floors
  return out
}

/** Ids of nodes mentioned in a message (validator text, QA warnings). */
export function idsIn(text: string, ids: Set<string>): string[] {
  const found: string[] = []
  for (const tok of text.split(/[^\w.-]+/)) {
    if (!tok) continue
    if (ids.has(tok)) { if (!found.includes(tok)) found.push(tok); continue }
    for (const part of tok.split('-')) if (ids.has(part) && !found.includes(part)) found.push(part)
  }
  return found
}

export const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

/** Copy with the patch applied; undefined values remove the key. */
export function patched<T extends object>(o: T, patch: Record<string, unknown>): T {
  const out = { ...o } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete out[k]; else out[k] = v }
  return out as T
}
export const patchNode = (b: Building, id: string, patch: Record<string, unknown>): Building => ({ ...b, nodes: b.nodes.map(n => (n.id === id ? patched(n, patch) : n)) })
export const patchEdge = (b: Building, i: number, patch: Record<string, unknown>): Building => ({ ...b, edges: b.edges.map((e, k) => (k === i ? patched(e, patch) : e)) })
