"""Acceptance tests written before trusting any number (hand-computed expectations)."""
import json
from pathlib import Path

import pytest

from nikaas.building import load, nearest_plan
from nikaas.sim import BOUNDARY, SPECIFIC_FLOW, WALK_SPEED, simulate

ROOT = Path(__file__).resolve().parents[1]


def one_room(n, door_w=1.0, length=10.0):
    return load({"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": n, "w": 0.1, "d": 0.1},
                           {"id": "X", "type": "exit", "x": length, "z": 0}],
                 "edges": [{"from": "r", "to": "X", "width": door_w, "length": length, "kind": "door"}]})


def test_single_door_matches_hand_calculation():
    # Hand calc: last person enters the door after n / (w * Fs) s, then walks L / v.
    n, w, L = 120, 1.0, 10.0
    b = one_room(n, w, L)
    out = simulate(b, {"r": "X"})
    expected = n / ((w - 2 * BOUNDARY["door"]) * SPECIFIC_FLOW["door"]) + L / WALK_SPEED
    assert out["completed"]
    assert out["total_time_s"] == pytest.approx(expected, rel=0.05)


def test_everyone_is_accounted_for():
    b = load(ROOT / "data/sample_floor.json")
    out = simulate(b, nearest_plan(b))
    assert out["completed"]
    assert sum(out["per_exit"].values()) == out["people"] == sum(b.people().values())


def test_blocked_exit_sends_everyone_to_the_other_one():
    b = load(ROOT / "data/sample_floor.json")
    plan = nearest_plan(b, blocked={"A"})
    assert set(plan.values()) == {"B"}
    out = simulate(b, plan, blocked={"A"})
    assert out["per_exit"]["A"] == 0 and out["per_exit"]["B"] == out["people"]


def test_plan_into_blocked_exit_is_rejected():
    b = load(ROOT / "data/sample_floor.json")
    with pytest.raises(ValueError):
        simulate(b, {r: "A" for r in b.rooms}, blocked={"A"})


def test_wider_door_is_never_slower():
    narrow = simulate(one_room(80, 0.9), {"r": "X"})["total_time_s"]
    wide = simulate(one_room(80, 1.8), {"r": "X"})["total_time_s"]
    assert wide < narrow


def test_frames_are_in_contract_shape():
    b = load(ROOT / "data/sample_floor.json")
    out = simulate(b, nearest_plan(b))
    f = out["frames"][0]
    assert set(f) == {"t", "people"}
    x, z, state = f["people"][0]
    assert state in {"inside", "walking", "queuing", "stairs", "out"}
    json.dumps(out)  # must serialise for the API


def test_busiest_edge_is_the_stair_in_front_of_the_overloaded_exit():
    b = load(ROOT / "data/sample_floor.json")
    plan = nearest_plan(b)
    out = simulate(b, plan)
    loads = list(out["per_exit"].items())
    heavy_exit = max(loads, key=lambda kv: kv[1])[0]
    busiest = next(iter(out["edge_load"]))
    assert busiest == out["bottleneck"]
    assert busiest.endswith(f"-{heavy_exit}")  # the stair into the exit that got the most people


def test_api_returns_edge_load_and_lambda_handler_exists():
    from fastapi.testclient import TestClient
    from nikaas import api
    b = json.loads((ROOT / "data/sample_floor.json").read_text())
    r = TestClient(api.app).post("/simulate", json={"building": b})
    assert r.status_code == 200 and r.json()["edge_load"]
    assert api.handler is not None


def test_room_with_two_doors_uses_both():
    # 100 people, two equal 1 m doors onto the same corridor: both doors carry ~half,
    # so the room empties about twice as fast as through one door.
    two = load({"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": 100, "w": .1, "d": .1},
                          {"id": "c1", "type": "corridor", "x": 2, "z": -1}, {"id": "c2", "type": "corridor", "x": 2, "z": 1},
                          {"id": "X", "type": "exit", "x": 10, "z": 0}],
                "edges": [{"from": "r", "to": "c1", "width": 1}, {"from": "r", "to": "c2", "width": 1},
                          {"from": "c1", "to": "X", "width": 5}, {"from": "c2", "to": "X", "width": 5}]})
    one = load({"nodes": two_nodes_one_door(), "edges": [{"from": "r", "to": "c1", "width": 1}, {"from": "c1", "to": "X", "width": 5}]})
    t2 = simulate(two, {"r": "X"})
    t1 = simulate(one, {"r": "X"})
    assert len(t2["door_routes"]["r"]) == 2
    assert t2["total_time_s"] < 0.6 * t1["total_time_s"]


