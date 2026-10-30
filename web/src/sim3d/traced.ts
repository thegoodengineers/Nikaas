// Walls traced from a floor's plan picture (site media, web/src/platform/walls.ts) made fit for the 3D view and the
// crowd: decoded, cleared of text and specks, downsampled when huge, the building's outline found, door openings cut
// wherever the walking graph crosses a wall, and a blocked mask (walls grown by the body radius) for walking.
// No DOM and no three.js, so the crowd model can be tested headless on traced buildings too.
import { decodeWalls, type WallGrid, type PlanImage } from '../platform/walls.ts'
import { rect, type Rect } from './layout.ts'

export type Grid = { res: number; x0: number; z0: number; cols: number; rows: number }
export type Traced = Grid & {
  hasWalls: boolean
  wall: Uint8Array    // wall cells drawn in 3D: cleaned, part of the building, doors cut
  cut: Uint8Array     // wall cells removed to open a door on the walking graph (a lintel is drawn above)
  foot: Uint8Array    // the storey's outline: rooms, corridors and their walls
  block: Uint8Array   // walls grown by the body radius: nobody's centre may stand here
  low?: Uint8Array    // walls far from anywhere walkable (a colonnade, a fence, stray marks): drawn as low parapets
  ext: Rect | null    // extent of the outline in metres
  plan: PlanImage | null
}
export type Seg = { ax: number; az: number; bx: number; bz: number; w: number }

const MAX_CELLS = 640_000       // finer grids are pooled down: 3D boxes and walking checks stay cheap
const MIN_RES = 0.05
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN)

/** A wall grid from site media, validated and decoded; null when it is unusable. Huge grids are pooled (a coarse cell
 * is a wall when any of its fine cells is). */
export function readGrid(raw: unknown): { g: Grid; cells: Uint8Array } | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Partial<WallGrid>
  const res = num(w.res), x0 = num(w.x0), z0 = num(w.z0), cols = Math.floor(num(w.cols)), rows = Math.floor(num(w.rows))
  if (![res, x0, z0, cols, rows].every(Number.isFinite) || res < 0.01 || res > 5 || cols < 2 || rows < 2 || cols * rows > 25e6) return null
  if (typeof w.rle !== 'string' || !w.rle.length) return null
  let cells: Uint8Array
  try { cells = decodeWalls({ res, x0, z0, cols, rows, rle: w.rle }) } catch { return null }
  let g: Grid = { res, x0, z0, cols, rows }
  const f = Math.max(1, Math.ceil(Math.sqrt((cols * rows) / MAX_CELLS)), Math.ceil(MIN_RES / res - 1e-9))
  if (f > 1) {
    // a coarse cell is a wall when at least a thin line's worth of its fine cells are (a line crossing it stays,
    // scattered specks do not add up to walls)
    const c2 = Math.ceil(cols / f), r2 = Math.ceil(rows / f), count = new Uint16Array(c2 * r2), out = new Uint8Array(c2 * r2)
    for (let r = 0; r < rows; r++) {
      const o = Math.floor(r / f) * c2, row = r * cols
      for (let c = 0; c < cols; c++) if (cells[row + c]) count[o + Math.floor(c / f)]++
    }
    for (let i = 0; i < out.length; i++) out[i] = count[i] >= f ? 1 : 0
    cells = out; g = { res: res * f, x0, z0, cols: c2, rows: r2 }
  }
  return { g, cells }
}

/** Connected components (8-neighbour) of set cells: label per cell (0 = none) and each component's cells. */
function components(m: Uint8Array, cols: number, rows: number, eight = true) {
  const lab = new Int32Array(m.length), comps: number[][] = [], stack = new Int32Array(m.length)
  for (let i = 0; i < m.length; i++) {
    if (!m[i] || lab[i]) continue
    const id = comps.length + 1, list: number[] = []
    let sp = 0; stack[sp++] = i; lab[i] = id
    while (sp) {
      const k = stack[--sp], r = (k / cols) | 0, c = k - r * cols
      list.push(k)
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if ((!dr && !dc) || (!eight && dr && dc)) continue
        const rr = r + dr, cc = c + dc
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue
        const n = rr * cols + cc
        if (m[n] && !lab[n]) { lab[n] = id; stack[sp++] = n }
      }
    }
    comps.push(list)
  }
  return { lab, comps }
}

