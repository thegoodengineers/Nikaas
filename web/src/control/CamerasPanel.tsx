// Room cameras (#/cam) and crowding hotspots.
import { ago, type Control } from '../platform/api.ts'
import { floorName, nodeLabel } from './util.ts'
import { LevelChip } from './PlanPanel.tsx'

export default function CamerasPanel({ data, siteId }: { data: Control; siteId: string }) {
  const b = data.site.building
  const camUrl = (node?: string) => `#/cam?site=${encodeURIComponent(siteId)}${node ? `&room=${encodeURIComponent(node)}` : ''}`
  const hot = [
    ...data.spots.map(s => ({ node: s.node, label: s.label, people: s.people, density: s.density, level: s.level })),
    ...Object.entries(data.rooms).filter(([, r]) => r.level !== 'ok').map(([id, r]) => ({ node: id, label: r.label, people: r.camera ?? r.people, density: r.density, level: r.level })),
  ].sort((x, y) => y.density - x.density)
  const pct = (v: number) => `${Math.round(v * 100)}%`
  return (
    <section className="pf-card" aria-labelledby="cr-cams-h">
      <div className="cr-card-head">
        <h2 id="cr-cams-h">Cameras</h2>
        <a className="pf-btn cr-btn-s" href={camUrl()}>Open room camera</a>
      </div>
      {data.cameras.length === 0 ? <p className="pf-empty">No camera has reported in the last 2 minutes. Open the room camera on a laptop to count people in a room.</p> : (
        <ul className="cr-list">
          {data.cameras.map(c => {
            const flagged = Math.max(c.fire, c.smoke) >= 0.6
            return (
              <li key={c.camera_id} className="cr-cam">
                <div className="cr-cam-top">
                  <strong>{nodeLabel(b, c.node)}</strong>
                  <span className="pf-muted pf-small">{ago(c.at)}</span>
                </div>
                <div className="cr-cam-row pf-small">
                  <span>People <strong className="num">{c.people ?? '–'}</strong></span>
                  <span className={c.fire >= 0.6 ? 'cr-t-bad' : ''}>Fire <strong className="num">{pct(c.fire)}</strong></span>
                  <span className={c.smoke >= 0.6 ? 'cr-t-bad' : ''}>Smoke <strong className="num">{pct(c.smoke)}</strong></span>
                  {c.confirmed === true && <span className="pf-chip bad">Confirmed by Rekognition</span>}
                  {c.confirmed === false && <span className="pf-chip">Not confirmed by Rekognition</span>}
                  {c.confirmed == null && flagged && <span className="pf-chip warn">Not checked by Rekognition</span>}
                </div>
                <div className="pf-small pf-muted">
                  <code className="cr-tok">{c.camera_id}</code>{floorName(b, b.nodes.find(n => n.id === c.node)?.floor_id) ? ` · ${floorName(b, b.nodes.find(n => n.id === c.node)?.floor_id)}` : ''} · <a href={camUrl(c.node)}>Open camera for this room</a>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <h3 className="cr-sub-h">Crowding hotspots</h3>
      {hot.length === 0 ? <p className="pf-empty">No space above {data.thresholds.concern} people/m².</p> : (
        <ul className="cr-list">
          {hot.map(h => (
            <li key={h.node} className="cr-li">
              <span className="cr-li-main">{h.label}</span>
              <span className="pf-small num">{h.people} people · {h.density.toFixed(2)} p/m²</span>
              <LevelChip level={h.level} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
