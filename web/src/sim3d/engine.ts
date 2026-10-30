/* eslint-disable @typescript-eslint/no-explicit-any */
// The drill: scene, camera, timeline (calm -> incident -> alarm -> exit scan -> evacuation -> all clear),
// incident tools, labels and the minimap. Everything about the building comes from a Plan (plan.ts), so the
// same engine runs the demo block and any building graph. React only draws the HUD around it.
import * as THREE from 'three'
import { OrbitControls } from '../vendor/three/OrbitControls.js'
import { EffectComposer } from '../vendor/three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from '../vendor/three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from '../vendor/three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from '../vendor/three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js'
import { inRect } from './layout.ts'
import type { Plan, V3 } from './plan.ts'
import { makeMats, mulberry32, type Mats } from './materials.ts'
import { buildWorld, type World } from './build.ts'
import { buildGraphWorld } from './build-graph.ts'
import { CrowdView } from './people.ts'
import { Sim, type SimEvent, type Hazard } from './sim.ts'
import { Fire, Collapse, Beacon, Ribbon, assemblyMark, stairBarrier, marker, pointScale } from './effects.ts'
import { Sound } from './audio.ts'

export type Phase = 'briefing' | 'calm' | 'alarm' | 'assess' | 'evacuate' | 'clear'
export type Scenario = 'fire' | 'quake' | 'collapse' | 'drill'
export type Tool = 'fire' | 'collapse' | null
export type ExitStatus = 'safe' | 'smoke' | 'blocked' | 'cut' | 'unknown'
export type LogItem = { id: number; t: string; kind: SimEvent['kind']; text: string }
export type Summary = { time: number; out: number; total: number; trapped: number; perExit: { label: string; n: number }[]; incidents: number; reroutes: number; groups: number }
export type HudState = {
  phase: Phase; clock: string; elapsed: number | null; alarm: boolean; quake: boolean; paused: boolean; speed: number
  counts: { total: number; out: number; inside: number; stairs: number; trapped: number; moving: number }
  groups: { letter: string; css: string; exitLabel: string; total: number; out: number; fromStart: number }[]
  exits: { id: string; n: number; label: string; status: ExitStatus; out: number; assigned: number; closed: boolean }[]
  stairs: { id: string; label: string; blocked: boolean }[]
  log: LogItem[]; tool: Tool; focus: number; explode: boolean; cinematic: boolean; roof: boolean; muted: boolean; flash: boolean
  startRoom: string; startLabel: string; startLevel: number; startCount: number; scenario: Scenario
  summary: Summary | null; mapLevel: number; hint: string; ready: boolean
  /** plan picture on the floor: null when the building has none (or it could not be loaded) */
  overlay: boolean | null
}

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
/** Building and room names can come from any uploaded file: never trust them as HTML. */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const STATUS_WORD: Record<ExitStatus, string> = { safe: 'Safe', smoke: 'Smoke', blocked: 'Blocked', cut: 'Cut off', unknown: '' }
type Label = { el: HTMLDivElement; at: () => [number, number, number] | null }

export class DrillEngine {
  sim!: Sim
  readonly plan: Plan
  private host: HTMLElement; private labelLayer: HTMLElement; private onHud: (s: HudState) => void
  private minimap: HTMLCanvasElement | null = null
  private renderer: any; private scene: any; private camera: any; private controls: any; private composer: any; private bloom: any
  private M!: Mats; private world!: World; private crowd!: CrowdView
  private root = new THREE.Group()
  private sound = new Sound()
  private raf = 0; private last = 0; private realT = 0
  private phase: Phase = 'briefing'; private phaseAt = 0
  private scenario: Scenario; private startRoom: string
  private speed = 1; private paused = false
  private explode = 0; private explodeTarget = 0; private focus: number
  private cinematic = true; private roofOn = false; private flash = true
  private tween: { p0: any; p1: any; t0: any; t1: any; k: number; dur: number } | null = null
  private shake = 0; private quakeUntil = -1
  private fires: { h: Hazard; fx: Fire; level: number }[] = []
  private collapses: Collapse[] = []
  private barriers: Record<string, any[]> = {}
  private beacons: Record<string, Beacon> = {}
  private ribbons: { r: Ribbon; pts: [number, number, number][]; css: string }[] = []
  private revealed = new Set<string>()
  private split = false
  private log: LogItem[] = []; private logId = 0
  private queue: { at: number; fn: () => void }[] = []
  private tool: Tool = null; private marker: any; private hover: { level: number; x: number; z: number; ok: boolean } | null = null
  private labels: Label[] = []; private groupLabels: Label[] = []
  private step: { value: number }; private maxLevel: { value: number }
  private incidents = 0; private reroutes = 0; private reason = ''
  private hudAt = 0; private mapAt = 0
  private summary: Summary | null = null
  private mapLevel: number
  private disposed = false; private ready = false; private failed = false
  private keys = new Set<string>()
  private lights: { hemi: any; sun: any } | null = null
  private lastReplan = -10; private replanPending = false
  private incidentStarted = false
  private rx = new Float32Array(0); private ry = new Float32Array(0); private rz = new Float32Array(0); private placed = new Uint8Array(0)
  private down = { x: 0, y: 0, t: 0 }
  private ray = new THREE.Raycaster(); private ndc = new THREE.Vector2(); private v3 = new THREE.Vector3()
  private ro: ResizeObserver
  private shakeOff = new THREE.Vector3()
  private overlayOn = true; private overlayReady = false
  private wallMaps = new Map<number, HTMLCanvasElement | null>()
  private warm = new THREE.Color('#ffdcb4'); private red = new THREE.Color('#ff3a2a')
  private pose = { x: 0, y: 0, z: 0, yaw: 0, scale: 1, sit: 0, crouch: 0, phase: 0, move: 0, wave: 0, alarm: 0, lean: 0, t: 0 }

