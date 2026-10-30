# Learnings (dated)

- **30 Oct 11:25** — The hand-calculated single-door test caught a capacity bug on the first run: leftover
  door capacity was being discarded each time step, making doors ~22% slower than the formula
  (128 s vs 100.7 s for 120 people through a 1 m door). Fixed in the simulator, not by loosening the test.
- **30 Oct 12:07** — Our first IIT Kharagpur result blamed the Audiovisual Hall's west door (queue 120). That was a model artefact: every room sent all occupants down one shortest path, so a hall's second door was never used. Rooms now split occupants across all usable doors by width (test `test_room_with_two_doors_uses_both`). Total time unchanged (112.75 s); the true bottleneck is the 1.2 m verandah door (peak queue 99). Lesson: check a surprising finding against the model's assumptions before telling anyone.
- **30 Oct 12:10** — Constants checked against published sources. SFPE Example 1 (Thunderhead Pathfinder verification docs) gives 245.2 s; our simulator now gives 245.25 s (0.02% off) after three fixes: effective width (clear width minus 6 in per door jamb), stair specific flow 1.012 p/s/m (18.5 p/min/ft, was 1.1), stair speed 0.915 m/s (0.85 x 212 ft/min, was 0.85). All baselines re-measured; times rose ~30% because effective widths are narrower.
- **30 Oct 15:07** — A crash in the report script hid stale numbers: one run that did not finish (empty time) made
  `scripts/report.py` stop part-way, so the website's results file had silently stopped updating. Lesson: the
  scripts that publish numbers need the same care as the simulator; an unfinished run is a result to show, not skip.
- **30 Oct 15:20** — A comparison bug, not a model bug: with an exit blocked, the Twin compared the Nikaas run against
  the nearest-exit baseline and showed "-116.8 s vs all exits open". Each plan now has its own baseline (+28.8 s).
- **30 Oct 15:30** — Reviewing a 2,500-line change to the core simulator: tests passing was not enough, so we re-ran 11
  scenarios before and after and required every time, queue and plan to be identical. They were, but the check also
  showed the change made simulate 30-60% slower, which a test suite would never report.
- **30 Oct 16:47** — Profile before optimising: the slowdown was 3D positions computed every frame for one-floor
  buildings that never output them. Three small, result-identical changes brought the museum re-plan from about
  2.8 s to 2.1 s; each was accepted only after the identity check above.
- **30 Oct 17:15** — One headline number invites the question "was that a lucky run?". 200 runs with random start
  delays and head counts answered it (193 of 200 on the museum), and the 7 losses had a clear cause (fewer people
  than planned, so a smaller jam). Showing where we lose made the result more believable, not less.
- **30 Oct 17:37** — Live is not always better on stage: blocking a stadium gate took up to 18 s on AWS, near the
  29 s API limit. Precomputing the six blocked-gate plans made the click instant; the live API stays for everything else.

