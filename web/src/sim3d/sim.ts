// Crowd evacuation model: distance-to-exit fields on the walking graph, a load-balanced split of the
// crowd across exits (and stairs), local collision avoidance, stair queues and live re-routing.
import { buildNav, clampWalk, EXITS, ROOMS, inset, R, WALL_T, type Nav } from './layout.ts'
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
}
export type Hazard = { id: number; kind: 'fire' | 'collapse'; level: number; x: number; z: number; r: number; rMax: number; grow: number; label: string; t0: number }
export type SimEvent = { kind: 'info' | 'warn' | 'danger' | 'good'; text: string }
export type Group = { exit: string; letter: string; color: [number, number, number]; css: string }

export const GROUP_COLORS: [string, [number, number, number]][] = [
  ['#22d3ee', [0.13, 0.83, 0.93]], ['#fbbf24', [0.98, 0.75, 0.14]], ['#e879f9', [0.91, 0.47, 0.98]], ['#a3e635', [0.64, 0.9, 0.21]],
]
const ARRIVE: Record<string, number> = { corr: 0.85, lobby: 1.0, landing: 0.8, door: 0.42, inner: 0.45, stair: 0.5, exit: 0.45, room: 0.6 }
const STAIR_FLOW = 1.15

export class Sim {
  nav: Nav = buildNav()
  agents: Agent[] = []
  D: Record<string, Float64Array> = {}
  blocked: Uint8Array
  pen: Float32Array
  hazards: Hazard[] = []
  stairBlocked: Record<string, boolean> = { W: false, C: false, E: false }
  exitClosed: Record<string, boolean> = {}
  groups: Group[] = []
  groupOf: Record<string, number> = {}
  outBy: Record<string, number> = {}
  exitNode: Record<string, number> = {}
  inners: Record<string, number[]> = {}
  t = 0
  evacuating = false
  quake = false
  alarm = false
  startRoom: string
  private rnd: () => number
  private emit: (e: SimEvent) => void
  private grid = new Map<number, Agent[]>()
  private rails = new Map<string, Agent[]>()
  private stairCache = new Map<string, string | null>()
  private nextHazard = 1

