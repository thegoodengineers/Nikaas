# Nikaas

![Nikaas: the building is already evacuating; a fire at the main entrance re-routes everyone](docs/img/hero.gif)

## For judges, start here
**▶ Demo video (3 min 20 s): https://youtu.be/zwIpXaX80vI** — the building twin, the 3D simulation, a live fire alarm reaching a phone, the live drill and the evidence.

**Nikaas is an open-source evacuation digital twin** — photograph a posted exit map, and Nikaas times the evacuation and finds the room-to-exit assignment that moves everyone out fastest.

- **44.6% faster** evacuation movement time on the demo lab block: nearest-exit rule 301 s → Nikaas plan 167 s, saving 134 s for 528 people (`runs/wow.csv`).
- **Within 3.71 s of a proven lower bound** — no plan can move everyone out faster than 163.04 s with the same exits and widths, and Nikaas reaches 166.75 s (`runs/wow.csv`).
- **Validated against SFPE Handbook Example 1**: 245.25 s vs the published 245.2 s (0.05 s error, `tests/test_sim.py`).
- **Not one lucky run**: with both plans fixed and 200 random runs per building (each person starts after a random delay of up to 60 s, room head counts off by up to ±20%, our assumptions), the Nikaas plan is faster in 193 of 200 runs on the IIT Kharagpur floor (median 13.75 s saved) and 200 of 200 on the lab block (median 130.25 s) (`runs/monte_carlo_summary.csv`).
- **Multi-floor buildings with shared stairwells**: on a 5-floor tower with 450 people, the nearest-exit rule sends everyone down one stairwell (375.25 s); the Nikaas plan uses both and gets everyone out in 206.0 s, 26.27 s above the proven lower bound (`runs/multi_floor.csv`). On the 3-floor office test building the plan ties the nearest-exit rule.
- **Scales to a stadium**: a representative stadium scaled to 2,001 people, 348.5 s → 203.0 s with the same gates (`runs/stadium_results.csv`).
- **Crowd mode (opt-in)**: `POST /simulate` with `crowd: true` flags corridor and door edges above our early-warning densities (concern 2.7 p/m², crush warning 4 p/m²), both set below the roughly 5 people/m² where published sources put crush risk (`docs/CROWD_RESEARCH.md`). Densities are estimated from a flow model, not a spatial crowd model, and are capped at 10 p/m².
- **Building-safety platform** (`docs/PLATFORM.md`): people scan a QR code at the entrance or on a room door (no name asked; a mobile number only if they opt in to emergency texts; deleted after 24 h); in an emergency their phone gets a push alert and their own step-by-step route across floors, re-planned when a hazard blocks a stair; people who cannot use stairs are sent to a refuge; outside, Google Maps walks them to the assembly point and "I'm safe" is checked against its location. The control room (`#/control`) sees who is inside, safe, missing or asking for help, starts and clears alarms, releases floors in waves, diverts rooms when an exit queues (only when the simulator confirms it is faster), and prints marshal lists and QR codes. Buildings come from a PDF or photos, one page per floor, fixed in an editor with stairs joined across floors (`#/buildings`). Heat and smoke sensors and room cameras raise hazards; a camera's suspected fire is confirmed by Amazon Rekognition. 16 tests in `tests/test_platform.py`.
- **Live drill**: judges scan a QR code, pick their room, and their phone shows their own exit; block an exit and every affected phone flashes red with its new route (and vibrates on Android). Phones taped beside doors become live exit signs that turn red and point to the nearest open exit.

## Links

**Watch and try**

