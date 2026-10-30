// Beside the floor plan: what needs someone now (help requests, rooms cut off, hazards), then the exits.
import { ago, api, fmtTime } from '../platform/api.ts'
import { HAZARD_LABEL, NEED_LABEL, SOURCE_LABEL, nodeLabel, useBusy, type PanelProps } from './util.ts'

type Item = { key: string; tone: 'help' | 'cut' | 'fire'; title: string; sub: string; node: string | null; hazard?: string }

export function Attention({ data, siteId, act, onShow }: PanelProps & { onShow: (node: string) => void }) {
  const [busy, run] = useBusy()
  const b = data.site.building
  const items: Item[] = []
  // help requests, one line per room
  const rooms = new Map<string, typeof data.help>()
  for (const p of data.help) rooms.set(p.room ?? '', [...(rooms.get(p.room ?? '') ?? []), p])
  for (const [room, ps] of rooms) {
    const needs = [...new Set(ps.map(p => (p.need && NEED_LABEL[p.need]) || 'Asked for help'))].join(', ')
    const last = Math.max(...ps.map(p => p.updated_at))
    items.push({ key: `h-${room}`, tone: 'help', title: `Help · ${room ? nodeLabel(b, room) : 'Room not known'}`,
      sub: `${ps.length > 1 ? `${ps.length} people · ` : ''}${needs} · ${ago(last)}`, node: room || null })
  }
  const cut = data.alarm?.trapped ?? []
  if (cut.length) items.push({ key: 'cut', tone: 'cut', title: `Cut off · ${cut.map(id => nodeLabel(b, id)).join(', ')}`,
    sub: 'No way out. Their phones are sent to a refuge to wait for rescue.', node: cut[0] })
  // the server's label adds the floor; walkway points without a name get one from the nearest named place
  const where = (node: string, label?: string) => (b.nodes.find(n => n.id === node)?.label && label) || nodeLabel(b, node)
  for (const h of [...data.hazards].reverse()) items.push({ key: h.id, tone: 'fire', title: `${HAZARD_LABEL[h.kind] ?? 'Hazard'} · ${where(h.node, h.label)}`,
    sub: `${SOURCE_LABEL[h.source ?? 'manual'] ?? h.source}${h.confidence != null ? ` ${Math.round(h.confidence * 100)}%` : ''}${h.at ? ` · ${ago(h.at)}` : ''}`, node: h.node, hazard: h.id })

  return (
    <section className={`pf-card cr-attn ${items.length ? 'on' : ''}`} aria-labelledby="cr-attn-h">
      <div className="cr-card-head">
        <h2 id="cr-attn-h">Needs attention <span className={`pf-chip ${items.length ? 'bad' : 'ok'}`}>{items.length}</span></h2>
      </div>
      {items.length === 0 ? <p className="pf-empty">Nothing right now. Help requests, rooms cut off by a hazard and reported hazards show up here.</p> : (
        <ul className="cr-attn-list">
          {items.map(it => (
            <li key={it.key} className={`t-${it.tone}`}>
              <span className="cr-attn-ic" aria-hidden="true">{it.tone === 'help' ? '!' : it.tone === 'cut' ? '✕' : '▲'}</span>
              <div className="cr-attn-text"><strong>{it.title}</strong><small>{it.sub}</small></div>
              <div className="cr-attn-act">
                {it.node && <button type="button" className="cr-link" onClick={() => onShow(it.node!)}>Show</button>}
                {it.hazard && <button type="button" className="cr-link" disabled={!!busy} onClick={() => run(it.hazard!, () => act(() => api.del(`/sites/${encodeURIComponent(siteId)}/hazards/${encodeURIComponent(it.hazard!)}`, true), 'Hazard cleared. Routes are being re-planned.'))}>{busy === it.hazard ? 'Clearing…' : 'Clear'}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function ExitList({ data }: { data: PanelProps['data'] }) {
  const a = data.alarm
  return (
    <section className="pf-card cr-exitlist" aria-labelledby="cr-exl-h">
      <div className="cr-card-head">
        <h2 id="cr-exl-h">Exits</h2>
        {a && <span className="pf-muted pf-small">heading · out · clear in</span>}
      </div>
      <ul>
        {data.exits.map((x, i) => {
          const total = x.assigned + x.out
          return (
            <li key={x.id}>
              <span className="cr-exl-n" style={{ background: x.blocked ? 'var(--bad)' : x.color ?? 'var(--exit)' }} aria-hidden="true">{x.group ?? i + 1}</span>
              <span className="cr-exl-name">{x.label}</span>
              {x.blocked ? <span className="pf-chip bad">Blocked</span>
                : a ? <span className="cr-exl-nums">{x.assigned} · {x.out} out{x.eta_s != null ? ` · ${fmtTime(x.eta_s)}` : ''}</span>
                : <span className="pf-chip ok">Open</span>}
              {a && !x.blocked && (
                <span className="cr-exl-bar" role="img" aria-label={`${x.out} of ${total} out`}><i style={{ width: `${total ? (x.out / total) * 100 : 0}%`, background: x.color ?? 'var(--exit)' }} /></span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
