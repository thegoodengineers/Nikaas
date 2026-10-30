// Flow capacity of an opening, and measuring clear widths from the traced walls of a floor.
// Capacity follows the simulator (nikaas/sim.py): people pass at a specific flow per metre of EFFECTIVE width,
// which is the clear width minus a boundary layer on each side (people keep away from walls and frames).
import type { Building, BuildingEdge, BuildingNode } from '../platform/api.ts'
import { decodeWalls, type WallGrid } from '../platform/walls.ts'
import { edgeKind, nodeMap } from './model.ts'

export type Kind = 'door' | 'corridor' | 'stair'
export const FLOW: Record<Kind, number> = { door: 1.312, corridor: 1.312, stair: 1.012 } // persons/s per metre
export const BOUNDARY: Record<Kind, number> = { door: 0.1524, corridor: 0.2, stair: 0.15 } // metres, each side
export const WALK = 1.19 // m/s

export const effWidth = (kind: Kind, width: number) => width - 2 * BOUNDARY[kind]
/** People per second through this opening. */
export const flowPerS = (kind: Kind, width: number) => Math.max(0, effWidth(kind, width)) * FLOW[kind]
export const perMin = (kind: Kind, width: number) => Math.round(flowPerS(kind, width) * 60)
/** Seconds for n people to get through (queueing at the opening only). */
export const passTime = (kind: Kind, width: number, n: number) => { const f = flowPerS(kind, width); return f > 0 ? n / f : Infinity }

export const CONF_TONE = { high: 'ok', medium: 'warn', low: 'bad' } as const

export function fmtDuration(s: number) {
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60), r = Math.round(s % 60)
  return r ? `${m} min ${r} s` : `${m} min`
}

// ---------- walls ----------
export type P = { x: number; z: number }
export type Walls = { g: WallGrid; cells: Uint8Array }
const cache = new WeakMap<WallGrid, Uint8Array>()
/** Decoded cells of a grid (cached per grid object; grids are never changed in place). */
export function wallsOf(g: WallGrid | undefined): Walls | null {
  if (!g) return null
  let cells = cache.get(g)
  if (!cells) { cells = decodeWalls(g); cache.set(g, cells) }
  return { g, cells }
}
/** Register cells for a grid just encoded from them, so they are not decoded again. */
export function remember(g: WallGrid, cells: Uint8Array) { cache.set(g, cells) }

export function isWall(w: Walls, x: number, z: number) {
  const c = Math.floor((x - w.g.x0) / w.g.res), r = Math.floor((z - w.g.z0) / w.g.res)
  return c >= 0 && r >= 0 && c < w.g.cols && r < w.g.rows && w.cells[r * w.g.cols + c] === 1
}
const inGrid = (w: Walls, x: number, z: number) => x >= w.g.x0 && z >= w.g.z0 && x < w.g.x0 + w.g.cols * w.g.res && z < w.g.z0 + w.g.rows * w.g.res

/** Distance from p along unit direction d to the first wall cell, or null if none within max (or the grid ends). */
export function ray(w: Walls, p: P, dx: number, dz: number, max: number): number | null {
  const step = w.g.res / 4
  for (let t = step; t <= max; t += step) {
    const x = p.x + dx * t, z = p.z + dz * t
    if (!inGrid(w, x, z)) return null
    if (isWall(w, x, z)) return t - step / 2 + FACE * w.g.res
  }
  return null
}
/** A traced wall cell is only partly ink, so on average the real wall face sits this far (in cells) inside it. */
const FACE = 0.3

export type Confidence = 'high' | 'medium' | 'low'
export type Measure = {
  width: number | null; conf: Confidence; note: string
  samples: number; hits: number; spread: number
  spans: [P, P][] // what was measured, to draw on the plan
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const quart = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] }
const round2 = (v: number) => Math.round(v * 100) / 100
const fail = (note: string, samples = 0): Measure => ({ width: null, conf: 'low', note, samples, hits: 0, spread: 0, spans: [] })

