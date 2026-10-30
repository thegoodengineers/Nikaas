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


def test_unknown_room_is_a_clear_404():
    c = TestClient(app)
    c.post("/drill", json={"building": B})
    r = c.get("/drill", params={"room": "nope"})
    assert r.status_code == 404 and "unknown room" in r.text
