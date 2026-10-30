// Import floor plans: PDF pages, images (one floor each) or a building JSON file. Plan pictures are read by
// the vision service floor by floor, merged into one building, and stacked floors are joined at their stairs.
import { useRef, useState, type ReactNode } from 'react'
import { api, ApiError, type Building, type Site } from '../platform/api.ts'
import { forVision, imageFile, isImage, isJson, isPdf, pdfPages, type PlanImage } from './files.ts'
import Icon from './Icon.tsx'
import { floorId, floorName, isStair, mergeFloors, type Doc, type Origin, type Underlay } from './model.ts'

type VisionReply = { ok: boolean; building: Building & { vision?: { photo_m?: number[] | null; exits_added?: string[] } }; problems: string[] }
type Item = {
  key: string; image: PlanImage; name: string; nameAuto: boolean; elev: number; elevAuto: boolean; width: number; widthAuto: boolean
  status: 'idle' | 'reading' | 'done' | 'error'; error?: string; result?: VisionReply
}
type Link = { from: string; to: string; group: string }
type Review = { doc: Doc; links: Link[]; linkErr: string; problems: string[] }

const DEFAULT_WIDTH = 40
const STOREY = 3.5

/** `fresh`: the doc has plan pictures just imported, so the editor traces their walls and measures widths. */
export default function ImportPlans({ onCancel, onDone }: { onCancel: () => void; onDone: (doc: Doc, origin: Origin, note?: ReactNode, fresh?: boolean) => void }) {
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [drag, setDrag] = useState(false)
  const [phase, setPhase] = useState<'pick' | 'reading' | 'review'>('pick')
  const [review, setReview] = useState<Review | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const relabel = (list: Item[]) => list.map((it, i) => ({
    ...it,
    name: it.nameAuto ? floorName(i) : it.name,
    elev: it.elevAuto ? +(i * STOREY).toFixed(2) : it.elev,
    width: it.widthAuto && i > 0 ? list[0].width : it.width,
  }))

  async function addFiles(files: File[]) {
    setErr('')
    const json = files.find(isJson)
    if (json) return openJson(json)
    const pics: PlanImage[] = []
    try {
      for (const f of files) {
        if (isPdf(f)) {
          setBusy(`Opening ${f.name}…`)
          pics.push(...await pdfPages(f, (d, t) => setBusy(`Rendering ${f.name}: page ${d} of ${t}`)))
        } else if (isImage(f)) {
          setBusy(`Opening ${f.name}…`)
          pics.push(await imageFile(f))
        } else {
          setErr(`${f.name}: use a PDF, a PNG/JPEG/WebP picture, or a building JSON file.`)
        }
      }
    } catch (e) {
      setErr(`Could not open the file: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy('')
    }
    if (!pics.length) return
    if (!name) setName(files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 80))
    setItems(list => relabel([...list, ...pics.map((image, k) => ({
      key: `${Date.now()}-${k}-${Math.random().toString(36).slice(2, 6)}`, image, name: '', nameAuto: true, elev: 0, elevAuto: true,
      width: list[0]?.width ?? DEFAULT_WIDTH, widthAuto: true, status: 'idle' as const,
    }))]))
  }

  async function openJson(f: File) {
    try {
      const data = JSON.parse(await f.text()) as Partial<Site> & Partial<Building>
      const b = (data.building ?? data) as Building
      if (!Array.isArray(b.nodes) || !Array.isArray(b.edges)) throw new Error('it has no "nodes" and "edges" lists (docs/CONTRACT.md)')
      const site = data.building ? data : null
      const nm = site?.name ?? b.name ?? f.name.replace(/\.json$/i, '')
      onDone({ building: { ...b, name: b.name ?? nm }, underlays: {} },
        { name: nm, address: site?.address ?? '', geo: site?.geo ?? null, assembly: site?.assembly ?? [] },
        <>Imported <b>{f.name}</b> as is: {b.nodes.length} nodes, {b.edges.length} links{b.floors?.length ? `, ${b.floors.length} floors` : ''}. Saving makes a new building.</>)
    } catch (e) {
      setErr(`${f.name} is not a building file: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const update = (key: string, patch: Partial<Item>) => setItems(list => relabel(list.map(it => (it.key === key ? { ...it, ...patch } : it))))
  const move = (i: number, d: number) => setItems(list => {
    const j = i + d
    if (j < 0 || j >= list.length) return list
    const out = [...list];[out[i], out[j]] = [out[j], out[i]]
    return relabel(out)
  })
  const remove = (key: string) => setItems(list => relabel(list.filter(it => it.key !== key)))

  const floorsOf = (list: Item[]) => list.map((it, i) => ({ id: floorId(i), name: it.name.trim() || floorName(i), elevation_m: Number(it.elev) || 0 }))
  const underlayOf = (it: Item, reply?: VisionReply): Underlay => {
    const pm = reply?.building.vision?.photo_m
    const aspect = it.image.height / it.image.width
    if (pm && pm.length === 4 && pm.every(Number.isFinite)) return { src: it.image.src, x: pm[0], z: pm[1], w: pm[2], h: pm[2] * aspect }
    return { src: it.image.src, x: 0, z: 0, w: it.width, h: it.width * aspect }
  }
  const buildingName = () => name.trim() || 'Imported building'

  function drawByHand() {
    const floors = floorsOf(items)
    const underlays = Object.fromEntries(items.map((it, i) => [floors[i].id, underlayOf(it)]))
    onDone({ building: { name: buildingName(), units: 'm', floors, nodes: [], edges: [] }, underlays }, { name: buildingName(), address: '', geo: null, assembly: [] },
      <>The plan pictures are under each floor at {items[0]?.width ?? DEFAULT_WIDTH} m wide. Use <b>Set scale</b> if a known length does not match, then draw rooms, walkways, stairs and exits.</>, true)
  }

  async function readPlans() {
    setPhase('reading'); setErr('')
    const results: (VisionReply | undefined)[] = []
    for (const it of items) {
      update(it.key, { status: 'reading', error: undefined })
      try {
        const image = await forVision(it.image.src)
        const r = await api.post<VisionReply>('/vision', { image, width_m: Number(it.width) || DEFAULT_WIDTH, name: `${buildingName()} · ${it.name}` })
        results.push(r)
        update(it.key, { status: 'done', result: r })
      } catch (e) {
        results.push(undefined)
        update(it.key, { status: 'error', error: e instanceof ApiError ? (e.status ? `${e.message} (${e.status})` : e.message) : String(e) })
      }
    }
    const floors = floorsOf(items)
    let building = mergeFloors(buildingName(), floors.map((floor, i) => ({ floor, building: results[i]?.building ?? null })))
    const underlays = Object.fromEntries(items.map((it, i) => [floors[i].id, underlayOf(it, results[i])]))
    let links: Link[] = [], linkErr = '', problems: string[] = []
    if (results.some(Boolean) && floors.length > 1) {
      try {
        const r = await api.post<{ building: Building; links: Link[]; problems: string[] }>('/plans/link-floors', { building })
        building = r.building; links = r.links; problems = r.problems
      } catch (e) {
        linkErr = e instanceof Error ? e.message : String(e)
      }
    }
    setReview({ doc: { building, underlays }, links, linkErr, problems })
    setPhase('review')
  }

  const anyRead = items.some(it => it.status === 'done')
  const reading = items.findIndex(it => it.status === 'reading')
  const doneCount = items.filter(it => it.status === 'done' || it.status === 'error').length

  function openEditor() {
    if (!review) return
    const stairs = review.doc.building.nodes.filter(isStair).length
    const note = anyRead
      ? <>Plans read. <b>Exits are guessed from the picture: check every exit</b> (green) before you save. {items.length < 2 ? '' : review.links.length ? `${review.links.length} stair links were added between floors.` : stairs ? 'No stairs lined up between floors: connect landings with the Connect tool or Link stairs.' : 'No stair landings were found: add them with the Stair tool.'}</>
      : <>The plan reader is not available right now, so the floors are empty. Draw over the plan pictures by hand.</>
    onDone(review.doc, { name: buildingName(), address: '', geo: null, assembly: [] }, note, true)
  }

  return (
    <div className="pl-page">
      <header className="pl-head">
        <div className="pf-grow">
          <button className="pf-btn ghost pl-back" onClick={onCancel}><Icon d="M15 18l-6-6 6-6" />Buildings</button>
          <h1>Import a floor plan</h1>
          <p className="pf-muted">A PDF (each page is one floor), one picture per floor, or a building JSON file. Floors are listed from the ground up.</p>
        </div>
      </header>

      {phase === 'pick' && (
        <div
          className={`pl-drop ${drag ? 'is-over' : ''}`}
          onDragOver={e => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={e => { e.preventDefault(); setDrag(false); void addFiles([...e.dataTransfer.files]) }}>
          <Icon d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16" />
          <p><b>Drop plan files here</b> or</p>
          <button className="pf-btn" onClick={() => input.current?.click()}>Choose files</button>
          <p className="pf-muted pf-small">PDF · PNG · JPEG · WebP · building JSON</p>
          <input ref={input} type="file" hidden multiple accept=".pdf,application/pdf,image/png,image/jpeg,image/webp,.json,application/json"
            onChange={e => { const f = [...(e.target.files ?? [])]; e.target.value = ''; void addFiles(f) }} />
        </div>
      )}
      {busy && <p className="pf-muted pf-small" role="status">{busy}</p>}
      {err && <div className="pf-alert bad" role="alert">{err}</div>}

      {items.length > 0 && (
        <section className="pf-card pl-import">
          <div className="pl-import-top">
            <label className="pf-field pf-grow">Building name
              <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Block C, three-storey office" disabled={phase !== 'pick'} />
            </label>
          </div>
          <ol className="pl-floors">
            {items.map((it, i) => (
              <li key={it.key} className={`pl-floor is-${it.status}`}>
                <img src={it.image.src} alt={`Plan for ${it.name}`} className="pl-thumb" />
                <div className="pl-floor-fields">
                  <label className="pf-field">Floor name
                    <input value={it.name} onChange={e => update(it.key, { name: e.target.value, nameAuto: false })} disabled={phase !== 'pick'} />
                  </label>
                  <label className="pf-field">Elevation (m)
                    <input type="number" step="0.1" value={it.elev} onChange={e => update(it.key, { elev: +e.target.value, elevAuto: false })} disabled={phase !== 'pick'} />
                  </label>
                  <label className="pf-field" title="The building's real length from west to east">E–W width (m)
                    <input type="number" min="5" max="2000" step="0.5" value={it.width} onChange={e => update(it.key, { width: +e.target.value, widthAuto: false })} disabled={phase !== 'pick'} />
                  </label>
                  <p className="pf-muted pf-small pl-floor-src">{it.image.label} · {it.image.width}×{it.image.height}px · {floorId(i)}</p>
                  {it.status === 'reading' && <p className="pf-small pl-status"><span className="pl-spin" />Reading the plan… (about 20 s)</p>}
                  {it.status === 'done' && it.result && <ReadSummary r={it.result} />}
                  {it.status === 'error' && <p className="pf-small pl-status bad">Could not read this floor: {it.error}</p>}
                </div>
                {phase === 'pick' && (
                  <div className="pl-floor-tools">
                    <button className="pf-btn ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${it.name} down a floor`} title="Lower"><Icon d="M12 5v14m0 0-6-6m6 6 6-6" /></button>
                    <button className="pf-btn ghost" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={`Move ${it.name} up a floor`} title="Higher"><Icon d="M12 19V5m0 0-6 6m6-6 6 6" /></button>
                    <button className="pf-btn ghost" onClick={() => remove(it.key)} aria-label={`Remove ${it.name}`} title="Remove"><Icon d="M6 6l12 12M18 6 6 18" /></button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          {phase === 'pick' && (
            <>
              <p className="pf-muted pf-small">The width is the building's real length from west to east (left to right on the plan). Photos have no scale, so this sets it.</p>
              <div className="pl-import-actions">
                <button className="pf-btn ghost" onClick={drawByHand}>Draw by hand instead</button>
                <button className="pf-btn primary" onClick={() => void readPlans()}>Read plans</button>
              </div>
            </>
          )}
          {phase === 'reading' && (
            <div className="pl-progress" role="status">
              <div className="pl-pbar"><span style={{ width: `${(doneCount / items.length) * 100}%` }} /></div>
              <span className="pf-small">{reading >= 0 ? `Reading floor ${reading + 1} of ${items.length}` : 'Joining floors at their stairs…'}</span>
            </div>
          )}
          {phase === 'review' && review && (
            <div className="pf-stack">
              {anyRead ? (
                <div className="pf-alert warn"><b>Check the exits.</b> The reader finds rooms and walkways well, but it guesses exits from the picture. Confirm each one in the editor.</div>
              ) : (
                <div className="pf-alert info">The plan reader is not available ({items.find(it => it.error)?.error}). You can still draw each floor by hand over its plan picture.</div>
              )}
              {items.length > 1 && anyRead && (
                <div>
                  <h3>Stairs between floors</h3>
                  {review.linkErr && <p className="pf-small pl-status bad">Could not link floors: {review.linkErr}</p>}
                  {!review.linkErr && review.links.length === 0 && <p className="pf-muted pf-small">No stair landings lined up between floors. Add them in the editor and press Link stairs.</p>}
                  {review.links.length > 0 && <LinksTable links={review.links} />}
                </div>
              )}
              {review.problems.length > 0 && <p className="pf-small pf-muted">{review.problems.length} things to fix; the editor's checks list them.</p>}
              <div className="pl-import-actions">
                <button className="pf-btn ghost" onClick={() => { setPhase('pick'); setReview(null); setItems(l => l.map(it => ({ ...it, status: 'idle', result: undefined, error: undefined }))) }}>Back</button>
                <button className="pf-btn primary" onClick={openEditor}>{anyRead ? 'Open in editor' : 'Continue in editor'}</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function ReadSummary({ r }: { r: VisionReply }) {
  const n = r.building.nodes
  const count = (t: string) => n.filter(x => x.type === t).length
  return (
    <p className="pf-small pl-status ok">
      {count('room')} rooms · {count('corridor')} walkway points · {count('exit')} exits · {n.filter(isStair).length} stair landings
      {r.problems.length > 0 && <span className="pf-chip warn">{r.problems.length} to fix</span>}
    </p>
  )
}

export function LinksTable({ links }: { links: Link[] }) {
  const groups = [...new Set(links.map(l => l.group))]
  return (
    <table className="pf-table">
      <thead><tr><th>Stair shaft</th><th>Links</th></tr></thead>
      <tbody>
        {groups.map(g => (
          <tr key={g}><td><b>{g}</b></td><td>{links.filter(l => l.group === g).map(l => `${l.from} → ${l.to}`).join(', ')}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
