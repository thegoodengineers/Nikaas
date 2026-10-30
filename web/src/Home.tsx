import { useEffect, useRef, useState } from 'react'
import LiveHero from './LiveHero.tsx'
import View3D, { type Building, type Frame } from './View3D.tsx'

type Validation = { published_s: number; ours_s: number; error_pct: number }
type Wow = { building: string; blocked: string; people: number; nearest_s: number; nikaas_s: number; pct_saved: number; gap_s: number; lower_bound_s: number }
type Run = { frames: Frame[]; door_routes?: Record<string, string[][]>; bottleneck?: string; peak_queue?: number; total_time_s: number }

// The scroll film: one pinned 3D stage; scrolling moves the camera and advances the story.
// Chapter boundaries are fractions of the film's scroll length.
const CHAPTERS = [
  { at: 0.00, title: 'The map on the wall.', body: 'Every building has one. It says “go to the nearest exit”.' },
  { at: 0.16, title: 'It becomes a building.', body: 'Rooms, doors, corridors and stairs, read from the photo and checked before anything is trusted.' },
  { at: 0.34, title: '{people} people take the nearest exit.', body: 'Each door and stair lets through only as many people per second as its width allows.' },
  { at: 0.52, title: 'One door jams.', body: 'Everyone near the verandah door picks the same way out. The queue grows while other exits wait.' },
  { at: 0.70, title: 'Nikaas re-plans.', body: 'Each room gets the exit that empties the building fastest. The green routes are the new plan.' },
  { at: 0.88, title: '', body: '' }, // the number
]

