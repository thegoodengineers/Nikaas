/* eslint-disable @typescript-eslint/no-explicit-any */
// Fire, smoke, falling debris, dust, exit beacons, animated route ribbons and the stair barrier.
import * as THREE from 'three'
import { WALL_H, FH } from './layout.ts'
import { softDot, radialTex, mulberry32, type Mats } from './materials.ts'

const rnd = mulberry32(99)
const DOT = softDot()
export const pointScale = { value: 600 }   // px per world unit at depth 1; set from the camera on resize

function pointsMat(kind: 'fire' | 'smoke' | 'dust') {
  const frag = {
    fire: `vec3 c = mix(vec3(4.0,3.1,1.6), vec3(3.2,1.1,0.18), smoothstep(0.0,0.42,vLife));
           c = mix(c, vec3(0.6,0.08,0.02), smoothstep(0.42,1.0,vLife));
           float a = t.a * (1.0 - vLife) * smoothstep(0.0,0.08,vLife) * 0.9;
           gl_FragColor = vec4(c * a, a);`,
    smoke: `float a = t.a * smoothstep(0.0,0.15,vLife) * (1.0 - vLife) * 0.42;
            gl_FragColor = vec4(vec3(0.07,0.07,0.08) + vLife * 0.06, a);`,
    dust: `float a = t.a * smoothstep(0.0,0.1,vLife) * (1.0 - vLife) * 0.5;
           gl_FragColor = vec4(vec3(0.52,0.48,0.42), a);`,
  }[kind]
  return new THREE.ShaderMaterial({
    uniforms: { uMap: { value: DOT }, uScale: pointScale },
    vertexShader: `attribute float aLife; attribute float aSize; uniform float uScale; varying float vLife;
      void main(){ vLife = aLife; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = aSize * uScale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D uMap; varying float vLife; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); if (vLife <= 0.0 || vLife >= 1.0) discard; ${frag} }`,
    transparent: true, depthWrite: false,
    blending: kind === 'fire' ? THREE.AdditiveBlending : THREE.NormalBlending,
  })
}

class Cloud {
  n: number; pos: Float32Array; vel: Float32Array; life: Float32Array; dur: Float32Array; size: Float32Array; base: Float32Array
  geo: any; points: any
  constructor(n: number, kind: 'fire' | 'smoke' | 'dust') {
    this.n = n
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3)
    this.life = new Float32Array(n).fill(2); this.dur = new Float32Array(n).fill(1); this.size = new Float32Array(n); this.base = new Float32Array(n)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1))
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    this.points = new THREE.Points(this.geo, pointsMat(kind)); this.points.frustumCulled = false
    this.points.renderOrder = kind === 'fire' ? 4 : 3
  }
  spawn(k: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, dur: number, size: number) {
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz
    this.life[k] = 0.0001; this.dur[k] = dur; this.base[k] = size; this.size[k] = size
  }
  step(dt: number, grow: number, drag: number, lift: number) {
    for (let k = 0; k < this.n; k++) {
      if (this.life[k] >= 1) continue
      this.life[k] = Math.min(1, this.life[k] + dt / this.dur[k])
      const i = k * 3
      this.vel[i] *= 1 - drag * dt; this.vel[i + 2] *= 1 - drag * dt; this.vel[i + 1] += lift * dt
      this.pos[i] += this.vel[i] * dt; this.pos[i + 1] += this.vel[i + 1] * dt; this.pos[i + 2] += this.vel[i + 2] * dt
      this.size[k] = this.base[k] * (1 + grow * this.life[k])
    }
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aLife.needsUpdate = true; this.geo.attributes.aSize.needsUpdate = true
  }
  dispose() { this.geo.dispose(); this.points.material.dispose() }
}

