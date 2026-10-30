// Header: which site, and whether the dashboard is live. The alarm state is the bar below it (AlarmPanel).
import type { Control, SiteSummary } from '../platform/api.ts'
import { useNow } from './util.ts'

type Props = { sites: SiteSummary[]; siteId: string; onSite: (id: string) => void; data: Control | null; lastOk: number; err: string | null }

export default function Header({ sites, siteId, onSite, data, lastOk, err }: Props) {
  const now = useNow(1000)
  const age = lastOk ? now - lastOk : Infinity
  const conn = age < 8 ? { k: 'ok', t: 'Live' } : lastOk && age < 30 ? { k: 'warn', t: 'Delayed' } : err || lastOk ? { k: 'bad', t: 'Offline' } : { k: 'info', t: 'Connecting' }
  const options = sites.some(s => s.id === siteId) ? sites : [...sites, { id: siteId, name: siteId } as SiteSummary]
  return (
    <header className="cr-head">
      <div className="cr-head-id">
        <p className="pf-eyebrow">Control room</p>
        <h1 className="cr-title">{data?.site.name ?? (sites.find(s => s.id === siteId)?.name || 'Site')}</h1>
        {data?.site.address && <p className="cr-addr">{data.site.address}</p>}
      </div>
      <div className="cr-head-tools">
        <label className="cr-site">
          <span>Site</span>
          <select value={siteId} onChange={e => onSite(e.target.value)}>
            {options.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <span className={`pf-chip ${conn.k}`} title={lastOk ? `Last update ${Math.round(age)} s ago` : undefined}>
          <span className={`pf-dot ${conn.k === 'ok' ? 'cr-live' : ''}`} />{conn.t}{lastOk > 0 && age >= 8 && isFinite(age) ? ` · ${Math.round(age)} s` : ''}
        </span>
      </div>
    </header>
  )
}
