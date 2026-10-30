// What happened, newest first: the last five, or all of them on request.
import { useState } from 'react'
import type { Control } from '../platform/api.ts'
import { clock } from './util.ts'

const KIND: Record<string, string> = { info: 'Info', warn: 'Warning', danger: 'Danger', good: 'Good' }

export default function EventFeed({ data }: { data: Control }) {
  const [all, setAll] = useState(false)
  const ev = [...data.events].sort((a, b) => b.at - a.at)
  return (
    <section className="pf-card" aria-labelledby="cr-feed-h">
      <div className="cr-card-head">
        <h2 id="cr-feed-h">Activity</h2>
        {ev.length > 5 && <button type="button" className="cr-link" onClick={() => setAll(v => !v)}>{all ? 'Show fewer' : `Show all ${ev.length}`}</button>}
      </div>
      {ev.length === 0 ? <p className="pf-empty">Nothing yet. Check-ins, alarms and hazards show up here.</p> : (
        <ol className="cr-feed">
          {(all ? ev : ev.slice(0, 5)).map((e, i) => (
            <li key={`${e.at}-${i}`} className={`cr-ev k-${e.kind}`}>
              <time dateTime={new Date(e.at * 1000).toISOString()}>{clock(e.at)}</time>
              <span className="cr-ev-text"><span className="cr-sr">{KIND[e.kind] ?? e.kind}: </span>{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