/** A growing fire: flames, a smoke column, scorch and glow on the floor, flickering light. */
export class Fire {
  group = new THREE.Group()
  private flames = new Cloud(320, 'fire')
  private smoke = new Cloud(170, 'smoke')
  private light: any
  private glow: any
  private scorch: any
  private acc = 0; private accS = 0
  constructor(x: number, z: number) {
    this.group.position.set(x, 0, z)
    this.group.add(this.flames.points, this.smoke.points)
    this.light = new THREE.PointLight('#ff7a2a', 60, 16, 1.6); this.light.position.y = 1.4; this.group.add(this.light)
    const disc = new THREE.PlaneGeometry(1, 1); disc.rotateX(-Math.PI / 2)
    this.scorch = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ map: radialTex('rgba(10,6,4,0.95)', 'rgba(10,6,4,0)'), transparent: true, depthWrite: false }))
    this.scorch.position.y = 0.03; this.group.add(this.scorch)
    this.glow = new THREE.Mesh(disc, new THREE.MeshBasicMaterial({ map: radialTex('rgba(255,120,30,1)', 'rgba(255,60,10,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.glow.position.y = 0.04; this.group.add(this.glow)
  }
  update(dt: number, t: number, r: number) {
    const F = this.flames, S = this.smoke
    this.acc += dt * (90 + r * 70)
    for (let k = 0; k < F.n && this.acc > 1; k++) {
      if (F.life[k] < 1) continue
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.85
      F.spawn(k, Math.cos(a) * d, 0.05 + rnd() * 0.2, Math.sin(a) * d, (rnd() - 0.5) * 0.4, 1.3 + rnd() * 1.8, (rnd() - 0.5) * 0.4, 0.45 + rnd() * 0.6, 0.55 + rnd() * 0.7)
      this.acc--
    }
    F.step(dt, -0.5, 0.5, 0.6)
    this.accS += dt * (14 + r * 6)
    for (let k = 0; k < S.n && this.accS > 1; k++) {
      if (S.life[k] < 1) continue
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.6
      S.spawn(k, Math.cos(a) * d, 1.2 + rnd() * 0.5, Math.sin(a) * d, (rnd() - 0.5) * 0.5, 0.9 + rnd() * 0.6, (rnd() - 0.5) * 0.5, 3 + rnd() * 2.5, 1.6 + rnd())
      this.accS--
    }
    // smoke spreads under the ceiling
    for (let k = 0; k < S.n; k++) if (S.life[k] < 1 && S.pos[k * 3 + 1] > WALL_H - 0.4) { S.pos[k * 3 + 1] = WALL_H - 0.4; S.vel[k * 3 + 1] = 0; S.vel[k * 3] += (S.pos[k * 3] > 0 ? 1 : -1) * dt * 0.8; S.vel[k * 3 + 2] += (S.pos[k * 3 + 2] > 0 ? 1 : -1) * dt * 0.4 }
    S.step(dt, 1.8, 0.3, 0.05)
    this.scorch.scale.setScalar(r * 2.6); this.glow.scale.setScalar(r * 2.2 + Math.sin(t * 9) * 0.15)
    this.light.intensity = 45 + r * 30 + Math.sin(t * 13) * 10 + Math.sin(t * 31) * 6
    this.light.distance = 12 + r * 3
  }
  dispose() { this.flames.dispose(); this.smoke.dispose(); this.group.removeFromParent() }
}

/** Ceiling or roof failure: slabs and plaster fall with simple physics, then dust rolls out. */
export class Collapse {
  group = new THREE.Group()
  private chunks: { m: any; v: any; w: any; h: number; rest: boolean }[] = []
  private dust = new Cloud(240, 'dust')
  private landed = false
  private r: number
  onLand?: () => void
  constructor(M: Mats, x: number, z: number, r: number, count = 28, delay = 0) {
    this.group.position.set(x, 0, z)
    this.group.add(this.dust.points)
    for (let k = 0; k < count; k++) {
      const big = k < count * 0.35
      const w = big ? 0.8 + rnd() * 1.0 : 0.2 + rnd() * 0.5, h = big ? 0.18 + rnd() * 0.15 : 0.12 + rnd() * 0.25, d = big ? 0.6 + rnd() * 0.9 : 0.2 + rnd() * 0.5
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), k % 5 === 0 ? M.plaster : M.concrete)
      m.castShadow = true; m.receiveShadow = true
      const a = rnd() * Math.PI * 2, dd = Math.sqrt(rnd()) * r
      m.position.set(Math.cos(a) * dd, FH - 0.35 + rnd() * 0.6 + delay * 9 * rnd(), Math.sin(a) * dd)
      m.rotation.set(rnd() * 0.6, rnd() * 3, rnd() * 0.6)
      this.chunks.push({ m, v: new THREE.Vector3((rnd() - 0.5) * 0.6, -rnd() * 2, (rnd() - 0.5) * 0.6), w: new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(4), h: Math.min(w, h, d) / 2 + 0.02, rest: false })
      this.group.add(m)
    }
    // broken rebar
    for (let k = 0; k < 5; k++) {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.2 + rnd(), 5), M.darkMetal)
      m.position.set((rnd() - 0.5) * r, FH - 0.2, (rnd() - 0.5) * r); m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3)
      this.chunks.push({ m, v: new THREE.Vector3(0, -1, 0), w: new THREE.Vector3(rnd(), rnd(), rnd()), h: 0.03, rest: false })
      this.group.add(m)
    }
    this.r = r
  }
  update(dt: number) {
    const D = this.dust
    for (const c of this.chunks) {
      if (c.rest) continue
      c.v.y -= 9.8 * dt
      c.m.position.addScaledVector(c.v, dt)
      c.m.rotation.x += c.w.x * dt; c.m.rotation.y += c.w.y * dt; c.m.rotation.z += c.w.z * dt
      if (c.m.position.y < c.h) {
        c.m.position.y = c.h
        if (!this.landed) {
          this.landed = true; this.onLand?.()
          for (let k = 0; k < D.n; k++) {
            const a = rnd() * Math.PI * 2, d = rnd() * this.r
            D.spawn(k, Math.cos(a) * d, 0.2 + rnd() * 1.2, Math.sin(a) * d, Math.cos(a) * (0.8 + rnd() * 2.2), 0.2 + rnd() * 0.8, Math.sin(a) * (0.8 + rnd() * 2.2), 3 + rnd() * 4, 1.0 + rnd() * 1.2)
          }
        }
        if (Math.abs(c.v.y) < 1.2) { c.rest = true; c.m.rotation.x = Math.round(c.m.rotation.x / Math.PI) * Math.PI + (rnd() - 0.5) * 0.3; c.m.rotation.z = Math.round(c.m.rotation.z / Math.PI) * Math.PI + (rnd() - 0.5) * 0.3 }
        c.v.y *= -0.28; c.v.x *= 0.55; c.v.z *= 0.55; c.w.multiplyScalar(0.5)
      }
    }
    D.step(dt, 2.6, 1.2, -0.02)
  }
  dispose() { this.dust.dispose(); this.group.traverse((o: any) => o.geometry?.dispose()); this.group.removeFromParent() }
}

