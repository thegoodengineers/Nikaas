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
  const glass = (M.templeStone as any).clone(); glass.color.set('#a8552b'); glass.transparent = true; glass.opacity = 0.5; glass.depthWrite = false; glass.userData.noShadow = true
  const level = new THREE.Group(); level.name = 'level-0'
  const site = new THREE.Group(); site.name = 'site'
  const roof = new THREE.Group(); roof.name = 'roof'
  const picks: any[] = []
  const lights: any[][] = [[]]
  const PX = 27, PN = 23, PS = 22, WH = 3.2, WT = 0.85, MH = 4.0, QH = 3.5, IH = 3.8, SH = 7.5

  const hw = (_m: any, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
    H.ext(glass, x0, y0, z0, x1, y1, z1)
    if (y0 < 0.5) { b.ext(M.templeWall, x0 - 0.02, 0, z0 - 0.02, x1 + 0.02, Math.min(1.0, y1), z1 + 0.02); b.ext(M.templeGold, x0 - 0.04, 1.0, z0 - 0.04, x1 + 0.04, 1.08, z1 + 0.04) }
  }
  b.floor(M.grass, rect(-70, -70, 70, 70), -0.06)
  b.floor(M.paving, rect(-PX - 8, -PN - 8, PX + 8, PS + 14), -0.02)
  b.flush(site)

  b.floor(M.marble, rect(-PX, -PN, PX, PS), 0.04)
  b.ext(M.templeStone, -PX + 0.4, -0.45, -PN + 0.4, PX - 0.4, 0, PS - 0.4)

  // prakara walls with a gate gap in each side
  b.ext(M.templeWall, -PX, 0, PS - WT, -3.5, WH, PS); b.ext(M.templeWall, 3.5, 0, PS - WT, PX, WH, PS)
  b.ext(M.templeWall, -3.5, WH - 0.5, PS - WT, 3.5, WH, PS)
  b.ext(M.templeWall, -PX, 0, -PN, PX, WH, -PN + WT)
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
  gopuram(b, M, PX + 3, 0, 11, 3.2, 5.0)
  gopuram(b, M, -PX - 3, 0, 11, 3.2, 5.0)

  // mandapam
  b.floor(M.marble, rect(-13, -2, 13, 12), 0.15)
  R.ext(M.templeStone, -13, MH, -2.8, 13, MH + 0.45, 12)
  R.ext(M.templeStone, -13, MH + 0.45, -2.8, 13, MH + 0.6, 12)
  hw(glass, -13, 0, 11.2, -4, MH, 12); hw(glass, 4, 0, 11.2, 13, MH, 12)
  hw(glass, -4, 2.9, 11.2, 4, MH, 12)
  hw(glass, 12.2, 0, -2, 13, MH, 12); hw(glass, -13, 0, -2, -12.2, MH, 12)
  hw(glass, -13, 0, -2.8, -3, MH, -2); hw(glass, 3, 0, -2.8, 13, MH, -2)
  hw(glass, -3, 2.9, -2.8, 3, MH, -2)
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
    hw(glass, sx, 0, 9.2, ex, QH, 10); hw(glass, sx, 0, -6, ex, QH, -5.2)
    hw(glass, east ? ex - 0.8 : sx, 0, -6, east ? ex : sx + 0.8, QH, 10)
    hw(glass, innerX0, 0, -6, innerX1, QH, -1.5); hw(glass, innerX0, 0, 4, innerX1, QH, 10)
    hw(glass, innerX0, 2.8, -1.5, innerX1, QH, 4)
    for (const cz of [-2, 4]) b.cyl(M.templeStone, 0.3, 0.3, QH - 0.4, (sx + ex) / 2, (QH - 0.4) / 2, cz, 8)
    R.sph(M.gopuramCream, 2.2, (sx + ex) / 2, QH + 0.35, 2, 0.5, 12)
    R.cyl(M.templeGold2, 0.05, 0.14, 1.0, (sx + ex) / 2, QH + 0.35 + 1.5, 2)
  }

  // inner corridor
  b.floor(M.marble, rect(-5, -12, 5, -2), 0.15)
  R.ext(M.templeStone, -5, IH, -12, 5, IH + 0.35, -2)
  hw(glass, -5, 0, -12, -4.2, IH, -2); hw(glass, 4.2, 0, -12, 5, IH, -2)

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

  // ---- extra detailing ----
  // red carpet runners and gold floor borders
  b.floor(M.carpetRed, rect(-1.4, -12, 1.4, 12), 0.17)
  b.floor(M.carpetRed, rect(-1.4, 12, 1.4, PS), 0.06)
  for (const [x0, z0, x1, z1] of [[-12.6, -1.6, 12.6, -1.45], [-12.6, 11.45, 12.6, 11.6]]) b.floor(M.templeGold, rect(x0, z0, x1, z1), 0.175)
  for (const sx of [-1, 1]) b.floor(M.templeGold, rect(sx * 12.45 - 0.08, -1.6, sx * 12.45 + 0.08, 11.6), 0.175)
  // steps up to the main gate and to the mandapam
  for (let k = 0; k < 4; k++) {
    b.ext(M.templeStone, -4.5 - k * 0.2, 0, PS + 0.1 + k * 0.7, 4.5 + k * 0.2, 0.5 - k * 0.12, PS + 0.8 + k * 0.7)
    b.ext(M.templeStone, -5.5 + k * 0.1, 0, 12 + k * 0.35, 5.5 - k * 0.1, 0.15 - k * 0.03, 12.35 + k * 0.35)
  }
  // stucco merlons with golden tips along the prakara wall tops
  for (let x = -PX + 2; x <= PX - 2; x += 3) for (const z of [-PN + WT / 2, PS - WT / 2]) {
    if (Math.abs(x) < 4.5) continue
    b.cyl(M.gopuramCream, 0.12, 0.34, 0.7, x, WH + 0.2 + 0.35, z, 8); b.sph(M.templeGold2, 0.1, x, WH + 1.0, z)
  }
  for (let z = -PN + 3; z <= PS - 3; z += 3) for (const x of [-PX + WT / 2, PX - WT / 2]) {
    if (Math.abs(z) < 3) continue
    b.cyl(M.gopuramCream, 0.12, 0.34, 0.7, x, WH + 0.2 + 0.35, z, 8); b.sph(M.templeGold2, 0.1, x, WH + 1.0, z)
  }
  // dhwajastambha (golden flagstaff) before the mandapam
  b.cyl(M.templeStone, 0.9, 1.1, 0.5, 0, 0.25, 17, 12); b.cyl(M.templeStone, 0.6, 0.9, 0.4, 0, 0.7, 17, 12)
  b.cyl(M.templeGold, 0.18, 0.28, 11, 0, 6.2, 17, 10)
  for (let k = 0; k < 4; k++) b.cyl(M.templeGold2, 0.34, 0.34, 0.12, 0, 1.6 + k * 2.2, 17, 10)
  b.sph(M.templeGold2, 0.38, 0, 11.9, 17, 0.8)
  b.box(M.gopuramOrange, 1.5, 0.9, 0.04, 0.8, 10.6, 17)
  // sanctum idol: pedestal, golden figure, halo and lamps
  b.ext(M.templeStone, -1.4, 0.2, -16.6, 1.4, 0.9, -14.4)
  b.cyl(M.templeGold2, 0.5, 0.65, 2.0, 0, 1.9, -15.5, 10); b.sph(M.templeGold2, 0.38, 0, 3.1, -15.5)
  b.cyl(M.templeGold2, 0.9, 0.9, 0.06, 0, 3.0, -15.9, 20)
  for (const lx of [-1.8, 1.8]) { b.cyl(M.templeGold, 0.1, 0.16, 0.8, lx, 0.6, -14.8, 8); b.sph(M.lamp, 0.12, lx, 1.1, -14.8) }
  // windows (dark niches) on every gopuram tier face
  for (const [gx, gz, gh, hx, hz] of [[0, PS + 3.5, 16, 5.5, 3.5], [PX + 3, 0, 11, 3.2, 5.0], [-PX - 3, 0, 11, 3.2, 5.0]] as number[][]) {
    let wx = hx, wz = hz, y = 1.2
    for (let t = 0; t < 7; t++) {
      const th = (gh * 0.74) / 7 * Math.pow(0.95, t)
      for (let k = -1; k <= 1; k++) {
        if (hx >= hz) { for (const sz of [-1, 1]) b.ext(M.darkMetal, gx + k * wx * 0.55 - 0.3, y + th * 0.2, gz + sz * (wz + 0.01) - 0.02, gx + k * wx * 0.55 + 0.3, y + th * 0.75, gz + sz * (wz + 0.01) + 0.02) }
        else { for (const sx of [-1, 1]) b.ext(M.darkMetal, gx + sx * (wx + 0.01) - 0.02, y + th * 0.2, gz + k * wz * 0.55 - 0.3, gx + sx * (wx + 0.01) + 0.02, y + th * 0.75, gz + k * wz * 0.55 + 0.3) }
      }
      y += th; wx *= 0.87; wz *= 0.9
    }
  }
  // Bangaru Vakili (golden door) at the sanctum passage, Vendi Vakili (silver door) at the mandapam entrance
  for (const sx of [-1, 1]) { b.ext(M.templeGold, sx * 1.7 - 0.2, 0, -12.5, sx * 1.7 + 0.2, 3.3, -12.1); b.ext(M.steel, sx * 4.3 - 0.2, 0, 11.7, sx * 4.3 + 0.2, 3.3, 12.1) }
  b.ext(M.templeGold, -1.9, 3.3, -12.5, 1.9, 3.6, -12.1); b.ext(M.steel, -4.5, 3.3, 11.7, 4.5, 3.6, 12.1)
  for (let k = 0; k < 6; k++) b.sph(M.templeGold2, 0.09, (k - 2.5) * 0.55, 3.45, -12.55, 1, 6)
  // hundi (offering chest) and laddu counter in the east hall
  b.ext(M.red, 19.2, 0.15, -4.2, 20.8, 1.2, -3.2); b.ext(M.templeGold, 19.1, 1.2, -4.3, 20.9, 1.32, -3.1)
  b.ext(M.counter, 17, 0.15, 7.4, 23, 1.1, 8.4); b.ext(M.templeGold, 16.9, 1.1, 7.3, 23.1, 1.18, 8.5)
  // Mahadwaram court: colonnade along both sides
  for (const px of [-6.6, 6.6]) for (const pz of [13, 15.5, 18]) { b.cyl(M.templeStone, 0.3, 0.3, 3.2, px, 1.6, pz, 8); b.ext(M.templeStone, px - 0.45, 3.2, pz - 0.45, px + 0.45, 3.4, pz + 0.45) }
  // sacred tank (pushkarini) with steps, and palms
  const water = new THREE.MeshStandardMaterial({ color: '#2f7f9e', roughness: 0.1, metalness: 0.3 })
  b.ext(M.templeStone, -50, 0, 4, -34, 0.4, 18)
  b.ext(M.templeGold, -50.1, 0.4, 3.9, -33.9, 0.5, 5.2); b.ext(M.templeGold, -50.1, 0.4, 16.8, -33.9, 0.5, 18.1)
  b.ext(M.templeGold, -50.1, 0.4, 5.2, -48.8, 0.5, 16.8); b.ext(M.templeGold, -35.2, 0.4, 5.2, -33.9, 0.5, 16.8)
  b.floor(water, rect(-48.6, 5.4, -35.4, 16.6), 0.43)
  for (const [tx, tz] of [[-40, -40], [40, -40], [-42, 30], [42, 28], [-58, -10], [58, 6], [-30, 34], [30, 40], [52, -26], [-52, -30]]) {
    b.cyl(M.bark, 0.2, 0.3, 7, tx, 3.5, tz, 7)
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; b.rod(M.plantDark, 0.09, [tx, 7, tz], [tx + Math.cos(a) * 2.6, 6.1, tz + Math.sin(a) * 2.6], 5) }
    b.sph(M.plant, 0.6, tx, 7.1, tz, 0.7)
  }

  const pickMat = new THREE.MeshBasicMaterial({ visible: false })
  for (const [x0, z0, x1, z1] of [[-13, -2, 13, 12], [-24, -6, -16, 10], [16, -6, 24, 10], [-7, 12, 7, 18], [-5, -12, 5, -2]]) {
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
