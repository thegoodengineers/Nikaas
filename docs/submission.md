# Submission text (numbers only from runs/; refresh at 08:30 after the last `python scripts/report.py`)

**Project:** Nikaas — Photograph the exit map. Get everyone out faster.
**Team:** TheGoodEngineers (AH50): Ayush V U, Bhumika G, Abhijeet, Chirag R H · Theme 03: Simulation, Digital Twins & Synthetic Data
**Repo:** https://github.com/thegoodengineers/Nikaas
**Live demo:** http://nikaas-webbucket-hbkfctr0cw8s.s3-website.ap-south-1.amazonaws.com · **Video:** _(URL before submitting)_

**One paragraph:** Every building has an evacuation map on the wall, and it says one thing: go to the nearest exit. When
everyone does, one door jams while others stand empty. Nikaas turns a photo of that map into a digital twin of the
building (rooms, doors, corridors, stairs), simulates every person with the flow limits of the SFPE fire-engineering
handbook, and gives each room the exit that empties the building fastest, re-planning in seconds when an exit is
blocked. On the IIT Kharagpur museum floor (507 people) everyone is out in 124.0 s instead of 145.25 s, within 6.41 s of
a proven lower bound; with the main entrance blocked, 223.5 s instead of 318.0 s. In a live drill, every phone in the
room gets its own exit and is re-routed the moment a fire is set.

## Against the judging criteria

| Criterion | What we built | Evidence (all in the repo) |
|---|---|---|
| Innovation | Photo of the posted exit map → graph → simulated evacuation → optimised plan; judges' phones become personal exit guides and live exit signs during a drill | `nikaas/vision.py`, `nikaas/drill.py`, `#/drill`, `#/me`, `#/sign` |
| Technical implementation | Flow-limited simulator validated against the SFPE worked example (245.25 s vs 245.2 s published); greedy exit optimiser with a proven network-flow lower bound; multi-floor stairwells shared fairly between floors; graph quality check before any number is trusted; 147 automated tests | `runs/validation.csv`, `runs/wow.csv`, `runs/multi_floor.csv`, `tests/` |
| Working prototype | Deployed on AWS (Lambda + API Gateway + S3, ap-south-1); the website, the API and the Live Drill all run live; `?demo=1` plays the story offline | live URL above, `template.yaml`, `docs/DEPLOY.md` |
| Impact & scalability | Lab block (528 people): 301.25 s → 166.75 s, 44.6% faster, 3.71 s above the bound. 5-floor tower (450): 375.25 s → 206.0 s. Stadium scaled to 2,001 people: 348.5 s → 203.0 s. Not one lucky run: with random start delays and ±20% occupancy, faster in 193 of 200 runs on the museum and 200 of 200 on the lab block | `runs/wow.csv`, `runs/multi_floor.csv`, `runs/stadium_results.csv`, `runs/monte_carlo_summary.csv` |
| Presentation | Live demo: the home page is already evacuating, a fire re-routes everyone, then the judges' phones get their own exits | `video/film.py` (showcase film), Live Drill |

## What we do not claim

- Times are movement times (from the moment people move until the last is out), not a full escape time; detection,
  alarm and reaction come on top and an exit plan does not change them (`docs/METHOD.md`).
- The museum floor plan is real; its scale, occupancy and door widths are our assumptions. The lab block, tower and
  stadium are representative buildings, not surveys.
- The photo-read museum scored 58 of 100 in our quality check (it found one exit instead of three), so we plan with the
  hand-checked graph and show the warning.
- The 3D Sim page is an illustration with simple walkers; the validated times are on the Twin and Evidence pages.
