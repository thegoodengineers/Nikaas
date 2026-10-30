/* eslint-disable @typescript-eslint/no-explicit-any */
// Instanced human figures: torso, head, hair, two arms, two-part legs and a glow ring at the feet.
// One draw call per body part for the whole crowd.
import * as THREE from 'three'
import { mergeGeometries } from '../vendor/three/addons/utils/BufferGeometryUtils.js'

export type Pose = {
  x: number; y: number; z: number; yaw: number; scale: number
  sit: number      // 0 standing .. 1 seated
  crouch: number   // 0 .. 1 drop, cover, hold
  phase: number    // walk cycle (radians)
  move: number     // 0 .. 1 stride size
  wave: number     // 0 .. 1 arm waving for help
  alarm: number    // 0 .. 1 tense arms
  lean: number
  t: number
  chair: boolean   // seated in a wheelchair
}

const SKIN = ['#f1c7a5', '#e0ac85', '#c68863', '#a86f4c', '#8d5a3c', '#6e4430']
const HAIR = ['#1c1714', '#2e221a', '#4a3424', '#6b4a2e', '#8f8f8f', '#141414', '#3b2a20']
const SHIRT = ['#e5e7eb', '#1f2937', '#2563eb', '#dc2626', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#f472b6', '#334155', '#a16207', '#f8fafc', '#0f766e', '#9f1239']
const PANTS = ['#1f2937', '#111827', '#374151', '#1e3a8a', '#44403c', '#57534e', '#0f172a', '#78716c']

export class CrowdView {
  n: number
  torso: any; head: any; hair: any; arms: any; thighs: any; shins: any; ring: any; frame: any; wheels: any
  private B = new THREE.Matrix4(); private T = new THREE.Matrix4(); private P = new THREE.Matrix4(); private Q = new THREE.Matrix4()
  private R = new THREE.Matrix4(); private S = new THREE.Matrix4(); private Z = new THREE.Matrix4().makeScale(0, 0, 0)
  private c = new THREE.Color()

  constructor(n: number, scene: any, rnd: () => number) {
    this.n = n
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0 })
    // big crowds get lighter figures (about 40 % of the triangles) and only bodies cast shadows: same look from the
    // usual camera distance, a much lighter frame on laptop graphics
    const lite = n > 250
    const cap = (r: number, len: number, drop: boolean) => { const g = new THREE.CapsuleGeometry(r, len, lite ? 2 : 3, lite ? 6 : 8); if (drop) g.translate(0, -(len / 2 + r), 0); return g }
    const torsoG = new THREE.CapsuleGeometry(0.16, 0.34, lite ? 3 : 4, lite ? 8 : 10); torsoG.scale(1.18, 1, 0.7); torsoG.translate(0, 0.33, 0)
    const hairG = new THREE.SphereGeometry(0.122, lite ? 9 : 12, lite ? 5 : 8, 0, Math.PI * 2, 0, Math.PI * 0.55); hairG.translate(0, 0.008, -0.012)
    const mk = (g: any, count: number, shadow = true) => {
      const im = new THREE.InstancedMesh(g, mat, count)
      im.castShadow = shadow; im.frustumCulled = false; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      scene.add(im); return im
    }
    this.torso = mk(torsoG, n); this.head = mk(new THREE.SphereGeometry(0.108, lite ? 10 : 14, lite ? 7 : 10), n); this.hair = mk(hairG, n, !lite)
    this.arms = mk(cap(0.048, 0.5, true), n * 2, !lite); this.thighs = mk(cap(0.072, 0.32, true), n * 2); this.shins = mk(cap(0.06, 0.34, true), n * 2, !lite)
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })
    const ringG = new THREE.RingGeometry(0.27, 0.38, 28); ringG.rotateX(-Math.PI / 2)
    // wheelchairs: one frame and two wheels per person, shown only for wheelchair users
    const bx = (w: number, h: number, d: number, x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return g }
    const frameG = mergeGeometries([
      bx(0.44, 0.05, 0.42, 0, 0.48, -0.02), bx(0.44, 0.5, 0.04, 0, 0.75, -0.22), bx(0.04, 0.05, 0.36, 0.23, 0.62, -0.04), bx(0.04, 0.05, 0.36, -0.23, 0.62, -0.04),
      bx(0.3, 0.03, 0.14, 0, 0.2, 0.3), bx(0.04, 0.04, 0.12, 0.2, 0.98, -0.28), bx(0.04, 0.04, 0.12, -0.2, 0.98, -0.28),
      bx(0.04, 0.3, 0.04, 0.2, 0.33, 0.24), bx(0.04, 0.3, 0.04, -0.2, 0.33, 0.24),
    ])
    const hub = new THREE.CylinderGeometry(0.05, 0.05, 0.05, 8); hub.rotateZ(Math.PI / 2)
    const rim = new THREE.TorusGeometry(0.29, 0.022, 6, 18); rim.rotateY(Math.PI / 2)
    const wheelG = mergeGeometries([hub, rim])
    const chairMat = new THREE.MeshStandardMaterial({ color: '#35507a', roughness: 0.5, metalness: 0.4 })
    const wheelMat = new THREE.MeshStandardMaterial({ color: '#17191d', roughness: 0.7 })
    this.frame = new THREE.InstancedMesh(frameG, chairMat, n); this.frame.castShadow = true; this.frame.frustumCulled = false
    this.wheels = new THREE.InstancedMesh(wheelG, wheelMat, n * 2); this.wheels.castShadow = true; this.wheels.frustumCulled = false
    for (const m of [this.frame, this.wheels]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); for (let i = 0; i < m.count; i++) m.setMatrixAt(i, this.Z); scene.add(m) }
    this.ring = new THREE.InstancedMesh(ringG, ringMat, n); this.ring.frustumCulled = false; this.ring.renderOrder = 2
    this.ring.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(this.ring)
    const pick = (a: string[]) => a[Math.floor(rnd() * a.length)]
    for (let i = 0; i < n; i++) {
      const shirt = this.c.set(pick(SHIRT)).clone(), pants = new THREE.Color(pick(PANTS))
      this.torso.setColorAt(i, shirt); this.arms.setColorAt(2 * i, shirt); this.arms.setColorAt(2 * i + 1, shirt)
      this.thighs.setColorAt(2 * i, pants); this.thighs.setColorAt(2 * i + 1, pants)
      this.shins.setColorAt(2 * i, pants); this.shins.setColorAt(2 * i + 1, pants)
      this.head.setColorAt(i, this.c.set(pick(SKIN))); this.hair.setColorAt(i, this.c.set(pick(HAIR)))
      this.ring.setColorAt(i, this.c.setRGB(0, 0, 0))
    }
    for (const m of [this.torso, this.head, this.hair, this.arms, this.thighs, this.shins, this.ring]) if (m.instanceColor) m.instanceColor.needsUpdate = true
  }

  setRing(i: number, r: number, g: number, b: number) { this.ring.setColorAt(i, this.c.setRGB(r, g, b)) }

  hide(i: number) {
    const Z = this.Z
    this.torso.setMatrixAt(i, Z); this.head.setMatrixAt(i, Z); this.hair.setMatrixAt(i, Z); this.ring.setMatrixAt(i, Z)
    this.frame.setMatrixAt(i, Z); this.wheels.setMatrixAt(2 * i, Z); this.wheels.setMatrixAt(2 * i + 1, Z)
    for (const k of [2 * i, 2 * i + 1]) { this.arms.setMatrixAt(k, Z); this.thighs.setMatrixAt(k, Z); this.shins.setMatrixAt(k, Z) }
  }

  pose(i: number, p: Pose) {
    const { B, T, P, Q, R, S } = this
    const s = p.scale
    B.makeRotationY(p.yaw); B.setPosition(p.x, p.y, p.z); S.makeScale(s, s, s); B.multiply(S)
    // ring stays flat on the floor
    T.makeTranslation(p.x, p.y + 0.03, p.z); this.ring.setMatrixAt(i, T)

    const sit = p.sit, cr = p.crouch, mv = p.move
    const hipY = 0.92 * (1 - sit) * (1 - cr) + 0.55 * sit * (1 - cr) + 0.36 * cr
    const sw = Math.sin(p.phase) * 0.55 * mv
    const lean = p.lean + cr * 0.95
    // legs
    for (let side = 0; side < 2; side++) {
      const sg = side ? -1 : 1
      const walkT = sg * sw, walkK = mv * 0.9 * Math.max(0, -Math.sin(p.phase * 1 + (side ? Math.PI : 0)) * 0.8 + 0.15)
      const thigh = walkT * (1 - sit) * (1 - cr) - (Math.PI / 2) * sit * (1 - cr) - 1.75 * cr
      const knee = walkK * (1 - sit) * (1 - cr) + (Math.PI / 2) * sit * (1 - cr) + 2.45 * cr
      P.copy(B).multiply(T.makeTranslation(sg * 0.09, hipY, 0)).multiply(R.makeRotationX(thigh))
      this.thighs.setMatrixAt(2 * i + side, P)
      Q.copy(P).multiply(T.makeTranslation(0, -0.46, 0)).multiply(R.makeRotationX(knee))
      this.shins.setMatrixAt(2 * i + side, Q)
    }
    // torso, head
    P.copy(B).multiply(T.makeTranslation(0, hipY, 0)).multiply(R.makeRotationX(lean))
    this.torso.setMatrixAt(i, P)
    Q.copy(P).multiply(T.makeTranslation(0, 0.8, 0.01))
    if (p.alarm > 0 && mv < 0.3) Q.multiply(R.makeRotationY(Math.sin(p.t * 2.3 + i) * 0.6 * p.alarm))
    this.head.setMatrixAt(i, Q); this.hair.setMatrixAt(i, Q)
    // arms
    for (let side = 0; side < 2; side++) {
      const sg = side ? -1 : 1
      let a = -sg * sw * 0.9 * (1 - sit) - 0.55 * sit - 2.55 * cr - 0.35 * p.alarm * (1 - mv)
      let spread = sg * (0.1 + 0.15 * cr)
      if (p.wave > 0 && side === 1) { a = a * (1 - p.wave) - 2.9 * p.wave; spread = sg * (0.25 + Math.sin(p.t * 7 + i) * 0.35) * p.wave + spread * (1 - p.wave) }
      Q.copy(P).multiply(T.makeTranslation(sg * 0.215, 0.6, 0)).multiply(R.makeRotationX(a)).multiply(S.makeRotationZ(spread))
      this.arms.setMatrixAt(2 * i + side, Q)
    }
    if (p.chair) {
      this.frame.setMatrixAt(i, B)
      for (let side = 0; side < 2; side++) {
        const sg = side ? -1 : 1
        Q.copy(B).multiply(T.makeTranslation(sg * 0.27, 0.3, -0.08)).multiply(R.makeRotationX(p.phase * 0.9))
        this.wheels.setMatrixAt(2 * i + side, Q)
      }
    } else { this.frame.setMatrixAt(i, this.Z); this.wheels.setMatrixAt(2 * i, this.Z); this.wheels.setMatrixAt(2 * i + 1, this.Z) }
  }

  commit() {
    for (const m of [this.torso, this.head, this.hair, this.arms, this.thighs, this.shins, this.ring, this.frame, this.wheels]) m.instanceMatrix.needsUpdate = true
    if (this.ring.instanceColor) this.ring.instanceColor.needsUpdate = true
  }

  dispose() {
    for (const m of [this.torso, this.head, this.hair, this.arms, this.thighs, this.shins, this.ring, this.frame, this.wheels]) { m.geometry.dispose(); m.removeFromParent() }
  }
}
