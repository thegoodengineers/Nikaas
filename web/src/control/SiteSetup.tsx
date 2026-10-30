// Site setup: where the building is on the map and where people gather outside.
import { useState } from 'react'
import { api, mapEmbedUrl, type Assembly, type Site } from '../platform/api.ts'
import { nodeLabel, type PanelProps } from './util.ts'

type Pt = { id: string; label: string; lat: string; lng: string; exits: string[]; touched: boolean }

const num = (s: string) => (s.trim() === '' ? null : Number(s))
const valid = (lat: number | null, lng: number | null) => lat !== null && lng !== null && isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))
const toPts = (a: Assembly[]): Pt[] => a.map(p => ({ id: p.id, label: p.label, lat: str(p.lat), lng: str(p.lng), exits: p.exits ?? [], touched: false }))

export default function SiteSetup({ data, siteId, act, notify }: PanelProps) {
  const b = data.site.building
  const g = data.site.geo
  const [lat, setLat] = useState(str(g?.lat))
  const [lng, setLng] = useState(str(g?.lng))
  const [rot, setRot] = useState(str(g?.rotation_deg ?? 0))
  const [pts, setPts] = useState<Pt[]>(() => toPts(data.site.assembly))
  const [preview, setPreview] = useState('building')
  const [busy, setBusy] = useState(false)
  const [locating, setLocating] = useState<string | null>(null)

  const locate = (target: string, done: (lat: number, lng: number) => void) => {
    if (!navigator.geolocation) { notify('bad', 'This browser cannot share its location. Type the coordinates instead.'); return }
    setLocating(target)
    navigator.geolocation.getCurrentPosition(
      p => { setLocating(null); done(+p.coords.latitude.toFixed(7), +p.coords.longitude.toFixed(7)); notify('info', `Location found (±${Math.round(p.coords.accuracy)} m). Save to keep it.`) },
      e => { setLocating(null); notify('bad', e.code === e.PERMISSION_DENIED ? 'Location permission was refused. Allow it for this site or type the coordinates.' : 'Could not get a location. Try again outdoors or type the coordinates.') },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }
  const setPt = (id: string, patch: Partial<Pt>) => setPts(ps => ps.map(p => (p.id === id ? { ...p, ...patch } : p)))

  const glat = num(lat), glng = num(lng)
  const geoOk = valid(glat, glng)
  const geoEmpty = lat.trim() === '' && lng.trim() === ''
  const badPt = pts.find(p => p.touched && !(p.lat.trim() === '' && p.lng.trim() === '') && !valid(num(p.lat), num(p.lng)))

  const save = async () => {
    if (!geoOk && !geoEmpty) { notify('bad', 'Building location: enter both latitude (-90 to 90) and longitude (-180 to 180).'); return }
    if (badPt) { notify('bad', `${badPt.label}: enter both latitude and longitude, or leave both empty.`); return }
    setBusy(true)
    const body = {
      geo: geoOk ? { lat: glat, lng: glng, rotation_deg: Number(rot) || 0 } : undefined,
      assembly: pts.map(p => ({ id: p.id, label: p.label.trim() || p.id, ...(p.touched ? { lat: num(p.lat), lng: num(p.lng) } : {}) })),
    }
    const r = await act(() => api.post<Site>(`/sites/${encodeURIComponent(siteId)}/geo`, body, true), 'Site location saved. Phones use it from their next update.')
    setBusy(false)
    if (r) setPts(toPts(r.assembly))
  }

  const prevPt = pts.find(p => p.id === preview)
  const pv = prevPt ? { lat: num(prevPt.lat), lng: num(prevPt.lng), label: prevPt.label } : { lat: glat, lng: glng, label: 'Building' }
  const showMap = valid(pv.lat, pv.lng)

  return (
    <div className="cr-setup">
      <p className="pf-alert info cr-gap">Phones use the building location and assembly points for outdoor directions after they leave, and to check “I'm safe” against where they are.</p>
      <div className="cr-setup-grid">
        <div className="pf-stack">
          <section className="pf-card" aria-labelledby="cr-geo-h">
            <h2 id="cr-geo-h">Building location</h2>
            <p className="pf-muted pf-small">The origin of the floor plan (x = 0, z = 0) on the map. Stand at that corner and use your location, or type it.</p>
            <div className="cr-geo-row">
              <label className="pf-field">Latitude<input inputMode="decimal" value={lat} onChange={e => setLat(e.target.value)} placeholder="19.0784" /></label>
              <label className="pf-field">Longitude<input inputMode="decimal" value={lng} onChange={e => setLng(e.target.value)} placeholder="72.8814" /></label>
              <label className="pf-field">Rotation (°)<input type="number" min={-180} max={180} step={1} value={rot} onChange={e => setRot(e.target.value)} /></label>
            </div>
            <p className="pf-muted pf-small">Rotation 0 means the top of the floor plan faces north; positive values turn the plan anticlockwise.</p>
            <div className="pf-row">
              <button type="button" className="pf-btn" onClick={() => locate('building', (a, o) => { setLat(String(a)); setLng(String(o)); setPreview('building') })} disabled={locating !== null}>
                {locating === 'building' ? 'Finding you…' : 'Use my location'}
              </button>
              <button type="button" className="pf-btn ghost" onClick={() => setPreview('building')} disabled={!geoOk}>Show on map</button>
            </div>
          </section>

          <section className="pf-card" aria-labelledby="cr-asm-h">
            <h2 id="cr-asm-h">Assembly points</h2>
            {pts.length === 0 ? <p className="pf-empty">This site has no assembly points.</p> : (
              <ul className="cr-asm">
                {pts.map(p => (
                  <li key={p.id} className="cr-asm-item">
                    <label className="pf-field">Name<input value={p.label} onChange={e => setPt(p.id, { label: e.target.value })} /></label>
                    <p className="pf-small pf-muted">Serves {p.exits.length ? p.exits.map(x => nodeLabel(b, x)).join(', ') : 'the nearest exits'}{!p.touched && p.lat ? ' · position from the building location' : ''}</p>
                    <div className="cr-geo-row two">
                      <label className="pf-field">Latitude<input inputMode="decimal" value={p.lat} onChange={e => setPt(p.id, { lat: e.target.value, touched: true })} /></label>
                      <label className="pf-field">Longitude<input inputMode="decimal" value={p.lng} onChange={e => setPt(p.id, { lng: e.target.value, touched: true })} /></label>
                    </div>
                    <div className="pf-row">
                      <button type="button" className="pf-btn cr-btn-s" disabled={locating !== null}
                        onClick={() => locate(p.id, (a, o) => { setPt(p.id, { lat: String(a), lng: String(o), touched: true }); setPreview(p.id) })}>
                        {locating === p.id ? 'Finding you…' : 'Use my location here'}
                      </button>
                      <button type="button" className="pf-btn ghost cr-btn-s" onClick={() => setPreview(p.id)} disabled={!valid(num(p.lat), num(p.lng))}>Show on map</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <div className="pf-row">
            <button type="button" className="pf-btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save location and assembly points'}</button>
            <button type="button" className="pf-btn ghost" onClick={() => { setLat(str(g?.lat)); setLng(str(g?.lng)); setRot(str(g?.rotation_deg ?? 0)); setPts(toPts(data.site.assembly)) }}>Reset</button>
          </div>
        </div>

        <section className="pf-card cr-map" aria-labelledby="cr-map-h">
          <h2 id="cr-map-h">Map preview: {pv.label}</h2>
          {showMap
            ? <iframe className="cr-map-frame" title={`Map of ${pv.label}`} src={mapEmbedUrl(pv.lat!, pv.lng!)} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />
            : <div className="cr-map-empty"><p className="pf-muted">Set coordinates to see the map.</p></div>}
          {showMap && <p className="pf-small pf-muted">{pv.lat!.toFixed(6)}, {pv.lng!.toFixed(6)} · Google Maps</p>}
        </section>
      </div>
    </div>
  )
}
