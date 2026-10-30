// Buildings (#/buildings): the list of sites, importing floor plans (PDF, images, building JSON) and the
// plan editor. #/buildings?edit=<id> opens a site straight in the editor.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, hashQuery, type Site, type SiteSummary } from '../platform/api.ts'
import BuildingArt from './BuildingArt.tsx'
import Editor from './Editor.tsx'
import Icon from './Icon.tsx'
import ImportPlans from './ImportPlans.tsx'
import Modal from './Modal.tsx'
import type { WallGrid } from '../platform/walls.ts'
import { floorId, floorName, type Doc, type Origin, type Underlay } from './model.ts'
import './plans.css'

type View = { kind: 'list' } | { kind: 'import' } | { kind: 'edit'; doc: Doc; origin: Origin; note?: ReactNode; fresh?: boolean; key: number }

const blank = (): Doc => ({ building: { name: 'New building', floors: [{ id: floorId(0), name: floorName(0), elevation_m: 0 }], nodes: [], edges: [] }, underlays: {} })

export default function Buildings() {
  const [view, setView] = useState<View>({ kind: 'list' })
  useEffect(() => { scrollTo(0, 0) }, [view])
  const [opening, setOpening] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const edit = useCallback(async (id: string) => {
    setOpening(id); setErr('')
    try {
      const s = await api.get<Site>(`/sites/${encodeURIComponent(id)}`)
      // plan pictures (links, or inline data when run locally) and traced walls saved with the site
      const underlays: Record<string, Underlay> = {}, walls: Record<string, WallGrid> = {}
      for (const [k, m] of Object.entries(s.media ?? {})) {
        if (m.plan?.url) underlays[k] = { src: m.plan.url, x: m.plan.x, z: m.plan.z, w: m.plan.w, h: m.plan.h }
        if (m.walls) walls[k] = m.walls
      }
      setView({
        kind: 'edit', key: Date.now(), doc: { building: s.building, underlays, walls },
        origin: { id: s.id, demo: !!s.demo, name: s.name, address: s.address ?? '', geo: s.geo, assembly: s.assembly ?? [] },
      })
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
    } finally {
      setOpening(null)
    }
  }, [])

  useEffect(() => {
    const open = () => { const id = hashQuery().get('edit'); if (id) void Promise.resolve().then(() => edit(id)) }
    open()
    // a link to #/buildings?edit=<id> while this page is already open
    addEventListener('hashchange', open)
    return () => removeEventListener('hashchange', open)
  }, [edit])

  const toList = () => {
    if (location.hash.includes('?')) history.replaceState(null, '', '#/buildings')
    setView({ kind: 'list' })
  }

  return (
    <div className="pf pl">
      {view.kind === 'list' && (
        <BuildingList onEdit={edit} opening={opening} err={err} onImport={() => setView({ kind: 'import' })}
          onBlank={() => setView({ kind: 'edit', key: Date.now(), doc: blank(), origin: { name: '', address: '', geo: null, assembly: [] } })} />
      )}
      {view.kind === 'import' && (
        <ImportPlans onCancel={toList} onDone={(doc, origin, note, fresh) => setView({ kind: 'edit', key: Date.now(), doc, origin, note, fresh })} />
      )}
      {view.kind === 'edit' && <Editor key={view.key} initial={view.doc} origin={view.origin} note={view.note} fresh={view.fresh} onClose={toList} />}
    </div>
  )
}

function BuildingList({ onEdit, onImport, onBlank, opening, err }: { onEdit: (id: string) => void; onImport: () => void; onBlank: () => void; opening: string | null; err: string }) {
  const [sites, setSites] = useState<SiteSummary[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [ask, setAsk] = useState<SiteSummary | null>(null) // the building to delete, while confirming
  const [busy, setBusy] = useState(false)
  const [delErr, setDelErr] = useState('')
  useEffect(() => {
    let live = true
    api.get<SiteSummary[]>('/sites').then(s => { if (live) setSites(s) }).catch(e => { if (live) setLoadErr(e instanceof ApiError ? e.message : String(e)) })
    return () => { live = false }
  }, [])
  return (
    <div className="pl-page">
      <header className="pl-head">
        <div className="pf-grow">
          <p className="pf-eyebrow">Buildings</p>
          <h1>Your buildings</h1>
          <p className="pf-muted">Import a floor plan or draw one, then open its control room.</p>
        </div>
        <div className="pl-head-actions">
          <button className="pf-btn primary" onClick={onImport}><Icon d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16" />Import a floor plan</button>
          <button className="pf-btn" onClick={onBlank}><Icon d="M12 5v14M5 12h14" />New blank building</button>
        </div>
      </header>
      {err && <div className="pf-alert bad" role="alert">Could not open that building: {err}</div>}
      {loadErr && <div className="pf-alert bad" role="alert">Could not load buildings: {loadErr}</div>}
      {!sites && !loadErr && <p className="pf-empty">Loading buildings…</p>}
      {sites && (
        <div className="pl-grid">
          {sites.map(s => (
            <article key={s.id} className="pf-card pl-site">
              <BuildingArt id={s.id} />
              <div className="pl-site-title">
                <h2>{s.name}</h2>
                {s.demo ? <span className="pf-chip info">Demo</span>
                  : <button className="pf-btn ghost pl-del" onClick={() => { setDelErr(''); setAsk(s) }} aria-label={`Delete ${s.name}`} title="Delete this building"><Icon d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13" /></button>}
              </div>
              <p className="pl-facts">{count(s.floors, 'floor')} · {count(s.rooms, 'room')} · {count(s.exits, 'exit')} · {count(s.people, 'person', 'people')}</p>
              <div className="pl-site-actions">
                <a className="pf-btn primary" href={`#/control?site=${encodeURIComponent(s.id)}`}>Open control room</a>
                <a className="pf-btn" href={`#/sim?site=${encodeURIComponent(s.id)}`}>3D view</a>
                <button className="pf-btn" onClick={() => onEdit(s.id)} disabled={opening === s.id}>{opening === s.id ? 'Opening…' : 'Edit'}</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {ask && (
        <Modal title={`Delete ${ask.name}?`} submit="Delete building" busy={busy} onCancel={() => setAsk(null)} onSubmit={async () => {
          setBusy(true); setDelErr('')
          try {
            await api.del(`/sites/${encodeURIComponent(ask.id)}`, true)
            setSites(list => list && list.filter(x => x.id !== ask.id)); setAsk(null)
          } catch (e) { setDelErr(e instanceof ApiError ? e.message : String(e)) } finally { setBusy(false) }
        }}>
          <p>This removes the building and its floor plans from Nikaas for everyone, and its printed QR codes stop working. It cannot be undone.</p>
          {delErr && <div className="pf-alert bad" role="alert">Could not delete it: {delErr}</div>}
        </Modal>
      )}
    </div>
  )
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
