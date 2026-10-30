/* eslint-disable @typescript-eslint/no-explicit-any */
// Builds the 3D building and campus from layout.ts. Static geometry is merged per material so a
// whole storey draws in a few dozen calls.
import * as THREE from 'three'
import { mergeGeometries } from '../vendor/three/addons/utils/BufferGeometryUtils.js'
import {
  FH, SLAB, WALL_H, WALL_T, DOOR_H, LEVELS, ROOMS, STAIRS, EXITS, LOBBY, CORRIDOR, FOOTPRINT,
  rect, type Rect, type Room,
} from './layout.ts'
import { type Mats, labelTex, mulberry32 } from './materials.ts'

export type Seat = { x: number; z: number; yaw: number; sit: boolean; room: string; level: number }

/** UVs in metres so textures keep their real size on every box. */
export function worldUV(g: any) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv
  for (let i = 0; i < p.count; i++) {
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i))
    if (ny >= nx && ny >= nz) uv.setXY(i, p.getX(i), p.getZ(i))
    else if (nx >= nz) uv.setXY(i, p.getZ(i), p.getY(i))
    else uv.setXY(i, p.getX(i), p.getY(i))
  }
}

const UP = new THREE.Vector3(0, 1, 0)
export class Batch {
  m = new Map<any, any[]>()
  add(mat: any, g: any) {
    if (!mat.userData.keepUV) worldUV(g)
    let list = this.m.get(mat)
    if (!list) { list = []; this.m.set(mat, list) }
    list.push(g)
  }
  box(mat: any, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) {
    const g = new THREE.BoxGeometry(w, h, d); if (ry) g.rotateY(ry); g.translate(x, y, z); this.add(mat, g)
  }
  ext(mat: any, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
    this.box(mat, Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
  }
  cyl(mat: any, r0: number, r1: number, h: number, x: number, y: number, z: number, seg = 14) {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg); g.translate(x, y, z); this.add(mat, g)
  }
  sph(mat: any, r: number, x: number, y: number, z: number, sy = 1, seg = 8) {
    const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2)); g.scale(1, sy, 1); g.translate(x, y, z); this.add(mat, g)
  }
  floor(mat: any, r: Rect, y = 0.012) {
    const g = new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0); g.rotateX(-Math.PI / 2); g.translate((r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2); this.add(mat, g)
  }
  rod(mat: any, r: number, a: [number, number, number], b: [number, number, number], seg = 8) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A), len = d.length()
    const g = new THREE.CylinderGeometry(r, r, len, seg)
    g.applyMatrix4(new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), new THREE.Vector3(1, 1, 1)))
    this.add(mat, g)
  }
  tilted(mat: any, w: number, t: number, len: number, x: number, y: number, z: number, angle: number) {
    const g = new THREE.BoxGeometry(w, t, len); g.rotateX(angle); g.translate(x, y, z); this.add(mat, g)
  }
  flush(group: any, shadows = true) {
    for (const [mat, gs] of this.m) {
      const g = mergeGeometries(gs); gs.forEach(x => x.dispose())
      const mesh = new THREE.Mesh(g, mat)
      mesh.castShadow = shadows && !mat.transparent && !mat.userData.noShadow && !(mat instanceof THREE.MeshBasicMaterial)
      mesh.receiveShadow = !(mat instanceof THREE.MeshBasicMaterial)
      group.add(mesh)
    }
    this.m.clear()
  }
}

// ---------- walls ----------
type Gap = { c: number; w: number; h: number; type: 'room' | 'stair' | 'exit' | 'glass' | 'open'; into: 1 | -1 }
type Seg = { axis: 'x' | 'z'; f: number; a: number; b: number; gaps: Gap[]; ext?: 1 | -1; curtain?: boolean }

function segsFor(L: number): Seg[] {
  const rooms = ROOMS.filter(r => r.level === L)
  const north = rooms.filter(r => r.side === 'N'), south = rooms.filter(r => r.side === 'S')
  const segs: Seg[] = []
  const doorGaps = (rs: Room[], into: 1 | -1): Gap[] => rs.flatMap(r => r.doors.map(c => ({ c, w: 1.6, h: DOOR_H, type: 'room' as const, into })))
  segs.push({ axis: 'x', f: -2, a: -20, b: 20, gaps: [...doorGaps(north, -1), { c: 0, w: 4.4, h: 2.7, type: 'open', into: -1 }] })
  const sg = doorGaps(south, 1)
  if (L === 0) {
    segs.push({ axis: 'x', f: 2, a: -20, b: LOBBY.x0, gaps: sg.filter(g => g.c < 0) })
    segs.push({ axis: 'x', f: 2, a: LOBBY.x1, b: 20, gaps: sg.filter(g => g.c > 0) })
  } else segs.push({ axis: 'x', f: 2, a: -20, b: 20, gaps: sg })
  const px = new Set<number>([-3, 3, 5.5]); for (const r of north) { px.add(r.r.x0); px.add(r.r.x1) }
  for (const x of px) if (Math.abs(x) < 20) segs.push({ axis: 'z', f: x, a: -12, b: -2, gaps: [] })
  const sx = new Set<number>(); for (const r of south) { sx.add(r.r.x0); sx.add(r.r.x1) }
  if (L === 0) { sx.add(LOBBY.x0); sx.add(LOBBY.x1) }
  for (const x of sx) if (Math.abs(x) < 20) segs.push({ axis: 'z', f: x, a: 2, b: 12, gaps: [] })
  // outside
  const nExit = EXITS.find(e => e.id === 'NORTH')!
  segs.push({ axis: 'x', f: -12, a: -20, b: 20, ext: -1, gaps: L === 0 ? [{ c: nExit.door[0], w: nExit.width, h: DOOR_H, type: 'exit', into: -1 }] : [] })
  if (L === 0) {
    segs.push({ axis: 'x', f: 12, a: -20, b: LOBBY.x0, ext: 1, gaps: [] })
    segs.push({ axis: 'x', f: 12, a: LOBBY.x0, b: LOBBY.x1, ext: 1, curtain: true, gaps: [{ c: 0, w: 3.2, h: 2.6, type: 'glass', into: 1 }] })
    segs.push({ axis: 'x', f: 12, a: LOBBY.x1, b: 20, ext: 1, gaps: [] })
  } else segs.push({ axis: 'x', f: 12, a: -20, b: 20, ext: 1, gaps: [] })
  const sd = (into: 1 | -1): Gap[] => [{ c: 0, w: 2.4, h: DOOR_H + 0.1, type: 'stair', into }]
  segs.push({ axis: 'z', f: -20, a: -12, b: -2, ext: -1, gaps: [] }, { axis: 'z', f: -20, a: -2, b: 10, gaps: sd(-1) }, { axis: 'z', f: -20, a: 10, b: 12, ext: -1, gaps: [] })
  segs.push({ axis: 'z', f: 20, a: -12, b: -10, ext: 1, gaps: [] }, { axis: 'z', f: 20, a: -10, b: 2, gaps: sd(1) }, { axis: 'z', f: 20, a: 2, b: 12, ext: 1, gaps: [] })
  const exitGap = (into: 1 | -1): Gap[] => L === 0 ? [{ c: 0, w: 1.8, h: DOOR_H, type: 'exit', into }] : []
  segs.push({ axis: 'z', f: -26, a: -2, b: 10, ext: -1, gaps: exitGap(-1) }, { axis: 'x', f: -2, a: -26, b: -20, ext: -1, gaps: [] }, { axis: 'x', f: 10, a: -26, b: -20, ext: 1, gaps: [] })
  segs.push({ axis: 'z', f: 26, a: -10, b: 2, ext: 1, gaps: exitGap(1) }, { axis: 'x', f: 2, a: 20, b: 26, ext: 1, gaps: [] }, { axis: 'x', f: -10, a: 20, b: 26, ext: -1, gaps: [] })
  return segs
}

