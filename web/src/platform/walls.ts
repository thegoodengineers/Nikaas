// Walls traced from a floor's plan picture, as a grid in building metres. Shared by the editor (tracing,
// width measurement) and the 3D views (extruding the real walls). Stored with the site under media[floor].walls.
//
// Format: cell (c, r) covers x in [x0 + c*res, x0 + (c+1)*res), z in [z0 + r*res, ...). `rle` lists run lengths over
// the cells in row-major order, alternating free, wall, free, ... and always starting with a free run (may be 0).
export type WallGrid = { res: number; x0: number; z0: number; cols: number; rows: number; rle: string }
/** A floor's plan picture placed in building metres (same shape as the editor's underlay): top-left corner and size. */
export type PlanImage = { url?: string; x: number; z: number; w: number; h: number }
export type FloorMedia = { plan?: PlanImage; walls?: WallGrid }
/** Site media keyed by floor id; single-floor buildings use the key "_". */
export type Media = Record<string, FloorMedia>
export const SINGLE_FLOOR = '_'

export function encodeWalls(cells: Uint8Array, cols: number, rows: number, res: number, x0: number, z0: number): WallGrid {
  const runs: number[] = []
  let cur = 0, n = 0
  for (let i = 0; i < cells.length; i++) {
    const v = cells[i] ? 1 : 0
    if (v === cur) n++
    else { runs.push(n); cur = v; n = 1 }
  }
  runs.push(n)
  return { res, x0, z0, cols, rows, rle: runs.join(',') }
}

export function decodeWalls(g: WallGrid): Uint8Array {
  const out = new Uint8Array(g.cols * g.rows)
  let i = 0, v = 0
  for (const s of g.rle.split(',')) {
    const n = Number(s) || 0
    if (v) out.fill(1, i, Math.min(out.length, i + n))
    i += n; v ^= 1
  }
  return out
}

/** Is the point (x, z) in metres on a wall cell? */
export function wallAt(g: WallGrid, cells: Uint8Array, x: number, z: number) {
  const c = Math.floor((x - g.x0) / g.res), r = Math.floor((z - g.z0) / g.res)
  return c >= 0 && r >= 0 && c < g.cols && r < g.rows && cells[r * g.cols + c] === 1
}

/** Horizontal runs of wall cells, merged across identical rows: [x0, z0, x1, z1] boxes in metres (for 3D extrusion). */
export function wallBoxes(g: WallGrid, cells: Uint8Array): [number, number, number, number][] {
  const open = new Map<string, [number, number, number, number]>()
  const out: [number, number, number, number][] = []
  for (let r = 0; r < g.rows; r++) {
    const seen = new Set<string>()
    let c = 0
    while (c < g.cols) {
      if (!cells[r * g.cols + c]) { c++; continue }
      const s = c
      while (c < g.cols && cells[r * g.cols + c]) c++
      const key = `${s}:${c}`
      seen.add(key)
      const box = open.get(key)
      if (box) box[3] = g.z0 + (r + 1) * g.res
      else open.set(key, [g.x0 + s * g.res, g.z0 + r * g.res, g.x0 + c * g.res, g.z0 + (r + 1) * g.res])
    }
    for (const [k, b] of open) if (!seen.has(k)) { out.push(b); open.delete(k) }
  }
  for (const b of open.values()) out.push(b)
  return out
}