/** Drop specks, letters and arrows: small blobs, and sparse ones under a metre (a solid pillar stays). */
function clean(cells: Uint8Array, g: Grid) {
  const { comps } = components(cells, g.cols, g.rows)
  for (const list of comps) {
    let c0 = Infinity, c1 = -1, r0 = Infinity, r1 = -1
    for (const k of list) { const r = (k / g.cols) | 0, c = k - r * g.cols; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r }
    const bw = c1 - c0 + 1, bh = r1 - r0 + 1, ext = Math.max(bw, bh) * g.res, fill = list.length / (bw * bh)
    if (ext < 0.45 || (ext < 1.1 && fill < 0.5)) for (const k of list) cells[k] = 0
  }
}

/** Cells that see a wall in all 8 directions (inside a building; holes are filled afterwards). */
function enclosed(cells: Uint8Array, g: Grid) {
  const { cols, rows } = g, n = cols * rows, hit = new Uint8Array(n), count = new Uint8Array(n)
  for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const rs = dr > 0 ? rows - 1 : 0, re = dr > 0 ? -1 : rows, rstep = dr > 0 ? -1 : 1
    const cs = dc > 0 ? cols - 1 : 0, ce = dc > 0 ? -1 : cols, cstep = dc > 0 ? -1 : 1
    for (let r = rs; r !== re; r += rstep) for (let c = cs; c !== ce; c += cstep) {
      const rr = r + dr, cc = c + dc, i = r * cols + c
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) { hit[i] = 0; continue }
      const k = rr * cols + cc
      hit[i] = cells[k] | hit[k]
      count[i] += hit[i]
    }
  }
  return count
}

/** The building's outline from its walls: enclosed cells and walls, only the parts that hold a room or corridor of
 * the walking graph (`seeds`), holes filled. */
function outline(cells: Uint8Array, g: Grid, seeds: [number, number][]) {
  const { cols, rows } = g, n = cols * rows
  const count = enclosed(cells, g), m = new Uint8Array(n)
  for (let i = 0; i < n; i++) m[i] = cells[i] || count[i] >= 8 ? 1 : 0
  const { lab, comps } = components(m, cols, rows, false), keep = new Uint8Array(comps.length + 1)
  for (const [x, z] of seeds) {
    const c = Math.floor((x - g.x0) / g.res), r = Math.floor((z - g.z0) / g.res)
    if (c >= 0 && r >= 0 && c < cols && r < rows) keep[lab[r * cols + c]] = 1
  }
  keep[0] = 0
  const foot = new Uint8Array(n)
  for (let i = 0; i < n; i++) foot[i] = keep[lab[i]]
  // fill holes: anything the outside cannot reach without crossing the outline
  const out = new Uint8Array(n), stack: number[] = []
  const seed = (i: number) => { if (!foot[i] && !out[i]) { out[i] = 1; stack.push(i) } }
  for (let c = 0; c < cols; c++) { seed(c); seed((rows - 1) * cols + c) }
  for (let r = 0; r < rows; r++) { seed(r * cols); seed(r * cols + cols - 1) }
  while (stack.length) {
    const k = stack.pop()!, r = (k / cols) | 0, c = k - r * cols
    if (c > 0) seed(k - 1); if (c < cols - 1) seed(k + 1); if (r > 0) seed(k - cols); if (r < rows - 1) seed(k + cols)
  }
  for (let i = 0; i < n; i++) if (!out[i]) foot[i] = 1
  return foot
}

/** Walls grown by `rad` cells (a disc). */
export function dilate(m: Uint8Array, g: Grid, rad: number) {
  const { cols, rows } = g, out = new Uint8Array(m.length), offs: [number, number][] = []
  for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) if (dr * dr + dc * dc <= (rad + 0.5) * (rad + 0.5)) offs.push([dr, dc])
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue
    const r = (i / cols) | 0, c = i - r * cols
    for (const [dr, dc] of offs) {
      const rr = r + dr, cc = c + dc
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) out[rr * cols + cc] = 1
    }
  }
  return out
}

function extent(m: Uint8Array, g: Grid): Rect | null {
  let c0 = Infinity, c1 = -1, r0 = Infinity, r1 = -1
  for (let i = 0; i < m.length; i++) if (m[i]) { const r = (i / g.cols) | 0, c = i - r * g.cols; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r }
  return c1 < 0 ? null : rect(g.x0 + c0 * g.res, g.z0 + r0 * g.res, g.x0 + (c1 + 1) * g.res, g.z0 + (r1 + 1) * g.res)
}

/** First pass on a storey's walls: clean, find the outline (seeded by the graph's rooms and corridors), keep the
 * walls that belong to it. Doors are cut later, once the walking graph is complete (`finishTraced`). */
