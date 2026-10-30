// The drill building: a three-storey teaching block with three stairs and four exits.
// Plain data plus the walking graph. Units are metres; x runs west to east, z north to south.
import { Walk, rectBox } from './walk.ts'

export const FH = 3.6            // floor-to-floor height
export const SLAB = 0.3
export const WALL_H = FH - SLAB
export const WALL_T = 0.2
export const DOOR_W = 1.6
export const DOOR_H = 2.3
export const LEVELS = 3
export const LEVEL_NAMES = ['Ground', 'Floor 1', 'Floor 2']
export const R = 0.25            // body radius used for walls

export type Rect = { x0: number; z0: number; x1: number; z1: number }
export const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0, z0, x1, z1 })
export const inset = (r: Rect, d: number): Rect => rect(r.x0 + d, r.z0 + d, r.x1 - d, r.z1 - d)
export const inRect = (r: Rect, x: number, z: number) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1

export type Kind = 'seminar' | 'classroom' | 'lab' | 'office' | 'library' | 'staff' | 'cafeteria' | 'clinic'
  | 'meeting' | 'server' | 'store' | 'pantry' | 'service'
export type Room = { id: string; level: number; label: string; kind: Kind; r: Rect; doors: number[]; side: 'N' | 'S'; people: number }

const N = (x0: number, x1: number) => rect(x0, -12, x1, -2)
const S = (x0: number, x1: number) => rect(x0, 2, x1, 12)

export const ROOMS: Room[] = [
  { id: 'cafe', level: 0, label: 'Cafeteria', kind: 'cafeteria', r: N(-20, -3), doors: [-15, -7], side: 'N', people: 14 },
  { id: 'admin', level: 0, label: 'Admin Office', kind: 'office', r: N(5.5, 12), doors: [8.5], side: 'N', people: 5 },
  { id: 'service', level: 0, label: 'Service Exit', kind: 'service', r: N(12, 14.5), doors: [13.25], side: 'N', people: 0 },
  { id: 'store', level: 0, label: 'Store', kind: 'store', r: N(14.5, 20), doors: [17.5], side: 'N', people: 2 },
  { id: 'clinic', level: 0, label: 'Clinic', kind: 'clinic', r: S(-20, -7), doors: [-11], side: 'S', people: 4 },
  { id: 'reception', level: 0, label: 'Accounts', kind: 'office', r: S(7, 20), doors: [10.5], side: 'S', people: 6 },

  { id: 'c1a', level: 1, label: 'Classroom 1A', kind: 'classroom', r: N(-20, -3), doors: [-16, -6.5], side: 'N', people: 18 },
  { id: 'c1b', level: 1, label: 'Classroom 1B', kind: 'classroom', r: N(5.5, 20), doors: [8.5, 17], side: 'N', people: 16 },
  { id: 'library', level: 1, label: 'Library', kind: 'library', r: S(-20, -6), doors: [-15, -9], side: 'S', people: 8 },
  { id: 'staff', level: 1, label: 'Staff Room', kind: 'staff', r: S(-6, 6), doors: [0], side: 'S', people: 6 },
  { id: 'c1c', level: 1, label: 'Classroom 1C', kind: 'classroom', r: S(6, 20), doors: [9.5, 17], side: 'S', people: 14 },

  { id: 'lab', level: 2, label: 'Computer Lab', kind: 'lab', r: N(-20, -3), doors: [-16, -6.5], side: 'N', people: 12 },
  { id: 'server', level: 2, label: 'Server Room', kind: 'server', r: N(5.5, 12), doors: [8.5], side: 'N', people: 2 },
  { id: 'research', level: 2, label: 'Research Office', kind: 'office', r: N(12, 20), doors: [16], side: 'N', people: 5 },
  { id: 'office2', level: 2, label: 'Faculty Office', kind: 'office', r: S(-20, -14), doors: [-17], side: 'S', people: 3 },
  { id: 'seminar', level: 2, label: 'Seminar Hall', kind: 'seminar', r: S(-14, 8), doors: [-9, 4], side: 'S', people: 64 },
  { id: 'meet', level: 2, label: 'Meeting Room', kind: 'meeting', r: S(8, 14), doors: [11], side: 'S', people: 6 },
  { id: 'pantry', level: 2, label: 'Pantry', kind: 'pantry', r: S(14, 20), doors: [17], side: 'S', people: 2 },
]
export const LOBBY = rect(-7, 2, 7, 12)
export const CORRIDOR = rect(-20, -2, 20, 2)
export const FOOTPRINT = rect(-20, -12, 20, 12)