/** Snap a direction to the nearest axis when it is within `deg` of it (plans are mostly drawn square). */
function snapAxis(dx: number, dz: number, deg = 15): [number, number] {
  const a = Math.atan2(dz, dx)
  const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2)
  return Math.abs(a - q) <= (deg * Math.PI) / 180 ? [Math.round(Math.cos(q)), Math.round(Math.sin(q))] : [dx, dz]
}

/**
 * Corridor width: at points along the link (away from its ends) cast rays both ways across it until a wall.
 * At each point the narrowest of a few slightly turned crossings counts (the true crossing is the shortest).
 */
export function corridorWidth(w: Walls, A: P, B: P, cap = 8): Measure {
  const L = Math.hypot(B.x - A.x, B.z - A.z)
  if (L < 0.8) return fail('Link too short to measure along')
  const ux = (B.x - A.x) / L, uz = (B.z - A.z) / L
  const margin = Math.min(1.5, L * 0.22)
  const n = Math.max(3, Math.min(15, Math.round((L - 2 * margin) / 0.6)))
  const widths: number[] = [], spans: [P, P][] = []
  for (let k = 0; k < n; k++) {
    const t = margin + ((L - 2 * margin) * (k + 0.5)) / n
    let p = { x: A.x + ux * t, z: A.z + uz * t }
    if (isWall(w, p.x, p.z)) {
      // the link runs over a wall drawing here: try just beside it
      const alt = [0.15, -0.15, 0.3, -0.3].map(o => ({ x: p.x - uz * o, z: p.z + ux * o })).find(q => !isWall(w, q.x, q.z))
      if (!alt) continue
      p = alt
    }
    let best: [number, P, P] | null = null
    for (const deg of [0, -6, 6, -12, 12]) {
      const a = (deg * Math.PI) / 180
      const nx = -uz * Math.cos(a) - ux * Math.sin(a), nz = ux * Math.cos(a) - uz * Math.sin(a)
      const dl = ray(w, p, nx, nz, cap), dr = ray(w, p, -nx, -nz, cap)
      if (dl === null || dr === null) continue
      const tot = (dl + dr) * Math.cos(a) // across the corridor, not along the slanted ray
      if (!best || tot < best[0]) best = [tot, { x: p.x + nx * dl, z: p.z + nz * dl }, { x: p.x - nx * dr, z: p.z - nz * dr }]
    }
    if (best && best[0] > 0.2) { widths.push(best[0]); spans.push([best[1], best[2]]) }
  }
  if (!widths.length) return fail(`No walls on both sides within ${cap} m`, n)
  const med = median(widths)
  const spread = (quart(widths, 0.75) - quart(widths, 0.25)) / med
  const frac = widths.length / n
  // a "corridor" wider than 6 m is an open hall or the rays crossed a room: never high confidence
  const wide = med > 6
  const conf: Confidence = frac >= 0.6 && spread <= 0.12 && !wide ? 'high' : frac >= 0.35 && spread <= 0.3 ? 'medium' : 'low'
  const note = wide ? 'Very wide for a corridor: an open hall, or the link runs through rooms' : conf === 'high' ? 'Walls found on both sides along the link' : frac < 0.6 ? `Walls on both sides at ${widths.length} of ${n} points` : 'Width varies along the link'
  return { width: round2(med), conf, note, samples: n, hits: widths.length, spread: round2(spread), spans }
}

/**
 * The opening in a wall near P: find the wall line (running along t) within ±searchN of P across it, then the
 * free gap in that line nearest to P, bounded by wall on both sides. Measured on several lines through the
 * wall's thickness; the median gap counts.
 */
