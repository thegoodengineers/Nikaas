/* eslint-disable @typescript-eslint/no-explicit-any */
// The drill: scene, camera, timeline (calm -> incident -> alarm -> exit scan -> evacuation -> all clear),
// incident tools, labels and the minimap. React only draws the HUD around it.
import * as THREE from 'three'
import { OrbitControls } from '../vendor/three/OrbitControls.js'
import { EffectComposer } from '../vendor/three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from '../vendor/three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from '../vendor/three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from '../vendor/three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js'
import { FH, LEVELS, LEVEL_NAMES, ROOMS, STAIRS, EXITS, CORRIDOR, LOBBY, FOOTPRINT, inRect } from './layout.ts'
import { makeMats, mulberry32, type Mats } from './materials.ts'
import { buildWorld, type World } from './build.ts'
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
}

export const START_ROOMS = ['seminar', 'c1a', 'lab', 'library', 'cafe']
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
type Label = { el: HTMLDivElement; at: () => [number, number, number] | null }

export class DrillEngine {
  sim!: Sim
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
  private explode = 0; private explodeTarget = 0; private focus = LEVELS - 1
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
  private step = { value: FH }; private maxLevel = { value: LEVELS - 1 }
  private incidents = 0; private reroutes = 0; private reason = ''
  private hudAt = 0; private mapAt = 0
  private summary: Summary | null = null
  private mapLevel = 2
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