| | |
|---|---|
| Demo video (3 min 20 s) | **https://youtu.be/zwIpXaX80vI** |
| Live site (HTTPS, use this one: phone alerts, GPS and the camera need it) | **https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html** |
| Live site (plain HTTP address) | http://nikaas-webbucket-hbkfctr0cw8s.s3-website.ap-south-1.amazonaws.com |
| API health check | https://4kzez16ucj.execute-api.ap-south-1.amazonaws.com/health |
| API: the demo buildings | https://4kzez16ucj.execute-api.ap-south-1.amazonaws.com/sites |
| Source code | https://github.com/thegoodengineers/Nikaas |
| Automatic deploys (every push to `main`) | https://github.com/thegoodengineers/Nikaas/actions/workflows/deploy.yml |

**Every page of the live site**

| Page | What it is | Link |
|---|---|---|
| Platform | Home: the building already evacuating; tap an exit to start a fire | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/) |
| Control room | Who is inside, safe or asking for help; start and clear alarms | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/control?site=office) |
| Buildings | Import a floor plan (PDF or photo) or draw one; edit floors and stairs | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/buildings) |
| 3D simulation | The main feature: fire, earthquake or collapse, group-by-group evacuation in 3D | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/sim) |
| Digital twin | Nearest exit vs the Nikaas plan, crowd behaviour, block an exit | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/twin) |
| Evidence | Where every number comes from: SFPE check, lower bounds, 200-run tests | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/evidence) |
| Live drill | Presenter screen with the QR code judges scan | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/drill) |
| Phone app | What people see after scanning a building QR code (alerts, route, "I'm safe") | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/go?site=office) |
| Drill phone | The judge's phone during a live drill: pick a room, follow the arrows | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/me) |
| Exit sign | A phone taped beside a door becomes a live exit sign | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/sign) |
| Room camera | A laptop camera counts people and spots fire for the control room | [open](https://nikaas-webbucket-hbkfctr0cw8s.s3.ap-south-1.amazonaws.com/index.html#/cam?site=office) |

The 3D simulation is an illustration with its own simple walkers; the validated times are on the Digital twin and Evidence pages.

**Documents**

| | |
|---|---|
| All results, generated from `runs/` | [docs/RESULTS.md](docs/RESULTS.md) |
| What our evacuation times mean (method and assumptions) | [docs/METHOD.md](docs/METHOD.md) |
| Multi-floor buildings and shared stairwells | [docs/MULTI_FLOOR_METHOD.md](docs/MULTI_FLOOR_METHOD.md) |
| Building-safety platform: check-in, alerts, control room | [docs/PLATFORM.md](docs/PLATFORM.md) |
| Crowd density research (crush-risk thresholds) | [docs/CROWD_RESEARCH.md](docs/CROWD_RESEARCH.md) |
| Building data format shared by every part | [docs/CONTRACT.md](docs/CONTRACT.md) |
| Deploying to AWS | [docs/DEPLOY.md](docs/DEPLOY.md) |
| Pitch script | [docs/PITCH.md](docs/PITCH.md) |
| Submission text | [docs/submission.md](docs/submission.md) |
| Open questions and the defaults we chose | [docs/QUESTIONS.md](docs/QUESTIONS.md) |
| Licence and third-party notices | [LICENSE](LICENSE) · [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |


---

**Photograph the exit map. Get everyone out faster.** An evacuation digital twin: a building's
posted exit map becomes a graph, a simulator times the evacuation, and an optimiser assigns each
room the exit that empties the building fastest, re-planning when a stair is blocked.

Built from scratch at **AfterHours 1.0** (DBIT, 30–31 Oct 2026), Theme 03: Simulation & Digital
Twins, by **TheGoodEngineers** (team AH50): Ayush V U, Bhumika G, Abhijeet, Chirag R H.

**Working today:** simulator (SFPE-validated) · API live on AWS (`/simulate`, `/optimise`, `/vision`) · website with 2D + 3D twin, nearest-vs-Nikaas comparison, tap-to-block · photo-to-building with Amazon Nova
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

## Licence

MIT, see [LICENSE](LICENSE). Vendored third-party code (three.js, qrcode-generator, pdf.js, TensorFlow.js, COCO-SSD) keeps its own licence, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