// Every number on this page is loaded from files generated out of runs/.
export default function Home() {
  const [val, setVal] = useState<Validation>()
  const [qa, setQa] = useState<{ score: number }>()
  const [wow, setWow] = useState<Wow[]>([])
  const [building, setBuilding] = useState<Building>()
  const [nearest, setNearest] = useState<Run>()
  const [nikaas, setNikaas] = useState<Run>()
  const [t, setT] = useState(0)
  const film = useRef<HTMLDivElement>(null)
  const [stageH, setStageH] = useState(() => Math.max(420, window.innerHeight - 64))

  useEffect(() => {
    fetch('data/validation.json').then(r => r.json()).then(setVal).catch(() => {})
    fetch('data/vision_nova_pro_qa.json').then(r => r.json()).then(setQa).catch(() => {})
    fetch('data/wow.json').then(r => r.json()).then(setWow).catch(() => {})
    fetch('data/iit_kgp_museum.json').then(r => r.json()).then(setBuilding).catch(() => {})
    fetch('data/frames_iit_kgp_nearest.json').then(r => r.json()).then(setNearest).catch(() => {})
    fetch('data/frames_iit_kgp_nikaas.json').then(r => r.json()).then(setNikaas).catch(() => {})
  }, [])
  useEffect(() => {
    const on = () => {
      const el = film.current
      if (!el) return
      const r = el.getBoundingClientRect(), total = el.offsetHeight - window.innerHeight
      setT(Math.max(0, Math.min(1, -r.top / Math.max(1, total))))
    }
    const size = () => setStageH(Math.max(420, window.innerHeight - 64))
    on(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', size)
    return () => { removeEventListener('scroll', on); removeEventListener('resize', size) }
  }, [])

  const w = (b: string, blocked = '') => wow.find(x => x.building === b && x.blocked === blocked)
  const lab = w('lab_block.json'), iit = w('iit_kgp_museum.json'), iitB = w('iit_kgp_museum.json', 'MAIN')

  // what the stage shows at scroll position t
  const ch = CHAPTERS.reduce((k, c, i) => (t >= c.at ? i : k), 0)
  const run = t < 0.70 ? nearest : nikaas
  const local = (a: number, b: number) => Math.max(0, Math.min(1, (t - a) / (b - a)))
  const frameIdx = run ? Math.floor((t < 0.70 ? local(0.34, 0.66) : local(0.70, 0.95)) * (run.frames.length - 1)) : 0
  const wallRise = 0.02 + 0.98 * local(0.14, 0.30)
  const photoOpacity = 1 - local(0.08, 0.2)
  const showPeople = t >= 0.30

  return (
    <div>
      <LiveHero />

      <section id="film" ref={film} className="film" style={{ height: '520vh' }}>
        <div className="film-stage" style={{ height: stageH }}>
          {building && <View3D building={building} frame={showPeople ? run?.frames[frameIdx] : undefined} blocked={[]}
            routes={t >= 0.70 ? nikaas?.door_routes : undefined}
            bottleneck={t >= 0.46 && t < 0.70 ? nearest?.bottleneck : undefined} peakQueue={nearest?.peak_queue}
            cameraT={t} wallRise={wallRise} height={stageH} onExit={() => { location.hash = '#/twin' }} />}
          <img className="film-photo" src="data/iit_kgp_nmst_block_b.jpg" alt="The posted floor plan of the IIT Kharagpur museum"
            style={{ opacity: photoOpacity, pointerEvents: 'none' }} />
          <div className="film-text">
            {ch < CHAPTERS.length - 1 ? (
              <div key={ch} className="film-card">
                <h2>{CHAPTERS[ch].title.replace('{people}', String(iit?.people ?? '…'))}</h2>
                <p>{CHAPTERS[ch].body}</p>
              </div>
            ) : (
              <div key="num" className="film-card">
                <div className="film-big">{iit ? `${(iit.nearest_s - iit.nikaas_s).toFixed(1)} s faster` : '…'}</div>
                <p>{iit ? `Everyone out in ${iit.nikaas_s} s instead of ${iit.nearest_s} s, on this floor, with the same doors.` : ''}</p>
              </div>
            )}
          </div>
          <div className="film-progress" aria-hidden="true"><span style={{ width: `${t * 100}%` }} /></div>
        </div>
      </section>

      <div className="page">
        <section className="stats" aria-label="Measured results">
          <div>
            <div className="big green">{lab ? `${lab.pct_saved}%` : '…'}</div>
            <p>{lab ? `faster on a ${lab.people}-person lab block: ${lab.nearest_s} s with the nearest-exit rule, ${lab.nikaas_s} s with the Nikaas plan, ${lab.gap_s} s above the proven fastest possible.` : ''}</p>
          </div>
          <div>
            <div className="big">{iitB ? `${iitB.nikaas_s} s` : '…'}</div>
            <p>{iitB ? `with the IIT Kharagpur main entrance blocked, down from ${iitB.nearest_s} s.` : ''}</p>
          </div>
          <div>
            <div className="big">{val ? `${val.ours_s} s` : '…'}</div>
            <p>{val ? `against ${val.published_s} s in the fire-engineering handbook’s worked example (SFPE), ${val.error_pct}% apart.` : ''}</p>
          </div>
        </section>
        <p className="sources">Movement times, the part an exit plan can change. Every number is generated from the project’s run files; see Evidence.</p>

        <section className="section">
          <h2>Three crowds that had one way out.</h2>
          <div className="incidents">
            <div><b>22</b><p>students died in the 2019 Surat coaching-centre fire after the escape stair burned.</p></div>
            <div><b>23</b><p>people died on one overloaded footbridge at Elphinstone Road, Mumbai, in 2017.</p></div>
            <div><b>11</b><p>people were killed outside Chinnaswamy Stadium, Bengaluru, on 4 June 2025.</p></div>
          </div>
          <p className="sources">Sources: Wikipedia articles on each incident; Hindustan Times; CNN; India Today.</p>
        </section>

        <section className="section">
          <h2>From a photo to a plan.</h2>
          <ol className="steps">
            <li><h3>Photograph the map</h3><p>A vision model reads rooms, corridors and exits from any posted evacuation plan.</p></li>
            <li><h3>Check the building</h3><p>A quality check flags missing exits and impossible doors before a number is trusted.</p></li>
            <li><h3>Simulate every person</h3><p>Flow limits per metre of door and stair width, validated against the SFPE handbook.</p></li>
            <li><h3>Plan and re-plan</h3><p>Each room gets an exit. Block a stair and the plan is rebuilt in seconds.</p></li>
          </ol>
        </section>

        <section className="section faq">
          <h2>Questions a fire engineer would ask.</h2>
          <details>
            <summary>How do you know the simulator is right?</summary>
            <p>It reproduces the worked evacuation example in the SFPE fire-engineering guide: {val ? `${val.ours_s} s against the published ${val.published_s} s` : '…'}. Doors, corridors and stairs pass only as many people per second as their effective width allows, using the handbook’s flow rates. The check runs as a test on every change.</p>
          </details>
          <details>
            <summary>Better than the nearest exit, but is the plan any good?</summary>
            <p>We also compute a proven lower bound: a network-flow model that no plan can beat with the same exits and widths. On the IIT Kharagpur floor the Nikaas plan is {iit ? `${iit.gap_s} s above that bound (${iit.nikaas_s} s against ${iit.lower_bound_s} s)` : '…'}. Every row is on the Evidence page.</p>
          </details>
          <details>
            <summary>What if the photo is read wrong?</summary>
            <p>Nothing is trusted straight from the photo. A quality check scores the building first: missing exits, exits too narrow for the people behind them, too few exits under the National Building Code. The museum read by Amazon Nova Pro scored {qa ? `${qa.score} out of 100` : '…'}: it found only one exit, too narrow for everyone behind it. The Twin shows those warnings beside it, and we plan with the hand-checked building.</p>
          </details>
          <details>
            <summary>Is this for a real fire?</summary>
            <p>Today it is for planning and drills: which room should use which exit, and what changes when a stair is blocked. Re-planning runs on AWS in seconds. The times are movement times; detection, alarm and reaction time come on top and an exit plan does not change them.</p>
          </details>
          <details>
            <summary>Why not use existing egress software?</summary>
            <p>Tools such as Pathfinder and MassMotion are built for fire engineers working from CAD or BIM models. Many buildings have no such model. They do have the evacuation map on the wall, and Nikaas starts from that photo.</p>
          </details>
        </section>

        <section className="closing">
          <h2>Your building has a map on the wall.</h2>
          <div className="cta-row"><a className="cta" href="#/twin">Open the twin</a><a className="cta quiet" href="#/beat">Try to beat the plan</a></div>
        </section>
      </div>
    </div>
  )
}
