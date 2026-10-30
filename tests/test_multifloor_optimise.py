"""Tests for multi-floor evacuation optimization and LP lower bound."""
import json
from pathlib import Path

import pytest
from nikaas.building import load, nearest_plan
from nikaas.optimise import lower_bound, optimise
from nikaas.sim import simulate

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def office_building():
    return load(ROOT / "data/multi_floor_office.json")


@pytest.fixture
def tower_building():
    return load(ROOT / "data/multi_floor_tower.json")


def test_upper_floor_rooms_assigned_to_ground_exits(office_building):
    b = office_building
    res = optimise(b)
    assert "plan" in res
    plan = res["plan"]
    # Every room on F1 and F2 must be assigned to either exit_north or exit_south
    for r in ("r_F1_1", "r_F1_2", "r_F1_3", "r_F1_4", "r_F2_1", "r_F2_2", "r_F2_3", "r_F2_4"):
        assert plan[r] in ("exit_north", "exit_south")


def test_optimiser_balances_load_across_stairwells(office_building):
    b = office_building
    res = optimise(b)
    plan = res["plan"]
    sim_res = simulate(b, plan, frame_every=1e9)
    # Both exits should be used actively
    assert sim_res["per_exit"]["exit_north"] > 100
    assert sim_res["per_exit"]["exit_south"] > 100


def test_blocking_one_exit_reroutes_all_upper_floor_occupants(office_building):
    b = office_building
    res = optimise(b, blocked={"exit_north"})
    plan = res["plan"]
    for r, ex in plan.items():
        assert ex == "exit_south"
    sim_res = simulate(b, plan, blocked={"exit_north"}, frame_every=1e9)
    assert sim_res["completed"] is True
    assert sim_res["per_exit"]["exit_north"] == 0
    assert sim_res["per_exit"]["exit_south"] == 400


def test_lower_bound_is_lower_bound_for_multifloor_buildings(office_building, tower_building):
    for b in (office_building, tower_building):
        n_plan = nearest_plan(b)
        n_time = simulate(b, n_plan, frame_every=1e9)["total_time_s"]
        lb = lower_bound(b)
        assert lb <= n_time

        opt_res = optimise(b)
        opt_time = opt_res["total_time_s"]
        assert lb <= opt_time


def test_stairwell_capacity_cuts_strengthen_lp_lower_bound():
    # In a building where stair capacity is the dominant bottleneck,
    # the lower bound must reflect the stair discharge time: N / C_stair.
    d = {
        "name": "Stair Bottleneck Bound",
        "floors": [
            {"id": "GF", "name": "GF", "elevation_m": 0.0},
            {"id": "F1", "name": "F1", "elevation_m": 3.5}
        ],
        "nodes": [
            {"id": "exit", "type": "exit", "floor_id": "GF", "x": 0.0, "z": 0.0},
            {"id": "land_GF", "type": "corridor", "floor_id": "GF", "x": 0.0, "z": 2.0},
            {"id": "land_F1", "type": "corridor", "floor_id": "F1", "x": 0.0, "z": 2.0},
            {"id": "room_1", "type": "room", "floor_id": "F1", "x": 5.0, "z": 2.0, "w": 4.0, "d": 4.0, "people": 150}
        ],
        "edges": [
            {"from": "exit", "to": "land_GF", "width": 10.0, "length": 2.0, "kind": "corridor"},  # huge exit
            {"from": "room_1", "to": "land_F1", "width": 10.0, "length": 5.0, "kind": "door"},  # huge door
            {"from": "land_F1", "to": "land_GF", "width": 1.3, "length": 5.0, "kind": "stair", "capacity_group": "choke"}  # bottleneck stair
        ]
    }
    b = load(d)
    lb = lower_bound(b)
    # Effective stair width = 1.0 m, specific flow = 1.012 p/s.
    # Stair capacity = 1.012 p/s.
    # 150 people through 1.012 p/s stair takes at least ~148 s.
    # If the LP ignored stair capacity and only checked the huge 10m exit,
    # it would return an unphysically low ~15 s!
    assert lb >= 140.0


def test_optimiser_beats_nearest_on_tower(tower_building):
    b = tower_building
    n_time = simulate(b, nearest_plan(b), frame_every=1e9)["total_time_s"]
    opt_res = optimise(b)
    assert opt_res["total_time_s"] < n_time


def test_lp_lower_bound_strictly_bounds_multidoor_stairwell_split():
    # Multi-door room where doors lead to different stairwells
    d = {
        "name": "Multi-door Stairwell Split Test",
        "floors": [
            {"id": "GF", "name": "GF", "elevation_m": 0.0},
            {"id": "F1", "name": "F1", "elevation_m": 3.5}
        ],
        "nodes": [
            {"id": "exit", "type": "exit", "floor_id": "GF", "x": 0.0, "z": 0.0},
            {"id": "land_A_GF", "type": "corridor", "floor_id": "GF", "x": -5.0, "z": 0.0},
            {"id": "land_B_GF", "type": "corridor", "floor_id": "GF", "x": 5.0, "z": 0.0},
            {"id": "land_A_F1", "type": "corridor", "floor_id": "F1", "x": -5.0, "z": 0.0},
            {"id": "land_B_F1", "type": "corridor", "floor_id": "F1", "x": 5.0, "z": 0.0},
            {"id": "r1", "type": "room", "floor_id": "F1", "x": 0.0, "z": 0.0, "w": 6.0, "d": 4.0, "people": 100}
        ],
        "edges": [
            {"from": "exit", "to": "land_A_GF", "width": 3.0, "length": 5.0, "kind": "corridor"},
            {"from": "exit", "to": "land_B_GF", "width": 3.0, "length": 5.0, "kind": "corridor"},
            {"from": "r1", "to": "land_A_F1", "width": 1.5, "length": 5.0, "kind": "door"},
            {"from": "r1", "to": "land_B_F1", "width": 1.5, "length": 5.0, "kind": "door"},
            {"from": "land_A_F1", "to": "land_A_GF", "width": 1.3, "length": 5.0, "kind": "stair", "capacity_group": "shaft_A"},
            {"from": "land_B_F1", "to": "land_B_GF", "width": 1.3, "length": 5.0, "kind": "stair", "capacity_group": "shaft_B"}
        ]
    }
    b = load(d)
    lb = lower_bound(b)
    plan = nearest_plan(b)
    sim_time = simulate(b, plan, frame_every=1e9)["total_time_s"]
    assert lb <= sim_time, f"LP lower bound {lb} exceeds actual simulation time {sim_time}"