// Switchback stairs. A..D are the walking line: A at the lower landing, B/B2/C2/C on the half landing, D at the upper landing.
export type Flight = { x0: number; x1: number; zs: number; ze: number; ys: number; ye: number } // ys/ye in storeys
export type Stair = {
  id: 'W' | 'C' | 'E'; label: string; zone: Rect; landing: Rect; mid: Rect; flights: Flight[]
  pts: [number, number][]; door: [number, number]; doorAxis: 'x' | 'z'; doorW: number
}
export const STAIRS: Stair[] = [
  {
    id: 'W', label: 'West stair', zone: rect(-26, -2, -20, 10), landing: rect(-26, -2, -20, 2), mid: rect(-26, 8.5, -20, 10),
    flights: [{ x0: -26, x1: -23, zs: 2, ze: 8.5, ys: 0, ye: 0.5 }, { x0: -23, x1: -20, zs: 8.5, ze: 2, ys: 0.5, ye: 1 }],
    pts: [[-24.5, 2], [-24.5, 8.5], [-24.5, 9.25], [-21.5, 9.25], [-21.5, 8.5], [-21.5, 2]], door: [-20, 0], doorAxis: 'x', doorW: 2.4,
  },
  {
    id: 'C', label: 'Central stair', zone: rect(-3, -12, 3, -2), landing: rect(-3, -5, 3, -2), mid: rect(-3, -12, 3, -10.5),
    flights: [{ x0: -3, x1: 0, zs: -5, ze: -10.5, ys: 0, ye: 0.5 }, { x0: 0, x1: 3, zs: -10.5, ze: -5, ys: 0.5, ye: 1 }],
    pts: [[-1.5, -5], [-1.5, -10.5], [-1.5, -11.25], [1.5, -11.25], [1.5, -10.5], [1.5, -5]], door: [0, -2], doorAxis: 'z', doorW: 4.4,
  },
  {
    id: 'E', label: 'East stair', zone: rect(20, -10, 26, 2), landing: rect(20, -2, 26, 2), mid: rect(20, -10, 26, -8.5),
    flights: [{ x0: 23, x1: 26, zs: -2, ze: -8.5, ys: 0, ye: 0.5 }, { x0: 20, x1: 23, zs: -8.5, ze: -2, ys: 0.5, ye: 1 }],
    pts: [[24.5, -2], [24.5, -8.5], [24.5, -9.25], [21.5, -9.25], [21.5, -8.5], [21.5, -2]], door: [20, 0], doorAxis: 'x', doorW: 2.4,
  },
]

export type Exit = {
  id: string; label: string; door: [number, number]; inner: [number, number]; out: [number, number]
  assembly: [number, number]; assemblyLabel: string; width: number; flow: number; axis: 'x' | 'z'
}
export const EXITS: Exit[] = [
  { id: 'WEST', label: 'West Exit', door: [-26, 0], inner: [-24.6, 0], out: [-29, 0], assembly: [-43, 7], assemblyLabel: 'Assembly 1 · West Lot', width: 1.8, flow: 1.4, axis: 'x' },
  { id: 'MAIN', label: 'Main Entrance', door: [0, 12], inner: [0, 10.6], out: [0, 15], assembly: [0, 31], assemblyLabel: 'Assembly 2 · South Lawn', width: 3.2, flow: 2.4, axis: 'z' },
  { id: 'EAST', label: 'East Exit', door: [26, 0], inner: [24.6, 0], out: [29, 0], assembly: [43, -7], assemblyLabel: 'Assembly 3 · East Court', width: 1.8, flow: 1.4, axis: 'x' },
  { id: 'NORTH', label: 'Service Exit', door: [13.25, -12], inner: [13.25, -10.6], out: [13.25, -15], assembly: [14, -31], assemblyLabel: 'Assembly 4 · North Yard', width: 1.6, flow: 1.2, axis: 'z' },
]

// ---------- walking graph ----------
export type NavNode = {
  i: number; level: number; x: number; z: number
  kind: 'corr' | 'door' | 'inner' | 'landing' | 'stair' | 'lobby' | 'exit' | 'room'
  room?: string; stair?: string; exit?: string; rail?: boolean
  axis?: 'x' | 'z'   // inner nodes: axis of the door wall's normal (people line up on it before the door)
}
export type NavEdge = { a: number; b: number; len: number; rail: boolean }
export type Nav = { nodes: NavNode[]; edges: NavEdge[]; adj: { to: number; len: number; rail: boolean }[][]; walk: Walk[] }

