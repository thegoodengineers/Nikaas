// Crowd evacuation model: distance-to-exit fields on the walking graph, a load-balanced split of the
// crowd across exits (and stairs), local collision avoidance, stair queues and live re-routing.
// Everything about the building comes from a Plan, so the same model runs the demo block and any building graph.
import { R, WALL_T, type Nav } from './layout.ts'
import type { Plan, PlanExit } from './plan.ts'
import type { Seat } from './build.ts'

export type Mode = 'seated' | 'idle' | 'mill' | 'walk' | 'rail' | 'outside' | 'assembled' | 'trapped'
export type Agent = {
  i: number; room: string; start: boolean; level: number; lf: number; x: number; z: number; yaw: number
  vx: number; vz: number; speed: number; mode: Mode; sit: number; seatYaw: number
  react: number; goT: number; pre: [number, number][]; node: number; prev: number
  exit: string; group: number; rail: { a: number; b: number; t: number; len: number } | null; lane: number
  mx: number; mz: number; millT: number; stuckT: number; lastD: number; danger: number; crouch: number
  out: boolean; tOut: number; target: [number, number] | null; slot: [number, number] | null; injured: boolean
  phase: number; move: number; scale: number
  lookT: number; legT: number; ghost: number   // look-ahead timer, time on this leg, deadlock escape until
  follows: boolean     // takes the exit the guidance gives (false: rushes the exit they know)
  wc: boolean          // wheelchair user who cannot use stairs on their own
  chair: boolean       // drawn in a wheelchair (stays true when staff carry them)
  assistAt: number     // when staff reach a wheelchair user with no step-free route
  base: number; react0: number; sit0: number   // as spawned, so the crowd can be reconfigured before the start
}
export type Hazard = { id: number; kind: 'fire' | 'collapse'; level: number; x: number; z: number; r: number; rMax: number; grow: number; label: string; t0: number }
export type SimEvent = { kind: 'info' | 'warn' | 'danger' | 'good'; text: string }
/** How the crowd behaves: the share who follow the group exit they are given; the rest rush the exit they know. */
export type CrowdProfile = 'guided' | 'mixed' | 'panic'
export const CROWD_PROFILES: Record<CrowdProfile, { follow: number; label: string; text: string }> = {
  guided: { follow: 0.9, label: 'Guided', text: '90% follow their group exit' },
  mixed: { follow: 0.65, label: 'Mixed', text: '35% ignore the guidance' },
  panic: { follow: 0.3, label: 'Panic', text: '70% rush the exit they know' },
}
/** Share of the crowd using a wheelchair when that option is on. */
export const WHEELCHAIR_SHARE = 0.06
/** Seconds a wheelchair user with no step-free route waits before staff carry them down. */
const ASSIST_DELAY = 40
/** Every stair has an accessible ramp beside it (drawn by the engine), so wheelchair users keep using the stair routes. */
const RAMPS = true
export type Group = { exit: string; letter: string; color: [number, number, number]; css: string }

// muted but distinct: teal, ochre, lilac, olive (status colours stay reserved for safe / smoke / danger)
export const GROUP_COLORS: [string, [number, number, number]][] = [
  ['#5fb4c6', [0.37, 0.71, 0.78]], ['#d3a24e', [0.83, 0.64, 0.31]], ['#b394d8', [0.7, 0.58, 0.85]], ['#93b863', [0.58, 0.72, 0.39]],
]
const ARRIVE: Record<string, number> = { corr: 0.85, lobby: 1.0, landing: 0.8, door: 0.42, inner: 0.45, stair: 0.5, exit: 0.45, room: 0.6 }
const OUT_LEVEL = 99

export class Sim {
  plan: Plan
  nav: Nav
  agents: Agent[] = []
  D: Record<string, Float64Array> = {}
  DA: Record<string, Float64Array> = {}   // distance fields for step-free routes (no stairs)
  hasWc = false
  private assistNow = false
  blocked: Uint8Array
  pen: Float32Array
  hazards: Hazard[] = []
  stairBlocked: Record<string, boolean> = {}
  exitClosed: Record<string, boolean> = {}
  groups: Group[] = []
  groupOf: Record<string, number> = {}
  outBy: Record<string, number> = {}
  outAsm: Record<string, number> = {}
  exitNode: Record<string, number> = {}
  inners: Record<string, number[]> = {}
  t = 0
  evacuating = false
  quake = false
  alarm = false
  startRoom: string
  private exits: PlanExit[]
  private exitById: Record<string, PlanExit> = {}
  private stairFlow: Record<string, number> = {}
  private groundExits: boolean
  private gx: number; private gz: number
  private rnd: () => number
  private emit: (e: SimEvent) => void
  private grid = new Map<number, Agent[]>()
  private rails = new Map<string, Agent[]>()
  private stairCache = new Map<string, string | null>()
  private nextHazard = 1

