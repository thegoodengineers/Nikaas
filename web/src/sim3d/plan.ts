// One interface for every building the sim can run: the hand-made demo block (layout.ts) or any building
// graph (graph.ts). The crowd model, the engine, the labels and the minimap only read a Plan.
import {
  FH, LEVELS, LEVEL_NAMES, ROOMS, STAIRS, EXITS, CORRIDOR, LOBBY, FOOTPRINT, buildNav, inRect, rect,
  type Nav, type Rect,
} from './layout.ts'
import type { GraphGeo } from './graph.ts'

export type V3 = [number, number, number]
export type PlanRoom = { id: string; level: number; label: string; people: number; r: Rect }
export type PlanExit = {
  id: string; label: string; level: number; door: [number, number]; out: [number, number]
  assembly: [number, number]; assemblyLabel: string; asm: string; width: number; flow: number
}
export type PlanStair = {
  id: string; label: string; flow: number
  zones: { level: number; r: Rect }[]
  barriers: { level: number; at: [number, number]; axis: 'x' | 'z'; width: number; side: number }[]
}
export type Plan = {
  kind: 'demo' | 'graph'
  key: string; name: string; sub: string
  levels: number; levelNames: string[]; fh: number
  rooms: PlanRoom[]
  spawn: { id: string; level: number; people: number }[]
  exits: PlanExit[]; stairs: PlanStair[]
  nav: Nav
  startRooms: string[]; defaultStart: string
  bounds: Rect; site: Rect; footprint?: Rect
  mapBase: { level: number; poly: [number, number][] }[]
  placeName: (level: number, x: number, z: number) => string
  /** camera position and target for a room view; y values are added to the room's floor height */
  camFor: (room: string) => { pos: V3; tgt: V3 }
  views: (step: number) => { overview: [V3, V3]; top: [V3, V3]; assess: [V3, V3] }
  geo?: GraphGeo
}

export const rectPoly = (r: Rect): [number, number][] => [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]]

let demo: Plan | null = null
/** The detailed three-storey teaching block (the default when no site is given). */
export function demoPlan(): Plan {
  if (demo) return demo
  const barrierAt: Record<string, [number, number, number]> = { W: [-23, 2, -1], E: [23, -2, 1], C: [0, -5, 1] }
  const base = [FOOTPRINT, STAIRS[0].zone, STAIRS[2].zone]
  demo = {
    kind: 'demo', key: 'demo', name: 'Block C, teaching block', sub: `${LEVELS} storeys · ${EXITS.length} exits`,
    levels: LEVELS, levelNames: LEVEL_NAMES, fh: FH,
    rooms: ROOMS.map(r => ({ id: r.id, level: r.level, label: r.label, people: r.people, r: r.r })),
    spawn: [...ROOMS.map(r => ({ id: r.id, level: r.level, people: r.people })), { id: 'lobby', level: 0, people: 6 }],
    exits: EXITS.map(e => ({ id: e.id, label: e.label, level: 0, door: e.door, out: e.out, assembly: e.assembly, assemblyLabel: e.assemblyLabel, asm: e.id, width: e.width, flow: e.flow })),
    stairs: STAIRS.map(s => ({
      id: s.id, label: s.label, flow: 1.15,
      zones: [...Array(LEVELS).keys()].map(level => ({ level, r: s.zone })),
      barriers: [...Array(LEVELS).keys()].map(level => ({ level, at: [barrierAt[s.id][0], barrierAt[s.id][1]] as [number, number], axis: 'z' as const, width: 5.6, side: barrierAt[s.id][2] })),
    })),
    nav: buildNav(),
    startRooms: ['seminar', 'c1a', 'lab', 'library', 'cafe'], defaultStart: 'seminar',
    bounds: rect(-26, -12, 26, 12), site: rect(-48, -34, 48, 34), footprint: FOOTPRINT,
    mapBase: [...Array(LEVELS).keys()].flatMap(level => base.map(r => ({ level, poly: rectPoly(r) }))),
    placeName: (level, x, z) => {
      const r = ROOMS.find(r => r.level === level && inRect(r.r, x, z))
      if (r) return r.label
      if (level === 0 && inRect(LOBBY, x, z)) return 'Lobby'
      const s = STAIRS.find(s => inRect(s.zone, x, z))
      if (s) return s.label
      if (inRect(CORRIDOR, x, z)) return `${x < -6 ? 'West' : x > 6 ? 'East' : 'Central'} corridor`
      return 'the building'
    },
    camFor: id => {
      const r = ROOMS.find(x => x.id === id) ?? ROOMS[0]
      const cx = (r.r.x0 + r.r.x1) / 2, cz = (r.r.z0 + r.r.z1) / 2, side = r.side === 'S' ? 1 : -1
      return { pos: [cx + 9, 17, cz + side * 15], tgt: [cx, 0.5, cz] }
    },
    views: step => ({
      overview: [[36, 30 + step * 3, 58], [0, step, 0]],
      top: [[0.01, 95, 8], [0, 0, 0]],
      assess: [[34, 36 + FH * 2, 56], [0, FH * 1.2, 0]],
    }),
  }
  return demo
}
