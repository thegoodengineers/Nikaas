// Wall tracing on raw pixels (no DOM, so it runs in a worker): plan picture -> grid of wall cells.
// Walls are the dark, grey-ish lines of a plan. Coloured symbols (green exit signs, red fire equipment, blue
// water) are skipped by their colour; text, arrows and legend icons are dropped as small blobs afterwards.

export type TraceOpts = {
  /** 0..1: higher marks fainter lines as walls. 0.5 suits most plans. */
  sensitivity: number
  /** Thicken walls to at least this many metres (0: leave as traced). */
  minWall?: number
}
export type TraceStats = { otsu: number; wallCells: number; removed: number; closed: number }

/**
 * `px` is RGBA of a picture drawn at `k` pixels per cell (pw = cols*k, ph = rows*k).
 * Returns one byte per cell (1 = wall), row-major.
 */
export function traceCells(px: Uint8ClampedArray, pw: number, ph: number, cols: number, rows: number, res: number, opts: TraceOpts): { cells: Uint8Array; stats: TraceStats } {
  const s = Math.min(1, Math.max(0, opts.sensitivity))
  const n = pw * ph
  const lum = new Uint8Array(n)
  const grey = new Uint8Array(n) // low colour: candidate wall ink
  const hist = new Uint32Array(256)
  let greyCount = 0
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2], a = px[j + 3]
    // transparent pixels count as white paper
    const L = a < 128 ? 255 : (r * 77 + g * 150 + b * 29) >> 8
    lum[i] = L
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
    // chroma limit grows a little with brightness: dark brown/grey ink passes, saturated symbols do not
    if (a >= 128 && mx - mn < 52 + 30 * s + L * 0.08) { grey[i] = 1; hist[L]++; greyCount++ }
  }
  const otsu = otsuThreshold(hist, greyCount)

  // local mean of luminance (integral image) for uneven light in photos
  const rad = Math.max(4, Math.round(Math.max(pw, ph) / 90))
  const integ = new Float64Array((pw + 1) * (ph + 1))
  for (let y = 0; y < ph; y++) {
    let row = 0
    for (let x = 0; x < pw; x++) {
      row += lum[y * pw + x]
      integ[(y + 1) * (pw + 1) + x + 1] = integ[y * (pw + 1) + x + 1] + row
    }
  }
  // ink must be darker than the global split and clearly darker than its surroundings
  const globalT = Math.min(250, otsu * (0.8 + 0.5 * s) + 10)
  const delta = 26 - 22 * s
  const ink = new Uint8Array(n)
  for (let y = 0; y < ph; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(ph, y + rad + 1)
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x
      if (!grey[i] || lum[i] > globalT) continue
      const x0 = Math.max(0, x - rad), x1 = Math.min(pw, x + rad + 1)
      const sum = integ[y1 * (pw + 1) + x1] - integ[y0 * (pw + 1) + x1] - integ[y1 * (pw + 1) + x0] + integ[y0 * (pw + 1) + x0]
      const mean = sum / ((x1 - x0) * (y1 - y0))
      if (lum[i] < mean - delta) ink[i] = 1
    }
  }

  // pool pixels into cells: a cell is ink when enough of its pixels are
  const k = Math.max(1, Math.round(pw / cols))
  const need = Math.max(1, Math.ceil(k * k * (0.3 - 0.15 * s)))
  let cells = new Uint8Array(cols * rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let cnt = 0
      for (let dy = 0; dy < k; dy++) {
        const y = r * k + dy
        if (y >= ph) break
        const base = y * pw + c * k
        for (let dx = 0; dx < k && c * k + dx < pw; dx++) cnt += ink[base + dx]
      }
      if (cnt >= need) cells[r * cols + c] = 1
    }
  }

  const before = count(cells)
  cells = dropSmall(cells, cols, rows, res)
  const kept = count(cells)
  // close one-cell gaps along lines (anti-aliasing, dashed scans)
  let closed = 0
  const out = cells.slice()
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c
      if (cells[i]) continue
      if ((cells[i - 1] && cells[i + 1]) || (cells[i - cols] && cells[i + cols]) || (cells[i - cols - 1] && cells[i + cols + 1]) || (cells[i - cols + 1] && cells[i + cols - 1])) { out[i] = 1; closed++ }
    }
  }
  cells = fillHollow(out, cols, rows, res)
  const thick = Math.round((opts.minWall ?? 0) / res)
  if (thick >= 2) cells = dilate(cells, cols, rows, Math.floor((thick - 1) / 2) || 1)
  return { cells, stats: { otsu, wallCells: count(cells), removed: before - kept, closed } }
}

function count(a: Uint8Array) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s }

export function otsuThreshold(hist: Uint32Array, total: number): number {
  if (!total) return 128
  let sumAll = 0
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]
  let sumB = 0, wB = 0, best = 0, bestT = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; bestT = t }
  }
  return bestT
}

