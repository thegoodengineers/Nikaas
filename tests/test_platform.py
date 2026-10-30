"""Platform layer (docs/PLATFORM.md): check-in, alarms, personal routes, hazards, sensors, cameras, control room."""
import base64
import json
import os

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi.testclient import TestClient

from nikaas import api, live, push, sites, store

T1, T2, T3 = "phone-aaaa-0001", "phone-bbbb-0002", "phone-cccc-0003"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    store.reset_memory()
    sent = []
    monkeypatch.setattr(push, "send", lambda sub, msg, ttl=600: sent.append((sub["endpoint"], msg)) or 201)
    monkeypatch.setattr(live.detect, "confirm", lambda image: None)
    monkeypatch.setattr(api, "CONTROL_KEY", "")
    return sent


@pytest.fixture
def client():
    return TestClient(api.app)


SUB = {"endpoint": "https://push.example.test/abc", "keys": {"p256dh": "x", "auth": "y"}}


def test_sites_listed_with_demo_buildings(client):
    ids = {s["id"]: s for s in client.get("/sites").json()}
    assert ids["office"]["floors"] == 3 and ids["office"]["rooms"] == 10 and ids["office"]["exits"] == 2
    assert ids["museum"]["floors"] == 1
    site = client.get("/sites/office").json()
    assert site["building"]["floors"][0]["id"] == "GF" and len(site["assembly"]) == 2
    assert client.get("/sites/nope").status_code == 404


def test_checkin_gives_a_way_out_before_any_alarm(client):
    me = client.post("/sites/office/checkin", json={"token": T1, "room": "r_F2_1"}).json()
    assert me["person"]["room_label"] == "Room 2.1" and me["person"]["floor"] == "F2"
    r = me["route"]
    assert r["exit"] == "exit_north" and r["path"][0] == "r_F2_1" and r["path"][-1] == "exit_north"
    kinds = [s["kind"] for s in r["steps"]]
    assert kinds[0] == "start" and "stairs" in kinds and kinds[-2] == "exit" and kinds[-1] == "outside"
    stairs = next(s for s in r["steps"] if s["kind"] == "stairs")
    assert "down 2 floors to Ground Floor" in stairs["text"] and "North stair" in stairs["text"]
    assert me["alarm"] is None and len(me["map"]["nodes"]) == 21
    # entrance scan without a room: checked in, no route yet
    me2 = client.post("/sites/office/checkin", json={"token": T2, "gate": "exit_south"}).json()
    assert me2["person"]["gate"] == "exit_south" and me2["route"] is None
    assert client.post("/sites/office/checkin", json={"token": "bad", "room": "r_F2_1"}).status_code == 422
    assert client.post("/sites/office/checkin", json={"token": T3, "room": "nope"}).status_code == 422


def test_alarm_routes_everyone_and_pushes(client, fresh):
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_F2_1"})
    client.post("/sites/office/push", json={"token": T1, "subscription": SUB})
    client.post("/sites/office/checkin", json={"token": T2, "room": "r_F2_4"})
    c = client.post("/sites/office/alarm", json={"type": "fire", "origin": "r_F1_2"}).json()
    assert c["alarm"]["type"] == "fire" and c["counts"]["checked_in"] == 2 and c["counts"]["missing"] == 2
    groups = {x["id"]: x["group"] for x in c["exits"]}
    assert set(groups.values()) == {"A", "B"}  # both exits in use: the crowd is split
    assert len(fresh) == 1 and fresh[0][1]["alarm"] and "Leave now by" in fresh[0][1]["body"]
    me = client.get("/sites/office/me", params={"token": T1}).json()
    assert me["route"]["group"] in ("A", "B") and me["route"]["changed"] is False and me["alarm"]["version"] >= 1


def test_hazard_on_stair_reroutes_and_flags_change(client, fresh):
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_F2_1"})
    client.post("/sites/office/push", json={"token": T1, "subscription": SUB})
    client.post("/sites/office/alarm", json={"type": "fire"})
    first = client.get("/sites/office/me", params={"token": T1}).json()["route"]
    assert first["exit"] == "exit_north"
    fresh.clear()
    # fire in the north stairwell on the first floor: room 2.1 must go round by the south stair
    c = client.post("/sites/office/hazards", json={"kind": "fire", "node": "stair_north_F1"}).json()
    assert c["hazards"][0]["label"] == "North stair, First Floor" and c["hazards"][0]["node"] == "stair_north_F1"
    me = client.get("/sites/office/me", params={"token": T1}).json()
    assert me["route"]["exit"] == "exit_south" and me["route"]["changed"] is True
    assert "stair_north_F1" not in me["route"]["path"]
    assert any(m["title"] == "Your route has changed" for _, m in fresh)
    again = client.get("/sites/office/me", params={"token": T1}).json()
    assert again["route"]["changed"] is False  # told once
    hid = c["hazard"]
    assert client.delete(f"/sites/office/hazards/{hid}").json()["hazards"] == []


