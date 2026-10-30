"""Save the nearest-exit and Nikaas-plan runs of one building for the website's Twin (offline playback).

Usage (repo root):  PYTHONPATH=. python scripts/precompute_frames.py data/multi_floor_tower.json tower
Writes web/public/data/<name>.json (the building) and frames_<name>_nearest.json / frames_<name>_nikaas.json.
The totals are the same runs as runs/multi_floor.csv; this script only adds the frames for playback.
"""
import json
import sys
from pathlib import Path

from nikaas.building import load, nearest_plan
from nikaas.optimise import optimise
from nikaas.sim import simulate

src, name = Path(sys.argv[1]), sys.argv[2]
frame_every = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
web = Path("web/public/data")
d = json.loads(src.read_text(encoding="utf-8-sig"))
(web / f"{name}.json").write_text(json.dumps(d, indent=1), encoding="utf-8")
b = load(d)
near = simulate(b, nearest_plan(b, set()), set(), frame_every=frame_every)
near["plan"] = nearest_plan(b, set())
opt = optimise(b, set())
run = simulate(b, opt["plan"], set(), frame_every=frame_every)
run.update(plan=opt["plan"], lower_bound_s=round(opt["lower_bound_s"], 2), nearest_s=near["total_time_s"])
for plan, r in (("nearest", near), ("nikaas", run)):
    out = web / f"frames_{name}_{plan}.json"
    out.write_text(json.dumps(r), encoding="utf-8")
    print(f"{plan}: {r['total_time_s']} s, {len(r['frames'])} frames, {out} ({out.stat().st_size / 1e6:.2f} MB)")