function buildWalls(b: Batch, M: Mats, L: number) {
  for (const s of segsFor(L)) {
    const piece = (p0: number, p1: number, y0: number, y1: number, mat: any, thick = WALL_T, off = 0) => {
      if (p1 - p0 < 0.005 || y1 - y0 < 0.005) return
      if (s.axis === 'x') b.box(mat, p1 - p0, y1 - y0, thick, (p0 + p1) / 2, (y0 + y1) / 2, s.f + off)
      else b.box(mat, thick, y1 - y0, p1 - p0, s.f + off, (y0 + y1) / 2, (p0 + p1) / 2)
    }
    const layered = (p0: number, p1: number, y0: number, y1: number) => {
      if (!s.ext) return piece(p0, p1, y0, y1, M.plaster)
      piece(p0, p1, y0, y1, M.cladding, WALL_T / 2, s.ext * WALL_T / 4)
      piece(p0, p1, y0, y1, M.plaster, WALL_T / 2, -s.ext * WALL_T / 4)
    }
    const windowed = (p0: number, p1: number) => {
      const len = p1 - p0
      if (len < 2.2) return layered(p0, p1, 0, WALL_H)
      const n = Math.max(1, Math.round((len - 0.7) / 2.7)), pier = 0.7, ww = (len - pier * (n + 1)) / n
      layered(p0, p1, 0, 0.9); layered(p0, p1, 2.5, WALL_H)
      for (let k = 0; k <= n; k++) { const x = p0 + k * (ww + pier); layered(x, x + pier, 0.9, 2.5) }
      for (let k = 0; k < n; k++) {
        const w0 = p0 + pier + k * (ww + pier), w1 = w0 + ww, mid = (w0 + w1) / 2
        piece(w0, w1, 0.9, 2.5, M.glass, 0.03)
        piece(w0, w1, 0.9, 0.96, M.frame, 0.14); piece(w0, w1, 2.44, 2.5, M.frame, 0.12)
        piece(mid - 0.03, mid + 0.03, 0.96, 2.44, M.frame, 0.08)
        piece(w0 - 0.06, w1 + 0.06, 0.84, 0.9, M.concrete, 0.16, (s.ext ?? 1) * 0.15)
      }
    }
    const curtain = (p0: number, p1: number) => {
      piece(p0, p1, 0, 0.12, M.frame, 0.25)
      piece(p0, p1, WALL_H - 0.45, WALL_H, M.claddingDark)
      piece(p0, p1, 0.12, WALL_H - 0.45, M.glass, 0.04)
      piece(p0, p1, 2.6, 2.66, M.frame, 0.12)
      for (let x = p0; x <= p1 + 0.01; x += (p1 - p0) / Math.max(1, Math.round((p1 - p0) / 1.5))) piece(x - 0.04, x + 0.04, 0.12, WALL_H - 0.45, M.frame, 0.14)
    }
    const gaps = [...s.gaps].sort((p, q) => p.c - q.c)
    let cur = s.a
    const solids: [number, number][] = []
    for (const g of gaps) { const g0 = g.c - g.w / 2; if (g0 > cur) solids.push([cur, g0]); cur = Math.max(cur, g.c + g.w / 2) }
    if (s.b > cur) solids.push([cur, s.b])
    for (const [p0, p1] of solids) {
      if (s.curtain) curtain(p0, p1)
      else if (s.ext) windowed(p0, p1)
      else layered(p0, p1, 0, WALL_H)
    }

    for (const g of gaps) {
      const g0 = g.c - g.w / 2, g1 = g.c + g.w / 2
      if (s.curtain) piece(g0, g1, g.h, WALL_H - 0.45, M.glass, 0.04)
      else layered(g0, g1, g.h, WALL_H)
      if (g.type === 'open') { piece(g0, g1, g.h - 0.08, g.h, M.frame, WALL_T + 0.04); continue }
      // frame
      piece(g0 - 0.06, g0, 0, g.h, M.frame, WALL_T + 0.05); piece(g1, g1 + 0.06, 0, g.h, M.frame, WALL_T + 0.05)
      piece(g0 - 0.06, g1 + 0.06, g.h - 0.06, g.h, M.frame, WALL_T + 0.05)
      // leaves, held open
      const leafMat = g.type === 'room' ? M.wood : g.type === 'glass' ? M.glass : M.greyMetal
      if (g.type === 'glass') {
        piece(g0 - 1.3, g0 + 0.05, 0.12, g.h, M.glass, 0.04, g.into * 0.09); piece(g1 - 0.05, g1 + 1.3, 0.12, g.h, M.glass, 0.04, g.into * 0.09)
        piece(g0 - 1.3, g0 + 0.05, g.h - 0.05, g.h, M.frame, 0.06, g.into * 0.09); piece(g1 - 0.05, g1 + 1.3, g.h - 0.05, g.h, M.frame, 0.06, g.into * 0.09)
        continue
      }
      const lw = g.w / 2 - 0.04, lh = g.h - 0.08
      for (const [hinge, dir] of [[g0, 1], [g1, -1]] as const) {
        const hx = hinge + dir * 0.04, depth = g.into * (WALL_T / 2 + lw / 2)
        if (s.axis === 'x') b.box(leafMat, 0.05, lh, lw, hx, lh / 2, s.f + depth)
        else b.box(leafMat, lw, lh, 0.05, s.f + depth, lh / 2, hx)
        // push bar / handle
        if (s.axis === 'x') b.box(M.steel, 0.08, 0.04, lw * 0.7, hx + dir * 0.05, 1.0, s.f + depth)
        else b.box(M.steel, lw * 0.7, 0.04, 0.08, s.f + depth, 1.0, hx + dir * 0.05)
      }
    }
  }
}

