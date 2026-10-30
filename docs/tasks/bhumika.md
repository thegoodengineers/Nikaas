# Bhumika — Crowd mode (crush-risk feature), pitch, proof, demo video

Part of Nikaas (AfterHours 1.0). Read first: `docs/CONTRACT.md` (shared data format), `docs/TASKS.md`
(team rules, checkpoints) and `docs/PLAN.md` (pitch, persona, rubric).

You own one product feature (Crowd mode) and how judges experience Nikaas: the story and the evidence.
Every number you use comes from `docs/RESULTS.md` or a script that writes to `runs/`; never type a number from memory.

## Your feature: Crowd mode — crush-risk detection
The Chinnaswamy Stadium crowd crush (Bengaluru, 4 June 2025, 11 killed) is in our problem slide. Crowd mode
answers: *where will the crowd get dangerously dense, and when?*

1. **Research first (by 14:00)** — `docs/CROWD_RESEARCH.md`: crowd density levels and when they become
   dangerous (people per m²), with sources you actually opened (e.g. Fruin's Level of Service, G. Keith Still's
   crowd-safety work, UK Guide to Safety at Sports Grounds). Write each threshold with its source and link.
2. **Density from the simulator (by 17:00)** — `nikaas/crowd.py` + `tests/test_crowd.py`: from a `simulate()`
   result, compute people per m² on each corridor/door area over time (area = edge length × effective width
   from `nikaas/sim.py`), the peak density per edge, and a `crush_risk` list of edges and times above the
   threshold from your research. Tests: a hand-checked case (e.g. 40 people queued on a 2 m × 5 m corridor =
   4 p/m²), and a negative control (a wide, empty corridor is never flagged).
3. **Stadium building (by 19:00)** — `data/stadium_gates.json` in the contract format: a representative cricket
   stadium (stands as rooms, concourse as corridors, 4–6 gates as exits, one gate narrow and near the metro).
   Label it "representative, not measured" in `name`; list assumptions in `docs/QUESTIONS.md`. Done when
   `POST /validate` returns no problems and `python scripts/run_nearest.py data/stadium_gates.json` writes to `runs/`.
4. **API field (with Chirag, by 21:00)** — when `crowd.py` is tested, tell Chirag in the team chat; he adds a
   `crush_risk` field to `/simulate` and shows it in the website (red zones).

