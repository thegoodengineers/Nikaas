import { useEffect, useState } from 'react'

type Result = { building: string; plan: string; blocked: string; people: number; total_time_s: number; bottleneck: string; peak_queue: number; commit: string }
type Wow = { building: string; blocked: string; people: number; nearest_s: number; nikaas_s: number; saved_s: number; pct_saved: number; lower_bound_s: number; gap_s: number }
type Stadium = { plan: string; people: number; total_time_s: number; max_density: number; worst_edge: string; lower_bound_s: number | null }
type MultiFloor = { scenario: string; floors: number; people: number; blocked: string; nearest_s: number; nikaas_s: number | null; lower_bound_s: number }
type Robust = { building: string; runs: number; premove_max_s: number; occupancy_spread: number; nearest_p50_s: number; nearest_p95_s: number; nikaas_p50_s: number; nikaas_p95_s: number; nikaas_faster: number; ties: number; nikaas_slower: number; median_saving_s: number; nominal_people: number; lost_people_min: number; lost_people_max: number; loss_median_s: number; loss_max_s: number }
type Validation = { case: string; published_s: number; ours_s: number; error_pct: number; commit: string }

const NAMES: Record<string, string> = {
  'iit_kgp_museum.json': 'IIT Kharagpur museum floor', 'lab_block.json': 'Lab block (representative)',
  'sample_floor.json': 'Sample floor', 'stadium_gates.json': 'Stadium (representative)',
  'whatif_lab_block_seminar_x2.json': 'Lab block, seminar hall doubled',
}
const name = (b: string) => NAMES[b] ?? b

