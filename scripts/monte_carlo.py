"""Does the Nikaas plan's lead survive uncertainty? Monte Carlo over pre-movement and occupancy.

The plans are fixed beforehand, as they would be when posted on the wall: the nearest-exit rule and the Nikaas
plan optimised for the nominal building. Each run then draws
  - every person's pre-movement delay, uniform in [0, PREMOVE_MAX] s (our assumption, see docs/METHOD.md), and
  - every room's occupancy, scaled by a factor uniform in [1 - OCC, 1 + OCC],
and simulates both plans on the same draw. Times are from the alarm: pre-movement + movement.

Usage (repo root):  PYTHONPATH=. python scripts/monte_carlo.py [--n 200]
Writes runs/monte_carlo.csv (one row per run and plan) and runs/monte_carlo_summary.csv.
"""
import argparse
import csv
import json
import random
import statistics
import subprocess
from pathlib import Path

from nikaas.building import load, nearest_plan
from nikaas.optimise import optimise
from nikaas.sim import simulate

PREMOVE_MAX = 60.0  # s
OCC = 0.2
BUILDINGS = ["data/iit_kgp_museum.json", "data/lab_block.json"]


def run(path: str, n: int, premove_max: float = PREMOVE_MAX, occ: float = OCC, seed0: int = 1000):
    """[(run, people, nearest_s, nikaas_s)] for n random draws on one building."""
    d = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    b = load(d)
    plans = {"nearest": nearest_plan(b, set()), "nikaas": optimise(b, set())["plan"]}
    rows = []
    for k in range(n):
        rng = random.Random(seed0 + k)
        dk = json.loads(json.dumps(d))
        for node in dk["nodes"]:
            if node.get("type") == "room" and node.get("people"):
                node["people"] = max(0, round(node["people"] * rng.uniform(1 - occ, 1 + occ)))
        bk = load(dk)
        t = {name: simulate(bk, plan, set(), seed=seed0 + k, premove=(0.0, premove_max), frame_every=1e9)["total_time_s"]
             for name, plan in plans.items()}
        rows.append((k, sum(bk.people().values()), t["nearest"], t["nikaas"]))
    return rows


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(q * (len(xs) - 1))))]


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    a = ap.parse_args()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or "uncommitted"
    detail, summary = [], []
    for path in BUILDINGS:
        rows = run(path, a.n)
        name = Path(path).name
        detail += [[name, k, people, PREMOVE_MAX, OCC, near, nik, commit] for k, people, near, nik in rows]
        near, nik = [r[2] for r in rows], [r[3] for r in rows]
        wins = sum(1 for r in rows if r[3] < r[2] - 0.01)
        ties = sum(1 for r in rows if abs(r[3] - r[2]) <= 0.01)
        summary.append([name, a.n, PREMOVE_MAX, OCC, pct(near, .5), pct(near, .95), pct(nik, .5), pct(nik, .95),
                        wins, ties, a.n - wins - ties, round(statistics.median(r[2] - r[3] for r in rows), 2), commit])
        print(name, summary[-1])
    with open("runs/monte_carlo.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["building", "run", "people", "premove_max_s", "occupancy_spread", "nearest_s", "nikaas_s", "commit"])
        w.writerows(detail)
    with open("runs/monte_carlo_summary.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["building", "runs", "premove_max_s", "occupancy_spread", "nearest_p50_s", "nearest_p95_s", "nikaas_p50_s",
                    "nikaas_p95_s", "nikaas_faster", "ties", "nikaas_slower", "median_saving_s", "commit"])
        w.writerows(summary)