export function prepareTraced(raw: unknown, plan: PlanImage | null, seeds: [number, number][]): Traced | null {
  const rg = readGrid(raw)
  if (!rg) return null
  const { g, cells } = rg
  clean(cells, g)
  const foot = outline(cells, g, seeds)
  let any = false
  for (let i = 0; i < cells.length; i++) { if (!foot[i]) cells[i] = 0; else if (cells[i]) any = true }
  if (!any) return null
  return { ...g, hasWalls: true, wall: cells, cut: new Uint8Array(cells.length), foot, block: new Uint8Array(cells.length), ext: extent(foot, g), plan }
}

/** A storey with a plan picture but no traced walls: the outline is the graph's own rooms and corridors. */
export function pictureOnly(plan: PlanImage, boxes: Rect[], polys: [number, number][][]): Traced | null {
  const all = [...boxes]
  for (const p of polys) all.push(rect(Math.min(...p.map(q => q[0])), Math.min(...p.map(q => q[1])), Math.max(...p.map(q => q[0])), Math.max(...p.map(q => q[1]))))
  if (!all.length) return null
  const x0 = Math.min(...all.map(b => b.x0)) - 0.5, z0 = Math.min(...all.map(b => b.z0)) - 0.5
  const x1 = Math.max(...all.map(b => b.x1)) + 0.5, z1 = Math.max(...all.map(b => b.z1)) + 0.5
  const res = Math.max(0.25, Math.sqrt(((x1 - x0) * (z1 - z0)) / 200_000))
  const g: Grid = { res, x0, z0, cols: Math.max(2, Math.ceil((x1 - x0) / res)), rows: Math.max(2, Math.ceil((z1 - z0) / res)) }
  const foot = new Uint8Array(g.cols * g.rows)
  const inPoly = (p: [number, number][], x: number, z: number) => {
    let s = 0
    for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length], v = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]); if (v !== 0) { if (s && Math.sign(v) !== s) return false; s = Math.sign(v) } }
    return true
  }
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) {
    const x = g.x0 + (c + 0.5) * res, z = g.z0 + (r + 0.5) * res
    if (boxes.some(b => x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) || polys.some(p => inPoly(p, x, z))) foot[r * g.cols + c] = 1
  }
  const n = g.cols * g.rows
  return { ...g, hasWalls: false, wall: new Uint8Array(n), cut: new Uint8Array(n), foot, block: new Uint8Array(n), ext: extent(foot, g), plan }
}

export const cellAt = (t: Grid, x: number, z: number) => {
  const c = Math.floor((x - t.x0) / t.res), r = Math.floor((z - t.z0) / t.res)
  return c >= 0 && r >= 0 && c < t.cols && r < t.rows ? r * t.cols + c : -1
}
export const inFoot = (t: Traced, x: number, z: number) => { const i = cellAt(t, x, z); return i >= 0 && t.foot[i] === 1 }

/** Square metres of wall inside a rectangle (used to keep stair shafts off drawn walls). */
export function wallArea(t: Traced, r: Rect) {
  const c0 = Math.max(0, Math.floor((r.x0 - t.x0) / t.res)), c1 = Math.min(t.cols - 1, Math.floor((r.x1 - t.x0) / t.res))
  const r0 = Math.max(0, Math.floor((r.z0 - t.z0) / t.res)), r1 = Math.min(t.rows - 1, Math.floor((r.z1 - t.z0) / t.res))
  let n = 0
  for (let rr = r0; rr <= r1; rr++) for (let c = c0; c <= c1; c++) n += t.wall[rr * t.cols + c]
  return n * t.res * t.res
}

/** Cells (global indices) of the cheapest way from a link's start to its end. Floor along the link costs its length,
 * floor away from it more the farther it is (3 times more outside the building), a wall cell 15 times as much: a door
 * gap close by wins, otherwise the thinnest crossing; never a long walk round a wing or along a veranda. */