  constructor(host: HTMLElement, labelLayer: HTMLElement, onHud: (s: HudState) => void, opts: { scenario: Scenario; startRoom: string; muted: boolean; flash: boolean }) {
    this.host = host; this.labelLayer = labelLayer; this.onHud = onHud
    this.scenario = opts.scenario; this.startRoom = opts.startRoom; this.flash = opts.flash
    this.sound.muted = opts.muted
    const w = host.clientWidth || 800, h = host.clientHeight || 600
    const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
    const pr = Math.min(window.devicePixelRatio || 1, 1.75)
    r.setPixelRatio(pr); r.setSize(w, h)
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.08
    r.outputColorSpace = THREE.SRGBColorSpace
    r.domElement.style.display = 'block'; r.domElement.style.width = '100%'; r.domElement.style.height = '100%'
    host.appendChild(r.domElement)
    this.renderer = r
    const scene = new THREE.Scene(); this.scene = scene
    scene.fog = new THREE.FogExp2('#121a29', 0.0058)
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.3, 1600)
    this.camera.position.set(40, 40, 60)
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 })
    this.composer = new EffectComposer(r, rt)
    this.composer.addPass(new RenderPass(scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.42, 0.93)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    const c = new OrbitControls(this.camera, r.domElement)
    c.enableDamping = true; c.dampingFactor = 0.08; c.maxPolarAngle = 1.47; c.minDistance = 3; c.maxDistance = 240
    c.screenSpacePanning = false; c.autoRotateSpeed = 0.45
    c.addEventListener('start', () => { this.tween = null; if (this.phase === 'briefing' || this.phase === 'calm') c.autoRotate = false })
    this.controls = c
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host)
    r.domElement.addEventListener('pointerdown', this.onDown); r.domElement.addEventListener('pointerup', this.onUp); r.domElement.addEventListener('pointermove', this.onMove)
    r.domElement.addEventListener('contextmenu', this.noMenu)
    window.addEventListener('keydown', this.onKey); window.addEventListener('keyup', this.onKeyUp); window.addEventListener('blur', this.onBlur)
    this.resize()
  }

  async init() {
    try { await Promise.race([Promise.all([document.fonts.load('800 40px "Big Shoulders Display"'), document.fonts.load('400 20px "Atkinson Hyperlegible"')]), new Promise(r => setTimeout(r, 1500))]) } catch { /* fonts are optional */ }
    if (this.disposed) return
    const scene = this.scene
    // dusk sky dome
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `varying vec3 vP; void main(){ float h = vP.y;
        vec3 top = vec3(0.025,0.045,0.10), mid = vec3(0.13,0.17,0.27), glow = vec3(0.42,0.26,0.20), low = vec3(0.04,0.05,0.07);
        vec3 c = mix(mid, top, smoothstep(0.05, 0.6, h)); c = mix(c, glow, smoothstep(0.18, 0.0, abs(h - 0.02)) * 0.55); c = mix(c, low, smoothstep(0.0, -0.2, h));
        gl_FragColor = vec4(c, 1.0); }`,
    }))
    scene.add(sky)
    const pm = new THREE.PMREMGenerator(this.renderer)
    scene.environment = pm.fromScene(new RoomEnvironment(this.renderer), 0.04).texture
    const hemi = new THREE.HemisphereLight('#9fb4dc', '#2a2622', 0.75)
    const sun = new THREE.DirectionalLight('#d6e0ff', 1.55)
    sun.position.set(-38, 70, 46); sun.target.position.set(0, 0, 0)
    sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096)
    Object.assign(sun.shadow.camera, { left: -52, right: 52, top: 52, bottom: -52, near: 10, far: 200 })
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025
    scene.add(hemi, sun, sun.target)
    this.lights = { hemi, sun }

    this.M = makeMats()
    const all: any[] = []
    for (const v of Object.values(this.M)) { if (Array.isArray(v)) all.push(...v); else all.push(v) }
    for (const m of all) if (m.isMeshStandardMaterial) m.envMapIntensity = 0.42
    this.world = buildWorld(this.M)
    scene.add(this.root, this.world.site)
    for (const g of this.world.levels) this.root.add(g)
    for (const g of this.world.flights) this.root.add(g)
    this.world.roof.visible = false; this.root.add(this.world.roof)
    for (const e of EXITS) {
      scene.add(assemblyMark(this.M, e.assembly[0], e.assembly[1]))
      const b = new Beacon(e.out[0], e.out[1], e.id); this.beacons[e.id] = b; scene.add(b.group)
    }
    this.sim = new Sim(this.world.seats, this.startRoom, mulberry32(42), ev => this.addLog(ev.kind, ev.text))
    const n = this.sim.agents.length
    this.crowd = new CrowdView(n, scene, mulberry32(7))
    for (const m of [this.crowd.torso.material, this.crowd.head.material]) m.envMapIntensity = 0.3
    this.rx = new Float32Array(n); this.ry = new Float32Array(n); this.rz = new Float32Array(n); this.placed = new Uint8Array(n)
    this.marker = marker(); scene.add(this.marker)
    this.makeLabels()
    this.mapLevel = this.startLevel()
    this.focus = this.startLevel()
    this.startView(true)
    this.addLog('info', `Morning session in the ${this.startLabel()}. All calm.`)
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
    this.addLog('info', 'Simulation started. Use the incident bar to change what happens.')
  }
  setSpeed(s: number) { this.speed = s }
  setPaused(p: boolean) { this.paused = p }
  setFocus(L: number) { this.focus = L; this.mapLevel = Math.min(L, LEVELS - 1) }
  setMapLevel(L: number) { this.mapLevel = L }
  setExplode(on: boolean) { this.explodeTarget = on ? 1 : 0 }
  setCinematic(on: boolean) { this.cinematic = on; if (!on) { this.tween = null; this.controls.autoRotate = false } }
  setRoof(on: boolean) { this.roofOn = on }
  setMuted(m: boolean) { this.sound.setMuted(m) }
  setFlash(f: boolean) { this.flash = f }
  setTool(t: Tool) { this.tool = t; this.marker.visible = false; this.hover = null; this.renderer.domElement.style.cursor = t ? 'crosshair' : '' }
  view(which: 'room' | 'overview' | 'top') {
    if (which === 'room') this.startView(false)
    else if (which === 'overview') this.flyTo([36, 30 + this.step.value * 3, 58], [0, this.step.value, 0], 2.2)
    else this.flyTo([0.01, 95, 8], [0, 0, 0], 2.2)
  }

  // ---------- incidents ----------
  placeFire(level: number, x: number, z: number) {
    if (!this.canAct()) return
    this.incidentStarted = true
    const label = this.placeName(level, x, z)
    const h = this.sim.addHazard({ kind: 'fire', level, x, z, r: 1.0, rMax: 4.2, grow: 0.07, label })
    const fx = new Fire(x, z); this.world.levels[level].add(fx.group)
    this.fires.push({ h, fx, level })
    this.labels.push({ el: this.tag('fire', `<b>FIRE</b><span>${label}</span>`), at: () => [x, this.floorY(level) + 3.2, z] })
    this.addLog('danger', `Fire breaks out: ${label} (${LEVEL_NAMES[level]})`)
    this.incidents++; this.reason = `fire in ${label}`; this.replanPending = true
    this.sound.init(); this.sound.blip(240, 0.12)
    if (!this.sim.alarm) this.after(2.4, () => { this.addLog('warn', `Smoke detector triggered on ${LEVEL_NAMES[level]}`); this.raiseAlarm() })
  }
  placeCollapse(level: number, x: number, z: number, r = 2.8) {
    if (!this.canAct()) return
    this.incidentStarted = true
    const top = level === LEVELS - 1, label = this.placeName(level, x, z)
    this.sound.init(); this.sound.rumble(1.8, 0.8); this.shake = Math.max(this.shake, 0.35)
    this.addLog('warn', `Cracking heard above ${label}…`)
    this.incidents++
    this.after(1.0, () => {
      const c = new Collapse(this.M, x, z, r)
      c.onLand = () => {
        this.sound.crash(1); this.shake = Math.max(this.shake, 1.1)
        const n = this.sim.crush(level, x, z, r)
        this.addLog('danger', `${top ? 'Roof' : 'Ceiling'} collapse: ${label}, ${LEVEL_NAMES[level]}${n ? `. ${n} people trapped under debris` : ''}`)
        this.sim.addHazard({ kind: 'collapse', level, x, z, r, rMax: r, grow: 0, label })
        this.reason = `collapse in ${label}`; this.replanPending = true
        if (!this.sim.alarm) this.raiseAlarm()
      }
      this.world.levels[level].add(c.group); this.collapses.push(c)
      this.labels.push({ el: this.tag('collapse', `<b>COLLAPSE</b><span>${label}</span>`), at: () => [x, this.floorY(level) + 2.6, z] })
    })
  }
  toggleStair(id: string, why = '') {
    if (!this.canAct()) return
    this.incidentStarted = true
    const s = STAIRS.find(x => x.id === id)!
    const on = !this.sim.stairBlocked[id]
    this.sim.stairBlocked[id] = on
    if (on) {
      const edge: Record<string, [number, number, number]> = { W: [-23, 2, -1], E: [23, -2, 1], C: [0, -5, 1] }
      const [x, z, side] = edge[id]
      this.barriers[id] = this.world.levels.map(g => { const b = stairBarrier(this.M, [x, z], 'z', 5.6, side); g.add(b); return b })
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
    const e = EXITS.find(x => x.id === id)!
    const open = EXITS.filter(x => !this.sim.exitClosed[x.id]).length
    if (!this.sim.exitClosed[id] && open <= 1) { this.addLog('warn', 'At least one exit has to stay open'); return }
    this.sim.exitClosed[id] = !this.sim.exitClosed[id]
    this.addLog(this.sim.exitClosed[id] ? 'danger' : 'good', `${e.label} ${this.sim.exitClosed[id] ? 'jammed shut' : 'reopened'}`)
    this.sound.init(); this.sound.blip(this.sim.exitClosed[id] ? 300 : 900)
    this.reason = `${e.label} ${this.sim.exitClosed[id] ? 'blocked' : 'reopened'}`; this.replanPending = true
  }
  earthquake() {
    if (!this.canAct() || this.sim.t < this.quakeUntil) return
    this.incidentStarted = true
    const T = this.sim.t
    this.quakeUntil = T + 7; this.sim.quake = true
    this.sound.init(); this.sound.rumble(7.6, 1); this.shake = 1.4
    this.addLog('danger', 'Earthquake. Everyone drops, covers and holds on.')
    this.incidents++
    this.after(0.8, () => { if (!this.sim.alarm) { this.addLog('warn', 'Seismic sensor tripped the building alarm'); this.raiseAlarm() } })
    const rnd = mulberry32(Math.floor(T * 1000) + 5)
    for (const d of [1.4, 2.9, 4.3, 5.6]) this.after(d, () => {
      const L = Math.floor(rnd() * LEVELS)
      const rooms = ROOMS.filter(r => r.level === L)
      const r = rooms[Math.floor(rnd() * rooms.length)]
      const x = r.r.x0 + 1.5 + rnd() * (r.r.x1 - r.r.x0 - 3), z = (r.r.z0 + r.r.z1) / 2 + (rnd() - 0.5) * 3
      const c = new Collapse(this.M, x, z, 1.1, 9)
      c.onLand = () => { this.sound.crash(0.45); const n = this.sim.crush(L, x, z, 0.9); if (n) this.addLog('danger', `Falling plaster in ${r.label}: ${n} hurt`) }
      this.world.levels[L].add(c.group); this.collapses.push(c)
    })
    this.after(2.6, () => {
      const open = STAIRS.filter(s => !this.sim.stairBlocked[s.id])
      if (open.length > 1) this.toggleStair(open[Math.floor(rnd() * open.length)].id, 'cracked by the quake')
    })
  }
  falseAlarm() {
    if (!this.canAct()) return
    this.incidentStarted = true
    if (this.sim.alarm) { this.addLog('info', 'Alarm is already sounding'); return }
    this.addLog('warn', `Manual call point pulled on ${LEVEL_NAMES[this.startLevel()]}. No fire confirmed: treat it as real.`)
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
    this.addLog('danger', 'ALARM. Evacuate the building.')
    this.shake = Math.max(this.shake, 0.25)
    if (this.phase === 'calm') this.setPhase('alarm')
  }
  private scenarioStart() {
    this.incidentStarted = true
    const L = this.startLevel()
    switch (this.scenario) {
      case 'fire': {
        const c1b = ROOMS.find(r => r.id === 'c1b')!
        if (this.startRoom === 'c1b') this.placeFire(0, -14, -9)
        else this.placeFire(1, (c1b.r.x0 + c1b.r.x1) / 2 + 1.5, -7.5)
        break
      }
      case 'quake': this.earthquake(); break
      case 'collapse': this.placeCollapse(L, 12.5, 0, 2.8); break
      case 'drill': this.falseAlarm(); break
    }
  }
  private enterAssess() {
    this.setPhase('assess')
    this.sim.recompute()
    this.focus = LEVELS - 1; this.explodeTarget = 1
    this.revealed.clear()
    if (this.cinematic) this.flyTo([34, 36 + FH * 2, 56], [0, FH * 1.2, 0], 3.2)
    this.addLog('info', 'Scanning every exit and route…')
  }
  private assessTick() {
    const k = this.sim.t - this.phaseAt
    EXITS.forEach((e, i) => {
      if (k > 0.7 + i * 0.5 && !this.revealed.has(e.id)) {
        this.revealed.add(e.id)
        const st = this.exitStatus(e.id)
        this.beacons[e.id].target = 1
        const word = { safe: 'clear', smoke: 'smoke on approach', blocked: 'BLOCKED', cut: 'cut off', unknown: '' }[st]
        this.addLog(st === 'safe' ? 'good' : st === 'smoke' ? 'warn' : 'danger', `Exit ${i + 1} · ${e.label}: ${word}`)
        this.sound.blip(st === 'safe' ? 990 : 330, 0.09)
      }
    })
    if (k > 3.0 && !this.split) {
      this.split = true
      this.sim.assign(true)
      const parts = this.sim.groups.map((g, gi) => `${g.letter} ${this.sim.agents.filter(a => a.start && a.group === gi).length}`).filter(s => !s.endsWith(' 0'))
      this.addLog('good', `Crowd in the ${this.startLabel()} split into ${parts.length} groups: ${parts.join(' · ')}`)
      this.buildRibbons()
      this.sound.blip(1320, 0.12)
    }
    if (k > 4.4) {
      this.setPhase('evacuate'); this.sim.go()
      this.addLog('info', 'Evacuation under way. Follow the lit routes.')
    }
  }
  private tick(h: number) {
    const sim = this.sim, T = sim.t
    if (this.queue.length) {
      const due = this.queue.filter(q => q.at <= T)
      if (due.length) { this.queue = this.queue.filter(q => q.at > T); for (const q of due) q.fn() }
    }
    const quaking = T < this.quakeUntil
    if (sim.quake && !quaking) this.addLog('warn', 'Shaking stopped. Move out now.')
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
    if (res.changed > 0) { this.reroutes += res.changed; this.addLog('warn', `Re-planned after ${this.reason}: ${res.changed} people switched exit`) }
    if (res.trapped > 0) this.addLog('danger', `${res.trapped} people have no safe route: rescue needed`)
    if (this.split) this.buildRibbons()
  }
  private finish() {
    this.setPhase('clear')
    const c = this.sim.counts(), time = this.sim.t - (this.alarmTime() ?? this.sim.t)
    this.summary = {
      time, out: c.out, total: c.total, trapped: c.trapped,
      perExit: EXITS.map(e => ({ label: e.label, n: this.sim.outBy[e.id] })), incidents: this.incidents, reroutes: this.reroutes, groups: this.sim.groups.length,
    }
    this.addLog(c.trapped ? 'warn' : 'good', c.trapped ? `Evacuation over: ${c.out} out, ${c.trapped} waiting for rescue` : `All clear: ${c.out} people out in ${fmt(time)}`)
    this.after(2.5, () => this.sound.sirenOff())
  }
  private alarmT = -1
  private alarmTime() { return this.alarmT < 0 ? null : this.alarmT }

  // ---------- helpers ----------
  private startLevel() { return ROOMS.find(r => r.id === this.startRoom)?.level ?? 2 }
  private startLabel() { return ROOMS.find(r => r.id === this.startRoom)?.label ?? 'building' }
  private floorY(lf: number) { return lf * this.step.value }
  private placeName(level: number, x: number, z: number) {
    const r = ROOMS.find(r => r.level === level && inRect(r.r, x, z))
    if (r) return r.label
    if (level === 0 && inRect(LOBBY, x, z)) return 'Lobby'
    const s = STAIRS.find(s => inRect(s.zone, x, z))
    if (s) return s.label
    if (inRect(CORRIDOR, x, z)) return `${x < -6 ? 'West' : x > 6 ? 'East' : 'Central'} corridor`
    return 'the building'
  }
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
    EXITS.forEach((e, i) => {
      const el = this.tag('exit', `<b>EXIT ${i + 1}</b><span>${e.label}</span><i>…</i>`)
      el.dataset.exit = e.id
      this.labels.push({ el, at: () => this.revealed.has(e.id) ? [e.out[0], 5.2, e.out[1]] : null })
      const a = this.tag('assembly', `<b>${e.assemblyLabel.split(' · ')[0]}</b><span>${e.assemblyLabel.split(' · ')[1]}</span><i>0 safe</i>`)
      a.dataset.assembly = e.id
      this.labels.push({ el: a, at: () => this.phase === 'evacuate' || this.phase === 'clear' || this.phase === 'assess' ? [e.assembly[0], 3.4, e.assembly[1]] : null })
    })
    const room = this.tag('room', '')
    room.dataset.room = '1'
    this.labels.push({
      el: room,
      at: () => {
        const r = ROOMS.find(x => x.id === this.startRoom)
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
      const e = EXITS.find(x => x.id === g.exit)!
      const pts: [number, number, number][] = route.map(n => [sim.nav.nodes[n].x, sim.nav.nodes[n].level, sim.nav.nodes[n].z])
      pts.push([e.out[0], 0, e.out[1]], [e.assembly[0], 0, e.assembly[1]])
      const r = new Ribbon(pts, new THREE.Color(...g.color), this.step, this.maxLevel)
      this.scene.add(r.mesh); this.ribbons.push({ r, pts, css: g.css })
      const p = pts[Math.min(3, pts.length - 1)]
      const el = this.tag('group', `<b style="color:${g.css}">GROUP ${g.letter}</b><span>to ${e.label}</span>`)
      this.groupLabels.push({ el, at: () => (this.phase === 'clear' || p[1] > this.focus + 0.5 ? null : [p[0], this.floorY(p[1]) + 2.2, p[2]]) })
    })
  }
  private startView(now: boolean) {
    const r = ROOMS.find(x => x.id === this.startRoom)!
    const cx = (r.r.x0 + r.r.x1) / 2, cz = (r.r.z0 + r.r.z1) / 2, y = this.floorY(r.level)
    const side = r.side === 'S' ? 1 : -1
    const pos: [number, number, number] = [cx + 9, y + 17, cz + side * 15], tgt: [number, number, number] = [cx, y + 0.5, cz]
    if (now) { this.camera.position.set(...pos); this.controls.target.set(...tgt); this.controls.update() }
    else this.flyTo(pos, tgt, 2.0)
    this.controls.autoRotate = this.cinematic
  }
  private flyTo(p: [number, number, number], t: [number, number, number], dur: number) {
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
      if (!h || !h.ok) { this.addLog('info', 'Pick a spot inside the building'); return }
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
    const ok = this.sim.insideBuilding(L, x, z) || (L === 0 && inRect(FOOTPRINT, x, z))
    this.hover = { level: L, x, z, ok }
    this.marker.visible = true
    this.marker.position.set(x, this.floorY(L) + 0.06, z)
    this.marker.userData.mat.color.setRGB(...((ok ? (this.tool === 'fire' ? [3, 1.1, 0.25] : [2.2, 2.2, 2.4]) : [1.2, 0.1, 0.1]) as [number, number, number]))
  }
  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return
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

  // ---------- frame ----------
  private loop = () => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const now = performance.now(), rdt = Math.min(0.05, (now - this.last) / 1000)
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
    const sim = this.sim, t = this.realT, cam = this.camera, ctl = this.controls
    // storeys: cutaway and pull-apart
    this.explode += (this.explodeTarget - this.explode) * Math.min(1, rdt * 2.5)
    this.step.value = FH * (1 + this.explode * 1.15)
    this.maxLevel.value = this.focus
    this.world.levels.forEach((g: any, L: number) => { g.position.y = this.floorY(L); g.visible = L <= this.focus })
    this.world.flights.forEach((g: any, L: number) => { g.position.y = this.floorY(L); g.scale.y = this.step.value / FH; g.visible = L + 1 <= this.focus })
    this.world.roof.position.y = this.floorY(LEVELS); this.world.roof.visible = this.roofOn && this.focus === LEVELS - 1
    // shaking
    const quaking = sim.t < this.quakeUntil
    if (quaking) this.shake = Math.max(this.shake, 0.9)
    this.shake = Math.max(0, this.shake - rdt * (quaking ? 0.2 : 0.9))
    const qa = quaking ? 0.09 : 0
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
    // alarm look: strobes, red room lights, brighter floor strips
    const alarm = sim.alarm && this.phase !== 'clear'
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9)
    const strobe = alarm && (t * 1.25) % 1 < 0.1
    this.M.strobe.emissiveIntensity = strobe ? 9 : alarm ? 0.4 : 0
    const warm = new THREE.Color('#ffd7a8'), red = new THREE.Color('#ff2a1a')
    for (const ls of this.world.lights) for (const l of ls) {
      if (alarm) { l.color.copy(warm).lerp(red, 0.55 + 0.4 * pulse); l.intensity = 10 + 14 * pulse }
      else { l.color.copy(warm); l.intensity = 14 }
    }
    const eg = alarm ? 1.6 + 1.4 * pulse : 1
    this.M.egress.color.setRGB(0.12 * eg, 0.75 * eg, 0.38 * eg)
    if (this.lights) this.lights.hemi.intensity = alarm ? 0.55 + 0.1 * pulse : 0.75
    // incidents
    this.bloom.strength = alarm ? 0.6 + 0.14 * pulse : 0.55
    let fireSize = 0
    for (const f of this.fires) { f.fx.update(Math.min(0.1, sdt), t, f.h.r); fireSize += f.h.r / 4 }
    this.sound.fire(fireSize)
    for (const c of this.collapses) c.update(Math.min(0.05, sdt))
    for (const b of Object.values(this.beacons)) b.update(rdt, t)
    for (const r of this.ribbons) r.r.update(rdt, t)
    for (const list of Object.values(this.barriers)) for (const b of list) b.userData.lamp.visible = (t * 2) % 1 < 0.5
    if (this.marker.visible) this.marker.scale.setScalar(1 + 0.08 * Math.sin(t * 6))
    this.drawCrowd(rdt, t)
    // render with a little camera shake
    const sh = this.shake * 0.28
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
      cv.pose(i, {
        x: this.rx[i], y: this.ry[i], z: this.rz[i], yaw: a.yaw, scale: a.scale, sit: a.sit, crouch: a.crouch,
        phase: a.phase, move: a.move, wave: trapped ? 1 : 0, alarm: a.mode === 'mill' ? 1 : 0,
        lean: a.danger > 0 ? 0.22 : a.move * 0.07, t,
      })
      // glow ring: red while frightened, group colour once the crowd is split, dim once safe
      if (trapped) { const f = (t * 3 + i * 0.1) % 1 < 0.5 ? 3 : 0.6; cv.setRing(i, f, 0.08 * f, 0.05 * f) }
      else if (evac && a.group >= 0 && sim.groups[a.group]) {
        const c = sim.groups[a.group].color, m = a.mode === 'assembled' ? 0.5 : a.danger > 0 ? 2.4 + Math.sin(t * 14) : 1.7
        cv.setRing(i, c[0] * m, c[1] * m, c[2] * m)
      } else if (a.mode === 'mill' || (sim.alarm && a.mode === 'seated')) { const f = 0.9 + 0.7 * Math.sin(t * 8 + i); cv.setRing(i, 1.4 * f, 0.12 * f, 0.08 * f) }
      else cv.setRing(i, 0, 0, 0)
    }
    cv.commit()
  }

  private placeLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight, v = this.v3
    for (const l of [...this.labels, ...this.groupLabels]) {
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
        const i = l.el.querySelector('i')!
        i.textContent = { safe: 'SAFE', smoke: 'SMOKE', blocked: 'BLOCKED', cut: 'CUT OFF', unknown: '' }[st]
        this.beacons[ex].setStatus(st)
      } else if (as) l.el.querySelector('i')!.textContent = `${sim.outBy[as]} safe`
      else if (l.el.dataset.room) {
        const n = sim.agents.filter(a => a.room === this.startRoom).length
        l.el.innerHTML = `<b>${this.startLabel().toUpperCase()}</b><span>${n} people · ${LEVEL_NAMES[this.startLevel()]}</span>`
      }
    }
  }

  private emitHud() {
    if (!this.ready) return
    const sim = this.sim
    this.updateLabelText()
    const counts = sim.counts()
    const groups = sim.groups.map((g, gi) => {
      let total = 0, out = 0, fromStart = 0
      for (const a of sim.agents) if (a.group === gi) { total++; if (a.out) out++; if (a.start) fromStart++ }
      return { letter: g.letter, css: g.css, exitLabel: EXITS.find(e => e.id === g.exit)!.label, total, out, fromStart }
    })
    const scanned = this.phase === 'evacuate' || this.phase === 'clear'
    const exits = EXITS.map((e, i) => ({
      id: e.id, n: i + 1, label: e.label, status: (scanned || this.revealed.has(e.id) ? this.exitStatus(e.id) : 'unknown') as ExitStatus,
      out: sim.outBy[e.id], assigned: sim.agents.filter(a => !a.out && a.exit === e.id && a.group >= 0).length, closed: sim.exitClosed[e.id],
    }))
    const alarmT = this.alarmTime()
    const tool = this.tool
    const hint = tool ? (this.hover && !this.hover.ok ? 'Point at a floor inside the building' : tool === 'fire' ? 'Click any floor to start a fire. Esc to cancel.' : 'Click a spot: the ceiling above it comes down. Esc to cancel.') : ''
    this.onHud({
      phase: this.phase, clock: this.clock(), elapsed: alarmT === null ? null : sim.t - alarmT, alarm: sim.alarm && this.phase !== 'clear', quake: sim.t < this.quakeUntil,
      paused: this.paused, speed: this.speed, counts, groups, exits,
      stairs: STAIRS.map(s => ({ id: s.id, label: s.label, blocked: sim.stairBlocked[s.id] })),
      log: this.log.slice(0, 14), tool, focus: this.focus, explode: this.explodeTarget > 0.5, cinematic: this.cinematic, roof: this.roofOn,
      muted: this.sound.muted, flash: this.flash, startRoom: this.startRoom, startLabel: this.startLabel(), startLevel: this.startLevel(),
      startCount: sim.agents.filter(a => a.room === this.startRoom).length, scenario: this.scenario, summary: this.summary, mapLevel: this.mapLevel, hint, ready: this.ready,
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
    if (w / h > 2.4) { const pw = w / 3; for (let L = 0; L < LEVELS; L++) this.drawPlan(g, LEVELS - 1 - L, L * pw, 0, pw, h, false) }
    else this.drawPlan(g, this.mapLevel, 0, 0, w, h, true)
  }

  private drawPlan(g: CanvasRenderingContext2D, L: number, ox: number, oy: number, pw: number, ph: number, site: boolean) {
    const sim = this.sim
    const ex = site ? [-48, 48, -34, 34] : [-28, 28, -14, 14]
    const s = Math.min((pw - 14) / (ex[1] - ex[0]), (ph - 26) / (ex[3] - ex[2]))
    const cx = ox + pw / 2, cy = oy + 14 + (ph - 14) / 2
    const P = (x: number, z: number): [number, number] => [cx + x * s, cy + z * s]
    const R = (x0: number, z0: number, x1: number, z1: number) => { const [a, b] = P(x0, z0); return [a, b, (x1 - x0) * s, (z1 - z0) * s] as const }
    g.save()
    g.beginPath(); g.rect(ox, oy, pw, ph); g.clip()
    if (site) {
      g.fillStyle = 'rgba(148,163,184,0.10)'
      for (const e of EXITS) { const [x, y] = P(e.assembly[0], e.assembly[1]); g.beginPath(); g.arc(x, y, 4.8 * s, 0, 7); g.fill(); g.strokeStyle = 'rgba(52,211,153,0.6)'; g.lineWidth = 1; g.stroke() }
    }
    g.fillStyle = 'rgba(148,163,184,0.10)'; g.strokeStyle = 'rgba(203,213,225,0.55)'; g.lineWidth = 1.2
    for (const r of [FOOTPRINT, STAIRS[0].zone, STAIRS[2].zone]) { const q = R(r.x0, r.z0, r.x1, r.z1); g.fillRect(...q); g.strokeRect(...q) }
    for (const r of ROOMS.filter(r => r.level === L)) {
      const q = R(r.r.x0, r.r.z0, r.r.x1, r.r.z1)
      g.fillStyle = r.id === this.startRoom ? 'rgba(34,211,238,0.16)' : 'rgba(15,23,42,0.55)'; g.fillRect(...q)
      g.strokeStyle = 'rgba(148,163,184,0.45)'; g.lineWidth = 1; g.strokeRect(...q)
    }
    for (const st of STAIRS) {
      const q = R(st.zone.x0, st.zone.z0, st.zone.x1, st.zone.z1)
      g.strokeStyle = 'rgba(147,197,253,0.5)'; g.lineWidth = 1
      for (let k = 1; k < 6; k++) { g.beginPath(); g.moveTo(q[0], q[1] + (q[3] * k) / 6); g.lineTo(q[0] + q[2], q[1] + (q[3] * k) / 6); g.stroke() }
      if (sim.stairBlocked[st.id]) { g.strokeStyle = '#ef4444'; g.lineWidth = 2.4; g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(q[0] + q[2], q[1] + q[3]); g.moveTo(q[0] + q[2], q[1]); g.lineTo(q[0], q[1] + q[3]); g.stroke() }
    }
    for (const h of sim.hazards) if (h.level === L) {
      const [x, y] = P(h.x, h.z)
      if (h.kind === 'fire') {
        const gr = g.createRadialGradient(x, y, 0, x, y, (h.r * 2 + 3) * s)
        gr.addColorStop(0, 'rgba(255,120,30,0.95)'); gr.addColorStop(0.35, 'rgba(255,60,20,0.5)'); gr.addColorStop(1, 'rgba(255,40,10,0)')
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, (h.r * 2 + 3) * s, 0, 7); g.fill()
      } else { g.fillStyle = 'rgba(203,213,225,0.55)'; g.beginPath(); g.arc(x, y, h.r * s, 0, 7); g.fill() }
    }
    g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round'
    for (const rb of this.ribbons) {
      g.strokeStyle = rb.css; g.globalAlpha = 0.85; g.beginPath()
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
      g.fillStyle = a.mode === 'trapped' ? '#ef4444' : a.group >= 0 && sim.groups[a.group] && this.split ? sim.groups[a.group].css : a.mode === 'mill' ? '#fca5a5' : '#e2e8f0'
      g.fillRect(x - 1.3, y - 1.3, 2.6, 2.6)
    }
    if (L === 0 || site) EXITS.forEach((e, i) => {
      const [x, y] = P(e.door[0], e.door[1])
      const st = this.phase === 'briefing' || this.phase === 'calm' || this.phase === 'alarm' ? 'unknown' : this.exitStatus(e.id)
      g.fillStyle = st === 'safe' ? '#22c55e' : st === 'smoke' ? '#f59e0b' : st === 'unknown' ? '#64748b' : '#ef4444'
      g.beginPath(); g.arc(x, y, 6.5, 0, 7); g.fill()
      g.fillStyle = '#04120a'; g.font = '800 10px "Big Shoulders Display", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), x, y + 0.5)
    })
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = 'rgba(226,232,240,0.9)'; g.font = '800 12px "Big Shoulders Display", sans-serif'
    g.fillText(LEVEL_NAMES[L].toUpperCase(), ox + 7, oy + 5)
    g.restore()
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
    this.composer.dispose?.()
    this.renderer.dispose()
    el.remove()
    for (const l of [...this.labels, ...this.groupLabels]) l.el.remove()
  }
}
