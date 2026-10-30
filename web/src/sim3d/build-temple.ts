/* eslint-disable @typescript-eslint/no-explicit-any */
// Dravidian temple scene for the Tirumala plan: prakara walls, four gopurams, pillared mandapam,
// queue halls and a golden vimana over the sanctum. Positions follow data/tirumala_temple.json.
import * as THREE from 'three'
import { rect } from './layout.ts'
import { Batch, type Seat, type World } from './build.ts'
import type { Mats } from './materials.ts'

function gopuram(b: Batch, M: Mats, cx: number, cz: number, totalH: number, hx: number, hz: number) {
  const TIERS = 7
  let wx = hx, wz = hz, y = 0
  b.ext(M.templeStone, cx - hx - 0.6, 0, cz - hz - 0.6, cx + hx + 0.6, 1.2, cz + hz + 0.6)
  y = 1.2
  for (let t = 0; t < TIERS; t++) {
    const th = (totalH * 0.74) / TIERS * Math.pow(0.95, t)
    b.ext(t % 2 === 0 ? M.gopuramOrange : M.gopuramCream, cx - wx, y, cz - wz, cx + wx, y + th, cz + wz)
    b.ext(M.templeGold, cx - wx - 0.1, y + th - 0.12, cz - wz - 0.1, cx + wx + 0.1, y + th, cz + wz + 0.1)
    y += th; wx *= 0.87; wz *= 0.9
  }
  const capH = totalH * 0.07
  b.ext(M.gopuramCream, cx - wx, y, cz - wz, cx + wx, y + capH, cz + wz)
  y += capH
  const faceX = hx >= hz
  const kr = Math.min(wx, wz) * 0.6
  for (let k = -1; k <= 1; k++) {
    const kx = faceX ? cx + k * wx * 0.6 : cx, kz = faceX ? cz : cz + k * wz * 0.6
    b.sph(M.templeGold2, kr, kx, y + kr, kz, 0.9)
    b.cyl(M.templeGold2, kr * 0.12, kr * 0.28, kr * 2.4, kx, y + kr * 2 + kr * 1.2, kz)
  }
}

function vimana(b: Batch, M: Mats, cx: number, cz: number, hw: number, y0: number) {
  let w = hw, y = y0
  b.ext(M.templeGold2, cx - w - 0.4, y, cz - w - 0.4, cx + w + 0.4, y + 0.5, cz + w + 0.4)
  y += 0.5
  const base = y
  for (let t = 0; t < 8; t++) {
    const th = 1.35 - t * 0.07
    b.box(M.templeGold, w * 2, th, w * 2, cx, y + th / 2, cz)
    b.box(M.templeGold2, w * 2 + 0.22, 0.12, w * 2 + 0.22, cx, y + 0.06, cz)
    b.box(M.templeGold2, w * 2 + 0.22, 0.12, w * 2 + 0.22, cx, y + th - 0.06, cz)
    y += th; w -= 0.32
  }
  const tierTop = y
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const px = cx + dx * (w + 0.1), pz = cz + dz * (w + 0.1)
    b.sph(M.templeGold2, 0.32, px, tierTop + 0.3, pz, 0.85)
    b.cyl(M.templeGold2, 0.05, 0.1, 0.7, px, tierTop + 0.9, pz)
  }
  b.cyl(M.templeGold, w + 0.12, w + 0.55, 0.6, cx, y + 0.3, cz, 12)
  y += 0.6
  b.cyl(M.templeGold2, 0.32, 0.48, 0.75, cx, y + 0.375, cz)
  y += 0.75
  b.sph(M.templeGold2, 0.62, cx, y + 0.62, cz)
  y += 1.24
  b.cyl(M.templeGold2, 0.07, 0.16, 1.9, cx, y + 0.95, cz)
  void base
}