function cheapest(t: Traced, s: Seg, hw: number): number[] | null {
  const { res, cols, rows } = t, m = 3
  const c0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - m - t.x0) / res)), c1 = Math.min(cols - 1, Math.floor((Math.max(s.ax, s.bx) + m - t.x0) / res))
  const r0 = Math.max(0, Math.floor((Math.min(s.az, s.bz) - m - t.z0) / res)), r1 = Math.min(rows - 1, Math.floor((Math.max(s.az, s.bz) + m - t.z0) / res))
  const W = c1 - c0 + 1, H = r1 - r0 + 1, n = W * H
  if (W < 1 || H < 1 || n > 500_000) return null
  const loc = (x: number, z: number) => {
    const c = Math.min(c1, Math.max(c0, Math.floor((x - t.x0) / res))), r = Math.min(r1, Math.max(r0, Math.floor((z - t.z0) / res)))
    return (r - r0) * W + (c - c0)
  }
  const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1, ux = (s.bx - s.ax) / len, uz = (s.bz - s.az) / len
  const cost = new Float32Array(n)
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const g = (r + r0) * cols + c + c0, x = t.x0 + (c + c0 + 0.5) * res - s.ax, z = t.z0 + (r + r0 + 0.5) * res - s.az
    const u = x * ux + z * uz, v = Math.abs(-x * uz + z * ux), off = Math.max(0, Math.hypot(u < 0 ? u : u > len ? u - len : 0, v) - hw)
    cost[r * W + c] = (t.wall[g] ? 15 : 1) * (1 + 1.5 * off) * (off === 0 || t.foot[g] ? 1 : 3)
  }
  const dist = new Float32Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1)
  // binary heap of (distance, cell) with lazy deletion
  let hk = new Int32Array(1024), hp = new Float32Array(1024), hn = 0
  const push = (k: number, p: number) => {
    if (hn === hk.length) { const k2 = new Int32Array(hn * 2), p2 = new Float32Array(hn * 2); k2.set(hk); p2.set(hp); hk = k2; hp = p2 }
    let i = hn++
    while (i > 0) { const j = (i - 1) >> 1; if (hp[j] <= p) break; hk[i] = hk[j]; hp[i] = hp[j]; i = j }
    hk[i] = k; hp[i] = p
  }
  const pop = () => {
    const k = hk[0], lk = hk[--hn], lp = hp[hn]
    let i = 0
    for (;;) { let j = 2 * i + 1; if (j >= hn) break; if (j + 1 < hn && hp[j + 1] < hp[j]) j++; if (hp[j] >= lp) break; hk[i] = hk[j]; hp[i] = hp[j]; i = j }
    hk[i] = lk; hp[i] = lp
    return k
  }
  const a = loc(s.ax, s.az), b = loc(s.bx, s.bz)
  dist[a] = 0; prev[a] = a; push(a, 0)
  while (hn) {
    const p = hp[0], k = pop()
    if (p > dist[k]) continue
    if (k === b) break
    const r = (k / W) | 0, c = k - r * W
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const rr = r + dr, cc = c + dc
      if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue
      const q = rr * W + cc, d = p + cost[q] * (dr && dc ? 1.4142 : 1)
      if (d < dist[q]) { dist[q] = d; prev[q] = k; push(q, d) }
    }
  }
  if (prev[b] < 0) return null
  const out: number[] = []
  for (let k = b; ; k = prev[k]) { const r = (k / W) | 0; out.push((r + r0) * cols + (k - r * W) + c0); if (k === a) break }
  return out
}

/** Straight cuts along links whose ends are still walled apart (the fallback when no cheaper crossing works). */
export function cutStraight(t: Traced, segs: Seg[], body: number) {
  const { res, cols, rows } = t, rad = Math.max(1, Math.round(body / res))
  let block = dilate(t.wall, t, rad)
  const blockedAt = (x: number, z: number) => { const i = cellAt(t, x, z); return i >= 0 && block[i] === 1 }
  const open = (s: Seg, a: number, b: number, hw: number) => {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az) || 1, ux = (s.bx - s.ax) / len, uz = (s.bz - s.az) / len
    const pts = [[s.ax + ux * a - uz * hw, s.az + uz * a + ux * hw], [s.ax + ux * b - uz * hw, s.az + uz * b + ux * hw], [s.ax + ux * a + uz * hw, s.az + uz * a - ux * hw], [s.ax + ux * b + uz * hw, s.az + uz * b - ux * hw]]
    const c0 = Math.max(0, Math.floor((Math.min(...pts.map(p => p[0])) - t.x0) / res)), c1 = Math.min(cols - 1, Math.floor((Math.max(...pts.map(p => p[0])) - t.x0) / res))
    const r0 = Math.max(0, Math.floor((Math.min(...pts.map(p => p[1])) - t.z0) / res)), r1 = Math.min(rows - 1, Math.floor((Math.max(...pts.map(p => p[1])) - t.z0) / res))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const i = r * cols + c
      if (!t.wall[i]) continue
      const dx = t.x0 + (c + 0.5) * res - s.ax, dz = t.z0 + (r + 0.5) * res - s.az, u = dx * ux + dz * uz, v = -dx * uz + dz * ux
      if (u >= a && u <= b && Math.abs(v) <= hw) { t.wall[i] = 0; t.cut[i] = 1 }
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    let cuts = 0
    for (const s of segs) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az)
      if (len < 1e-3) continue
      const n = Math.max(2, Math.ceil(len / (res * 0.5))), ext = body + res * (1.5 + pass)
      const hw = Math.min(1.6, Math.max(s.w / 2, body + res * (2 + pass) + 0.05))
      let start = -1
      for (let k = 0; k <= n + 1; k++) {
        const along = (len * k) / n, on = k <= n && blockedAt(s.ax + ((s.bx - s.ax) * k) / n, s.az + ((s.bz - s.az) * k) / n)
        if (on && start < 0) start = along
        if (!on && start >= 0) { open(s, start - ext, Math.min(len, along - len / n) + ext, hw); start = -1; cuts++ }
      }
    }
    if (!cuts) break
    block = dilate(t.wall, t, rad)
  }
  t.block = block
}

