/* eslint-disable @typescript-eslint/no-explicit-any */
// 3D geometry for a building graph (graph.ts): slabs, walls with door gaps and lintels, door frames and leaves,
// switchback stair flights, exit portals, a desk and chair for every seat, and a plain site around it.
// Static geometry is merged per material, like the demo block in build.ts.
import * as THREE from 'three'
import { SLAB, DOOR_H } from './layout.ts'
import { Batch, kit, worldUV, type World } from './build.ts'
import { labelTex, mulberry32, type Mats } from './materials.ts'
import { shaftPoint, shaftRect, type GraphGeo, type GShaft } from './graph.ts'

/** Rotation about y that turns a box's local x axis onto the direction (ux, uz). */
const yawOf = (ux: number, uz: number) => Math.atan2(-uz, ux)
const UP = new THREE.Vector3(0, 1, 0)

export function buildGraphWorld(M: Mats, g: GraphGeo): World {
  const rnd = mulberry32(21)
  const levels: any[] = [], picks: any[] = [], lights: any[][] = []
  const pickMat = new THREE.MeshBasicMaterial({ visible: false })
  const bd = g.bounds, wallH = g.wallH, cx = (bd.x0 + bd.x1) / 2, cz = (bd.z0 + bd.z1) / 2
  const floorOf: Record<string, any> = { lab: M.epoxy, hall: M.carpetBlue, office: M.carpetGrey, lobby: M.marble, wash: M.tile, cafe: M.checker, library: M.woodFloor, store: M.concrete, class: M.vinyl }
  const perLevel = Math.max(1, Math.min(3, Math.floor(8 / g.levels)))
  const signY = Math.min(2.62, wallH - 0.35)

  for (let L = 0; L < g.levels; L++) {
    const group = new THREE.Group(); group.name = `level-${L}`
    const b = new Batch(), K = kit(b, M, [], L, rnd)
    // a box whose local x runs along (ux, uz)
    const obox = (mat: any, len: number, h: number, w: number, x: number, y: number, z: number, ux: number, uz: number) => b.box(mat, len, h, w, x, y, z, yawOf(ux, uz))

    // ---- floors ----
    for (const r of g.rooms) if (r.level === L) { b.ext(M.concrete, r.r.x0, -SLAB, r.r.z0, r.r.x1, 0, r.r.z1); b.floor(floorOf[r.kind] ?? M.vinyl, r.r, 0.014) }
    for (const s of g.strips) if (s.level === L) {
      const len = Math.hypot(s.bx - s.ax, s.bz - s.az), ux = (s.bx - s.ax) / len, uz = (s.bz - s.az) / len
      const ea = s.openA ? 0 : s.w / 2, eb = s.openB ? 0 : s.w / 2, full = len + ea + eb
      const mx = (s.ax + s.bx) / 2 + (ux * (eb - ea)) / 2, mz = (s.az + s.bz) / 2 + (uz * (eb - ea)) / 2
      obox(M.concrete, full, SLAB, s.w, mx, -SLAB / 2, mz, ux, uz)
      obox(M.tile, full, 0.02, s.w, mx, 0, mz, ux, uz)
      if ((s.kind === 'corr' || s.kind === 'exit') && len > 1.5) { // photoluminescent egress line along one edge
        const o = s.w / 2 - 0.22
        obox(M.egress, len, 0.012, 0.05, (s.ax + s.bx) / 2 - uz * o, 0.022, (s.az + s.bz) / 2 + ux * o, ux, uz)
      }
    }
    for (const sh of g.shafts) if (L >= sh.lo && L <= sh.hi) {
      const d = L === sh.lo ? sh.len : sh.ld, [mx, mz] = shaftPoint(sh, d / 2, 0)
      obox(M.concrete, d, SLAB, sh.width, mx, -SLAB / 2, mz, sh.ux, sh.uz)
      obox(M.tile, d, 0.02, sh.width, mx, 0.002, mz, sh.ux, sh.uz)
      // EXIT sign over the stair door, facing the corridor
      const [sx, sz] = shaftPoint(sh, -0.12, 0)
      K.exitSign(sx, signY, sz, Math.atan2(sh.ux, sh.uz))
    }

    // ---- walls, lintels over openings, door frames and open leaves ----
    const { walls, gaps } = g.walls(L)
    for (const w of walls) {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az)
      if (len > 0.01) obox(M.plaster, len, wallH, w.t, (w.ax + w.bx) / 2, wallH / 2, (w.az + w.bz) / 2, (w.bx - w.ax) / len, (w.bz - w.az) / len)
    }
    for (const w of gaps) {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az), ux = (w.bx - w.ax) / len, uz = (w.bz - w.az) / len
      obox(M.plaster, len + 0.02, wallH - DOOR_H, w.t, (w.ax + w.bx) / 2, (DOOR_H + wallH) / 2, (w.az + w.bz) / 2, ux, uz)
      for (const [x, z] of [[w.ax, w.az], [w.bx, w.bz]]) obox(M.frame, 0.06, DOOR_H, w.t + 0.05, x, DOOR_H / 2, z, ux, uz)
      obox(M.frame, len, 0.06, w.t + 0.05, (w.ax + w.bx) / 2, DOOR_H - 0.03, (w.az + w.bz) / 2, ux, uz)
    }
    for (const d of g.doors) if (d.level === L) {
      const tx = -d.nz, tz = d.nx, lw = Math.max(0.5, d.w - 0.12)
      const hx = d.x - tx * (d.w / 2 - 0.04), hz = d.z - tz * (d.w / 2 - 0.04)
      obox(M.wood, lw, DOOR_H - 0.06, 0.045, hx - d.nx * (lw / 2 + 0.1) + tx * 0.03, (DOOR_H - 0.06) / 2, hz - d.nz * (lw / 2 + 0.1) + tz * 0.03, -d.nx, -d.nz)
    }
    // ---- exits: a portal with a canopy and an EXIT sign ----
    for (const e of g.exits) if (e.level === L) {
      const tx = -e.nz, tz = e.nx, w = e.w
      obox(M.plaster, w + 0.36, wallH - DOOR_H, 0.2, e.x, (DOOR_H + wallH) / 2, e.z, tx, tz)
      for (const s of [-1, 1]) obox(M.frame, 0.1, DOOR_H, 0.26, e.x + tx * s * (w / 2 + 0.05), DOOR_H / 2, e.z + tz * s * (w / 2 + 0.05), tx, tz)
      obox(M.claddingDark, w + 1.2, 0.14, 1.7, e.x + e.nx * 0.85, DOOR_H + 0.42, e.z + e.nz * 0.85, tx, tz)
      K.exitSign(e.x - e.nx * 0.13, signY, e.z - e.nz * 0.13, Math.atan2(e.nx, e.nz))
    }

    // ---- furniture: a chair and a small desk for every seated person, a board on the wall they face ----
    for (const s of g.seats) if (s.level === L && s.sit) {
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw)
      K.pb(M.fabricBlue, 0.44, 0.06, 0.42, s.x, s.z, s.yaw, 0, 0.46, 0); K.pb(M.fabricBlue, 0.44, 0.4, 0.05, s.x, s.z, s.yaw, 0, 0.72, -0.2)
      K.pb(M.darkMetal, 0.05, 0.44, 0.05, s.x, s.z, s.yaw, 0, 0.22, 0)
      const dx = s.x + fx * 0.5, dz = s.z + fz * 0.5
      K.pb(M.whiteLam, 0.64, 0.04, 0.42, dx, dz, s.yaw, 0, 0.74, 0)
      for (const side of [-1, 1]) K.pb(M.greyMetal, 0.03, 0.72, 0.38, dx, dz, s.yaw, side * 0.3, 0.36, 0)
    }
    for (const r of g.rooms) if (r.level === L) {
      const w = r.r.x1 - r.r.x0, d = r.r.z1 - r.r.z0, rcx = (r.r.x0 + r.r.x1) / 2, rcz = (r.r.z0 + r.r.z1) / 2
      const half = Math.abs(r.fx) > 0.5 ? w / 2 : d / 2, span = Math.abs(r.fx) > 0.5 ? d : w
      if (r.kind !== 'store' && r.kind !== 'wash' && span > 2.5 && half > 1.5) {
        const bx = rcx + r.fx * (half - 0.13), bz = rcz + r.fz * (half - 0.13), bw = Math.min(r.kind === 'hall' ? 5 : 3.6, span - 1.2)
        obox(r.kind === 'hall' ? M.screenSlide : M.whiteboard, bw, r.kind === 'hall' ? 2.0 : 1.15, 0.03, bx, r.kind === 'hall' ? 1.9 : 1.5, bz, -r.fz, r.fx)
      }
      if (w > 3 && d > 3 && r.kind !== 'store') K.plant(r.r.x0 + 0.55, r.r.z0 + 0.55, 0.9)
      if (r.kind === 'store') for (let k = 0; k < Math.min(6, Math.floor(w * d / 6)); k++) K.boxes(r.r.x0 + 0.6 + rnd() * (w - 1.2), r.r.z0 + 0.6 + rnd() * (d - 1.2))
    }
    b.flush(group)

    // room names on the floor, just inside the main door
    for (const r of g.rooms) if (r.level === L) {
      const door = g.doors.find(d => d.room === r.id)
      const tx = door ? -door.nz : 1, tz = door ? door.nx : 0
      const span = Math.abs(tx) > 0.5 ? r.r.x1 - r.r.x0 : r.r.z1 - r.r.z0, lw = Math.min(span - 0.8, 6.5)
      if (lw < 1.2) continue
      const depth = Math.abs(tx) > 0.5 ? r.r.z1 - r.r.z0 : r.r.x1 - r.r.x0
      const x = door ? door.x - door.nx * Math.min(1.4, depth / 2) : (r.r.x0 + r.r.x1) / 2, z = door ? door.z - door.nz * Math.min(1.4, depth / 2) : (r.r.z0 + r.r.z1) / 2
      const m = new THREE.Mesh(new THREE.PlaneGeometry(lw, lw * 0.156), new THREE.MeshBasicMaterial({ map: labelTex(r.label), transparent: true, depthWrite: false }))
      m.rotation.set(-Math.PI / 2, 0, Math.atan2(-tz, tx)); m.position.set(x, 0.026, z); group.add(m)
    }
    const pick = new THREE.Mesh(new THREE.PlaneGeometry(bd.x1 - bd.x0 + 12, bd.z1 - bd.z0 + 12), pickMat)
    pick.rotation.x = -Math.PI / 2; pick.position.set(cx, 0.03, cz); pick.userData.level = L
    group.add(pick); picks.push(pick)
    const ls: any[] = [], long = bd.x1 - bd.x0 >= bd.z1 - bd.z0
    for (let k = 0; k < perLevel; k++) {
      const f = (k + 0.5) / perLevel, l = new THREE.PointLight('#ffd7a8', 14, Math.max(26, Math.max(bd.x1 - bd.x0, bd.z1 - bd.z0) / perLevel + 8), 1.2)
      l.position.set(long ? bd.x0 + (bd.x1 - bd.x0) * f : cx, wallH - 0.4, long ? cz : bd.z0 + (bd.z1 - bd.z0) * f)
      group.add(l); ls.push(l)
    }
    lights.push(ls)
    levels.push(group)
  }

  // ---- stair flights, one group per storey gap (the engine stretches them when floors are pulled apart) ----
  const flights: any[] = []
  for (let L = 0; L < Math.max(0, g.levels - 1); L++) {
    const grp = new THREE.Group(), b = new Batch()
    for (const sh of g.shafts) if (sh.pairs.some(([p, q]) => p === L && q === L + 1)) buildFlights(b, M, sh, g.fh)
    b.flush(grp); flights.push(grp)
  }
  return { levels, flights, roof: buildRoof(M, g), site: buildSite(M, g), seats: g.seats, picks, lights }
}

