"""Simulator against eight published, unannounced trial evacuations of real lecture theatres.
Writes runs/theatres.csv. Run: python scripts/run_theatres.py

Measured data: M. Spearpoint and X. Xiang, "Calculating evacuation times from lecture theatre type rooms using a
network model", Fire Safety Science 10 (2011), pp. 599-612, doi 10.3801/IAFSS.FSS.10-599, Table 1: room size, exit
widths, people who used each exit, total clearance time. Pre-movement: 14 s (A1) and 22 s (C1) measured; 18 s for
the other rooms, as that paper assumes.

Our modelling choices (not in the source):
- the people who used an exit stay on that exit and are spread evenly over walking distances from 0 to
  room length + room width (the longest travel distance in the source's own model), then queue at the exit;
- the rear exits of A2 and A3, which the source says are limited by a 1.05 m stair, are stairs; all others are doors.
No simulator constant is changed. The balanced column keeps the people and the exits of a room and lets a local
search choose how many people use each exit; it assumes anyone can reach any exit equally easily."""
import csv, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nikaas.building import load  # noqa: E402
from nikaas.sim import simulate  # noqa: E402

BANDS = 12  # walking-distance bands per exit group
# room: (length m, width m, pre-movement s, measured clearance s, [(exit, clear width m, kind, people who used it)])
ROOMS = {
    "A1": (20, 16, 14, 114, [("front", 1.65, "door", 105), ("side", 1.65, "door", 78), ("rear", 0.85, "door", 63)]),
    "A2": (15, 11, 18, 101, [("front", 1.80, "door", 122), ("rear", 1.05, "stair", 49)]),
    "A3": (12, 10, 18, 84, [("front", 1.80, "door", 95), ("rear", 1.05, "stair", 1)]),
    "C1": (20, 19, 22, 96, [("front right", 1.45, "door", 66), ("front left", 1.45, "door", 54),
                            ("rear right", 0.74, "door", 38), ("rear left", 0.74, "door", 34)]),
    "C2": (17, 15, 18, 117, [("front", 1.45, "door", 155), ("rear", 0.74, "door", 31)]),
    "C3": (17, 15, 18, 73, [("front", 1.45, "door", 53), ("back", 0.74, "door", 8)]),
    "S2": (13, 12, 18, 77, [("front", 1.45, "door", 56), ("midway", 0.97, "door", 44)]),
    "S4": (15, 12, 18, 91, [("front", 1.45, "door", 63), ("midway", 0.97, "door", 63)]),
}


def exit_time(length, width, premove, w, kind, users, scale=1.0):
    """Time at which the last of `users` people is out of one exit of clear width `w`."""
    if users == 0:
        return 0.0
    far = (length + width) * scale
    nodes = [{"id": "d", "type": "corridor", "x": 0, "z": 0}, {"id": "x", "type": "exit", "x": 0, "z": -1}]
    edges = [{"from": "d", "to": "x", "width": w, "length": 0.5, "kind": kind}]
    plan = {}
    for i in range(BANDS):
        n = users // BANDS + (1 if i < users % BANDS else 0)
        if n:
            nodes.append({"id": f"g{i}", "type": "room", "x": i * 6, "z": 10, "w": 4, "d": 4, "people": n})
            edges.append({"from": f"g{i}", "to": "d", "width": 50.0, "kind": "corridor",
                          "length": max(0.1, (i + 0.5) / BANDS * far - 0.5)})
            plan[f"g{i}"] = "x"
    b = load({"name": "exit", "units": "m", "nodes": nodes, "edges": edges})
    return simulate(b, plan, frame_every=1e9, premove=(premove, premove))["total_time_s"]


def room_time(name, split=None, scale=1.0):
    length, width, premove, _, exits = ROOMS[name]
    return max(exit_time(length, width, premove, e[1], e[2], u, scale)
               for e, u in zip(exits, split or [e[3] for e in exits]))


def balanced(name):
    """Same people and exits, split chosen so that the last person is out as early as possible (local search)."""
    length, width, premove, _, exits = ROOMS[name]
    split = [e[3] for e in exits]
    best, step = room_time(name, split), 8
    while step >= 1:
        improved = True
        while improved:
            improved = False
            times = [exit_time(length, width, premove, e[1], e[2], u) for e, u in zip(exits, split)]
            src = max(range(len(exits)), key=lambda i: times[i])
            for dst in sorted(range(len(exits)), key=lambda i: times[i]):
                if dst == src or split[src] < step:
                    continue
                cand = list(split)
                cand[src] -= step
                cand[dst] += step
                t = room_time(name, cand)
                if t < best - 1e-9:
                    best, split, improved = t, cand, True
                    break
        step //= 2
    return best, split


if __name__ == "__main__":
    commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    rows = []
    for r, (length, width, premove, measured, exits) in ROOMS.items():
        t = room_time(r)
        tb, split = balanced(r)
        rows.append([r, sum(e[3] for e in exits), len(exits), premove, measured, t, round((t - measured) / measured * 100, 1),
                     room_time(r, scale=0.5), room_time(r, scale=1.5), tb, "+".join(map(str, split)), commit])
        print(rows[-1], flush=True)
    for label, col in (("as modelled", 5), ("half the walking distance", 7), ("1.5 x the walking distance", 8)):
        err = [abs(x[col] - x[4]) / x[4] * 100 for x in rows]
        print(f"{label}: mean absolute error {sum(err) / len(err):.1f} %, largest {max(err):.1f} %, "
              f"within 15 % in {sum(e <= 15 for e in err)} of {len(err)}")
    with open(ROOT / "runs/theatres.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["room", "people", "exits", "premove_s", "measured_s", "simulated_s", "diff_pct", "simulated_half_distance_s",
                    "simulated_1p5_distance_s", "balanced_exits_s", "balanced_split", "commit"])
        w.writerows(rows)