export function buildNav(): Nav {
  const nodes: NavNode[] = [], edges: NavEdge[] = []
  const add = (n: Omit<NavNode, 'i'>) => { const k = nodes.length; nodes.push({ ...n, i: k }); return k }
  const link = (a: number, b: number, rail = false) => {
    const A = nodes[a], B = nodes[b]
    edges.push({ a, b, len: Math.hypot(A.x - B.x, A.z - B.z) + Math.abs(A.level - B.level) * 2.5, rail })
  }
  const walk: Rect[][] = []
  const landingNode: Record<string, number> = {}

  for (let L = 0; L < LEVELS; L++) {
    const W: Rect[] = [inset(CORRIDOR, R + WALL_T / 2)]
    walk.push(W)
    const rooms = ROOMS.filter(r => r.level === L)
    const xs = new Set<number>([-19.2, 0, 19.2])
    for (const r of rooms) for (const d of r.doors) xs.add(d)
    if (L === 0) { xs.add(-4); xs.add(4) }
    const sorted = [...xs].sort((a, b) => a - b)
    const corr: Record<number, number> = {}
    let prev = -1
    for (const x of sorted) {
      const k = add({ level: L, x, z: 0, kind: 'corr' }); corr[x] = k
      if (prev >= 0) link(prev, k)
      prev = k
    }
    for (const r of rooms) {
      W.push(inset(r.r, R + WALL_T / 2))
      const wz = r.side === 'N' ? -2 : 2, sgn = r.side === 'N' ? -1 : 1
      const inners: number[] = []
      for (const d of r.doors) {
        const door = add({ level: L, x: d, z: wz, kind: 'door', room: r.id })
        const inner = add({ level: L, x: d, z: wz + sgn * 1.0, kind: 'inner', room: r.id, axis: 'z' })
        link(corr[d], door); link(door, inner); inners.push(inner)
        W.push(rect(d - DOOR_W / 2 + R, wz - 0.6, d + DOOR_W / 2 - R, wz + 0.6))
      }
      for (let a = 0; a < inners.length; a++) for (let b = a + 1; b < inners.length; b++) link(inners[a], inners[b])
      if (r.id === 'service') {
        const mid = add({ level: 0, x: 13.25, z: -7, kind: 'room', room: r.id })
        link(inners[0], mid)
        const e = EXITS.find(x => x.id === 'NORTH')!
        const inn = add({ level: 0, x: e.inner[0], z: e.inner[1], kind: 'room', room: r.id })
        const ex = add({ level: 0, x: e.door[0], z: e.door[1], kind: 'exit', exit: e.id })
        link(mid, inn); link(inn, ex)
        W.push(rect(e.door[0] - e.width / 2 + R, -12.6, e.door[0] + e.width / 2 - R, -11.4))
      }
    }
    // stair landings and their doors
    for (const s of STAIRS) {
      W.push(inset(s.landing, R + WALL_T / 2))
      const lx = (s.landing.x0 + s.landing.x1) / 2, lz = (s.landing.z0 + s.landing.z1) / 2
      const land = add({ level: L, x: lx, z: lz, kind: 'landing', stair: s.id })
      landingNode[`${s.id}${L}`] = land
      const door = add({ level: L, x: s.door[0], z: s.door[1], kind: 'door', stair: s.id })
      const hw = s.doorW / 2 - R
      W.push(s.doorAxis === 'x' ? rect(s.door[0] - 0.6, s.door[1] - hw, s.door[0] + 0.6, s.door[1] + hw) : rect(s.door[0] - hw, s.door[1] - 0.6, s.door[0] + hw, s.door[1] + 0.6))
      const cx = s.id === 'W' ? -19.2 : s.id === 'E' ? 19.2 : 0
      link(corr[cx], door); link(door, land)
    }
    if (L === 0) {
      W.push(rect(LOBBY.x0 + R + 0.1, 1.0, LOBBY.x1 - R - 0.1, LOBBY.z1 - R - 0.1))
      const lob = [-4, 0, 4].map(x => add({ level: 0, x, z: 6.5, kind: 'lobby' }))
      link(corr[-4], lob[0]); link(corr[0], lob[1]); link(corr[4], lob[2]); link(lob[0], lob[1]); link(lob[1], lob[2])
      const main = EXITS.find(x => x.id === 'MAIN')!
      const inn = add({ level: 0, x: main.inner[0], z: main.inner[1], kind: 'lobby' })
      for (const l of lob) link(l, inn)
      const ex = add({ level: 0, x: main.door[0], z: main.door[1], kind: 'exit', exit: 'MAIN' })
      link(inn, ex)
      W.push(rect(-main.width / 2 + R, 11.3, main.width / 2 - R, 12.7))
      for (const id of ['WEST', 'EAST']) {
        const e = EXITS.find(x => x.id === id)!
        const land = landingNode[(id === 'WEST' ? 'W' : 'E') + '0']
        const inn2 = add({ level: 0, x: e.inner[0], z: e.inner[1], kind: 'landing' })
        const ex2 = add({ level: 0, x: e.door[0], z: e.door[1], kind: 'exit', exit: id })
        link(land, inn2); link(inn2, ex2)
        W.push(rect(e.door[0] - 0.7, -e.width / 2 + R, e.door[0] + 0.7, e.width / 2 - R))
      }
    }
  }
  // stair flights between storeys
  for (const s of STAIRS) for (let L = 0; L < LEVELS - 1; L++) {
    const lv = [L, L + 0.5, L + 0.5, L + 0.5, L + 0.5, L + 1]
    const ids = s.pts.map(([x, z], k) => add({ level: lv[k], x, z, kind: 'stair', stair: s.id, rail: k > 0 && k < 5 }))
    link(landingNode[`${s.id}${L}`], ids[0])
    for (let k = 1; k < ids.length; k++) link(ids[k - 1], ids[k], true)
    link(ids[5], landingNode[`${s.id}${L + 1}`])
  }
  const adj: Nav['adj'] = nodes.map(() => [])
  for (const e of edges) { adj[e.a].push({ to: e.b, len: e.len, rail: e.rail }); adj[e.b].push({ to: e.a, len: e.len, rail: e.rail }) }
  return { nodes, edges, adj, walk: walk.map(W => new Walk(W.map(r => rectBox(r.x0, r.z0, r.x1, r.z1)))) }
}