function buildFlights(b: Batch, M: Mats, sh: GShaft, fh: number) {
  const yaw = yawOf(sh.ux, sh.uz), q1 = sh.wf / 2 + 0.08, n = sh.steps, tread = sh.run / n, rise = fh / 2 / n, w = sh.wf - 0.12
  const P = (s: number, q: number) => shaftPoint(sh, s, q)
  const slope = (mat: any, len: number, t: number, wid: number, s: number, q: number, y: number, ang: number) => {
    const g = new THREE.BoxGeometry(len, t, wid); g.rotateZ(ang); g.rotateY(yaw); const [x, z] = P(s, q); g.translate(x, y, z); b.add(mat, g)
  }
  for (const [qc, dir, y0] of [[q1, 1, 0], [-q1, -1, fh / 2]] as const) {
    const s0 = dir > 0 ? sh.ld : sh.ld + sh.run
    for (let k = 0; k < n; k++) {
      const sc = s0 + dir * (k + 0.5) * tread, top = y0 + (k + 1) * rise, [x, z] = P(sc, qc)
      b.box(M.concrete, tread + 0.01, rise + 0.02, w, x, top - rise / 2, z, yaw)
      const [nx, nz] = P(s0 + dir * (k * tread + 0.03), qc)
      b.box(M.nosing, 0.06, 0.012, w, nx, top + 0.006, nz, yaw)
    }
    const run = n * tread, ang = Math.atan2(n * rise, run) * dir
    slope(M.concrete, Math.hypot(run, n * rise), 0.16, w, s0 + dir * run / 2, qc, y0 + (n * rise) / 2 - 0.12, ang)
    for (const rq of [qc - w / 2 + 0.02, qc + w / 2 - 0.02]) {
      const [ax, az] = P(s0, rq), [bx, bz] = P(s0 + dir * run, rq)
      rod(b, M.steel, 0.025, [ax, y0 + 0.95, az], [bx, y0 + n * rise + 0.95, bz])
      for (let k = 0; k <= 4; k++) { const t = k / 4, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = y0 + n * rise * t; rod(b, M.steel, 0.015, [x, y, z], [x, y + 0.95, z], 6) }
    }
  }
  const [mx, mz] = P(sh.ld + sh.run + sh.md / 2, 0)
  b.box(M.concrete, sh.md, 0.22, sh.width, mx, fh / 2 - 0.11, mz, yaw)
  b.box(M.tile, sh.md, 0.02, sh.width, mx, fh / 2 + 0.002, mz, yaw)
}