def two_nodes_one_door():
    return [{"id": "r", "type": "room", "x": 0, "z": 0, "people": 100, "w": .1, "d": .1},
            {"id": "c1", "type": "corridor", "x": 2, "z": -1}, {"id": "X", "type": "exit", "x": 10, "z": 0}]


def test_reproduces_sfpe_engineering_guide_example_1():
    """300 people, two 32 in doors into two 44 in stairs (7/11 in, 50 ft), 10 ft landing to the exit.
    Published hand calculation: T1 1.0 s + T2 225.0 s + T3 19.2 s = 245.2 s
    (Thunderhead Pathfinder verification docs, SFPE Example 1)."""
    FT, IN = 0.3048, 0.0254
    nodes = [{"id": "room", "type": "room", "x": 0, "z": 0, "people": 300, "w": 0.01, "d": 0.01}]
    edges = []
    for k in ("L", "R"):
        nodes += [{"id": f"top{k}", "type": "corridor", "x": 0, "z": 0}, {"id": f"bot{k}", "type": "corridor", "x": 0, "z": 0},
                  {"id": f"X{k}", "type": "exit", "x": 0, "z": 0}]
        edges += [{"from": "room", "to": f"top{k}", "width": 32 * IN, "length": 1.0 * WALK_SPEED, "kind": "door"},
                  {"from": f"top{k}", "to": f"bot{k}", "width": 44 * IN, "length": 50 * FT, "kind": "stair"},
                  {"from": f"bot{k}", "to": f"X{k}", "width": 30 * FT, "length": 10 * FT, "kind": "corridor"}]
    # the example is symmetric: model one side with half the occupants (150), as the hand calculation does
    out_l = simulate(load({"nodes": [dict(n, people=150) if n["id"] == "room" else n for n in nodes if not n["id"].endswith("R")],
                           "edges": [e for e in edges if not e["to"].endswith("R")]}), {"room": "XL"})
    assert out_l["total_time_s"] == pytest.approx(245.2, rel=0.02)


def test_queuing_people_are_spread_out_not_stacked():
    b = load(ROOT / "data/iit_kgp_museum.json")
    out = simulate(b, nearest_plan(b))
    first = out["frames"][0]["people"]
    queued = {(x, z) for x, z, st in first if st == "queuing"}
    n_queued = sum(1 for *_, st in first if st == "queuing")
    assert n_queued > 100 and len(queued) > 0.9 * n_queued  # almost every queued person has their own spot


def test_total_time_ignores_people_waiting_at_a_refuge():
    # A room whose only exit is down a stair: wheelchair users cannot use stairs, so they wait at a refuge.
    # The total time must be the time of the last person who actually walks out, not NaN.
    b = load({"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": 20, "w": 0.1, "d": 0.1},
                        {"id": "c", "type": "corridor", "x": 5, "z": 0},
                        {"id": "X", "type": "exit", "x": 10, "z": 0}],
              "edges": [{"from": "r", "to": "c", "width": 1.0, "length": 5.0, "kind": "door"},
                        {"from": "c", "to": "X", "width": 1.2, "length": 5.0, "kind": "stair"}]})
    walk = simulate(b, {"r": "X"}, frame_every=1e9)
    mixed = simulate(b, {"r": "X"}, frame_every=1e9, wheelchair_fraction=0.1)
    assert mixed["wheelchair_refuge"] == 2
    assert mixed["total_time_s"] == mixed["total_time_s"]  # not NaN
    assert 0 < mixed["total_time_s"] <= walk["total_time_s"]
