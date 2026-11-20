"""Time-expanded lower bound and door-level plans, compared with the room plan and the exit-only bound.
Writes runs/improvements.csv. Run: python scripts/run_improvements.py"""
import csv, hashlib, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from nikaas.building import load, nearest_plan  # noqa: E402
from nikaas.optimise import lower_bound, optimise, optimise_doors  # noqa: E402
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
    t_opt = time.perf_counter() - t0
    lp = lower_bound(b, blocked)
    t0 = time.perf_counter()
    tef = time_expanded_bound(b, blocked, upper=near)
    t_tef = time.perf_counter() - t0
    bound = min(max(lp, tef), door["total_time_s"])
    rows.append([Path(f).name, hashlib.sha256((ROOT / f).read_bytes()).hexdigest()[:12], "+".join(blocked) or "-",
                 sum(b.people().values()), near, room["total_time_s"], door["total_time_s"], lp, tef, bound,
                 round(door["total_time_s"] - bound, 2), round(t_opt, 2), round(t_tef, 2), commit])
    print(rows[-1], flush=True)
with open(ROOT / "runs/improvements.csv", "w", newline="", encoding="utf-8") as fh:
    w = csv.writer(fh)
    w.writerow(["building", "sha256", "blocked", "people", "nearest_s", "room_plan_s", "door_plan_s", "exit_bound_s",
                "time_expanded_bound_s", "bound_s", "gap_s", "optimise_runtime_s", "tef_runtime_s", "commit"])
    w.writerows(rows)