  constructor(seats: Seat[], startRoom: string, rnd: () => number, emit: (e: SimEvent) => void) {
    this.startRoom = startRoom; this.rnd = rnd; this.emit = emit
    const n = this.nav.nodes.length
    this.blocked = new Uint8Array(n); this.pen = new Float32Array(n)
    for (const node of this.nav.nodes) {
      if (node.kind === 'exit') this.exitNode[node.exit!] = node.i
      if (node.kind === 'inner') (this.inners[node.room!] ??= []).push(node.i)
    }
    for (const e of EXITS) { this.outBy[e.id] = 0; this.exitClosed[e.id] = false }
    const rooms = [...ROOMS.map(r => ({ id: r.id, level: r.level, people: r.people })), { id: 'lobby', level: 0, people: 6 }]
    for (const room of rooms) {
      const list = seats.filter(s => s.room === room.id)
      const stand = list.filter(s => !s.sit), sit = list.filter(s => s.sit)
      for (let k = sit.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [sit[k], sit[j]] = [sit[j], sit[k]] }
      const chosen = [...stand, ...sit].slice(0, room.people)
      for (const s of chosen) this.spawn(s, room.id === startRoom)
    }
    this.recompute()
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
      phase: r() * 6, move: 0, scale: 0.9 + r() * 0.13,
    })
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
    for (const e of EXITS) this.D[e.id] = this.dijkstra(this.exitNode[e.id])
    this.stairCache.clear()
  }

  private dijkstra(src: number) {
    const n = this.nav.nodes.length, dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n)
    if (this.blocked[src]) return dist
    dist[src] = 0
    for (;;) {
      let u = -1, best = Infinity
      for (let k = 0; k < n; k++) if (!done[k] && dist[k] < best) { best = dist[k]; u = k }
      if (u < 0) break
      done[u] = 1
      for (const e of this.nav.adj[u]) {
        if (this.blocked[e.to]) continue
        const c = best + e.len * (e.rail ? 1.25 : 1) + this.pen[e.to]
        if (c < dist[e.to]) dist[e.to] = c
      }
    }
    return dist
  }

  exitReachable(e: string) {
    if (this.blocked[this.exitNode[e]]) return false
    const D = this.D[e]
    return this.agents.some(a => !a.out && isFinite(this.costTo(a, e, D)))
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

  private costTo(a: Agent, e: string, D = this.D[e]) {
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
    if (a.level === 0 && a.mode !== 'rail') return null
    const D = this.D[e], from = a.mode === 'rail' && a.rail ? a.rail.b : a.node >= 0 && !a.pre.length ? a.node : this.startNodes(a)[0]
    const key = `${from}:${e}`
    if (this.stairCache.has(key)) return this.stairCache.get(key)!
    let n = from, found: string | null = null
    for (let k = 0; k < 80 && n >= 0; k++) {
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
    const ids = EXITS.map(e => e.id).filter(e => !this.blocked[this.exitNode[e]])
    const flow: Record<string, number> = Object.fromEntries(EXITS.map(e => [e.id, e.flow]))
    const cost = live.map(a => ids.map(e => this.costTo(a, e)))
    let startPool = new Set(ids)
    let choice: (string | null)[] = []
    for (let iter = 0; iter < 4; iter++) {
      const load: Record<string, number> = {}, sload: Record<string, number> = {}
      const order = live.map((_, k) => k).sort((p, q) => Math.min(...cost[p]) - Math.min(...cost[q]))
      choice = new Array(live.length).fill(null)
      for (const k of order) {
        const a = live[k]
        let best: string | null = null, bs = Infinity
        ids.forEach((e, j) => {
          if (a.start && !startPool.has(e)) return
          const c = cost[k][j]
          if (!isFinite(c)) return
          const st = this.stairOf(a, e)
          let s = c / 1.3 + (load[e] ?? 0) / flow[e] + (st ? (sload[st] ?? 0) / STAIR_FLOW : 0)
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
    for (const e of EXITS) {
      const d = this.D[e.id][from]
      if (!isFinite(d)) continue
      const c = d / 1.3 + this.agents.filter(o => !o.out && o.exit === e.id).length / e.flow
      if (c < bc) { bc = c; best = e.id }
    }
    if (!best) return false
    a.exit = best; a.group = this.ensureGroup(best)
    return true
  }

  // ---------- movement ----------
  private startWalk(a: Agent): void {
    const D = this.D[a.exit]
    let s = -1, bc = Infinity
    for (const k of this.startNodes(a)) {
      const n = this.nav.nodes[k], c = Math.hypot(n.x - a.x, n.z - a.z) + D[k]
      if (c < bc) { bc = c; s = k }
    }
    if (!isFinite(bc)) {
      if (this.reassignOne(a, this.startNodes(a)[0])) return this.startWalk(a)
      this.trap(a); this.emit({ kind: 'danger', text: `Person trapped in ${this.roomLabel(a.room)}: no safe route` }); return
    }
    const n = this.nav.nodes[s]
    a.pre = this.inners[a.room] ? (Math.abs(a.z - n.z) > 0.3 ? [[a.x, n.z]] : []) : []
    a.node = s; a.prev = s; a.mode = 'walk'; a.stuckT = 0; a.lastD = 1e9
  }

  roomLabel(id: string) { return ROOMS.find(r => r.id === id)?.label ?? 'the lobby' }

  private decide(a: Agent, n: number, depth = 0): void {
    const node = this.nav.nodes[n]
    if (node.kind === 'exit') {
      const e = EXITS.find(x => x.id === node.exit)!
      a.mode = 'outside'; a.out = true; a.tOut = this.t; a.target = e.out; a.rail = null
      const k = this.outBy[e.id]++
      const ring = Math.floor(Math.sqrt(k / 3)), ang = k * 2.39996
      a.slot = [e.assembly[0] + Math.cos(ang) * (0.9 + ring * 0.85), e.assembly[1] + Math.sin(ang) * (0.9 + ring * 0.85)]
      return
    }
    const D = this.D[a.exit]
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
      this.trap(a); this.emit({ kind: 'danger', text: `Person cut off near ${node.room ? this.roomLabel(node.room) : 'a corridor'}` }); return
    }
    a.prev = n; a.node = best
    if (rail) { a.mode = 'rail'; a.rail = { a: n, b: best, t: 0, len: Math.hypot(this.nav.nodes[best].x - node.x, this.nav.nodes[best].z - node.z) || len } }
    else if (a.mode === 'rail') {
      a.mode = 'walk'; a.rail = null; a.level = Math.round(node.level); a.lf = a.level
      ;[a.x, a.z] = clampWalk(this.nav.walk[a.level], a.x, a.z)
    }
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
      const key = ((a.out ? 9 : a.level) * 4096 + Math.floor(a.x + 64)) * 4096 + Math.floor(a.z + 64)
      let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(a)
    }
    for (const a of this.agents) this.agentStep(a, dt)
  }

  private neighbours(a: Agent, cb: (o: Agent) => void) {
    const lv = a.out ? 9 : a.level, cx = Math.floor(a.x + 64), cz = Math.floor(a.z + 64)
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
          const [x, z] = clampWalk(this.nav.walk[a.level], a.x + (r() - 0.5) * 2.6, a.z + (r() - 0.5) * 2.6)
          a.mx = x; a.mz = z; a.millT = this.t + 0.7 + r() * 1.3
        }
        this.steer(a, a.mx, a.mz, 0.75, dt, true)
        return
      }
      case 'walk': {
        let tx: number, tz: number, arrive: number
        if (a.pre.length) { [tx, tz] = a.pre[0]; arrive = 0.32 }
        else { const n = this.nav.nodes[a.node]; tx = n.x; tz = n.z; arrive = ARRIVE[n.kind] ?? 0.5 }
        const d = Math.hypot(tx - a.x, tz - a.z)
        if (d < arrive) { if (a.pre.length) a.pre.shift(); else this.decide(a, a.node); return }
        if (d > a.lastD - 0.004) a.stuckT += dt; else a.stuckT = Math.max(0, a.stuckT - dt * 2)
        a.lastD = d
        if (a.stuckT > 2.5) { a.vx += (r() - 0.5) * 2; a.vz += (r() - 0.5) * 2; a.stuckT = 1.2; if (a.pre.length) a.pre.shift() }
        this.steer(a, tx, tz, a.speed * (a.danger ? 1.35 : 1), dt, false)
        return
      }
      case 'rail': {
        const rl = a.rail!, A = this.nav.nodes[rl.a], B = this.nav.nodes[rl.b]
        let free = true
        const same = this.rails.get(`${rl.a}-${rl.b}`)
        if (same) for (const o of same) if (o !== a && o.rail && o.rail.a === rl.a && o.rail.t > rl.t && o.rail.t - rl.t < 0.62 && Math.abs(o.lane - a.lane) < 0.55) { free = false; break }
        const v = free ? a.speed * 0.72 * (a.danger ? 1.25 : 1) : 0
        rl.t += v * dt
        a.move += ((free ? 0.85 : 0) - a.move) * Math.min(1, dt * 6)
        a.phase += v * dt * 5.2
        if (rl.t >= rl.len) { a.x = B.x; a.z = B.z; a.lf = B.level; this.decide(a, rl.b); return }
        const f = rl.t / rl.len, dx = (B.x - A.x) / rl.len, dz = (B.z - A.z) / rl.len
        const lane = B.level !== A.level ? a.lane : a.lane * 0.4
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

  private steer(a: Agent, tx: number, tz: number, speed: number, dt: number, mill: boolean, outside = false) {
    const dx = tx - a.x, dz = tz - a.z, d = Math.hypot(dx, dz) || 1
    const ux = dx / d, uz = dz / d
    let sx = 0, sz = 0, slow = 1
    this.neighbours(a, o => {
      const ox = a.x - o.x, oz = a.z - o.z, dd = ox * ox + oz * oz
      if (dd > 0.5 || dd < 1e-8) return
      const dist = Math.sqrt(dd), push = (0.71 - dist) / 0.71
      sx += (ox / dist) * push; sz += (oz / dist) * push
      const ahead = -(ox * ux + oz * uz) / dist
      if (ahead > 0.55 && dist < 0.64) slow = Math.min(slow, Math.max(0.04, (dist - 0.34) / 0.3))
    })
    const want = mill && d < 0.3 ? 0 : speed * slow
    const wx = ux * want + sx * 1.7, wz = uz * want + sz * 1.7
    const k = Math.min(1, dt * 7)
    a.vx += (wx - a.vx) * k; a.vz += (wz - a.vz) * k
    let nx = a.x + a.vx * dt, nz = a.z + a.vz * dt
    if (!outside) [nx, nz] = clampWalk(this.nav.walk[a.level], nx, nz)
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
    for (let k = 0; k < 120; k++) {
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
    const pad = R + WALL_T / 2
    return this.nav.walk[level].some(r => { const q = inset(r, -pad); return x >= q.x0 && x <= q.x1 && z >= q.z0 && z <= q.z1 })
  }
}

function turn(a: number, b: number, k: number) {
  let d = b - a
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return a + d * Math.min(1, k)
}