export function buildTempleWorld(M: Mats, seats: Seat[] = []): World {
  const b = new Batch(), R = new Batch(), H = new Batch()
  const glass = (M.templeStone as any).clone(); glass.transparent = true; glass.opacity = 0.2; glass.depthWrite = false; glass.userData.noShadow = true
  const level = new THREE.Group(); level.name = 'level-0'
  const site = new THREE.Group(); site.name = 'site'
  const roof = new THREE.Group(); roof.name = 'roof'
  const picks: any[] = []
  const lights: any[][] = [[]]
  const PX = 27, PN = 23, PS = 22, WH = 3.2, WT = 0.85, MH = 4.0, QH = 3.5, IH = 3.8, SH = 7.5

  b.floor(M.grass, rect(-70, -70, 70, 70), -0.06)
  b.floor(M.paving, rect(-PX - 8, -PN - 8, PX + 8, PS + 14), -0.02)
  b.flush(site)

  b.floor(M.marble, rect(-PX, -PN, PX, PS), 0.04)
  b.ext(M.templeStone, -PX + 0.4, -0.45, -PN + 0.4, PX - 0.4, 0, PS - 0.4)

  // prakara walls with a gate gap in each side
  b.ext(M.templeWall, -PX, 0, PS - WT, -3.5, WH, PS); b.ext(M.templeWall, 3.5, 0, PS - WT, PX, WH, PS)
  b.ext(M.templeWall, -3.5, WH - 0.5, PS - WT, 3.5, WH, PS)
  b.ext(M.templeWall, -PX, 0, -PN, -3, WH, -PN + WT); b.ext(M.templeWall, 3, 0, -PN, PX, WH, -PN + WT)
  b.ext(M.templeWall, -3, WH - 0.5, -PN, 3, WH, -PN + WT)
  b.ext(M.templeWall, PX - WT, 0, -PN, PX, WH, -2); b.ext(M.templeWall, PX - WT, 0, 2, PX, WH, PS)
  b.ext(M.templeWall, PX - WT, WH - 0.5, -2, PX, WH, 2)
  b.ext(M.templeWall, -PX, 0, -PN, -PX + WT, WH, -2); b.ext(M.templeWall, -PX, 0, 2, -PX + WT, WH, PS)
  b.ext(M.templeWall, -PX, WH - 0.5, -2, -PX + WT, WH, 2)
  b.ext(M.templeStone, -PX - 0.15, WH, -PN - 0.15, PX + 0.15, WH + 0.2, -PN + WT + 0.15)
  b.ext(M.templeStone, -PX - 0.15, WH, PS - WT - 0.15, PX + 0.15, WH + 0.2, PS + 0.15)
  b.ext(M.templeStone, -PX - 0.15, WH, -PN, -PX + WT + 0.15, WH + 0.2, PS)
  b.ext(M.templeStone, PX - WT - 0.15, WH, -PN, PX + 0.15, WH + 0.2, PS)
  for (const [cx, cz] of [[-PX, -PN], [PX, -PN], [-PX, PS], [PX, PS]]) {
    b.ext(M.templeWall, cx - 1, 0, cz - 1, cx + 1, WH + 1.4, cz + 1)
    b.sph(M.gopuramCream, 1.0, cx, WH + 2.2, cz, 0.45)
    b.cyl(M.templeGold2, 0.05, 0.12, 0.8, cx, WH + 2.7, cz)
  }

  gopuram(b, M, 0, PS + 3.5, 16, 5.5, 3.5)
  gopuram(b, M, 0, -PN - 3.5, 10, 4.2, 3.0)
  gopuram(b, M, PX + 3, 0, 11, 3.2, 5.0)
  gopuram(b, M, -PX - 3, 0, 11, 3.2, 5.0)

  // mandapam
  b.floor(M.marble, rect(-13, -2, 13, 12), 0.15)
  R.ext(M.templeStone, -13, MH, -2.8, 13, MH + 0.45, 12)
  R.ext(M.templeStone, -13, MH + 0.45, -2.8, 13, MH + 0.6, 12)
  H.ext(glass, -13, 0, 11.2, -4, MH, 12); H.ext(glass, 4, 0, 11.2, 13, MH, 12)
  H.ext(glass, -4, 2.9, 11.2, 4, MH, 12)
  H.ext(glass, 12.2, 0, -2, 13, MH, 12); H.ext(glass, -13, 0, -2, -12.2, MH, 12)
  H.ext(glass, -13, 0, -2.8, -3, MH, -2); H.ext(glass, 3, 0, -2.8, 13, MH, -2)
  H.ext(glass, -3, 2.9, -2.8, 3, MH, -2)
  const colH = MH - 0.85
  for (const cx of [-8, 0, 8]) for (const cz of [1, 6, 10]) {
    b.ext(M.templeStone, cx - 0.65, 0.15, cz - 0.65, cx + 0.65, 0.5, cz + 0.65)
    b.cyl(M.templeStone, 0.4, 0.4, colH, cx, 0.5 + colH / 2, cz, 8)
    b.cyl(M.templeStone, 0.68, 0.4, 0.3, cx, 0.5 + colH + 0.15, cz, 8)
    b.ext(M.templeStone, cx - 0.72, 0.8 + colH, cz - 0.72, cx + 0.72, MH, cz + 0.72)
  }
  // mandapam dome with golden finial
  R.sph(M.gopuramCream, 4.2, 0, MH + 0.6, 5, 0.55, 14)
  R.cyl(M.templeGold2, 0.08, 0.22, 1.6, 0, MH + 0.6 + 2.3 + 0.8, 5)
  R.sph(M.templeGold2, 0.35, 0, MH + 0.6 + 2.3 + 1.8, 5)

  // queue halls
  for (const [sx, ex] of [[-24, -16], [16, 24]]) {
    const east = sx > 0, innerX0 = east ? sx : ex - 0.8, innerX1 = east ? sx + 0.8 : ex
    b.floor(M.checker, rect(sx, -6, ex, 10), 0.15)
    R.ext(M.templeStone, sx, QH, -6, ex, QH + 0.35, 10)
    H.ext(glass, sx, 0, 9.2, ex, QH, 10); H.ext(glass, sx, 0, -6, ex, QH, -5.2)
    H.ext(glass, east ? ex - 0.8 : sx, 0, -6, east ? ex : sx + 0.8, QH, 10)
    H.ext(glass, innerX0, 0, -6, innerX1, QH, -1.5); H.ext(glass, innerX0, 0, 4, innerX1, QH, 10)
    H.ext(glass, innerX0, 2.8, -1.5, innerX1, QH, 4)
    for (const cz of [-2, 4]) b.cyl(M.templeStone, 0.3, 0.3, QH - 0.4, (sx + ex) / 2, (QH - 0.4) / 2, cz, 8)
    R.sph(M.gopuramCream, 2.2, (sx + ex) / 2, QH + 0.35, 2, 0.5, 12)
    R.cyl(M.templeGold2, 0.05, 0.14, 1.0, (sx + ex) / 2, QH + 0.35 + 1.5, 2)
  }

  // inner corridor
  b.floor(M.marble, rect(-5, -12, 5, -2), 0.15)
  R.ext(M.templeStone, -5, IH, -12, 5, IH + 0.35, -2)
  H.ext(glass, -5, 0, -12, -4.2, IH, -2); H.ext(glass, 4.2, 0, -12, 5, IH, -2)

  // sanctum
  b.floor(M.marble, rect(-4.6, -18, 4.6, -12), 0.2)
  b.ext(M.templeStone, -5, 0, -12.8, -1.5, SH, -12); b.ext(M.templeStone, 1.5, 0, -12.8, 5, SH, -12)
  b.ext(M.templeStone, -1.5, 2.5, -12.8, 1.5, SH, -12)
  b.ext(M.templeStone, -5, 0, -18, 5, SH, -17.2)
  b.ext(M.templeStone, 4.2, 0, -18, 5, SH, -12.8); b.ext(M.templeStone, -5, 0, -18, -4.2, SH, -12.8)
  b.ext(M.templeStone, -5, SH, -18, 5, SH + 0.5, -12)
  vimana(b, M, 0, -15, 5.2, SH + 0.5)

  // lamp columns at the mandapam entrance
  for (const lx of [-6, 6]) {
    b.cyl(M.templeGold, 0.2, 0.24, 5.5, lx, 2.75, 14)
    b.cyl(M.templeGold2, 0.42, 0.28, 0.5, lx, 5.75, 14)
    b.sph(M.templeGold2, 0.35, lx, 6.5, 14, 0.7)
    const lamp = new THREE.PointLight(new THREE.Color(2.0, 1.2, 0.35), 8, 7, 2)
    lamp.position.set(lx, 6.6, 14); lights[0].push(lamp); level.add(lamp)
  }

  const pickMat = new THREE.MeshBasicMaterial({ visible: false })
  for (const [x0, z0, x1, z1] of [[-13, -2, 13, 12], [-24, -6, -16, 10], [16, -6, 24, 10], [-5, -12, 5, -2]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 0.4, z1 - z0), pickMat)
    m.position.set((x0 + x1) / 2, 0.2, (z0 + z1) / 2); m.userData.level = 0
    picks.push(m)
  }

  const warm = new THREE.Color(1.25, 0.9, 0.55)
  for (const [lx, lz] of [[0, 5], [-8, 5], [8, 5], [-20, 2], [20, 2], [0, -7]]) {
    const l = new THREE.PointLight(warm, 10, 16, 1.5)
    l.position.set(lx, MH * 0.8, lz); lights[0].push(l); level.add(l)
  }
  const glow = new THREE.PointLight(new THREE.Color(1.5, 0.9, 0.25), 22, 14, 2)
  glow.position.set(0, 4, -15); lights[0].push(glow); level.add(glow)

  b.flush(level); H.flush(level, false); R.flush(roof)
  return { levels: [level], flights: [], roof, site, seats, picks, lights, seeThrough: glass }
}
