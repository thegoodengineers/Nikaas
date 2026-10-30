"""Precompute stadium evacuation frames and crowd analysis for the website demo.

Run from repo root with:
    python -m scripts.precompute_stadium
or:
    PYTHONPATH=. python scripts/precompute_stadium.py


The representative stadium has 14,600 people — too large for a live API call
(75 MB response, ~20 s CPU). This script scales it to 2,001 people (option b
from the 13:47 build note), runs a full simulation and crowd analysis, and
saves the results to web/public/data/ for the website to load as a precomputed
run.

Usage (run from repo root):
    python scripts/precompute_stadium.py

Outputs:
    web/public/data/stadium_scaled.json         — scaled building (2,001 people)
    web/public/data/frames_stadium_nearest.json — sim frames + crowd result, nearest-exit rule
    web/public/data/frames_stadium_nikaas.json  — the same for the Nikaas plan (optimise())
    runs/stadium_results.csv                    — headline numbers for RESULTS.md
"""
import csv
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).parent.parent
DATA = ROOT / "data" / "stadium_gates.json"
WEB = ROOT / "web" / "public" / "data"
RUNS = ROOT / "runs"

TARGET_PEOPLE = 2000


def main():
    WEB.mkdir(parents=True, exist_ok=True)
    RUNS.mkdir(parents=True, exist_ok=True)

    from nikaas.building import load, nearest_plan
    from nikaas.crowd import analyse as crowd_analyse
    from nikaas.optimise import optimise
    from nikaas.sim import simulate

    # ── scale the stadium ─────────────────────────────────────────────────────
    b_json = json.loads(DATA.read_bytes().decode("utf-8-sig"))
    original_total = sum(n.get("people", 0) for n in b_json["nodes"] if n.get("type") == "room")
    scale = TARGET_PEOPLE / original_total

    scaled = json.loads(json.dumps(b_json))  # deep copy
    scaled["name"] = "Representative cricket stadium (scaled to ~2,000 for demo)"
    for n in scaled["nodes"]:
        if "people" in n:
            n["people"] = max(1, round(n["people"] * scale))

    actual_total = sum(n.get("people", 0) for n in scaled["nodes"] if n.get("type") == "room")
    print(f"Stadium scaled: {original_total} -> {actual_total} people")

    # ── simulate both plans: today's nearest-exit rule and the Nikaas plan ────
    # (optimise() takes ~13 s here, too slow for a live API call, so the website loads these runs)
    b = load(scaled)
    plans = {"nearest": (nearest_plan(b, set()), None)}
    opt = optimise(b, set())
    plans["nikaas"] = (opt["plan"], opt["lower_bound_s"])

    building_out = WEB / "stadium_scaled.json"
    building_out.write_text(json.dumps(scaled, indent=2), encoding="utf-8")
    print(f"Building saved: {building_out}")

    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip() or "uncommitted"
    rows = []
    for name, (plan, bound) in plans.items():
        sim = simulate(b, plan, set(), max_t=2000, frame_every=5)
        sim["plan"] = plan
        sim["crowd"] = crowd_analyse(sim, scaled)
        if bound is not None:  # what the Twin's side panel shows for a Nikaas plan
            sim["lower_bound_s"], sim["nearest_s"] = round(bound, 2), rows[0][4]
        crowd = sim["crowd"]
        print(f"{name}: {sim['total_time_s']} s, {len(sim['frames'])} frames, "
              f"max crowd density {crowd['max_density']} p/m² on edge '{crowd['worst_edge']}'")
        frames_out = WEB / f"frames_stadium_{name}.json"
        frames_out.write_text(json.dumps(sim), encoding="utf-8")
        print(f"Frames saved: {frames_out}  ({frames_out.stat().st_size / 1e6:.2f} MB)")
        rows.append(["stadium_gates.json (scaled)", name, "-", actual_total, sim["total_time_s"],
                     crowd["max_density"], crowd["worst_edge"], crowd.get("first_crush_t", ""),
                     "" if bound is None else round(bound, 2), commit])

    # ── headline CSV ──────────────────────────────────────────────────────────
    csv_out = RUNS / "stadium_results.csv"
    with csv_out.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["building", "plan", "blocked_exit", "people", "total_time_s",
                    "max_density_pm2", "worst_edge", "first_crush_t", "lower_bound_s", "commit"])
        w.writerows(rows)
    print(f"CSV saved: {csv_out}")

if __name__ == "__main__":
    main()