const beamMat = (color: any) => new THREE.ShaderMaterial({
  uniforms: { uColor: { value: color }, uTime: { value: 0 }, uAlpha: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv;
    void main(){ float fade = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.6); float bands = 0.55 + 0.45 * sin(vUv.y * 40.0 - uTime * 5.0);
      float a = fade * (0.25 + 0.35 * bands) * uAlpha; gl_FragColor = vec4(uColor * 2.4 * a, a); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
})

/** Light column and pulsing ring marking an exit: green = safe, red = blocked, amber = smoke on the route. */
export class Beacon {
  group = new THREE.Group()
  column: any; ring: any; pick: any
  private color = new THREE.Color('#22c55e')
  private alpha = 0
  target = 0
  id: string
  constructor(x: number, z: number, id: string) {
    this.id = id
    this.group.position.set(x, 0, z)
    const col = new THREE.CylinderGeometry(1.1, 1.1, 16, 28, 1, true); col.translate(0, 8, 0)
    this.column = new THREE.Mesh(col, beamMat(this.color)); this.column.renderOrder = 5
    const rg = new THREE.RingGeometry(1.25, 1.65, 48); rg.rotateX(-Math.PI / 2)
    this.ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: this.color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    this.ring.position.y = 0.05
    this.pick = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 8, 8), new THREE.MeshBasicMaterial({ visible: false }))
    this.pick.position.y = 4; this.pick.userData.exit = id
    this.group.add(this.column, this.ring, this.pick)
  }
  setStatus(s: string) { this.color.set(s === 'safe' ? '#22c55e' : s === 'smoke' ? '#f59e0b' : '#ef4444') }
  update(dt: number, t: number) {
    this.alpha += (this.target - this.alpha) * Math.min(1, dt * 3)
    this.column.material.uniforms.uTime.value = t
    this.column.material.uniforms.uAlpha.value = this.alpha
    const k = (t * 0.8) % 1
    this.ring.scale.setScalar(1 + k * 1.6); this.ring.material.opacity = this.alpha * (1 - k) * 0.9
    this.ring.material.color.copy(this.color).multiplyScalar(2)
    this.group.visible = this.alpha > 0.01
  }
}

