// Walkable area of one storey: a union of oriented boxes (room rectangles, corridor strips, door gaps,
// stair landings), already shrunk by the body radius, minus the walls traced from the floor's plan picture
// (a grid, already grown by the body radius). A coarse grid keeps the nearest-point query cheap for big
// buildings. No DOM and no three.js, so the crowd model runs headless too.

/** Oriented box: centre, unit axis (ux, uz), half length along the axis and half width across it. */
export type Box = { cx: number; cz: number; ux: number; uz: number; hu: number; hv: number }

export const rectBox = (x0: number, z0: number, x1: number, z1: number): Box =>
  ({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, ux: 1, uz: 0, hu: Math.max(0, (x1 - x0) / 2), hv: Math.max(0, (z1 - z0) / 2) })

/** Strip along a segment, `hv` either side of it, reaching `ext` past both ends. */
export function segBox(ax: number, az: number, bx: number, bz: number, hv: number, ext: number): Box {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz)
  if (len < 1e-6) return { cx: ax, cz: az, ux: 1, uz: 0, hu: Math.max(0, ext), hv: Math.max(0, hv) }
  return { cx: (ax + bx) / 2, cz: (az + bz) / 2, ux: dx / len, uz: dz / len, hu: Math.max(0, len / 2 + ext), hv: Math.max(0, hv) }
}

const CELL = 2, PAD = 3

/** Traced walls on a grid: `block` marks cells no one's centre may enter. */
export type WallMask = { res: number; x0: number; z0: number; cols: number; rows: number; block: Uint8Array }
const NB8: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]

export class Walk {
  boxes: Box[]
  private gx = 0; private gz = 0; private nx = 0; private nz = 0
  private cells: number[][] = []