// ---------- furniture ----------
export type Kit = ReturnType<typeof kit>
export function kit(b: Batch, M: Mats, seats: Seat[], level: number, rnd: () => number) {
  const rot = (lx: number, lz: number, yaw: number): [number, number] => [lx * Math.cos(yaw) + lz * Math.sin(yaw), -lx * Math.sin(yaw) + lz * Math.cos(yaw)]
  const pb = (mat: any, w: number, h: number, d: number, x: number, z: number, yaw: number, lx: number, ly: number, lz: number) => {
    const [ox, oz] = rot(lx, lz, yaw); b.box(mat, w, h, d, x + ox, ly, z + oz, yaw)
  }
  const seat = (room: string, x: number, z: number, yaw: number, sit = true) => seats.push({ x, z, yaw, sit, room, level })
  const K = {
    pb, seat,
    chair(x: number, z: number, yaw: number, fabric: any = M.fabricBlue) {
      pb(fabric, 0.46, 0.07, 0.44, x, z, yaw, 0, 0.46, 0); pb(fabric, 0.46, 0.48, 0.06, x, z, yaw, 0, 0.74, -0.21)
      for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pb(M.darkMetal, 0.03, 0.45, 0.03, x, z, yaw, a * 0.2, 0.225, c * 0.18)
    },
    officeChair(x: number, z: number, yaw: number) {
      pb(M.fabricGrey, 0.5, 0.08, 0.48, x, z, yaw, 0, 0.5, 0); pb(M.fabricGrey, 0.46, 0.56, 0.07, x, z, yaw, 0, 0.84, -0.24)
      b.cyl(M.darkMetal, 0.03, 0.03, 0.42, x, 0.27, z, 8); b.cyl(M.darkMetal, 0.28, 0.28, 0.04, x, 0.05, z, 10)
    },
    desk(x: number, z: number, w: number, d: number, yaw: number, top: any = M.whiteLam) {
      pb(top, w, 0.04, d, x, z, yaw, 0, 0.74, 0)
      for (const [a, c] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) pb(M.greyMetal, 0.04, 0.72, 0.04, x, z, yaw, a * (w / 2 - 0.05), 0.36, c * (d / 2 - 0.05))
    },
    monitor(x: number, z: number, yaw: number, screen: any = M.screenCode) {
      pb(M.black, 0.56, 0.35, 0.03, x, z, yaw, 0, 1.02, 0); pb(screen, 0.52, 0.31, 0.006, x, z, yaw, 0, 1.02, 0.018)
      pb(M.darkMetal, 0.05, 0.2, 0.05, x, z, yaw, 0, 0.85, -0.03); pb(M.darkMetal, 0.22, 0.02, 0.16, x, z, yaw, 0, 0.77, -0.03)
    },
    plant(x: number, z: number, s = 1) {
      b.cyl(M.pot, 0.2 * s, 0.15 * s, 0.42 * s, x, 0.21 * s, z, 12)
      b.sph(M.plant, 0.36 * s, x, 0.74 * s, z, 1.1); b.sph(M.plantDark, 0.26 * s, x + 0.12 * s, 0.98 * s, z - 0.08 * s, 1.2)
    },
    shelf(x: number, z: number, w: number, yaw: number, both = false) {
      pb(M.woodDark, w, 2.0, 0.36, x, z, yaw, 0, 1.0, 0); pb(M.books, w - 0.06, 1.9, 0.01, x, z, yaw, 0, 1.0, 0.185)
      if (both) pb(M.books, w - 0.06, 1.9, 0.01, x, z, yaw + Math.PI, 0, 1.0, 0.185)
    },
    sofa(x: number, z: number, w: number, yaw: number, mat: any = M.fabricTeal) {
      pb(mat, w, 0.42, 0.85, x, z, yaw, 0, 0.21, 0); pb(mat, w, 0.45, 0.2, x, z, yaw, 0, 0.62, -0.33)
      pb(mat, 0.18, 0.62, 0.85, x, z, yaw, -(w / 2 - 0.09), 0.31, 0); pb(mat, 0.18, 0.62, 0.85, x, z, yaw, w / 2 - 0.09, 0.31, 0)
    },
    roundTable(x: number, z: number, r: number) {
      b.cyl(M.whiteLam, r, r, 0.04, x, 0.74, z, 24); b.cyl(M.darkMetal, 0.04, 0.04, 0.72, x, 0.36, z, 8); b.cyl(M.darkMetal, 0.28, 0.28, 0.03, x, 0.015, z, 16)
    },
    stool(x: number, z: number, mat: any = M.fabricRed) { b.cyl(mat, 0.2, 0.2, 0.06, x, 0.46, z, 12); b.cyl(M.darkMetal, 0.025, 0.025, 0.44, x, 0.22, z, 6) },
    cabinet(x: number, z: number, yaw: number, w = 1.0, h = 1.2) {
      pb(M.greyMetal, w, h, 0.45, x, z, yaw, 0, h / 2, 0)
      pb(M.darkMetal, 0.02, h - 0.1, 0.01, x, z, yaw, 0, h / 2, 0.23)
    },
    extinguisher(x: number, z: number) { b.cyl(M.red, 0.09, 0.09, 0.5, x, 0.55, z, 10); b.cyl(M.black, 0.035, 0.035, 0.1, x, 0.85, z, 6); b.box(M.red, 0.2, 0.04, 0.2, x, 0.02, z) },
    strobe(x: number, y: number, z: number) { b.box(M.strobe, 0.16, 0.12, 0.16, x, y, z) },
    exitSign(x: number, y: number, z: number, yaw: number, hang = false) {
      pb(M.exitSign, 0.92, 0.3, 0.06, x, z, yaw, 0, y, 0)
      if (hang) for (const s of [-0.35, 0.35]) pb(M.darkMetal, 0.015, WALL_H - y - 0.15, 0.015, x, z, yaw, s, (WALL_H + y + 0.15) / 2, 0)
    },
    bed(x: number, z: number, yaw: number) {
      pb(M.steel, 0.95, 0.42, 2.0, x, z, yaw, 0, 0.25, 0); pb(M.bedding, 0.9, 0.16, 1.94, x, z, yaw, 0, 0.54, 0)
      pb(M.whiteLam, 0.6, 0.1, 0.35, x, z, yaw, 0, 0.66, -0.74); pb(M.steel, 0.95, 0.5, 0.05, x, z, yaw, 0, 0.7, -1.0)
    },
    rack(x: number, z: number, yaw: number) { pb(M.black, 0.6, 2.0, 1.0, x, z, yaw, 0, 1.0, 0); pb(M.rackFront, 0.56, 1.9, 0.006, x, z, yaw, 0, 1.0, 0.503) },
    boxes(x: number, z: number) {
      const n = 1 + Math.floor(rnd() * 3)
      for (let k = 0; k < n; k++) { const s = 0.35 + rnd() * 0.25; b.box(M.cardboard, s, s * 0.8, s, x + (rnd() - 0.5) * 0.3, s * 0.4 + k * s * 0.8, z + (rnd() - 0.5) * 0.3, rnd() * 0.5) }
    },
    rnd,
  }
  return K
}