/** Assembly point: a painted ring, a sign on a post. */
export function assemblyMark(M: Mats, x: number, z: number) {
  const g = new THREE.Group(); g.position.set(x, 0, z)
  const ring = new THREE.RingGeometry(4.6, 4.9, 64); ring.rotateX(-Math.PI / 2)
  const rm = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.3, 0.55), transparent: true, opacity: 0.75, depthWrite: false }))
  rm.position.y = 0.02; g.add(rm)
  const fill = new THREE.CircleGeometry(4.6, 48); fill.rotateX(-Math.PI / 2)
  const fm = new THREE.Mesh(fill, new THREE.MeshBasicMaterial({ color: '#0c8f4c', transparent: true, opacity: 0.16, depthWrite: false }))
  fm.position.y = 0.015; g.add(fm)
  const d = Math.hypot(x, z) || 1, px = (-x / d) * 5.4, pz = (-z / d) * 5.4
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 8), M.steel); post.position.set(px, 1.3, pz); post.castShadow = true; g.add(post)
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.12, 0.04), M.assemblySign); sign.position.set(px, 2.45, pz); sign.castShadow = true; g.add(sign)
  sign.lookAt(-x, 2.45, -z)
  return g
}

/** Glowing route ribbon with chevrons flowing toward the exit. Points carry a storey value so the ribbon
 * follows the floors when the building is pulled apart. */
