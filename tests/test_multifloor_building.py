"""Tests for multi-floor building graph loading and validation."""
import copy
import json
import math
from pathlib import Path

import pytest
from nikaas.building import Building, load, shortest_path, validate

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def base_multifloor_dict():
    return json.loads((ROOT / "data/multi_floor_office.json").read_text(encoding="utf-8"))


def test_legacy_single_floor_loads_unchanged():
    b = load(ROOT / "data/sample_floor.json")
    assert isinstance(b, Building)
    assert len(b.floors) == 0
    assert b.floor_of("lab1") is None
    assert b.elevation_of("lab1") == 0.0
    probs = validate(ROOT / "data/sample_floor.json")
    assert probs == []


def test_multifloor_metadata_loads_correctly(base_multifloor_dict):
    b = load(base_multifloor_dict)
    assert len(b.floors) == 3
    assert set(b.floors.keys()) == {"GF", "F1", "F2"}
    assert b.floors["F1"]["elevation_m"] == 3.5
    assert b.floor_of("r_F2_1") == "F2"
    assert b.elevation_of("r_F2_1") == 7.0
    assert b.elevation_of("exit_north") == 0.0
    probs = validate(base_multifloor_dict)
    assert probs == []


def test_unknown_floor_reference_is_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    d["nodes"][0]["floor_id"] = "F99"
    probs = validate(d)
    assert any("unknown floor_id 'F99'" in p for p in probs)


def test_duplicate_floor_id_is_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    d["floors"].append({"id": "F1", "name": "Duplicate First Floor", "elevation_m": 3.5})
    probs = validate(d)
    assert any("duplicate floor ids" in p for p in probs)


def test_missing_or_non_finite_elevation_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    d["floors"][1]["elevation_m"] = "three-point-five"
    probs = validate(d)
    assert any("elevation_m must be a finite number" in p for p in probs)

    d["floors"][1]["elevation_m"] = float("inf")
    probs2 = validate(d)
    assert any("elevation_m must be a finite number" in p for p in probs2)


def test_cross_floor_corridor_edge_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    # Change vertical stair edge to corridor
    for e in d["edges"]:
        if e.get("kind") == "stair":
            e["kind"] = "corridor"
            break
    probs = validate(d)
    assert any("must have kind 'stair'" in p for p in probs)


def test_cross_floor_door_edge_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    for e in d["edges"]:
        if e.get("kind") == "stair":
            e["kind"] = "door"
            break
    probs = validate(d)
    assert any("must have kind 'stair'" in p for p in probs)


def test_cross_floor_stair_without_explicit_length_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    for e in d["edges"]:
        if e.get("kind") == "stair":
            del e["length"]
            break
    probs = validate(d)
    assert any("must specify explicit positive 'length'" in p for p in probs)


def test_zero_or_negative_stair_length_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    for e in d["edges"]:
        if e.get("kind") == "stair":
            e["length"] = -5.0
            break
    probs = validate(d)
    assert any("length must be > 0 m" in p for p in probs)


def test_invalid_capacity_group_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    for e in d["edges"]:
        if e.get("kind") == "stair":
            e["capacity_group"] = ""  # empty string
            break
    probs = validate(d)
    assert any("capacity_group must be a non-empty string" in p for p in probs)


def test_shortest_path_uses_explicit_stair_length(base_multifloor_dict):
    b = load(base_multifloor_dict)
    # Travel from F2 landing to GF landing via north stair:
    # 2 flights of length 6.5 each = 13.0 m
    dist, path = shortest_path(b, "stair_north_F2", "stair_north_GF")
    assert path == ["stair_north_F2", "stair_north_F1", "stair_north_GF"]
    assert pytest.approx(dist, 0.01) == 13.0


def test_unreachable_floor_when_stairs_severed(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    # Remove all stairs connecting upper floors to ground
    d["edges"] = [e for e in d["edges"] if e.get("kind") != "stair"]
    probs = validate(d)
    assert any("room r_F2_1 cannot reach any exit" in p for p in probs)


def test_corridor_with_capacity_group_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    for e in d["edges"]:
        if e.get("kind") == "corridor":
            e["capacity_group"] = "invalid_group"
            break
    probs = validate(d)
    assert any("only stair edges may belong to a capacity_group" in p for p in probs)


def test_disconnected_capacity_group_rejected(base_multifloor_dict):
    d = copy.deepcopy(base_multifloor_dict)
    # Create two disconnected stair flights with the same capacity group
    # One flight in north stair with shaft_discon, another flight in south stair with shaft_discon
    for e in d["edges"]:
        if e.get("from") == "stair_north_F2" and e.get("to") == "stair_north_F1":
            e["capacity_group"] = "shaft_discon"
        elif e.get("from") == "stair_south_F1" and e.get("to") == "stair_south_GF":
            e["capacity_group"] = "shaft_discon"
    probs = validate(d)
    assert any("edges are disconnected" in p for p in probs)
