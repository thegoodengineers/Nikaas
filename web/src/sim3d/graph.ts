// Any building in the project's graph format (docs/CONTRACT.md, multi-floor fields in docs/MULTI_FLOOR_DESIGN.md)
// turned into a Plan: rooms become boxes with a door facing whatever they connect to, corridors become strips
// along their edges, exits get an assembly point outside, and every stairwell gets a switchback shaft placed
// beside its landings. Walls are derived from the walkable shapes so the walls and the walking area agree.
// When the site carries a floor's plan picture and the walls traced from it (media, docs/PLATFORM.md), those walls
// replace the derived ones there: doors are cut where the graph crosses them and nobody walks through them.
// No DOM and no three.js: the crowd model can be tested headless on these plans.
import { R, WALL_T, SLAB, rect, inset, inRect, type Rect, type NavNode, type NavEdge, type Nav } from './layout.ts'
import { Walk, rectBox, segBox, type Box } from './walk.ts'
import { rectPoly, type Plan, type PlanRoom, type PlanExit, type PlanStair, type V3 } from './plan.ts'
import type { Seat } from './build.ts'
import { prepareTraced, pictureOnly, finishTraced, cutStraight, dilate, wallArea, inFoot, type Traced, type Seg } from './traced.ts'
import type { PlanImage } from '../platform/walls.ts'

export type GNode = { id: string; type?: string; x: number; z: number; w?: number; d?: number; people?: number; label?: string; floor_id?: string | null }
export type GEdge = { from: string; to: string; width?: number; length?: number; kind?: string; capacity_group?: string | null }
export type GFloor = { id: string; name?: string; elevation_m?: number }
export type Building = { name?: string; description?: string; floors?: GFloor[] | null; nodes: GNode[]; edges: GEdge[] }
export type SiteDoc = {
  id?: string; name?: string; address?: string; building: Building
  assembly?: { id?: string; label?: string; x?: number | null; z?: number | null; exits?: string[] }[] | null
  /** per floor id ("_" for a single-floor building): the plan picture and the walls traced from it */
  media?: Record<string, { plan?: PlanImage | null; walls?: unknown } | null> | null
}

export type GStrip = { level: number; ax: number; az: number; bx: number; bz: number; w: number; kind: 'corr' | 'door' | 'exit' | 'access'; openA: boolean; openB: boolean }
export type GDoor = { level: number; x: number; z: number; nx: number; nz: number; w: number; room: string }
export type GShaft = {
  id: string; label: string; lo: number; hi: number; pairs: [number, number][]
  px: number; pz: number; ux: number; uz: number   // door edge centre and the direction into the shaft
  wf: number; ld: number; run: number; md: number; width: number; len: number; steps: number
}
export type GExit = { id: string; level: number; x: number; z: number; nx: number; nz: number; w: number; asm: string }
export type GRoom = PlanRoom & { fx: number; fz: number; kind: string }
export type WallPiece = { ax: number; az: number; bx: number; bz: number; t: number; src: 'room' | 'shaft' | 'strip' }
export type GraphGeo = {
  levels: number; fh: number; wallH: number
  rooms: GRoom[]; strips: GStrip[]; doors: GDoor[]; shafts: GShaft[]; exits: GExit[]; seats: Seat[]
  bounds: Rect; site: Rect; centre: [number, number]
  asms: { id: string; label: string; x: number; z: number }[]
  walls: (level: number) => { walls: WallPiece[]; gaps: WallPiece[] }
  /** per storey: walls traced from its plan picture and/or the picture itself, or null */
  traced: (Traced | null)[]
  /** the storey's traced walls already cover this point (so no derived wall, floor or door is drawn there) */
  covered: (level: number, x: number, z: number) => boolean
}

const MAX_FIGURES = 1200
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const pretty = (s: string) => {
  const t = s.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^(r|rm)\s+(?=\w)/i, 'Room ').replace(/^corr\s+/i, 'Corridor ')
  return t ? t[0].toUpperCase() + t.slice(1) : s
}
const area = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0))
const grow = (a: Rect, x0: number, z0: number, x1: number, z1: number) => { a.x0 = Math.min(a.x0, x0); a.z0 = Math.min(a.z0, z0); a.x1 = Math.max(a.x1, x1); a.z1 = Math.max(a.z1, z1) }
function lcg(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }

const KINDS: [RegExp, string][] = [
  [/lab|computer|workshop/i, 'lab'], [/hall|seminar|auditor|audio|lecture|theat|taramandal|planetar/i, 'hall'],
  [/office|admin|staff|faculty|meeting/i, 'office'], [/recep|lobby|foyer|entrance/i, 'lobby'], [/wash|toilet|\bwc\b|rest ?room/i, 'wash'],
  [/cafe|canteen|pantry|kitchen|dining/i, 'cafe'], [/librar|study|reading/i, 'library'], [/store|storage|server|plant|service|guest/i, 'store'],
]

/** Corner points of a strip, reaching `ea` / `eb` past its ends. */
export function stripPoly(s: GStrip, ea: number, eb: number): [number, number][] {
  const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1, ux = (s.bx - s.ax) / len, uz = (s.bz - s.az) / len, h = s.w / 2
  const ax = s.ax - ux * ea, az = s.az - uz * ea, bx = s.bx + ux * eb, bz = s.bz + uz * eb
  return [[ax - uz * h, az + ux * h], [bx - uz * h, bz + ux * h], [bx + uz * h, bz - ux * h], [ax + uz * h, az - ux * h]]
}
export const shaftPoint = (s: GShaft, along: number, across: number): [number, number] => [s.px + s.ux * along - s.uz * across, s.pz + s.uz * along + s.ux * across]
export function shaftRect(s: Pick<GShaft, 'px' | 'pz' | 'ux' | 'uz' | 'len' | 'width'>): Rect {
  const a = shaftPoint(s as GShaft, 0, -s.width / 2), b = shaftPoint(s as GShaft, s.len, s.width / 2)
  return rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]))
}

/** Part of the segment strictly inside a convex polygon, as a [t0, t1] range of the segment, or null. */
function clipInside(ax: number, az: number, bx: number, bz: number, pts: [number, number][], eps: number): [number, number] | null {
  let ar = 0
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; ar += p[0] * q[1] - q[0] * p[1] }
  const sg = ar > 0 ? 1 : -1, dx = bx - ax, dz = bz - az
  let t0 = 0, t1 = 1
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length]
    let nx = -(q[1] - p[1]) * sg, nz = (q[0] - p[0]) * sg
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l
    const f = (ax - p[0]) * nx + (az - p[1]) * nz - eps, den = dx * nx + dz * nz
    if (Math.abs(den) < 1e-12) { if (f < 0) return null; continue }
    const t = -f / den
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t)
    if (t0 >= t1) return null
  }
  return [t0, t1]
}