export function openingAt(w: Walls, P: P, t: [number, number], searchN: number, searchT = 2.5, why = 'opening'): Measure {
  const [tx, tz] = t
  const nx = -tz, nz = tx
  const step = w.g.res / 2
  const reach = searchT + 3
  const along = (q: P) => {
    const out: boolean[] = []
    for (let s = -reach; s <= reach + 1e-9; s += step) out.push(isWall(w, q.x + tx * s, q.z + tz * s))
    return out
  }
  // how much of a 6 m stretch along t is wall, at each offset across
  const offs: { o: number; f: number }[] = []
  for (let o = -searchN; o <= searchN + 1e-9; o += step) {
    const q = { x: P.x + nx * o, z: P.z + nz * o }
    let on = 0, all = 0
    for (let s = -3; s <= 3; s += step) { all++; if (isWall(w, q.x + tx * s, q.z + tz * s)) on++ }
    offs.push({ o, f: on / all })
  }
  let bi = 0
  offs.forEach((x, i) => { if (x.f > offs[bi].f) bi = i })
  const fmax = offs[bi]?.f ?? 0
  if (fmax < 0.2) return fail(`No wall line found at the ${why}`)
  // the band of offsets inside this wall line
  let i0 = bi, i1 = bi
  while (i0 > 0 && offs[i0 - 1].f >= fmax * 0.6) i0--
  while (i1 < offs.length - 1 && offs[i1 + 1].f >= fmax * 0.6) i1++
  const gaps: number[] = [], spans: [P, P][] = [], dists: number[] = []
  const lines = offs.slice(i0, i1 + 1)
  for (const { o } of lines) {
    const q = { x: P.x + nx * o, z: P.z + nz * o }
    const a = along(q)
    const mid = Math.round(reach / step)
    // free runs bounded by wall on both sides
    let best: [number, number, number] | null = null // start, end (exclusive), distance from centre
    let i = 0
    while (i < a.length) {
      if (a[i]) { i++; continue }
      const s0 = i
      while (i < a.length && !a[i]) i++
      if (s0 === 0 || i === a.length) continue
      const d = mid < s0 ? s0 - mid : mid >= i ? mid - i + 1 : 0
      if (d * step > searchT) continue
      if (!best || d < best[2]) best = [s0, i, d]
    }
    if (!best) continue
    const len = (best[1] - best[0]) * step + 2 * FACE * w.g.res
    if (len < 0.25) continue
    gaps.push(len)
    dists.push(best[2] * step)
    const sA = -reach + best[0] * step, sB = -reach + best[1] * step
    spans.push([{ x: q.x + tx * sA, z: q.z + tz * sA }, { x: q.x + tx * sB, z: q.z + tz * sB }])
  }
  if (!gaps.length) return fail(`Wall found, but no gap in it near the ${why}`, lines.length)
  const med = median(gaps)
  const spread = (Math.max(...gaps) - Math.min(...gaps)) / med
  const frac = gaps.length / lines.length
  const off = median(dists)
  const plausible = med >= 0.5 && med <= 5
  const conf: Confidence = plausible && frac >= 0.6 && spread <= 0.2 && off <= 1 && fmax >= 0.45 ? 'high'
    : plausible && frac >= 0.4 && spread <= 0.4 ? 'medium' : 'low'
  const note = !plausible ? `Gap of ${round2(med)} m is unusual for a ${why}`
    : off > 1 ? `Nearest gap is ${round2(off)} m from where the link meets the wall`
      : conf === 'high' ? `Gap in the wall at the ${why}` : `Gap edges unclear at the ${why}`
  // draw the line through the middle of the wall
  const midSpan = spans[spans.length >> 1]
  return { width: round2(med), conf, note, samples: lines.length, hits: gaps.length, spread: round2(spread), spans: [midSpan] }
}

/** Where the segment from `o` towards the room's centre crosses the room's outline, and that side's direction. */
function roomCrossing(room: BuildingNode, o: P): { p: P; t: [number, number]; side: number } {
  const hw = (room.w ?? 1) / 2, hd = (room.d ?? 1) / 2
  const dx = room.x - o.x, dz = room.z - o.z
  const inside = Math.abs(o.x - room.x) <= hw && Math.abs(o.z - room.z) <= hd
  if (inside || (!dx && !dz)) {
    // the other end sits inside the room: use the nearest side
    const sides = [
      { d: hd - (o.z - room.z), p: { x: o.x, z: room.z + hd }, t: [1, 0] as [number, number] },
      { d: hd + (o.z - room.z), p: { x: o.x, z: room.z - hd }, t: [1, 0] as [number, number] },
      { d: hw - (o.x - room.x), p: { x: room.x + hw, z: o.z }, t: [0, 1] as [number, number] },
      { d: hw + (o.x - room.x), p: { x: room.x - hw, z: o.z }, t: [0, 1] as [number, number] },
    ].sort((a, b) => a.d - b.d)
    return { p: sides[0].p, t: sides[0].t, side: sides[0].t[0] ? hw * 2 : hd * 2 }
  }
  // parameter where the ray from o to the centre enters the rectangle
  const tx = dx ? Math.max((room.x - Math.sign(dx) * hw - o.x) / dx, 0) : -Infinity
  const tz = dz ? Math.max((room.z - Math.sign(dz) * hd - o.z) / dz, 0) : -Infinity
  if (tx >= tz) return { p: { x: o.x + dx * tx, z: o.z + dz * tx }, t: [0, 1], side: hd * 2 }
  return { p: { x: o.x + dx * tz, z: o.z + dz * tz }, t: [1, 0], side: hw * 2 }
}

