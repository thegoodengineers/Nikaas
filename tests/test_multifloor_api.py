"""Tests for multi-floor API endpoints (/validate, /qa, /simulate, /optimise)."""
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from nikaas.api import app

client = TestClient(app)
ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def office_dict():
    return json.loads((ROOT / "data/multi_floor_office.json").read_text(encoding="utf-8"))


@pytest.fixture
def sample_floor_dict():
    return json.loads((ROOT / "data/sample_floor.json").read_text(encoding="utf-8"))


def test_api_single_floor_backward_compatibility(sample_floor_dict):
    # Validate
    v = client.post("/validate", json={"building": sample_floor_dict})
    assert v.status_code == 200
    assert v.json()["ok"] is True

    # QA
    q = client.post("/qa", json={"building": sample_floor_dict})
    assert q.status_code == 200
    assert q.json()["score"] == 100.0

    # Simulate
    s = client.post("/simulate", json={"building": sample_floor_dict})
    assert s.status_code == 200
    s_data = s.json()
    assert s_data["completed"] is True
    assert "frames" in s_data
    assert "people_3d" not in s_data["frames"][0]  # legacy format preserved

    # Optimise
    o = client.post("/optimise", json={"building": sample_floor_dict})
    assert o.status_code == 200
    assert "plan" in o.json()


def test_api_multifloor_endpoints(office_dict):
    # Validate
    v = client.post("/validate", json={"building": office_dict})
    assert v.status_code == 200
    assert v.json()["ok"] is True

    # QA
    q = client.post("/qa", json={"building": office_dict})
    assert q.status_code == 200
    assert q.json()["score"] == 100.0
    assert q.json()["checks"]["multi_floor"]["status"] == "pass"

    # Simulate
    s = client.post("/simulate", json={"building": office_dict, "frame_every": 2.0})
    assert s.status_code == 200
    s_data = s.json()
    assert s_data["completed"] is True
    assert "per_floor" in s_data
    assert "stairwell_load" in s_data
    assert "vertical_movement" in s_data
    assert "people_3d" in s_data["frames"][0]
    assert s_data["vertical_movement"]["people_using_stairs"] > 0

    # Optimise
    o = client.post("/optimise", json={"building": office_dict, "simulate": True})
    assert o.status_code == 200
    o_data = o.json()
    assert "plan" in o_data
    assert "run" in o_data
    assert o_data["run"]["completed"] is True


def test_api_invalid_floor_returns_422(office_dict):
    d = copy.deepcopy(office_dict)
    d["nodes"][0]["floor_id"] = "NONEXISTENT_FLOOR"
    r = client.post("/simulate", json={"building": d})
    assert r.status_code == 422
    assert "unknown floor_id" in str(r.json())


def test_api_blocked_exit_multifloor(office_dict):
    s = client.post("/simulate", json={"building": office_dict, "blocked": ["exit_north"]})
    assert s.status_code == 200
    s_data = s.json()
    assert s_data["per_exit"]["exit_north"] == 0
    assert s_data["per_exit"]["exit_south"] == 400