def test_cut_off_room_gets_a_refuge_and_help_with_stairs(client):
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_F2_3"})
    client.post("/sites/office/alarm", json={"type": "fire"})
    # Room 2.3's only door leads to the south landing: a fire there cuts it off
    south = client.post("/sites/office/hazards", json={"kind": "fire", "node": "stair_south_F2"}).json()["hazard"]
    me = client.get("/sites/office/me", params={"token": T1}).json()
    assert me["route"]["mode"] in ("refuge", "stay")
    c = client.get("/sites/office/control").json()
    assert "r_F2_3" in c["alarm"]["trapped"] and c["rooms"]["r_F2_3"]["trapped"]
    # someone on floor 2 who cannot use stairs is sent to a stair landing to wait
    client.post("/sites/office/checkin", json={"token": T2, "room": "r_F2_2"})
    me = client.post("/sites/office/status", json={"token": T2, "status": "help", "need": "stairs"}).json()
    assert me["route"]["mode"] == "refuge" and me["route"]["path"][-1] == "stair_north_F2"
    # with smoke in the north shaft (one floor down) and the south landing clear again, the refuge moves south
    client.delete(f"/sites/office/hazards/{south}")
    client.post("/sites/office/hazards", json={"kind": "smoke", "node": "stair_north_F1"})
    me = client.get("/sites/office/me", params={"token": T2}).json()
    assert me["route"]["mode"] == "refuge" and me["route"]["path"][-1] != "stair_north_F2"
    c = client.get("/sites/office/control").json()
    assert c["counts"]["help"] == 1 and c["help"][0]["need"] == "stairs"


def test_safe_is_checked_against_the_assembly_point(client):
    client.post("/sites/office/geo", json={"geo": {"lat": 19.0, "lng": 72.0}})
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_GF_1"})
    client.post("/sites/office/alarm", json={"type": "drill"})
    a = client.get("/sites/office/me", params={"token": T1}).json()["route"]["assembly"]
    assert a["lat"] is not None
    near = client.post("/sites/office/status", json={"token": T1, "status": "safe", "lat": a["lat"] + 0.0002, "lng": a["lng"], "accuracy": 15}).json()
    assert near["person"]["safe_verified"] is True
    far = client.post("/sites/office/status", json={"token": T1, "status": "safe", "lat": a["lat"] + 0.01, "lng": a["lng"], "accuracy": 15}).json()
    assert far["person"]["safe_verified"] is False and far["person"]["safe_distance_m"] > 1000
    assert client.get("/sites/office/control").json()["counts"]["safe"] == 1


def test_sensor_over_the_heat_rating_raises_hazard_and_alarm(client):
    r = client.post("/sites/office/sensors", json={"sensor_id": "t1", "node": "corr_F1_mid", "temp_c": 31}).json()
    assert r["hazard"] is None and r["alarm"] is None
    r = client.post("/sites/office/sensors", json={"sensor_id": "t1", "node": "corr_F1_mid", "temp_c": 64}).json()
    assert r["hazard"] and r["alarm"]["type"] == "fire" and r["alarm"]["origin"] == "corr_F1_mid"
    assert r["sensors"][0]["temp_c"] == 64


def test_camera_needs_confirmation_or_a_strong_score(client, monkeypatch):
    r = client.post("/sites/office/cameras", json={"camera_id": "c1", "node": "r_F1_1", "people": 4, "fire": 0.7}).json()
    assert r["hazard"] is None  # 0.7 without a second opinion is not enough
    monkeypatch.setattr(live.detect, "confirm", lambda image: {"fire": 0.93, "smoke": 0.4, "people": 2})
    r = client.post("/sites/office/cameras", json={"camera_id": "c1", "node": "r_F1_1", "people": 4, "fire": 0.7, "image": "aGVsbG8="}).json()
    assert r["confirmed"] is True and r["hazard"] and r["alarm"]["type"] == "fire"
    assert r["rooms"]["r_F1_1"]["camera"] == 4 and r["rooms"]["r_F1_1"]["density"] == round(4 / 30, 2)


def test_crowding_levels_from_camera_counts(client):
    r = client.post("/sites/office/cameras", json={"camera_id": "c2", "node": "r_GF_1", "people": 125}).json()
    assert r["rooms"]["r_GF_1"]["density"] == round(125 / 30, 2) and r["rooms"]["r_GF_1"]["level"] == "crush"
    r = client.post("/sites/office/cameras", json={"camera_id": "c3", "node": "corr_GF_mid", "people": 90}).json()
    spot = r["spots"][0]
    assert spot["node"] == "corr_GF_mid" and spot["level"] == "concern"


def test_phased_release_starts_with_the_incident_floor(client):
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_GF_1"})
    c = client.post("/sites/office/alarm", json={"type": "fire", "origin": "r_F1_1", "phased": True, "wave_gap_s": 45}).json()
    waves = {w["wave"]: w["floors"] for w in c["waves"]}
    assert waves[0] == ["F1", "F2"] and waves[1] == ["GF"]
    me = client.get("/sites/office/me", params={"token": T1}).json()
    assert me["route"]["wave"] == 1 and me["route"]["release_at"] == 45