function rod(b: Batch, mat: any, r: number, a: [number, number, number], c: [number, number, number], seg = 8) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...c), d = B.clone().sub(A), len = d.length()
  if (len < 1e-4) return
  const g = new THREE.CylinderGeometry(r, r, len, seg)
  g.applyMatrix4(new THREE.Matrix4().compose(A.add(B).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), new THREE.Vector3(1, 1, 1)))
  b.add(mat, g)
}

function buildRoof(M: Mats, g: GraphGeo) {
  const grp = new THREE.Group(), b = new Batch(), top = g.levels - 1
  for (const r of g.rooms) if (r.level === top) b.ext(M.concrete, r.r.x0 - 0.1, -SLAB, r.r.z0 - 0.1, r.r.x1 + 0.1, 0.05, r.r.z1 + 0.1)
  for (const s of g.strips) if (s.level === top) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az), ux = (s.bx - s.ax) / len, uz = (s.bz - s.az) / len
    b.box(M.concrete, len + s.w, SLAB + 0.05, s.w + 0.2, (s.ax + s.bx) / 2, -SLAB / 2 + 0.025, (s.az + s.bz) / 2, yawOf(ux, uz))
  }
  for (const sh of g.shafts) if (sh.hi === top) { const q = shaftRect(sh); b.ext(M.concrete, q.x0 - 0.1, -SLAB, q.z0 - 0.1, q.x1 + 0.1, 0.05, q.z1 + 0.1) }
  b.flush(grp)
  return grp
}

