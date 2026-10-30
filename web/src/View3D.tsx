/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from './vendor/three/OrbitControls.js'

type Node = { id: string; type: 'room' | 'corridor' | 'exit'; x: number; z: number; w?: number; d?: number; label?: string; floor_id?: string }
export type Building = { name: string; nodes: Node[]; edges: { from: string; to: string; width: number; kind?: string }[]; floors?: { id: string; elevation_m: number }[] }
// multi-floor runs also carry people_3d: [x, height, z, state, floor] (nikaas/sim.py)
export type Frame = { t: number; people: [number, number, string][]; people_3d?: [number, number, number, string, string][] }

type Props = {
  building: Building
  frame?: Frame
  blocked: string[]
  routes?: Record<string, string[][]>
  edgeLoad?: Record<string, number>
  bottleneck?: string
  peakQueue?: number
  height?: number
  cameraT?: number   // scroll film: 0..1 along a scripted camera path (disables orbit controls)
  wallRise?: number  // scroll film: 0..1, walls and furniture rise out of the floor
  showcase?: boolean // hero: slow auto-orbit, no wheel zoom (so the page still scrolls)
  onExit: (id: string) => void
}

// Look rules: docs/VISUAL_STYLE.md. White architectural model on a dark floor; colour only on
// people (state), escape routes (green) and danger (red).
const WALL_H = 1.7, WALL_T = 0.2
// multi-floor buildings are drawn with floors twice as far apart as real (an exploded view), so every floor stays visible
const EXPLODE = 2
const STATE_COLOR: Record<string, string> = { walking: '#f05a22', queuing: '#c8321a', stairs: '#2563eb', inside: '#e0763f' }

// free the GPU memory of everything under a scene node (geometry, materials and their textures)
function disposeTree(root: any) {
  root.traverse((o: any) => {
    o.geometry?.dispose()
    for (const m of [o.material].flat()) if (m) { m.map?.dispose(); m.dispose() }
  })
}