  constructor(host: HTMLElement, labelLayer: HTMLElement, onHud: (s: HudState) => void, opts: { plan: Plan; scenario: Scenario; startRoom: string; muted: boolean; flash: boolean }) {
    this.host = host; this.labelLayer = labelLayer; this.onHud = onHud
    this.plan = opts.plan
    this.scenario = opts.scenario; this.startRoom = opts.startRoom; this.flash = opts.flash
    this.step = { value: this.plan.fh }; this.maxLevel = { value: this.plan.levels - 1 }
    this.focus = this.plan.levels - 1; this.mapLevel = this.plan.levels - 1
    this.sound.muted = opts.muted
    const w = host.clientWidth || 800, h = host.clientHeight || 600
    const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    const pr = Math.min(window.devicePixelRatio || 1, 1.75)
    r.setPixelRatio(pr); r.setSize(w, h)
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05
    r.outputColorSpace = THREE.SRGBColorSpace
    r.domElement.style.display = 'block'; r.domElement.style.width = '100%'; r.domElement.style.height = '100%'
    host.appendChild(r.domElement)
    this.renderer = r
    const scene = new THREE.Scene(); this.scene = scene
    const S = Math.max(this.plan.site.x1 - this.plan.site.x0, this.plan.site.z1 - this.plan.site.z0, 60)
    scene.fog = new THREE.FogExp2('#161c25', 0.0058 * Math.min(1, 96 / S))
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.3, 1600)
    this.camera.position.set(40, 40, 60)
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(r, rt)
    this.composer.addPass(new RenderPass(scene, this.camera))
    // a light touch of bloom for lamps and signs only: this is a technical view, not a light show
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.26, 0.32, 0.96)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    const c = new OrbitControls(this.camera, r.domElement)
    c.enableDamping = true; c.dampingFactor = 0.08; c.maxPolarAngle = 1.47; c.minDistance = 3; c.maxDistance = Math.max(240, S * 2.4)
    c.screenSpacePanning = false; c.autoRotateSpeed = 0.35
    c.addEventListener('start', () => { this.tween = null; if (this.phase === 'briefing' || this.phase === 'calm') c.autoRotate = false })
    this.controls = c
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host)
    r.domElement.addEventListener('pointerdown', this.onDown); r.domElement.addEventListener('pointerup', this.onUp); r.domElement.addEventListener('pointermove', this.onMove)
    r.domElement.addEventListener('contextmenu', this.noMenu)
    window.addEventListener('keydown', this.onKey); window.addEventListener('keyup', this.onKeyUp); window.addEventListener('blur', this.onBlur)
    this.resize()
  }

  async init() {
    try { await Promise.race([Promise.all([document.fonts.load('700 40px "Atkinson Hyperlegible"'), document.fonts.load('400 20px "Atkinson Hyperlegible"')]), new Promise(r => setTimeout(r, 1500))]) } catch { /* fonts are optional */ }
    if (this.disposed) return
    const scene = this.scene, plan = this.plan
    // overcast sky dome: neutral slate, a faint warm horizon
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; void main(){ float h = clamp(vP.y, -1.0, 1.0);
        vec3 top = vec3(0.05,0.065,0.09), mid = vec3(0.16,0.185,0.225), glow = vec3(0.25,0.24,0.24), low = vec3(0.05,0.055,0.065);
        vec3 c = mix(mid, top, smoothstep(0.05, 0.6, h)); c = mix(c, glow, smoothstep(0.18, 0.0, abs(h - 0.02)) * 0.4); c = mix(c, low, smoothstep(0.0, -0.2, h));
        gl_FragColor = vec4(c, 1.0); }`,
    }))
    scene.add(sky)
    const pm = new THREE.PMREMGenerator(this.renderer)
    scene.environment = pm.fromScene(new RoomEnvironment(this.renderer), 0.04).texture
    // the sun's shadow covers the building (not the whole site) with a map sized to it: crisp and cheap
    const st = plan.kind === 'demo' ? plan.site : { x0: plan.bounds.x0 - 10, z0: plan.bounds.z0 - 10, x1: plan.bounds.x1 + 10, z1: plan.bounds.z1 + 10 }
    const scx = (st.x0 + st.x1) / 2, scz = (st.z0 + st.z1) / 2, half = Math.max(plan.kind === 'demo' ? 52 : 24, (st.x1 - st.x0) / 2 + 6, (st.z1 - st.z0) / 2 + 6)
    const hemi = new THREE.HemisphereLight('#a9b8d2', '#2a2724', 0.8)
    const sun = new THREE.DirectionalLight('#e2e8f5', 1.5)
    sun.position.set(scx - 38, 70 + plan.levels * plan.fh, scz + 46); sun.target.position.set(scx, 0, scz)
    const size = Math.min(this.renderer.capabilities.maxTextureSize || 4096, plan.kind === 'demo' || half > 70 ? 4096 : half > 22 ? 2048 : 1024)
    sun.castShadow = true; sun.shadow.mapSize.set(size, size)
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 10, far: 260 + half })
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025
    scene.add(hemi, sun, sun.target)
    this.lights = { hemi, sun }

    this.M = makeMats()
    const all: any[] = []
    for (const v of Object.values(this.M)) { if (Array.isArray(v)) all.push(...v); else all.push(v) }
    for (const m of all) if (m.isMeshStandardMaterial) m.envMapIntensity = 0.42
    this.world = plan.geo ? buildGraphWorld(this.M, plan.geo) : buildWorld(this.M)
    scene.add(this.root, this.world.site)
    for (const g of this.world.levels) this.root.add(g)
    for (const g of this.world.flights) this.root.add(g)
    this.world.roof.visible = false; this.root.add(this.world.roof)
    this.loadOverlays()
    const bc: [number, number] = [(plan.bounds.x0 + plan.bounds.x1) / 2, (plan.bounds.z0 + plan.bounds.z1) / 2]
    const asmDone = new Set<string>()
    for (const e of plan.exits) {
      if (!asmDone.has(e.asm)) { asmDone.add(e.asm); scene.add(assemblyMark(this.M, e.assembly[0], e.assembly[1], bc[0], bc[1])) }
      const b = new Beacon(e.out[0], e.out[1], e.id); b.group.position.y = e.level * plan.fh; this.beacons[e.id] = b; scene.add(b.group)
    }
    this.sim = new Sim(plan, this.world.seats, this.startRoom, mulberry32(42), ev => this.addLog(ev.kind, ev.text))
    const n = this.sim.agents.length
    this.crowd = new CrowdView(n, scene, mulberry32(7))
    for (const m of [this.crowd.torso.material, this.crowd.head.material]) m.envMapIntensity = 0.3
    this.rx = new Float32Array(n); this.ry = new Float32Array(n); this.rz = new Float32Array(n); this.placed = new Uint8Array(n)
    this.marker = marker(); scene.add(this.marker)
    this.makeLabels()
    this.mapLevel = this.startLevel()
    this.focus = this.startLevel()
    this.startView(true)
    this.addLog('info', `Normal operation: ${n} people in ${plan.name}.`)
    this.ready = true
    this.last = performance.now()
    this.emitHud()
    this.loop()
  }

  // ---------- public controls (from the HUD) ----------
  setMinimap(c: HTMLCanvasElement | null) { this.minimap = c }
  setScenario(s: Scenario) { this.scenario = s }
  setStartRoom(id: string) {
    if (this.phase !== 'briefing' || !this.ready) { this.startRoom = id; return }
    this.startRoom = id; this.sim.startRoom = id
    for (const a of this.sim.agents) a.start = a.room === id
    this.mapLevel = this.startLevel(); this.focus = this.startLevel()
    this.startView(false)
  }
  begin() {
    if (!this.ready || this.phase !== 'briefing') return
    this.sound.init(); this.sound.blip(660)
    this.setPhase('calm')
    this.addLog('info', 'Simulation started. Add incidents from the Incidents toolbar.')
  }
  setSpeed(s: number) { this.speed = s }
  setPaused(p: boolean) { this.paused = p }
  setFocus(L: number) { this.focus = L; this.mapLevel = Math.min(L, this.plan.levels - 1) }
  setMapLevel(L: number) { this.mapLevel = L }
  setExplode(on: boolean) { this.explodeTarget = on ? 1 : 0 }
  setCinematic(on: boolean) { this.cinematic = on; if (!on) { this.tween = null; this.controls.autoRotate = false } }
  setRoof(on: boolean) { this.roofOn = on }
  setMuted(m: boolean) { this.sound.setMuted(m) }
  setFlash(f: boolean) { this.flash = f }
  setOverlay(on: boolean) { this.overlayOn = on; for (const m of this.world?.overlays ?? []) m.visible = on && !!m.material.map; this.emitHud() }
  setTool(t: Tool) { this.tool = t; this.marker.visible = false; this.hover = null; this.renderer.domElement.style.cursor = t ? 'crosshair' : '' }
  view(which: 'room' | 'overview' | 'top') {
    if (which === 'room') { this.startView(false); return }
    const v = this.plan.views(this.step.value)
    const [p, t] = which === 'overview' ? v.overview : v.top
    this.flyTo(p, t, 2.2)
  }

  /** Plan pictures on the floors: loaded with CORS (presigned bucket links), shown once ready, skipped on error. */
  private loadOverlays() {
    const list = this.world.overlays ?? []
    if (!list.length) return
    const loader = new THREE.TextureLoader(); loader.setCrossOrigin('anonymous')
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() ?? 1)
    for (const m of list) loader.load(m.userData.url, (tex: any) => {
      if (this.disposed) { tex.dispose(); return }
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = aniso
      m.material.map = tex; m.material.needsUpdate = true; m.visible = this.overlayOn
      this.overlayReady = true; this.emitHud()
    }, undefined, () => { if (!this.disposed) console.warn('The plan picture could not be loaded; showing the building without it.') })
  }

  // ---------- incidents ----------
  placeFire(level: number, x: number, z: number) {
    if (!this.canAct()) return
    this.incidentStarted = true
    const label = this.placeName(level, x, z)
    const h = this.sim.addHazard({ kind: 'fire', level, x, z, r: 1.0, rMax: 4.2, grow: 0.07, label })
    const fx = new Fire(x, z, this.plan.fh - 0.3); this.world.levels[level].add(fx.group)
    this.fires.push({ h, fx, level })
    this.labels.push({ el: this.tag('fire', `<b>Fire</b><span>${esc(label)}</span>`), at: () => [x, this.floorY(level) + 3.2, z] })
    this.addLog('danger', `Fire reported: ${label}, ${this.levelName(level)}`)
    this.incidents++; this.reason = `fire in ${label}`; this.replanPending = true
    this.sound.init(); this.sound.blip(240, 0.12)
    if (!this.sim.alarm) this.after(2.4, () => { this.addLog('warn', `Smoke detector activated on ${this.levelName(level)}`); this.raiseAlarm() })
  }
  placeCollapse(level: number, x: number, z: number, r = 2.8) {
    if (!this.canAct()) return
    this.incidentStarted = true
    const top = level === this.plan.levels - 1, label = this.placeName(level, x, z)
    this.sound.init(); this.sound.rumble(1.8, 0.8); this.shake = Math.max(this.shake, 0.3)
    this.addLog('warn', `Structural noise reported above ${label}`)
    this.incidents++
    this.after(1.0, () => {
      const c = new Collapse(this.M, x, z, r, 28, 0, this.plan.fh)
      c.onLand = () => {
        this.sound.crash(1); this.shake = Math.max(this.shake, 0.9)
        const n = this.sim.crush(level, x, z, r)
        this.addLog('danger', `${top ? 'Roof' : 'Ceiling'} collapse: ${label}, ${this.levelName(level)}${n ? `. ${n} people need rescue` : ''}`)
        this.sim.addHazard({ kind: 'collapse', level, x, z, r, rMax: r, grow: 0, label })
        this.reason = `collapse in ${label}`; this.replanPending = true
        if (!this.sim.alarm) this.raiseAlarm()
      }
      this.world.levels[level].add(c.group); this.collapses.push(c)
      this.labels.push({ el: this.tag('collapse', `<b>Collapse</b><span>${esc(label)}</span>`), at: () => [x, this.floorY(level) + 2.6, z] })
    })
  }
  toggleStair(id: string, why = '') {
    if (!this.canAct()) return
    this.incidentStarted = true
    const s = this.plan.stairs.find(x => x.id === id)
    if (!s) return
    const on = !this.sim.stairBlocked[id]
    this.sim.stairBlocked[id] = on
    if (on) {
      this.barriers[id] = s.barriers.map(b => { const m = stairBarrier(this.M, b.at, b.axis, b.width, b.side); this.world.levels[b.level]?.add(m); return m })
      this.addLog('danger', `${s.label} closed${why ? ` (${why})` : ''}`); this.incidents++
    } else {
      for (const b of this.barriers[id] ?? []) b.removeFromParent()
      delete this.barriers[id]
      this.addLog('good', `${s.label} reopened`)
    }
    this.sound.init(); this.sound.blip(on ? 300 : 900)
    this.reason = `${s.label} ${on ? 'closed' : 'reopened'}`; this.replanPending = true
    if (on && !this.sim.alarm && this.phase !== 'briefing') this.raiseAlarm()
  }
  toggleExit(id: string) {
    if (!this.canAct()) return
    const e = this.plan.exits.find(x => x.id === id)
    if (!e) return
    const open = this.plan.exits.filter(x => !this.sim.exitClosed[x.id]).length
    if (!this.sim.exitClosed[id] && open <= 1) { this.addLog('warn', 'At least one exit has to stay open'); return }
    this.sim.exitClosed[id] = !this.sim.exitClosed[id]
    this.addLog(this.sim.exitClosed[id] ? 'danger' : 'good', `${e.label} ${this.sim.exitClosed[id] ? 'blocked' : 'reopened'}`)
    this.sound.init(); this.sound.blip(this.sim.exitClosed[id] ? 300 : 900)
    this.reason = `${e.label} ${this.sim.exitClosed[id] ? 'blocked' : 'reopened'}`; this.replanPending = true
  }
  earthquake() {
    if (!this.canAct() || this.sim.t < this.quakeUntil) return
    this.incidentStarted = true
    const T = this.sim.t, plan = this.plan
    this.quakeUntil = T + 7; this.sim.quake = true
    this.sound.init(); this.sound.rumble(7.6, 1); this.shake = 1.1
    this.addLog('danger', 'Earthquake: occupants drop, cover and hold on')
    this.incidents++
    this.after(0.8, () => { if (!this.sim.alarm) { this.addLog('warn', 'Seismic sensor activated the building alarm'); this.raiseAlarm() } })
    const rnd = mulberry32(Math.floor(T * 1000) + 5)
    const floors = [...new Set(plan.rooms.map(r => r.level))]
    for (const d of [1.4, 2.9, 4.3, 5.6]) this.after(d, () => {
      const L = floors[Math.floor(rnd() * floors.length)]
      const rooms = plan.rooms.filter(r => r.level === L)
      const r = rooms[Math.floor(rnd() * rooms.length)]
      const w = r.r.x1 - r.r.x0, dd = r.r.z1 - r.r.z0, mx = Math.min(1.5, w * 0.3), mz = Math.min(1.5, dd * 0.3)
      const x = r.r.x0 + mx + rnd() * (w - 2 * mx), z = r.r.z0 + mz + rnd() * (dd - 2 * mz)
      const c = new Collapse(this.M, x, z, 1.1, 9, 0, plan.fh)
      c.onLand = () => { this.sound.crash(0.45); const n = this.sim.crush(L, x, z, 0.9); if (n) this.addLog('danger', `Falling debris in ${r.label}: ${n} injured`) }
      this.world.levels[L].add(c.group); this.collapses.push(c)
    })
    this.after(2.6, () => {
      const open = plan.stairs.filter(s => !this.sim.stairBlocked[s.id])
      if (open.length > 1) this.toggleStair(open[Math.floor(rnd() * open.length)].id, 'damaged by the earthquake')
    })
  }
  falseAlarm() {
    if (!this.canAct()) return
    this.incidentStarted = true
    if (this.sim.alarm) { this.addLog('info', 'The alarm is already sounding'); return }
    this.addLog('warn', `Manual call point activated on ${this.levelName(this.startLevel())}. No fire confirmed; evacuating as normal.`)
    this.raiseAlarm()
  }

  // ---------- timeline ----------
  private canAct() { return this.ready && this.phase !== 'briefing' }
  private after(sec: number, fn: () => void) { this.queue.push({ at: this.sim.t + sec, fn }) }
  private setPhase(p: Phase) { this.phase = p; this.phaseAt = this.sim.t }
  private raiseAlarm() {
    if (this.sim.alarm) return
    this.sim.raiseAlarm()
    this.alarmT = this.sim.t
    this.sound.sirenOn()
    this.addLog('danger', 'Alarm activated. Evacuate the building.')
    this.shake = Math.max(this.shake, 0.2)
    if (this.phase === 'calm') this.setPhase('alarm')
  }
  /** Where the scripted incident happens on a generic building: on the start room's way out (so the crowd has to
   * re-route), but never somewhere that would leave anyone without a way out. */
  private incidentSpot(level: number, r: number, avoidStart: boolean): { level: number; x: number; z: number } | null {
    const sim = this.sim, plan = this.plan, start = plan.rooms.find(x => x.id === this.startRoom)
    const nearStart = (x: number, z: number) => !!start && start.level === level && inRect({ x0: start.r.x0 - 3, z0: start.r.z0 - 3, x1: start.r.x1 + 3, z1: start.r.z1 + 3 }, x, z)
    const routes = plan.exits.map(e => sim.routeFor(e.id, this.startRoom)).filter(p => p.length > 1)
    routes.sort((p, q) => p.length - q.length)
    const cache = new Map<number, { trapped: number; exitsLost: number }>()
    const ok = (i: number, keepExits: boolean) => {
      const n = sim.nav.nodes[i]
      if (n.rail || n.kind === 'exit' || n.kind === 'stair' || Math.abs(n.level - level) > 0.01) return false
      if (avoidStart && nearStart(n.x, n.z)) return false
      let m = cache.get(i)
      if (!m) { m = sim.impact(level, n.x, n.z, r); cache.set(i, m) }
      return m.trapped === 0 && (!keepExits || m.exitsLost === 0)
    }
    // best: a corridor on the way out that forces a re-route but leaves every exit usable
    for (const keepExits of [true, false]) {
      for (const corrOnly of [true, false]) for (const p of routes) for (const i of p.slice(1)) {
        if ((!corrOnly || sim.nav.nodes[i].kind === 'corr') && ok(i, keepExits)) return { level, x: sim.nav.nodes[i].x, z: sim.nav.nodes[i].z }
      }
      const any = sim.nav.nodes.filter(n => (n.kind === 'corr' || n.kind === 'landing') && ok(n.i, keepExits))
      if (any.length) { const n = any[Math.floor(any.length / 2)]; return { level, x: n.x, z: n.z } }
    }
    return null
  }
  private scenarioStart() {
    this.incidentStarted = true
    const L = this.startLevel(), demo = this.plan.kind === 'demo'
    switch (this.scenario) {
      case 'fire': {
        if (demo) {
          const c1b = this.plan.rooms.find(r => r.id === 'c1b')!
          if (this.startRoom === 'c1b') this.placeFire(0, -14, -9)
          else this.placeFire(1, (c1b.r.x0 + c1b.r.x1) / 2 + 1.5, -7.5)
          break
        }
        const spot = this.incidentSpot(Math.max(0, L - 1), 5.2, L === 0) ?? this.incidentSpot(L, 5.2, true)
        if (spot) this.placeFire(spot.level, spot.x, spot.z)
        else this.falseAlarm()
        break
      }
      case 'quake': this.earthquake(); break
      case 'collapse': {
        if (demo) { this.placeCollapse(L, 12.5, 0, 2.8); break }
        const spot = this.incidentSpot(L, 3.4, true)
        if (spot) this.placeCollapse(spot.level, spot.x, spot.z, 2.8)
        else this.falseAlarm()
        break
      }
      case 'drill': this.falseAlarm(); break
    }
  }
  private enterAssess() {
    this.setPhase('assess')
    this.sim.recompute()
    this.focus = this.plan.levels - 1; this.explodeTarget = this.plan.levels > 1 ? 1 : 0
    this.revealed.clear()
    if (this.cinematic) { const [p, t] = this.plan.views(this.step.value).assess; this.flyTo(p, t, 3.2) }
    this.addLog('info', 'Checking exits and routes')
  }
  private assessTick() {
    const k = this.sim.t - this.phaseAt, exits = this.plan.exits, gap = Math.min(0.5, 2.2 / Math.max(1, exits.length))
    exits.forEach((e, i) => {
      if (k > 0.7 + i * gap && !this.revealed.has(e.id)) {
        this.revealed.add(e.id)
        const st = this.exitStatus(e.id)
        this.beacons[e.id].target = 1
        const word = { safe: 'clear', smoke: 'smoke on approach', blocked: 'blocked', cut: 'cut off', unknown: '' }[st]
        this.addLog(st === 'safe' ? 'good' : st === 'smoke' ? 'warn' : 'danger', `Exit ${i + 1}, ${e.label}: ${word}`)
        this.sound.blip(st === 'safe' ? 990 : 330, 0.09)
      }
    })
    if (k > 3.0 && !this.split) {
      this.split = true
      this.sim.assign(true)
      const parts = this.sim.groups.map((g, gi) => `${g.letter} ${this.sim.agents.filter(a => a.start && a.group === gi).length}`).filter(s => !s.endsWith(' 0'))
      this.addLog('good', `${this.startLabel()}: occupants assigned to ${parts.length} ${parts.length === 1 ? 'group' : 'groups'} (${parts.join(' · ')})`)
      this.buildRibbons()
      this.sound.blip(1320, 0.12)
    }
    if (k > 4.4) {
      this.setPhase('evacuate'); this.sim.go()
      this.addLog('info', 'Evacuation in progress')
    }
  }
  private tick(h: number) {
    const sim = this.sim, T = sim.t
    if (this.queue.length) {
      const due = this.queue.filter(q => q.at <= T)
      if (due.length) { this.queue = this.queue.filter(q => q.at > T); for (const q of due) q.fn() }
    }
    const quaking = T < this.quakeUntil
    if (sim.quake && !quaking) this.addLog('warn', 'Shaking stopped. Evacuation resumes.')
    sim.quake = quaking
    switch (this.phase) {
      case 'calm': if (T - this.phaseAt > 4 && !this.incidentStarted) this.scenarioStart(); break
      case 'alarm': if (T - this.phaseAt > 3.8 && !quaking) this.enterAssess(); break
      case 'assess': this.assessTick(); break
      case 'evacuate': {
        const c = sim.counts()
        if (c.inside - c.trapped === 0) this.finish()
        break
      }
    }
    if (sim.hazardsUpdate(h)) this.replanPending = true
    if (this.replanPending && T - this.lastReplan > 0.7) this.replan()
    sim.step(h)
  }
  private replan() {
    this.lastReplan = this.sim.t; this.replanPending = false
    const res = this.sim.replan()
    if (res.changed > 0) { this.reroutes += res.changed; this.addLog('warn', `Routes updated after ${this.reason}: ${res.changed} people re-routed`) }
    if (res.trapped > 0) this.addLog('danger', `${res.trapped} people have no safe route and need rescue`)
    if (this.split) this.buildRibbons()
  }
  private finish() {
    this.setPhase('clear')
    const c = this.sim.counts(), time = this.sim.t - (this.alarmTime() ?? this.sim.t)
    this.summary = {
      time, out: c.out, total: c.total, trapped: c.trapped,
      perExit: this.plan.exits.map(e => ({ label: e.label, n: this.sim.outBy[e.id] })), incidents: this.incidents, reroutes: this.reroutes, groups: this.sim.groups.length,
    }
    this.addLog(c.trapped ? 'warn' : 'good', c.trapped ? `Evacuation ended: ${c.out} evacuated, ${c.trapped} need rescue` : `Evacuation complete: ${c.out} people evacuated in ${fmt(time)}`)
    this.after(2.5, () => this.sound.sirenOff())
  }
  private alarmT = -1
  private alarmTime() { return this.alarmT < 0 ? null : this.alarmT }

  // ---------- helpers ----------
  private levelName(L: number) { return this.plan.levelNames[L] ?? `Level ${L}` }
  private startLevel() { return this.plan.rooms.find(r => r.id === this.startRoom)?.level ?? 0 }
  private startLabel() { return this.plan.rooms.find(r => r.id === this.startRoom)?.label ?? 'building' }
  private floorY(lf: number) { return lf * this.step.value }
  private placeName(level: number, x: number, z: number) { return this.plan.placeName(level, x, z) }
  private exitStatus(id: string): ExitStatus {
    const sim = this.sim, n = sim.exitNode[id]
    if (sim.exitClosed[id] || sim.blocked[n]) return 'blocked'
    if (!sim.exitReachable(id)) return 'cut'
    let smoke = sim.pen[n] > 0
    for (const e of sim.nav.adj[n]) if (sim.pen[e.to] > 0) smoke = true
    return smoke ? 'smoke' : 'safe'
  }
  private addLog(kind: SimEvent['kind'], text: string) {
    const T = this.alarmTime()
    const t = T === null ? this.clock() : `T+${fmt(this.sim.t - T)}`
    this.log.unshift({ id: this.logId++, t, kind, text })
    if (this.log.length > 40) this.log.length = 40
  }
  private clock() {
    const s = 9 * 3600 + 41 * 60 + 12 + Math.floor(this.sim?.t ?? 0)
    return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  private tag(cls: string, html: string) {
    const el = document.createElement('div'); el.className = `d-tag ${cls}`; el.innerHTML = html
    this.labelLayer.appendChild(el); return el
  }
  private makeLabels() {
    const plan = this.plan, asmDone = new Set<string>()
    plan.exits.forEach((e, i) => {
      const el = this.tag('exit', `<b>Exit ${i + 1}</b><span>${esc(e.label)}</span><i></i>`)
      el.dataset.exit = e.id
      this.labels.push({ el, at: () => this.revealed.has(e.id) ? [e.out[0], e.level * this.step.value + 5.2, e.out[1]] : null })
      if (asmDone.has(e.asm)) return
      asmDone.add(e.asm)
      const [head, tail] = e.assemblyLabel.includes(' · ') ? e.assemblyLabel.split(' · ') : [e.assemblyLabel, '']
      const a = this.tag('assembly', `<b>${esc(head)}</b>${tail ? `<span>${esc(tail)}</span>` : ''}<i>0 safe</i>`)
      a.dataset.assembly = e.asm
      this.labels.push({ el: a, at: () => this.phase === 'evacuate' || this.phase === 'clear' || this.phase === 'assess' ? [e.assembly[0], 3.4, e.assembly[1]] : null })
    })
    const room = this.tag('room', '')
    room.dataset.room = '1'
    this.labels.push({
      el: room,
      at: () => {
        const r = plan.rooms.find(x => x.id === this.startRoom)
        if (!r || this.phase === 'evacuate' || this.phase === 'clear' || this.phase === 'assess') return null
        return [(r.r.x0 + r.r.x1) / 2, this.floorY(r.level) + 4.0, (r.r.z0 + r.r.z1) / 2]
      },
    })
  }
  private buildRibbons() {
    for (const r of this.ribbons) r.r.dispose()
    this.ribbons = []
    for (const l of this.groupLabels) l.el.remove()
    this.groupLabels = []
    const sim = this.sim
    sim.groups.forEach((g, gi) => {
      if (!sim.agents.some(a => a.start && a.group === gi)) return
      const route = sim.routeFor(g.exit, this.startRoom)
      if (route.length < 2) return
      const e = this.plan.exits.find(x => x.id === g.exit)!
      const pts: [number, number, number][] = route.map(n => [sim.nav.nodes[n].x, sim.nav.nodes[n].level, sim.nav.nodes[n].z])
      pts.push([e.out[0], e.level, e.out[1]], [e.assembly[0], 0, e.assembly[1]])
      const r = new Ribbon(pts, new THREE.Color(...g.color), this.step, this.maxLevel)
      this.scene.add(r.mesh); this.ribbons.push({ r, pts, css: g.css })
      const p = pts[Math.min(3, pts.length - 1)]
      const el = this.tag('group', `<b style="color:${g.css}">Group ${g.letter}</b><span>to ${esc(e.label)}</span>`)
      this.groupLabels.push({ el, at: () => (this.phase === 'clear' || p[1] > this.focus + 0.5 ? null : [p[0], this.floorY(p[1]) + 2.2, p[2]]) })
    })
  }
  private startView(now: boolean) {
    const r = this.plan.rooms.find(x => x.id === this.startRoom) ?? this.plan.rooms[0]
    const y = this.floorY(r.level), v = this.plan.camFor(r.id)
    const pos: V3 = [v.pos[0], v.pos[1] + y, v.pos[2]], tgt: V3 = [v.tgt[0], v.tgt[1] + y, v.tgt[2]]
    if (now) { this.camera.position.set(...pos); this.controls.target.set(...tgt); this.controls.update() }
    else this.flyTo(pos, tgt, 2.0)
    this.controls.autoRotate = this.cinematic
  }
  private flyTo(p: V3, t: V3, dur: number) {
    this.controls.autoRotate = false
    this.tween = { p0: this.camera.position.clone(), p1: new THREE.Vector3(...p), t0: this.controls.target.clone(), t1: new THREE.Vector3(...t), k: 0, dur }
  }

  // ---------- input ----------
  private onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY, t: performance.now() } }
  private onUp = (e: PointerEvent) => {
    if (e.button !== 0 || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 6 || performance.now() - this.down.t > 450) return
    if (this.tool) {
      this.pickFloor(e)
      const h = this.hover
      if (!h || !h.ok) { this.addLog('info', 'Select a point inside the building'); return }
      if (this.tool === 'fire') this.placeFire(h.level, h.x, h.z)
      else this.placeCollapse(h.level, h.x, h.z)
      return
    }
    this.setNdc(e); this.ray.setFromCamera(this.ndc, this.camera)
    const hit = this.ray.intersectObjects(Object.values(this.beacons).filter(b => b.group.visible).map(b => b.pick))[0]
    if (hit) this.toggleExit(hit.object.userData.exit)
  }
  private onMove = (e: PointerEvent) => { if (this.tool) this.pickFloor(e) }
  private noMenu = (e: Event) => e.preventDefault()
  private setNdc(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
  }
  private pickFloor(e: PointerEvent) {
    if (!this.ready) return
    this.setNdc(e); this.ray.setFromCamera(this.ndc, this.camera)
    const picks = this.world.picks.filter((p: any) => p.userData.level <= this.focus)
    const hit = this.ray.intersectObjects(picks)[0]
    if (!hit) { this.hover = null; this.marker.visible = false; return }
    const L = hit.object.userData.level, x = hit.point.x - this.root.position.x, z = hit.point.z - this.root.position.z
    const fp = this.plan.footprint
    const ok = this.sim.insideBuilding(L, x, z) || (L === 0 && !!fp && inRect(fp, x, z))
    this.hover = { level: L, x, z, ok }
    this.marker.visible = true
    this.marker.position.set(x, this.floorY(L) + 0.06, z)
    this.marker.userData.mat.color.setRGB(...((ok ? (this.tool === 'fire' ? [1.6, 0.6, 0.2] : [1.3, 1.3, 1.4]) : [1.0, 0.12, 0.12]) as [number, number, number]))
  }
  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    const k = e.key.toLowerCase()
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'r', 'f'].includes(k)) { this.keys.add(k); if (k.startsWith('arrow')) e.preventDefault() }
  }
  private onKeyUp = (e: KeyboardEvent) => { this.keys.delete(e.key.toLowerCase()) }
  private onBlur = () => this.keys.clear()

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h); this.composer.setSize(w, h)
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix()
    pointScale.value = (h * this.renderer.getPixelRatio()) / (2 * Math.tan((this.camera.fov * Math.PI) / 360))
  }

  /** Keep the view smooth on laptop graphics: when frames stay under ~30 fps, step down once every few seconds:
   * bloom off, then a lower pixel ratio, then a smaller shadow map. Never steps back up (no flicker). */
  private quality = 3; private qSum = 0; private qN = 0; private qFrom = 0
  private adapt(ms: number) {
    if (!this.ready || this.quality <= 0) return
    if (ms > 250) { this.qSum = 0; this.qN = 0; return } // a hidden tab or a hitch, not a slow GPU
    if (this.realT < 3 || this.realT - this.qFrom < 2.5) { this.qSum = 0; this.qN = 0; return } // shaders warming up / just changed
    this.qSum += ms; this.qN++
    if (this.qSum < 2000) return
    const fps = (1000 * this.qN) / this.qSum
    this.qSum = 0; this.qN = 0
    if (fps >= 29) return
    this.quality--; this.qFrom = this.realT
    if (this.quality === 2) this.bloom.enabled = false
    else if (this.quality === 1) { const pr = Math.min(window.devicePixelRatio || 1, 1); this.renderer.setPixelRatio(pr); this.composer.setPixelRatio?.(pr); this.resize() }
    else if (this.lights) {
      const sh = this.lights.sun.shadow
      if (sh.mapSize.x > 1024) { sh.mapSize.set(sh.mapSize.x / 2, sh.mapSize.y / 2); sh.map?.dispose(); sh.map = null }
    }
  }

  // ---------- frame ----------
  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now(), rdt = Math.min(0.05, (now - this.last) / 1000)
    this.adapt(now - this.last)
    this.last = now; this.realT += rdt
    let simDt = 0
    if (!this.paused && this.phase !== 'briefing') {
      simDt = rdt * this.speed
      const n = Math.ceil(simDt / 0.034)
      try { for (let k = 0; k < n; k++) this.tick(simDt / n) } catch (err) { if (!this.failed) console.error('sim step failed', err); this.failed = true }
    }
    this.frame(rdt, simDt)
  }

  private frame(rdt: number, sdt: number) {
    const sim = this.sim, t = this.realT, cam = this.camera, ctl = this.controls, FH = this.plan.fh, LV = this.plan.levels
    // storeys: cutaway and pull-apart
    this.explode += (this.explodeTarget - this.explode) * Math.min(1, rdt * 2.5)
    this.step.value = FH * (1 + this.explode * 1.15)
    this.maxLevel.value = this.focus
    this.world.levels.forEach((g: any, L: number) => { g.position.y = this.floorY(L); g.visible = L <= this.focus })
    this.world.flights.forEach((g: any, L: number) => { g.position.y = this.floorY(L); g.scale.y = this.step.value / FH; g.visible = L + 1 <= this.focus })
    this.world.roof.position.y = this.floorY(LV); this.world.roof.visible = this.roofOn && this.focus === LV - 1
    for (const e of this.plan.exits) if (e.level) this.beacons[e.id].group.position.y = this.floorY(e.level)
    // shaking
    const quaking = sim.t < this.quakeUntil
    if (quaking) this.shake = Math.max(this.shake, 0.7)
    this.shake = Math.max(0, this.shake - rdt * (quaking ? 0.2 : 0.9))
    const qa = quaking ? 0.07 : 0
    this.root.position.set(Math.sin(t * 31) * qa + Math.sin(t * 17) * qa * 0.6, 0, Math.cos(t * 27) * qa * 0.8)
    // camera
    if (this.tween) {
      const tw = this.tween; tw.k = Math.min(1, tw.k + rdt / tw.dur); const k = ease(tw.k)
      cam.position.lerpVectors(tw.p0, tw.p1, k); ctl.target.lerpVectors(tw.t0, tw.t1, k)
      if (tw.k >= 1) this.tween = null
    }
    if (this.keys.size) {
      const d = cam.position.distanceTo(ctl.target), sp = rdt * Math.max(6, d * 0.9)
      const fwd = new THREE.Vector3().subVectors(ctl.target, cam.position).setY(0).normalize(), right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize()
      const mv = new THREE.Vector3()
      if (this.keys.has('w') || this.keys.has('arrowup')) mv.add(fwd)
      if (this.keys.has('s') || this.keys.has('arrowdown')) mv.sub(fwd)
      if (this.keys.has('d') || this.keys.has('arrowright')) mv.add(right)
      if (this.keys.has('a') || this.keys.has('arrowleft')) mv.sub(right)
      if (mv.lengthSq()) { mv.normalize().multiplyScalar(sp); cam.position.add(mv); ctl.target.add(mv); this.tween = null }
      const rot = (this.keys.has('q') ? 1 : 0) - (this.keys.has('e') ? 1 : 0)
      if (rot) { const off = cam.position.clone().sub(ctl.target).applyAxisAngle(cam.up, rot * rdt * 1.4); cam.position.copy(ctl.target).add(off); this.tween = null }
      const vert = (this.keys.has('r') ? 1 : 0) - (this.keys.has('f') ? 1 : 0)
      if (vert) { const dv = vert * rdt * 8; cam.position.y += dv; ctl.target.y = Math.max(0, ctl.target.y + dv); this.tween = null }
    }
    ctl.update()
    // alarm look: slow strobes, slightly warmer-red room light, brighter egress strips
    const alarm = sim.alarm && this.phase !== 'clear'
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9)
    const strobe = alarm && (t * 1.25) % 1 < 0.1
    this.M.strobe.emissiveIntensity = strobe ? 3.5 : alarm ? 0.3 : 0
    const warm = this.warm, red = this.red
    for (const ls of this.world.lights) for (const l of ls) {
      if (alarm) { l.color.copy(warm).lerp(red, 0.3 + 0.2 * pulse); l.intensity = 12 + 4 * pulse }
      else { l.color.copy(warm); l.intensity = 14 }
    }
    const eg = alarm ? 1.3 + 0.6 * pulse : 1
    this.M.egress.color.setRGB(0.12 * eg, 0.62 * eg, 0.34 * eg)
    if (this.lights) this.lights.hemi.intensity = alarm ? 0.68 + 0.05 * pulse : 0.8
    this.bloom.strength = alarm ? 0.3 + 0.05 * pulse : 0.26
    // incidents
    let fireSize = 0
    for (const f of this.fires) { f.fx.update(Math.min(0.1, sdt), t, f.h.r); fireSize += f.h.r / 4 }
    this.sound.fire(fireSize)
    for (const c of this.collapses) c.update(Math.min(0.05, sdt))
    for (const b of Object.values(this.beacons)) b.update(rdt, t)
    for (const r of this.ribbons) r.r.update(rdt, t)
    for (const list of Object.values(this.barriers)) for (const b of list) b.userData.lamp.visible = (t * 2) % 1 < 0.5
    if (this.marker.visible) this.marker.scale.setScalar(1 + 0.05 * Math.sin(t * 6))
    this.drawCrowd(rdt, t)
    // render with a little camera shake
    const sh = this.shake * 0.24
    this.shakeOff.set((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh)
    cam.position.add(this.shakeOff)
    this.composer.render()
    cam.position.sub(this.shakeOff)
    this.placeLabels()
    if (t - this.mapAt > 0.12) { this.mapAt = t; this.drawMap() }
    if (t - this.hudAt > 0.12) { this.hudAt = t; this.emitHud() }
  }

  private drawCrowd(rdt: number, t: number) {
    const sim = this.sim, cv = this.crowd, k = 1 - Math.exp(-rdt * 14)
    const evac = this.phase === 'assess' || this.phase === 'evacuate' || this.phase === 'clear'
    const ox = this.root.position.x, oz = this.root.position.z
    for (const a of sim.agents) {
      const i = a.i
      const vis = a.out || Math.ceil(a.lf - 0.02) <= this.focus
      if (!vis) { cv.hide(i); this.placed[i] = 0; continue }
      const y = a.out ? 0 : this.floorY(a.lf)
      const tx = a.x + (a.out ? 0 : ox), tz = a.z + (a.out ? 0 : oz)
      if (!this.placed[i]) { this.rx[i] = tx; this.ry[i] = y; this.rz[i] = tz; this.placed[i] = 1 }
      else { this.rx[i] += (tx - this.rx[i]) * k; this.ry[i] += (y - this.ry[i]) * k; this.rz[i] += (tz - this.rz[i]) * k }
      const trapped = a.mode === 'trapped'
      const p = this.pose
      p.x = this.rx[i]; p.y = this.ry[i]; p.z = this.rz[i]; p.yaw = a.yaw; p.scale = a.scale; p.sit = a.sit; p.crouch = a.crouch
      p.phase = a.phase; p.move = a.move; p.wave = trapped ? 1 : 0; p.alarm = a.mode === 'mill' ? 1 : 0
      p.lean = a.danger > 0 ? 0.22 : a.move * 0.07; p.t = t
      cv.pose(i, p)
      // floor ring: red for people who need rescue, group colour once the crowd is assigned, dim once safe
      if (trapped) { const f = (t * 2 + i * 0.1) % 1 < 0.5 ? 1.6 : 0.5; cv.setRing(i, f, 0.1 * f, 0.07 * f) }
      else if (evac && a.group >= 0 && sim.groups[a.group]) {
        const c = sim.groups[a.group].color, m = a.mode === 'assembled' ? 0.35 : a.danger > 0 ? 1.3 + 0.3 * Math.sin(t * 10) : 0.95
        cv.setRing(i, c[0] * m, c[1] * m, c[2] * m)
      } else if (a.mode === 'mill' || (sim.alarm && a.mode === 'seated')) { const f = 0.6 + 0.25 * Math.sin(t * 5 + i); cv.setRing(i, 0.9 * f, 0.5 * f, 0.15 * f) }
      else cv.setRing(i, 0, 0, 0)
    }
    cv.commit()
  }

  private placeLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight, v = this.v3
    for (let k = 0, n = this.labels.length + this.groupLabels.length; k < n; k++) {
      const l = k < this.labels.length ? this.labels[k] : this.groupLabels[k - this.labels.length]
      const p = l.at()
      if (!p) { if (l.el.style.display !== 'none') l.el.style.display = 'none'; continue }
      v.set(p[0], p[1], p[2]).project(this.camera)
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) { l.el.style.display = 'none'; continue }
      l.el.style.display = ''
      l.el.style.transform = `translate3d(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px, 0) translate(-50%, -100%)`
    }
  }

  private updateLabelText() {
    const sim = this.sim
    for (const l of this.labels) {
      const ex = l.el.dataset.exit, as = l.el.dataset.assembly
      if (ex) {
        const st = this.exitStatus(ex)
        l.el.className = `d-tag exit ${st}`
        l.el.querySelector('i')!.textContent = STATUS_WORD[st]
        this.beacons[ex].setStatus(st)
      } else if (as) l.el.querySelector('i')!.textContent = `${sim.outAsm[as] ?? 0} safe`
      else if (l.el.dataset.room) {
        const n = sim.agents.filter(a => a.room === this.startRoom).length
        l.el.innerHTML = `<b>${esc(this.startLabel())}</b><span>${n} people · ${esc(this.levelName(this.startLevel()))}</span>`
      }
    }
  }

  private emitHud() {
    if (!this.ready) return
    const sim = this.sim, plan = this.plan
    this.updateLabelText()
    const counts = sim.counts()
    const groups = sim.groups.map((g, gi) => {
      let total = 0, out = 0, fromStart = 0
      for (const a of sim.agents) if (a.group === gi) { total++; if (a.out) out++; if (a.start) fromStart++ }
      return { letter: g.letter, css: g.css, exitLabel: plan.exits.find(e => e.id === g.exit)?.label ?? g.exit, total, out, fromStart }
    })
    const scanned = this.phase === 'evacuate' || this.phase === 'clear'
    const assigned: Record<string, number> = {}
    for (const a of sim.agents) if (!a.out && a.group >= 0) assigned[a.exit] = (assigned[a.exit] ?? 0) + 1
    const exits = plan.exits.map((e, i) => ({
      id: e.id, n: i + 1, label: e.label, status: (scanned || this.revealed.has(e.id) ? this.exitStatus(e.id) : 'unknown') as ExitStatus,
      out: sim.outBy[e.id], assigned: assigned[e.id] ?? 0, closed: sim.exitClosed[e.id],
    }))
    const alarmT = this.alarmTime()
    const tool = this.tool
    const hint = tool ? (this.hover && !this.hover.ok ? 'Point at a floor inside the building' : tool === 'fire' ? 'Select a floor location for the fire. Press Esc to cancel.' : 'Select a location: the ceiling above it collapses. Press Esc to cancel.') : ''
    this.onHud({
      phase: this.phase, clock: this.clock(), elapsed: alarmT === null ? null : sim.t - alarmT, alarm: sim.alarm && this.phase !== 'clear', quake: sim.t < this.quakeUntil,
      paused: this.paused, speed: this.speed, counts, groups, exits,
      stairs: plan.stairs.map(s => ({ id: s.id, label: s.label, blocked: sim.stairBlocked[s.id] })),
      log: this.log.slice(0, 14), tool, focus: this.focus, explode: this.explodeTarget > 0.5, cinematic: this.cinematic, roof: this.roofOn,
      muted: this.sound.muted, flash: this.flash, startRoom: this.startRoom, startLabel: this.startLabel(), startLevel: this.startLevel(),
      startCount: sim.agents.filter(a => a.room === this.startRoom).length, scenario: this.scenario, summary: this.summary, mapLevel: this.mapLevel, hint, ready: this.ready,
      overlay: this.overlayReady ? this.overlayOn : null,
    })
  }

  // ---------- minimap ----------
  private drawMap() {
    const c = this.minimap
    if (!c || !this.ready) return
    const w = c.clientWidth, h = c.clientHeight
    if (!w || !h) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
    const LV = this.plan.levels
    if (w / h > 2.4 && LV > 1) { const pw = w / LV; for (let L = 0; L < LV; L++) this.drawPlan(g, LV - 1 - L, L * pw, 0, pw, h, false) }
    else this.drawPlan(g, this.mapLevel, 0, 0, w, h, true)
  }

  private drawPlan(g: CanvasRenderingContext2D, L: number, ox: number, oy: number, pw: number, ph: number, site: boolean) {
    const sim = this.sim, plan = this.plan
    const b = plan.bounds, ex = site ? plan.site : { x0: b.x0 - 2, z0: b.z0 - 2, x1: b.x1 + 2, z1: b.z1 + 2 }
    const s = Math.min((pw - 14) / (ex.x1 - ex.x0), (ph - 26) / (ex.z1 - ex.z0))
    const mx = (ex.x0 + ex.x1) / 2, mz = (ex.z0 + ex.z1) / 2
    const cx = ox + pw / 2, cy = oy + 14 + (ph - 14) / 2
    const P = (x: number, z: number): [number, number] => [cx + (x - mx) * s, cy + (z - mz) * s]
    const R = (x0: number, z0: number, x1: number, z1: number) => { const [a, c] = P(x0, z0); return [a, c, (x1 - x0) * s, (z1 - z0) * s] as const }
    const poly = (pts: [number, number][]) => { g.beginPath(); pts.forEach(([x, z], i) => { const [px, py] = P(x, z); if (i) g.lineTo(px, py); else g.moveTo(px, py) }); g.closePath() }
    g.save()
    g.beginPath(); g.rect(ox, oy, pw, ph); g.clip()
    if (site) {
      const done = new Set<string>()
      for (const e of plan.exits) {
        if (done.has(e.asm)) continue
        done.add(e.asm)
        const [x, y] = P(e.assembly[0], e.assembly[1]); g.beginPath(); g.arc(x, y, 4.8 * s, 0, 7)
        g.fillStyle = 'rgba(148,163,184,0.08)'; g.fill(); g.strokeStyle = 'rgba(74,222,128,0.45)'; g.lineWidth = 1; g.stroke()
      }
    }
    const tr = plan.geo?.traced[L], wm = tr?.hasWalls ? this.wallMap(L) : null
    if (wm && tr) {
      // traced walls: the building as drawn; of the room boxes only the start room, as a highlight
      const [ax, ay] = P(tr.x0, tr.z0)
      g.imageSmoothingEnabled = true; g.drawImage(wm, ax, ay, tr.cols * tr.res * s, tr.rows * tr.res * s)
      for (const r of plan.rooms) if (r.level === L && r.id === this.startRoom) { g.fillStyle = 'rgba(125,166,224,0.25)'; g.fillRect(...R(r.r.x0, r.r.z0, r.r.x1, r.r.z1)) }
    } else {
      g.fillStyle = 'rgba(148,163,184,0.10)'; g.strokeStyle = 'rgba(203,213,225,0.45)'; g.lineWidth = 1
      for (const m of plan.mapBase) if (m.level === L) { poly(m.poly); g.fill(); g.stroke() }
      for (const r of plan.rooms) if (r.level === L) {
        const q = R(r.r.x0, r.r.z0, r.r.x1, r.r.z1)
        g.fillStyle = r.id === this.startRoom ? 'rgba(125,166,224,0.22)' : 'rgba(15,23,42,0.6)'; g.fillRect(...q)
        g.strokeStyle = 'rgba(148,163,184,0.45)'; g.lineWidth = 1; g.strokeRect(...q)
      }
    }
    for (const st of plan.stairs) for (const z of st.zones) if (z.level === L) {
      const q = R(z.r.x0, z.r.z0, z.r.x1, z.r.z1), wide = q[2] > q[3]
      g.strokeStyle = 'rgba(148,163,184,0.5)'; g.lineWidth = 1
      for (let k = 1; k < 6; k++) {
        g.beginPath()
        if (wide) { g.moveTo(q[0] + (q[2] * k) / 6, q[1]); g.lineTo(q[0] + (q[2] * k) / 6, q[1] + q[3]) } else { g.moveTo(q[0], q[1] + (q[3] * k) / 6); g.lineTo(q[0] + q[2], q[1] + (q[3] * k) / 6) }
        g.stroke()
      }
      if (sim.stairBlocked[st.id]) { g.strokeStyle = '#ef4444'; g.lineWidth = 2; g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0] + q[2], q[1] + q[3]); g.moveTo(q[0] + q[2], q[1]); g.lineTo(q[0], q[1] + q[3]); g.stroke() }
    }
    for (const hz of sim.hazards) if (hz.level === L) {
      const [x, y] = P(hz.x, hz.z)
      if (hz.kind === 'fire') {
        const gr = g.createRadialGradient(x, y, 0, x, y, (hz.r * 2 + 3) * s)
        gr.addColorStop(0, 'rgba(239,68,68,0.85)'); gr.addColorStop(0.4, 'rgba(239,68,68,0.35)'); gr.addColorStop(1, 'rgba(239,68,68,0)')
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, (hz.r * 2 + 3) * s, 0, 7); g.fill()
      } else { g.fillStyle = 'rgba(203,213,225,0.55)'; g.beginPath(); g.arc(x, y, hz.r * s, 0, 7); g.fill() }
    }
    g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round'
    for (const rb of this.ribbons) {
      g.strokeStyle = rb.css; g.globalAlpha = 0.8; g.beginPath()
      let pen = false
      for (const [x, l, z] of rb.pts) {
        const on = Math.abs(l - L) < 0.51 || (site && L === 0 && l === 0)
        const [px, py] = P(x, z)
        if (on) { if (pen) g.lineTo(px, py); else g.moveTo(px, py); pen = true } else pen = false
      }
      g.stroke(); g.globalAlpha = 1
    }
    for (const a of sim.agents) {
      if (a.out ? !site || L !== 0 : Math.round(a.lf) !== L) continue
      const [x, y] = P(a.x, a.z)
      g.fillStyle = a.mode === 'trapped' ? '#ef4444' : a.group >= 0 && sim.groups[a.group] && this.split ? sim.groups[a.group].css : a.mode === 'mill' ? '#fcd34d' : '#e2e8f0'
      g.fillRect(x - 1.2, y - 1.2, 2.4, 2.4)
    }
    plan.exits.forEach((e, i) => {
      if (e.level !== L) return
      const [x, y] = P(e.door[0], e.door[1])
      const st = this.phase === 'briefing' || this.phase === 'calm' || this.phase === 'alarm' ? 'unknown' : this.exitStatus(e.id)
      g.fillStyle = st === 'safe' ? '#22c55e' : st === 'smoke' ? '#f59e0b' : st === 'unknown' ? '#64748b' : '#ef4444'
      g.beginPath(); g.arc(x, y, 6.5, 0, 7); g.fill()
      g.fillStyle = '#0b1220'; g.font = '700 10px "Atkinson Hyperlegible", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), x, y + 0.5)
    })
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = 'rgba(226,232,240,0.9)'; g.font = '700 11px "Atkinson Hyperlegible", sans-serif'
    g.fillText(this.levelName(L), ox + 7, oy + 5)
    g.restore()
  }

  /** A storey's traced walls and outline as a small picture for the minimap (drawn once, then scaled). */
  private wallMap(L: number) {
    if (this.wallMaps.has(L)) return this.wallMaps.get(L)!
    const t = this.plan.geo?.traced[L]
    let c: HTMLCanvasElement | null = null
    if (t?.hasWalls) {
      c = document.createElement('canvas'); c.width = t.cols; c.height = t.rows
      const g = c.getContext('2d')!, img = g.createImageData(t.cols, t.rows), d = img.data
      for (let i = 0; i < t.wall.length; i++) {
        const o = i * 4
        if (t.wall[i]) { d[o] = 226; d[o + 1] = 232; d[o + 2] = 240; d[o + 3] = 235 }
        else if (t.foot[i]) { d[o] = 148; d[o + 1] = 163; d[o + 2] = 184; d[o + 3] = 34 }
      }
      g.putImageData(img, 0, 0)
    }
    this.wallMaps.set(L, c)
    return c
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this.onDown); el.removeEventListener('pointerup', this.onUp); el.removeEventListener('pointermove', this.onMove); el.removeEventListener('contextmenu', this.noMenu)
    window.removeEventListener('keydown', this.onKey); window.removeEventListener('keyup', this.onKeyUp); window.removeEventListener('blur', this.onBlur)
    this.sound.dispose()
    this.controls.dispose()
    this.scene.traverse((o: any) => { o.geometry?.dispose?.() })
    for (const m of this.world?.overlays ?? []) { m.material.map?.dispose?.(); m.material.dispose() }
    this.composer.dispose?.()
    this.renderer.dispose()
    el.remove()
    for (const l of [...this.labels, ...this.groupLabels]) l.el.remove()
  }
}
