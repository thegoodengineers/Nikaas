/* eslint-disable @typescript-eslint/no-explicit-any */
// 3D for a storey's traced walls (traced.ts): the walls extruded from the grid as one merged mesh, lintels over the
// doors cut for the walking graph, a slab over the building's outline and the plan picture laid on the floor.
import * as THREE from 'three'
import { wallBoxes } from '../platform/walls.ts'
import { SLAB, DOOR_H } from './layout.ts'
import { dilate, type Traced, type Grid } from './traced.ts'

type B4 = [number, number, number, number]
const boxesOf = (g: Grid, m: Uint8Array): B4[] => wallBoxes({ res: g.res, x0: g.x0, z0: g.z0, cols: g.cols, rows: g.rows, rle: '' }, m)

/** The mask pooled to cells of about `res` metres (a coarse cell is set when any fine cell is). */
function pooled(t: Grid, m: Uint8Array, res: number): { g: Grid; m: Uint8Array } {
  const f = Math.max(1, Math.round(res / t.res))
  if (f === 1) return { g: t, m }
  const cols = Math.ceil(t.cols / f), rows = Math.ceil(t.rows / f), out = new Uint8Array(cols * rows)
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) if (m[r * t.cols + c]) out[Math.floor(r / f) * cols + Math.floor(c / f)] = 1
  return { g: { res: t.res * f, x0: t.x0, z0: t.z0, cols, rows }, m: out }
}

/** Upright boxes over [x0, z0, x1, z1] footprints as one geometry: group 0 the sides, group 1 the tops (and the
 * undersides with `under`). UVs in metres, like Batch's worldUV. */
export function prisms(boxes: B4[], y0: number, y1: number, under = false) {
  const per = under ? 6 : 5, n = boxes.length
  const pos = new Float32Array(n * per * 12), nor = new Float32Array(n * per * 12), uv = new Float32Array(n * per * 8)
  const sides = new Uint32Array(n * 24), caps = new Uint32Array(n * (under ? 12 : 6))
  let v = 0, si = 0, ci = 0
  const quad = (pts: number[][], nx: number, ny: number, nz: number, cap: boolean) => {
    for (const p of pts) {
      pos.set(p, v * 3); nor.set([nx, ny, nz], v * 3)
      uv.set(ny ? [p[0], p[2]] : nx ? [p[2], p[1]] : [p[0], p[1]], v * 2)
      v++
    }
    const a = v - 4, idx = [a, a + 1, a + 2, a, a + 2, a + 3]
    if (cap) { caps.set(idx, ci); ci += 6 } else { sides.set(idx, si); si += 6 }
  }
  for (const [x0, z0, x1, z1] of boxes) {
    quad([[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], 0, 1, 0, true)
    if (under) quad([[x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y0, z0]], 0, -1, 0, true)
    quad([[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], 0, 0, -1, false)
    quad([[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]], 0, 0, 1, false)
    quad([[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]], -1, 0, 0, false)
    quad([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], 1, 0, 0, false)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  const index = new Uint32Array(si + ci); index.set(sides.subarray(0, si)); index.set(caps.subarray(0, ci), si)
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.addGroup(0, si, 0); g.addGroup(si, ci, 1)
  g.computeBoundingSphere()
  return g
}

const mesh = (g: any, mats: any, shadow: boolean) => { const m = new THREE.Mesh(g, mats); m.castShadow = shadow; m.receiveShadow = true; return m }

/** Outline boxes of a storey (coarse), for its slab, its roof and the picture on its floor. */
export const outlineBoxes = (t: Traced) => { const p = pooled(t, t.foot, 0.3); return boxesOf(p.g, p.m) }

/** The outline grown by `margin` metres, in boxes of about a metre: the paved apron around the building. */
export function apronBoxes(t: Traced, margin: number) {
  const p = pooled(t, t.foot, 1), pad = Math.max(1, Math.round(margin / p.g.res))
  const g: Grid = { ...p.g, x0: p.g.x0 - pad * p.g.res, z0: p.g.z0 - pad * p.g.res, cols: p.g.cols + 2 * pad, rows: p.g.rows + 2 * pad }
  const m = new Uint8Array(g.cols * g.rows)
  for (let r = 0; r < p.g.rows; r++) for (let c = 0; c < p.g.cols; c++) if (p.m[r * p.g.cols + c]) m[(r + pad) * g.cols + c + pad] = 1
  return boxesOf(g, dilate(m, g, pad))
}

/** Walls, lintels and the floor slab of a storey with traced walls. */
export function tracedStorey(t: Traced, wallH: number, M: { side: any; cap: any; slab: any; floor: any }) {
  const out: any[] = []
  if (t.hasWalls) {
    const tall = t.low ? t.wall.map((v, i) => (v && !t.low![i] ? 1 : 0)) : t.wall
    out.push(mesh(prisms(boxesOf(t, tall), 0, wallH), [M.side, M.cap], true))
    if (t.low?.some(v => v)) out.push(mesh(prisms(boxesOf(t, t.low), 0, Math.min(1.1, wallH)), [M.side, M.cap], true))
    // doors cut for the walking graph: a lintel above the opening, the opening itself walkable
    const lint = new Uint8Array(t.cut.length)
    for (let i = 0; i < lint.length; i++) lint[i] = t.cut[i] && !t.wall[i] ? 1 : 0
    const lb = boxesOf(t, lint)
    if (lb.length) out.push(mesh(prisms(lb, DOOR_H, wallH, true), [M.side, M.cap], true))
    const ob = outlineBoxes(t)
    if (ob.length) out.push(mesh(prisms(ob, -SLAB, 0.001), [M.slab, M.floor], false))
  }
  return out
}

/** The plan picture on a storey's floor, cut to the building's outline; its texture is loaded by the engine. */
export function planOverlay(t: Traced) {
  const p = t.plan
  if (!p) return null
  const quads: B4[] = []
  for (const [x0, z0, x1, z1] of outlineBoxes(t)) {
    const a = Math.max(x0, p.x), b = Math.max(z0, p.z), c = Math.min(x1, p.x + p.w), d = Math.min(z1, p.z + p.h)
    if (c > a && d > b) quads.push([a, b, c, d])
  }
  if (!quads.length) return null
  const y = 0.03, pos = new Float32Array(quads.length * 12), uv = new Float32Array(quads.length * 8), idx = new Uint32Array(quads.length * 6)
  quads.forEach(([x0, z0, x1, z1], k) => {
    pos.set([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0], k * 12)
    const U = (x: number) => (x - p.x) / p.w, V = (z: number) => 1 - (z - p.z) / p.h
    uv.set([U(x0), V(z0), U(x0), V(z1), U(x1), V(z1), U(x1), V(z0)], k * 8)
    idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6)
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(quads.length * 12).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  g.computeBoundingSphere()
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.82, metalness: 0, transparent: true, opacity: 0.88, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
  mat.envMapIntensity = 0.35
  const m = new THREE.Mesh(g, mat)
  m.receiveShadow = true; m.renderOrder = 1; m.visible = false // shown once the picture has loaded
  m.userData.url = p.url
  return m
}
