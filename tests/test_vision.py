"""Vision tests. No AWS calls: Bedrock is replaced by a fake client that returns a fixed reply."""
import json
from pathlib import Path

from nikaas.building import validate
from nikaas.vision import EXITS_PROMPT, _extract_json, connect, image_size, merge_exits, read_map, to_building

ROOT = Path(__file__).resolve().parents[1]
PHOTO = ROOT / "data/maps/iit_kgp_nmst_block_b.jpg"

# two rooms, a walkway, one exit; room B and the exit are not linked (models often leave gaps like this)
REPLY = {
    "rooms": [
        {"id": "a", "label": "Gallery A", "use": "gallery", "box": [100, 100, 300, 300]},
        {"id": "b", "label": "Hall B", "use": "seated_hall", "box": [300, 100, 500, 300]},
    ],
    "points": [{"id": "p1", "at": [200, 350]}, {"id": "p2", "at": [400, 350]}],
    "exits": [{"id": "OUT", "label": "Main door", "at": [500, 350]}],
    "links": [{"from": "a", "to": "p1", "width": 1.2, "kind": "door"},
              {"from": "p1", "to": "p2", "width": 2.5, "kind": "corridor"},
              {"from": "a", "to": "ghost", "width": 1.0}],
}


# exits-only pass: one exit we already have (same spot) and one new one at the west end
EXITS_REPLY = {"exits": [{"label": "Main door", "at": [505, 352]},
                         {"label": "West steps", "at": [100, 350], "kind": "stair", "width": 1.8}]}


class FakeBedrock:
    def __init__(self, reply, exits_reply='{"exits": []}'):
        self.reply, self.exits_reply, self.calls = reply, exits_reply, 0

    def converse(self, **kw):
        self.calls += 1
        content = kw["messages"][0]["content"]
        assert content[0]["image"]["source"]["bytes"]
        text = self.exits_reply if content[1]["text"] == EXITS_PROMPT else self.reply
        return {"output": {"message": {"content": [{"text": text}]}},
                "usage": {"inputTokens": 10, "outputTokens": 20}}


def test_image_size_reads_jpeg_header():
    assert image_size(PHOTO.read_bytes()) == (1920, 1277)


def test_extract_json_handles_fences_and_chatter():
    assert _extract_json('Here you go:\n```json\n{"a": 1}\n```\nDone.') == {"a": 1}
    assert _extract_json('sure {"a": {"b": 2}} hope that helps') == {"a": {"b": 2}}


def test_to_building_scales_drawing_to_width_and_keeps_aspect():
    b = to_building(REPLY, width_m=40, size=(1000, 500))
    xs = [n["x"] for n in b["nodes"]]
    a = next(n for n in b["nodes"] if n["id"] == "a")
    # drawing spans x 100..500 on the grid -> 40 m; room a is 200 grid units wide = 20 m
    assert a["w"] == 20.0 and min(xs) >= 0 and max(xs) <= 40
    assert a["d"] == 10.0  # photo is half as tall as wide, so 200 grid units down = 10 m
    hall = next(n for n in b["nodes"] if n["id"] == "b")
    assert hall["people"] == round(20 * 10 * 1.5)  # area x seated-hall density


def test_connect_links_everything_and_reports_what_it_added():
    b = to_building(REPLY, width_m=40)
    assert validate(b)  # as the model sent it: unknown node + rooms that cannot leave
    added = connect(b)
    assert validate(b) == [] and added
    assert all(e["to"] != "ghost" for e in b["edges"])


def test_read_map_end_to_end_with_fake_bedrock():
    fake = FakeBedrock("```json\n" + json.dumps(REPLY) + "\n```", json.dumps(EXITS_REPLY))
    b, probs = read_map(PHOTO.read_bytes(), "jpeg", width_m=81, client=fake)
    assert probs == [] and fake.calls == 2
    assert b["vision"]["auto_links"] and b["vision"]["photo_px"] == [1920, 1277]
    assert b["vision"]["exits_added"] == ["West steps"]
    assert sum(n["type"] == "exit" for n in b["nodes"]) == 2


