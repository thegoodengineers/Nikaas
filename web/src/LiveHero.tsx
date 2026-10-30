import { useEffect, useState } from 'react'
import ExitIcon from './ExitIcon.tsx'
import View3D, { type Building, type Frame } from './View3D.tsx'

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
type Run = { frames: Frame[]; door_routes?: Record<string, string[][]>; bottleneck?: string; peak_queue?: number; total_time_s: number; people?: number }

// The opening seconds: the building is already evacuating, full screen, and the first click starts a fire.
export default function LiveHero() {
  const [building, setBuilding] = useState<Building>()
  const [run, setRun] = useState<Run>()
  const [i, setI] = useState(0)
  const [fire, setFire] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [h, setH] = useState(() => Math.max(520, window.innerHeight - 64))

  useEffect(() => {
    fetch('data/iit_kgp_museum.json').then(r => r.json()).then(setBuilding)
    fetch('data/frames_iit_kgp_nikaas.json').then(r => r.json()).then(setRun)
    const size = () => setH(Math.max(520, window.innerHeight - 64))
    addEventListener('resize', size); return () => removeEventListener('resize', size)
  }, [])
  useEffect(() => {
    if (!run) return
    const id = setInterval(() => setI(k => (k + 1 >= run.frames.length ? 0 : k + 1)), 110)
    return () => clearInterval(id)
  }, [run])

  // ?fire=MAIN starts that fire 3 s after load, so recordings and the demo video need no clicking in 3D
  useEffect(() => {
    const f = new URLSearchParams(location.search).get('fire')
    if (!f || !building || !run) return
    const id = setTimeout(() => burn(f), 3000)
    return () => clearTimeout(id)
  }, [building, !!run]) // eslint-disable-line react-hooks/exhaustive-deps

  async function burn(exit: string) {
    if (!building || busy) return
    if (fire === exit) { // tap again to put it out
      setFire(undefined); setI(0); fetch('data/frames_iit_kgp_nikaas.json').then(r => r.json()).then(setRun); return
    }
    setBusy(true); setFire(exit)
    try {
      let r: Run
      if (exit === 'MAIN') r = await (await fetch('data/frames_iit_kgp_nikaas_blockedMAIN.json')).json()
      else {
        // an error answer has no frames: keep the current run instead of breaking the hero
        const post = async (path: string, body: unknown) => {
          const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          if (!res.ok) throw new Error(`Server error ${res.status}`)
          return res.json()
        }
        const o = await post('/optimise', { building, blocked: [exit], simulate: true })
        r = o.run ?? await post('/simulate', { building, blocked: [exit], plan: o.plan })
      }
      setI(0); setRun(r)
    } catch { setFire(undefined) } finally { setBusy(false) }
  }

  const f = run?.frames[i]
  const total = f?.people.length ?? 0, out = f?.people.filter(p => p[2] === 'out').length ?? 0
  const fireLabel = building?.nodes.find(n => n.id === fire)?.label
  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

  return (
    <section className="live-hero" style={{ height: h }}>
      {building && <View3D building={building} frame={f} blocked={fire ? [fire] : []} routes={run?.door_routes}
        bottleneck={run?.bottleneck} peakQueue={run?.peak_queue} height={h} showcase onExit={burn} />}
      <div className="lh-copy">
        <h1>Photograph the exit map. <span className="runner"><ExitIcon /></span> Get everyone out faster.</h1>
        <p>Nikaas turns the evacuation map on a wall into a live model of the building. People check in with their phone, get their own way out in an emergency, and the control room sees who is safe.</p>
        <div className="cta-row" style={{ justifyContent: 'flex-start' }}>
          <a className="cta" href="#/control">Open the control room</a>
          <a className="cta quiet" href="#/go?site=office">Try the phone app</a>
        </div>
      </div>
      <div className="lh-live" aria-live="polite">
        <b>{out}</b><span> of {total} people out</span><em>{mmss(f?.t ?? 0)}</em>
      </div>
      <div className={`lh-hint ${fire ? 'on-fire' : ''}`}>
        {busy ? 'Re-planning every room…'
          : fire ? <>Fire at {fireLabel}. Everyone was re-routed. <button onClick={() => burn(fire)}>Put it out</button></>
          : <><i className="pulse" /> Select an exit to simulate a fire there</>}
      </div>
    </section>
  )
}