/** Second pass: clear the stair shafts, then for every walking-graph link cut a door where its cheapest way crosses a
 * drawn wall (none when the tracing already has a gap there), and grow the walls by the body radius for walking.
 * Returns each link's way as corner points (null when it found none). */
export function finishTraced(t: Traced, segs: Seg[], clear: Rect[], body: number): ([number, number][] | null)[] {
  if (!t.hasWalls) return segs.map(() => null)
  const { res, cols, rows } = t
  for (const q of clear) {
    const c0 = Math.max(0, Math.floor((q.x0 - t.x0) / res)), c1 = Math.min(cols - 1, Math.floor((q.x1 - t.x0) / res))
    const r0 = Math.max(0, Math.floor((q.z0 - t.z0) / res)), r1 = Math.min(rows - 1, Math.floor((q.z1 - t.z0) / res))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) t.wall[r * cols + c] = 0
  }
  // while searching, walls count grown by the clearance a link needs (its half width, up to 0.55 m): a way through a
  // gap is wide enough to walk, and a wall tip poking into a corridor is trimmed back rather than squeezed past
  const rad = Math.max(1, Math.round(body / res)), keep = t.wall, body2 = dilate(keep, t, rad)
  const grownBy = new Map<number, Uint8Array>([[rad, body2]])
  const cuts: [number, number][] = [], paths: (number[] | null)[] = []
  for (const s of segs) {
    const hw = Math.min(1.2, Math.max(s.w / 2, body + 2 * res + 0.05))
    const cr = Math.max(rad, Math.round(Math.min(s.w / 2, 0.55) / res))
    let grown = grownBy.get(cr)
    if (!grown) { grown = dilate(keep, t, cr); grownBy.set(cr, grown) }
    t.wall = grown
    const path = cheapest(t, s, hw)
    t.wall = keep
    paths.push(path)
    // through a wall: a door of the link's width; just too close to one: trim it back to the clearance
    if (path) for (const k of path) if (body2[k]) cuts.push([k, Math.ceil(hw / res)]); else if (grown[k]) cuts.push([k, cr + 1])
  }
  for (const [k, R] of cuts) {
    const r = (k / cols) | 0, c = k - r * cols
    for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) {
      const rr = r + dr, cc = c + dc
      if (rr < 0 || cc < 0 || rr >= rows || cc >= cols || dr * dr + dc * dc > R * R) continue
      const i = rr * cols + cc
      if (t.wall[i]) { t.wall[i] = 0; t.cut[i] = 1 }
    }
  }
  t.block = dilate(t.wall, t, rad)
  // each way as few corners as possible: from each corner, the farthest cell still in plain sight
  const at = (k: number): [number, number] => { const r = (k / cols) | 0; return [t.x0 + (k - r * cols + 0.5) * res, t.z0 + (r + 0.5) * res] }
  return paths.map((path, i) => {
    if (!path) return null
    const s = segs[i], pts = path.slice().reverse().map(at)
    pts[0] = [s.ax, s.az]; pts[pts.length - 1] = [s.bx, s.bz]
    const near = (x: number, z: number) => Math.hypot(x - s.ax, z - s.az) < 0.45 || Math.hypot(x - s.bx, z - s.bz) < 0.45
    const sees = (p: [number, number], q: [number, number]) => {
      const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (res * 0.5)))
      for (let k = 1; k < n; k++) {
        const x = p[0] + ((q[0] - p[0]) * k) / n, z = p[1] + ((q[1] - p[1]) * k) / n, c = cellAt(t, x, z)
        if (c >= 0 && t.block[c] && !near(x, z)) return false
      }
      return true
    }
    const out: [number, number][] = [pts[0]]
    let j = 0
    while (j < pts.length - 1) {
      let k = pts.length - 1
      while (k > j + 1 && !sees(pts[j], pts[k])) k--
      out.push(pts[k]); j = k
    }
    return out
  })
}
