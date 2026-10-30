import { useEffect, useState, type CSSProperties } from 'react'
import { api, type Building, type BuildingNode, type Site } from '../platform/api.ts'

// A building card's picture: its 3D render from web/public/thumbs (made by scripts/card_pictures.py), or, for a
// building without one, the building drawn from its own map as an architect's massing model: axonometric, the long
// side running across; each floor a plate, each room a white block with its design occupancy as orange dots,
// exits green, stair landings blue. Floors lift apart a little on hover.
const [A, B] = [12 * Math.PI / 180, 40 * Math.PI / 180] // x runs right and slightly down, z down to the left
const [CA, SA, CB, SB] = [Math.cos(A), Math.sin(A), Math.cos(B), Math.sin(B)]
const ROOM_H = 2.2, SLAB = 0.6
const xy = (x: number, z: number, y: number) => [x * CA - z * CB, x * SA + z * SB - y]
const P = (x: number, z: number, y: number) => xy(x, z, y).map(v => v.toFixed(2)).join(',')
const quad = (x0: number, z0: number, x1: number, z1: number, y: number) => [P(x0, z0, y), P(x1, z0, y), P(x1, z1, y), P(x0, z1, y)].join(' ')

export default function BuildingArt({ id }: { id: string }) {
  const [photo, setPhoto] = useState(true) // the saved render, until it fails to load
  const [b, setB] = useState<Building>()
  useEffect(() => {
    if (photo) return
    let live = true
    api.get<Site>(`/sites/${encodeURIComponent(id)}`).then(s => { if (live) setB(s.building) }).catch(() => {})
    return () => { live = false }
  }, [id, photo])
  return (
    <div className="pl-art" aria-hidden="true">
      {photo ? <img src={`thumbs/${encodeURIComponent(id)}.jpg`} alt="" loading="lazy" onError={() => setPhoto(false)} /> : b && <Model b={b} seed={id} />}
    </div>
  )
}

function Model({ b, seed: key }: { b: Building; seed: string }) {
  if (!b.nodes.length) return null
  const floors = [...(b.floors?.length ? b.floors : [{ id: '', name: '', elevation_m: 0 }])].sort((p, q) => p.elevation_m - q.elevation_m)
  const fl = (n: BuildingNode) => n.floor_id ?? floors[0].id
  const N = Object.fromEntries(b.nodes.map(n => [n.id, n]))
  const ext = (n: BuildingNode) => [n.x - (n.w ?? 0) / 2, n.z - (n.d ?? 0) / 2, n.x + (n.w ?? 0) / 2, n.z + (n.d ?? 0) / 2]
  const box = b.nodes.map(ext).reduce((a, e) => [Math.min(a[0], e[0]), Math.min(a[1], e[1]), Math.max(a[2], e[2]), Math.max(a[3], e[3])])
  const [X0, Z0, X1, Z1] = [box[0] - 1.5, box[1] - 1.5, box[2] + 1.5, box[3] + 1.5]
  const gap = ((X1 - X0) * SA + (Z1 - Z0) * SB) * 0.7 // each floor lifted by 70% of a plate's drawn depth
  const Y = (f: string | undefined) => Math.max(0, floors.findIndex(x => x.id === f)) * gap
  const total = b.nodes.reduce((s, n) => s + (n.type === 'room' ? n.people ?? 0 : 0), 0)
  const perDot = Math.max(1, total / 160)
  let seed = [...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2147483647, 7) || 1
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  // the drawing's extent: every plate's corners, from its slab underneath to the room tops above
  const pts = floors.flatMap(f => [[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]].flatMap(([x, z]) => [xy(x, z, Y(f.id) + ROOM_H), xy(x, z, Y(f.id) - SLAB)]))
  const [l, r] = [Math.min(...pts.map(q => q[0])), Math.max(...pts.map(q => q[0]))], [t, bt] = [Math.min(...pts.map(q => q[1])), Math.max(...pts.map(q => q[1]))]

  return (
    <svg className="bm" viewBox={`${l - 1} ${t - 1} ${r - l + 2} ${bt - t + 2}`} preserveAspectRatio="xMidYMid meet">
      {floors.map((f, i) => {
        const y = Y(f.id), on = b.nodes.filter(n => fl(n) === f.id)
        const rooms = on.filter(n => n.type === 'room').sort((p, q) => p.x * SA + p.z * SB - (q.x * SA + q.z * SB)) // far rooms first
        const walks = b.edges.filter(e => N[e.from] && N[e.to] && fl(N[e.from]) === f.id && fl(N[e.to]) === f.id && N[e.from].type !== 'room' && N[e.to].type !== 'room')
        return (
          <g key={f.id || i} className="bm-floor" style={{ '--i': i } as CSSProperties}>
            <polygon className="slab-edge" points={[P(X0, Z1, y), P(X1, Z1, y), P(X1, Z1, y - SLAB), P(X0, Z1, y - SLAB)].join(' ')} />
            <polygon className="slab-edge dark" points={[P(X1, Z0, y), P(X1, Z1, y), P(X1, Z1, y - SLAB), P(X1, Z0, y - SLAB)].join(' ')} />
            <polygon className="slab" points={quad(X0, Z0, X1, Z1, y)} />
            {walks.map(e => { const [a, c] = [P(N[e.from].x, N[e.from].z, y).split(','), P(N[e.to].x, N[e.to].z, y).split(',')]; return <line key={e.from + e.to} className="walk" x1={a[0]} y1={a[1]} x2={c[0]} y2={c[1]} strokeWidth={e.width * 0.8} /> })}
            {rooms.map(rm => {
              const [x0, z0, x1, z1] = ext(rm), h = y + ROOM_H
              const dots = Array.from({ length: Math.round((rm.people ?? 0) / perDot) }, () => P(x0 + 0.6 + rnd() * (x1 - x0 - 1.2), z0 + 0.6 + rnd() * (z1 - z0 - 1.2), h).split(','))
              return (
                <g key={rm.id}>
                  <polygon className="side" points={[P(x0, z1, y), P(x1, z1, y), P(x1, z1, h), P(x0, z1, h)].join(' ')} />
                  <polygon className="side dark" points={[P(x1, z0, y), P(x1, z1, y), P(x1, z1, h), P(x1, z0, h)].join(' ')} />
                  <polygon className="top" points={quad(x0, z0, x1, z1, h)} />
                  {dots.map(([cx, cy], k) => <circle key={k} className="p" cx={cx} cy={cy} r={0.38} />)}
                </g>
              )
            })}
            {on.filter(n => n.stair).map(n => <polygon key={n.id} className="stair" points={quad(n.x - 1.2, n.z - 1.2, n.x + 1.2, n.z + 1.2, y)} />)}
            {on.filter(n => n.type === 'exit').map(x => { const [cx, cy] = P(x.x, x.z, y).split(','); return <circle key={x.id} className="exit" cx={cx} cy={cy} r={1.1} /> })}
          </g>
        )
      })}
    </svg>
  )
}