def test_merge_exits_skips_duplicates_and_links_new_exit_to_nearest_point():
    g = json.loads(json.dumps(REPLY))
    assert merge_exits(g, EXITS_REPLY) == ["West steps"]
    new = g["exits"][-1]
    link = next(e for e in g["links"] if e["from"] == new["id"])
    assert link["to"] == "p1" and link["kind"] == "stair" and link["width"] == 1.8


def test_exits_pass_failure_keeps_main_result():
    fake = FakeBedrock(json.dumps(REPLY), "not json at all")
    b, probs = read_map(PHOTO.read_bytes(), "jpeg", client=fake)
    assert probs == [] and b["vision"]["exits_added"] == []


def test_read_map_reports_garbage_instead_of_crashing():
    b, probs = read_map(b"\xff\xd8not really a jpeg", "jpeg", client=FakeBedrock("I cannot read this image."))
    assert probs and b["nodes"] == []


# --- POST /vision (API) ---

def _api(monkeypatch, reply=None, exits='{"exits": []}'):
    import base64

    import boto3
    from fastapi.testclient import TestClient

    import nikaas.api as api
    import nikaas.vision as vision

    fake = FakeBedrock(json.dumps(reply or REPLY), exits)
    monkeypatch.setattr(vision, "_client", lambda region: fake)
    monkeypatch.delenv("PHOTO_BUCKET", raising=False)  # no S3 in tests
    monkeypatch.setattr(boto3, "client", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no AWS in tests")))
    return TestClient(api.app), base64.b64encode(PHOTO.read_bytes()).decode()


def test_vision_endpoint_returns_valid_building(monkeypatch):
    c, b64 = _api(monkeypatch)
    r = c.post("/vision", json={"image": "data:image/jpeg;base64," + b64, "width_m": 81, "name": "museum"})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["ok"] and out["problems"] == [] and out["id"] and out["photo_key"] is None
    assert out["building"]["name"] == "museum"
    assert c.post("/validate", json={"building": out["building"]}).json()["ok"]


def test_vision_endpoint_rejects_bad_input(monkeypatch):
    c, b64 = _api(monkeypatch)
    assert c.post("/vision", json={"image": "!!not base64!!"}).status_code == 400
    assert c.post("/vision", json={"image": "aGVsbG8="}).status_code == 415  # "hello"
    assert c.post("/vision", json={"image": b64, "width_m": 0}).status_code == 422


def test_vision_endpoint_reports_bedrock_failure_as_502(monkeypatch):
    import nikaas.vision as vision

    c, b64 = _api(monkeypatch)

    class Down:
        def converse(self, **kw):
            raise RuntimeError("AccessDeniedException")

    monkeypatch.setattr(vision, "_client", lambda region: Down())
    r = c.post("/vision", json={"image": b64})
    assert r.status_code == 502 and "AccessDenied" in r.text


def test_stair_landings_are_marked_and_photo_frame_is_reported():
    g = json.loads(json.dumps(REPLY))
    g["points"].append({"id": "st", "at": [300, 350], "stair": True, "label": "North stair"})
    g["links"].append({"from": "st", "to": "p1", "width": 2.0, "kind": "corridor"})
    b = to_building(g, width_m=40, size=(1000, 500))
    st = next(n for n in b["nodes"] if n["id"] == "st")
    assert st["type"] == "corridor" and st["stair"] is True and st["label"] == "North stair"
    assert not any(n.get("stair") for n in b["nodes"] if n["id"] != "st")
    # drawing spans grid x 100..500 (40 m, so 0.1 m per grid unit) and starts at grid y 100 (height ratio 0.5)
    assert b["photo_m"] == [-10.0, -5.0, 100.0, 50.0]


def test_read_map_lists_stairs_and_photo_frame():
    reply = json.loads(json.dumps(REPLY))
    reply["points"].append({"id": "stair_1", "at": [450, 350], "stair": "true"})
    fake = FakeBedrock(json.dumps(reply))
    b, probs = read_map(PHOTO.read_bytes(), "jpeg", width_m=81, client=fake)
    assert probs == [] and b["vision"]["stairs"] == ["stair_1"]
    assert "photo_m" not in b and len(b["vision"]["photo_m"]) == 4
    assert validate(b) == []
