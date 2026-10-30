# Nikaas

![Nikaas: the building is already evacuating; a fire at the main entrance re-routes everyone](docs/img/hero.gif)

## For judges, start here
**Nikaas is an open-source evacuation digital twin** — photograph a posted exit map, and Nikaas times the evacuation and finds the room-to-exit assignment that moves everyone out fastest.

- **44.6% faster** evacuation movement time on the demo lab block: nearest-exit rule 301 s → Nikaas plan 167 s, saving 134 s for 528 people (`runs/wow.csv`).
- **Within 3.71 s of a proven lower bound** — no plan can move everyone out faster than 163.04 s with the same exits and widths, and Nikaas reaches 166.75 s (`runs/wow.csv`).
- **Validated against SFPE Handbook Example 1**: 245.25 s vs the published 245.2 s (0.05 s error, `tests/test_sim.py`).
- **Not one lucky run**: with both plans fixed and 200 random runs per building (each person starts after a random delay of up to 60 s, room head counts off by up to ±20%, our assumptions), the Nikaas plan is faster in 193 of 200 runs on the IIT Kharagpur floor (median 13.75 s saved) and 200 of 200 on the lab block (median 130.25 s) (`runs/monte_carlo_summary.csv`).
- **Multi-floor buildings with shared stairwells**: on a 5-floor tower with 450 people, the nearest-exit rule sends everyone down one stairwell (375.25 s); the Nikaas plan uses both and gets everyone out in 206.0 s, 26.27 s above the proven lower bound (`runs/multi_floor.csv`). On the 3-floor office test building the plan ties the nearest-exit rule.
- **Scales to a stadium**: a representative stadium scaled to 2,001 people, 348.5 s → 203.0 s with the same gates (`runs/stadium_results.csv`).
- **Crowd mode (opt-in)**: `POST /simulate` with `crowd: true` flags corridor and door edges above the density thresholds researched in `docs/CROWD_RESEARCH.md` (concern 2.7 p/m², crush 4 p/m²). Densities are estimated from a flow model, not a spatial crowd model, and are capped at 10 p/m².
- **Live drill**: judges scan a QR code, pick their room, and their phone shows their own exit; block an exit and every affected phone flashes red with its new route (and vibrates on Android). Phones taped beside doors become live exit signs that turn red and point to the nearest open exit.

Live site: **http://nikaas-webbucket-hbkfctr0cw8s.s3-website.ap-south-1.amazonaws.com** (Home, Twin, 3D Sim, Beat Nikaas, Live drill, Evidence; on phones `#/me` and `#/sign`). The 3D Sim page is an illustration with its own simple walkers; the validated times are on the Twin and Evidence pages · API: https://4kzez16ucj.execute-api.ap-south-1.amazonaws.com/health · Demo video: *(fill before submission)*

---

**Photograph the exit map. Get everyone out faster.** An evacuation digital twin: a building's
posted exit map becomes a graph, a simulator times the evacuation, and an optimiser assigns each
room the exit that empties the building fastest, re-planning when a stair is blocked.

Built from scratch at **AfterHours 1.0** (DBIT, 30–31 Oct 2026), Theme 03: Simulation & Digital
Twins, by **TheGoodEngineers** (team AH50): Ayush V U, Bhumika G, Abhijeet, Chirag R H.

**Working today:** simulator (SFPE-validated) · API live on AWS (`/simulate`, `/optimise`, `/beat`, `/vision`) · website with 2D + 3D twin, nearest-vs-Nikaas comparison, tap-to-block, Beat Nikaas · photo-to-building with Amazon Nova
**In progress:** Crowd mode density analysis (densities being corrected) · stadium building
**Not built yet:** multi-floor buildings · NBC travel-distance check

> Every number above comes from `runs/` or `docs/RESULTS.md`. If a number has no file behind it, it is not here.

## Validated
The simulator reproduces the SFPE Engineering Guide's Example 1 (300 people, two doors, two stairs):
**245.25 s vs the published 245.2 s** (`tests/test_sim.py::test_reproduces_sfpe_engineering_guide_example_1`).
All results: [`docs/RESULTS.md`](docs/RESULTS.md), generated from `runs/`.

## Demo building
A real posted floor-plan panel: **Nehru Museum of Science & Technology, Block B, IIT Kharagpur**,
digitised into `data/iit_kgp_museum.json` (`scripts/make_iit_kgp.py`; overlay check in
`data/maps/iit_kgp_overlay.jpg`). Scale, occupancy and exit widths are our assumptions (`docs/QUESTIONS.md`).

Photo: "Floor Plan Panel - NMST - IIT Kharagpur" by Biswarup Ganguly, CC BY 3.0, via Wikimedia Commons
(https://commons.wikimedia.org/wiki/File:Floor_Plan_Panel_-_NMST_-_IIT_Kharagpur_-_West_Midnapore_2015-09-28_4616.JPG).

## Run locally
```
pip install -r requirements.txt
python -m pytest -q
python scripts/run_nearest.py data/sample_floor.json
uvicorn nikaas.api:app --reload
```

## Layout
- `nikaas/building.py` graph loading, shortest paths, nearest-exit plan
- `nikaas/sim.py` flow-limited evacuation simulator (SFPE hydraulic model)
- `nikaas/api.py` FastAPI app
- `data/` building graphs · `runs/` measured outputs · `docs/CONTRACT.md` shared format
