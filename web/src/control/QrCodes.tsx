// One printable QR code per building. Scanning it opens the phone app (#/go) to turn on emergency alerts;
// people choose their room when an alarm comes, so rooms need no codes of their own.
import { siteUrl, type Control } from '../platform/api.ts'
import ExitIcon from '../ExitIcon.tsx'
import Qr from './Qr.tsx'
import usePrint from './usePrint.tsx'

const isLocal = () => /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname) || location.hostname.endsWith('.local')

export default function QrCodes({ data, siteId }: { data: Control; siteId: string }) {
  const [layer, print] = usePrint()
  const url = `${siteUrl()}#/go?site=${encodeURIComponent(siteId)}`
  const poster = <Poster site={data.site.name} url={url} />
  return (
    <div className="cr-qrs">
      {isLocal()
        ? <p className="pf-alert warn cr-gap">This code points at <strong>{siteUrl()}</strong>, a local address other phones cannot open. Print it from the public HTTPS site.</p>
        : <p className="pf-alert info cr-gap">This code points at <strong>{siteUrl()}</strong>, the public HTTPS address phones need.</p>}
      <section className="pf-card cr-gap" aria-labelledby="cr-qr-h">
        <div className="cr-card-head">
          <h2 id="cr-qr-h">Building QR code</h2>
          <button type="button" className="pf-btn primary" onClick={() => print(poster, 'posters')}>Print poster</button>
        </div>
        <p className="pf-muted pf-small">One code for the whole building: put copies at the entrances and the registration desk. People scan it once and
          tap Turn on alerts. When you raise the alarm, every phone gets a notification; they choose their room and get their own route out.</p>
        <div className="cr-poster-grid"><div className="cr-poster-preview">{poster}</div></div>
        <p className="pf-small pf-muted">Link: <code>{url}</code></p>
      </section>
      {layer}
    </div>
  )
}

function Poster({ site, url }: { site: string; url: string }) {
  return (
    <article className="cr-poster">
      <div className="cr-poster-brand"><span className="cr-poster-mark"><ExitIcon /></span>Nikaas</div>
      <p className="cr-poster-site">{site}</p>
      <Qr url={url} label={`QR code for ${site}`} className="cr-poster-qr" />
      <h3 className="cr-poster-call">Scan to get emergency alerts.</h3>
      <p className="cr-poster-sub">Tap Turn on alerts. In an emergency your phone shows your own way out.</p>
      <p className="cr-poster-note">No app to install. No name or number needed. Your sign-up is deleted after 24 hours.</p>
    </article>
  )
}
