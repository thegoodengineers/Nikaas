// Walkable area of one storey: a union of oriented boxes (room rectangles, corridor strips, door gaps,
// stair landings), already shrunk by the body radius. A coarse grid keeps the nearest-point query cheap
// for big buildings. No DOM and no three.js, so the crowd model runs headless too.

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

  /** Nearest walkable point (the point itself when it is already inside). */
  clamp(x: number, z: number): [number, number] {
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
