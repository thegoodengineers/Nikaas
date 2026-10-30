"""Acceptance tests for Ayush's optimiser, lower bound, and 'Beat Nikaas' score."""
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from nikaas.api import app
from nikaas.building import load, nearest_plan
from nikaas.optimise import lower_bound, optimise
from nikaas.sim import simulate

ROOT = Path(__file__).resolve().parents[1]


def test_two_exits_one_blocked_sends_everyone_to_other():
    b = load(ROOT / "data/sample_floor.json")
    res = optimise(b, blocked=["A"])
    assert set(res["plan"].values()) == {"B"}
    assert res["total_time_s"] > 0
    assert res["lower_bound_s"] <= res["total_time_s"]


def test_negative_control_nearest_already_optimal():
    # Symmetric building: two identical rooms at x = -10 and x = +10,
    # two identical exits at x = -20 and x = +20.
    # Nearest assigns r1 -> A, r2 -> B.
    # Any other assignment doubles exit load and adds 3x walk time.
    # Optimiser must report the EXACT same plan and time, with no fake gain.
    symmetric = {
        "nodes": [
            {"id": "r1", "type": "room", "x": -10, "z": 0, "people": 50, "w": 4, "d": 4},
            {"id": "r2", "type": "room", "x": 10, "z": 0, "people": 50, "w": 4, "d": 4},
            {"id": "c1", "type": "corridor", "x": -10, "z": 0},
            {"id": "c2", "type": "corridor", "x": 10, "z": 0},
            {"id": "A", "type": "exit", "x": -20, "z": 0},
            {"id": "B", "type": "exit", "x": 20, "z": 0},
        ],
        "edges": [
            {"from": "r1", "to": "c1", "width": 1.2, "kind": "door"},
            {"from": "r2", "to": "c2", "width": 1.2, "kind": "door"},
            {"from": "c1", "to": "A", "width": 1.5, "length": 10.0, "kind": "corridor"},
            {"from": "c2", "to": "B", "width": 1.5, "length": 10.0, "kind": "corridor"},
            {"from": "c1", "to": "c2", "width": 1.5, "length": 20.0, "kind": "corridor"},
        ],
    }
    b = load(symmetric)
    near = nearest_plan(b)
    near_time = simulate(b, near, frame_every=1e9)["total_time_s"]

    opt = optimise(b)
    assert opt["plan"] == near
    assert opt["total_time_s"] == pytest.approx(near_time, abs=0.1)
    assert opt["lower_bound_s"] <= opt["total_time_s"]


def test_lower_bound_is_lower_bound_for_all_buildings():
    for name in ["sample_floor.json", "lab_block.json", "iit_kgp_museum.json"]:
        b = load(ROOT / f"data/{name}")
        near_plan = nearest_plan(b)
        near_time = simulate(b, near_plan, frame_every=1e9)["total_time_s"]

        opt = optimise(b)
        lb = opt["lower_bound_s"]

        # Lower bound must be <= both nearest time and optimised time
        assert lb <= near_time
        assert lb <= opt["total_time_s"]
        assert lb > 0


def test_optimise_beats_nearest_on_sample_floor():
    b = load(ROOT / "data/sample_floor.json")
    near_time = simulate(b, nearest_plan(b), frame_every=1e9)["total_time_s"]
    opt = optimise(b)
    assert opt["total_time_s"] < near_time
    assert opt["total_time_s"] <= 153.0  # beats 156.5s


def test_optimise_beats_nearest_on_lab_block():
    b = load(ROOT / "data/lab_block.json")
    near_time = simulate(b, nearest_plan(b), frame_every=1e9)["total_time_s"]
    opt = optimise(b)
    # Nearest was 301.25s due to Stair A overload; optimised is ~166s (>130s saved)
    assert opt["total_time_s"] < near_time - 100.0
    assert opt["total_time_s"] <= 170.0


def test_optimise_beats_nearest_on_iit_kgp_museum():
    b = load(ROOT / "data/iit_kgp_museum.json")
    near_time = simulate(b, nearest_plan(b), frame_every=1e9)["total_time_s"]
    opt = optimise(b)
    # Nearest was 145.25s; optimised drops off the narrow verandah door to ~124s
    assert opt["total_time_s"] < near_time
    assert opt["total_time_s"] <= 126.0


def test_api_optimise_endpoint():
    client = TestClient(app)
    b_data = json.loads((ROOT / "data/sample_floor.json").read_text())

    # Successful call
    r = client.post("/optimise", json={"building": b_data})
    assert r.status_code == 200
    data = r.json()
    assert "plan" in data and "total_time_s" in data and "lower_bound_s" in data
    assert data["total_time_s"] < 156.0
    assert data["lower_bound_s"] <= data["total_time_s"]

    # Blocked exit call
    r_blocked = client.post("/optimise", json={"building": b_data, "blocked": ["A"]})
    assert r_blocked.status_code == 200
    assert set(r_blocked.json()["plan"].values()) == {"B"}

    # Invalid building validation rejection
    bad = {"nodes": [{"id": "r", "type": "room", "x": 0, "z": 0, "people": 5}], "edges": []}
    r_bad = client.post("/optimise", json={"building": bad})
    assert r_bad.status_code == 422
