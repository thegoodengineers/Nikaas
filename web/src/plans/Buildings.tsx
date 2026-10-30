// Buildings (#/buildings): the list of sites, importing floor plans (PDF, images, building JSON) and the
// plan editor. #/buildings?edit=<id> opens a site straight in the editor.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, hashQuery, type Site, type SiteSummary } from '../platform/api.ts'
import Editor from './Editor.tsx'
import Icon from './Icon.tsx'
import ImportPlans from './ImportPlans.tsx'
import { floorId, floorName, type Doc, type Origin } from './model.ts'
import './plans.css'

type View = { kind: 'list' } | { kind: 'import' } | { kind: 'edit'; doc: Doc; origin: Origin; note?: ReactNode; key: number }

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
      setView({
        kind: 'edit', key: Date.now(), doc: { building: s.building, underlays: {} },
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
        <ImportPlans onCancel={toList} onDone={(doc, origin, note) => setView({ kind: 'edit', key: Date.now(), doc, origin, note })} />
      )}
      {view.kind === 'edit' && <Editor key={view.key} initial={view.doc} origin={view.origin} note={view.note} onClose={toList} />}
    </div>
  )
}

function BuildingList({ onEdit, onImport, onBlank, opening, err }: { onEdit: (id: string) => void; onImport: () => void; onBlank: () => void; opening: string | null; err: string }) {
  const [sites, setSites] = useState<SiteSummary[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
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
          <p className="pf-muted">Each building is a floor-by-floor map of rooms, walkways, stairs and exits. Import a floor plan or draw one, then open its control room.</p>
        </div>
        <div className="pl-head-actions">
          <button className="pf-btn primary" onClick={onImport}><Icon d="M12 16V4m0 0-4 4m4-4 4 4M4 20h16" />Import a floor plan</button>
          <button className="pf-btn" onClick={onBlank}><Icon d="M12 5v14M5 12h14" />New blank building</button>
        </div>
      </header>
      {err && <div className="pf-alert bad" role="alert">Could not open that building: {err}</div>}
      {loadErr && <div className="pf-alert bad" role="alert">Could not load buildings: {loadErr}</div>}
      {!sites && !loadErr && <p className="pf-empty">Loading buildings…</p>}
      {sites && sites.length === 0 && <div className="pf-card pf-empty">No buildings yet. Import a floor plan to start.</div>}
      {sites && sites.length > 0 && (
        <div className="pl-grid">
          {sites.map(s => (
            <article key={s.id} className="pf-card pl-site">
              <div className="pf-row">
                <h2 className="pf-grow">{s.name}</h2>
                {s.demo && <span className="pf-chip info">Demo</span>}
              </div>
              <p className="pf-muted pf-small pl-addr">{s.address || 'No address yet'}</p>
              <dl className="pl-stats">
                <div><dt>Floors</dt><dd>{s.floors}</dd></div>
                <div><dt>Rooms</dt><dd>{s.rooms}</dd></div>
                <div><dt>Exits</dt><dd>{s.exits}</dd></div>
                <div><dt>People</dt><dd>{s.people}</dd></div>
              </dl>
              <div className="pl-site-actions">
                <a className="pf-btn primary" href={`#/control?site=${encodeURIComponent(s.id)}`}>Open control room</a>
                <a className="pf-btn" href={`#/sim?site=${encodeURIComponent(s.id)}`}>3D view</a>
                <button className="pf-btn" onClick={() => onEdit(s.id)} disabled={opening === s.id}>{opening === s.id ? 'Opening…' : 'Edit'}</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
