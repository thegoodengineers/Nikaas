# Ayush — optimiser, lower bound, wow number

Part of Nikaas (AfterHours 1.0). Read first: `docs/CONTRACT.md` (shared data format) and `docs/TASKS.md` (team rules, checkpoints).

Files: `nikaas/optimise.py`, `tests/test_optimise.py`, `scripts/run_wow.py`, `runs/wow.csv`.

Goal: assign each room an exit so the **last person out** leaves as early as possible, given the
simulator's model (edge capacity = width × specific flow from `nikaas/sim.py`).

1. **Greedy first (by 14:00):** start from `nearest_plan`; repeatedly move one room to another exit if
   `simulate()` total time drops; stop when no move helps. Done when it beats nearest on `data/sample_floor.json`.
2. **Lower bound (by 17:00):** a quickest-flow / time-expanded network flow LP (Ford & Fulkerson, *Flows in
   Networks*, 1962) on the same graph, solved with `scipy.optimize.linprog` (HiGHS backend is fine as a
   library call). Report `lower_bound_s`. Done when a test shows `lower_bound_s <= total_time_s` for every plan tried.
3. **`optimise(building, blocked=()) -> {"plan", "total_time_s", "lower_bound_s"}`**; re-plan with a blocked
   exit in < 2 s on the CSE Labs graph.
4. **Tests:** (a) two exits, one blocked → everyone to the other; (b) **negative control:** a building where
   nearest is already optimal → optimiser reports the same time, no fake gain; (c) bound ≤ plan time.
5. **Wow number (by 06:00):** `scripts/run_wow.py` runs nearest vs optimised vs blocked on `data/cse_labs.json`,
   writes `runs/wow.csv` with building sha256, times, gap to the bound, git commit.
6. **"Beat Nikaas" score:** function that takes a judge's hand-made plan and returns its time and the gap to Nikaas.

Fallback: if the LP is slow or wrong, keep greedy and use a simple bound: total people / total exit capacity + shortest walk.

