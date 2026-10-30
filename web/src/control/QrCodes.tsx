// Printable QR codes: an A4 poster per entrance and a sheet of room stickers. They open the phone app (#/go).
import { siteUrl, type Control } from '../platform/api.ts'
import ExitIcon from '../ExitIcon.tsx'
import Qr from './Qr.tsx'
import usePrint from './usePrint.tsx'
import { floorName, floorsOf } from './util.ts'

const isLocal = () => /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) || location.hostname.endsWith('.local')

export default function QrCodes({ data, siteId }: { data: Control; siteId: string }) {
  const [layer, print] = usePrint()
  const b = data.site.building
  const base = siteUrl()
  const sid = encodeURIComponent(siteId)
  const gateUrl = (x: string) => `${base}#/go?site=${sid}&gate=${encodeURIComponent(x)}`
  const roomUrl = (r: string) => `${base}#/go?site=${sid}&room=${encodeURIComponent(r)}`
  const order = Object.fromEntries(floorsOf(b).map((f, i) => [f.id, i]))
  const rooms = b.nodes.filter(n => n.type === 'room').sort((x, y) => (order[x.floor_id ?? ''] ?? 0) - (order[y.floor_id ?? ''] ?? 0) || (x.label ?? x.id).localeCompare(y.label ?? y.id, undefined, { numeric: true }))
  const exits = data.exits

  const posters = () => exits.map(x => <Poster key={x.id} site={data.site.name} exit={x.label} url={gateUrl(x.id)} />)
  const stickers = () => (
    <div className="cr-stickers">
      {rooms.map(r => <Sticker key={r.id} site={data.site.name} room={r.label ?? r.id} floor={floorName(b, r.floor_id)} url={roomUrl(r.id)} />)}
    </div>
  )

  return (
    <div className="cr-qrs">
      {isLocal()
        ? <p className="pf-alert warn cr-gap">These codes point at <strong>{base}</strong>, a local address other phones cannot open. Print them from the public HTTPS site.</p>
        : <p className="pf-alert info cr-gap">These codes point at <strong>{base}</strong>. Phones need this public HTTPS address for alerts to work.</p>}

      <section className="pf-card cr-gap" aria-labelledby="cr-qr-gate-h">
        <div className="cr-card-head">
          <h2 id="cr-qr-gate-h">Entrance posters</h2>
          <button type="button" className="pf-btn primary" onClick={() => print(posters(), 'posters')}>Print posters ({exits.length})</button>
        </div>
        <p className="pf-muted pf-small">One A4 poster per entrance. Scanning checks a phone in; scanning again on the way out asks “Leaving?”.</p>
        <div className="cr-poster-grid">
          {exits.map(x => (
            <div key={x.id} className="cr-poster-preview">
              <Poster site={data.site.name} exit={x.label} url={gateUrl(x.id)} />
              <div className="cr-poster-actions">
                <button type="button" className="pf-btn cr-btn-s" onClick={() => print(<Poster site={data.site.name} exit={x.label} url={gateUrl(x.id)} />, 'posters')}>Print this poster</button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="pf-card" aria-labelledby="cr-qr-room-h">
        <div className="cr-card-head">
          <h2 id="cr-qr-room-h">Room stickers</h2>
          <button type="button" className="pf-btn primary" onClick={() => print(stickers(), 'stickers')}>Print stickers ({rooms.length})</button>
        </div>
        <p className="pf-muted pf-small">Stick one inside each room by the door. Scanning tells Nikaas which room a phone is in, so its route starts there.</p>
        <div className="cr-sticker-preview">{stickers()}</div>
      </section>
      {layer}
    </div>
  )
}

function Poster({ site, exit, url }: { site: string; exit: string; url: string }) {
  return (
    <article className="cr-poster">
      <div className="cr-poster-brand"><span className="cr-poster-mark"><ExitIcon /></span>Nikaas</div>
      <p className="cr-poster-site">{site}</p>
      <Qr url={url} label={`QR code for ${exit}`} className="cr-poster-qr" />
      <h3 className="cr-poster-call">Scan when you enter.</h3>
      <p className="cr-poster-sub">Get alerts and your way out.</p>
      <p className="cr-poster-gate">Entrance: {exit}</p>
      <p className="cr-poster-note">No app or sign-up. Your phone stays anonymous.</p>
    </article>
  )
}

function Sticker({ site, room, floor, url }: { site: string; room: string; floor: string; url: string }) {
  return (
    <article className="cr-sticker">
      <Qr url={url} label={`QR code for ${room}`} className="cr-sticker-qr" />
      <div className="cr-sticker-text">
        <strong>{room}</strong>
        {floor && <span>{floor}</span>}
        <span className="cr-sticker-call">Scan to check in to this room</span>
        <span className="cr-sticker-site">{site}</span>
      </div>
    </article>
  )
}