  constructor(plan: Plan, seats: Seat[], startRoom: string, rnd: () => number, emit: (e: SimEvent) => void, opt: { follow?: number; wheelchair?: number } = {}) {
    this.plan = plan; this.nav = plan.nav; this.exits = plan.exits
    this.startRoom = startRoom; this.rnd = rnd; this.emit = emit
    const n = this.nav.nodes.length
    this.blocked = new Uint8Array(n); this.pen = new Float32Array(n)
    let mx = Infinity, mz = Infinity
    for (const node of this.nav.nodes) {
      if (node.kind === 'exit') this.exitNode[node.exit!] = node.i
      if (node.kind === 'inner') (this.inners[node.room!] ??= []).push(node.i)
      mx = Math.min(mx, node.x); mz = Math.min(mz, node.z)
    }
    // spatial hash offsets: keep cell indices positive for any building origin (and for the assembly points)
    this.gx = 96 - Math.floor(Math.min(mx, plan.site.x0)); this.gz = 96 - Math.floor(Math.min(mz, plan.site.z0))
    for (const e of this.exits) { this.outBy[e.id] = 0; this.outAsm[e.asm] = 0; this.exitClosed[e.id] = false; this.exitById[e.id] = e }
    for (const s of plan.stairs) { this.stairBlocked[s.id] = false; this.stairFlow[s.id] = s.flow }
    this.groundExits = this.exits.every(e => e.level === 0)
    for (const room of plan.spawn) {
      const list = seats.filter(s => s.room === room.id)
      const stand = list.filter(s => !s.sit), sit = list.filter(s => s.sit)
      for (let k = sit.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [sit[k], sit[j]] = [sit[j], sit[k]] }
      const chosen = [...stand, ...sit].slice(0, room.people)
      for (const s of chosen) this.spawn(s, room.id === startRoom)
    }
    this.configure(opt)
  }