## Proof and story
5. **Pitch script (draft by 17:00, final by 06:00)** — `docs/PITCH.md`, 3 minutes as spoken: problem in the
   first 15 s, product name, live demo path (what to click and say), the validation line ("reproduces the SFPE
   handbook example: 245.25 s vs 245.2 s"), the wow number from `docs/RESULTS.md`, Crowd mode, close. Mark who says what.
6. **What-if sheet (by 23:00)** — `docs/WHATIFS.md`: questions judges are likely to ask (block each exit, double the
   Audiovisual Hall, a narrower door…), each answered by a run saved in `runs/`.
7. **README "For judges, start here" (draft by 23:00, final by 06:00)** — top of `README.md`: one-line pitch, live URL
   (from Abhijeet), video link, 4 bullets with real numbers, how to run, honest "working today / not built yet".
8. **Finalist PPT (by 23:00)** — update the idea PPT (offline template, max 5 slides) with real numbers and app screenshots.
9. **Demo video (07:30–08:30)** — record the website's `?demo=1` story (Chirag provides it), ≤ 3 min, captions, no speed-up.

## New work (assigned 13:59)
10. **Showcase film of the website (by 19:00 draft, final after the 07:30 freeze)** — like Nikhil Bhima's
    "redesigned the landing page" post on X: a ~25 s, high-resolution (2880×1576, i.e. 1440×788 at 2× device scale)
    screen recording of the site, no voice, smooth and slow. Record it with Playwright, not by hand:
    `browser.new_context(viewport={"width":1440,"height":788}, device_scale_factor=2, record_video_dir=...)`,
    then scroll Home top-to-bottom with `page.mouse.wheel` in small steps (smooth, ~6 s), open the Twin, block an exit,
    switch to the Nikaas plan. Save the script as `video/showcase.py` and the film as `video/nikaas_showcase.mp4`.
    Never speed it up; cut steps instead.
11. **Fix Crowd mode densities** (see my 13:50 note): only count people outside rooms, cap test at 10 p/m².
12. **Judge's-eye review of every page, every 2 hours** — open Home, Twin, Beat Nikaas, Evidence at 1440, 1024 and
    400 px. List anything broken, unclear, unproven or ugly in your notes section (I fix the website; you find problems).
13. **Finalist slides** — update the 5-slide offline-template PPT with screenshots of the new site and numbers from
    `docs/RESULTS.md` (keep fonts 14–18 pt).

## Keep improving (every hour until 07:30 freeze)
Do not stop when the list is done. Each hour: `git pull`, read `docs/RESULTS.md` and `hackathon.md` for what changed,
then pick one thing and commit it:
- **Research** a claim we make (density thresholds, evacuation speeds, Indian fire-safety rules such as the
  National Building Code 2016 Part 4) and add the source to the doc that uses it;
- **Review** the app and the docs as a judge would: anything unclear, unproven or broken goes in your notes to Chirag;
- **Sharpen** the pitch and what-ifs with the newest numbers; cut anything that is not backed by a run.
Log each hour's change in `hackathon.md` (one line).

Fallback: if `crowd.py` is not tested by 21:00, Crowd mode is shown as a slide with your research only.

## Notes from Chirag (build lead)
Newest at the bottom. Check this section after every `git pull`.
- **12:25** — Change of plan: **Chirag now owns the website (`web/`)**. Your work is above: the Crowd mode
  crush-risk feature (research + `nikaas/crowd.py`) plus pitch, proof, README and the demo video (moved from
  Abhijeet, who keeps AWS + vision). Useful now: the simulator matches the SFPE handbook example (245.25 s vs
  245.2 s); on the lab block, closing a stair makes evacuation *faster* than the nearest-exit rule (`docs/RESULTS.md`).
- **12:28** — The live API is up (Abhijeet): `https://4kzez16ucj.execute-api.ap-south-1.amazonaws.com/health`.
- **12:46** — Video mode is ready: open the site with `?demo=1` (e.g. `npm run dev` then `http://localhost:5173/?demo=1`). It shows the landing page for 4 s, scrolls to the map, plays the nearest-exit run with a caption, then blocks the main entrance and plays the re-routed run. Saved runs only, so it works offline. Set speed with the 1-8x buttons before recording.
- **12:54** — The wow numbers are in `runs/wow.csv` (Ayush): lab block nearest 301.25 s -> Nikaas 166.75 s (134.5 s, 44.6% faster, 3.71 s from the proven lower bound); IIT KGP 145.25 -> 124.0 s. `?demo=1` now plays nearest exit -> Nikaas plan -> main entrance blocked, with captions.
- **12:56** — Your web app (pushed at 12:57, written at 12:10) arrived after the website moved to me, and it replaced the live site. I merged so nothing is lost: your code is kept in `web/legacy-bhumika/` (with a README), and the live site in `web/src` stays on the version with the landing page, vendored three.js (npm is blocked on the venue network, so a build that needs npm packages cannot be installed here), photo switch, Nikaas comparison and `?demo=1` story. I will port your scrubber, side-by-side panels and edge_load colouring into it. **Please do not push to `web/` from now on**; your tasks are in this file (Crowd mode, pitch, README, video). Also: our rule is **no AI mentions in commits or files**, so please remove `Co-Authored-By` lines from your commit messages.
- **13:02** — Ported two of your ideas into the live site: the timeline scrubber and corridors coloured red by `edge_load` (2D view). Credited in the commit. Thanks.
- **13:16** — For the pitch and README: our times are **movement times**, not full escape time. See `docs/METHOD.md` (SFPE Handbook Ch. 56; BSI PD 7974-6). Say "evacuation movement time" or "X s faster to move everyone out", never "total evacuation time" or "the building is safe". Judges from fire engineering will check this.
- **13:22** — Pitch moment: hand a judge the laptop, open "Beat Nikaas" (below the map), let them send rooms to exits and press "Time my plan". Nikaas should win; the panel shows by how many seconds and the proven lower bound.
- **13:35** — Reviewed your push: pitch, what-ifs and crowd research are good and use movement-time language. I corrected two README claims judges would catch: (1) the lower bound means *no plan can beat 163.04 s*, not that Nikaas is optimal (it is a greedy plan 3.71 s above the bound); (2) Crowd mode is not built yet, so it is marked "in progress" until `nikaas/crowd.py` is tested. I ran your two missing what-ifs (block C: 301.25 s, unchanged; seminar doubled: 433.0 s) and filled them in `docs/WHATIFS.md`. Next for you: `nikaas/crowd.py` + tests.
- **13:42** — Reviewed Crowd mode: 10 crowd tests pass, 51 total, nice work on `first_crush_t` and `narrative()`. Three fixes I made: (1) `data/stadium_gates.json` was saved with a BOM, which crashed the loader; the loader now tolerates it. (2) `CROWD_RESEARCH.md` said the Chinnaswamy crush was at Gate 6 with 6–7 p/m² and a single narrow gate as the cause. Wikipedia says crushes happened at gates 2, 2A, 6, 7, 15, 17, 18 and 21, and I found no source for the density, so I removed both. Please never state a cause or figure for a real tragedy without a source you opened. (3) The stadium is representative, not Chinnaswamy. Do not say "we modelled Chinnaswamy" in the pitch; say "a stadium like Chinnaswamy".
- **13:47** — **Crowd mode cannot run live on the stadium.** 14,600 people do not finish within the simulator's 1,800 s limit (Gate South queue 4,005, `runs/results.csv`), 300 simulated seconds already take ~2.8 s of CPU, and frames for 14,600 people would be far over the 6 MB Lambda response. Choose one before 17:00: (a) precompute the stadium run offline (`simulate(..., max_t=4000, frame_every=10)`) and save the frames + crowd result to `web/public/data/` for the demo, or (b) scale the representative stadium to ~2,000 people so it runs live. Tell me which and I will put it in the website.
- **13:52** — Reviewed Crowd mode output. **Densities are not physical:** IIT KGP nearest-exit gives max_density 17.05 p/m² and 1,017 crush entries; lab block (B blocked) 21.67 p/m² and 1,945 entries. Real crowds top out around 8-9 p/m², so judges will catch this. Likely cause: people still inside a room (state `inside`, or `queuing` before their first door) are assigned to the nearest edge, often a short door edge with a tiny area. Suggested fix in `crowd.py`: count only people whose state is `walking`, `queuing` or `stairs` and who are outside rooms (point not inside any room rectangle from the building), and add a test that no edge exceeds a physical cap (e.g. 10 p/m²) on `data/iit_kgp_museum.json`. Also: `/simulate` now runs crowd analysis only with `"crowd": true` (it doubled the cost of every tap-to-block), see `docs/CONTRACT.md`.
- **13:59** — New tasks 10–13 above. Priority order today: 11 (crowd densities) → 12 (review) → 10 (showcase film draft) → 13 (slides). The website is redesigned (separate pages: Home, Twin, Beat Nikaas, Evidence); please review it from the judges' side.
- **14:02** — **Showcase film reference received** (the "tabi" landing-page video Chirag shared, 25.9 s, 60 fps): the site is
  recorded *inside a browser window* that sits on a colourful gradient desktop wallpaper (pink/orange to blue), with a little
  margin around the window. Sequence: hero (2 s hold) → smooth scroll through features → one live interaction → stats →
  footer → back to the hero. No voice, no speed-up, one continuous take. For Nikaas: Home hero with the exit sign (hold) →
  scroll to "how it works" and the measured numbers → open the Twin → tap "West steps" so the fire rings and re-plan show →
  switch to "Nikaas plan" → Evidence page → back to Home. Make the frame with ffmpeg: record the page at 1440×788 ×2 with
  Playwright, then `overlay` it on a gradient image with rounded corners. Keep it ≤ 26 s.
- **14:03** — Your PR #1 merge re-added `web/src/components/` and `web/src/types.ts`, which **broke the website build** (they need npm three.js, which the venue blocks). They are already kept in `web/legacy-bhumika/`, so I removed the duplicates. **Please do not merge or push anything under `web/src`.** I also corrected the README status: the optimiser UI is built, and Crowd mode is "in progress" until the density fix lands.
- **14:15** — The live site is up and current: http://nikaas-webbucket-hbkfctr0cw8s.s3-website.ap-south-1.amazonaws.com (put it in the README, done, and use it for the showcase film so judges see the real thing).
- **14:23** — Home is now a scroll film (light mode): scroll through it slowly in your showcase recording, it is the centrepiece. Use `page.mouse.wheel` in small steps over ~10 s for the film section.
- **14:26** — New pitch centrepiece: **Live Drill**. Write the 40-second script: "Everyone, take out your phone and scan this" → judges pick their room → their phone shows their exit → Chirag blocks an exit (fire) → every phone vibrates and re-routes → "that is Nikaas: everyone gets their own way out". Rehearse it with 3 phones. Film it for the showcase video too.
- **14:45** — Your review: fixed `#/beat` (old `#/challenge` still works) and the mobile nav (one line, scrolls). I could not reproduce the Twin spinner at 375 px on the current build (3D shows after ~5 s); if you still see it, write the exact steps here. Crowd fix reviewed, tests pass. One ask: `PHYSICAL_CAP` clamps the number, so please add `"capped": true` to an edge's record when its raw peak was above 10, so nobody quotes 10 p/m² as a measurement.
- **14:45** — Showcase film: Home has changed. It now **opens on a live 3D building that is already evacuating**, and tapping a green exit sign starts a fire and re-routes everyone. Start the film there: hold 3 s, click an exit in the 3D (take a screenshot first to find it), wait for "Fire at …, everyone was re-routed". Make `BASE_URL` a `--url` argument (my dev server is on 5175; the live S3 site is best once Abhijeet republishes).
- **14:45** — New for the pitch: **live exit signs** at `#/sign`. Tape a phone beside the classroom door, pick the door, and when we set a fire there it turns red, "Do not use", and says which exit to use instead. Put it in the Live Drill script: the judges watch a real sign on the wall change. Source to quote: the EU GETAWAY project (University of Greenwich) tested signs like this driven by an evacuation simulator: https://fseg.gre.ac.uk/fire/GETAWAY.html
- **14:45** — For the narrated pitch video (≤ 3:00), follow `HACKATHON_PLAYBOOK_v2` Part 2: `video/script.md` table → `narrate.py` (edge-tts, en-IN-PrabhatNeural or en-IN-NeerjaNeural) → `record.py` (Playwright, each scene = narration + 1.2 s; the demo scenes from `?demo=1`) → `assemble.py` (ffmpeg, music ducked under voice). Order: hook ≤ 10 s → problem → Nikaas → live demo → proof numbers (from `docs/RESULTS.md` only) → architecture → what we learned → close.
- **14:52** — For your showcase film: open Home as `/?fire=MAIN` and the fire starts by itself 3 s after people appear (no clicking in 3D). Record with GPU WebGL, `chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])`; with the default software renderer the people barely move in the recording. Working example: `video/hero_gif.py` (made the README GIF).
- **14:59** — Your stadium is now the third building in the Twin ("Stadium gates (2,001 people)"). I extended your precompute script to run the Nikaas plan too: 348.5 s → 203.0 s, and peak density on the worst concourse 2.69 → 1.61 p/m² (`runs/stadium_results.csv`). Use that in the scale slide: same gates, 145.5 s faster and a calmer concourse. One correction: 2.69 p/m² is just *below* the 2.7 concern line, not above it (your commit and build-log entry say above); please say "just below" in the slides.
- **17:09** — The silent showcase film is done (Chirag asked for it now): `python video/film.py` records the live site and writes `video/out/nikaas_film.mp4` (38 s). Your `video/showcase.py` is no longer needed for that. Please put your time into the narrated pitch video (playbook Part 2) and the slides; you can reuse clips from this film.
- **17:55** — For the pitch script and rehearsal: step 0 is pressing "Start over" on the Live drill page, so no phone shows an old alert. Then "Start the drill" is not needed; the QR is ready.
- **17:59** — I rebuilt `docs/PITCH.md` as v2 from your draft (same structure and your speaking parts) because judges would catch three claims: (1) "our stadium model shows Gate South exceeds the crush threshold within 60 s ... the gate that failed on June 4th": our stadium is a representative building, not Chinnaswamy; its peak density is 2.69 p/m², below the 4 p/m² line; and we have no source on which gate failed. (2) "No building in India has a tool that tells you in advance" and "existing tools miss crowd density entirely": MassMotion and LEGION do density maps. (3) The museum is the *Nehru* Museum of Science & Technology. v2 adds the Live Drill and exit sign, the 200-run robustness result, the tower and the stadium, a "Do not say" list and a table of where each number comes from. Please read it, time it out loud (3:00), and change anything that does not sound like you.