  constructor(boxes: Box[]) {
    this.boxes = boxes
    if (!boxes.length) return
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    const aabb = boxes.map(b => {
      const ex = Math.abs(b.ux) * b.hu + Math.abs(b.uz) * b.hv, ez = Math.abs(b.uz) * b.hu + Math.abs(b.ux) * b.hv
      const r = [b.cx - ex - PAD, b.cz - ez - PAD, b.cx + ex + PAD, b.cz + ez + PAD]
      x0 = Math.min(x0, r[0]); z0 = Math.min(z0, r[1]); x1 = Math.max(x1, r[2]); z1 = Math.max(z1, r[3])
      return r
    })
    this.gx = x0; this.gz = z0
    this.nx = Math.max(1, Math.ceil((x1 - x0) / CELL)); this.nz = Math.max(1, Math.ceil((z1 - z0) / CELL))
    if (this.nx * this.nz > 250000) return // absurdly large plan: fall back to scanning every box
    this.cells = Array.from({ length: this.nx * this.nz }, () => [])
    aabb.forEach((r, k) => {
      const i0 = Math.floor((r[0] - x0) / CELL), i1 = Math.min(this.nx - 1, Math.floor((r[2] - x0) / CELL))
      const j0 = Math.floor((r[1] - z0) / CELL), j1 = Math.min(this.nz - 1, Math.floor((r[3] - z0) / CELL))
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) this.cells[i * this.nz + j].push(k)
    })
  }

  private near(x: number, z: number): number[] | null {
    if (!this.cells.length) return null
    const i = Math.floor((x - this.gx) / CELL), j = Math.floor((z - this.gz) / CELL)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return null
    const l = this.cells[i * this.nz + j]
    return l.length ? l : null
  }

  /** Traced walls, when the storey has them; `open` = inside a box and off the walls, per cell. */
  wall: WallMask | null = null
  open: Uint8Array | null = null
  /** connected areas of open cells (4-neighbour): 0 = not open, -1 = a pocket too small to stand in */
  comp: Int32Array | null = null

  setWalls(m: WallMask) {
    this.wall = m
    const n = m.cols * m.rows, open = new Uint8Array(n), comp = new Int32Array(n)
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      const i = r * m.cols + c
      if (!m.block[i] && this.contains(m.x0 + (c + 0.5) * m.res, m.z0 + (r + 0.5) * m.res)) open[i] = 1
    }
    // slivers between drawn walls (smaller than about a square metre) are not somewhere to walk: nobody steps in
    const minCells = Math.max(4, Math.round(1 / (m.res * m.res))), stack: number[] = []
    let id = 0
    for (let i = 0; i < n; i++) {
      if (!open[i] || comp[i]) continue
      const list: number[] = []
      comp[i] = ++id; stack.push(i)
      while (stack.length) {
        const k = stack.pop()!, r = (k / m.cols) | 0, c = k - r * m.cols
        list.push(k)
        for (const q of [c > 0 ? k - 1 : -1, c < m.cols - 1 ? k + 1 : -1, r > 0 ? k - m.cols : -1, r < m.rows - 1 ? k + m.cols : -1]) {
          if (q >= 0 && open[q] && !comp[q]) { comp[q] = id; stack.push(q) }
        }
      }
      if (list.length < minCells) for (const k of list) { comp[k] = -1; open[k] = 0 }
    }
    this.open = open; this.comp = comp
  }
  cellOf(x: number, z: number) {
    const m = this.wall
    if (!m) return -1
    const c = Math.floor((x - m.x0) / m.res), r = Math.floor((z - m.z0) / m.res)
    return c >= 0 && r >= 0 && c < m.cols && r < m.rows ? r * m.cols + c : -1
  }
  /** On a traced wall (grown by the body radius). */
  blocked(x: number, z: number) { const i = this.cellOf(x, z); return i >= 0 && this.wall!.block[i] === 1 }
  /** Somewhere a person can stand: inside the walkable boxes and off the walls. */
  free(x: number, z: number) { return this.contains(x, z, 0) && !this.blocked(x, z) }

  /** Nearest walkable point (the point itself when it is already inside), off the traced walls. */
  clamp(x: number, z: number): [number, number] {
    if (!this.wall) return this.boxClamp(x, z)
    if (this.free(x, z)) return [x, z]
    const p = this.boxClamp(x, z)
    if (!this.blocked(p[0], p[1]) && Math.hypot(p[0] - x, p[1] - z) < 0.3) return p
    return this.nearestOpen(x, z) ?? p
  }

  /** One step from (ax, az) towards (nx, nz): stays in the walkable area, slides along traced walls and never
   * squeezes diagonally between two wall corners into another area. */
  move(ax: number, az: number, nx: number, nz: number): [number, number] {
    if (!this.wall) return this.boxClamp(nx, nz)
    const comp = this.comp!, block = this.wall.block, i0 = this.cellOf(ax, az), c0 = i0 >= 0 ? comp[i0] : 0
    const ok = (x: number, z: number) => {
      const i = this.cellOf(x, z)
      if (i < 0) return this.contains(x, z, 0)
      return !block[i] && comp[i] >= 0 && (c0 <= 0 || comp[i] === 0 || comp[i] === c0) && this.contains(x, z, 0)
    }
    if (ok(nx, nz)) return [nx, nz]
    const p = this.boxClamp(nx, nz) // sliding along a box edge, as without traced walls
    if (Math.hypot(p[0] - nx, p[1] - nz) < 0.25 && ok(p[0], p[1])) return p
    if (ok(nx, az)) return [nx, az]
    if (ok(ax, nz)) return [ax, nz]
    if (c0 > 0 || ok(ax, az)) return [ax, az]
    return this.nearestOpen(ax, az) ?? p
  }

  /** Centre of the nearest open cell within `reach` metres. */
  nearestOpen(x: number, z: number, reach = 2.5): [number, number] | null {
    const m = this.wall, open = this.open
    if (!m || !open) return null
    const c = Math.floor((x - m.x0) / m.res), r = Math.floor((z - m.z0) / m.res), R = Math.ceil(reach / m.res)
    let best = -1, bd = Infinity
    for (let k = 0; k <= R && best < 0; k++) {
      for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== k) continue
        const rr = r + dr, cc = c + dc
        if (rr < 0 || cc < 0 || rr >= m.rows || cc >= m.cols || !open[rr * m.cols + cc]) continue
        const d = dr * dr + dc * dc
        if (d < bd) { bd = d; best = rr * m.cols + cc }
      }
    }
    if (best < 0) return null
    const br = (best / m.cols) | 0, bc = best - br * m.cols
    return [m.x0 + (bc + 0.5) * m.res, m.z0 + (br + 0.5) * m.res]
  }

  /** The straight line between two points stays on open cells (its two ends, where someone already stands, aside). */
  clear(ax: number, az: number, bx: number, bz: number) {
    const m = this.wall, open = this.open
    if (!m || !open) return true
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (m.res * 0.5)))
    for (let i = 1; i < n; i++) {
      const k = this.cellOf(ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n)
      if (k >= 0 && !open[k]) return false
    }
    return true
  }

  /** A way round the traced walls from one point to another: corner points to walk through, ending at the target,
   * or null when there is none nearby. Searches a window around both points only, so it stays cheap. */
  path(ax: number, az: number, bx: number, bz: number, margin = 8): [number, number][] | null {
    const m = this.wall, open = this.open
    if (!m || !open) return null
    const toCell = (x: number, z: number): [number, number] => [Math.floor((x - m.x0) / m.res), Math.floor((z - m.z0) / m.res)]
    const [ca, ra] = toCell(ax, az), [cb, rb] = toCell(bx, bz), pad = Math.ceil(margin / m.res)
    const c0 = Math.max(0, Math.min(ca, cb) - pad), c1 = Math.min(m.cols - 1, Math.max(ca, cb) + pad)
    const r0 = Math.max(0, Math.min(ra, rb) - pad), r1 = Math.min(m.rows - 1, Math.max(ra, rb) + pad)
    const W = c1 - c0 + 1, H = r1 - r0 + 1
    if (W < 1 || H < 1 || W * H > 600_000) return null
    const isOpen = (c: number, r: number) => c >= c0 && c <= c1 && r >= r0 && r <= r1 && open[r * m.cols + c] === 1
    // start and goal snap to the nearest open cell close by
    const snap = (c: number, r: number): number => {
      for (let k = 0; k <= 4; k++) for (let dr = -k; dr <= k; dr++) for (let dc = -k; dc <= k; dc++) if (isOpen(c + dc, r + dr)) return (r + dr - r0) * W + (c + dc - c0)
      return -1
    }
    const s = snap(ca, ra), g = snap(cb, rb)
    if (s < 0 || g < 0) return null
    const prev = new Int32Array(W * H).fill(-1), q = new Int32Array(W * H)
    let qh = 0, qt = 0
    q[qt++] = s; prev[s] = s
    while (qh < qt && prev[g] < 0) {
      const k = q[qh++], r = (k / W) | 0, c = k - r * W
      for (const [dc, dr] of NB8) {
        const cc = c + dc, rr = r + dr
        if (cc < 0 || rr < 0 || cc >= W || rr >= H) continue
        const n = rr * W + cc
        if (prev[n] >= 0 || !isOpen(cc + c0, rr + r0)) continue
        if (dc && dr && (!isOpen(c + dc + c0, r + r0) || !isOpen(c + c0, r + dr + r0))) continue // no corner cutting
        prev[n] = k; q[qt++] = n
      }
    }
    if (prev[g] < 0) return null
    const cells: [number, number][] = []
    for (let k = g; ; k = prev[k]) {
      const r = (k / W) | 0, c = k - r * W
      cells.push([m.x0 + (c + c0 + 0.5) * m.res, m.z0 + (r + r0 + 0.5) * m.res])
      if (k === s) break
    }
    cells.reverse()
    cells[cells.length - 1] = [bx, bz]
    // pull the string: from each corner, the farthest cell still in plain sight
    const out: [number, number][] = []
    let i = 0, px = ax, pz = az
    while (i < cells.length - 1) {
      let j = cells.length - 1
      while (j > i + 1 && !this.clear(px, pz, cells[j][0], cells[j][1])) j--
      out.push(cells[j]); [px, pz] = cells[j]; i = j
    }
    if (!out.length) out.push([bx, bz])
    return out
  }

  /** The largest open area inside the box [x0, z0, x1, z1] when cells marked in `avoid` are closed (e.g. doors cut
   * through drawn walls, so the area is a room as drawn, not the room plus its neighbour). */
  largest(box: [number, number, number, number], avoid: Uint8Array): number[] {
    const m = this.wall, open = this.open
    if (!m || !open) return []
    const c0 = Math.max(0, Math.floor((box[0] - m.x0) / m.res)), c1 = Math.min(m.cols - 1, Math.floor((box[2] - m.x0) / m.res))
    const r0 = Math.max(0, Math.floor((box[1] - m.z0) / m.res)), r1 = Math.min(m.rows - 1, Math.floor((box[3] - m.z0) / m.res))
    const seen = new Set<number>()
    let best: number[] = []
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const s = r * m.cols + c
      if (!open[s] || avoid[s] || seen.has(s)) continue
      const list = [s]; seen.add(s)
      for (let h = 0; h < list.length; h++) {
        const k = list[h], rr = (k / m.cols) | 0, cc = k - rr * m.cols
        for (const [dc, dr] of NB8) {
          const x = cc + dc, y = rr + dr
          if (x < c0 || y < r0 || x > c1 || y > r1) continue
          const n = y * m.cols + x
          if (!open[n] || avoid[n] || seen.has(n)) continue
          seen.add(n); list.push(n)
        }
      }
      if (list.length > best.length) best = list
    }
    return best
  }

  /** Open cells reachable from the start points without leaving the box [x0, z0, x1, z1], nearest first. */
  region(starts: [number, number][], box: [number, number, number, number]): number[] {
    const m = this.wall, open = this.open
    if (!m || !open) return []
    const c0 = Math.max(0, Math.floor((box[0] - m.x0) / m.res)), c1 = Math.min(m.cols - 1, Math.floor((box[2] - m.x0) / m.res))
    const r0 = Math.max(0, Math.floor((box[1] - m.z0) / m.res)), r1 = Math.min(m.rows - 1, Math.floor((box[3] - m.z0) / m.res))
    const seen = new Set<number>(), out: number[] = []
    for (const [x, z] of starts) {
      const k0 = this.cellOf(x, z), p = k0 >= 0 && open[k0] ? [x, z] : this.nearestOpen(x, z, 1.5)
      if (!p) continue
      const k = this.cellOf(p[0], p[1])
      if (k >= 0 && !seen.has(k)) { seen.add(k); out.push(k) }
    }
    for (let h = 0; h < out.length; h++) {
      const k = out[h], r = (k / m.cols) | 0, c = k - r * m.cols
      for (const [dc, dr] of NB8) {
        const cc = c + dc, rr = r + dr
        if (cc < c0 || rr < r0 || cc > c1 || rr > r1) continue
        const n = rr * m.cols + cc
        if (!open[n] || seen.has(n)) continue
        seen.add(n); out.push(n)
      }
    }
    return out
  }

  private boxClamp(x: number, z: number): [number, number] {
    const B = this.boxes, list = this.near(x, z), n = list ? list.length : B.length
    let bx = x, bz = z, bd = Infinity
    for (let k = 0; k < n; k++) {
      const b = B[list ? list[k] : k]
      const dx = x - b.cx, dz = z - b.cz
      const u = dx * b.ux + dz * b.uz, v = -dx * b.uz + dz * b.ux
      const cu = u < -b.hu ? -b.hu : u > b.hu ? b.hu : u, cv = v < -b.hv ? -b.hv : v > b.hv ? b.hv : v
      if (cu === u && cv === v) return [x, z]
      const d = (u - cu) * (u - cu) + (v - cv) * (v - cv)
      if (d < bd) { bd = d; bx = b.cx + cu * b.ux - cv * b.uz; bz = b.cz + cu * b.uz + cv * b.ux }
    }
    return [bx, bz]
  }

  /** Inside the walkable area grown by `pad` (used to tell inside the building from outside). */
  contains(x: number, z: number, pad = 0) {
    const B = this.boxes, list = this.near(x, z), n = list ? list.length : B.length
    for (let k = 0; k < n; k++) {
      const b = B[list ? list[k] : k]
      const dx = x - b.cx, dz = z - b.cz
      if (Math.abs(dx * b.ux + dz * b.uz) <= b.hu + pad && Math.abs(-dx * b.uz + dz * b.ux) <= b.hv + pad) return true
    }
    return false
  }
}