function furnishRoom(K: Kit, M: Mats, b: Batch, r: Room) {
  const { x0, x1, z0, z1 } = r.r
  const into = r.side === 'N' ? -1 : 1
  const wz = r.side === 'N' ? z1 : z0, back = r.side === 'N' ? z0 : z1
  const near = wz + into * 1.9, far = back - into * 0.7
  const zlo = Math.min(near, far), zhi = Math.max(near, far), zc = (zlo + zhi) / 2
  const faceBack = into > 0 ? 0 : Math.PI // yaw that faces the back wall
  const W = Math.PI / 2
  // cove light along the back wall top
  b.box(M.lightStrip, x1 - x0 - 0.6, 0.05, 0.05, (x0 + x1) / 2, WALL_H - 0.12, back - into * 0.16)

  switch (r.kind) {
    case 'seminar': {
      b.ext(M.woodDark, x0 + 0.1, 0, z0 + 0.1, x0 + 2.6, 0.35, z1 - 0.1)
      b.box(M.ledBlue, 0.04, 0.03, z1 - z0 - 0.4, x0 + 2.62, 0.33, (z0 + z1) / 2)
      b.box(M.screenSlide, 0.03, 2.9, 5.2, x0 + 0.14, 1.95, 7.1)
      b.box(M.black, 0.05, 3.1, 5.4, x0 + 0.12, 1.95, 7.1)
      b.box(M.woodDark, 0.6, 1.1, 0.5, x0 + 3.1, 0.55, 4.0); b.box(M.black, 0.04, 0.3, 0.03, x0 + 3.1, 1.2, 4.0)
      for (const z of [z0 + 0.6, z1 - 0.6]) { b.box(M.black, 0.5, 1.1, 0.5, x0 + 0.6, 0.9, z); K.plant(x0 + 1.6, z, 1.3) }
      for (let x = x0 + 3.2; x < x1 - 0.6; x += 1.8) b.box(x % 3.6 < 1.8 ? M.fabricGrey : M.fabricBlue, 1.2, 2.0, 0.06, x, 1.6, z1 - 0.13)
      K.seat(r.id, x0 + 3.0, 5.0, W, false)
      const rows: number[] = [], cols = [3.75, 4.35, 4.95, 5.55, 6.15, 8.0, 8.6, 9.2, 9.8, 10.4, 11.0]
      for (let x = x0 + 4.4; x < x1 - 1.4; x += 1.25) rows.push(x)
      for (const x of rows) for (const z of cols) { K.chair(x, z, -W); K.seat(r.id, x - 0.04, z, -W) }
      b.box(M.whiteLam, 1.6, 0.04, 0.7, x1 - 0.9, 0.9, z1 - 1.4); b.cyl(M.steel, 0.15, 0.15, 0.5, x1 - 0.7, 1.15, z1 - 1.4, 10)
      break
    }
    case 'classroom': {
      b.box(M.whiteboard, 0.03, 1.2, Math.min(4.2, zhi - zlo), x0 + 0.13, 1.5, zc)
      K.desk(x0 + 1.6, zc, 0.7, 1.5, 0, M.wood); K.officeChair(x0 + 1.0, zc + 0.3, W)
      K.seat(r.id, x0 + 2.4, zc - 0.9, W, false)
      for (let x = x0 + 3.4; x <= x1 - 1.0; x += 1.7) for (let z = zlo + 0.7; z <= zhi - 0.6; z += 1.55) {
        K.desk(x, z, 0.55, 1.25, 0, M.wood)
        for (const dz of [-0.3, 0.3]) { K.chair(x + 0.5, z + dz, -W, M.fabricTeal); K.seat(r.id, x + 0.46, z + dz, -W) }
      }
      K.cabinet(x1 - 0.8, back - into * 0.3, faceBack + Math.PI, 1.4, 1.8); K.plant(x1 - 0.6, wz + into * 1.2, 1.1)
      b.box(M.cork, 1.4, 1.0, 0.03, (x0 + x1) / 2, 1.6, back - into * 0.13)
      break
    }
    case 'lab': {
      b.box(M.whiteboard, 0.03, 1.2, 3.6, x0 + 0.13, 1.5, zc)
      const personYaw = into > 0 ? 0 : Math.PI
      for (let z = zlo + 0.5; z <= zhi - 0.2; z += 2.3) {
        K.desk((x0 + x1) / 2 + 0.5, z, x1 - x0 - 3.2, 0.75, 0)
        for (let x = x0 + 2.4; x <= x1 - 1.4; x += 1.3) {
          K.monitor(x, z + into * 0.12, personYaw + Math.PI)
          const sz = z - into * 0.68; K.officeChair(x, sz, personYaw); K.seat(r.id, x, sz + into * 0.06, personYaw)
        }
      }
      K.rack(x1 - 0.6, back - into * 0.6, -W); K.plant(x0 + 0.6, back - into * 0.6)
      break
    }
    case 'office': {
      const xs: number[] = []; for (let x = x0 + 1.7; x <= x1 - 1.3; x += 3.0) xs.push(x)
      for (const x of xs) for (let z = zlo + 1.0; z <= zhi - 0.8; z += 2.8) {
        for (const s of [-1, 1]) {
          K.desk(x, z + s * 0.36, 1.4, 0.7, 0); K.monitor(x, z + s * 0.2, s > 0 ? 0 : Math.PI, M.screenTV)
          const py = s > 0 ? Math.PI : 0
          K.officeChair(x, z + s * 1.0, py); K.seat(r.id, x, z + s * 0.96, py)
        }
      }
      for (let x = x0 + 0.8; x < x1 - 0.6; x += 1.1) K.cabinet(x, back - into * 0.3, faceBack + Math.PI)
      K.plant(x1 - 0.6, wz + into * 1.0, 1.2)
      break
    }
    case 'library': {
      const split = x0 + (x1 - x0) * 0.48
      for (let x = x0 + 1.4; x < split; x += 1.7) K.shelf(x, zc, zhi - zlo - 0.4, W, true)
      for (let x = x0 + 0.8; x < x1 - 0.6; x += 2.0) K.shelf(x, back - into * 0.22, 1.9, faceBack + Math.PI)
      for (let x = split + 1.3; x < x1 - 1.0; x += 2.6) for (let z = zlo + 0.8; z <= zhi - 0.6; z += 2.4) {
        K.desk(x, z, 1.8, 0.9, 0, M.wood)
        for (const dx of [-0.45, 0.45]) for (const s of [-1, 1]) { const py = s > 0 ? Math.PI : 0; K.chair(x + dx, z + s * 0.7, py, M.fabricRed); K.seat(r.id, x + dx, z + s * 0.66, py) }
      }
      b.ext(M.counter, split - 0.4, 0, wz + into * 0.9, split + 1.6, 1.0, wz + into * 1.5)
      K.seat(r.id, split + 0.6, wz + into * 1.9, into > 0 ? Math.PI : 0, false)
      break
    }
    case 'staff': {
      b.ext(M.counter, x0 + 0.5, 0, back - into * 0.65, x0 + 5.5, 0.92, back - into * 0.05)
      b.ext(M.whiteLam, x0 + 0.5, 1.6, back - into * 0.4, x0 + 5.5, 2.3, back - into * 0.05)
      b.ext(M.steel, x0 + 5.7, 0, back - into * 0.75, x0 + 6.5, 1.9, back - into * 0.05)
      K.sofa(x1 - 2.2, back - into * 0.6, 2.4, faceBack + Math.PI); K.sofa(x1 - 0.7, zc, 2.0, -W)
      b.box(M.wood, 1.2, 0.4, 0.7, x1 - 2.2, 0.2, zc)
      K.seat(r.id, x1 - 2.7, back - into * 0.75, faceBack + Math.PI); K.seat(r.id, x1 - 1.6, back - into * 0.75, faceBack + Math.PI)
      K.desk(x0 + 3.0, zc, 2.2, 1.0, 0, M.wood)
      for (const dx of [-0.7, 0, 0.7]) for (const s of [-1, 1]) { const py = s > 0 ? Math.PI : 0; K.chair(x0 + 3.0 + dx, zc + s * 0.75, py, M.fabricGrey); K.seat(r.id, x0 + 3.0 + dx, zc + s * 0.71, py) }
      K.plant(x0 + 0.6, wz + into * 1.0, 1.2)
      break
    }
    case 'cafeteria': {
      b.ext(M.counter, x0 + 0.8, 0, back - into * 1.3, x0 + 8.5, 1.0, back - into * 0.5)
      b.ext(M.steel, x0 + 0.8, 1.0, back - into * 1.3, x0 + 8.5, 1.04, back - into * 0.5)
      b.box(M.menu, 4.0, 1.0, 0.04, x0 + 4.6, 2.3, back - into * 0.14)
      K.seat(r.id, x0 + 3.0, back - into * 0.25, faceBack + Math.PI, false); K.seat(r.id, x0 + 6.0, back - into * 0.25, faceBack + Math.PI, false)
      for (const dx of [0, 1.0]) { b.box(M.vend, 0.9, 1.8, 0.04, x1 - 1.0 - dx, 0.95, back - into * 0.82); b.ext(M.darkMetal, x1 - 1.45 - dx, 0, back - into * 0.1, x1 - 0.55 - dx, 1.9, back - into * 0.8) }
      for (let x = x0 + 2.0; x <= x1 - 1.4; x += 2.7) for (let z = zlo + 0.6; z <= zhi - 1.6; z += 2.6) {
        K.roundTable(x, z, 0.55)
        for (let k = 0; k < 4; k++) { const a = k * W + 0.4, sx = x + Math.sin(a) * 0.85, sz = z + Math.cos(a) * 0.85; K.stool(sx, sz); K.seat(r.id, sx, sz, a + Math.PI) }
      }
      break
    }
    case 'clinic': {
      for (let k = 0; k < 3; k++) {
        const x = x0 + 1.6 + k * 2.6
        K.bed(x, back - into * 1.2, faceBack + Math.PI)
        b.box(M.curtain, 0.02, 1.8, 2.4, x + 1.3, 1.1, back - into * 1.3)
        if (k < 2) K.seat(r.id, x + 0.6, back - into * 1.4, W)
      }
      K.desk(x1 - 2.0, zc, 1.4, 0.7, 0); K.officeChair(x1 - 2.0, zc + into * 0.6, faceBack + Math.PI); K.monitor(x1 - 2.0, zc - into * 0.1, faceBack, M.screenTV)
      K.seat(r.id, x1 - 3.0, zc + into * 0.4, -W, false)
      K.cabinet(x1 - 0.5, back - into * 0.4, -W, 1.0, 1.9); b.box(M.cross, 0.5, 0.5, 0.02, x1 - 0.12, 2.3, back - into * 0.4)
      break
    }
    case 'meeting': {
      K.desk((x0 + x1) / 2, zc, 3.6, 1.3, 0, M.woodDark)
      for (let k = 0; k < 3; k++) for (const s of [-1, 1]) {
        const x = (x0 + x1) / 2 - 1.2 + k * 1.2, py = s > 0 ? Math.PI : 0
        K.officeChair(x, zc + s * 0.95, py); K.seat(r.id, x, zc + s * 0.9, py)
      }
      b.box(M.screenTV, 0.04, 1.1, 1.9, x1 - 0.14, 1.6, zc); b.box(M.black, 0.05, 1.2, 2.0, x1 - 0.12, 1.6, zc)
      K.plant(x0 + 0.6, back - into * 0.6, 1.1)
      break
    }
    case 'server': {
      for (let z = zlo + 0.5; z <= zhi - 0.4; z += 2.4) for (let x = x0 + 1.0; x <= x1 - 1.0; x += 0.62) K.rack(x, z, faceBack)
      K.seat(r.id, x0 + 1.4, zlo - into * 0.8, faceBack, false); K.seat(r.id, x1 - 1.3, zhi + 0.6 * into, faceBack, false)
      break
    }
    case 'store': {
      for (let x = x0 + 0.8; x < x1 - 0.5; x += 1.4) {
        b.ext(M.greyMetal, x - 0.6, 0, back - into * 0.1, x + 0.6, 2.2, back - into * 0.7)
        for (let k = 0; k < 4; k++) K.boxes(x + (K.rnd() - 0.5) * 0.6, back - into * (1.4 + K.rnd()))
      }
      break
    }
    case 'pantry': {
      b.ext(M.counter, x0 + 0.4, 0, back - into * 0.65, x1 - 1.4, 0.92, back - into * 0.05)
      b.ext(M.steel, x1 - 1.2, 0, back - into * 0.75, x1 - 0.4, 1.9, back - into * 0.05)
      K.roundTable((x0 + x1) / 2, zc, 0.5); K.stool((x0 + x1) / 2 - 0.8, zc); K.stool((x0 + x1) / 2 + 0.8, zc)
      K.seat(r.id, (x0 + x1) / 2 - 0.8, zc, W); K.seat(r.id, (x0 + x1) / 2 + 0.8, zc, -W)
      break
    }
    case 'service': {
      for (let k = 0; k < 4; k++) K.boxes(x0 + 0.45, back - into * (0.8 + k * 1.6))
      break
    }
  }
  if (r.kind !== 'server' && r.kind !== 'store' && r.kind !== 'service') K.plant(x0 + 0.6, wz + into * 0.7, 0.9)
}

