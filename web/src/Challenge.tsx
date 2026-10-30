import { useEffect, useState } from 'react'
import BeatNikaas from './BeatNikaas.tsx'
import type { Building } from './View3D.tsx'

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

// Beat Nikaas: a judge plans the evacuation by hand and the server times it against the optimiser.
export default function Challenge() {
  const [building, setBuilding] = useState<Building>()
  const [startPlan, setStartPlan] = useState<Record<string, string>>()
  useEffect(() => {
    fetch('data/iit_kgp_museum.json').then(r => r.json()).then(setBuilding)
    fetch('data/frames_iit_kgp_nearest.json').then(r => r.json()).then(r => setStartPlan(r.plan))
  }, [])
  return (
    <div className="page">
      <h2>Beat Nikaas</h2>
      <p className="lede">
        Here is the IIT Kharagpur museum floor with {building ? building.nodes.reduce((n, x) => n + ((x as { people?: number }).people ?? 0), 0) : '…'} people in it. Send each room to an exit yourself, then time your plan.
        The list starts from today’s rule, everyone to the nearest exit. Nikaas has already planned the same floor.
      </p>
      <figure style={{ margin: '20px 0', maxWidth: 720 }}>
        <img src="data/iit_kgp_nmst_block_b.jpg" alt="The posted floor plan of the museum, with room names" style={{ width: '100%', display: 'block', border: '1px solid var(--tile)' }} />
        <figcaption className="sources">The floor plan the rooms below come from. Photo: Biswarup Ganguly, CC BY 3.0.</figcaption>
      </figure>
      {building && API && <BeatNikaas api={API} building={building} blocked={[]} startPlan={startPlan} />}
      {!API && <p>The challenge needs the live simulator. Run the site with <code>VITE_API_URL</code> set.</p>}
    </div>
  )
}