export class Ribbon {
  mesh: any
  uniforms: any
  constructor(points: [number, number, number][], color: any, step: { value: number }, maxLevel: { value: number }) {
    const pos: number[] = [], lev: number[] = [], uv: number[] = [], idx: number[] = []
    let u = 0
    const w = 0.32
    for (let k = 0; k < points.length; k++) {
      const [x, l, z] = points[k], p = points[Math.max(0, k - 1)], nx = points[Math.min(points.length - 1, k + 1)]
      let dx = nx[0] - p[0], dz = nx[2] - p[2]; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d
      if (k > 0) u += Math.hypot(x - p[0], z - p[2]) + Math.abs(l - p[1]) * FH
      pos.push(x - dz * w, 0, z + dx * w, x + dz * w, 0, z - dx * w)
      lev.push(l, l); uv.push(u, 0, u, 1)
      if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('aLevel', new THREE.Float32BufferAttribute(lev, 1))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    this.uniforms = { uColor: { value: color }, uTime: { value: 0 }, uReveal: { value: 0 }, uLen: { value: u }, uStep: step, uMax: maxLevel, uAlpha: { value: 1 } }
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `attribute float aLevel; uniform float uStep; varying vec2 vUv; varying float vLev;
        void main(){ vUv = uv; vLev = aLevel; vec3 p = position; p.y = aLevel * uStep + 0.09 + (fract(aLevel) > 0.01 ? 0.12 : 0.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }`,
      fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uReveal; uniform float uLen; uniform float uMax; uniform float uAlpha;
        varying vec2 vUv; varying float vLev;
        void main(){
          if (vLev > uMax + 0.51) discard;
          if (vUv.x > uReveal * uLen) discard;
          float across = abs(vUv.y - 0.5) * 2.0;
          float s = fract(vUv.x * 0.7 - uTime * 1.4);
          float chev = smoothstep(0.0, 0.06, s - across * 0.32) * (1.0 - smoothstep(0.26, 0.34, s - across * 0.32));
          float edge = smoothstep(0.72, 0.95, across);
          float a = (0.22 + chev * 0.85 + edge * 0.5) * uAlpha * (1.0 - smoothstep(0.96, 1.0, across));
          gl_FragColor = vec4(uColor * (0.9 + chev * 2.2), a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
    this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 3
  }
  update(dt: number, t: number) { this.uniforms.uTime.value = t; this.uniforms.uReveal.value = Math.min(1, this.uniforms.uReveal.value + dt * 0.7) }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.removeFromParent() }
}

const stripes = (() => {
  const c = document.createElement('canvas'); c.width = 256; c.height = 32
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 32); g.fillStyle = '#d61f1f'
  for (let x = -32; x < 256; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 0); g.lineTo(x + 32, 0); g.lineTo(x + 16, 32); g.fill() }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t
})()

/** Barrier tape, warning light and rubble across a closed stair door, one per storey. */
export function stairBarrier(M: Mats, door: [number, number], axis: 'x' | 'z', width: number, side: number) {
  const g = new THREE.Group()
  const tape = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.6, emissive: '#ff3030', emissiveIntensity: 0.15 })
  const along = axis === 'x' ? 'z' : 'x'
  const off = side * 0.45
  for (const y of [0.55, 1.05]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(along === 'z' ? 0.03 : width + 0.4, 0.09, along === 'z' ? width + 0.4 : 0.03), tape)
    b.position.set(door[0] + (axis === 'x' ? off : 0), y, door[1] + (axis === 'z' ? off : 0)); g.add(b)
  }
  for (const s of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.2, 8), M.red)
    p.position.set(door[0] + (axis === 'x' ? off : s * (width / 2 + 0.15)), 0.6, door[1] + (axis === 'z' ? off : s * (width / 2 + 0.15))); p.castShadow = true; g.add(p)
  }
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 0.4, 0.3) }))
  lamp.position.set(door[0] + (axis === 'x' ? off : -width / 2 - 0.15), 1.3, door[1] + (axis === 'z' ? off : axis === 'x' ? -width / 2 - 0.15 : 0))
  g.add(lamp); g.userData.lamp = lamp
  for (let k = 0; k < 9; k++) {
    const s = 0.2 + rnd() * 0.45, m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s), M.concrete)
    m.position.set(door[0] - (axis === 'x' ? off * 2.2 : 0) + (rnd() - 0.5) * (axis === 'z' ? width : 1.4), s * 0.3, door[1] - (axis === 'z' ? off * 2.2 : 0) + (rnd() - 0.5) * (axis === 'x' ? width : 1.4))
    m.rotation.y = rnd() * 3; m.castShadow = true; g.add(m)
  }
  return g
}

/** Placement cursor for incident tools. */
export function marker() {
  const g = new THREE.Group()
  const rg = new THREE.RingGeometry(0.9, 1.1, 40); rg.rotateX(-Math.PI / 2)
  const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 1.2, 0.3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
  const cross = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 2.6).rotateX(-Math.PI / 2), m.material)
  const cross2 = cross.clone(); cross2.rotation.y = Math.PI / 2
  g.add(m, cross, cross2); g.position.y = 0.06; g.visible = false; g.renderOrder = 6
  g.userData.mat = m.material
  return g
}