  /** Decide who follows the guidance and who uses a wheelchair. Only before the drill starts. */
  configure(opt: { follow?: number; wheelchair?: number }) {
    let seed = 7
    const g = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    const follow = opt.follow ?? 1, share = opt.wheelchair ?? 0, n = this.agents.length
    const order = this.agents.map((_, i) => i)
    for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(g() * (k + 1)); [order[k], order[j]] = [order[j], order[k]] }
    const wcSet = new Set(share > 0 && n >= 8 ? order.slice(0, Math.max(1, Math.round(n * share))) : [])
    for (const a of this.agents) {
      a.follows = g() < follow
      a.wc = a.chair = wcSet.has(a.i)
      a.assistAt = Infinity
      a.speed = a.wc ? 0.62 + (a.base - 1.2) * 0.35 : a.base * (a.follows ? 1 : 1.12)
      a.react = a.react0 * (a.follows ? 1 : 0.55)
      a.mode = a.wc || !a.sit0 ? 'idle' : 'seated'; a.sit = a.wc ? 0 : a.sit0
    }
    this.recompute()
  }

  /** Read-outs for the crowd panel. */
  crowdStats() {
    let ignoring = 0, wc = 0, wcOut = 0, wcWaiting = 0
    for (const a of this.agents) {
      if (!a.follows) ignoring++
      if (a.chair) { wc++; if (a.out) wcOut++; else if (a.mode === 'trapped' && !a.injured) wcWaiting++ }
    }
    return { ignoring, wc, wcOut, wcWaiting }
  }

  private spawn(s: Seat, start: boolean) {
    const r = this.rnd
    this.agents.push({
      i: this.agents.length, room: s.room, start, level: s.level, lf: s.level, x: s.x, z: s.z, yaw: s.yaw,
      vx: 0, vz: 0, speed: 1.2 + r() * 0.35, mode: s.sit ? 'seated' : 'idle', sit: s.sit ? 1 : 0, seatYaw: s.yaw,
      react: (start ? 0.25 : 0.6) + r() * (start ? 1.3 : 2.6), goT: 0, pre: [], node: -1, prev: -1,
      exit: 'MAIN', group: -1, rail: null, lane: (r() - 0.5) * 1.5,
      mx: s.x, mz: s.z, millT: 0, stuckT: 0, lastD: 1e9, danger: 0, crouch: 0,
      out: false, tOut: 0, target: null, slot: null, injured: false,
      phase: r() * 6, move: 0, scale: 0.9 + r() * 0.13, lookT: 0, legT: 0, ghost: -1,
      follows: true, wc: false, chair: false, assistAt: Infinity, base: 0, react0: 0, sit0: s.sit ? 1 : 0,
    })
    const a = this.agents[this.agents.length - 1]
    a.base = a.speed; a.react0 = a.react
  }

  // ---------- hazards and distance fields ----------
  addHazard(h: Omit<Hazard, 'id' | 't0'>) { const z = { ...h, id: this.nextHazard++, t0: this.t }; this.hazards.push(z); return z }

  recompute() {
    const { nodes } = this.nav, B = this.blocked, P = this.pen
    B.fill(0); P.fill(0)
    for (const n of nodes) {
      if (n.rail && this.stairBlocked[n.stair!]) B[n.i] = 1
      if (n.kind === 'exit' && this.exitClosed[n.exit!]) B[n.i] = 1
      for (const h of this.hazards) {
        if (Math.abs(n.level - h.level) > 0.01) continue
        const d = Math.hypot(n.x - h.x, n.z - h.z)
        if (h.kind === 'fire') {
          if (d < h.r + 0.9) B[n.i] = 1
          else if (d < h.r * 2 + 4) P[n.i] += 45 * (1 - (d - h.r - 0.9) / (h.r + 3.1))
        } else if (d < h.r + 0.5) B[n.i] = 1
      }
    }
    this.hasWc = this.agents.some(a => a.wc)
    for (const e of this.exits) {
      this.D[e.id] = this.dijkstra(this.exitNode[e.id])
      this.DA[e.id] = !RAMPS && this.hasWc && this.plan.stairs.length ? this.dijkstra(this.exitNode[e.id], true) : this.D[e.id]
    }
    this.stairCache.clear()
  }

  /** If everything within r of (x, z) on a storey were blocked: how many people would have no way out, and how
   * many exits nobody could reach any more. */
  impact(level: number, x: number, z: number, r: number) {
    const { nodes, adj } = this.nav, B = new Uint8Array(this.blocked)
    for (const n of nodes) if (Math.abs(n.level - level) < 0.01 && Math.hypot(n.x - x, n.z - z) < r) B[n.i] = 1
    const rooms = this.plan.spawn.filter(s => s.people && this.inners[s.id])
    const all = new Uint8Array(nodes.length)
    let exitsLost = 0
    for (const e of this.exits) {
      const s = this.exitNode[e.id]
      if (B[s] || this.exitClosed[e.id]) { exitsLost++; continue }
      const reach = new Uint8Array(nodes.length), q = [s]; reach[s] = 1
      while (q.length) { const u = q.pop()!; for (const ed of adj[u]) if (!reach[ed.to] && !B[ed.to]) { reach[ed.to] = 1; q.push(ed.to) } }
      if (!rooms.some(rm => this.inners[rm.id].some(i => reach[i]))) exitsLost++
      for (let i = 0; i < reach.length; i++) if (reach[i]) all[i] = 1
    }
    let trapped = 0
    for (const rm of rooms) if (!this.inners[rm.id].some(i => all[i])) trapped += rm.people
    return { trapped, exitsLost }
  }

  private dOf(a: Agent, e: string) { return a.wc ? this.DA[e] : this.D[e] }

  private dijkstra(src: number, stepFree = false) {
    const n = this.nav.nodes.length, dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n)
    if (this.blocked[src]) return dist
    dist[src] = 0
    for (;;) {
      let u = -1, best = Infinity
      for (let k = 0; k < n; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k }
      if (u < 0) break
      done[u] = 1
      for (const e of this.nav.adj[u]) {
        if (this.blocked[e.to] || (stepFree && e.rail)) continue
        const c = best + e.len * (e.rail ? 1.25 : 1) + this.pen[e.to]
        if (c < dist[e.to]) dist[e.to] = c
      }
    }
    return dist
  }

  exitReachable(e: string) {
    if (this.blocked[this.exitNode[e]]) return false
    const left = this.agents.filter(a => !a.out && a.mode !== 'trapped')
    return !left.length || left.some(a => isFinite(this.costTo(a, e))) // nobody left inside: nothing is cut off
  }

  private startNodes(a: Agent): number[] {
    const inn = this.inners[a.room]
    if (inn) return inn
    let best = -1, bd = Infinity
    for (const n of this.nav.nodes) if (n.level === a.level && (n.kind === 'lobby' || n.kind === 'corr')) {
      const d = Math.hypot(n.x - a.x, n.z - a.z); if (d < bd) { bd = d; best = n.i }
    }
    return [best]
  }

  private costTo(a: Agent, e: string, D = this.dOf(a, e)) {
    if (a.mode === 'rail' && a.rail) return a.rail.len - a.rail.t + D[a.rail.b]
    if (a.mode === 'walk' && a.node >= 0 && !a.pre.length) {
      const n = this.nav.nodes[a.node]
      return Math.hypot(n.x - a.x, n.z - a.z) + D[a.node]
    }
    let best = Infinity
    for (const s of this.startNodes(a)) {
      const n = this.nav.nodes[s]
      best = Math.min(best, Math.hypot(n.x - a.x, n.z - a.z) + D[s])
    }
    return best
  }

  /** First stair on the way from an agent to an exit (stairs are the shared bottleneck upstairs). */
  private stairOf(a: Agent, e: string) {
    if (!this.plan.stairs.length || (this.groundExits && a.level === 0 && a.mode !== 'rail')) return null
    const D = this.dOf(a, e), from = a.mode === 'rail' && a.rail ? a.rail.b : a.node >= 0 && !a.pre.length ? a.node : this.startNodes(a)[0]
    const key = `${from}:${e}:${a.wc ? 1 : 0}`
    if (this.stairCache.has(key)) return this.stairCache.get(key)!
    let n = from, found: string | null = null
    for (let k = 0; k < 600 && n >= 0; k++) {
      const node = this.nav.nodes[n]
      if (node.rail) { found = node.stair!; break }
      if (node.kind === 'exit') break
      let best = -1, bc = Infinity
      for (const ed of this.nav.adj[n]) { if (this.blocked[ed.to]) continue; const c = ed.len + D[ed.to]; if (c < bc) { bc = c; best = ed.to } }
      n = best
    }
    this.stairCache.set(key, found)
    return found
  }

  private ensureGroup(e: string) {
    if (this.groupOf[e] !== undefined) return this.groupOf[e]
    const k = this.groups.length
    const [css, color] = GROUP_COLORS[k % GROUP_COLORS.length]
    this.groups.push({ exit: e, letter: 'ABCDEFG'[k], color, css })
    this.groupOf[e] = k
    return k
  }

  /** Split everyone still inside across the open exits, balancing exit and stair queues. The crowd of the start room
   * is limited to three groups so it splits into clear sections instead of a stampede to the nearest door. */
  assign(initial: boolean) {
    const live = this.agents.filter(a => !a.out && a.mode !== 'trapped')
    const ids = this.exits.map(e => e.id).filter(e => !this.blocked[this.exitNode[e]])
    const flow: Record<string, number> = Object.fromEntries(this.exits.map(e => [e.id, e.flow]))
    const cost = live.map(a => ids.map(e => this.costTo(a, e)))
    let startPool = new Set(ids)
    let choice: (string | null)[] = []
    const known = ids.reduce((b, e) => (flow[e] > (flow[b] ?? -1) ? e : b), ids[0])   // the widest door: the one people came in by
    for (let iter = 0; iter < 4; iter++) {
      const load: Record<string, number> = {}, sload: Record<string, number> = {}
      const order = live.map((_, k) => k).sort((p, q) => Math.min(...cost[p]) - Math.min(...cost[q]))
      choice = new Array(live.length).fill(null)
      for (const k of order) {
        const a = live[k]
        let best: string | null = null, bs = Infinity
        if (!a.follows) {   // rushes the nearest exit they know, ignoring the group split
          ids.forEach((e, j) => { const c = cost[k][j]; if (!isFinite(c)) return; const v = e === known ? c * 0.5 : c; if (v < bs) { bs = v; best = e } })
          choice[k] = best
          if (best) { load[best] = (load[best] ?? 0) + 1; const st = this.stairOf(a, best); if (st) sload[st] = (sload[st] ?? 0) + 1 }
          continue
        }
        ids.forEach((e, j) => {
          if (a.start && !startPool.has(e)) return
          const c = cost[k][j]
          if (!isFinite(c)) return
          const st = this.stairOf(a, e)
          let s = c / 1.3 + (load[e] ?? 0) / flow[e] + (st ? (sload[st] ?? 0) / (this.stairFlow[st] ?? 1.15) : 0)
          if (!initial && a.exit === e) s -= 6
          if (s < bs) { bs = s; best = e }
        })
        choice[k] = best
        if (best) { load[best] = (load[best] ?? 0) + 1; const st = this.stairOf(a, best); if (st) sload[st] = (sload[st] ?? 0) + 1 }
      }
      const startUse: Record<string, number> = {}
      live.forEach((a, k) => { if (a.start && choice[k]) startUse[choice[k]!] = (startUse[choice[k]!] ?? 0) + 1 })
      const used = Object.keys(startUse)
      if (used.length <= 3) break
      const smallest = used.sort((p, q) => startUse[p] - startUse[q])[0]
      startPool = new Set([...startPool].filter(e => e !== smallest))
    }
    // group letters: largest first on the first split, then stable
    if (initial) {
      this.groups = []; this.groupOf = {}
      const tally: Record<string, number> = {}
      for (const c of choice) if (c) tally[c] = (tally[c] ?? 0) + 1
      for (const e of Object.keys(tally).sort((p, q) => tally[q] - tally[p])) this.ensureGroup(e)
    }
    let changed = 0, trapped = 0
    live.forEach((a, k) => {
      const c = choice[k]
      if (!c) { if (a.mode !== 'rail') { this.trap(a); trapped++ } return }
      if (!initial && c !== a.exit) changed++
      a.exit = c; a.group = this.ensureGroup(c)
    })
    return { changed, trapped }
  }

  private trap(a: Agent) {
    a.mode = 'trapped'; a.pre = []; a.rail = null
    if (a.wc && !a.injured && a.assistAt === Infinity) a.assistAt = this.t + ASSIST_DELAY
  }

  /** The alarm sounds: everyone reacts after their own short delay. */
  raiseAlarm() {
    if (this.alarm) return
    this.alarm = true
    for (const a of this.agents) a.react += this.t
  }
  /** Everyone still inside starts walking to their group's exit, staggered so doors are not hit all at once. */
  go() {
    this.evacuating = true
    for (const a of this.agents) if (!a.out && a.mode !== 'trapped') a.goT = this.t + (a.start ? 0.15 + this.rnd() * 1.8 : 0.3 + this.rnd() * 2.6)
  }
  /** Debris lands: people under it cannot walk out on their own. */
  crush(level: number, x: number, z: number, r: number) {
    let n = 0
    for (const a of this.agents) if (!a.out && Math.abs(a.lf - level) < 0.3 && Math.hypot(a.x - x, a.z - z) < r) { a.injured = true; this.trap(a); n++ }
    return n
  }
  /** People with no route earlier get another chance when the world changes (an exit reopened). */
  private retryTrapped() {
    for (const a of this.agents) if (a.mode === 'trapped' && !a.injured && !a.out) { a.mode = 'mill'; a.goT = this.t; a.millT = 0 }
  }

  private reassignOne(a: Agent, from: number) {
    let best: string | null = null, bc = Infinity
    for (const e of this.exits) {
      const d = this.dOf(a, e.id)[from]
      if (!isFinite(d)) continue
      let load = 0
      for (const o of this.agents) if (!o.out && o.exit === e.id) load++
      const c = d / 1.3 + load / e.flow
      if (c < bc) { bc = c; best = e.id }
    }
    if (!best) return false
    a.exit = best; a.group = this.ensureGroup(best)
    return true
  }

  // ---------- movement ----------
  private startWalk(a: Agent): void {
    const D = this.dOf(a, a.exit)
    let s = -1, bc = Infinity
    for (const k of this.startNodes(a)) {
      const n = this.nav.nodes[k], c = Math.hypot(n.x - a.x, n.z - a.z) + D[k]
      if (c < bc) { bc = c; s = k }
    }
    if (!isFinite(bc)) {
      if (this.reassignOne(a, this.startNodes(a)[0])) return this.startWalk(a)
      this.trap(a); this.emit(a.wc ? { kind: 'warn', text: `Wheelchair user in ${this.roomLabel(a.room)}: no step-free route, waiting for staff to carry them down` } : { kind: 'danger', text: `Person trapped in ${this.roomLabel(a.room)}: no safe route` }); return
    }
    const n = this.nav.nodes[s]
    // line up with the door first (along the door wall's normal), then walk to it
    a.pre = !this.inners[a.room] || n.kind !== 'inner' ? []
      : n.axis === 'x' ? (Math.abs(a.x - n.x) > 0.3 ? [[n.x, a.z]] : []) : (Math.abs(a.z - n.z) > 0.3 ? [[a.x, n.z]] : [])
    a.node = s; a.prev = s; a.mode = 'walk'; a.stuckT = 0; a.lastD = 1e9; a.legT = 0
    // a drawn wall between the seat and the door: walk round it
    const W = this.nav.walk[a.level], t = a.pre[0] ?? [n.x, n.z]
    if (W.wall && !this.visible(a.level, a.x, a.z, t[0], t[1])) {
      const p = W.path(a.x, a.z, n.x, n.z)
      if (p) a.pre = p.slice(0, -1)
    }
  }

  /** Stuck behind a drawn wall: a way round it to the current target, if there is one nearby. */
  private detour(a: Agent) {
    const W = this.nav.walk[a.level]
    if (!W.wall || a.node < 0) return false
    const n = this.nav.nodes[a.node]
    if (Math.abs(n.level - a.level) > 0.01) return false
    const p = W.path(a.x, a.z, n.x, n.z, 12)
    if (!p) return false
    a.pre = p.slice(0, -1)
    return true
  }

  roomLabel(id: string) { return this.plan.rooms.find(r => r.id === id)?.label ?? 'the lobby' }

  private decide(a: Agent, n: number, depth = 0): void {
    const node = this.nav.nodes[n]
    if (node.kind === 'exit') {
      const e = this.exitById[node.exit!]
      a.mode = 'outside'; a.out = true; a.tOut = this.t; a.target = e.out; a.rail = null
      this.outBy[e.id]++
      const k = this.outAsm[e.asm]++
      const ring = Math.floor(Math.sqrt(k / 3)), ang = k * 2.39996
      a.slot = [e.assembly[0] + Math.cos(ang) * (0.9 + ring * 0.85), e.assembly[1] + Math.sin(ang) * (0.9 + ring * 0.85)]
      return
    }
    const D = this.dOf(a, a.exit)
    let best = -1, bc = Infinity, rail = false, len = 0
    for (const e of this.nav.adj[n]) {
      if (this.blocked[e.to]) continue
      const c = e.len * (e.rail ? 1.25 : 1) + D[e.to]
      if (c < bc) { bc = c; best = e.to; rail = e.rail; len = e.len }
    }
    if (!isFinite(bc) && node.stair && this.stairBlocked[node.stair]) {
      // already on a stair that was just closed: keep going to the next landing
      for (const e of this.nav.adj[n]) if (e.to !== a.prev && this.nav.nodes[e.to].stair === node.stair) { bc = 0; best = e.to; rail = e.rail; len = e.len; break }
    }
    if (!isFinite(bc)) {
      if (depth < 2 && this.reassignOne(a, n) && a.exit !== undefined) return this.decide(a, n, depth + 1)
      this.trap(a); this.emit({ kind: a.wc ? 'warn' : 'danger', text: `${a.wc ? 'Wheelchair user' : 'Person'} cut off near ${node.room ? this.roomLabel(node.room) : 'a corridor'}` }); return
    }
    a.prev = n; a.node = best; a.legT = 0
    if (rail) { a.mode = 'rail'; a.rail = { a: n, b: best, t: 0, len: Math.hypot(this.nav.nodes[best].x - node.x, this.nav.nodes[best].z - node.z) || len } }
    else if (a.mode === 'rail') {
      a.mode = 'walk'; a.rail = null; a.level = Math.round(node.level); a.lf = a.level
      ;[a.x, a.z] = this.nav.walk[a.level].clamp(a.x, a.z)
    }
    if (a.mode === 'walk') this.routeLeg(a, n, best)
  }

  /** On a storey with traced walls, a leg whose end is out of sight bends round the walls: the link's precomputed
   * corners (or a fresh way round), skipping corners already passed. */
  private routeLeg(a: Agent, from: number, to: number) {
    a.pre = []
    const W = this.nav.walk[a.level], M = this.nav.nodes[to]
    if (!W.wall || Math.abs(M.level - a.level) > 0.01 || this.visible(a.level, a.x, a.z, M.x, M.z)) return
    const via = this.nav.via?.get(from * this.nav.nodes.length + to) ?? W.path(a.x, a.z, M.x, M.z)
    if (!via) return
    const pre = via.slice(0, -1)
    while (pre.length > 1 && this.visible(a.level, a.x, a.z, pre[1][0], pre[1][1])) pre.shift()
    a.pre = pre
  }

  hazardsUpdate(dt: number) {
    let changed = false
    for (const h of this.hazards) {
      if (h.kind !== 'fire' || h.r >= h.rMax) continue
      const before = Math.floor(h.r / 0.5)
      h.r = Math.min(h.rMax, h.r + h.grow * dt)
      if (Math.floor(h.r / 0.5) !== before) changed = true
    }
    return changed
  }

  /** Re-plan after the world changed. Returns how many people switched exit. */
  replan() {
    this.recompute()
    // anyone heading into a blocked node turns back
    for (const a of this.agents) {
      if (a.mode === 'walk' && a.node >= 0 && this.blocked[a.node] && !a.pre.length) { if (!this.blocked[a.prev]) a.node = a.prev }
      if (a.mode === 'rail' && a.rail && this.blocked[a.rail.b] && !this.blocked[a.rail.a]) {
        const r = a.rail; a.rail = { a: r.b, b: r.a, t: r.len - r.t, len: r.len }; a.node = r.a
      }
    }
    if (!this.evacuating) return { changed: 0, trapped: 0 }
    this.retryTrapped()
    return this.assign(false)
  }

  step(dt: number) {
    this.t += dt
    const grid = this.grid, rails = this.rails
    grid.clear(); rails.clear()
    for (const a of this.agents) {
      if (a.mode === 'rail' && a.rail) { const k = `${a.rail.a}-${a.rail.b}`; let l = rails.get(k); if (!l) rails.set(k, l = []); l.push(a); continue }
      if (a.mode === 'assembled' || a.mode === 'trapped' && a.injured) continue
      const key = ((a.out ? OUT_LEVEL : a.level) * 4096 + Math.floor(a.x + this.gx)) * 4096 + Math.floor(a.z + this.gz)
      let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(a)
    }
    for (const a of this.agents) {
      if (a.mode === 'trapped' && a.wc && !a.injured && !a.out && this.t >= a.assistAt) {
        a.wc = false; a.assistAt = Infinity; a.speed = 0.5; a.mode = 'mill'; a.goT = this.t; a.millT = 0
        this.assistNow = true
      }
    }
    if (this.assistNow) {
      this.assistNow = false
      this.recompute(); this.assign(false)
      this.emit({ kind: 'good', text: 'Staff are carrying wheelchair users down the stairs' })
    }
    for (const a of this.agents) this.agentStep(a, dt)
  }

  private neighbours(a: Agent, cb: (o: Agent) => void) {
    const lv = a.out ? OUT_LEVEL : a.level, cx = Math.floor(a.x + this.gx), cz = Math.floor(a.z + this.gz)
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = this.grid.get((lv * 4096 + cx + i) * 4096 + cz + j)
      if (l) for (const o of l) if (o !== a) cb(o)
    }
  }

  private agentStep(a: Agent, dt: number) {
    const r = this.rnd
    a.danger = Math.max(0, a.danger - dt * 0.5)
    for (const h of this.hazards) if (h.kind === 'fire' && !a.out && Math.abs(a.lf - h.level) < 0.3 && Math.hypot(a.x - h.x, a.z - h.z) < h.r + 2.2) a.danger = 1
    const crouchT = this.quake && a.mode !== 'assembled' && !a.injured ? 1 : 0
    a.crouch += (crouchT - a.crouch) * Math.min(1, dt * 5)
    if (this.quake) { a.vx *= 0.8; a.vz *= 0.8; a.move *= 0.9; return }

    switch (a.mode) {
      case 'seated': case 'idle': {
        a.move *= 0.9
        if (this.alarm && this.t > a.react) { a.mode = 'mill'; a.millT = 0; a.mx = a.x; a.mz = a.z }
        if (a.mode === 'seated') a.sit = Math.min(1, a.sit + dt)
        return
      }
      case 'mill': {
        a.sit = Math.max(0, a.sit - dt * 1.6)
        if (a.sit > 0.15) return
        if (this.evacuating && this.t > a.goT) { this.startWalk(a); return }
        if (this.t > a.millT) {
          const [x, z] = this.nav.walk[a.level].clamp(a.x + (r() - 0.5) * 2.6, a.z + (r() - 0.5) * 2.6)
          a.mx = x; a.mz = z; a.millT = this.t + 0.7 + r() * 1.3
        }
        this.steer(a, a.mx, a.mz, 0.75, dt, true)
        return
      }
      case 'walk': {
        if (!a.pre.length && this.t > a.lookT) { a.lookT = this.t + 0.3 + r() * 0.1; if (this.lookAhead(a)) return }
        // a jam that has not moved for a long time: let this person squeeze through for a moment
        a.legT += dt
        if (a.legT > 20) { a.legT = 0; a.ghost = this.t + 2.5 }
        let tx: number, tz: number, arrive: number
        if (a.pre.length) { [tx, tz] = a.pre[0]; arrive = 0.32 }
        else { const n = this.nav.nodes[a.node]; tx = n.x; tz = n.z; arrive = ARRIVE[n.kind] ?? 0.5 }
        const d = Math.hypot(tx - a.x, tz - a.z)
        if (d < arrive) {
          if (!a.pre.length) { this.decide(a, a.node); return }
          // round a drawn wall: drop the corner only once the next leg is in sight
          const nx = a.pre[1] ?? [this.nav.nodes[a.node].x, this.nav.nodes[a.node].z]
          if (d < 0.08 || !this.nav.walk[a.level].wall || this.visible(a.level, a.x, a.z, nx[0], nx[1])) { a.pre.shift(); return }
        }
        if (d > a.lastD - 0.004) a.stuckT += dt; else a.stuckT = Math.max(0, a.stuckT - dt * 2)
        a.lastD = d
        if (a.stuckT > 2.5) {
          a.vx += (r() - 0.5) * 2; a.vz += (r() - 0.5) * 2; a.stuckT = 1.2
          const walled = !!this.nav.walk[a.level].wall && !this.visible(a.level, a.x, a.z, tx, tz)
          if (walled && this.detour(a)) a.lastD = 1e9
          else if (a.pre.length) a.pre.shift()
          else if (!this.visible(a.level, a.x, a.z, tx, tz)) this.recover(a)
        }
        this.steer(a, tx, tz, a.speed * (a.danger ? 1.35 : 1), dt, false)
        return
      }
      case 'rail': {
        const rl = a.rail!, A = this.nav.nodes[rl.a], B = this.nav.nodes[rl.b]
        let free = true
        const same = this.rails.get(`${rl.a}-${rl.b}`)
        if (same) for (const o of same) if (o !== a && o.rail && o.rail.a === rl.a && o.rail.t > rl.t && o.rail.t - rl.t < 0.62 && Math.abs(o.lane - a.lane) < 0.55) { free = false; break }
        const v = free ? a.speed * (a.chair ? 0.9 : 0.72) * (a.danger ? 1.25 : 1) : 0
        rl.t += v * dt
        a.move += ((free ? 0.85 : 0) - a.move) * Math.min(1, dt * 6)
        a.phase += v * dt * 5.2
        if (rl.t >= rl.len) { a.x = B.x; a.z = B.z; a.lf = B.level; this.decide(a, rl.b); return }
        const f = rl.t / rl.len, dx = (B.x - A.x) / rl.len, dz = (B.z - A.z) / rl.len
        const ln = a.chair ? 0 : a.lane   // wheelchairs ride the ramp down the middle of the flight
        const lane = B.level !== A.level ? ln : ln * 0.4
        a.x = A.x + (B.x - A.x) * f - dz * lane; a.z = A.z + (B.z - A.z) * f + dx * lane
        a.lf = A.level + (B.level - A.level) * f
        a.level = Math.floor(a.lf + 1e-6)
        a.yaw = turn(a.yaw, Math.atan2(dx, dz), dt * 8)
        return
      }
      case 'outside': {
        const tgt = a.target!
        const d = Math.hypot(tgt[0] - a.x, tgt[1] - a.z)
        if (d < 0.6) {
          if (a.slot && tgt !== a.slot) a.target = a.slot
          else { a.mode = 'assembled'; a.yaw = Math.atan2(-a.x, -a.z) }
          return
        }
        this.steer(a, tgt[0], tgt[1], a.speed, dt, false, true)
        return
      }
      case 'assembled': case 'trapped': {
        a.move *= 0.9; a.vx = 0; a.vz = 0
        a.sit = Math.max(0, a.sit - dt)
        return
      }
    }
  }

  /** The next node is already in plain sight: skip the current one (smooth corners, no walking back to a node
   * the crowd pushed you past). Never skips exits or stair entries. */
  private lookAhead(a: Agent) {
    const n = a.node, N = this.nav.nodes[n]
    if (n < 0 || N.kind === 'exit' || N.kind === 'stair' || N.rail) return false
    const D = this.dOf(a, a.exit)
    let best = -1, bc = Infinity, rail = false
    for (const e of this.nav.adj[n]) {
      if (this.blocked[e.to]) continue
      const c = e.len * (e.rail ? 1.25 : 1) + D[e.to]
      if (c < bc) { bc = c; best = e.to; rail = e.rail }
    }
    if (best < 0 || rail || !isFinite(bc)) return false
    const M = this.nav.nodes[best]
    if (M.kind === 'stair' || Math.abs(M.level - a.level) > 0.01) return false
    const dM = Math.hypot(M.x - a.x, M.z - a.z)
    if (dM + D[best] >= Math.hypot(N.x - a.x, N.z - a.z) + D[n] - 0.05) return false
    if (!this.visible(a.level, a.x, a.z, M.x, M.z)) return false
    this.decide(a, n)
    return true
  }

  /** Straight walk from one point to another stays inside the walkable area of the storey. */
  private visible(level: number, ax: number, az: number, bx: number, bz: number) {
    const W = this.nav.walk[level]
    if (W.wall) return W.clear(ax, az, bx, bz) // traced walls can be thin: check every cell on the way
    const k = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.3))
    for (let i = 1; i <= k; i++) if (!W.free(ax + ((bx - ax) * i) / k, az + ((bz - az) * i) / k)) return false
    return true
  }

  /** Pushed round a corner by the crowd and the target is now behind a wall: head for the best node in sight. */
  private recover(a: Agent) {
    const D = this.dOf(a, a.exit)
    let best = -1, bc = Infinity
    for (const reach of [9, Infinity]) { // nearby first; on long diagonal corridors the nearest node can be far
      for (const n of this.nav.nodes) {
        if (n.rail || n.kind === 'stair' || Math.abs(n.level - a.level) > 0.01 || this.blocked[n.i] || !isFinite(D[n.i])) continue
        const d = Math.hypot(n.x - a.x, n.z - a.z)
        if (d > reach || d + D[n.i] >= bc || !this.visible(a.level, a.x, a.z, n.x, n.z)) continue
        bc = d + D[n.i]; best = n.i
      }
      if (best >= 0) break
    }
    if (best < 0 || best === a.node) return false
    a.node = best; a.legT = 0
    return true
  }

  private steer(a: Agent, tx: number, tz: number, speed: number, dt: number, mill: boolean, outside = false) {
    const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz) || 1
    const ux = dx / d, uz = dz / d
    let sx = 0, sz = 0, slow = 1
    if (a.ghost < this.t) this.neighbours(a, o => {
      const ox = a.x - o.x, oz = a.z - o.z, dd = ox * ox + oz * oz
      if (dd > 1.44 || dd < 1e-8) return
      const dist = Math.sqrt(dd), ahead = -(ox * ux + oz * uz) / dist
      // someone walking at us: both keep to their right so counter-flows form lanes instead of a deadlock
      const oncoming = o.vx * ux + o.vz * uz < -0.2
      if (oncoming && ahead > 0.3) { const k = 0.6 * (1.2 - dist); sx -= uz * k; sz += ux * k }
      if (dd > 0.5) return
      const push = (0.71 - dist) / 0.71
      sx += (ox / dist) * push; sz += (oz / dist) * push
      if (ahead > 0.55 && dist < 0.64) slow = Math.min(slow, oncoming ? 0.45 : Math.max(0.04, (dist - 0.34) / 0.3))
    })
    const want = mill && d < 0.3 ? 0 : speed * slow
    const wx = ux * want + sx * 1.7, wz = uz * want + sz * 1.7
    const k = Math.min(1, dt * 7)
    a.vx += (wx - a.vx) * k; a.vz += (wz - a.vz) * k
    let nx = a.x + a.vx * dt, nz = a.z + a.vz * dt
    if (!outside) [nx, nz] = this.nav.walk[a.level].move(a.x, a.z, nx, nz)
    const moved = Math.hypot(nx - a.x, nz - a.z)
    a.x = nx; a.z = nz
    const sp = moved / Math.max(dt, 1e-4)
    a.move += (Math.min(1, sp / 1.3) - a.move) * Math.min(1, dt * 8)
    a.phase += sp * dt * 5.2
    if (sp > 0.15) a.yaw = turn(a.yaw, Math.atan2(a.vx, a.vz), dt * 9)
  }

  // ---------- read-outs ----------
  counts() {
    let out = 0, stairs = 0, trapped = 0, moving = 0
    for (const a of this.agents) {
      if (a.out) out++
      else if (a.mode === 'trapped') trapped++
      else if (a.mode === 'rail') stairs++
      if (a.mode === 'walk' || a.mode === 'rail' || a.mode === 'outside') moving++
    }
    return { total: this.agents.length, out, inside: this.agents.length - out, stairs, trapped, moving }
  }

  /** Route (graph nodes) one member of a group would take from the start room, for drawing. */
  routeFor(exit: string, room: string): number[] {
    const D = this.D[exit], inn = this.inners[room] ?? []
    let s = -1, bc = Infinity
    for (const k of inn) if (D[k] < bc) { bc = D[k]; s = k }
    if (s < 0) return []
    const path = [s]
    let n = s
    for (let k = 0; k < 600; k++) {
      if (this.nav.nodes[n].kind === 'exit') break
      let best = -1, b = Infinity
      for (const e of this.nav.adj[n]) { if (this.blocked[e.to]) continue; const c = e.len * (e.rail ? 1.25 : 1) + D[e.to]; if (c < b) { b = c; best = e.to } }
      if (best < 0 || !isFinite(b)) break
      path.push(best); n = best
    }
    return path
  }

  /** Inside any room rectangle or walkable area of a storey: used to place incidents. */
  insideBuilding(level: number, x: number, z: number) {
    return !!this.nav.walk[level]?.contains(x, z, R + WALL_T / 2)
  }
}

function turn(a: number, b: number, k: number) {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * Math.min(1, k)
}
