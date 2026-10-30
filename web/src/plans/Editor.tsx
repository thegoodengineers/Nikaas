// The plan editor: one floor at a time over its plan picture. Draw rooms, walkway points, exits and stair
// landings, connect them, set the scale, trace the walls from the picture and measure widths from them, link
// stairs between floors, check the building and save it as a site (with its plan pictures and walls).
// The building stores metres (+x east, +z south); lengths show in metres or feet.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, setControlKey, type Building, type BuildingNode, type Site } from '../platform/api.ts'
import { FloorTabs } from '../platform/PlanView.tsx'
import type { WallGrid } from '../platform/walls.ts'
import Checks from './Checks.tsx'
import { forVision, imageFile, isPdf, pdfPages } from './files.ts'
import Icon from './Icon.tsx'
import { LinksTable } from './ImportPlans.tsx'
import Inspector, { LenField, type Edit, type Sel } from './Inspector.tsx'
import Modal from './Modal.tsx'
import {
  bounds, cleanBuilding, defaultEdge, dist, edgeKind, floorId, floorName, floorsOf, isStair, keyOf, newGroup, newId, nodeMap, onFloor,
  patchEdge, patched, round1, round2, SINGLE, STAIR_LENGTH, type Doc, type Origin, type Underlay,
} from './model.ts'
import { emptyWalls, moveWalls, paintWalls, scaleWalls, storable, traceWalls, uploadJpeg, wallsPng } from './trace.ts'
import { fmtLen, fromU, numU, setUnits, useUnits } from './units.ts'
import { useHistory } from './useHistory.ts'
import { edgeFloor, edgeKey, measureEdge, perMin, snapFace, snapRooms, suggests, wallsOf, widthIssues, type Measure, type Walls } from './widths.ts'
import WidthsPanel from './WidthsPanel.tsx'

type Tool = 'select' | 'room' | 'corridor' | 'exit' | 'stair' | 'connect' | 'delete' | 'wall'
type P = { x: number; z: number }
type View = { x0: number; z0: number; s: number } // top-left corner in metres, pixels per metre
type Mode = { kind: 'scale'; pts: P[] } | { kind: 'measure'; edge: number; pts: P[] } | null
type Ask =
  | { kind: 'room'; x: number; z: number; w: number; d: number }
  | { kind: 'stair'; a: string; b: string }
  | { kind: 'scale'; measured: number }
  | { kind: 'save' }
  | { kind: 'deleteFloor' }
  | null
type Drag =
  | { kind: 'pan'; sx: number; sy: number; v: View; moved: boolean; clear: boolean }
  | { kind: 'node'; id: string; dx: number; dz: number; sx: number; sy: number; moved: boolean }
  | { kind: 'rect'; a: P; b: P }
  | { kind: 'brush'; pts: P[]; add: boolean }
  | null