export function graphPlan(doc: Building | SiteDoc, key = 'graph'): Plan {
  const site = doc && typeof doc === 'object' && 'building' in doc && doc.building ? doc as SiteDoc : null
  const B = (site ? site.building : doc) as Building
  if (!B || !Array.isArray(B.nodes) || !Array.isArray(B.edges)) throw new Error('This file is not a building graph: it needs "nodes" and "edges".')

  // ---------- floors ----------
  const fl = (Array.isArray(B.floors) ? B.floors : []).filter(f => f && typeof f.id === 'string')
  const floors = fl.length
    ? fl.map((f, i) => ({ id: f.id, name: f.name || f.id, elev: num(f.elevation_m, i * 3.5) })).sort((a, b) => a.elev - b.elev)
    : [{ id: '', name: 'Ground floor', elev: 0 }]
  const levelOf = new Map(floors.map((f, i) => [f.id, i]))
  const LV = floors.length
  const diffs = floors.slice(1).map((f, i) => f.elev - floors[i].elev).filter(d => d > 0.5).sort((a, b) => a - b)
  const fh = clamp(diffs.length ? diffs[Math.floor(diffs.length / 2)] : 3.5, 2.8, 6)
  const wallH = fh - SLAB

  // ---------- walking graph helpers ----------
  const nn: NavNode[] = [], ne: NavEdge[] = [], ew: number[] = [], seen = new Set<string>()
  const add = (n: Omit<NavNode, 'i'>) => { nn.push({ ...n, i: nn.length }); return nn.length - 1 }
  const link = (a: number, b: number, rail = false, w = 1) => {
    if (a === b || a < 0 || b < 0) return
    const k = a < b ? `${a}:${b}` : `${b}:${a}`
    if (seen.has(k)) return
    seen.add(k)
    const A = nn[a], C = nn[b]
    // never zero: people follow the steepest descent of distance-to-exit, so a zero edge would make them ping-pong
    ne.push({ a, b, len: Math.max(0.1, Math.hypot(A.x - C.x, A.z - C.z) + Math.abs(A.level - C.level) * 2.5), rail })
    ew.push(w)
  }
  const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]) }

  // ---------- nodes ----------
  type N = GNode & { type: string; level: number; nav: number }
  const nodes = new Map<string, N>()
  for (const n of B.nodes) {
    if (!n || typeof n.id !== 'string' || !Number.isFinite(n.x) || !Number.isFinite(n.z) || nodes.has(n.id)) continue
    nodes.set(n.id, { ...n, type: typeof n.type === 'string' ? n.type : 'corridor', level: levelOf.get(n.floor_id ?? '') ?? 0, nav: -1 })
  }
  const rooms: GRoom[] = [], roomOf = new Map<string, GRoom>()
  for (const n of nodes.values()) {
    if (n.type === 'room') {
      const w = clamp(num(n.w, 4), 1.2, 400), d = clamp(num(n.d, 4), 1.2, 400), label = String(n.label || pretty(n.id))
      const r: GRoom = { id: n.id, level: n.level, label, people: Math.max(0, Math.round(num(n.people, 0))), r: rect(n.x - w / 2, n.z - d / 2, n.x + w / 2, n.z + d / 2), fx: 0, fz: 1, kind: KINDS.find(k => k[0].test(`${label} ${n.id}`))?.[1] ?? 'class' }
      rooms.push(r); roomOf.set(n.id, r)
    } else n.nav = add({ level: n.level, x: n.x, z: n.z, kind: n.type === 'exit' ? 'exit' : 'corr', ...(n.type === 'exit' ? { exit: n.id } : {}) })
  }
  if (!rooms.length) throw new Error('This building has no rooms.')
  // very large venues: one figure stands for several people so the view stays smooth
  const total = rooms.reduce((s, r) => s + r.people, 0), per = total > MAX_FIGURES ? Math.ceil(total / MAX_FIGURES) : 1
  if (per > 1) for (const r of rooms) if (r.people) r.people = Math.max(1, Math.round(r.people / per))
  if (![...nodes.values()].some(n => n.type === 'exit')) throw new Error('This building has no exits.')

  // ---------- rooms, doors and corridor strips ----------
  const strips: GStrip[] = [], doors: GDoor[] = [], extra: { level: number; b: Box }[] = []
  const inners = new Map<string, number[]>(), doorAt = new Map<string, { inner: number; door: number }>()
  const exitW = new Map<string, number>()
  const elbows: number[] = [], corrEdges: { level: number; a: number; b: number; w: number }[] = []
  const strip =(level: number, ax: number, az: number, bx: number, bz: number, w: number, kind: GStrip['kind'], openA = false, openB = false) => {
    if (Math.hypot(bx - ax, bz - az) > 0.05) strips.push({ level, ax, az, bx, bz, w, kind, openA, openB })
  }

  type DoorRef = { inner: number; door: number; x: number; z: number; nx: number; nz: number }
  function roomDoor(room: GRoom, tx: number, tz: number, dw: number): DoorRef {
    const r = room.r, dx = tx - clamp(tx, r.x0, r.x1), dz = tz - clamp(tz, r.z0, r.z1)
    let x: number, z: number, nx = 0, nz = 0
    if (Math.abs(dx) >= Math.abs(dz)) {
      nx = dx >= 0 ? 1 : -1; x = nx > 0 ? r.x1 : r.x0
      const m = Math.min(dw / 2 + 0.3, (r.z1 - r.z0) / 2); z = clamp(tz, r.z0 + m, r.z1 - m)
    } else {
      nz = dz >= 0 ? 1 : -1; z = nz > 0 ? r.z1 : r.z0
      const m = Math.min(dw / 2 + 0.3, (r.x1 - r.x0) / 2); x = clamp(tx, r.x0 + m, r.x1 - m)
    }
    const k = `${room.id}:${x.toFixed(1)}:${z.toFixed(1)}`
    let d = doorAt.get(k)
    if (!d) {
      const depth = Math.max(0.2, Math.min(0.9, (nx ? r.x1 - r.x0 : r.z1 - r.z0) / 2 - 0.1))
      const inner = add({ level: room.level, x: x - nx * depth, z: z - nz * depth, kind: 'inner', room: room.id, axis: nx ? 'x' : 'z' })
      const door = add({ level: room.level, x, z, kind: 'door', room: room.id })
      link(inner, door, false, dw)
      d = { inner, door }; doorAt.set(k, d); push(inners, room.id, inner)
      doors.push({ level: room.level, x, z, nx, nz, w: dw, room: room.id })
    }
    return { ...d, x, z, nx, nz }
  }
  /** From a door, out at right angles to the wall, then along to the target (an L, like a real corridor). */
  function routeOut(level: number, d: DoorRef, tx: number, tz: number, tn: number, dw: number, open: boolean) {
    const vx = tx - d.x, vz = tz - d.z, along = vx * d.nx + vz * d.nz, side = -vx * d.nz + vz * d.nx
    const sx = d.x - d.nx * 0.35, sz = d.z - d.nz * 0.35 // starts just inside so it cuts the wall
    if (along > 0.6 && Math.abs(side) > 0.35) {
      const ex = d.x + d.nx * along, ez = d.z + d.nz * along
      const el = add({ level, x: ex, z: ez, kind: 'corr' })
      link(d.door, el, false, dw); link(el, tn, false, dw); elbows.push(el)
      strip(level, sx, sz, ex, ez, dw, 'door'); strip(level, ex, ez, tx, tz, dw, open ? 'exit' : 'door', false, open)
    } else { link(d.door, tn, false, dw); strip(level, sx, sz, tx, tz, dw, open ? 'exit' : 'door', false, open) }
  }
  function roomTo(room: GRoom, t: N, w: number) {
    const dw = clamp(w, 0.9, 2.4)
    if (inRect(inset(room.r, -0.3), t.x, t.z)) { // the node sits inside the room: no door, walk straight to it
      const q = inset(room.r, Math.min(0.6, (room.r.x1 - room.r.x0) / 2 - 0.05, (room.r.z1 - room.r.z0) / 2 - 0.05))
      const inner = add({ level: room.level, x: clamp(t.x, q.x0, q.x1), z: clamp(t.z, q.z0, q.z1), kind: 'inner', room: room.id, axis: 'z' })
      push(inners, room.id, inner); link(inner, t.nav, false, 1.2)
      extra.push({ level: room.level, b: rectBox(t.x - 0.6, t.z - 0.6, t.x + 0.6, t.z + 0.6) })
      return
    }
    routeOut(room.level, roomDoor(room, t.x, t.z, dw), t.x, t.z, t.nav, dw, t.type === 'exit')
  }
  function roomRoom(A: GRoom, C: GRoom, w: number) {
    const dw = clamp(w, 0.9, 2.4), a = inset(A.r, -0.35), b = inset(C.r, -0.35)
    const ox0 = Math.max(a.x0, b.x0), ox1 = Math.min(a.x1, b.x1), oz0 = Math.max(a.z0, b.z0), oz1 = Math.min(a.z1, b.z1)
    const ca = [(A.r.x0 + A.r.x1) / 2, (A.r.z0 + A.r.z1) / 2], cc = [(C.r.x0 + C.r.x1) / 2, (C.r.z0 + C.r.z1) / 2]
    if (ox1 > ox0 && oz1 > oz0) { // touching rooms: a door in the shared wall
      const thinX = ox1 - ox0 < oz1 - oz0
      const nx = thinX ? Math.sign(cc[0] - ca[0]) || 1 : 0, nz = thinX ? 0 : Math.sign(cc[1] - ca[1]) || 1
      const m = dw / 2 + 0.2
      const x = thinX ? (ox0 + ox1) / 2 : clamp((ox0 + ox1) / 2, Math.max(A.r.x0, C.r.x0) + m, Math.min(A.r.x1, C.r.x1) - m)
      const z = thinX ? clamp((oz0 + oz1) / 2, Math.max(A.r.z0, C.r.z0) + m, Math.min(A.r.z1, C.r.z1) - m) : (oz0 + oz1) / 2
      const qa = inset(A.r, 0.4), qc = inset(C.r, 0.4)
      const iA = add({ level: A.level, x: clamp(x - nx * 0.9, qa.x0, qa.x1), z: clamp(z - nz * 0.9, qa.z0, qa.z1), kind: 'inner', room: A.id, axis: nx ? 'x' : 'z' })
      const iC = add({ level: A.level, x: clamp(x + nx * 0.9, qc.x0, qc.x1), z: clamp(z + nz * 0.9, qc.z0, qc.z1), kind: 'inner', room: C.id, axis: nx ? 'x' : 'z' })
      const dn = add({ level: A.level, x, z, kind: 'door', room: A.id })
      link(iA, dn, false, dw); link(dn, iC, false, dw); push(inners, A.id, iA); push(inners, C.id, iC)
      strip(A.level, nn[iA].x, nn[iA].z, nn[iC].x, nn[iC].z, dw, 'door')
      doors.push({ level: A.level, x, z, nx, nz, w: dw, room: A.id })
      return
    }
    const dC = roomDoor(C, ca[0], ca[1], dw)
    routeOut(A.level, roomDoor(A, dC.x, dC.z, dw), dC.x, dC.z, dC.door, dw, false)
  }

  const stairEdges: { a: N; b: N; w: number; group: string }[] = []
  for (const e of B.edges) {
    const a = nodes.get(e?.from), b = nodes.get(e?.to)
    if (!a || !b || a === b) continue
    const w = clamp(num(e.width, 1.2), 0.8, 6)
    if (a.type === 'exit') exitW.set(a.id, Math.max(exitW.get(a.id) ?? 0, w))
    if (b.type === 'exit') exitW.set(b.id, Math.max(exitW.get(b.id) ?? 0, w))
    if (a.level !== b.level) {
      if (a.type !== 'room' && b.type !== 'room') stairEdges.push({ a, b, w, group: typeof e.capacity_group === 'string' ? e.capacity_group : '' })
      continue
    }
    const ra = roomOf.get(a.id), rb = roomOf.get(b.id)
    if (ra && rb) roomRoom(ra, rb, w)
    else if (ra) roomTo(ra, b, w)
    else if (rb) roomTo(rb, a, w)
    else {
      const [p, q] = a.type === 'exit' && b.type !== 'exit' ? [b, a] : [a, b] // exits at the open end
      strip(a.level, p.x, p.z, q.x, q.z, clamp(w, 1.0, 6), q.type === 'exit' ? 'exit' : 'corr', p.type === 'exit', q.type === 'exit')
      link(p.nav, q.nav, false, clamp(w, 1.0, 6)); corrEdges.push({ level: a.level, a: p.nav, b: q.nav, w: clamp(w, 1.0, 6) })
    }
  }
  // an elbow that lands on a corridor joins it both ways (no walking past the junction and back)
  const joinElbows = () => { for (const el of elbows) {
    const E = nn[el]
    for (const c of corrEdges) {
      if (c.level !== E.level) continue
      const A = nn[c.a], C = nn[c.b], dx = C.x - A.x, dz = C.z - A.z, L2 = dx * dx + dz * dz
      if (L2 < 1e-6) continue
      const t = ((E.x - A.x) * dx + (E.z - A.z) * dz) / L2
      if (t > 0.02 && t < 0.98 && Math.hypot(A.x + dx * t - E.x, A.z + dz * t - E.z) < c.w / 2) { link(el, c.a, false, c.w); link(el, c.b, false, c.w) }
    }
  } }
  // rooms nobody linked: give them a door to the nearest corridor on their floor
  for (const r of rooms) {
    if (inners.has(r.id)) continue
    const cx = (r.r.x0 + r.r.x1) / 2, cz = (r.r.z0 + r.r.z1) / 2
    let best: N | null = null, bd = Infinity
    for (const n of nodes.values()) if (n.type !== 'room' && n.level === r.level) { const d = Math.hypot(n.x - cx, n.z - cz); if (d < bd) { bd = d; best = n } }
    if (best) roomTo(r, best, 1.0)
  }

  // ---------- traced walls and plan pictures (site media) ----------
  const traced: (Traced | null)[] = [...Array(LV)].map(() => null)
  for (const [key, m] of Object.entries(site?.media && typeof site.media === 'object' ? site.media : {})) {
    const L = key === '_' ? (LV === 1 ? 0 : levelOf.get('_')) : levelOf.get(key)
    if (L === undefined || !m || typeof m !== 'object') continue
    const p = m.plan
    const plan = p && typeof p.url === 'string' && p.url && [p.x, p.z, p.w, p.h].every(v => typeof v === 'number' && Number.isFinite(v)) && p.w > 0 && p.h > 0
      ? { url: p.url, x: p.x, z: p.z, w: p.w, h: p.h } : null
    const seeds: [number, number][] = []
    for (const r of rooms) if (r.level === L) seeds.push([(r.r.x0 + r.r.x1) / 2, (r.r.z0 + r.r.z1) / 2])
    for (const n of nn) if (n.level === L && n.kind !== 'exit') seeds.push([n.x, n.z])
    for (const s of strips) if (s.level === L) seeds.push([(s.ax + s.bx) / 2, (s.az + s.bz) / 2])
    try {
      traced[L] = (m.walls ? prepareTraced(m.walls, plan, seeds) : null)
        ?? (plan ? pictureOnly(plan, rooms.filter(r => r.level === L).map(r => r.r), strips.filter(s => s.level === L).map(s => stripPoly(s, s.openA ? 0 : s.w / 2, s.openB ? 0 : s.w / 2))) : null)
    } catch { traced[L] = null } // a broken grid never stops the building from loading
    if (traced[L] && !traced[L]!.plan && plan) traced[L]!.plan = plan
  }
  const tw = (L: number) => (traced[L]?.hasWalls ? traced[L] : null)

  // ---------- stairwells ----------
  const shafts: GShaft[] = [], stairs: PlanStair[] = []
  const groups = new Map<string, typeof stairEdges>()
  for (const s of stairEdges) {
    const lo = s.a.level < s.b.level ? s.a : s.b
    push(groups, s.group ? `g:${s.group}` : `p:${Math.round(lo.x)}:${Math.round(lo.z)}`, s)
  }
  const exitNodes = [...nodes.values()].filter(n => n.type === 'exit')
  const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [gk, list] of groups) {
    const byLevel = new Map<number, N[]>()
    for (const s of list) for (const n of [s.a, s.b]) { const l = byLevel.get(n.level) ?? []; if (!l.includes(n)) l.push(n); byLevel.set(n.level, l) }
    const lvls = [...byLevel.keys()].sort((p, q) => p - q), lo = lvls[0], hi = lvls[lvls.length - 1]
    const anchor = byLevel.get(lo)![0]
    const wf = clamp(Math.max(...list.map(s => s.w)), 1.0, 1.8)
    const steps = Math.max(6, Math.ceil(fh / 2 / 0.175)), run = steps * 0.28
    const ld = Math.max(1.6, wf + 0.3), md = Math.max(1.3, wf), width = 2 * wf + 0.3, len = ld + run + md
    // place the shaft where it overlaps the fewest rooms, corridors and other shafts, close to its landing
    const near = (r: Rect) => Math.abs((r.x0 + r.x1) / 2 - anchor.x) < 30 && Math.abs((r.z0 + r.z1) / 2 - anchor.z) < 30
    const roomsNear = rooms.filter(r => r.level >= lo && r.level <= hi && near(r.r)).map(r => r.r)
    const sq: Rect[] = []
    for (const s of strips) if (s.level >= lo && s.level <= hi) {
      const L = Math.hypot(s.bx - s.ax, s.bz - s.az), h = s.w / 2, n = Math.max(1, Math.ceil(L / h))
      for (let k = 0; k <= n; k++) { const x = s.ax + ((s.bx - s.ax) * k) / n, z = s.az + ((s.bz - s.az) * k) / n; const q = rect(x - h, z - h, x + h, z + h); if (near(q)) sq.push(q) }
    }
    for (const e of exitNodes) if (e.level >= lo && e.level <= hi) sq.push(rect(e.x - 2, e.z - 2, e.x + 2, e.z + 2))
    const placed = shafts.filter(s => s.lo <= hi && s.hi >= lo).map(s => shaftRect(s))
    let best = { s: Infinity, px: anchor.x, pz: anchor.z, ux: 1, uz: 0 }
    for (const [ux, uz] of DIRS) for (let i = -18; i <= 18; i++) for (let j = -18; j <= 18; j++) {
      const px = anchor.x + i * 0.5, pz = anchor.z + j * 0.5
      const back = (anchor.x - px) * ux + (anchor.z - pz) * uz // < 0: the landing node is in front of the door
      let s = Math.hypot(i, j) * 0.3 + (back > -0.4 ? 40 : 0)
      if (s >= best.s) continue
      const r = shaftRect({ px, pz, ux, uz, len, width }), g = inset(r, -0.3)
      for (const q of placed) s += area(g, q) * 100
      for (const q of roomsNear) s += area(g, q) * 10
      for (const q of sq) s += area(r, q) * 8
      for (let L = lo; L <= hi; L++) { const t = tw(L); if (t) s += wallArea(t, g) * 30 } // keep off drawn walls
      if (s >= best.s) continue
      const ex = px + ux * back, ez = pz + uz * back // the access walk: out along the door's line, then in
      for (let k = 1; k <= 8; k++) {
        const t = k / 8, x1 = anchor.x + (ex - anchor.x) * t, z1 = anchor.z + (ez - anchor.z) * t, x2 = ex + (px - ex) * t, z2 = ez + (pz - ez) * t
        for (const q of roomsNear) { if (inRect(inset(q, 0.2), x1, z1)) s += 1.5; if (inRect(inset(q, 0.2), x2, z2)) s += 1.5 }
      }
      if (s < best.s) best = { s, px, pz, ux, uz }
    }
    const id = `S${shafts.length + 1}`
    const named = gk.startsWith('g:') ? pretty(gk.slice(2)) : ''
    const sh: GShaft = { id, label: named && !/^\d+$/.test(named) ? named : `Stair ${shafts.length + 1}`, lo, hi, pairs: [], px: best.px, pz: best.pz, ux: best.ux, uz: best.uz, wf, ld, run, md, width, len, steps }
    shafts.push(sh)
    const P = (s: number, q: number) => shaftPoint(sh, s, q)
    const landing = new Map<number, number>(), aw = Math.max(1.2, wf)
    for (const L of lvls) {
      const [lx, lz] = P(ld / 2, 0)
      const land = add({ level: L, x: lx, z: lz, kind: 'landing', stair: id })
      const door = add({ level: L, x: sh.px, z: sh.pz, kind: 'door', stair: id })
      link(door, land, false, wf); landing.set(L, land)
      const [ix, iz] = P(0.35, 0)
      for (const a of byLevel.get(L)!) {
        const back = (a.x - sh.px) * sh.ux + (a.z - sh.pz) * sh.uz, side = -(a.x - sh.px) * sh.uz + (a.z - sh.pz) * sh.ux
        if (Math.abs(side) > 0.4 && back < -0.4) {
          const ex = sh.px + sh.ux * back, ez = sh.pz + sh.uz * back
          const el = add({ level: L, x: ex, z: ez, kind: 'corr' })
          link(a.nav, el, false, aw); link(el, door, false, aw); elbows.push(el)
          strip(L, a.x, a.z, ex, ez, aw, 'access'); strip(L, ex, ez, ix, iz, aw, 'access')
        } else { link(a.nav, door, false, aw); strip(L, a.x, a.z, ix, iz, aw, 'access') }
      }
    }
    const pairSeen = new Set<string>()
    for (const s of list) {
      const [p, q] = s.a.level < s.b.level ? [s.a, s.b] : [s.b, s.a], L = p.level, k = q.level - p.level
      if (pairSeen.has(`${L}:${q.level}`)) continue
      pairSeen.add(`${L}:${q.level}`); sh.pairs.push([L, q.level])
      const q1 = wf / 2 + 0.08, sm = ld + run + md / 2
      const lv = [L, L + k / 2, L + k / 2, L + k / 2, L + k / 2, L + k]
      const pts: [number, number][] = [[ld, q1], [ld + run, q1], [sm, q1], [sm, -q1], [ld + run, -q1], [ld, -q1]]
      const ids = pts.map(([a, b], i) => { const [x, z] = P(a, b); return add({ level: lv[i], x, z, kind: 'stair', stair: id, rail: i > 0 && i < 5 }) })
      link(landing.get(L)!, ids[0], false, wf)
      for (let i = 1; i < ids.length; i++) link(ids[i - 1], ids[i], true)
      link(ids[5], landing.get(q.level)!, false, wf)
    }
    const zr = shaftRect(sh), axis: 'x' | 'z' = sh.ux ? 'x' : 'z', [bx, bz] = P(ld, 0)
    stairs.push({
      id, label: sh.label, flow: Math.max(0.6, wf * 0.8),
      zones: [...Array(hi - lo + 1).keys()].map(k => ({ level: lo + k, r: zr })),
      barriers: lvls.map(level => ({ level, at: [bx, bz] as [number, number], axis, width: width - 0.1, side: -(sh.ux || sh.uz) })),
    })
  }

  joinElbows()

  // traced walls: cut a door wherever a link of the walking graph has to cross one, clear the stair shafts
  const ways: { level: number; e: NavEdge; w: number; pts: [number, number][] }[] = []
  for (let L = 0; L < LV; L++) {
    const t = tw(L)
    if (!t) continue
    const segs: Seg[] = [], es: NavEdge[] = []
    ne.forEach((e, k) => {
      const A = nn[e.a], C = nn[e.b]
      if (!e.rail && A.level === L && C.level === L) { segs.push({ ax: A.x, az: A.z, bx: C.x, bz: C.z, w: ew[k] }); es.push(e) }
    })
    const clear = shafts.filter(s => L >= s.lo && L <= s.hi).map(s => inset(shaftRect(s), -0.15))
    try {
      finishTraced(t, segs, clear, R + 0.05).forEach((pts, i) => { if (pts && pts.length > 2) ways.push({ level: L, e: es[i], w: segs[i].w, pts }) })
    } catch { traced[L] = null }
  }

  // ---------- footprint ----------
  const bounds = rect(Infinity, Infinity, -Infinity, -Infinity)
  for (const r of rooms) grow(bounds, r.r.x0, r.r.z0, r.r.x1, r.r.z1)
  for (const s of strips) for (const [x, z] of stripPoly(s, 0, 0)) grow(bounds, x, z, x, z)
  for (const s of shafts) { const q = shaftRect(s); grow(bounds, q.x0, q.z0, q.x1, q.z1) }
  const gb = { ...bounds } // a traced outline may add a veranda or a wing, never a whole stray picture
  for (const t of traced) if (t?.hasWalls && t.ext) grow(bounds, Math.max(t.ext.x0, gb.x0 - 15), Math.max(t.ext.z0, gb.z0 - 15), Math.min(t.ext.x1, gb.x1 + 15), Math.min(t.ext.z1, gb.z1 + 15))
  const centre: [number, number] = [(bounds.x0 + bounds.x1) / 2, (bounds.z0 + bounds.z1) / 2]

  // ---------- exits and assembly points ----------
  const adjOf = (i: number) => ne.filter(e => e.a === i || e.b === i).map(e => (e.a === i ? e.b : e.a))
  const exits: PlanExit[] = [], gexits: GExit[] = [], asms: GraphGeo['asms'] = []
  const given = (site?.assembly ?? []).filter(a => a && Number.isFinite(a.x) && Number.isFinite(a.z))
  for (const n of exitNodes) {
    const nb = adjOf(n.nav)
    if (!nb.length) continue
    let nx = n.x - nn[nb[0]].x, nz = n.z - nn[nb[0]].z, l = Math.hypot(nx, nz)
    if (l < 0.1) { nx = n.x - centre[0]; nz = n.z - centre[1]; l = Math.hypot(nx, nz) }
    if (l < 0.1) { nx = 0; nz = 1; l = 1 }
    nx /= l; nz /= l
    const w = clamp(exitW.get(n.id) ?? 1.6, 0.9, 6)
    const label = String(n.label || pretty(n.id))
    let asm = given.find(a => Array.isArray(a.exits) && a.exits.includes(n.id))
    if (!asm && given.length === 1) asm = given[0]
    let A: GraphGeo['asms'][number]
    if (asm) {
      const aid = String(asm.id ?? `A${asms.length + 1}`)
      A = asms.find(a => a.id === aid) ?? { id: aid, label: String(asm.label || `Assembly ${asms.length + 1} · Outside ${label}`), x: asm.x!, z: asm.z! }
    } else {
      let vx = n.x - centre[0], vz = n.z - centre[1]; const vl = Math.hypot(vx, vz) || 1
      vx = vx / vl + nx; vz = vz / vl + nz; const v2 = Math.hypot(vx, vz) || 1; vx /= v2; vz /= v2
      const out = inset(bounds, -7)
      let t = 12
      while (t < 160 && inRect(out, n.x + vx * t, n.z + vz * t)) t += 2
      const x = n.x + vx * t, z = n.z + vz * t
      A = asms.find(a => Math.hypot(a.x - x, a.z - z) < 10) ?? { id: `A${asms.length + 1}`, label: `Assembly ${asms.length + 1} · Outside ${label}`, x, z }
    }
    if (!asms.includes(A)) asms.push(A)
    gexits.push({ id: n.id, level: n.level, x: n.x, z: n.z, nx, nz, w, asm: A.id })
    exits.push({ id: n.id, label, level: n.level, door: [n.x, n.z], out: [n.x + nx * 2.6, n.z + nz * 2.6], assembly: [A.x, A.z], assemblyLabel: A.label, asm: A.id, width: w, flow: w * 1.3 })
  }
  if (!exits.length) throw new Error('None of the exits is connected to the building.')
  const siteR = { ...bounds }
  for (const e of exits) { grow(siteR, e.out[0] - 2, e.out[1] - 2, e.out[0] + 2, e.out[1] + 2); grow(siteR, e.assembly[0] - 7, e.assembly[1] - 7, e.assembly[0] + 7, e.assembly[1] + 7) }

  // ---------- walkable area per storey ----------
  const walk: Box[][] = [...Array(LV)].map(() => [])
  const pad = R + WALL_T / 2
  for (const r of rooms) { const q = inset(r.r, pad); walk[r.level].push(rectBox(q.x0, q.z0, Math.max(q.x0, q.x1), Math.max(q.z0, q.z1))) }
  for (const s of strips) {
    const L = Math.hypot(s.bx - s.ax, s.bz - s.az), ux = (s.bx - s.ax) / L, uz = (s.bz - s.az) / L, hv = Math.max(0.2, s.w / 2 - R - 0.08)
    const ea = s.openA ? 0.6 : hv + 0.45, eb = s.openB ? 0.6 : hv + 0.45
    walk[s.level].push(segBox(s.ax - ux * ea, s.az - uz * ea, s.bx + ux * eb, s.bz + uz * eb, hv, 0))
  }
  for (const sh of shafts) for (let L = sh.lo; L <= sh.hi; L++) {
    const [ax, az] = shaftPoint(sh, R + 0.1, 0), [bx, bz] = shaftPoint(sh, sh.ld - R - 0.1, 0)
    walk[L].push(segBox(ax, az, bx, bz, sh.width / 2 - R - 0.1, 0))
  }
  for (const x of extra) walk[x.level].push(x.b)
  // links that bend round traced walls: walkable along their way too (through the door cut for them)
  for (const wy of ways) {
    const hv = Math.max(0.2, Math.min(1.2, wy.w / 2) - R - 0.08)
    for (let i = 0; i + 1 < wy.pts.length; i++) walk[wy.level].push(segBox(wy.pts[i][0], wy.pts[i][1], wy.pts[i + 1][0], wy.pts[i + 1][1], hv, hv))
  }

  // ---------- seats: each room's people inside its rectangle ----------
  const seats: Seat[] = [], rnd = lcg(1234)
  for (const room of rooms) {
    const ds = doors.filter(d => d.room === room.id)
    if (ds.length) { room.fx = -ds[0].nx; room.fz = -ds[0].nz }
    if (!room.people) continue
    const r = room.r, a = inset(r, 0.5)
    for (const d of ds) { if (d.nx > 0) a.x1 = Math.min(a.x1, r.x1 - 1.3); if (d.nx < 0) a.x0 = Math.max(a.x0, r.x0 + 1.3); if (d.nz > 0) a.z1 = Math.min(a.z1, r.z1 - 1.3); if (d.nz < 0) a.z0 = Math.max(a.z0, r.z0 + 1.3) }
    const alongX = Math.abs(room.fx) > 0.5
    if ((alongX ? a.x1 - a.x0 : a.z1 - a.z0) > 4) { if (room.fx > 0) a.x1 -= 0.9; else if (room.fx < 0) a.x0 += 0.9; else if (room.fz > 0) a.z1 -= 0.9; else a.z0 += 0.9 }
    if (a.x1 - a.x0 < 0.6 || a.z1 - a.z0 < 0.6) Object.assign(a, inset(r, Math.min(0.45, (r.x1 - r.x0) / 2 - 0.1, (r.z1 - r.z0) / 2 - 0.1)))
    const yaw = Math.atan2(room.fx, room.fz)
    const [lo, hi] = alongX ? [a.x0, a.x1] : [a.z0, a.z1], [clo, chi] = alongX ? [a.z0, a.z1] : [a.x0, a.x1]
    const nr = Math.max(1, Math.floor((hi - lo) / 1.0)), nc = Math.max(1, Math.floor((chi - clo) / 0.7))
    if (room.people <= nr * nc) {
      // seated, filling from the front row, centre outwards
      const front = (alongX ? room.fx : room.fz) >= 0
      const cols = [...Array(nc).keys()].sort((p, q) => Math.abs(p - (nc - 1) / 2) - Math.abs(q - (nc - 1) / 2))
      let left = room.people
      for (let k = 0; k < nr && left > 0; k++) for (const c of cols) {
        if (left-- <= 0) break
        const along = front ? hi - (k + 0.5) * (hi - lo) / nr : lo + (k + 0.5) * (hi - lo) / nr, across = clo + (c + 0.5) * (chi - clo) / nc
        seats.push({ x: alongX ? along : across, z: alongX ? across : along, yaw, sit: true, room: room.id, level: room.level })
      }
    } else {
      // more people than chairs: standing, packed evenly over the whole room
      const q = inset(r, Math.min(0.4, (r.x1 - r.x0) / 2 - 0.05, (r.z1 - r.z0) / 2 - 0.05)), W = q.x1 - q.x0, D = q.z1 - q.z0
      const pitch = Math.max(0.42, Math.sqrt((W * D) / room.people)), cx = Math.max(1, Math.floor(W / pitch)), cz = Math.max(1, Math.floor(D / pitch))
      const cells = [...Array(cx * cz).keys()]
      for (let k = cells.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [cells[k], cells[j]] = [cells[j], cells[k]] }
      for (let k = 0; k < room.people; k++) {
        const c = cells[k % cells.length], j = (k / cells.length) | 0
        const x = q.x0 + ((Math.floor(c / cz) + 0.5) * W) / cx + (rnd() - 0.5) * pitch * 0.4 + j * 0.13
        const z = q.z0 + (((c % cz) + 0.5) * D) / cz + (rnd() - 0.5) * pitch * 0.4 + j * 0.11
        seats.push({ x: clamp(x, q.x0, q.x1), z: clamp(z, q.z0, q.z1), yaw: yaw + (rnd() - 0.5) * 1.2, sit: false, room: room.id, level: room.level })
      }
    }
  }

  // ---------- walls: room, shaft and corridor outlines minus everything walkable that crosses them ----------
  const wallCache = new Map<number, { walls: WallPiece[]; gaps: WallPiece[] }>()
  function walls(L: number) {
    const hit = wallCache.get(L)
    if (hit) return hit
    const polys: [number, number][][] = [], cands: { a: [number, number]; b: [number, number]; t: number; own: number; src: WallPiece['src'] }[] = []
    const outline = (pts: [number, number][], t: number, own: number, ends: boolean[]) => {
      pts.forEach((p, i) => {
        if (!ends[i]) return
        const q = pts[(i + 1) % pts.length], l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, e = t / 2
        const ux = (q[0] - p[0]) / l, uz = (q[1] - p[1]) / l
        cands.push({ a: [p[0] - ux * e, p[1] - uz * e], b: [q[0] + ux * e, q[1] + uz * e], t, own, src })
      })
    }
    let src: WallPiece['src'] = 'room'
    for (const r of rooms) if (r.level === L) { const p = rectPoly(r.r); outline(p, WALL_T, polys.length, [true, true, true, true]); polys.push(p) }
    src = 'shaft'
    for (const s of shafts) if (L >= s.lo && L <= s.hi) { const p = rectPoly(shaftRect(s)); outline(p, WALL_T, polys.length, [true, true, true, true]); polys.push(p) }
    src = 'strip'
    for (const s of strips) if (s.level === L) {
      const h = s.w / 2, p = stripPoly(s, s.openA ? 0 : h, s.openB ? 0 : h)
      outline(p, 0.14, polys.length, [true, !s.openB, true, !s.openA]); polys.push(p)
    }
    const out = { walls: [] as WallPiece[], gaps: [] as WallPiece[] }
    for (const c of cands) {
      const iv: [number, number][] = []
      polys.forEach((p, k) => { if (k !== c.own) { const r = clipInside(c.a[0], c.a[1], c.b[0], c.b[1], p, 0.03); if (r) iv.push(r) } })
      iv.sort((p, q) => p[0] - q[0])
      const len = Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]), at = (t: number): [number, number] => [c.a[0] + (c.b[0] - c.a[0]) * t, c.a[1] + (c.b[1] - c.a[1]) * t]
      let cur = 0, prevEnd = -1
      const solid = (t0: number, t1: number) => {
        if ((t1 - t0) * len < 0.12) return
        if (prevEnd >= 0 && (t0 - prevEnd) * len > 0.4 && (t0 - prevEnd) * len < 4.5) { const [ax, az] = at(prevEnd), [bx, bz] = at(t0); out.gaps.push({ ax, az, bx, bz, t: c.t, src: c.src }) }
        const [ax, az] = at(t0), [bx, bz] = at(t1); out.walls.push({ ax, az, bx, bz, t: c.t, src: c.src }); prevEnd = t1
      }
      for (const [t0, t1] of iv) { if (t0 > cur) solid(cur, t0); cur = Math.max(cur, t1) }
      if (cur < 1) solid(cur, 1)
    }
    wallCache.set(L, out)
    return out
  }

  // ---------- the plan ----------
  const nav: Nav = { nodes: nn, edges: ne, adj: nn.map(() => []), walk: walk.map(w => new Walk(w)) }
  for (const e of ne) { nav.adj[e.a].push({ to: e.b, len: e.len, rail: e.rail }); nav.adj[e.b].push({ to: e.a, len: e.len, rail: e.rail }) }
  for (let L = 0; L < LV; L++) {
    const t = tw(L)
    if (!t) continue
    const W = nav.walk[L]
    W.setWalls(t)
    // every link must be walkable: straight, round the drawn walls along its way, or (rarely) a straight cut
    const N = nn.length, via = (nav.via ??= new Map())
    for (const wy of ways) if (wy.level === L) {
      via.set(wy.e.a * N + wy.e.b, wy.pts.slice(1))
      via.set(wy.e.b * N + wy.e.a, wy.pts.slice().reverse().slice(1))
    }
    const links = ne.filter(e => !e.rail && nn[e.a].level === L && nn[e.b].level === L)
    const walkable = (e: NavEdge) => {
      const A = nn[e.a], C = nn[e.b], v = via.get(e.a * N + e.b)
      if (!v) return W.clear(A.x, A.z, C.x, C.z) || !!W.path(A.x, A.z, C.x, C.z, 6)
      let p: [number, number] = [A.x, A.z]
      for (const q of v) { if (!W.clear(p[0], p[1], q[0], q[1]) && !W.path(p[0], p[1], q[0], q[1], 4)) return false; p = q }
      return true
    }
    const bad = links.filter(e => !walkable(e))
    if (bad.length) {
      cutStraight(t, bad.map(e => ({ ax: nn[e.a].x, az: nn[e.a].z, bx: nn[e.b].x, bz: nn[e.b].z, w: ew[ne.indexOf(e)] })), R + 0.05)
      for (const e of bad) { via.delete(e.a * N + e.b); via.delete(e.b * N + e.a) }
      W.setWalls(t)
    }
    // walls nowhere near a walkable place stand low, so they never hide the building behind them
    if (W.open) {
      const near = dilate(W.open, t, Math.round(1.8 / t.res)), low = new Uint8Array(t.wall.length)
      for (let i = 0; i < low.length; i++) low[i] = t.wall[i] && !near[i] ? 1 : 0
      t.low = low
    }
    // everyone starts in the room as drawn (the largest walled area of its box, connected to its door): seats on a
    // wall, or past a drawn wall, move to the nearest spot of it (and stand, as there is no desk there)
    const avoid = dilate(t.cut, t, 1)
    for (const room of rooms) {
      if (room.level !== L || !room.people) continue
      const starts = (inners.get(room.id) ?? []).map(i => [nn[i].x, nn[i].z] as [number, number])
      const box: [number, number, number, number] = [room.r.x0 - 0.2, room.r.z0 - 0.2, room.r.x1 + 0.2, room.r.z1 + 0.2]
      const reach = W.region(starts, box), area = W.largest(box, avoid), linked = new Set(reach)
      const cells = area.length * t.res * t.res >= 2 && area.some(k => linked.has(k)) ? area : reach
      if (!cells.length) continue
      const ok = new Set(cells), taken = new Set<number>()
      const mine = seats.filter(s => s.room === room.id)
      const fits = mine.map(s => { const k = W.cellOf(s.x, s.z); return k >= 0 && ok.has(k) && !taken.has(k) && (taken.add(k), true) })
      mine.forEach((s, i) => {
        if (fits[i]) return
        let best = -1, bd = Infinity
        for (const k of cells) {
          if (taken.has(k)) continue
          const r = (k / t.cols) | 0, c = k - r * t.cols, d = (t.x0 + (c + 0.5) * t.res - s.x) ** 2 + (t.z0 + (r + 0.5) * t.res - s.z) ** 2
          if (d < bd) { bd = d; best = k }
        }
        if (best < 0) best = cells[i % cells.length]
        const r = (best / t.cols) | 0, c = best - r * t.cols
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) taken.add(best + dr * t.cols + dc)
        s.x = t.x0 + (c + 0.5) * t.res; s.z = t.z0 + (r + 0.5) * t.res; s.sit = false
      })
    }
  }
  const covered = (L: number, x: number, z: number) => { const t = tw(L); return !!t && inFoot(t, x, z) }
  const corridorNodes = [...nodes.values()].filter(n => n.type !== 'room' && n.type !== 'exit')
  const startRooms = [...rooms].filter(r => r.people > 0 && inners.has(r.id)).sort((p, q) => q.people - p.people || q.level - p.level).slice(0, 8).map(r => r.id)
  const S = Math.max(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0, 20)
  const name = String(site?.name || B.name || 'Building').replace(/\s*\(synthetic\)\s*/i, '')
  const geo: GraphGeo = { levels: LV, fh, wallH, rooms, strips, doors, shafts, exits: gexits, seats, bounds, site: siteR, centre, asms, walls, traced, covered }
  return {
    kind: 'graph', key, name, sub: `${LV} ${LV === 1 ? 'storey' : 'storeys'} · ${exits.length} ${exits.length === 1 ? 'exit' : 'exits'}${per > 1 ? ` · 1 figure = ${per} people` : ''}`,
    levels: LV, levelNames: floors.map(f => f.name), fh,
    rooms, spawn: rooms.map(r => ({ id: r.id, level: r.level, people: r.people })),
    exits, stairs, nav,
    startRooms: startRooms.length ? startRooms : [rooms[0].id], defaultStart: startRooms[0] ?? rooms[0].id,
    bounds, site: siteR,
    mapBase: [
      ...strips.map(s => ({ level: s.level, poly: stripPoly(s, s.openA ? 0 : s.w / 2, s.openB ? 0 : s.w / 2) })),
      ...shafts.flatMap(s => [...Array(s.hi - s.lo + 1).keys()].map(k => ({ level: s.lo + k, poly: rectPoly(shaftRect(s)) }))),
    ],
    placeName: (level, x, z) => {
      const r = rooms.find(r => r.level === level && inRect(r.r, x, z))
      if (r) return r.label
      const s = shafts.find(s => level >= s.lo && level <= s.hi && inRect(shaftRect(s), x, z))
      if (s) return s.label
      let best: N | null = null, bd = 8
      for (const n of corridorNodes) if (n.level === level) { const d = Math.hypot(n.x - x, n.z - z); if (d < bd) { bd = d; best = n } }
      return best?.label ? String(best.label) : 'Corridor'
    },
    camFor: id => {
      const r = roomOf.get(id) ?? rooms[0]
      const cx = (r.r.x0 + r.r.x1) / 2, cz = (r.r.z0 + r.r.z1) / 2
      let dx = cx - centre[0], dz = cz - centre[1]; const l = Math.hypot(dx, dz)
      if (l < 1) { dx = 0.45; dz = 0.9 } else { dx /= l; dz /= l }
      const k = 13 + Math.max(r.r.x1 - r.r.x0, r.r.z1 - r.r.z0) * 0.45
      return { pos: [cx + dx * k - dz * 8, 16 + k * 0.2, cz + dz * k + dx * 8], tgt: [cx, 0.5, cz] }
    },
    views: step => {
      const cx = centre[0], cz = centre[1], top = step * (LV - 1)
      const v = (x: number, y: number, z: number): V3 => [cx + x, y, cz + z]
      return {
        overview: [v(0.69 * S, 0.58 * S + step * LV, 1.1 * S), v(0, top * 0.5, 0)],
        top: [v(0.01, 1.75 * S + step * LV, 0.15 * S), v(0, 0, 0)],
        assess: [v(0.65 * S, 0.7 * S + fh * (LV - 1) * 1.6, 1.08 * S), v(0, fh * (LV - 1) * 0.6, 0)],
      }
    },
    geo,
  }
}
