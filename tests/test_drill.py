"""Live drill: a blocked exit re-routes every phone whose room used it, and flags them."""
import json
from pathlib import Path

from fastapi.testclient import TestClient

from nikaas.api import app

ROOT = Path(__file__).resolve().parents[1]
B = json.loads((ROOT / "data/iit_kgp_museum.json").read_text(encoding="utf-8"))


def test_drill_reroutes_rooms_when_their_exit_is_blocked():
    c = TestClient(app)
    s1 = c.post("/drill", json={"building": B}).json()
    used_main = [r for r, x in s1["rooms"].items() if x["exit"] == "MAIN"]
    assert used_main and all(x["distance_m"] > 0 and x["walk_s"] > 0 for x in s1["rooms"].values())
    s2 = c.post("/drill", json={"building": B, "blocked": ["MAIN"]}).json()
    assert s2["version"] == s1["version"] + 1
    assert all(x["exit"] != "MAIN" for x in s2["rooms"].values())
    assert "MAIN" in s2["exit_labels"] and "MAIN" in s2["blocked"]  # the sign by MAIN turns red
    assert s2["instead"]["MAIN"] in s2["exit_labels"] and s2["instead"]["MAIN"] != "MAIN"  # and points elsewhere
    assert set(used_main) <= set(s2["changed"])  # every room that lost its exit gets an alert
    phone = c.get("/drill", params={"room": used_main[0], "since": s1["version"]}).json()
    assert phone["alert"] and phone["updated"] and phone["exit"] != "MAIN" and phone["blocked_labels"]
    assert phone["blocked"] == ["MAIN"]  # the phone map marks the fire


def test_reset_starts_a_clean_drill():
    c = TestClient(app)
    c.post("/drill", json={"building": B})
    c.post("/drill", json={"building": B, "blocked": ["MAIN"]})
    s = c.post("/drill", json={"building": B, "reset": True}).json()
    assert s["version"] == 1 and s["blocked"] == [] and s["changed"] == []  # no stale alerts on the phones


def test_unknown_room_is_a_clear_404():
    c = TestClient(app)
    c.post("/drill", json={"building": B})
    r = c.get("/drill", params={"room": "nope"})
    assert r.status_code == 404 and "unknown room" in r.text


def test_camera_count_replans_the_drill_and_survives_a_fire():
    """Nikaas Live: a camera's count replaces the floor-plan number for its room and the plan follows it."""
    c = TestClient(app)
    s1 = c.post("/drill", json={"building": B}).json()
    assert "building" not in s1 and s1["live"] == {} and s1["people"]["study"] == 15
    s2 = c.post("/occupancy", json={"room": "study", "count": 3}).json()
    assert s2["replanned"] and s2["version"] == s1["version"] + 1
    assert s2["people"]["study"] == 3 and s2["live"]["study"]["count"] == 3 and s2["live"]["study"]["design"] == 15
    assert s2["total_time_s"] != s1["total_time_s"] or s2["rooms"] != s1["rooms"]
    # same number again: no re-plan, no new version (the camera sends often)
    s3 = c.post("/occupancy", json={"room": "study", "count": 3}).json()
    assert not s3["replanned"] and s3["version"] == s2["version"]
    # the presenter sets a fire: the camera count is kept
    s4 = c.post("/drill", json={"building": B, "blocked": ["MAIN"]}).json()
    assert s4["people"]["study"] == 3 and "study" in s4["live"]
    phone = c.get("/drill", params={"room": "study"}).json()
    assert phone["people"] == 3 and phone["live"]["count"] == 3
    # camera off: back to the floor-plan number
    s5 = c.post("/occupancy", json={"room": "study", "count": None}).json()
    assert s5["replanned"] and s5["people"]["study"] == 15 and s5["live"] == {}


def test_occupancy_rejects_bad_rooms_and_counts():
    c = TestClient(app)
    c.post("/drill", json={"building": B})
    assert c.post("/occupancy", json={"room": "nope", "count": 3}).status_code == 404
    assert c.post("/occupancy", json={"room": "MAIN", "count": 3}).status_code == 404  # an exit, not a room
    assert c.post("/occupancy", json={"room": "study", "count": -1}).status_code == 422


def test_occupancy_without_a_drill_is_a_clear_404(monkeypatch):
    from nikaas import drill

    monkeypatch.setattr(drill, "_memory", {})
    r = TestClient(app).post("/occupancy", json={"room": "study", "count": 3})
    assert r.status_code == 404 and "no drill running" in r.text
