// Trace a floor's walls from its plan picture: draw the picture at the grid's resolution, classify pixels in a
// worker (traceCore.ts) and store the result as a WallGrid in building metres. Also small grid helpers for
// the editor (brush, moving with the picture) and preparing pictures for upload.
import { encodeWalls, type WallGrid } from '../platform/walls.ts'
import { dataUrlBytes } from './files.ts'
import { traceCells, type TraceOpts, type TraceStats } from './traceCore.ts'
import { remember, wallsOf } from './widths.ts'

export type Place = { x: number; z: number; w: number; h: number }
export const RLE_MAX = 200_000
const MAX_SIDE = 4000 // cells, the server's limit
const RES_STEPS = [0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1]

/** Load a picture so its pixels can be read: same-origin or data URLs directly, other sites through CORS. */
export async function pixelsReady(src: string): Promise<HTMLImageElement | ImageBitmap> {
  if (/^(data|blob):/.test(src)) return loadImg(src, false)
  try {
    const r = await fetch(src, { mode: 'cors' })
    if (!r.ok) throw new Error(`picture link answered ${r.status}`)
    return await createImageBitmap(await r.blob())
  } catch {
    return loadImg(src, true)
  }
}
function loadImg(src: string, cors: boolean): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image()
    if (cors) img.crossOrigin = 'anonymous'
    img.onload = () => ok(img)
    img.onerror = () => fail(new Error('The plan picture could not be loaded'))
    img.src = src
  })
}
const sizeOf = (img: HTMLImageElement | ImageBitmap) => (img instanceof HTMLImageElement ? { w: img.naturalWidth, h: img.naturalHeight } : { w: img.width, h: img.height })

function runCore(px: Uint8ClampedArray, pw: number, ph: number, cols: number, rows: number, res: number, opts: TraceOpts): Promise<{ cells: Uint8Array; stats: TraceStats }> {
  let worker: Worker
  try {
    worker = new Worker(new URL('./traceWorker.ts', import.meta.url), { type: 'module' })
  } catch {
    return Promise.resolve(traceCells(px, pw, ph, cols, rows, res, opts))
  }
  return new Promise((ok, fail) => {
    worker.onmessage = (ev: MessageEvent<{ cells?: Uint8Array; stats?: TraceStats; error?: string }>) => {
      worker.terminate()
      if (ev.data.error || !ev.data.cells || !ev.data.stats) fail(new Error(ev.data.error ?? 'Tracing failed'))
      else ok({ cells: ev.data.cells, stats: ev.data.stats })
    }
    // a worker that cannot start: trace here instead
    worker.onerror = ev => { ev.preventDefault(); worker.terminate(); try { ok(traceCells(px, pw, ph, cols, rows, res, opts)) } catch (e) { fail(e) } }
    worker.postMessage({ px, pw, ph, cols, rows, res, opts }) // copied, so the fallback above still has the pixels
  })
}

export type TraceResult = { grid: WallGrid; stats: TraceStats; ms: number }

/** Trace walls of the picture `src` placed at `place` (metres). Picks a coarser grid if the result is too large. */
export async function traceWalls(src: string, place: Place, opts: TraceOpts): Promise<TraceResult> {
  const t0 = performance.now()
  const img = await pixelsReady(src)
  const { w: iw } = sizeOf(img)
  let last: TraceResult | null = null
  for (const res of RES_STEPS) {
    const cols = Math.ceil(place.w / res), rows = Math.ceil(place.h / res)
    if (cols > MAX_SIDE || rows > MAX_SIDE || cols * rows > 8_000_000) continue
    // several pixels per cell keep thin lines; cap the pixel count so big pictures stay quick
    let k = Math.min(3, Math.max(1, Math.ceil(iw / cols)))
    while (k > 1 && cols * rows * k * k > 10_000_000) k--
    const pw = cols * k, ph = rows * k
    const canvas = document.createElement('canvas')
    canvas.width = pw; canvas.height = ph
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, pw, ph)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, (place.w / res) * k, (place.h / res) * k)
    let px: Uint8ClampedArray
    try {
      px = ctx.getImageData(0, 0, pw, ph).data
    } catch {
      throw new Error('This picture is on another site that does not allow reading it, so it cannot be traced here. Add the picture again from a file.')
    }
    const { cells, stats } = await runCore(px, pw, ph, cols, rows, res, opts)
    const grid = encodeWalls(cells, cols, rows, res, place.x, place.z)
    remember(grid, cells)
    last = { grid, stats, ms: Math.round(performance.now() - t0) }
    if (grid.rle.length <= RLE_MAX) return last
  }
  if (last) return last
  throw new Error('The picture is too large to trace')
}

/** The same walls after the picture moved or was resized: corner and cell size follow the picture. */
export function moveWalls(g: WallGrid, from: Place, to: Place): WallGrid {
  const k = to.w / from.w
  return { ...g, res: g.res * k, x0: to.x + (g.x0 - from.x) * k, z0: to.z + (g.z0 - from.z) * k }
}
/** Scale everything about the origin (Set scale). */
export const scaleWalls = (g: WallGrid, f: number): WallGrid => ({ ...g, res: g.res * f, x0: g.x0 * f, z0: g.z0 * f })