function floorMat(M: Mats, r: Room) {
  return ({ seminar: M.carpetBlue, classroom: M.vinyl, lab: M.epoxy, office: M.carpetGrey, library: M.woodFloor, staff: M.carpetRed,
    cafeteria: M.checker, clinic: M.epoxy, meeting: M.carpetGrey, server: M.epoxy, store: M.concrete, pantry: M.checker, service: M.concrete } as Record<string, any>)[r.kind]
}

function corridorDecor(K: Kit, M: Mats, b: Batch, L: number) {
  const rooms = ROOMS.filter(r => r.level === L)
  const doors = { N: rooms.filter(r => r.side === 'N').flatMap(r => r.doors), S: rooms.filter(r => r.side === 'S').flatMap(r => r.doors) }
  const free = (side: 'N' | 'S', x: number, half: number) => {
    if (doors[side].some(d => Math.abs(d - x) < 0.8 + half + 0.25)) return false
    if (side === 'N' && (Math.abs(x) < 2.4 + half || (x > 2.8 - half && x < 5.7 + half))) return false
    if (side === 'S' && L === 0 && Math.abs(x) < 7.4 + half) return false
    return Math.abs(x) < 19.4 - half
  }
  const zOf = (side: 'N' | 'S', off: number) => (side === 'N' ? -2 + off : 2 - off)
  // glowing egress strips and wall-washer light lines
  for (const side of ['N', 'S'] as const) {
    b.box(M.egress, 39.4, 0.012, 0.06, 0, 0.02, zOf(side, 0.28))
    if (!(side === 'S' && L === 0)) b.box(M.lightStrip, 39.4, 0.05, 0.05, 0, WALL_H - 0.1, zOf(side, 0.14))
  }
  for (const side of ['N', 'S'] as const) for (const x of [-15.5, -10.5, -4.5, 6.8, 12, 18]) {
    const xx = [x, x + 1.4, x - 1.4, x + 2.4].find(v => free(side, v, 0.2))
    if (xx !== undefined) K.strobe(xx, 2.55, zOf(side, 0.16))
  }
  for (const x of [-12.5, 14.5]) { const xx = [x, x + 2, x - 2].find(v => free('S', v, 0.9)); if (xx !== undefined) { b.box(M.wood, 1.5, 0.08, 0.42, xx, 0.45, zOf('S', 0.36)); b.box(M.darkMetal, 1.4, 0.43, 0.3, xx, 0.21, zOf('S', 0.36)); K.plant(xx + 1.1, zOf('S', 0.35), 0.8) } }
  for (const x of [-18, 18.5]) { const xx = [x, x + 1.5, x - 1.5].find(v => free('N', v, 0.7)); if (xx !== undefined) b.box(M.cork, 1.3, 0.9, 0.03, xx, 1.55, zOf('N', 0.12)) }
  const map = [-2.5, 9, -11].find(v => free('S', v, 0.6)); if (map !== undefined && L > 0) b.box(M.evacMap, 0.9, 0.68, 0.03, map, 1.5, zOf('S', 0.12))
  // stairs: extinguisher, call point, EXIT sign above each stair door
  K.extinguisher(-19.7, 1.65); K.extinguisher(19.7, -1.65); K.extinguisher(-2.65, -2.3)
  b.box(M.red, 0.04, 0.14, 0.14, -19.88, 1.4, -1.6); b.box(M.red, 0.04, 0.14, 0.14, 19.88, 1.4, 1.6)
  K.exitSign(-19.86, 2.62, 0, Math.PI / 2); K.exitSign(19.86, 2.62, 0, Math.PI / 2); K.exitSign(0, 2.95, -1.86, 0)
  K.exitSign(-10, 2.72, 0, Math.PI / 2, true); K.exitSign(10, 2.72, 0, Math.PI / 2, true)
  // lift
  b.box(M.steel, 1.9, 2.25, 0.04, 4.25, 1.12, -1.88); b.box(M.darkMetal, 0.02, 2.25, 0.05, 4.25, 1.12, -1.87)
  b.box(M.frame, 2.1, 0.1, 0.07, 4.25, 2.3, -1.88); b.box(M.red, 0.5, 0.18, 0.02, 4.25, 2.55, -1.87)
  b.ext(M.darkMetal, 3.1, 0, -11.9, 5.4, 0.05, -2.1)
  // landing number on each stair wall and a landing extinguisher
  K.extinguisher(-25.6, -1.6); K.extinguisher(25.6, 1.6); K.extinguisher(2.6, -4.6)
}