/**
 * Drop connected blobs that are not walls: small marks (letters, arrows, icons) and solid filled areas.
 * Kept: anything long (a wall run or a network of walls), and short pieces that are thin and straight.
 */
function dropSmall(cells: Uint8Array, cols: number, rows: number, res: number): Uint8Array {
  const label = new Int32Array(cells.length).fill(-1)
  const out = new Uint8Array(cells.length)
  const stack: number[] = []
  const comp: number[] = []
  const longKeep = 2.4 / res, shortMin = 0.7 / res
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || label[start] >= 0) continue
    comp.length = 0
    stack.push(start); label[start] = start
    let c0 = cols, c1 = -1, r0 = rows, r1 = -1, inner = 0
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const r = (i / cols) | 0, c = i - r * cols
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r
      let nb = 0
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue
          const cc = c + dc
          if (cc < 0 || cc >= cols) continue
          const j = rr * cols + cc
          if (!cells[j]) continue
          nb++
          if (label[j] < 0) { label[j] = start; stack.push(j) }
        }
      }
      if (nb === 8) inner++
    }
    const bw = c1 - c0 + 1, bh = r1 - r0 + 1
    const long = Math.max(bw, bh), short = Math.min(bw, bh)
    const area = comp.length
    // solid patches (shadows, filled symbols, photo edges): mostly interior cells and thick
    const solid = inner > area * 0.55 && area * res * res > 1.5 && short * res > 1.0
    let keep = !solid && (long >= longKeep || (long >= shortMin && long >= short * 3.5 && area <= long * 4))
    // a line of text: a band of letters, so slices across it cut through several strokes
    if (keep && long * res <= 9 && short * res >= 0.3 && short * res <= 1.3 && area < bw * bh * 0.7) keep = !looksLikeText(comp, cols, c0, r0, bw, bh)
    if (keep) for (const i of comp) out[i] = 1
  }
  return out
}

/** Fill thin enclosed gaps: walls drawn as two outlines become solid (better rays and 3D walls). */
function fillHollow(cells: Uint8Array, cols: number, rows: number, res: number): Uint8Array {
  const seen = new Uint8Array(cells.length)
  const stack: number[] = [], comp: number[] = []
  const maxThick = 0.6 / res
  for (let start = 0; start < cells.length; start++) {
    if (cells[start] || seen[start]) continue
    comp.length = 0
    stack.push(start); seen[start] = 1
    let c0 = cols, c1 = -1, r0 = rows, r1 = -1, edge = false
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const r = (i / cols) | 0, c = i - r * cols
      if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) edge = true
      if (c > 0 && !cells[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1) }
      if (c < cols - 1 && !cells[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1) }
      if (r > 0 && !cells[i - cols] && !seen[i - cols]) { seen[i - cols] = 1; stack.push(i - cols) }
      if (r < rows - 1 && !cells[i + cols] && !seen[i + cols]) { seen[i + cols] = 1; stack.push(i + cols) }
    }
    if (edge) continue
    const long = Math.max(c1 - c0 + 1, r1 - r0 + 1)
    if (comp.length / long <= maxThick && Math.min(c1 - c0 + 1, r1 - r0 + 1) <= 1.0 / res) for (const i of comp) cells[i] = 1
  }
  return cells
}

/** Text: slices along the band's long side mostly meet ink, and often cross two or more strokes. Walls cross one. */
function looksLikeText(comp: number[], cols: number, c0: number, r0: number, bw: number, bh: number) {
  const mine = new Uint8Array(bw * bh)
  for (const i of comp) { const r = (i / cols) | 0, c = i - r * cols; mine[(r - r0) * bw + (c - c0)] = 1 }
  const alongX = bw >= bh
  const L = alongX ? bw : bh, S = alongX ? bh : bw
  let multi = 0, hit = 0, gaps = 0, prevHit = false
  for (let a = 0; a < L; a++) {
    let runs = 0, prev = 0
    for (let b = 0; b < S; b++) {
      const v = alongX ? mine[b * bw + a] : mine[a * bw + b]
      if (v && !prev) runs++
      prev = v
    }
    if (runs) hit++
    if (runs >= 2) multi++
    if (!runs && prevHit) gaps++
    prevHit = runs > 0
  }
  return hit > 0 && multi / hit > 0.3 && (gaps >= 2 || multi / hit > 0.5)
}

export function dilate(cells: Uint8Array, cols: number, rows: number, radius: number): Uint8Array {
  const out = cells.slice()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!cells[r * cols + c]) continue
      for (let dr = -radius; dr <= radius; dr++) {
        const rr = r + dr
        if (rr < 0 || rr >= rows) continue
        for (let dc = -radius; dc <= radius; dc++) {
          const cc = c + dc
          if (cc >= 0 && cc < cols) out[rr * cols + cc] = 1
        }
      }
    }
  }
  return out
}