/** Measure one link from the walls of its floor. Stairs are not measured (flights are not on the plan picture). */
export function measureEdge(b: Building, e: BuildingEdge, w: Walls | null): Measure {
  if (!w) return fail('No walls traced on this floor')
  const by = nodeMap(b)
  const A = by[e.from], B = by[e.to]
  if (!A || !B) return fail('Link end missing')
  const kind = edgeKind(b, e)
  if (kind === 'stair' && (A.floor_id ?? null) !== (B.floor_id ?? null)) return fail('Stairs between floors: measure the flight by hand')
  const exit = A.type === 'exit' ? A : B.type === 'exit' ? B : null
  if (exit) {
    const other = exit === A ? B : A
    const [ux, uz] = snapAxis(exit.x - other.x, exit.z - other.z)
    const l = Math.hypot(ux, uz) || 1
    return openingAt(w, exit, [-uz / l, ux / l], 2.0, 2.5, 'exit')
  }
  const room = A.type === 'room' ? A : B.type === 'room' ? B : null
  if (room) {
    const other = room === A ? B : A
    const { p, t, side } = roomCrossing(room, other)
    // the door can be anywhere along that side of the room; the nearest gap to the link wins
    return openingAt(w, p, t, 1.2, Math.max(2.5, Math.min(8, side * 0.6)), 'door')
  }
  if (kind === 'door') {
    const L = Math.hypot(B.x - A.x, B.z - A.z) || 1
    const [ux, uz] = snapAxis((B.x - A.x) / L, (B.z - A.z) / L)
    return openingAt(w, { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 }, [-uz, ux], Math.max(0.5, L / 2), 2.5, 'door')
  }
  return corridorWidth(w, A, B)
}

/** Floor key of a link (the floor its first end is on). */
export const edgeFloor = (b: Building, e: BuildingEdge) => {
  if (!b.floors?.length) return '_'
  const n = b.nodes.find(x => x.id === e.from)
  return n?.floor_id ?? '_'
}
export const edgeKey = (e: BuildingEdge) => `${e.from}|${e.to}`
/** A measured width worth suggesting: found, and different from the width set. */
export const suggests = (m: Measure | undefined, width: number) => !!m?.width && Math.abs(m.width - width) >= 0.05

/**
 * Move each room side onto a wall line running along it, when one lies within `reach` metres.
 * Returns the new nodes and how many rooms moved.
 */