export default function View3D({ building, frame, blocked, routes, edgeLoad, bottleneck, peakQueue, height = 560, cameraT, wallRise = 1, showcase = false, onExit }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<any>({})

  // build the static scene once per building
  useEffect(() => {
    const el = host.current
    if (!el) return
    const W = el.clientWidth, H = height
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    renderer.setSize(W, H)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#eef1f3')
    const elev: Record<string, number> = Object.fromEntries((building.floors ?? []).map(f => [f.id, f.elevation_m * EXPLODE]))
    const Y = (n: Node) => (n.floor_id ? elev[n.floor_id] ?? 0 : 0)
    const topY = Math.max(0, ...building.nodes.map(Y))
    const xs = building.nodes.map(n => n.x), zs = building.nodes.map(n => n.z)
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), topY * 1.3) + 14
    scene.fog = new THREE.Fog('#eef1f3', span * 1.4, span * 3)

    scene.add(new THREE.HemisphereLight('#ffffff', '#9aa3ab', 1.2))
    const sun = new THREE.DirectionalLight('#fff7ee', 2.0)
    sun.position.set(cx - span * 0.4, span, cz + span * 0.5)
    sun.target.position.set(cx, 0, cz)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 })
    scene.add(sun, sun.target)

    const mat = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 })
    const white = mat('#f3f4f5'), floorMat = mat('#30353b'), walkMat = mat('#3b4047')
    if (topY > 0) Object.assign(walkMat, { transparent: true, opacity: 0.45, depthWrite: false }) // floors stacked: see the queues below
    // white tiled wall panels like an architect's model: 0.5 m tiles with light grout lines
    const tileCanvas = document.createElement('canvas'); tileCanvas.width = tileCanvas.height = 64
    const tg = tileCanvas.getContext('2d')!
    tg.fillStyle = '#f6f7f8'; tg.fillRect(0, 0, 64, 64); tg.strokeStyle = '#cdd2d7'; tg.lineWidth = 3; tg.strokeRect(0, 0, 64, 64)
    const tileTex = new THREE.CanvasTexture(tileCanvas); tileTex.colorSpace = THREE.SRGBColorSpace
    tileTex.wrapS = tileTex.wrapT = THREE.RepeatWrapping; tileTex.anisotropy = 8
    const tiled = (len: number) => { const t = tileTex.clone(); t.needsUpdate = true; t.repeat.set(Math.max(1, len / 0.5), WALL_H / 0.5); return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }) }
    const deskMat = mat('#e6e9ec'), legMat = mat('#b9c0c7'), plantMat = mat('#5b8a4a')
    const rise = new THREE.Group(); scene.add(rise) // walls + furniture: scaled in y for the 'becomes a building' moment
    const box = (w: number, h: number, d: number, m: any, x: number, y: number, z: number) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m)
      b.position.set(x, y, z); b.castShadow = true; b.receiveShadow = true; rise.add(b); return b
    }
    // a strip between two points at different heights (a stair flight): a thin box turned to point from a to b
    const slope = (a: Node, b: Node, width: number, m: any, lift: number) => {
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.5) { // a stair straight down a shaft: draw the shaft, see-through so its queue shows
        const mm = m.clone(); mm.transparent = true; mm.opacity = Math.min(mm.opacity ?? 1, 0.3); mm.depthWrite = false
        const sh = new THREE.Mesh(new THREE.BoxGeometry(width + 1.2, Math.abs(Y(b) - Y(a)), width + 1.2), mm)
        sh.position.set(a.x, (Y(a) + Y(b)) / 2, a.z); return sh
      }
      const dir = new THREE.Vector3(b.x - a.x, Y(b) - Y(a), b.z - a.z), len = dir.length()
      const st = new THREE.Mesh(new THREE.BoxGeometry(len, 0.04, width), m)
      st.position.set((a.x + b.x) / 2, (Y(a) + Y(b)) / 2 + lift, (a.z + b.z) / 2)
      st.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.normalize()); st.receiveShadow = true
      return st
    }
    const slab = new THREE.Mesh(new THREE.PlaneGeometry(span + 10, span * 0.75 + 10), floorMat)
    slab.rotation.x = -Math.PI / 2; slab.position.set(cx, 0, cz); slab.receiveShadow = true; scene.add(slab)

    const byId = Object.fromEntries(building.nodes.map(n => [n.id, n]))
    // glass floor plates for upper floors, so each storey reads as a level
    for (const f of building.floors ?? []) if (elev[f.id] > 0) {
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(span - 6, span * 0.75 - 6), new THREE.MeshStandardMaterial({ color: '#cfd6dc', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }))
      plate.rotation.x = -Math.PI / 2; plate.position.set(cx, elev[f.id] - 0.02, cz); scene.add(plate)
    }
    // walkways between corridor / exit points, as slightly lighter floor strips (one material each: jams turn red)
    const strips: Record<string, any> = {}
    for (const e of building.edges) {
      const a = byId[e.from], b = byId[e.to]
      if (a.type === 'room' || b.type === 'room') continue
      if (Y(a) !== Y(b)) { const st = slope(a, b, e.width, walkMat.clone(), 0.01); strips[`${e.from}-${e.to}`] = st; strips[`${e.to}-${e.from}`] = st; scene.add(st); continue }
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      if (len < 0.01) continue
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(len + e.width, e.width), walkMat.clone())
      strips[`${e.from}-${e.to}`] = strip; strips[`${e.to}-${e.from}`] = strip
      strip.rotation.x = -Math.PI / 2; strip.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x)
      strip.position.set((a.x + b.x) / 2, Y(a) + 0.01, (a.z + b.z) / 2); strip.receiveShadow = true; scene.add(strip)
    }
    // rooms: four low white walls, with a gap on the side facing each door
    const label = (text: string, x: number, z: number, size = 1.1, y = 0) => {
      const c = document.createElement('canvas'); c.width = 512; c.height = 96
      const g = c.getContext('2d')!; g.fillStyle = '#c9ced3'; g.font = '600 44px Segoe UI'; g.textAlign = 'center'; g.fillText(text, 256, 62, 500)
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 5.3, size), new THREE.MeshBasicMaterial({ map: t, transparent: true }))
      m.rotation.x = -Math.PI / 2; m.position.set(x, y + 0.03, z); scene.add(m)
    }
    for (const r of building.nodes.filter(n => n.type === 'room')) {
      const ry = Y(r), rbox = (w: number, h: number, d: number, m: any, x: number, y: number, z: number) => box(w, h, d, m, x, y + ry, z)
      const w = r.w ?? 4, d = r.d ?? 4, x0 = r.x - w / 2, x1 = r.x + w / 2, z0 = r.z - d / 2, z1 = r.z + d / 2
      const gaps: Record<string, [number, number][]> = { N: [], S: [], W: [], E: [] }
      // People walk in straight lines between graph points, so every place a path crosses this room's outline
      // must be an opening; otherwise they appear to walk through walls (seen on the photo-read building).
      const cross = (ax: number, az: number, bx: number, bz: number, half: number) => {
        const hit = (t: number) => t >= 0 && t <= 1
        if (bz !== az) for (const [side, zz] of [['N', z0], ['S', z1]] as const) {
          const t = (zz - az) / (bz - az); const x = ax + (bx - ax) * t
          if (hit(t) && x >= x0 - 0.01 && x <= x1 + 0.01) gaps[side].push([x - half, x + half])
        }
        if (bx !== ax) for (const [side, xx] of [['W', x0], ['E', x1]] as const) {
          const t = (xx - ax) / (bx - ax); const z = az + (bz - az) * t
          if (hit(t) && z >= z0 - 0.01 && z <= z1 + 0.01) gaps[side].push([z - half, z + half])
        }
      }
      for (const e of building.edges) {
        const a = byId[e.from], b = byId[e.to]
        if (Y(a) !== ry || Y(b) !== ry) continue // only paths on this room's floor cut its walls
        cross(a.x, a.z, b.x, b.z, Math.max(0.7, e.width / 2 + 0.25))
      }
      const wall = (a: number, b: number, fixed: number, horiz: boolean, cuts: [number, number][]) => {
        let s = a
        for (const [g0, g1] of cuts.sort((p, q) => p[0] - q[0])) {
          if (g0 > s) horiz ? rbox(g0 - s, WALL_H, WALL_T, tiled(g0 - s), (s + g0) / 2, WALL_H / 2, fixed) : rbox(WALL_T, WALL_H, g0 - s, tiled(g0 - s), fixed, WALL_H / 2, (s + g0) / 2)
          s = Math.max(s, g1)
        }
        if (b > s) horiz ? rbox(b - s, WALL_H, WALL_T, tiled(b - s), (s + b) / 2, WALL_H / 2, fixed) : rbox(WALL_T, WALL_H, b - s, tiled(b - s), fixed, WALL_H / 2, (s + b) / 2)
      }
      wall(x0, x1, z0, true, gaps.N); wall(x0, x1, z1, true, gaps.S); wall(z0, z1, x0, false, gaps.W); wall(z0, z1, x1, false, gaps.E)
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat('#454a51'))
      fl.rotation.x = -Math.PI / 2; fl.position.set(r.x, ry + 0.015, r.z); fl.receiveShadow = true; scene.add(fl)
      label(r.label ?? r.id, r.x, r.z - d / 2 + 0.9, Math.min(1.1, w / 5.6), ry)
      if (w >= 4 && d >= 4) {
        const cols = Math.max(1, Math.floor((w - 1.6) / 2.4)), rows = Math.max(1, Math.floor((d - 2.4) / 2.2))
        for (let a = 0; a < cols; a++) for (let c = 0; c < rows; c++) {
          const dx = x0 + 1.2 + (a + 0.5) * ((w - 2.4) / cols), dz = z0 + 1.8 + (c + 0.5) * ((d - 3) / rows)
          rbox(1.5, 0.08, 0.7, deskMat, dx, 0.74, dz); rbox(1.4, 0.7, 0.06, legMat, dx, 0.37, dz)
        }
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.4, 12), white); pot.position.set(x1 - 0.7, ry + 0.2, z0 + 0.7); rise.add(pot)
        const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 10), plantMat); leaf.position.set(x1 - 0.7, ry + 0.75, z0 + 0.7); leaf.castShadow = true; rise.add(leaf)
      }
    }
    // exits: a post with a sign, clickable
    const exitMeshes: any[] = []
    for (const x of building.nodes.filter(n => n.type === 'exit')) {
      const xy = Y(x)
      const sign = box(1.8, 0.7, 0.15, new THREE.MeshStandardMaterial({ color: '#16a34a', emissive: '#16a34a', emissiveIntensity: 0.35 }), x.x, xy + 2.2, x.z)
      box(0.15, 2.0, 0.15, white, x.x, xy + 1.0, x.z)
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.06, 32), new THREE.MeshStandardMaterial({ color: '#16a34a', transparent: true, opacity: 0.6 }))
      pad.position.set(x.x, xy + 0.04, x.z); scene.add(pad)
      sign.userData.exit = x.id; pad.userData.exit = x.id
      exitMeshes.push(sign, pad)
      label(x.label ?? x.id, x.x, x.z + 2.2, 1.0, xy)
    }

    // people: simple human figures (body + head), instanced
    const N = Math.max(1, building.nodes.reduce((s, n: any) => s + (n.people ?? 0), 0))
    // human figure = torso + legs + head (instanced), coloured by state
    const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.62, 0.26), new THREE.MeshStandardMaterial({ roughness: 0.55 }), N)
    const legs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.78, 0.2), mat('#3a3f46'), N)
    const head = new THREE.InstancedMesh(new THREE.SphereGeometry(0.15, 12, 10), mat('#f0b48a'), N)
    body.castShadow = head.castShadow = legs.castShadow = true
    body.frustumCulled = head.frustumCulled = legs.frustumCulled = false // instances move far from the origin; default culling hides them
    scene.add(body, legs, head)

    const routeGroup = new THREE.Group(); scene.add(routeGroup)
    const fires: Record<string, any> = {}
    for (const x of building.nodes.filter(n => n.type === 'exit')) {
      const f = new THREE.Group(); f.visible = false; f.position.set(x.x, Y(x), x.z); scene.add(f)
      const rings = [0, 1, 2].map(k => {
        const r = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.2, 48), new THREE.MeshBasicMaterial({ color: '#ff6a1a', transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))
        r.rotation.x = -Math.PI / 2; r.position.y = 0.06; r.userData.o = k / 3; f.add(r); return r
      })
      const flames = Array.from({ length: 14 }, (_, k) => {
        const m = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.1, 8), new THREE.MeshBasicMaterial({ color: k % 2 ? '#ff8a1a' : '#ffc21a', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }))
        m.userData.a = (k / 14) * Math.PI * 2; m.userData.p = k * 0.37; f.add(m); return m
      })
      const glow = new THREE.PointLight('#ff6a1a', 0, 14, 1.6); glow.position.y = 1.2; f.add(glow)
      fires[x.id] = { group: f, rings, flames, glow }
    }
    // bottleneck marker: pulsing red ring on the floor + a floating label, moved to the worst jam per run
    const marker = new THREE.Group(); marker.visible = false; scene.add(marker)
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.7, 48), new THREE.MeshBasicMaterial({ color: '#c81e1e', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }))
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.07; marker.add(ring)
    const tagCanvas = document.createElement('canvas'); tagCanvas.width = 512; tagCanvas.height = 128
    const tagTex = new THREE.CanvasTexture(tagCanvas); tagTex.colorSpace = THREE.SRGBColorSpace
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthTest: false })); tag.scale.set(13, 3.25, 1); tag.position.y = 5.5; marker.add(tag)

    const camera = new THREE.PerspectiveCamera(35, W / H, 0.5, span * 6)
    // tall buildings: step back and look from the side, so every floor and both stair shafts show
    if (topY > 0) camera.position.set(cx + span * 0.95, topY / 2 + span * 0.45, cz + span * 0.5)
    else camera.position.set(cx + span * 0.04, span * 0.52, cz + span * 0.66)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(cx, topY / 2, cz); controls.enableDamping = true; if (showcase) { controls.autoRotate = true; controls.autoRotateSpeed = 0.55; controls.enableZoom = false }; controls.maxPolarAngle = Math.PI * 0.45; controls.update()

    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2()
    let downAt = 0
    renderer.domElement.addEventListener('pointerdown', () => { downAt = performance.now() })
    renderer.domElement.addEventListener('pointerup', (ev: PointerEvent) => {
      if (performance.now() - downAt > 250) return // a drag to orbit, not a click
      const r = renderer.domElement.getBoundingClientRect()
      mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(mouse, camera)
      const hit = ray.intersectObjects(exitMeshes)[0]
      if (hit) api.current.onExit?.(hit.object.userData.exit)
    })

    let raf = 0
    const filmTarget = new THREE.Vector3(cx, 0, cz)
    // smooth motion: every render frame, people glide toward their latest simulated position
    const M = new THREE.Matrix4(), hide = new THREE.Matrix4().makeScale(0, 0, 0)
    let last = performance.now()
    const loop = () => {
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now
      const a = api.current, k = 1 - Math.exp(-dt * 6)
      if (a.target) {
        for (let n = 0; n < N; n++) {
          const tg = a.target[n]
          if (!tg) { body.setMatrixAt(n, hide); head.setMatrixAt(n, hide); legs.setMatrixAt(n, hide); continue }
          const ty = tg[3] ?? 0
          const c = a.cur[n] ?? (a.cur[n] = [tg[0], tg[1], ty])
          const jump = Math.hypot(tg[0] - c[0], tg[1] - c[1], ty - c[2]) > 25 // new run or restart: snap, do not slide across the map
          c[0] = jump ? tg[0] : c[0] + (tg[0] - c[0]) * k; c[1] = jump ? tg[1] : c[1] + (tg[1] - c[1]) * k; c[2] = jump ? ty : c[2] + (ty - c[2]) * k
          const moving = tg[2] === 'walking' || tg[2] === 'stairs'
          const bob = moving ? Math.abs(Math.sin(now / 140 + n)) * 0.05 : 0
          legs.setMatrixAt(n, M.makeTranslation(c[0], c[2] + 0.39, c[1]))
          body.setMatrixAt(n, M.makeTranslation(c[0], c[2] + 1.09 + bob, c[1]))
          head.setMatrixAt(n, M.makeTranslation(c[0], c[2] + 1.58 + bob, c[1]))
        }
        body.instanceMatrix.needsUpdate = true; head.instanceMatrix.needsUpdate = true; legs.instanceMatrix.needsUpdate = true
      }
      for (const fr of Object.values(fires) as any[]) {
        if (!fr.group.visible) continue
        const tt = now / 1000
        fr.rings.forEach((r: any) => { const k = (tt * 0.45 + r.userData.o) % 1; const sc = 0.6 + k * 2.6; r.scale.set(sc, sc, sc); r.material.opacity = 0.65 * (1 - k) })
        fr.flames.forEach((m: any) => { const k = (tt * 1.4 + m.userData.p) % 1; m.position.set(Math.cos(m.userData.a) * 0.9, 0.3 + k * 1.2, Math.sin(m.userData.a) * 0.9); m.scale.setScalar(1 - k * 0.7); m.material.opacity = 0.9 * (1 - k) })
        fr.glow.intensity = 40 + Math.sin(tt * 11) * 12
      }
      if (marker.visible) { const k = 1 + 0.12 * Math.sin(now / 250); ring.scale.set(k, k, k) }
      const film = api.current.film
      if (film) { camera.position.lerp(film.pos, 0.12); filmTarget.lerp(film.look, 0.12); camera.lookAt(filmTarget) } else controls.update()
      renderer.render(scene, camera); raf = requestAnimationFrame(loop)
    }
    loop()
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth; renderer.setSize(w, H); camera.aspect = w / H; camera.updateProjectionMatrix()
    })
    ro.observe(el)

    api.current = { ...api.current, scene, body, head, exitMeshes, routeGroup, byId, Y, slope, N, strips, marker, tagCanvas, tagTex, fires, rise, camera, controls, cx, cz, span, cur: [], target: undefined }
    return () => {
      cancelAnimationFrame(raf); ro.disconnect()
      disposeTree(scene)
      renderer.dispose(); renderer.forceContextLoss() // free the WebGL context now: browsers keep only ~16 alive
      el.removeChild(renderer.domElement)
    }
  }, [building, height, showcase])

  useEffect(() => { api.current.onExit = onExit }, [onExit])

  // blocked exits turn red
  useEffect(() => {
    for (const m of api.current.exitMeshes ?? []) {
      const off = blocked.includes(m.userData.exit)
      m.material.color.set(off ? '#c81e1e' : '#16a34a')
      if (m.material.emissive) m.material.emissive.set(off ? '#c81e1e' : '#16a34a')
    }
    for (const [id, fr] of Object.entries(api.current.fires ?? {}) as [string, any][]) fr.group.visible = blocked.includes(id)
  }, [blocked, building])

  // escape routes: green ribbons from each door to its exit
  useEffect(() => {
    const { routeGroup, byId, Y, slope } = api.current
    if (!routeGroup) return
    disposeTree(routeGroup) // the old ribbons' geometry stays on the GPU until disposed
    routeGroup.clear()
    const m = new THREE.MeshBasicMaterial({ color: '#22c55e', transparent: true, opacity: 0.7, depthWrite: false })
    for (const paths of Object.values(routes ?? {})) for (const path of paths) {
      for (let k = 1; k < path.length; k++) {
        const a = byId[path[k - 1]], b = byId[path[k]]
        if (!a || !b) continue // run from another building: skip
        if (Y(a) !== Y(b)) { routeGroup.add(slope(a, b, 0.35, m, 0.05)); continue }
        const len = Math.hypot(b.x - a.x, b.z - a.z)
        if (len < 0.01) continue
        const r = new THREE.Mesh(new THREE.PlaneGeometry(len, 0.35), m)
        r.rotation.x = -Math.PI / 2; r.rotation.z = -Math.atan2(b.z - a.z, b.x - a.x)
        r.position.set((a.x + b.x) / 2, Y(a) + 0.05, (a.z + b.z) / 2); routeGroup.add(r)
      }
    }
  }, [routes, building])

  // jammed walkways glow red by their peak queue (same rule as the 2D view)
  useEffect(() => {
    const strips = api.current.strips as Record<string, any> | undefined
    if (!strips) return
    const peak = Math.max(1, ...Object.values(edgeLoad ?? {}))
    const base = new THREE.Color('#4a4f56'), red = new THREE.Color('#c81e1e')
    for (const [key, m] of Object.entries(strips)) {
      const jam = Math.min(1, (edgeLoad?.[key] ?? 0) / peak)
      m.material.color.copy(base).lerp(red, jam > 0.15 ? 0.3 + 0.7 * jam : 0)
    }
  }, [edgeLoad, building])

  useEffect(() => {
    const { marker, tagCanvas, tagTex, byId } = api.current
    if (!marker) return
    const [a, b] = (bottleneck ?? '').split('-').length === 2 ? (bottleneck as string).split('-') : [undefined, undefined]
    const na = a && byId[a], nb = b && byId[b]
    // node ids can contain '-' (e.g. m-34); fall back to matching edge keys
    let A = na, B = nb
    if (!(A && B) && bottleneck) for (const id of Object.keys(byId)) if (bottleneck.startsWith(id + '-') && byId[bottleneck.slice(id.length + 1)]) { A = byId[id]; B = byId[bottleneck.slice(id.length + 1)] }
    if (!A || !B) { marker.visible = false; return }
    marker.position.set((A.x + B.x) / 2, (api.current.Y(A) + api.current.Y(B)) / 2, (A.z + B.z) / 2); marker.visible = true
    const g = tagCanvas.getContext('2d')!
    g.clearRect(0, 0, 512, 128); g.fillStyle = 'rgba(200,30,30,0.92)'; g.fillRect(0, 16, 512, 96)
    g.fillStyle = '#fff'; g.font = '600 46px Segoe UI'; g.textAlign = 'center'; g.fillText(`Bottleneck · queue ${peakQueue ?? ''}`, 256, 80)
    tagTex.needsUpdate = true
  }, [bottleneck, peakQueue, building])

  useEffect(() => {
    const r = api.current.rise
    if (!r) return
    const k = Math.max(0.001, Math.min(1, wallRise))
    r.scale.y = k
  }, [wallRise, building])

  // scripted camera for the scroll film: keyframes over t in [0, 1]
  useEffect(() => {
    const a = api.current
    if (!a.camera) return
    if (cameraT === undefined) { a.film = undefined; a.controls.enabled = true; return }
    a.controls.enabled = false
    const { cx, cz, span } = a
    const bn = a.marker?.visible ? a.marker.position : new THREE.Vector3(cx, 0, cz)
    const keys: [number, any, any][] = [
      [0.00, new THREE.Vector3(cx, span * 1.05, cz + 0.01), new THREE.Vector3(cx, 0, cz)],                       // plan view, like the map
      [0.30, new THREE.Vector3(cx - span * 0.35, span * 0.55, cz + span * 0.6), new THREE.Vector3(cx, 0, cz)],    // tilt into 3D as walls rise
      [0.55, new THREE.Vector3(bn.x - 9, 11, bn.z + 16), new THREE.Vector3(bn.x, 0, bn.z)],                       // dive to the jam
      [0.75, new THREE.Vector3(cx + span * 0.3, span * 0.45, cz + span * 0.55), new THREE.Vector3(cx, 0, cz)],    // Nikaas re-plans
      [1.00, new THREE.Vector3(cx, span * 0.7, cz + span * 0.75), new THREE.Vector3(cx, 0, cz)],                  // pull back
    ]
    const t = Math.max(0, Math.min(1, cameraT))
    let i = 0
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++
    const [t0, p0, l0] = keys[i], [t1, p1, l1] = keys[i + 1]
    const u = (t - t0) / Math.max(1e-6, t1 - t0), e = u * u * (3 - 2 * u) // smoothstep
    a.film = { pos: p0.clone().lerp(p1, e), look: l0.clone().lerp(l1, e) }
  }, [cameraT, building, bottleneck])

  // latest simulated positions and colours; the render loop glides people toward them
  useEffect(() => {
    const { body, N } = api.current
    if (!body) return
    const C = new THREE.Color(), ppl = frame?.people ?? [], p3 = frame?.people_3d
    const target: ([number, number, string, number?] | undefined)[] = new Array(N)
    for (let k = 0; k < N; k++) {
      const q = p3?.[k], p: [number, number, string, number?] | undefined = q ? [q[0], q[2], q[3], q[1] * EXPLODE] : ppl[k]
      if (!p || p[2] === 'out') { api.current.cur[k] = undefined; continue }
      target[k] = p
      body.setColorAt(k, C.set(STATE_COLOR[p[2]] ?? '#8a939b'))
    }
    api.current.target = target
    if (body.instanceColor) body.instanceColor.needsUpdate = true
  }, [frame])

  return <div ref={host} style={{ width: '100%', height, background: '#e8ecef', border: '1px solid var(--line)', cursor: 'grab' }} />
}
