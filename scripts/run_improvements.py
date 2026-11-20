"""Room, door-level and share plans, and the time-expanded lower bound, against the exit-only bound.
Writes runs/improvements.csv. Run: python scripts/run_improvements.py"""
import csv, hashlib, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nikaas.building import load, nearest_plan  # noqa: E402
from nikaas.optimise import lower_bound, optimise, optimise_doors, optimise_shares  # noqa: E402
from nikaas.sim import simulate  # noqa: E402
from nikaas.tef import time_expanded_bound  # noqa: E402

CASES = [("data/lab_block.json", ()), ("data/lab_block.json", ("B",)), ("data/iit_kgp_museum.json", ()),
         ("data/iit_kgp_museum.json", ("MAIN",)), ("data/sample_floor.json", ()), ("data/sample_floor.json", ("A",)),
         ("data/multi_floor_tower.json", ()), ("data/multi_floor_office.json", ()),
         ("web/public/data/stadium_scaled.json", ()), ("web/public/data/stadium_scaled.json", ("GATE_W",))]
commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
rows = []
for f, blocked in CASES:
    b = load(ROOT / f)
    near = simulate(b, nearest_plan(b, blocked), blocked, frame_every=1e9)["total_time_s"]
    t0 = time.perf_counter()
    room = optimise(b, blocked, bound=False)
    door = optimise_doors(b, blocked, start=room["plan"])
    best_start = door if door["total_time_s"] < room["total_time_s"] else room
    share = optimise_shares(b, blocked, start=best_start["plan"], time_limit_s=600)
    t_opt = time.perf_counter() - t0
    best = min(room["total_time_s"], door["total_time_s"], share["total_time_s"])
    lp = lower_bound(b, blocked)
    t0 = time.perf_counter()
    tef = max(time_expanded_bound(b, blocked, dt=1.0, upper=near), time_expanded_bound(b, blocked, dt=0.5, upper=near))
    t_tef = time.perf_counter() - t0
    bound = max(lp, tef)
    assert bound <= best, f"bound {bound} above an achieved plan {best} in {f} {blocked}"
    rows.append([Path(f).name, hashlib.sha256((ROOT / f).read_bytes()).hexdigest()[:12], "+".join(blocked) or "-",
                 sum(b.people().values()), near, room["total_time_s"], door["total_time_s"], share["total_time_s"],
                 lp, tef, bound, round(best - bound, 2), round(t_opt, 2), round(t_tef, 2), commit])
    print(rows[-1], flush=True)
with open(ROOT / "runs/improvements.csv", "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["building", "sha256", "blocked", "people", "nearest_s", "room_plan_s", "door_plan_s", "share_plan_s",
                "exit_bound_s", "time_expanded_bound_s", "bound_s", "gap_s", "optimise_runtime_s", "tef_runtime_s", "commit"])
    w.writerows(rows)