/** A grid within the server's limits: cells of 0.05-1 m and at most 4000 per side (nearest-cell resampling). */
export function storable(g: WallGrid): WallGrid {
  if (g.res >= 0.05 && g.res <= 1 && g.cols <= MAX_SIDE && g.rows <= MAX_SIDE && g.rle.length <= 250_000) return g
  const src = wallsOf(g)!
  const W = g.cols * g.res, H = g.rows * g.res
  let res = Math.min(1, Math.max(0.05, g.res, W / MAX_SIDE, H / MAX_SIDE))
  for (;;) {
    const cols = Math.ceil(W / res), rows = Math.ceil(H / res)
    const cells = new Uint8Array(cols * rows)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const sc = Math.floor(((c + 0.5) * res) / g.res), sr = Math.floor(((r + 0.5) * res) / g.res)
      if (sc < g.cols && sr < g.rows && src.cells[sr * g.cols + sc]) cells[r * cols + c] = 1
    }
    const out = encodeWalls(cells, cols, rows, res, g.x0, g.z0)
    if (out.rle.length <= 250_000 || res >= 1) { remember(out, cells); return out }
    res = Math.min(1, res * 1.4)
  }
}

/** Paint (add) or erase wall cells along a brush stroke; returns a new grid (or the same one if nothing changed). */
export function paintWalls(g: WallGrid, pts: { x: number; z: number }[], radius: number, add: boolean): WallGrid {
  const src = wallsOf(g)!
  const cells = src.cells.slice()
  const rc = radius / g.res
  let changed = false
  const stamp = (x: number, z: number) => {
    const cx = (x - g.x0) / g.res, cz = (z - g.z0) / g.res
    for (let r = Math.floor(cz - rc); r <= Math.ceil(cz + rc); r++) {
      if (r < 0 || r >= g.rows) continue
      for (let c = Math.floor(cx - rc); c <= Math.ceil(cx + rc); c++) {
        if (c < 0 || c >= g.cols) continue
        if ((c + 0.5 - cx) ** 2 + (r + 0.5 - cz) ** 2 > rc * rc + 0.25) continue
        const i = r * g.cols + c
        if (cells[i] !== (add ? 1 : 0)) { cells[i] = add ? 1 : 0; changed = true }
      }
    }
  }
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[i + 1] ?? a
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (g.res / 2)))
    for (let k = 0; k <= n; k++) stamp(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n)
  }
  if (!changed) return g
  const out = encodeWalls(cells, g.cols, g.rows, g.res, g.x0, g.z0)
  remember(out, cells)
  return out
}

/** An empty grid over a picture (to paint walls by hand without tracing). */
export function emptyWalls(place: Place, res = 0.1): WallGrid {
  const cols = Math.min(MAX_SIDE, Math.ceil(place.w / res)), rows = Math.min(MAX_SIDE, Math.ceil(place.h / res))
  const r = Math.max(res, place.w / cols, place.h / rows)
  const c2 = Math.ceil(place.w / r), r2 = Math.ceil(place.h / r)
  const cells = new Uint8Array(c2 * r2)
  const g = encodeWalls(cells, c2, r2, r, place.x, place.z)
  remember(g, cells)
  return g
}

/** The walls as a transparent PNG (one pixel per cell) to lay over the plan. */
export function wallsPng(g: WallGrid, color: [number, number, number]): string {
  const { cells } = wallsOf(g)!
  const canvas = document.createElement('canvas')
  canvas.width = g.cols; canvas.height = g.rows
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(g.cols, g.rows)
  const d = img.data
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i]) continue
    const j = i * 4
    d[j] = color[0]; d[j + 1] = color[1]; d[j + 2] = color[2]; d[j + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

const UPLOAD_SIDE = 2400
const UPLOAD_MAX = 3_900_000
/** The plan picture as a JPEG data URL for the server: at most 2400 px on its longest side and under 4 MB. */
export async function uploadJpeg(src: string): Promise<string> {
  const img = await pixelsReady(src)
  const { w, h } = sizeOf(img)
  let side = Math.min(UPLOAD_SIDE, Math.max(w, h))
  let q = 0.82
  for (let tries = 0; tries < 8; tries++) {
    const k = side / Math.max(w, h)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * k)); canvas.height = Math.max(1, Math.round(h * k))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    let out: string
    try { out = canvas.toDataURL('image/jpeg', q) } catch { throw new Error('the picture is on another site that does not allow copying it') }
    if (dataUrlBytes(out) <= UPLOAD_MAX) return out
    if (q > 0.65) q -= 0.08
    else side = Math.round(side * 0.8)
  }
  throw new Error('the picture stays over 4 MB even after shrinking it')
}