def test_divert_moves_a_room_when_one_exit_queues(client, monkeypatch):
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_F2_1"})
    client.post("/sites/office/alarm", json={"type": "fire"})
    a = live.alarm("office")
    a["started_at"] -= 60
    a["replanned_at"] -= 60
    for rm in a["plan"]["rooms"].values():  # pretend the plan sent everyone north
        rm["exit"] = "exit_north"
    a["plan"]["occupancy"] = {k: 120 for k in a["plan"]["occupancy"]}
    store.store().put(live.pk("office"), "ALARM", a)
    c = client.get("/sites/office/control").json()
    assert any("diverted" in e["text"] for e in c["events"])
    assert any(x["id"] == "exit_south" and x["rooms"] for x in c["exits"])


def test_link_floors_joins_landings_above_each_other(client):
    b = json.loads(json.dumps(sites.get_site("office")["building"]))
    b["edges"] = [e for e in b["edges"] if e.get("kind") != "stair"]
    for n in b["nodes"]:
        if n["id"] == "stair_north_F2":
            n["x"] += 1.5  # photos never line up exactly
    out = client.post("/plans/link-floors", json={"building": b}).json()
    assert len(out["links"]) == 4 and out["problems"] == []
    groups = {l["group"] for l in out["links"]}
    assert len(groups) == 2  # one shaft per stair, shared by both flights


def test_saved_site_and_geo(client):
    b = sites.get_site("museum")["building"]
    s = client.post("/sites", json={"name": "Test Hall", "building": b}).json()
    assert s["id"] == "test-hall" and len(s["assembly"]) == 3
    assert any(x["id"] == "test-hall" for x in client.get("/sites").json())
    g = client.post("/sites/test-hall/geo", json={"geo": {"lat": 22.3, "lng": 87.3}}).json()
    assert g["assembly"][0]["lat"] is not None
    assert client.post("/sites", json={"name": "Broken", "building": {"nodes": [], "edges": []}}).status_code == 422


def test_control_key(client, monkeypatch):
    monkeypatch.setattr(api, "CONTROL_KEY", "k3y")
    assert client.get("/sites/office/control").status_code == 401
    assert client.get("/sites/office/control", headers={"x-control-key": "k3y"}).status_code == 200
    assert client.post("/sites/office/alarm", json={"type": "fire"}).status_code == 401
    # phones do not need the key
    assert client.post("/sites/office/checkin", json={"token": T1, "room": "r_GF_1"}).status_code == 200


def test_all_clear_and_checkout(client, fresh):
    client.post("/sites/office/checkin", json={"token": T1, "room": "r_GF_1"})
    client.post("/sites/office/push", json={"token": T1, "subscription": SUB})
    client.post("/sites/office/alarm", json={"type": "fire"})
    fresh.clear()
    c = client.delete("/sites/office/alarm").json()
    assert c["alarm"] is None and fresh and fresh[0][1]["title"].startswith("All clear")
    client.post("/sites/office/checkout", json={"token": T1})
    assert client.get("/sites/office/me", params={"token": T1}).status_code == 404


def _decrypt(body: bytes, ua_key, auth: bytes) -> bytes:
    """What a browser does with a push message (RFC 8291), to check our encryption end to end."""
    salt, rs, idlen = body[:16], body[16:20], body[20]
    as_public = body[21:21 + idlen]
    ct = body[21 + idlen:]
    shared = ua_key.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_public))
    ua_public = ua_key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    prk_key = push._hkdf_extract(auth, shared)
    ikm = push._hkdf_expand(prk_key, b"WebPush: info\x00" + ua_public + as_public, 32)
    prk = push._hkdf_extract(salt, ikm)
    cek = push._hkdf_expand(prk, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = push._hkdf_expand(prk, b"Content-Encoding: nonce\x00", 12)
    plain = AESGCM(cek).decrypt(nonce, ct, None)
    assert int.from_bytes(rs, "big") == 4096
    return plain.rstrip(b"\x00")[:-1]


def test_push_message_decrypts_like_a_browser_would():
    ua = ec.generate_private_key(ec.SECP256R1())
    ua_pub = push.b64u(ua.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    auth = os.urandom(16)
    body = push.encrypt(b'{"title":"FIRE"}', ua_pub, push.b64u(auth))
    assert _decrypt(body, ua, auth) == b'{"title":"FIRE"}'
    hdr = push.vapid_header("https://fcm.googleapis.com/fcm/send/abc")
    assert hdr.startswith("vapid t=") and ", k=" in hdr
    jwt = hdr.split("t=")[1].split(",")[0]
    claims = json.loads(base64.urlsafe_b64decode(jwt.split(".")[1] + "=="))
    assert claims["aud"] == "https://fcm.googleapis.com"