function lobby(K: Kit, M: Mats, b: Batch) {
  b.floor(M.marble, LOBBY, 0.013)
  const ring = new THREE.RingGeometry(1.7, 2.1, 48); ring.rotateX(-Math.PI / 2); ring.translate(0, 0.02, 6.6); b.add(M.claddingDark, ring)
  b.ext(M.counter, 4.3, 0, 4.0, 5.1, 1.05, 8.4); b.ext(M.woodDark, 4.25, 1.05, 3.95, 5.15, 1.1, 8.45)
  K.officeChair(5.8, 6.2, -Math.PI / 2); K.seat('lobby', 5.8, 6.2, -Math.PI / 2)
  K.monitor(4.75, 5.4, Math.PI / 2, M.screenTV)
  K.sofa(-5.9, 5.6, 2.4, Math.PI / 2); K.sofa(-5.9, 8.6, 2.4, Math.PI / 2)
  b.box(M.wood, 0.7, 0.4, 1.2, -4.6, 0.2, 7.1)
  K.seat('lobby', -5.75, 5.2, Math.PI / 2); K.seat('lobby', -5.75, 9.0, Math.PI / 2)
  K.seat('lobby', 3.6, 6.0, Math.PI / 2, false); K.seat('lobby', 3.4, 7.1, Math.PI / 2, false); K.seat('lobby', -1.8, 9.5, 0.6, false)
  for (const [x, z] of [[-6.2, 11.2], [6.2, 11.2], [-6.2, 2.9], [6.2, 2.9]]) K.plant(x, z, 1.6)
  b.box(M.evacMap, 1.2, 0.9, 0.03, -6.86, 1.6, 7.0, Math.PI / 2)
  K.exitSign(0, 2.82, 11.88, 0)
}