const TOOLS: { id: Tool; label: string; key: string; icon: string; hint: string }[] = [
  { id: 'select', label: 'Select', key: 'V', icon: 'M5 3l14 8-6 2-2 6z', hint: 'Click to select, drag to move. Drag empty space to pan.' },
  { id: 'room', label: 'Room', key: 'R', icon: 'M4 5h16v14H4z', hint: 'Drag a rectangle over a room on the plan.' },
  { id: 'corridor', label: 'Walkway', key: 'C', icon: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 12h6m6 0h6', hint: 'Click along corridors. With a point selected, the new one is joined to it.' },
  { id: 'exit', label: 'Exit', key: 'E', icon: 'M10 4h9v16h-9M4 12h10m-3-3 3 3-3 3', hint: 'Click at each door to the outside.' },
  { id: 'stair', label: 'Stair', key: 'S', icon: 'M4 20h4v-4h4v-4h4V8h4', hint: 'Click where people step onto a staircase. Landings join floors.' },
  { id: 'connect', label: 'Connect', key: 'L', icon: 'M7 17 17 7M7 7h.01M17 17h.01', hint: 'Click two nodes to link them. For stairs, pick a landing, switch floor, pick the other.' },
  { id: 'delete', label: 'Delete', key: 'D', icon: 'M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13', hint: 'Click a node or a link to delete it.' },
  { id: 'wall', label: 'Walls', key: 'B', icon: 'M3 21c3 0 4-2 4-4a3 3 0 0 1 3-3l8-8a2 2 0 0 0-3-3l-8 8a3 3 0 0 1-3 3', hint: 'Paint walls the tracing missed. Hold Alt (or pick Erase in the Floor panel) to rub out walls.' },
]
const WALL_RGB: [number, number, number] = [194, 65, 12]

/** Snap both ends of a measuring line to the wall faces they are near (pointing into the opening). */
function snapPair(w: Walls | null, a: P, b: P): [P, P] {
  const d = dist(a, b)
  if (!w || d < 0.05) return [a, b]
  const dx = (b.x - a.x) / d, dz = (b.z - a.z) / d
  return [snapFace(w, a, dx, dz), snapFace(w, b, -dx, -dz)]
}

export default function Editor({ initial, origin: origin0, note, fresh, onClose }: { initial: Doc; origin: Origin; note?: ReactNode; fresh?: boolean; onClose: () => void }) {
  const h = useHistory<Doc>(initial)
  const { doc } = h
  const b = doc.building
  const floors = floorsOf(b)
  const [floor, setFloor] = useState<string>(floors[0]?.id ?? SINGLE)
  const fl = floors.length ? (floors.some(f => f.id === floor) ? floor : floors[0].id) : SINGLE
  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<Sel>(null)
  const [mode, setMode] = useState<Mode>(null)
  const [ask, setAsk] = useState<Ask>(null)
  const [from, setFrom] = useState<string | null>(null) // first node picked by Connect
  const [view, setView] = useState<View>({ x0: -5, z0: -5, s: 10 })
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [cursor, setCursor] = useState<P | null>(null)
  const [opacity, setOpacity] = useState(0.55)
  const [showWidths, setShowWidths] = useState(true)
  const [showBelow, setShowBelow] = useState(true)
  const [joinNew, setJoinNew] = useState(true)
  const [banner, setBanner] = useState<ReactNode>(note ?? null)
  const [toast, setToast] = useState('')
  const [origin, setOrigin] = useState(origin0)
  const [savedSite, setSavedSite] = useState<Site | null>(null)
  const [linking, setLinking] = useState(false)
  const [linkRes, setLinkRes] = useState<{ links: { from: string; to: string; group: string }[]; err?: string } | null>(null)
  const [tolerance, setTolerance] = useState(4)
  const svg = useRef<SVGSVGElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag>(null)
  const [rect, setRect] = useState<{ a: P; b: P } | null>(null)
  const fitted = useRef(false)
  const side = useRef<HTMLElement>(null)
  useEffect(() => { if (sel) side.current?.scrollTo({ top: 0, behavior: 'smooth' }) }, [sel])
  const space = useRef(false)
  const units = useUnits()
  const L = (m: number) => fmtLen(m, units)
  const [showWalls, setShowWalls] = useState(true)
  const [wallOpacity, setWallOpacity] = useState(0.75)
  const [sens, setSens] = useState(0.5)
  const [tracing, setTracing] = useState('')
  const [brush, setBrush] = useState({ add: true, size: 0.25 })
  const [stroke, setStroke] = useState<{ pts: P[]; add: boolean } | null>(null)
  const [measured, setMeasured] = useState<Record<string, Measure>>({})
  const [ignored, setIgnored] = useState<Set<string>>(new Set())
  const [showCap, setShowCap] = useState(true)

  const by = useMemo(() => nodeMap(b), [b])
  const floorOf = (id: string | undefined) => (floors.length ? (id ? floors.find(f => f.id === id)?.name ?? id : 'No floor') : '')
  const vis = b.nodes.filter(n => onFloor(b, n, fl))
  const visIds = new Set(vis.map(n => n.id))
  const under: Underlay | undefined = doc.underlays[fl]
  const grid: WallGrid | undefined = doc.walls?.[fl]
  const W = useMemo(() => wallsOf(grid), [grid])
  const wallImg = useMemo(() => (grid ? wallsPng(grid, WALL_RGB) : null), [grid])

  const flash = (t: string) => { setToast(t); setTimeout(() => setToast(x => (x === t ? '' : x)), 3500) }
  const { commit } = h
  const setB = useCallback((fn: (b: Building) => Building) => commit(d => ({ ...d, building: fn(d.building) })), [commit])
  const { checkpoint, dropCheckpoint, live } = h
  const edit: Edit = useMemo(() => ({
    begin: checkpoint, end: dropCheckpoint, commit: setB,
    change: fn => live(d => ({ ...d, building: fn(d.building) })),
  }), [checkpoint, dropCheckpoint, live, setB])

  // ---- view ----
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fit = useCallback(() => {
    if (!size.w || !size.h) return
    const box = bounds(b.nodes, under ? [under] : [])
    const pad = 32
    const s = Math.max(0.5, Math.min((size.w - pad * 2) / (box.x1 - box.x0), (size.h - pad * 2) / (box.z1 - box.z0)))
    setView({ s, x0: (box.x0 + box.x1) / 2 - size.w / s / 2, z0: (box.z0 + box.z1) / 2 - size.h / s / 2 })
  }, [b.nodes, under, size])
  useEffect(() => {
    if (fitted.current || !size.w) return
    fitted.current = true
    const t = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(t)
  }, [size, fit])
  const zoomAt = useCallback((k: number, px?: number, py?: number) => setView(v => {
    const cx = px ?? size.w / 2, cy = py ?? size.h / 2
    const s = Math.min(400, Math.max(0.3, v.s * k))
    const wx = v.x0 + cx / v.s, wz = v.z0 + cy / v.s
    return { s, x0: wx - cx / s, z0: wz - cy / s }
  }), [size])
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top)
      else setView(v => ({ ...v, x0: v.x0 + e.deltaX / v.s }))
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [zoomAt])
  const toWorld = (e: { clientX: number; clientY: number }): P => {
    const r = svg.current!.getBoundingClientRect()
    return { x: view.x0 + (e.clientX - r.left) / view.s, z: view.z0 + (e.clientY - r.top) / view.s }
  }
  const centerOn = (n: BuildingNode) => setView(v => ({ ...v, x0: n.x - size.w / v.s / 2, z0: n.z - size.h / v.s / 2 }))

  // ---- unsaved changes ----
  useEffect(() => {
    if (!h.dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    addEventListener('beforeunload', warn)
    return () => removeEventListener('beforeunload', warn)
  }, [h.dirty])
  const close = () => { if (!h.dirty || confirm('Leave the editor? Your changes are not saved.')) onClose() }

  // ---- editing ----
  const pick = (id: string) => {
    const n = by[id]
    if (!n) return
    if (floors.length && n.floor_id && n.floor_id !== fl) setFloor(n.floor_id)
    setSel({ kind: 'node', id })
    centerOn(n)
  }
  const addNode = (n: BuildingNode, joinTo?: string | null) => {
    setB(bb => {
      const out = { ...bb, nodes: [...bb.nodes, n] }
      const j = joinTo ? bb.nodes.find(x => x.id === joinTo) : null
      if (j && (j.floor_id ?? null) === (n.floor_id ?? null)) out.edges = [...bb.edges, { from: j.id, to: n.id, ...defaultEdge(j, n) }]
      return out
    })
    setSel({ kind: 'node', id: n.id })
  }
  const place = (t: 'corridor' | 'exit' | 'stair', p: P) => {
    const stem = t === 'corridor' ? 'c' : t === 'exit' ? 'exit' : 'stair'
    const id = newId(b, fl, stem)
    const n: BuildingNode = { id, type: t === 'exit' ? 'exit' : 'corridor', x: round1(p.x), z: round1(p.z) }
    if (floors.length) n.floor_id = fl
    if (t === 'exit') n.label = `Exit ${b.nodes.filter(x => x.type === 'exit').length + 1}`
    if (t === 'stair') { n.stair = true; n.label = `Stair ${b.nodes.filter(isStair).length + 1}${floors.length ? `, ${floorOf(fl)}` : ''}` }
    const prev = sel?.kind === 'node' && joinNew ? sel.id : null
    addNode(n, prev && by[prev]?.type !== 'room' ? prev : null)
  }
  const removeNode = (id: string) => {
    setB(bb => ({ ...bb, nodes: bb.nodes.filter(n => n.id !== id), edges: bb.edges.filter(e => e.from !== id && e.to !== id) }))
    setSel(null); if (from === id) setFrom(null)
  }
  const removeEdge = (i: number) => { setB(bb => ({ ...bb, edges: bb.edges.filter((_, k) => k !== i) })); setSel(null) }
  const connect = (a: string, c: string) => {
    if (a === c) return
    if (b.edges.some(e => (e.from === a && e.to === c) || (e.from === c && e.to === a))) { flash('These two are already linked.'); return }
    const A = by[a], C = by[c]
    const d = defaultEdge(A, C)
    if (d.kind === 'stair') { setAsk({ kind: 'stair', a, b: c }); return }
    setB(bb => ({ ...bb, edges: [...bb.edges, { from: a, to: c, ...d }] }))
    setSel({ kind: 'edge', i: b.edges.length })
  }
  const deleteSel = () => {
    if (sel?.kind === 'node') removeNode(sel.id)
    else if (sel?.kind === 'edge') removeEdge(sel.i)
  }

  // ---- pointer ----
  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (ask) return
    const p = toWorld(e)
    const target = (e.target as Element).closest('[data-node],[data-edge]')
    const nodeId = target?.getAttribute('data-node') ?? null
    const edgeAt = target?.getAttribute('data-edge')
    const edgeI = edgeAt != null ? Number(edgeAt) : null
    svg.current?.setPointerCapture(e.pointerId)
    if (e.button === 1 || (e.button === 0 && space.current)) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: view, moved: false, clear: false }
      return
    }
    if (e.button !== 0) return
    if (mode) {
      const pts = [...mode.pts, p]
      if (pts.length < 2) { setMode({ ...mode, pts }); return }
      const m = dist(pts[0], pts[1])
      if (m < 0.01) { setMode({ ...mode, pts: [] }); return }
      if (mode.kind === 'scale') { setMode({ ...mode, pts }); setAsk({ kind: 'scale', measured: m }) }
      else {
        const [a, c] = snapPair(W, pts[0], pts[1])
        const w = Math.max(0.1, round2(dist(a, c)))
        setB(bb => patchEdge(bb, mode.edge, { width: w }))
        setMode(null); flash(`Width set to ${L(w)}${W ? ' (ends snapped to the traced walls)' : ''}.`)
      }
      return
    }
    switch (tool) {
      case 'select':
        if (nodeId) {
          const n = by[nodeId]
          setSel({ kind: 'node', id: nodeId })
          h.checkpoint()
          drag.current = { kind: 'node', id: nodeId, dx: n.x - p.x, dz: n.z - p.z, sx: e.clientX, sy: e.clientY, moved: false }
        } else if (edgeI != null) setSel({ kind: 'edge', i: edgeI })
        else drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: view, moved: false, clear: true }
        break
      case 'room':
        drag.current = { kind: 'rect', a: p, b: p }
        setRect({ a: p, b: p })
        break
      case 'corridor': case 'exit': case 'stair':
        if (nodeId) setSel({ kind: 'node', id: nodeId })
        else place(tool, p)
        break
      case 'connect':
        if (!nodeId) { if (!from) flash('Click a node to start a link.'); break }
        if (!from) { setFrom(nodeId); setSel({ kind: 'node', id: nodeId }) }
        else if (from === nodeId) setFrom(null)
        else { connect(from, nodeId); setFrom(null) }
        break
      case 'delete':
        if (nodeId) removeNode(nodeId)
        else if (edgeI != null) removeEdge(edgeI)
        break
      case 'wall': {
        const add = brush.add !== e.altKey
        drag.current = { kind: 'brush', pts: [p], add }
        setStroke({ pts: [p], add })
        break
      }
    }
  }
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = toWorld(e)
    setCursor(p)
    const d = drag.current
    if (!d) return
    if (d.kind === 'pan') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
      setView({ ...d.v, x0: d.v.x0 - dx / d.v.s, z0: d.v.z0 - dy / d.v.s })
    } else if (d.kind === 'node') {
      if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 3) return
      d.moved = true
      const x = round1(p.x + d.dx), z = round1(p.z + d.dz), id = d.id
      h.live(doc => ({
        ...doc, building: {
          ...doc.building,
          nodes: doc.building.nodes.map(n => (n.id === id ? { ...n, x, z } : n)),
          // a moved node's links follow it: drop stored lengths so they are measured again (stairs keep theirs)
          edges: doc.building.edges.map(ed => ((ed.from === id || ed.to === id) && ed.length !== undefined && edgeKind(doc.building, ed) !== 'stair' ? patched(ed, { length: undefined }) : ed)),
        },
      }))
    } else if (d.kind === 'rect') {
      d.b = p
      setRect({ a: d.a, b: p })
    } else if (d.kind === 'brush') {
      const last = d.pts[d.pts.length - 1]
      if (dist(last, p) < brush.size / 3) return
      d.pts.push(p)
      setStroke({ pts: [...d.pts], add: d.add })
    }
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'pan' && !d.moved && d.clear) { setSel(null); setFrom(null) }
    if (d.kind === 'node' && !d.moved) h.dropCheckpoint()
    if (d.kind === 'rect') {
      setRect(null)
      const w = Math.abs(d.b.x - d.a.x), dd = Math.abs(d.b.z - d.a.z)
      if (w < 0.5 || dd < 0.5) { flash('Drag a larger rectangle to draw a room.'); return }
      setAsk({ kind: 'room', x: round1((d.a.x + d.b.x) / 2), z: round1((d.a.z + d.b.z) / 2), w: round1(w), d: round1(dd) })
    }
    if (d.kind === 'brush') {
      setStroke(null)
      const key = fl
      h.commit(dc => {
        const g = dc.walls?.[key] ?? (dc.underlays[key] ? emptyWalls(dc.underlays[key]) : emptyWalls(padded(bounds(dc.building.nodes.filter(n => onFloor(dc.building, n, key))))))
        const ng = paintWalls(g, d.pts, brush.size, d.add)
        return ng === dc.walls?.[key] ? dc : { ...dc, walls: { ...dc.walls, [key]: ng } }
      })
    }
  }

  // ---- keyboard ----
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  useEffect(() => {
    keyRef.current = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (ask || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return
      const k = e.key.toLowerCase()
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) h.redo(); else h.undo(); return }
      if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); h.redo(); return }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (k === 'escape') { setMode(null); setFrom(null); setRect(null); setStroke(null); drag.current = null; setSel(null); return }
      if (k === 'delete' || k === 'backspace') { if (sel) { e.preventDefault(); deleteSel() } return }
      if (k === 'f') { fit(); return }
      if (k === 'w') { setShowWidths(x => !x); return }
      if (k === ' ') { space.current = true; e.preventDefault(); return }
      const tl = TOOLS.find(x => x.key.toLowerCase() === k)
      if (tl) { setTool(tl.id); setFrom(null); setMode(null) }
    }
  })
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e)
    const up = (e: KeyboardEvent) => { if (e.key === ' ') space.current = false }
    addEventListener('keydown', down); addEventListener('keyup', up)
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up) }
  }, [])

  // ---- floors ----
  const sortedFloors = [...floors].sort((x, y) => x.elevation_m - y.elevation_m)
  const fIdx = sortedFloors.findIndex(f => f.id === fl)
  const below = fIdx > 0 ? sortedFloors[fIdx - 1] : null
  const curFloor = floors.find(f => f.id === fl)
  const setFloorField = (patch: Partial<{ name: string; elevation_m: number }>) =>
    edit.change(bb => ({ ...bb, floors: (bb.floors ?? []).map(f => (f.id === fl ? { ...f, ...patch } : f)) }))
  const addFloor = () => {
    let k = floors.length, id = floorId(k)
    while (floors.some(f => f.id === id)) id = floorId(++k)
    const top = sortedFloors[sortedFloors.length - 1]
    const elev = top ? round2(top.elevation_m + 3.5) : 0
    h.commit(d => {
      const bb = d.building
      if (bb.floors?.length) return { ...d, building: { ...bb, floors: [...bb.floors, { id, name: floorName(k), elevation_m: elev }] } }
      // a single-floor building gets floors: everything so far is the ground floor
      const under0 = d.underlays[SINGLE], walls0 = d.walls?.[SINGLE]
      const underlays = { ...d.underlays }, walls = { ...d.walls }
      delete underlays[SINGLE]; delete walls[SINGLE]
      if (under0) underlays.GF = under0
      if (walls0) walls.GF = walls0
      return {
        underlays, walls, building: {
          ...bb, floors: [{ id: 'GF', name: floorName(0), elevation_m: 0 }, { id: 'F1', name: floorName(1), elevation_m: 3.5 }],
          nodes: bb.nodes.map(n => ({ ...n, floor_id: 'GF' })),
        },
      }
    })
    setFloor(floors.length ? id : 'F1')
    setSel(null)
  }
  const deleteFloor = () => {
    h.commit(d => {
      const gone = new Set(d.building.nodes.filter(n => n.floor_id === fl).map(n => n.id))
      const underlays = { ...d.underlays }, walls = { ...d.walls }
      delete underlays[fl]; delete walls[fl]
      return {
        underlays, walls, building: {
          ...d.building, floors: (d.building.floors ?? []).filter(f => f.id !== fl),
          nodes: d.building.nodes.filter(n => !gone.has(n.id)), edges: d.building.edges.filter(e => !gone.has(e.from) && !gone.has(e.to)),
        },
      }
    })
    setFloor(sortedFloors.find(f => f.id !== fl)?.id ?? SINGLE); setSel(null)
  }
  const loadUnderlay = async (file: File) => {
    try {
      const img = isPdf(file) ? (await pdfPages(file))[0] : await imageFile(file)
      if (!img) return
      const box = bounds(vis)
      const w = vis.length ? Math.max(10, box.x1 - box.x0) : 40
      h.commit(d => ({ ...d, underlays: { ...d.underlays, [fl]: { src: img.src, x: vis.length ? box.x0 : 0, z: vis.length ? box.z0 : 0, w, h: w * img.height / img.width } } }))
      flash('Plan picture added. Use Set scale with a known length to line it up, then Trace walls.')
    } catch (e) {
      flash(`Could not open the picture: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  /** Move or resize the picture under this floor (to line it up with the drawing); keeps its proportions. Its walls follow. */
  const setUnder = (patch: Partial<Underlay>) => h.live(d => {
    const u = d.underlays[fl]
    if (!u) return d
    const nu = { ...u, ...patch }
    if (patch.w) nu.h = u.h * patch.w / u.w
    const g = d.walls?.[fl]
    return { ...d, underlays: { ...d.underlays, [fl]: nu }, ...(g ? { walls: { ...d.walls, [fl]: moveWalls(g, u, nu) } } : {}) }
  })

  // ---- walls and widths ----
  const traceFloor = async () => {
    const u = doc.underlays[fl]
    if (!u) return
    setTracing(fl)
    try {
      const r = await traceWalls(u.src, u, { sensitivity: sens })
      const key = fl
      h.commit(d => ({ ...d, walls: { ...d.walls, [key]: r.grid } }))
      flash(`Walls traced in ${(r.ms / 1000).toFixed(1)} s (${L(r.grid.res)} cells). Paint or erase with the Walls tool.`)
    } catch (e) {
      flash(`Could not trace: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setTracing('')
    }
  }
  const measureAll = useCallback((bb: Building, walls: Doc['walls']) => {
    const out: Record<string, Measure> = {}
    for (const e of bb.edges) {
      const g = walls?.[edgeFloor(bb, e)]
      if (g) out[edgeKey(e)] = measureEdge(bb, e, wallsOf(g))
    }
    setMeasured(out)
    return out
  }, [])
  const measureOne = (i: number) => {
    const e = b.edges[i]
    if (!e) return
    setMeasured(m => ({ ...m, [edgeKey(e)]: measureEdge(b, e, wallsOf(doc.walls?.[edgeFloor(b, e)])) }))
  }
  const acceptWidth = (i: number, w: number) => { setB(bb => patchEdge(bb, i, { width: w })); flash(`Width set to ${L(w)}.`) }
  const acceptHigh = () => {
    const take = (e: Building['edges'][number]) => { const m = measured[edgeKey(e)]; return m?.conf === 'high' && suggests(m, e.width) && !ignored.has(edgeKey(e)) ? m.width! : null }
    const n = b.edges.filter(e => take(e) !== null).length
    setB(bb => ({ ...bb, edges: bb.edges.map(e => { const w = take(e); return w === null ? e : { ...e, width: w } }) }))
    flash(`${n} widths taken from the walls. Ctrl+Z undoes them.`)
  }
  const toggleIgnore = (key: string) => setIgnored(s0 => { const s1 = new Set(s0); if (s1.has(key)) s1.delete(key); else s1.add(key); return s1 })
  const snapHere = () => {
    if (!W) return
    const { moved } = snapRooms(b.nodes, n => (keyOf(b, n) === fl ? W : null))
    if (moved) h.commit(d => ({ ...d, building: { ...d.building, nodes: snapRooms(d.building.nodes, n => (keyOf(d.building, n) === fl ? W : null)).nodes } }))
    flash(moved ? `${moved} rooms lined up with the walls. Ctrl+Z undoes it.` : 'Rooms already sit on the walls (or no wall within 0.5 m).')
  }
  const pickEdge = (i: number) => {
    const e = b.edges[i]
    const n = e && by[e.from]
    if (!n) return
    if (floors.length && n.floor_id && n.floor_id !== fl) setFloor(n.floor_id)
    setSel({ kind: 'edge', i })
    const o = by[e.to] ?? n
    setView(v => ({ ...v, x0: (n.x + o.x) / 2 - size.w / v.s / 2, z0: (n.z + o.z) / 2 - size.h / v.s / 2 }))
  }

  // after an import with pictures: trace every floor, line rooms up with the walls, measure every link
  const autoRan = useRef(false)
  const { commit: hCommit, live: hLive } = h
  useEffect(() => {
    if (!fresh || autoRan.current) return
    autoRan.current = true
    const keys = Object.keys(initial.underlays).filter(k => !initial.walls?.[k])
    if (!keys.length) return
    void (async () => {
      const grids: Record<string, WallGrid> = {}
      for (const k of keys) {
        setTracing(k)
        try { grids[k] = (await traceWalls(initial.underlays[k].src, initial.underlays[k], { sensitivity: 0.5 })).grid } catch { /* that floor stays untraced */ }
      }
      setTracing('')
      if (!Object.keys(grids).length) return
      hLive(d => ({ ...d, walls: { ...d.walls, ...grids } }))
      const bb = initial.building
      const r = snapRooms(bb.nodes, n => wallsOf(grids[keyOf(bb, n)]))
      if (r.moved) hCommit(d => ({ ...d, building: { ...d.building, nodes: snapRooms(d.building.nodes, n => wallsOf(grids[keyOf(d.building, n)])).nodes } }))
      const m = measureAll({ ...bb, nodes: r.nodes }, grids)
      const n = Object.values(m).filter(x => x.width).length
      setBanner(<>Walls traced from the plan picture{keys.length > 1 ? 's' : ''}{r.moved ? `; ${r.moved} rooms lined up with them (Ctrl+Z undoes it)` : ''}. {n} of {bb.edges.length} widths measured from the walls: review them under <b>Widths</b> before accepting.</>)
    })()
  }, [fresh, initial, hLive, hCommit, measureAll])

  // ---- scale ----
  const applyScale = (real: number, measured: number) => {
    const f = real / measured
    if (!Number.isFinite(f) || f <= 0) return
    h.commit(d => {
      const bb = d.building
      const mine = (n: BuildingNode) => (bb.floors?.length ? n.floor_id === fl : true)
      const ids = new Set(bb.nodes.filter(mine).map(n => n.id))
      const nodes = bb.nodes.map(n => (ids.has(n.id) ? { ...n, x: round2(n.x * f), z: round2(n.z * f), ...(n.type === 'room' ? { w: round2((n.w ?? 0) * f), d: round2((n.d ?? 0) * f) } : {}) } : n))
      const edges = bb.edges.map(e => (ids.has(e.from) && ids.has(e.to) && e.length !== undefined && e.kind !== 'stair' ? { ...e, length: round2(e.length * f) } : e))
      const u = d.underlays[fl], g = d.walls?.[fl]
      return {
        building: { ...bb, nodes, edges }, underlays: u ? { ...d.underlays, [fl]: { ...u, x: u.x * f, z: u.z * f, w: u.w * f, h: u.h * f } } : d.underlays,
        walls: g ? { ...d.walls, [fl]: scaleWalls(g, f) } : d.walls,
      }
    })
    setMode(null)
    setView(v => ({ s: v.s / f, x0: v.x0 * f, z0: v.z0 * f }))
    flash(`Scale set: ${floorOf(fl) || 'this plan'} was stretched ${f >= 1 ? '×' : '÷'}${(f >= 1 ? f : 1 / f).toFixed(3)}.`)
  }

  // ---- stairs ----
  const linkStairs = async () => {
    setLinking(true); setLinkRes(null)
    try {
      const r = await api.post<{ building: Building; links: { from: string; to: string; group: string }[] }>('/plans/link-floors', { building: cleanBuilding(b), tolerance_m: tolerance })
      if (r.links.length) setB(() => ({ ...r.building, name: b.name }))
      setLinkRes({ links: r.links })
    } catch (e) {
      setLinkRes({ links: [], err: e instanceof Error ? e.message : String(e) })
    } finally {
      setLinking(false)
    }
  }

  // ---- rendering helpers ----
  const px = (n: number) => n / view.s
  const landingFloors = (id: string) => {
    const out: { up: boolean; name: string }[] = []
    const me = floors.find(f => f.id === by[id]?.floor_id)
    for (const e of b.edges) {
      if (e.from !== id && e.to !== id) continue
      const o = by[e.from === id ? e.to : e.from]
      if (!o || o.floor_id === by[id]?.floor_id) continue
      const of = floors.find(f => f.id === o.floor_id)
      out.push({ up: (of?.elevation_m ?? 0) > (me?.elevation_m ?? 0), name: of?.id ?? '?' })
    }
    return out
  }
  const selNode = sel?.kind === 'node' ? sel.id : null
  const selEdge = sel?.kind === 'edge' ? sel.i : null
  const measuring = mode?.kind === 'measure'
  const toolHint = mode?.kind === 'scale'
    ? (mode.pts.length ? 'Now click the other end of the known length.' : 'Set scale: click one end of a length you know on the plan (a wall, a door, a dimension line).')
    : mode?.kind === 'measure' ? (mode.pts.length ? `Click the other side.${W ? ' Ends snap to the traced walls.' : ''}` : 'Measure width: click one side of the corridor or door on the plan, then the other.')
      : from ? `Linking from ${by[from]?.label ?? from}: click the other node${floors.length > 1 ? ' (switch floors for a stair)' : ''}. Esc cancels.`
        : TOOLS.find(t => t.id === tool)!.hint
  const counts = { rooms: b.nodes.filter(n => n.type === 'room').length, exits: b.nodes.filter(n => n.type === 'exit').length, people: b.nodes.reduce((s, n) => s + (n.type === 'room' ? Number(n.people ?? 0) : 0), 0) }
  const labelOf = (id: string) => by[id]?.label ?? id
  const issues = widthIssues(b, measured, labelOf, L)
  const selKey = selEdge != null && b.edges[selEdge] ? edgeKey(b.edges[selEdge]) : null
  const selMeasure = selKey ? measured[selKey] : undefined
  const measureLine = (() => {
    if (mode?.kind !== 'measure' || !mode.pts.length) return null
    const end = mode.pts[1] ?? cursor
    if (!end) return null
    const [a, c] = snapPair(W, mode.pts[0], end)
    const e = b.edges[mode.edge]
    return { a, c, raw: [mode.pts[0], end], w: dist(a, c), kind: e ? edgeKind(b, e) : 'door' as const }
  })()

  return (
    <div className="pl-editor">
      <div className="pl-bar">
        <button className="pf-btn ghost pl-back" onClick={close}><Icon d="M15 18l-6-6 6-6" />Buildings</button>
        <div className="pl-title pf-grow">
          <input className="pl-name" value={b.name} aria-label="Building name" onFocus={edit.begin} onBlur={edit.end} onChange={e => edit.change(bb => ({ ...bb, name: e.target.value }))} />
          <span className="pf-small pf-muted">{floors.length || 1} floor{floors.length > 1 ? 's' : ''} · {counts.rooms} rooms · {counts.exits} exits · {counts.people} people{h.dirty ? ' · unsaved changes' : ''}</span>
        </div>
        <div className="pl-bar-group">
          <button className="pf-btn ghost" onClick={h.undo} disabled={!h.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" /></button>
          <button className="pf-btn ghost" onClick={h.redo} disabled={!h.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon d="m15 14 5-5-5-5m5 5H9a5 5 0 0 0 0 10h3" /></button>
          <button className="pf-btn primary" onClick={() => setAsk({ kind: 'save' })}>Save</button>
        </div>
      </div>

      {banner && <div className="pf-alert info pl-banner"><div className="pf-grow">{banner}</div><button className="pf-btn ghost" onClick={() => setBanner(null)} aria-label="Dismiss">×</button></div>}
      {savedSite && (
        <div className="pf-alert ok pl-banner">
          <div className="pf-grow">Saved as <b>{savedSite.name}</b>{h.dirty ? ' (changed since)' : ''}.</div>
          <a className="pf-btn go" href={`#/control?site=${encodeURIComponent(savedSite.id)}`}>Open control room</a>
          <a className="pf-btn" href={`#/sim?site=${encodeURIComponent(savedSite.id)}`}>3D view</a>
        </div>
      )}

      <div className="pl-work">
        <div className="pl-canvas-col">
          <div className="pl-tools" role="toolbar" aria-label="Drawing tools">
            {TOOLS.map(t => (
              <button key={t.id} className={`pl-tool ${tool === t.id && !mode ? 'on' : ''}`} aria-pressed={tool === t.id} title={`${t.label} (${t.key})`}
                onClick={() => { setTool(t.id); setFrom(null); setMode(null) }}>
                <Icon d={t.icon} /><span>{t.label}</span>
              </button>
            ))}
            <span className="pl-sep" />
            <button className={`pl-tool ${mode?.kind === 'scale' ? 'on' : ''}`} title="Click two points a known distance apart, then type that distance"
              onClick={() => setMode(m => (m?.kind === 'scale' ? null : { kind: 'scale', pts: [] }))}>
              <Icon d="M3 17 17 3l4 4L7 21zM7 13l2 2m2-6 2 2m2-6 2 2" /><span>Set scale</span>
            </button>
            <label className="pl-toggle"><input type="checkbox" checked={showWidths} onChange={e => setShowWidths(e.target.checked)} />Widths</label>
            {showWidths && <label className="pl-toggle" title="Show people per minute with each width"><input type="checkbox" checked={showCap} onChange={e => setShowCap(e.target.checked)} />/min</label>}
            {grid && <label className="pl-toggle"><input type="checkbox" checked={showWalls} onChange={e => setShowWalls(e.target.checked)} />Walls</label>}
            <span className="pf-grow" />
            <div className="pl-units" role="group" aria-label="Units">
              <button className={units === 'm' ? 'on' : ''} aria-pressed={units === 'm'} onClick={() => setUnits('m')}>m</button>
              <button className={units === 'ft' ? 'on' : ''} aria-pressed={units === 'ft'} onClick={() => setUnits('ft')}>ft</button>
            </div>
          </div>
          {floors.length > 1 && <div className="pl-floorbar"><FloorTabs floors={floors} value={fl} onChange={id => { setFloor(id); if (!from) setSel(null) }} /></div>}
          <div className="pl-canvas" ref={wrap}>
            <svg ref={svg} className={`pl-svg tool-${mode ? 'measure' : tool}`} width={size.w} height={size.h}
              viewBox={`${view.x0} ${view.z0} ${size.w / view.s || 1} ${size.h / view.s || 1}`}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setCursor(null)}
              role="application" aria-label={`Plan editor, ${floorOf(fl) || 'floor plan'}`}>
              <Grid view={view} size={size} />
              {under && <image href={under.src} x={under.x} y={under.z} width={under.w} height={under.h} opacity={opacity} preserveAspectRatio="none" className="pl-under" />}
              {showBelow && below && b.nodes.filter(n => n.floor_id === below.id && isStair(n)).map(n => (
                <rect key={`g${n.id}`} className="pl-ghost" x={n.x - px(7)} y={n.z - px(7)} width={px(14)} height={px(14)}><title>{`${n.label ?? n.id} (${below.name})`}</title></rect>
              ))}
              {vis.filter(n => n.type === 'room').map(n => {
                const w = n.w ?? 1, d = n.d ?? 1
                const big = w * view.s > 46 && d * view.s > 26
                return (
                  <g key={n.id} data-node={n.id} className={`pl-room ${selNode === n.id ? 'sel' : ''} ${from === n.id ? 'from' : ''}`}>
                    <rect x={n.x - w / 2} y={n.z - d / 2} width={w} height={d} />
                    {big && <text x={n.x} y={n.z - px(3)} style={{ fontSize: px(12) }}>{n.label ?? n.id}</text>}
                    {big && <text x={n.x} y={n.z + px(11)} className="pl-sub" style={{ fontSize: px(11) }}>{n.people ?? 0} people</text>}
                  </g>
                )
              })}
              {/* walls over the room fills, so they stay visible inside rooms */}
              {grid && wallImg && showWalls && <image href={wallImg} x={grid.x0} y={grid.z0} width={grid.cols * grid.res} height={grid.rows * grid.res} opacity={wallOpacity} preserveAspectRatio="none" className="pl-under pl-walls" />}
              {stroke && stroke.pts.length > 0 && <polyline className={`pl-brush ${stroke.add ? 'add' : 'erase'}`} points={stroke.pts.map(q => `${q.x},${q.z}`).join(' ')} strokeWidth={brush.size * 2} />}
              {b.edges.map((e, i) => {
                const A = by[e.from], B = by[e.to]
                if (!A || !B || !visIds.has(A.id) || !visIds.has(B.id)) return null
                const kind = edgeKind(b, e)
                const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2
                return (
                  <g key={`e${i}`} data-edge={i} className={`pl-edge k-${kind} ${selEdge === i ? 'sel' : ''}`}>
                    <line x1={A.x} y1={A.z} x2={B.x} y2={B.z} className="pl-edge-hit" />
                    <line x1={A.x} y1={A.z} x2={B.x} y2={B.z} className="pl-edge-line" />
                    {showWidths && (kind !== 'door' ? dist(A, B) * view.s > 44 : selEdge === i || view.s > 28) && (
                      <text x={mx} y={mz - px(5)} style={{ fontSize: px(10.5) }} className={`pl-width ${issues.some(x => x.edge === i) ? 'warn' : ''}`}>{L(e.width)}{showCap ? ` · ${perMin(kind, e.width)}/min` : ''}</text>
                    )}
                  </g>
                )
              })}
              {vis.filter(n => n.type === 'corridor').map(n => {
                const st = isStair(n)
                const cls = `pl-node ${st ? 'stair' : 'walk'} ${selNode === n.id ? 'sel' : ''} ${from === n.id ? 'from' : ''}`
                if (!st) return (
                  <g key={n.id} data-node={n.id} className={cls}>
                    <circle cx={n.x} cy={n.z} r={px(11)} className="pl-hit" />
                    <circle cx={n.x} cy={n.z} r={px(5)} className="pl-dot" />
                  </g>
                )
                const lf = landingFloors(n.id)
                return (
                  <g key={n.id} data-node={n.id} className={cls}>
                    <circle cx={n.x} cy={n.z} r={px(12)} className="pl-hit" />
                    <rect x={n.x - px(7)} y={n.z - px(7)} width={px(14)} height={px(14)} rx={px(2)} />
                    <path d={`M${n.x - px(4)} ${n.z + px(4)}h${px(3)}v${-px(3)}h${px(3)}v${-px(3)}h${px(2)}`} className="pl-stair-mark" />
                    {lf.length > 0 && <text x={n.x + px(10)} y={n.z + px(4)} style={{ fontSize: px(10) }} className="pl-stair-text">{lf.map(l => `${l.up ? '↑' : '↓'}${l.name}`).join(' ')}</text>}
                  </g>
                )
              })}
              {vis.filter(n => n.type === 'exit').map(n => (
                <g key={n.id} data-node={n.id} className={`pl-node exit ${selNode === n.id ? 'sel' : ''} ${from === n.id ? 'from' : ''}`}>
                  <circle cx={n.x} cy={n.z} r={px(12)} className="pl-hit" />
                  <circle cx={n.x} cy={n.z} r={px(7)} className="pl-dot" />
                  <path d={`M${n.x - px(3)} ${n.z}h${px(6)}m${-px(2.5)} ${-px(2.5)}l${px(2.5)} ${px(2.5)}l${-px(2.5)} ${px(2.5)}`} className="pl-exit-mark" />
                  <text x={n.x} y={n.z - px(11)} style={{ fontSize: px(11) }}>{n.label ?? n.id}</text>
                </g>
              ))}
              {rect && <rect className="pl-draft" x={Math.min(rect.a.x, rect.b.x)} y={Math.min(rect.a.z, rect.b.z)} width={Math.abs(rect.b.x - rect.a.x)} height={Math.abs(rect.b.z - rect.a.z)} />}
              {rect && <text className="pl-dim" x={(rect.a.x + rect.b.x) / 2} y={Math.min(rect.a.z, rect.b.z) - px(6)} style={{ fontSize: px(11) }}>{L(Math.abs(rect.b.x - rect.a.x))} × {L(Math.abs(rect.b.z - rect.a.z))}</text>}
              {selMeasure && selMeasure.spans.map(([a, c], k) => <line key={`sp${k}`} className={`pl-span ${selMeasure.conf}`} x1={a.x} y1={a.z} x2={c.x} y2={c.z} />)}
              {tool === 'wall' && cursor && !mode && <circle className={`pl-brush-cursor ${brush.add ? 'add' : 'erase'}`} cx={cursor.x} cy={cursor.z} r={brush.size} />}
              {from && cursor && by[from] && visIds.has(from) && <line className="pl-rubber" x1={by[from].x} y1={by[from].z} x2={cursor.x} y2={cursor.z} />}
              {mode?.kind === 'scale' && (mode.pts.length > 0) && (
                <g className="pl-measure">
                  {(() => { const end = mode.pts[1] ?? cursor; return end ? <line x1={mode.pts[0].x} y1={mode.pts[0].z} x2={end.x} y2={end.z} /> : null })()}
                  {mode.pts.map((q, k) => <circle key={k} cx={q.x} cy={q.z} r={px(4)} />)}
                  {(() => { const end = mode.pts[1] ?? cursor; return end ? <text x={(mode.pts[0].x + end.x) / 2} y={(mode.pts[0].z + end.z) / 2 - px(8)} style={{ fontSize: px(12) }}>{round2(dist(mode.pts[0], end))} units</text> : null })()}
                </g>
              )}
              {measureLine && (
                <g className="pl-measure">
                  <line x1={measureLine.raw[0].x} y1={measureLine.raw[0].z} x2={measureLine.raw[1].x} y2={measureLine.raw[1].z} className="raw" />
                  <line x1={measureLine.a.x} y1={measureLine.a.z} x2={measureLine.c.x} y2={measureLine.c.z} />
                  <circle cx={measureLine.a.x} cy={measureLine.a.z} r={px(4)} />
                  <circle cx={measureLine.c.x} cy={measureLine.c.z} r={px(4)} />
                  <text x={(measureLine.a.x + measureLine.c.x) / 2} y={(measureLine.a.z + measureLine.c.z) / 2 - px(10)} style={{ fontSize: px(12.5) }}>
                    {L(measureLine.w)} · {perMin(measureLine.kind, measureLine.w)} people/min
                  </text>
                </g>
              )}
            </svg>
            <div className="pl-hint" role="status">{toolHint}</div>
            <div className="pl-zoom">
              <button onClick={() => zoomAt(1.25)} aria-label="Zoom in">+</button>
              <button onClick={() => zoomAt(0.8)} aria-label="Zoom out">−</button>
              <button onClick={fit} aria-label="Fit to view" title="Fit (F)"><Icon d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></button>
            </div>
            {cursor && <div className="pl-coords">x {numU(cursor.x, units, 1)} · z {numU(cursor.z, units, 1)} {units}{W && isWallAt(W, cursor) ? ' · wall' : ''}</div>}
            {tracing && <div className="pl-tracing" role="status"><span className="pl-spin" />Tracing walls{floors.length > 1 ? ` of ${floorOf(tracing)}` : ''}…</div>}
            {toast && <div className="pl-toast" role="status">{toast}</div>}
            {b.nodes.length === 0 && !under && <div className="pl-empty-canvas"><p>Empty floor. Draw rooms with <b>Room</b>, walkways with <b>Walkway</b>, and mark <b>Exits</b>. Or add a plan picture in the Floor panel to trace over.</p></div>}
          </div>
        </div>

        <aside className="pl-side" ref={side}>
          <section className="pf-card">
            <h3>{sel?.kind === 'edge' ? 'Link' : sel?.kind === 'node' ? (by[sel.id]?.type === 'room' ? 'Room' : by[sel.id]?.type === 'exit' ? 'Exit' : isStair(by[sel.id] ?? { id: '', type: 'room', x: 0, z: 0 }) ? 'Stair landing' : 'Walkway point') : 'Selection'}</h3>
            <Inspector building={b} sel={sel} edit={edit} floorName={floorOf} onSelect={setSel} onPickNode={pick} onDelete={deleteSel} measuring={measuring}
              onMeasure={i => setMode(m => (m?.kind === 'measure' ? null : { kind: 'measure', edge: i, pts: [] }))}
              units={units} auto={selMeasure} canAuto={!!(selEdge != null && b.edges[selEdge] && doc.walls?.[edgeFloor(b, b.edges[selEdge])])} onAuto={measureOne} onAccept={acceptWidth} />
          </section>

          <section className="pf-card">
            <h3>Floor{curFloor ? `: ${curFloor.name}` : ''}</h3>
            <div className="pf-stack">
              {curFloor && (
                <div className="pl-grid2">
                  <label className="pf-field">Name<input value={curFloor.name} onFocus={edit.begin} onBlur={edit.end} onChange={e => setFloorField({ name: e.target.value })} /></label>
                  <LenField units={units} label="Elevation" value={curFloor.elevation_m} step={0.1} edit={edit} onChange={v => setFloorField({ elevation_m: round2(v) })} />
                </div>
              )}
              <div className="pl-under-row">
                <span className="pf-small"><b>Plan picture</b> {under ? `${L(under.w)} × ${L(under.h)}` : 'none'}</span>
                <label className="pf-btn">{under ? 'Replace' : 'Add'}<input type="file" hidden accept="image/png,image/jpeg,image/webp,.pdf,application/pdf"
                  onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void loadUnderlay(f) }} /></label>
                {under && <button className="pf-btn ghost" onClick={() => h.commit(d => { const u = { ...d.underlays }; delete u[fl]; return { ...d, underlays: u } })}>Remove</button>}
              </div>
              {under && (
                <details className="pl-details">
                  <summary className="pf-small">Picture position</summary>
                  <div className="pl-grid3">
                    <LenField units={units} label="Left x" value={under.x} step={0.5} edit={edit} onChange={v => setUnder({ x: v })} />
                    <LenField units={units} label="Top z" value={under.z} step={0.5} edit={edit} onChange={v => setUnder({ z: v })} />
                    <LenField units={units} label="Width" value={under.w} step={0.5} edit={edit} onChange={v => { if (v >= 1) setUnder({ w: v }) }} />
                  </div>
                  <p className="pf-small pf-muted">Moves the picture (and its traced walls) only. Set scale stretches the picture and the drawing together.</p>
                </details>
              )}
              {under && <label className="pf-field pl-range">Picture opacity {Math.round(opacity * 100)}%<input type="range" min="0" max="1" step="0.05" value={opacity} onChange={e => setOpacity(+e.target.value)} /></label>}
              <div className="pl-walls-box">
                <div className="pl-under-row">
                  <span className="pf-small"><b>Walls</b> {grid ? `traced, ${L(grid.res)} cells` : 'none yet'}</span>
                  {under && <button className="pf-btn" onClick={() => void traceFloor()} disabled={!!tracing}>{tracing === fl ? 'Tracing…' : grid ? 'Trace again' : 'Trace walls from plan'}</button>}
                </div>
                {under && <label className="pf-field pl-range" title="Higher marks fainter lines as walls">Sensitivity {Math.round(sens * 100)}%<input type="range" min="0" max="1" step="0.05" value={sens} onChange={e => setSens(+e.target.value)} /></label>}
                {!under && <p className="pf-small pf-muted">Add a plan picture to trace its walls, or paint walls with the Walls tool (B).</p>}
                {grid && (
                  <>
                    <label className="pf-field pl-range">Wall overlay {Math.round(wallOpacity * 100)}%<input type="range" min="0.1" max="1" step="0.05" value={wallOpacity} onChange={e => { setWallOpacity(+e.target.value); setShowWalls(true) }} /></label>
                    <div className="pl-under-row">
                      <div className="pl-units" role="group" aria-label="Brush">
                        <button className={brush.add ? 'on' : ''} aria-pressed={brush.add} onClick={() => { setBrush(x => ({ ...x, add: true })); setTool('wall'); setMode(null) }}>Paint</button>
                        <button className={!brush.add ? 'on' : ''} aria-pressed={!brush.add} onClick={() => { setBrush(x => ({ ...x, add: false })); setTool('wall'); setMode(null) }}>Erase</button>
                      </div>
                      <label className="pf-field pl-range pf-grow">Brush {L(brush.size * 2)}<input type="range" min="0.05" max="1.5" step="0.05" value={brush.size} onChange={e => setBrush(x => ({ ...x, size: +e.target.value }))} /></label>
                    </div>
                    <div className="pf-row">
                      <button className="pf-btn" onClick={snapHere} title="Move room sides onto wall lines within 0.5 m">Line rooms up with walls</button>
                      <button className="pf-btn ghost" onClick={() => h.commit(d => { const w = { ...d.walls }; delete w[fl]; return { ...d, walls: w } })}>Clear walls</button>
                    </div>
                  </>
                )}
              </div>
              {under && <VisionRead under={under} floorLabel={curFloor?.name ?? 'Floor'} hasNodes={vis.length > 0} onRead={(nb) => {
                const pre = fl === SINGLE ? '' : `${fl}_`
                h.commit(d => ({
                  ...d, building: {
                    ...d.building,
                    nodes: [...d.building.nodes, ...nb.nodes.map(n => ({ ...n, id: pre + n.id, ...(fl === SINGLE ? {} : { floor_id: fl }) }))],
                    edges: [...d.building.edges, ...nb.edges.map(e => ({ from: pre + e.from, to: pre + e.to, width: e.width, ...(e.kind ? { kind: e.kind } : {}), ...(e.length ? { length: e.length } : {}) }))],
                  },
                }))
                flash(`Read ${nb.nodes.length} nodes from the picture. Check the exits.`)
              }} />}
              {below && <label className="pl-check"><input type="checkbox" checked={showBelow} onChange={e => setShowBelow(e.target.checked)} />Show stair landings of {below.name} (dashed)</label>}
              <label className="pl-check"><input type="checkbox" checked={joinNew} onChange={e => setJoinNew(e.target.checked)} />Join new points to the selected one</label>
              <div className="pf-row">
                <button className="pf-btn" onClick={addFloor}>Add floor above</button>
                {floors.length > 1 && <button className="pf-btn ghost" onClick={() => setAsk({ kind: 'deleteFloor' })}>Delete this floor</button>}
              </div>
            </div>
          </section>

          {floors.length > 1 && (
            <section className="pf-card">
              <h3>Stairs between floors</h3>
              <p className="pf-small pf-muted">Joins stair landings that sit above each other on consecutive floors. Landings: corridor points marked as stairs.</p>
              <div className="pl-measure-row">
                <label className="pf-field">Tolerance (m)<input type="number" min="0.5" max="20" step="0.5" value={tolerance} onChange={e => setTolerance(+e.target.value || 4)} /></label>
                <button className="pf-btn" onClick={() => void linkStairs()} disabled={linking}>{linking ? 'Linking…' : 'Link stairs'}</button>
              </div>
              {linkRes?.err && <div className="pf-alert bad">{linkRes.err}</div>}
              {linkRes && !linkRes.err && (linkRes.links.length
                ? <LinksTable links={linkRes.links} />
                : <p className="pf-small pf-muted">No new links. Either every landing is already linked, or no landings are within {tolerance} m of one on the next floor.</p>)}
              <StairList building={b} onPick={i => { const e = b.edges[i]; const n = by[e.from]; if (n?.floor_id) setFloor(n.floor_id); setSel({ kind: 'edge', i }) }} floorName={floorOf} label={labelOf} L={L} />
            </section>
          )}

          <section className="pf-card">
            <h3>Widths</h3>
            <WidthsPanel building={b} measured={measured} ignored={ignored} units={units} selected={selEdge} onPick={pickEdge} onAccept={acceptWidth}
              onAcceptHigh={acceptHigh} onIgnore={toggleIgnore} onMeasureAll={() => { measureAll(b, doc.walls); flash('Widths measured from the walls. Nothing changes until you accept.') }}
              canMeasure={!!doc.walls && Object.keys(doc.walls).length > 0} floorName={floorOf} />
          </section>

          <section className="pf-card">
            <h3>Checks</h3>
            <Checks building={b} onPick={pick} label={labelOf} widths={issues} onPickEdge={pickEdge} />
          </section>
        </aside>
      </div>

      {ask?.kind === 'room' && <RoomAsk ask={ask} L={L} n={vis.filter(n => n.type === 'room').length + 1} onCancel={() => setAsk(null)} onOk={(label, people) => {
        const id = newId(b, fl, 'room')
        const n: BuildingNode = { id, type: 'room', label, x: ask.x, z: ask.z, w: ask.w, d: ask.d, people }
        if (floors.length) n.floor_id = fl
        addNode(n)
        setAsk(null)
      }} />}
      {ask?.kind === 'stair' && <StairAsk a={by[ask.a]} c={by[ask.b]} group={(() => {
        const g = b.edges.find(e => e.kind === 'stair' && e.capacity_group && [e.from, e.to].some(x => x === ask.a || x === ask.b))?.capacity_group
        return g ?? newGroup(b)
      })()} floorName={floorOf} units={units} onCancel={() => setAsk(null)} onOk={(width, length, group) => {
        setB(bb => ({ ...bb, edges: [...bb.edges, { from: ask.a, to: ask.b, width, length, kind: 'stair', ...(group ? { capacity_group: group } : {}) }] }))
        setSel({ kind: 'edge', i: b.edges.length })
        setAsk(null)
      }} />}
      {ask?.kind === 'scale' && <ScaleAsk measured={ask.measured} units={units} onCancel={() => { setAsk(null); setMode(null) }} onOk={real => { applyScale(real, ask.measured); setAsk(null) }} />}
      {ask?.kind === 'deleteFloor' && (
        <Modal title={`Delete ${curFloor?.name ?? 'this floor'}?`} submit="Delete floor" onCancel={() => setAsk(null)} onSubmit={() => { deleteFloor(); setAsk(null) }}>
          <p>Its {vis.length} nodes and their links go too. You can undo this.</p>
        </Modal>
      )}
      {ask?.kind === 'save' && <SaveAsk doc={doc} origin={origin} floorName={floorOf} onCancel={() => setAsk(null)} onSaved={(s, warn) => {
        h.markSaved(); setSavedSite(s); setAsk(null)
        if (warn.length) setBanner(<>Saved, but: {warn.join(' ')}</>)
        setOrigin({ id: s.id, demo: false, name: s.name, address: s.address ?? '', geo: s.geo, assembly: s.assembly })
      }} />}
    </div>
  )
}

