# What our evacuation times mean

**Our times are movement times**: from the moment people start to move until the last person leaves,
with every door, corridor and stair limited to its flow capacity (SFPE hydraulic model, see `nikaas/sim.py`).

A full required safe escape time (RSET) adds phases that come **before** movement:

    RSET = detection + alarm / notification + pre-movement (recognition and response) + movement

- SFPE Handbook of Fire Protection Engineering, 5th ed., Ch. 56 (Bukowski & Tubbs, 2016): evacuation time
  consists of detection, notification, pre-movement and movement times (as summarised in the pyFDS-Evac
  documentation, pedestriandynamics.org/pyFDS-Evac/fundamentals/aset-rset/, read 30 Oct 2026).
- SFPE Handbook, "Employing the Hydraulic Model to Assess Emergency Movement" (Gwynne & Rosenbaum): the
  hydraulic model is a baseline that assumes exit paths are used at maximum capacity from the moment of alarm
  (chapter abstract, link.springer.com/chapter/10.1007/978-3-031-59212-6_67, read 30 Oct 2026).
- BSI PD 7974-6:2019 (human factors, life-safety strategies): in many situations the pre-travel processes
  make up the greatest part of the time required for escape (standard preview, read 30 Oct 2026).

**Why we report movement time.** The exit plan is what Nikaas changes. Detection, alarm and pre-movement
depend on the alarm system and on people, not on which exit a room is told to use, so we leave them out
rather than guess them. When we say "the Nikaas plan is X s faster", X is a difference in movement time.

**What we do not claim.** We do not claim a total RSET or that a building is "safe". Pre-movement time can be
added per room through `simulate(..., premove=(min_s, max_s))` once real alarm and drill data are available.

## Robustness check (`scripts/monte_carlo.py`)

To test whether the Nikaas plan's lead is more than one lucky run, both plans are fixed and each building is
re-simulated 200 times with random conditions. **These are our assumptions, not measured values:** every
person's pre-movement delay is uniform in [0, 60] s, and every room's occupancy is scaled by a factor uniform in
[0.8, 1.2]. Times in that table are from the alarm (pre-movement + movement), so they are not comparable with the
movement times elsewhere. Real pre-movement distributions depend on the building type and alarm system (BSI
PD 7974-6:2019); with drill data the same script can be re-run with measured ranges.

## Plans and lower bounds (`nikaas/optimise.py`, `nikaas/tef.py`)

**Three kinds of plan.** A *room plan* sends each room to one exit; this is what the live platform uses. A
*door-level plan* (`{door: exit}`, `optimise_doors()`) lets the people at each door of a room use their own exit.
A *share plan* (`{exit: fraction}`, `optimise_shares()`) divides a room between exits; the platform could carry
it out because every phone already gets its own route. Each refinement starts from the previous plan and keeps a
change only if the simulated movement time drops, so it is never slower than where it started.

**Two lower bounds.** No plan of any kind can beat either bound with the same exits and widths:

- *Exits and stairwells* (`lower_bound()`): a linear program in which every exit and every shared stairwell
  passes people no faster than its capacity.
- *Every edge over time* (`time_expanded_bound()`): the building is copied once per time step and every door,
  corridor and stair carries at most its capacity in each step (a quickest-flow problem on a time-expanded network,
  Ford and Fulkerson 1958; Hoppe and Tardos 2000). Travel times are rounded down and capacities up, so it stays a
  bound. It is much tighter where an inner corridor is the bottleneck (the stadium), and slightly looser on simple
  floors because of the rounding.

`optimise()` reports the larger of the two. As with any flow model, the bounds hold up to about one person's
headway at an exit (0.45-1.1 s for our buildings), because the simulator lets the first arrival at an idle door
straight through. `scripts/run_improvements.py` checks every case and stops if a bound ever exceeds a plan the
simulator achieved.


## Against measured evacuations (`scripts/run_theatres.py`, `runs/theatres.csv`)

The simulator is compared with eight unannounced trial evacuations of real lecture theatres (61 to 246 people each)
published by Spearpoint and Xiang (Fire Safety Science 10, 2011, doi 10.3801/IAFSS.FSS.10-599): room size, exit
widths, the number of people who used each exit and the time until the last person was out. The people who used an
exit stay on that exit. **Our assumptions, not in the source:** they are spread evenly over walking distances from
0 to room length + room width, and the two rear exits limited by a 1.05 m stair are stairs. No constant is changed.

Result: within 15 % of the measured time in 5 of the 8 rooms, mean absolute error 12.5 %, and fast by 11.5 % on
average. Halving the walking distances gives 12.8 %, multiplying them by 1.5 gives 11.3 %. The rooms have fixed
seating and aisles that our graph of a theatre does not represent, and they are single rooms, so this checks the
door model only. The `balanced_exits_s` column keeps the people and exits and lets a local search choose the split
between exits; it is a simulated estimate that assumes anyone can reach any exit equally easily.