function slabPieces(L: number): Rect[] {
  const W = STAIRS[0], E = STAIRS[2]
  if (L === 0) return [FOOTPRINT, W.zone, E.zone]
  return [rect(-20, -12, -3, 12), rect(3, -12, 20, 12), rect(-3, -5, 3, 12), W.landing, E.landing]
}

function buildFlights(b: Batch, M: Mats) {
  for (const s of STAIRS) {
    for (const f of s.flights) {
      const n = 12, run = Math.abs(f.ze - f.zs), dir = Math.sign(f.ze - f.zs), tread = run / n
      const rise = ((f.ye - f.ys) * FH) / n, y0 = f.ys * FH, w = f.x1 - f.x0 - 0.12, cx = (f.x0 + f.x1) / 2
      for (let k = 0; k < n; k++) {
        const zc = f.zs + dir * (k + 0.5) * tread, top = y0 + (k + 1) * rise
        b.box(M.concrete, w, rise + 0.02, tread + 0.01, cx, top - rise / 2, zc)
        b.box(M.nosing, w, 0.012, 0.06, cx, top + 0.006, f.zs + dir * (k * tread + 0.03))
      }
      const ang = Math.atan2(n * rise, run)
      b.tilted(M.concrete, w, 0.16, Math.hypot(run, n * rise), cx, y0 + (n * rise) / 2 - 0.12, (f.zs + f.ze) / 2, -dir * ang)
      for (const rx of [f.x0 + 0.1, f.x1 - 0.1]) {
        b.rod(M.steel, 0.025, [rx, y0 + 0.95, f.zs], [rx, y0 + n * rise + 0.95, f.ze])
        for (let k = 0; k <= 4; k++) { const t = k / 4, z = f.zs + (f.ze - f.zs) * t, y = y0 + n * rise * t; b.rod(M.steel, 0.015, [rx, y, z], [rx, y + 0.95, z], 6) }
      }
    }
    const m = s.mid
    b.ext(M.concrete, m.x0, FH / 2 - 0.22, m.z0, m.x1, FH / 2, m.z1)
    b.floor(M.tile, m, FH / 2 + 0.01)
  }
}

export type World = {
  levels: any[]; flights: any[]; roof: any; site: any; seats: Seat[]; picks: any[]; lights: any[][]
}

export function buildWorld(M: Mats): World {
  const rnd = mulberry32(21)
  const levels: any[] = [], seats: Seat[] = [], picks: any[] = [], lights: any[][] = []
  const pickMat = new THREE.MeshBasicMaterial({ visible: false })
  for (let L = 0; L < LEVELS; L++) {
    const group = new THREE.Group(); group.name = `level-${L}`
    const b = new Batch(), K = kit(b, M, seats, L, rnd)
    for (const p of slabPieces(L)) b.ext(M.concrete, p.x0, -SLAB, p.z0, p.x1, 0, p.z1)
    b.floor(M.tile, CORRIDOR)
    for (const s of STAIRS) b.floor(M.tile, s.landing)
    if (L === 0) for (const s of [STAIRS[0], STAIRS[2]]) b.floor(M.concrete, s.zone, 0.008)
    for (const r of ROOMS.filter(r => r.level === L)) { b.floor(floorMat(M, r), r.r); furnishRoom(K, M, b, r) }
    buildWalls(b, M, L)
    corridorDecor(K, M, b, L)
    if (L === 0) {
      lobby(K, M, b)
      b.ext(M.claddingDark, -5, 3.0, 12.1, 5, 3.25, 15.6); b.box(M.lamp, 9.6, 0.02, 0.06, 0, 2.99, 15.4)
      for (const x of [-4.6, 4.6]) b.cyl(M.steel, 0.12, 0.12, 3.0, x, 1.5, 15.2, 12)
      b.ext(M.paving, -5.2, -0.15, 12, 5.2, 0.02, 15.8)
      for (const e of EXITS) {
        const [x, z] = e.door, o = e.axis === 'x' ? Math.sign(x) * 0.16 : Math.sign(z) * 0.16
        if (e.axis === 'x') { K.exitSign(x + o, 2.62, z, Math.PI / 2); K.exitSign(x - o, 2.62, z, Math.PI / 2) }
        else if (e.id !== 'MAIN') { K.exitSign(x, 2.62, z + o, 0); K.exitSign(x, 2.62, z - o, 0) }
        else K.exitSign(x, 2.82, z + 0.16, 0)
      }
    }
    b.flush(group)
    // room names on the floor
    for (const r of ROOMS.filter(r => r.level === L)) {
      const w = Math.min(r.r.x1 - r.r.x0 - 1, 6.5), g = new THREE.PlaneGeometry(w, w * 0.156)
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: labelTex(r.label), transparent: true, depthWrite: false }))
      const wz = r.side === 'N' ? -2 : 2, into = r.side === 'N' ? -1 : 1
      m.rotation.x = -Math.PI / 2; m.position.set((r.r.x0 + r.r.x1) / 2, 0.025, wz + into * 1.45); group.add(m)
    }
    for (const side of [-1, 1]) {
      const t = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), new THREE.MeshBasicMaterial({ map: labelTex(`Level ${L}`, 'rgba(20,32,43,0.7)'), transparent: true }))
      t.position.set(side * 25.88, 2.2, 0); t.rotation.y = -side * Math.PI / 2; group.add(t)
    }
    const pick = new THREE.Mesh(new THREE.PlaneGeometry(54, 26), pickMat); pick.rotation.x = -Math.PI / 2; pick.position.y = 0.03; pick.userData.level = L
    group.add(pick); picks.push(pick)
    const ls: any[] = []
    for (const x of [-13, 0, 13]) { const l = new THREE.PointLight('#ffd7a8', 14, 26, 1.2); l.position.set(x, 2.9, 0); group.add(l); ls.push(l) }
    lights.push(ls)
    levels.push(group)
  }
  const flights: any[] = []
  for (let L = 0; L < LEVELS - 1; L++) {
    const g = new THREE.Group(), b = new Batch(); buildFlights(b, M); b.flush(g); flights.push(g)
  }
  return { levels, flights, roof: buildRoof(M), site: buildSite(M), seats, picks, lights }
}