export function snapRooms(nodes: BuildingNode[], wallsFor: (n: BuildingNode) => Walls | null, reach = 0.5): { nodes: BuildingNode[]; moved: number } {
  let moved = 0
  const out = nodes.map(n => {
    if (n.type !== 'room' || !n.w || !n.d) return n
    const w = wallsFor(n)
    if (!w) return n
    let x0 = n.x - n.w / 2, x1 = n.x + n.w / 2, z0 = n.z - n.d / 2, z1 = n.z + n.d / 2
    const line = (fixed: number, a0: number, a1: number, horiz: boolean) => {
      const step = w.g.res / 2
      const span = a1 - a0
      const s0 = a0 + span * 0.12, s1 = a1 - span * 0.12
      const scores: { o: number; f: number }[] = []
      for (let o = -reach; o <= reach + 1e-9; o += step) {
        let on = 0, all = 0
        for (let s = s0; s <= s1; s += step) { all++; if (horiz ? isWall(w, s, fixed + o) : isWall(w, fixed + o, s)) on++ }
        scores.push({ o, f: all ? on / all : 0 })
      }
      const fmax = Math.max(...scores.map(s => s.f))
      if (fmax < 0.5) return fixed
      // centre of the strongest band
      const band = scores.filter(s => s.f >= fmax * 0.85).map(s => s.o)
      const best = scores.find(s => s.f === fmax)!.o
      const near = band.filter(o => Math.abs(o - best) <= 0.35)
      return fixed + (Math.min(...near) + Math.max(...near)) / 2
    }
    const nz0 = line(z0, x0, x1, true), nz1 = line(z1, x0, x1, true)
    const nx0 = line(x0, z0, z1, false), nx1 = line(x1, z0, z1, false)
    if (nx1 - nx0 < 0.5 || nz1 - nz0 < 0.5) return n
    const changed = Math.abs(nx0 - x0) + Math.abs(nx1 - x1) + Math.abs(nz0 - z0) + Math.abs(nz1 - z1) > 0.05
    if (!changed) return n
    moved++
    x0 = nx0; x1 = nx1; z0 = nz0; z1 = nz1
    const r1 = (v: number) => Math.round(v * 10) / 10
    return { ...n, x: r1((x0 + x1) / 2), z: r1((z0 + z1) / 2), w: r1(x1 - x0), d: r1(z1 - z0) }
  })
  return { nodes: out, moved }
}

/**
 * Snap a clicked point to the face of the nearest wall along `dir` (pointing into the opening): if the point is
 * inside a wall, step forward out of it; if it is in the open, step back to the wall. Within `reach` metres.
 */
export function snapFace(w: Walls | null, p: P, dx: number, dz: number, reach = 0.6): P {
  if (!w) return p
  const step = w.g.res / 4
  if (isWall(w, p.x, p.z)) {
    for (let t = step; t <= reach; t += step) if (!isWall(w, p.x + dx * t, p.z + dz * t)) return { x: p.x + dx * (t - step / 2), z: p.z + dz * (t - step / 2) }
    return p
  }
  for (let t = step; t <= reach; t += step) if (isWall(w, p.x - dx * t, p.z - dz * t)) return { x: p.x - dx * (t - step / 2), z: p.z - dz * (t - step / 2) }
  return p
}

export type WidthIssue = { edge: number; level: 'bad' | 'warn'; text: string }
/** Widths worth a second look: implausible sizes, no usable width, or far from what the walls say. */
export function widthIssues(b: Building, measured: Record<string, Measure>, label: (id: string) => string, fmt: (m: number) => string): WidthIssue[] {
  const out: WidthIssue[] = []
  b.edges.forEach((e, i) => {
    const kind = edgeKind(b, e)
    const name = `${label(e.from)} → ${label(e.to)}`
    if (effWidth(kind, e.width) <= 0) out.push({ edge: i, level: 'bad', text: `${name}: ${fmt(e.width)} leaves no usable width after the ${fmt(BOUNDARY[kind])} edge allowance on each side, so nobody can pass.` })
    else if (kind === 'door' && e.width < 0.7) out.push({ edge: i, level: 'warn', text: `${name}: door ${fmt(e.width)} is narrower than ${fmt(0.7)}.` })
    else if (kind === 'door' && e.width > 4) out.push({ edge: i, level: 'warn', text: `${name}: door ${fmt(e.width)} is wider than ${fmt(4)}. Is it really one door?` })
    else if (kind === 'corridor' && e.width < 0.9) out.push({ edge: i, level: 'warn', text: `${name}: corridor ${fmt(e.width)} is narrower than ${fmt(0.9)}.` })
    const m = measured[edgeKey(e)]
    if (m?.width && m.conf !== 'low' && Math.abs(m.width - e.width) / Math.max(m.width, e.width) > 0.3)
      out.push({ edge: i, level: 'warn', text: `${name}: set to ${fmt(e.width)}, but the traced walls say ${fmt(m.width)}.` })
  })
  return out
}