function Grid({ view, size }: { view: View; size: { w: number; h: number } }) {
  // a 1 m / 5 m / 10 m grid, whichever is at least 14 px apart
  const step = [1, 2, 5, 10, 20, 50, 100].find(s => s * view.s >= 14) ?? 100
  const x0 = Math.floor(view.x0 / step) * step, z0 = Math.floor(view.z0 / step) * step
  const x1 = view.x0 + size.w / view.s, z1 = view.z0 + size.h / view.s
  const lines: ReactNode[] = []
  for (let x = x0; x <= x1 && lines.length < 400; x += step) lines.push(<line key={`x${x}`} x1={x} x2={x} y1={view.z0} y2={z1} className={Math.abs(x) < 1e-6 ? 'axis' : ''} />)
  for (let z = z0; z <= z1 && lines.length < 800; z += step) lines.push(<line key={`z${z}`} y1={z} y2={z} x1={view.x0} x2={x1} className={Math.abs(z) < 1e-6 ? 'axis' : ''} />)
  return <g className="pl-grid-lines">{lines}</g>
}

function StairList({ building, onPick, floorName, label, L }: { building: Building; onPick: (i: number) => void; floorName: (id: string | undefined) => string; label: (id: string) => string; L: (m: number) => string }) {
  const by = nodeMap(building)
  const rows = building.edges.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'stair' && by[e.from]?.floor_id !== by[e.to]?.floor_id)
  if (!rows.length) return <p className="pf-small pf-muted">No stairs between floors yet.</p>
  return (
    <table className="pf-table pl-stairs">
      <thead><tr><th>Shaft</th><th>Flight</th><th>Width</th></tr></thead>
      <tbody>
        {rows.map(([e, i]) => (
          <tr key={i} onClick={() => onPick(i)} className="pl-rowbtn" tabIndex={0} onKeyDown={ev => { if (ev.key === 'Enter') onPick(i) }}>
            <td>{e.capacity_group ?? <span className="pf-muted">none</span>}</td>
            <td>{label(e.from)} <span className="pf-muted">({floorName(by[e.from]?.floor_id)})</span> → {label(e.to)} <span className="pf-muted">({floorName(by[e.to]?.floor_id)})</span></td>
            <td>{L(e.width)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function RoomAsk({ ask, n, L, onOk, onCancel }: { ask: { w: number; d: number }; n: number; L: (m: number) => string; onOk: (label: string, people: number) => void; onCancel: () => void }) {
  const [label, setLabel] = useState(`Room ${n}`)
  const [people, setPeople] = useState(String(Math.max(1, Math.round(ask.w * ask.d * 0.3))))
  return (
    <Modal title="New room" submit="Add room" onCancel={onCancel} onSubmit={() => onOk(label.trim() || `Room ${n}`, Math.max(0, Math.round(+people || 0)))}>
      <p className="pf-small pf-muted">{L(ask.w)} × {L(ask.d)} ({round1(ask.w * ask.d)} m²)</p>
      <label className="pf-field">Name on the plan<input value={label} onChange={e => setLabel(e.target.value)} /></label>
      <label className="pf-field">People on a busy day<input type="number" min="0" step="1" value={people} onChange={e => setPeople(e.target.value)} /></label>
      <p className="pf-small pf-muted">Rough guide per m²: office 0.15, lab 0.5, classroom 1.0, seated hall 1.5.</p>
    </Modal>
  )
}

function StairAsk({ a, c, group, floorName, units, onOk, onCancel }: { a: BuildingNode; c: BuildingNode; group: string; floorName: (id: string | undefined) => string; units: 'm' | 'ft'; onOk: (w: number, l: number, g: string) => void; onCancel: () => void }) {
  const [w, setW] = useState(String(numU(1.2, units)))
  const [l, setL] = useState(String(numU(STAIR_LENGTH, units)))
  const [g, setG] = useState(group)
  return (
    <Modal title="Stair between floors" submit="Add stair" onCancel={onCancel} onSubmit={() => onOk(Math.max(0.3, round2(fromU(+w, units)) || 1.2), Math.max(0.5, round2(fromU(+l, units)) || STAIR_LENGTH), g.trim())}>
      <p className="pf-small">{a.label ?? a.id} ({floorName(a.floor_id)}) ↔ {c.label ?? c.id} ({floorName(c.floor_id)})</p>
      <label className="pf-field">Clear width ({units})<input type="number" step="0.1" min="0.3" value={w} onChange={e => setW(e.target.value)} /></label>
      <label className="pf-field">Walking length on the flights ({units})<input type="number" step="0.1" min="0.5" value={l} onChange={e => setL(e.target.value)} /></label>
      <label className="pf-field">Stair shaft (capacity group)<input value={g} onChange={e => setG(e.target.value)} /></label>
      <p className="pf-small pf-muted">Flights in one shaft share its capacity, so people from several floors queue for the same stairs.</p>
    </Modal>
  )
}

function ScaleAsk({ measured, units, onOk, onCancel }: { measured: number; units: 'm' | 'ft'; onOk: (real: number) => void; onCancel: () => void }) {
  const [v, setV] = useState(String(numU(measured, units)))
  return (
    <Modal title="Set scale" submit="Apply scale" onCancel={onCancel} onSubmit={() => { const r = fromU(+v, units); if (r > 0) onOk(r) }}>
      <p className="pf-small pf-muted">The two points are {fmtLen(measured, units)} apart on this floor now. Type the real distance; the floor, its picture and its walls are stretched to match.</p>
      <label className="pf-field">Real distance ({units})<input type="number" step="0.01" min="0.01" value={v} onChange={e => setV(e.target.value)} /></label>
    </Modal>
  )
}

function VisionRead({ under, floorLabel, hasNodes, onRead }: { under: Underlay; floorLabel: string; hasNodes: boolean; onRead: (b: Building) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const read = async () => {
    setBusy(true); setErr('')
    try {
      const image = await forVision(under.src)
      const r = await api.post<{ building: Building & { vision?: { photo_m?: number[] | null } } }>('/vision', { image, width_m: Math.min(2000, Math.max(5, round1(under.w))), name: floorLabel })
      // the reader measures from its own corner of the photo; map that onto where the picture sits here
      const pm = r.building.vision?.photo_m
      const k = pm?.[2] ? under.w / pm[2] : 1
      const ox = pm ? pm[0] : 0, oz = pm ? pm[1] : 0
      onRead({
        ...r.building,
        nodes: r.building.nodes.map(n => ({
          ...n, x: round1(under.x + (n.x - ox) * k), z: round1(under.z + (n.z - oz) * k),
          ...(n.type === 'room' ? { w: round1((n.w ?? 1) * k), d: round1((n.d ?? 1) * k) } : {}),
        })),
        edges: r.building.edges.map(e => (e.length !== undefined && e.kind !== 'stair' ? { ...e, length: round2(e.length * k) } : e)),
      })
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pl-read">
      <button className="pf-btn" onClick={() => void read()} disabled={busy}>{busy ? 'Reading the plan… (about 20 s)' : hasNodes ? 'Read picture again (adds nodes)' : 'Read this picture'}</button>
      {err && <p className="pf-small pl-status bad">The plan reader is not available: {err}. Draw by hand over the picture.</p>}
    </div>
  )
}

function SaveAsk({ doc, origin, floorName, onSaved, onCancel }: { doc: Doc; origin: Origin; floorName: (id: string | undefined) => string; onSaved: (s: Site, warnings: string[]) => void; onCancel: () => void }) {
  const building = doc.building
  const [name, setName] = useState(origin.demo && origin.name ? `${origin.name} (copy)` : origin.name || building.name || '')
  const [address, setAddress] = useState(origin.address)
  const [key, setKey] = useState('')
  const [needKey, setNeedKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [err, setErr] = useState('')
  const copy = !!origin.demo
  /** Plan pictures and walls of each floor go up after the building: POST /sites/{id}/media/{floor}. */
  const uploadMedia = async (id: string) => {
    const floorIds = building.floors?.length ? building.floors.map(f => f.id) : [SINGLE]
    const keys = floorIds.filter(k => doc.underlays[k] || doc.walls?.[k])
    const warn: string[] = []
    for (const [n, k] of keys.entries()) {
      const u = doc.underlays[k], g = doc.walls?.[k]
      const where = building.floors?.length ? floorName(k) : 'The plan'
      setStep(`Uploading ${where.toLowerCase() === 'the plan' ? 'the plan' : where} (${n + 1} of ${keys.length})…`)
      const body: Record<string, unknown> = {}
      if (u) {
        body.plan = { x: round2(u.x), z: round2(u.z), w: round2(u.w), h: round2(u.h) }
        try { body.image = await uploadJpeg(u.src) } catch (e) { warn.push(`${where}: picture not uploaded (${e instanceof Error ? e.message : String(e)}).`) }
      }
      if (g) body.walls = storable(g)
      await api.post(`/sites/${encodeURIComponent(id)}/media/${encodeURIComponent(k)}`, body, true)
    }
    return warn
  }
  const save = async () => {
    if (!name.trim()) { setErr('Give the building a name.'); return }
    if (needKey && key.trim()) setControlKey(key.trim())
    setBusy(true); setErr('')
    const site: Record<string, unknown> = {
      name: name.trim(), address: address.trim(), building: { ...cleanBuilding(building), name: building.name?.trim() || name.trim() },
      geo: origin.geo ?? null, assembly: origin.assembly ?? [],
    }
    if (origin.id && !copy) site.id = origin.id
    let saved: Site | null = null
    try {
      setStep('Saving the building…')
      saved = await api.post<Site>('/sites', site, true)
      const warn = await uploadMedia(saved.id)
      onSaved(saved, warn)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setNeedKey(true); setErr(needKey ? 'That control key was not accepted.' : saved ? 'The building is saved; uploading its plan pictures needs this deployment’s control key.' : 'Saving needs this deployment’s control key.') }
      else if (saved) onSaved(saved, [`plan pictures and walls were not uploaded (${e instanceof Error ? e.message : String(e)}).`])
      else setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setBusy(false); setStep('')
    }
  }
  return (
    <Modal title={copy ? 'Save as a new building' : origin.id ? 'Save building' : 'Save new building'} submit={copy ? 'Save copy' : 'Save'} busy={busy} onCancel={onCancel} onSubmit={() => void save()}>
      {copy && <div className="pf-alert info">This is a demo building, so your version is saved as a copy. The demo stays as it was.</div>}
      <label className="pf-field">Name<input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Block C, three-storey office" /></label>
      <label className="pf-field">Address (optional)<input value={address} onChange={e => setAddress(e.target.value)} placeholder="Street, city" /></label>
      {needKey && <label className="pf-field">Control key<input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} /></label>}
      {err && <div className="pf-alert bad" role="alert">{err}</div>}
      {step && <p className="pf-small pl-status" role="status"><span className="pl-spin" />{step}</p>}
      <p className="pf-small pf-muted">The building must pass the checks to be saved. Plan pictures (as JPEG, at most 2400 px) and traced walls are uploaded with it.</p>
    </Modal>
  )
}

const isWallAt = (w: Walls, p: P) => {
  const c = Math.floor((p.x - w.g.x0) / w.g.res), r = Math.floor((p.z - w.g.z0) / w.g.res)
  return c >= 0 && r >= 0 && c < w.g.cols && r < w.g.rows && w.cells[r * w.g.cols + c] === 1
}
/** A box around a floor's drawing, with room to paint walls around it. */
const padded = (bx: { x0: number; z0: number; x1: number; z1: number }) => ({ x: Math.floor(bx.x0 - 5), z: Math.floor(bx.z0 - 5), w: Math.ceil(bx.x1 - bx.x0 + 10), h: Math.ceil(bx.z1 - bx.z0 + 10) })