function buildRoof(M: Mats) {
  const g = new THREE.Group(), b = new Batch()
  for (const p of [FOOTPRINT, STAIRS[0].zone, STAIRS[2].zone]) b.ext(M.concrete, p.x0, -SLAB, p.z0, p.x1, 0.05, p.z1)
  const par = (x0: number, z0: number, x1: number, z1: number) => b.ext(M.cladding, x0, 0, z0, x1, 1.0, z1)
  par(-20, -12.1, 20, -11.9); par(-20, 11.9, 20, 12.1); par(-20.1, -12, -19.9, 12); par(19.9, -12, 20.1, 12)
  par(-26.1, -2, -25.9, 10); par(-26, 9.9, -20, 10.1); par(-26, -2.1, -20, -1.9); par(25.9, -10, 26.1, 2); par(20, -10.1, 26, -9.9); par(20, 1.9, 26, 2.1)
  for (const [x, z] of [[-12, -6], [-6, -6], [8, 6]]) { b.ext(M.greyMetal, x - 1.2, 0, z - 0.9, x + 1.2, 1.3, z + 0.9); b.cyl(M.black, 0.6, 0.6, 0.1, x, 1.35, z, 20) }
  b.cyl(M.paint, 1.2, 1.2, 2.2, 15, 1.15, -7, 20)
  for (let x = -16; x <= 4; x += 2.2) for (const z of [3, 6.5]) b.tilted(M.frame, 2.0, 0.06, 1.6, x, 0.8, z, -0.35)
  b.flush(g)
  return g
}

function buildSite(M: Mats) {
  const g = new THREE.Group(), b = new Batch(), rnd = mulberry32(3)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(420, 420), M.grass)
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.08; ground.receiveShadow = true
  worldUV(ground.geometry); g.add(ground)
  const pave = (x0: number, z0: number, x1: number, z1: number, mat: any = M.paving, y = -0.04) => b.ext(mat, x0, y - 0.04, z0, x1, y, z1)
  pave(-31, -17, 31, 17)
  pave(-2.6, 17, 2.6, 26); pave(-9, 26, 9, 36)
  pave(-36, -2.5, -31, 2.5); pave(31, -2.5, 36, 2.5); pave(11.6, -26, 15.2, -17)
  pave(-62, -16, -36, 20, M.asphalt, -0.03)
  pave(34, -16, 54, 4); pave(4, -40, 24, -26)
  pave(-120, 40, 120, 48, M.asphalt, -0.03)
  for (let x = -110; x < 110; x += 6) b.ext(M.paint, x, -0.01, 43.9, x + 3, 0.0, 44.1)
  // parking bays and cars
  for (let k = 0; k < 9; k++) {
    const x = -60 + k * 2.8
    b.ext(M.paint, x - 0.05, -0.01, -15.5, x + 0.05, 0.0, -10.5); b.ext(M.paint, x - 0.05, -0.01, 14.5, x + 0.05, 0.0, 19.5)
    for (const [zc, zf] of [[-13, -1], [17, 1]]) if (rnd() < 0.75 && k < 8) {
      const car = M.cars[Math.floor(rnd() * M.cars.length)], cx = x + 1.4
      b.ext(car, cx - 0.85, 0.25, zc - 2.1, cx + 0.85, 0.85, zc + 2.1)
      b.ext(car, cx - 0.75, 0.85, zc - 1.0 + zf * 0.2, cx + 0.75, 1.35, zc + 0.9 + zf * 0.2)
      b.ext(M.glass, cx - 0.77, 0.9, zc - 0.95 + zf * 0.2, cx + 0.77, 1.3, zc + 0.85 + zf * 0.2)
      for (const [wx, wz] of [[-0.8, -1.3], [0.8, -1.3], [-0.8, 1.3], [0.8, 1.3]]) { const w = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 14); w.rotateZ(Math.PI / 2); w.translate(cx + wx, 0.33, zc + wz); b.add(M.rubber, w) }
    }
  }
  // trees, kept off paths, lots and the building
  const blocked = [rect(-64, -18, 30, 22), rect(-34, -19, 56, 19), rect(-11, 15, 11, 38), rect(2, -42, 26, -15), rect(-122, 38, 122, 50), rect(32, -18, 56, 6)]
  let placed = 0
  for (let tries = 0; tries < 900 && placed < 70; tries++) {
    const x = (rnd() - 0.5) * 170, z = (rnd() - 0.5) * 130
    if (blocked.some(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1)) continue
    const s = 0.8 + rnd() * 0.7
    b.cyl(M.bark, 0.14 * s, 0.2 * s, 2.4 * s, x, 1.2 * s, z, 7)
    b.sph(rnd() < 0.5 ? M.plant : M.plantDark, 1.5 * s, x, 3.2 * s, z, 1.15, 7)
    b.sph(M.plantDark, 1.05 * s, x + 0.5 * s, 4.1 * s, z - 0.3 * s, 1.1, 6)
    placed++
  }
  for (const [x0, z0, x1, z1] of [[-31, 17.4, -3.2, 18.2], [3.2, 17.4, 31, 18.2], [-31, -18.2, 11, -17.4], [15.8, -18.2, 31, -17.4]]) b.ext(M.hedge, x0, 0, z0, x1, 0.9, z1)
  // street lamps
  const lamp = (x: number, z: number) => { b.cyl(M.darkMetal, 0.07, 0.1, 5.2, x, 2.6, z, 8); b.ext(M.darkMetal, x - 0.3, 5.15, z - 0.18, x + 0.3, 5.35, z + 0.18); b.ext(M.lamp, x - 0.26, 5.12, z - 0.14, x + 0.26, 5.15, z + 0.14) }
  for (let x = -90; x <= 90; x += 18) lamp(x, 38.5)
  for (const [x, z] of [[-30, 20], [30, 20], [-30, -19], [30, -19], [-36, 0], [36, 0], [-50, 2], [46, -12], [8, -34], [-6, 30], [6, 30]]) lamp(x, z)
  // benches on the lawn
  for (const x of [-16, 16]) { b.ext(M.wood, x - 0.9, 0.42, 22, x + 0.9, 0.48, 22.5); b.ext(M.darkMetal, x - 0.8, 0, 22.05, x + 0.8, 0.42, 22.45) }
  b.flush(g)
  return g
}