function buildSite(M: Mats, g: GraphGeo) {
  const grp = new THREE.Group(), b = new Batch(), rnd = mulberry32(3), bd = g.bounds, st = g.site
  const S = Math.max(420, (st.x1 - st.x0) * 3, (st.z1 - st.z0) * 3)
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S), M.grass)
  ground.rotation.x = -Math.PI / 2; ground.position.set((st.x0 + st.x1) / 2, -0.08, (st.z0 + st.z1) / 2); ground.receiveShadow = true
  worldUV(ground.geometry); grp.add(ground)
  b.ext(M.paving, bd.x0 - 2.5, -0.08, bd.z0 - 2.5, bd.x1 + 2.5, -0.04, bd.z1 + 2.5)
  // a paved path from every exit to its assembly point
  const paths: [number, number, number, number][] = []
  for (const e of g.exits) {
    const a = g.asms.find(x => x.id === e.asm), ox = e.x + e.nx * 2.6, oz = e.z + e.nz * 2.6
    paths.push([e.x, e.z, ox, oz])
    if (a) paths.push([ox, oz, a.x, a.z])
  }
  for (const [ax, az, bx, bz] of paths) {
    const len = Math.hypot(bx - ax, bz - az)
    if (len < 0.2) continue
    b.box(M.paving, len + 2.4, 0.05, 2.4, (ax + bx) / 2, -0.055, (az + bz) / 2, yawOf((bx - ax) / len, (bz - az) / len))
  }
  for (const a of g.asms) { const c = new THREE.CylinderGeometry(5.6, 5.6, 0.05, 40); c.translate(a.x, -0.05, a.z); b.add(M.paving, c) }
  // trees around the site, clear of the building, the paths and the assembly points
  const nearPath = (x: number, z: number) => paths.some(([ax, az, bx, bz]) => {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2))
    return Math.hypot(ax + dx * t - x, az + dz * t - z) < 4
  })
  let placed = 0
  for (let tries = 0; tries < 900 && placed < 60; tries++) {
    const x = st.x0 - 30 + rnd() * (st.x1 - st.x0 + 60), z = st.z0 - 30 + rnd() * (st.z1 - st.z0 + 60)
    if (x > bd.x0 - 7 && x < bd.x1 + 7 && z > bd.z0 - 7 && z < bd.z1 + 7) continue
    if (nearPath(x, z) || g.asms.some(a => Math.hypot(a.x - x, a.z - z) < 9)) continue
    const s = 0.8 + rnd() * 0.7
    b.cyl(M.bark, 0.14 * s, 0.2 * s, 2.4 * s, x, 1.2 * s, z, 7)
    b.sph(rnd() < 0.5 ? M.plant : M.plantDark, 1.5 * s, x, 3.2 * s, z, 1.15, 7)
    placed++
  }
  b.flush(grp)
  return grp
}
