"""Multi-Floor Evacuation Benchmark Suite.
Runs reproducible multi-floor scenarios and records results to runs/multi_floor.csv and runs/multi_floor.json.
"""
import copy
import csv
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from nikaas.building import load, nearest_plan, validate
from nikaas.optimise import lower_bound, optimise
from nikaas.sim import simulate


def get_git_commit():
    try:
        r = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True)
        return r.stdout.strip()
    except Exception:
        return "unknown"


def sha256_of_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def run_benchmarks():
    commit = get_git_commit()
    office_path = ROOT / "data/multi_floor_office.json"
    tower_path = ROOT / "data/multi_floor_tower.json"

    office_d = json.loads(office_path.read_text(encoding="utf-8"))
    tower_d = json.loads(tower_path.read_text(encoding="utf-8"))

    results = []

    # Scenario 1: 3-Floor Office — Normal Operation (Nearest vs Optimised)
    b_office = load(office_d)
    t0 = time.perf_counter()
    n_plan = nearest_plan(b_office)
    n_sim = simulate(b_office, n_plan, frame_every=1e9)
    opt_res = optimise(b_office)
    lb = lower_bound(b_office)
    dt = round(time.perf_counter() - t0, 3)

    results.append({
        "scenario": "3_floor_office_normal",
        "building_hash": sha256_of_file(office_path),
        "commit": commit,
        "floor_count": len(b_office.floors),
        "room_count": len(b_office.rooms),
        "total_occupants": sum(b_office.people().values()),
        "stairwell_count": 2,
        "blocked_resources": "none",
        "plan_type": "nikaas_plan",
        "plan": opt_res["plan"],
        "completed": opt_res["total_time_s"] is not None,
        "movement_time_s": opt_res["total_time_s"],
        "nearest_time_s": n_sim["total_time_s"],
        "lower_bound_s": lb,
        "gap_to_bound_s": round(opt_res["total_time_s"] - lb, 2) if opt_res["total_time_s"] else None,
        "per_floor_population": {f: v["occupants"] for f, v in n_sim["per_floor"].items()},
        "per_exit_population": n_sim["per_exit"],
        "stairwell_load": n_sim["stairwell_load"],
        "runtime_s": dt,
    })

    # Scenario 2: 3-Floor Office — Block North Exit (Forcing South Stairwell)
    t0 = time.perf_counter()
    b_blocked_n = load(office_d)
    n_plan_blk = nearest_plan(b_blocked_n, blocked={"exit_north"})
    n_sim_blk = simulate(b_blocked_n, n_plan_blk, blocked={"exit_north"}, frame_every=1e9)
    lb_blk = lower_bound(b_blocked_n, blocked={"exit_north"})
    dt = round(time.perf_counter() - t0, 3)

    results.append({
        "scenario": "3_floor_office_north_exit_blocked",
        "building_hash": sha256_of_file(office_path),
        "commit": commit,
        "floor_count": len(b_office.floors),
        "room_count": len(b_office.rooms),
        "total_occupants": sum(b_office.people().values()),
        "stairwell_count": 2,
        "blocked_resources": "exit_north",
        "plan_type": "nearest_plan",
        "plan": n_plan_blk,
        "completed": n_sim_blk["completed"],
        "movement_time_s": n_sim_blk["total_time_s"],
        "nearest_time_s": n_sim_blk["total_time_s"],
        "lower_bound_s": lb_blk,
        "gap_to_bound_s": round(n_sim_blk["total_time_s"] - lb_blk, 2) if n_sim_blk["total_time_s"] else None,
        "per_floor_population": {f: v["occupants"] for f, v in n_sim_blk["per_floor"].items()},
        "per_exit_population": n_sim_blk["per_exit"],
        "stairwell_load": n_sim_blk["stairwell_load"],
        "runtime_s": dt,
    })

    # Scenario 3: 3-Floor Office — Block South Exit (Forcing North Stairwell)
    t0 = time.perf_counter()
    n_plan_s_blk = nearest_plan(b_blocked_n, blocked={"exit_south"})
    n_sim_s_blk = simulate(b_blocked_n, n_plan_s_blk, blocked={"exit_south"}, frame_every=1e9)
    lb_s_blk = lower_bound(b_blocked_n, blocked={"exit_south"})
    dt = round(time.perf_counter() - t0, 3)

    results.append({
        "scenario": "3_floor_office_south_exit_blocked",
        "building_hash": sha256_of_file(office_path),
        "commit": commit,
        "floor_count": len(b_office.floors),
        "room_count": len(b_office.rooms),
        "total_occupants": sum(b_office.people().values()),
        "stairwell_count": 2,
        "blocked_resources": "exit_south",
        "plan_type": "nearest_plan",
        "plan": n_plan_s_blk,
        "completed": n_sim_s_blk["completed"],
        "movement_time_s": n_sim_s_blk["total_time_s"],
        "nearest_time_s": n_sim_s_blk["total_time_s"],
        "lower_bound_s": lb_s_blk,
        "gap_to_bound_s": round(n_sim_s_blk["total_time_s"] - lb_s_blk, 2) if n_sim_s_blk["total_time_s"] else None,
        "per_floor_population": {f: v["occupants"] for f, v in n_sim_s_blk["per_floor"].items()},
        "per_exit_population": n_sim_s_blk["per_exit"],
        "stairwell_load": n_sim_s_blk["stairwell_load"],
        "runtime_s": dt,
    })

    # Scenario 4: Narrow Stairwells (1.0m width vs standard 1.6m width)
    narrow_d = copy.deepcopy(office_d)
    for e in narrow_d["edges"]:
        if e.get("kind") == "stair":
            e["width"] = 1.0
    b_narrow = load(narrow_d)
    t0 = time.perf_counter()
    n_plan_narrow = nearest_plan(b_narrow)
    n_sim_narrow = simulate(b_narrow, n_plan_narrow, frame_every=1e9)
    opt_narrow = optimise(b_narrow)
    lb_narrow = lower_bound(b_narrow)
    dt = round(time.perf_counter() - t0, 3)

    results.append({
        "scenario": "3_floor_narrow_stairwell_1m",
        "building_hash": sha256_of_file(office_path),
        "commit": commit,
        "floor_count": 3,
        "room_count": 10,
        "total_occupants": 400,
        "stairwell_count": 2,
        "blocked_resources": "none",
        "plan_type": "nikaas_plan",
        "plan": opt_narrow["plan"],
        "completed": opt_narrow["total_time_s"] is not None,
        "movement_time_s": opt_narrow["total_time_s"],
        "nearest_time_s": n_sim_narrow["total_time_s"],
        "lower_bound_s": lb_narrow,
        "gap_to_bound_s": round(opt_narrow["total_time_s"] - lb_narrow, 2) if opt_narrow["total_time_s"] else None,
        "per_floor_population": {f: v["occupants"] for f, v in n_sim_narrow["per_floor"].items()},
        "per_exit_population": n_sim_narrow["per_exit"],
        "stairwell_load": n_sim_narrow["stairwell_load"],
        "runtime_s": dt,
    })

    # Scenario 5: Uneven Occupant Distribution (Top Floor Doubled)
    uneven_d = copy.deepcopy(office_d)
    for n in uneven_d["nodes"]:
        if n.get("floor_id") == "F2" and n.get("type") == "room":
            n["people"] = n["people"] * 2  # 90 people each
    b_uneven = load(uneven_d)
    t0 = time.perf_counter()
    n_plan_uneven = nearest_plan(b_uneven)
    n_sim_uneven = simulate(b_uneven, n_plan_uneven, frame_every=1e9)
    opt_uneven = optimise(b_uneven)
    lb_uneven = lower_bound(b_uneven)
    dt = round(time.perf_counter() - t0, 3)

    results.append({
        "scenario": "3_floor_office_uneven_top_heavy",
        "building_hash": sha256_of_file(office_path),
        "commit": commit,
        "floor_count": 3,
        "room_count": 10,
        "total_occupants": sum(b_uneven.people().values()),
        "stairwell_count": 2,
        "blocked_resources": "none",
        "plan_type": "nikaas_plan",
        "plan": opt_uneven["plan"],
        "completed": opt_uneven["total_time_s"] is not None,
        "movement_time_s": opt_uneven["total_time_s"],
        "nearest_time_s": n_sim_uneven["total_time_s"],
        "lower_bound_s": lb_uneven,
        "gap_to_bound_s": round(opt_uneven["total_time_s"] - lb_uneven, 2) if opt_uneven["total_time_s"] else None,
        "per_floor_population": {f: v["occupants"] for f, v in n_sim_uneven["per_floor"].items()},
        "per_exit_population": n_sim_uneven["per_exit"],
        "stairwell_load": n_sim_uneven["stairwell_load"],
        "runtime_s": dt,
    })

    # Scenario 6: 5-Floor Tower Vertical Scaling
    b_tower = load(tower_d)
    t0 = time.perf_counter()
    n_plan_tower = nearest_plan(b_tower)
    n_sim_tower = simulate(b_tower, n_plan_tower, frame_every=1e9)
    opt_tower = optimise(b_tower)
    lb_tower = lower_bound(b_tower)
    dt = round(time.perf_counter() - t0, 3)

    results.append({
        "scenario": "5_floor_tower_scaling",
        "building_hash": sha256_of_file(tower_path),
        "commit": commit,
        "floor_count": len(b_tower.floors),
        "room_count": len(b_tower.rooms),
        "total_occupants": sum(b_tower.people().values()),
        "stairwell_count": 2,
        "blocked_resources": "none",
        "plan_type": "nikaas_plan",
        "plan": opt_tower["plan"],
        "completed": opt_tower["total_time_s"] is not None,
        "movement_time_s": opt_tower["total_time_s"],
        "nearest_time_s": n_sim_tower["total_time_s"],
        "lower_bound_s": lb_tower,
        "gap_to_bound_s": round(opt_tower["total_time_s"] - lb_tower, 2) if opt_tower["total_time_s"] else None,
        "per_floor_population": {f: v["occupants"] for f, v in n_sim_tower["per_floor"].items()},
        "per_exit_population": n_sim_tower["per_exit"],
        "stairwell_load": n_sim_tower["stairwell_load"],
        "runtime_s": dt,
    })

    # Save to runs/multi_floor.json
    runs_dir = ROOT / "runs"
    runs_dir.mkdir(exist_ok=True)
    out_json = runs_dir / "multi_floor.json"
    out_json.write_text(json.dumps(results, indent=2), encoding="utf-8")

    # Save to runs/multi_floor.csv
    out_csv = runs_dir / "multi_floor.csv"
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        fieldnames = [
            "scenario", "building_hash", "commit", "floor_count", "room_count",
            "total_occupants", "stairwell_count", "blocked_resources", "plan_type",
            "completed", "movement_time_s", "nearest_time_s", "lower_bound_s",
            "gap_to_bound_s", "runtime_s"
        ]
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for r in results:
            writer.writerow(r)

    print(f"Generated {len(results)} multi-floor benchmarks in runs/multi_floor.csv and runs/multi_floor.json")
    for r in results:
        print(f" - {r['scenario']}: {r['movement_time_s']} s (nearest: {r['nearest_time_s']} s, LB: {r['lower_bound_s']} s, gap: {r['gap_to_bound_s']} s, runtime: {r['runtime_s']} s)")


if __name__ == "__main__":
    run_benchmarks()
