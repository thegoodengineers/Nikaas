"""Time-expanded lower bound and door-level plans: checked against hand calculations and the simulator."""
import itertools
from pathlib import Path

from nikaas.building import load, nearest_plan
from nikaas.optimise import optimise, optimise_doors
from nikaas.sim import SPECIFIC_FLOW, WALK_SPEED, effective_width, simulate
from nikaas.tef import time_expanded_bound

ROOT = Path(__file__).resolve().parents[1]


def one_room(n, door_w=1.0, length=10.0):
    return load({"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": n, "w": 0.1, "d": 0.1},
                           {"id": "X", "type": "exit", "x": length, "z": 0}],
                 "edges": [{"from": "r", "to": "X", "width": door_w, "length": length, "kind": "door"}]})


def test_bound_matches_single_door_hand_calculation():
    # everyone must pass one door: n / c seconds of flow plus the walk. With 1 s steps the bound rounds the
    # horizon, the walk and each step's capacity, so it may sit up to about 3 s below the hand value
    b = one_room(100)
    c = effective_width(b.edges[0]) * SPECIFIC_FLOW["door"]
    hand = 100 / c + 10 / WALK_SPEED
    lb = time_expanded_bound(b)
    assert hand - 3.0 <= lb <= hand
    assert lb <= simulate(b, {"r": "X"}, frame_every=1e9)["total_time_s"]


def test_bound_never_beats_any_plan_of_the_sample_floor():
    b = load(ROOT / "data/sample_floor.json")
    lb = time_expanded_bound(b)
    best = min(simulate(b, dict(zip(b.rooms, xs)), frame_every=1e9)["total_time_s"]
               for xs in itertools.product(b.exits, repeat=len(b.rooms)))
    assert lb <= best


def test_bound_is_tighter_than_the_exit_only_bound_on_the_tower():
    b = load(ROOT / "data/multi_floor_tower.json")
    out = optimise(b)
    assert out["lower_bound_s"] >= time_expanded_bound(b) > 180  # old exit/stairwell bound was 179.73
    assert out["lower_bound_s"] <= out["total_time_s"]


def test_door_level_plan_keeps_everyone_and_is_never_slower():
    b = load(ROOT / "data/lab_block.json")
    room = optimise(b, bound=False)
    door = optimise_doors(b, start=room["plan"])
    run = simulate(b, door["plan"], frame_every=1e9)
    assert run["people"] == sum(b.people().values()) and run["completed"]
    assert door["total_time_s"] <= room["total_time_s"]


def test_door_level_plan_splits_a_room_across_exits():
    # one room, two doors, each door next to its own exit: sending each door to its own exit beats one exit
    b = load({"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": 200, "w": 10, "d": 4},
                        {"id": "A", "type": "exit", "x": -10, "z": 0}, {"id": "B", "type": "exit", "x": 10, "z": 0}],
              "edges": [{"from": "r", "to": "A", "width": 1.0, "length": 10, "kind": "door"},
                        {"from": "r", "to": "B", "width": 1.0, "length": 10, "kind": "door"}]})
    one = simulate(b, {"r": "A"}, frame_every=1e9)
    split = simulate(b, {"r": {"A": "A", "B": "B"}}, frame_every=1e9)
    assert split["per_exit"] == {"A": 100, "B": 100} and split["total_time_s"] <= one["total_time_s"]


def test_share_plan_divides_a_room_exactly():
    b = load({"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": 101, "w": 10, "d": 4},
                        {"id": "A", "type": "exit", "x": -10, "z": 0}, {"id": "B", "type": "exit", "x": 10, "z": 0}],
              "edges": [{"from": "r", "to": "A", "width": 1.0, "length": 10, "kind": "door"},
                        {"from": "r", "to": "B", "width": 1.0, "length": 10, "kind": "door"}]})
    run = simulate(b, {"r": {"A": 0.3, "B": 0.7}}, frame_every=1e9)
    assert run["per_exit"] == {"A": 30, "B": 71} and run["people"] == 101 and run["completed"]


def test_share_plans_beat_room_plans_and_respect_the_bound():
    from nikaas.optimise import optimise_shares
    b = load(ROOT / "data/sample_floor.json")
    room = optimise(b)  # 152.5 s, the best of all 64 room plans
    shares = optimise_shares(b, start=room["plan"], time_limit_s=120)
    assert shares["total_time_s"] < room["total_time_s"]
    assert shares["total_time_s"] >= room["lower_bound_s"]
    run = simulate(b, shares["plan"], frame_every=1e9)
    assert run["people"] == sum(b.people().values()) and run["total_time_s"] == shares["total_time_s"]
