// What happened, newest first.
import { ago, type Control } from '../platform/api.ts'
import { clock } from './util.ts'

const KIND: Record<string, string> = { info: 'Info', warn: 'Warning', danger: 'Danger', good: 'Good' }

export default function EventFeed({ data }: { data: Control }) {
  const ev = [...data.events].sort((a, b) => b.at - a.at)
  return (
    <section className="pf-card" aria-labelledby="cr-feed-h">
      <h2 id="cr-feed-h">Events</h2>
      {ev.length === 0 ? <p className="pf-empty">Nothing yet.</p> : (
        <ol className="cr-feed">
          {ev.map((e, i) => (
            <li key={`${e.at}-${i}`} className={`cr-ev k-${e.kind}`}>
              <span className="cr-ev-dot" aria-label={KIND[e.kind] ?? e.kind} role="img" />
              <div>
                <p className="cr-ev-text">{e.text}</p>
                <p className="cr-ev-time"><time dateTime={new Date(e.at * 1000).toISOString()}>{clock(e.at)}</time> · {ago(e.at)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