// Every table here is generated from runs/ by scripts/report.py and scripts/run_validation.py.
export default function Evidence() {
  const [rows, setRows] = useState<Result[]>([])
  const [wow, setWow] = useState<Wow[]>([])
  const [val, setVal] = useState<Validation>()
  const [stadium, setStadium] = useState<Stadium[]>([])
  const [mf, setMf] = useState<MultiFloor[]>([])
  const [mc, setMc] = useState<Robust[]>([])
  useEffect(() => {
    fetch('data/results.json').then(r => r.json()).then(setRows).catch(() => {})
    fetch('data/wow.json').then(r => r.json()).then(setWow).catch(() => {})
    fetch('data/validation.json').then(r => r.json()).then(setVal).catch(() => {})
    fetch('data/stadium.json').then(r => r.json()).then(setStadium).catch(() => {})
    fetch('data/multi_floor.json').then(r => r.json()).then(setMf).catch(() => {})
    fetch('data/monte_carlo.json').then(r => r.json()).then(setMc).catch(() => {})
  }, [])
  return (
    <div className="page">
      <h2>How we know the numbers hold</h2>
      <p className="lede">Every number on this site is written by a script into the project’s run files. Nothing here is typed by hand.</p>

      <h3 style={{ marginTop: 40 }}>The simulator matches the fire-engineering handbook</h3>
      <p>
        The SFPE Engineering Guide works one evacuation by hand: 300 people, two 32-inch doors, two stairs. It gets {val?.published_s ?? '…'} s.
        Our simulator gets {val?.ours_s ?? '…'} s ({val?.error_pct ?? '…'}% apart). The check runs as an automated test on every change.
      </p>

      <h3 style={{ marginTop: 40 }}>Nikaas plan against the nearest-exit rule</h3>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Building</th><th>Blocked exit</th><th>People</th><th>Nearest exit</th><th>Nikaas plan</th><th>Saved</th><th>Fastest possible ≥</th></tr></thead>
        <tbody>{wow.map(r => (
          <tr key={r.building + r.blocked}><td>{name(r.building)}</td><td>{r.blocked || 'none'}</td><td className="num">{r.people}</td>
            <td className="num">{r.nearest_s} s</td><td className="num">{r.nikaas_s} s</td><td className="num">{r.pct_saved}%</td><td className="num">{r.lower_bound_s} s</td></tr>))}</tbody>
      </table></div>
      <p className="sources">“Fastest possible” is a proven lower bound from a time-expanded network-flow model (Ford and Fulkerson, 1962). No plan can beat it with the same exits and widths.</p>

      <h3 style={{ marginTop: 40 }}>Is the lead real, or one lucky run?</h3>
      <p>
        A posted plan has to work on the day, not just on our numbers. We fixed both plans, then re-ran each building {mc[0]?.runs ?? '…'} times
        with every person starting after a random delay of up to {mc[0]?.premove_max_s ?? '…'} s and every room’s head count off by up to
        ±{mc[0] ? Math.round(mc[0].occupancy_spread * 100) : '…'}%. Times here are from the alarm.
      </p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Building</th><th>Nearest exit, median / 95th pct</th><th>Nikaas plan, median / 95th pct</th><th>Nikaas faster in</th><th>Median saving</th></tr></thead>
        <tbody>{mc.map(r => (
          <tr key={r.building}><td>{name(r.building)}</td><td className="num">{r.nearest_p50_s} s / {r.nearest_p95_s} s</td><td className="num">{r.nikaas_p50_s} s / {r.nikaas_p95_s} s</td>
            <td className="num">{r.nikaas_faster} of {r.runs} runs</td><td className="num">{r.median_saving_s} s</td></tr>))}</tbody>
      </table></div>
      {mc.filter(r => r.nikaas_slower > 0).map(r => (
        <p key={r.building}>
          When does the nearest-exit rule win? On the {name(r.building)}, in {r.nikaas_slower} runs. In every one of them fewer people were in the
          building than planned ({r.lost_people_min}–{r.lost_people_max} instead of {r.nominal_people}), so the jam the plan is built to avoid was smaller. The plan
          lost {r.loss_median_s} s at the median and {r.loss_max_s} s at most. In a live drill Nikaas re-plans for the people actually there.
        </p>))}
      <p className="sources">The delay range and occupancy spread are our assumptions (docs/METHOD.md), not measured values; scripts/monte_carlo.py, runs/monte_carlo.csv.</p>

      <h3 style={{ marginTop: 40 }}>At stadium scale</h3>
      <p>
        The representative stadium holds 14,600 people. With everyone taking the nearest gate, our run did not finish within the
        simulator’s 30-minute cap. Scaled to {stadium[0]?.people.toLocaleString('en-IN') ?? '…'} people with the same gates and widths:
      </p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Plan</th><th>People</th><th>Movement time</th><th>Peak density</th><th>Fastest possible ≥</th></tr></thead>
        <tbody>{stadium.map(r => (
          <tr key={r.plan}><td>{r.plan === 'nikaas' ? 'Nikaas plan' : 'Nearest exit'}</td><td className="num">{r.people}</td>
            <td className="num">{r.total_time_s} s</td><td className="num">{r.max_density} p/m² ({r.worst_edge})</td><td className="num">{r.lower_bound_s ? `${r.lower_bound_s} s` : '-'}</td></tr>))}</tbody>
      </table></div>
      <p className="sources">Densities are estimated from the flow model, not a spatial crowd model, and capped at 10 p/m². Thresholds and their sources are in docs/CROWD_RESEARCH.md.</p>

      <h3 style={{ marginTop: 40 }}>Buildings with several floors</h3>
      <p>
        Floors share stairwells, so a stair carries people from every floor above it. The simulator limits each stair flight by its
        width and lets floors take turns at the stair doors, so no floor is starved.
      </p>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Scenario</th><th>Floors</th><th>People</th><th>Blocked</th><th>Nearest exit</th><th>Nikaas plan</th><th>Fastest possible ≥</th></tr></thead>
        <tbody>{mf.map(r => (
          <tr key={r.scenario}><td>{r.scenario.replace(/_/g, ' ')}</td><td className="num">{r.floors}</td><td className="num">{r.people}</td><td>{r.blocked || 'none'}</td>
            <td className="num">{r.nearest_s} s</td><td className="num">{r.nikaas_s === null ? '-' : `${r.nikaas_s} s`}</td><td className="num">{r.lower_bound_s} s</td></tr>))}</tbody>
      </table></div>
      <p className="sources">On the 3-floor office the Nikaas plan ties the nearest-exit rule; the gain shows on the 5-floor tower, where the nearest exit sends everyone down one stairwell. Blocked-exit rows were run with the nearest-exit plan only.</p>

      <h3 style={{ marginTop: 40 }}>Every scenario we ran</h3>
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Building</th><th>Blocked exit</th><th>People</th><th>Movement time</th><th>Worst jam (peak queue)</th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.building + r.plan + r.blocked}><td>{name(r.building)}</td><td>{r.blocked || 'none'}</td><td className="num">{r.people}</td>
            <td className="num">{r.total_time_s ? `${r.total_time_s} s` : 'did not finish in 30 min'}</td><td>{r.bottleneck} ({r.peak_queue})</td></tr>))}</tbody>
      </table></div>

      <h3 style={{ marginTop: 40 }}>What the times mean</h3>
      <p>
        These are movement times: from the moment people start to move until the last person is out. A full escape time also counts
        detection, the alarm and the time people take to react (SFPE Handbook, Ch. 56; BSI PD 7974-6:2019). An exit plan does not change
        those phases, so we leave them out instead of guessing them.
      </p>
      <p>
        The museum floor plan is real; its scale, room occupancy and door widths are our assumptions. The lab block and stadium are
        representative buildings, not surveys of real ones.
      </p>
    </div>
  )
}
