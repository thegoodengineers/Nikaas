// Emergency texts: who is registered, whether texts can reach them, and a test message.
import { ago, api } from '../platform/api.ts'
import type { PanelProps } from './util.ts'

export default function SmsPanel({ data, siteId, act }: PanelProps) {
  const s = data.sms
  const phones = data.people.filter(p => p.phone)
  if (!s) return null
  const provider = { sns: 'Amazon SNS', fast2sms: 'Fast2SMS', twilio: 'Twilio', log: 'Local test outbox' }[s.provider] ?? s.provider
  return (
    <section className="pf-card cr-sms" aria-labelledby="cr-sms-h">
      <div className="cr-card-head">
        <h2 id="cr-sms-h">Emergency texts</h2>
        <span className={`pf-chip ${s.verified ? 'ok' : ''}`}>{s.verified} verified</span>
      </div>
      <p className="pf-small pf-muted">Starting the alarm texts every verified phone a link to its own route; All clear texts them too. Sent with {provider}.</p>
      {s.sandbox && (
        <p className="pf-alert warn pf-small">Amazon SNS test mode: texts reach only numbers verified with a code (at most {s.sandbox_limit}), with a USD 1 monthly budget.
          Ask AWS Support to move SMS to production for any number.</p>
      )}
      {s.last && <p className="pf-small">Last send ({s.last.kind}): <b>{s.last.sent}</b> sent{s.last.failed ? <>, <b className="cr-t-bad">{s.last.failed} failed</b></> : ''} · {ago(s.last.at)}</p>}
      {phones.length === 0 ? <p className="pf-empty">No phone numbers yet. People register by scanning the building QR code (QR codes tab).</p> : (
        <ul className="cr-list cr-scroll">
          {phones.map(p => (
            <li key={p.token} className="cr-li">
              <span className="cr-li-main">{p.phone}<span className="pf-muted pf-small"> · {p.room_label ?? 'room not given'}</span></span>
              <span className="cr-li-meta pf-small">
                {!p.phone_verified ? <span className="pf-chip warn">not verified</span>
                  : p.sms_last ? <span className={`pf-chip ${p.sms_last.ok ? 'ok' : 'bad'}`} title={p.sms_last.error ?? undefined}>{p.sms_last.ok ? 'sent' : 'failed'}: {p.sms_last.kind}</span>
                    : <span className="pf-chip ok">ready</span>}
                {p.phone_verified && <button type="button" className="pf-btn cr-btn-s" onClick={() => act(() => api.post(`/sites/${encodeURIComponent(siteId)}/sms/test`, { person: p.token }, true), r => (r as { failed?: number }).failed ? 'The test text failed: see the event feed' : `Test text sent to ${p.phone}`)}>Test</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