## Notes from Chirag (build lead)
Newest at the bottom. Check this section after every `git pull`.
- **11:47** — Use `simulate(b, plan, blocked)` from `nikaas/sim.py` to score any plan; `nearest_plan(b, blocked)` is your starting point. Return shape for `/optimise` is in `docs/CONTRACT.md`; Chirag wires the endpoint once `optimise()` is pushed.
- **12:00** — Optimise on `data/lab_block.json`: nearest exit sends 264 people to the narrow west stair A (1.2 m) and only 194 to the wide main stair B (2.0 m), 211.75 s total (`runs/results.csv`). That imbalance is what your plan should fix.
- **12:05** — Optimise on `data/iit_kgp_museum.json`. Nearest exit: 112.75 s, bottleneck is the Audiovisual Hall's west door (120 people queue at one 1.2 m door while the hall's second door is unused). Blocking MAIN: 242.75 s. Note: a room with two doors needs per-door splitting; plan format can stay room -> exit for now.
- **12:07** — **Correction to my previous note:** the Audiovisual Hall queue was a simulator artefact (rooms used only one door). Fixed: occupants now split across all doors. Real baseline on `data/iit_kgp_museum.json`: 112.75 s, bottleneck is the narrow **verandah door** (1.2 m, 155 people, peak queue 99) while the 2.0 m main entrance takes 203. Your plan should move people off the verandah door. Plan format stays room -> exit.
- **12:10** — Simulator constants changed (SFPE-validated, 245.25 s vs 245.2 s on SFPE Example 1). New baselines in `docs/RESULTS.md`: IIT KGP nearest **145.25 s**; lab block nearest **301.25 s**, and blocking Stair A gives 284.75 s, so even a trivial plan beats nearest there. Use `docs/RESULTS.md` numbers, not my older notes.
- **12:54** — Reviewed and wired: all 33 tests pass (I had to `pip install scipy` locally). The website now has a "Nikaas plan" switch that calls `/optimise` and shows "21.3 s faster, 14.6% saved, within 6.4 s of the lower bound" on IIT KGP, and 134.5 s / 44.6% on the lab block is our best wow number. Re-plan with MAIN blocked took 2.8 s locally (target < 2 s), worth a look if easy. Great work.
- **13:22** — Your `beat_nikaas_score` is now live as `POST /beat` and in the website ("Beat Nikaas" panel: a dropdown per room, "Time my plan"). Browser test: Audiovisual Hall sent to MAIN -> judge 155 s vs Nikaas 124 s, Nikaas wins by 31 s.
- **14:05** — Reviewed `graph_qa` + `/qa` (tests pass, 74 total). Wired into the website: the photo-read building banner now shows your score and top warnings (Nova Pro graph: 88/100, two long door links). **One gap:** it does not flag that Nova found only 1 of 3 exits, which is what makes that graph wrong (388.5 s vs 145.25 s). Suggest a check comparing total exit capacity (effective width x specific flow, from `nikaas/sim.py`) with occupants, e.g. warn when one exit must carry more than ~2.5 min of flow, plus an NBC-style minimum-exits rule (2 exits per floor above a small occupancy; cite NBC 2016 Part 4 if you use it).
- **14:19** — Exit-capacity check reviewed: 91 tests pass; Nova graph now 58/100 with the capacity and NBC 1-exit warnings first, hand graphs still 100. Website banner refreshed to show them. Thanks.
- **14:26** — New: "Live Drill" (judges' phones get their own exit, re-routed live when we block a stair). It calls your `optimise()` on every block, so re-plan speed matters now (IIT KGP ~2.8 s with MAIN blocked). Can you get re-plan under 1.5 s, e.g. by warm-starting from the previous plan? Also help Abhijeet turn the DBIT lab photo into a correct graph (`/qa` must pass).
- **14:45** — Idea that backs our headline number (from what industry tools like Pathfinder do): a **Monte Carlo band**. Run N = 200 simulations with random pre-movement delays (`simulate(..., premove=(lo, hi), seed=k)`) and occupancy ±20%, for both nearest and Nikaas plans, and report P50 / P95 total time and "Nikaas is faster in X of 200 runs". Write `scripts/monte_carlo.py` → `runs/monte_carlo.csv`, plus one test that a 10-run version is deterministic for fixed seeds. Judges from industry will doubt one number; a distribution answers that. State the delay distribution as our assumption in `docs/METHOD.md`.
- **14:59** — Stadium (2,001 people) is in the Twin with your optimiser: 348.5 s → 203.0 s, but the lower bound is 107.11 s, a 95.9 s gap (on the museum the gap is 6.4 s). Likely cause: one exit per room, so a 900-person stand goes to a single gate while the LP bound can split it. If you have time, try splitting a room's people across two exits (or assign per door) and see how far the gap closes. `optimise()` also takes ~13 s there, so this is precomputed, not live.
- **16:21** — Reviewed the multi-floor engine (PR #8, merged by Abhijeet): 144 tests pass on main, and I re-ran 11 single-floor scenarios (museum, lab block, sample floor, stadium, with and without blocked exits) on main before and after: nearest time, queues, bottleneck, people per exit, Nikaas time and lower bound are all identical. Your `run_multi_floor.py` reproduces your CSV exactly. Great work.
  Three asks: (1) **Speed.** On my laptop `simulate` is now 30–60% slower and `optimise` 5–17% slower (museum with MAIN blocked: re-plan 2.4 s → 2.8 s). The Live Drill re-plans on every fire, so please profile the single-floor path (e.g. skip the stairwell group scheduler when no edge has a `capacity_group`) and get it back to the old speed; the 11-scenario identity check must still hold. (2) **Re-run `scripts/run_multi_floor.py` on main** so the `commit` column in `runs/multi_floor.csv` names a commit that is actually on main (it says 825172b). (3) **Pitch wording:** the multi-floor gain is the 5-floor tower only (375.25 s → 206.0 s, 45.1%); on the 3-floor office the Nikaas plan ties the nearest-exit rule in every scenario. Say exactly that.
- **16:31** — Your tower is in the Twin now ("5-floor tower (450 people)"), drawn in 3D from your `people_3d` frames: floors stacked, both stair shafts, the queue at each floor's stair door. Nearest exit sends everyone down the north shaft; your plan uses both. Open it and check it matches what your engine does; tell me here if anything looks wrong.
