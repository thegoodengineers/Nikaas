"""Phone-number registration and emergency texts (nikaas/sms.py, live.register / verify_phone, GET /r/{code})."""
import re

import pytest
from fastapi.testclient import TestClient

from nikaas import api, live, push, sms, store

T1, T2 = "phone-sms-0001-aaaa", "phone-sms-0002-bbbb"


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    store.reset_memory()
    sms.OUTBOX.clear()
    monkeypatch.setenv("NIKAAS_SMS", "log")
    monkeypatch.setattr(push, "send", lambda sub, msg, ttl=600: 201)
    monkeypatch.setattr(api, "CONTROL_KEY", "")
    monkeypatch.setattr(api, "SITE_URL", "https://example.test/index.html")


@pytest.fixture
def client():
    return TestClient(api.app)


def register(client, token, phone):
    r = client.post("/sites/office/register", json={"token": token, "phone": phone})
    assert r.status_code == 200, r.text
    code = sms.last_code(sms.normalize(phone))
    return r.json(), code


@pytest.mark.parametrize("raw,e164", [("98765 43210", "+919876543210"), ("098765-43210", "+919876543210"), ("+91 98765 43210", "+919876543210"),
                                      ("0091 9876543210", "+919876543210"), ("+44 7700 900123", "+447700900123")])
def test_numbers_people_type_become_e164(raw, e164):
    assert sms.normalize(raw) == e164


@pytest.mark.parametrize("raw", ["12345", "5876543210", "+91 12345 67890", "phone"])
def test_bad_numbers_are_refused(raw):
    with pytest.raises(sms.SmsError):
        sms.normalize(raw)


def test_register_verify_then_alarm_texts_a_personal_link(client):
    me, code = register(client, T1, "98765 43210")
    assert me["verify"] == "code" and me["person"]["verify_pending"] and code
    assert "9876543210" not in str(me)  # the number never comes back in full
    wrong = client.post("/sites/office/verify", json={"token": T1, "code": "000000" if code != "000000" else "111111"})
    assert wrong.status_code == 422
    ok = client.post("/sites/office/verify", json={"token": T1, "code": code}).json()
    assert ok["person"]["phone_verified"] and ok["person"]["phone"].startswith("+91 98")
    sms.OUTBOX.clear()
    client.post("/sites/office/alarm", json={"type": "fire"})
    assert len(sms.OUTBOX) == 1
    text = sms.OUTBOX[0]["text"]
    assert text.startswith("FIRE ALARM at Block C") and len(text) <= 160 and text.isascii()
    link = re.search(r"(https?://\S+/r/([a-z0-9]+))", text)
    assert link, text
    r = client.get(f"/r/{link.group(2)}", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == f"https://example.test/index.html#/go?site=office&p={T1}"
    assert client.get("/r/nope123", follow_redirects=False).headers["location"].endswith("#/go")
    # opening the link and choosing a room gives this person's route
    me = client.post("/sites/office/checkin", json={"token": T1, "room": "r_F2_1"}).json()
    assert me["route"]["exit"] and me["route"]["steps"]
    c = client.get("/sites/office/control").json()
    assert c["sms"]["verified"] == 1 and c["sms"]["last"]["sent"] == 1 and c["people"][0]["phone_verified"]
    sms.OUTBOX.clear()
    client.delete("/sites/office/alarm")
    assert sms.OUTBOX and sms.OUTBOX[0]["text"].startswith("ALL CLEAR")


def test_only_verified_phones_get_texts_and_one_number_one_registration(client):
    _, code = register(client, T1, "9876543210")
    client.post("/sites/office/verify", json={"token": T1, "code": code})
    register(client, T2, "9123456789")  # never verified
    sms.OUTBOX.clear()
    client.post("/sites/office/alarm", json={"type": "drill"})
    assert [m["to"] for m in sms.OUTBOX] == ["+919876543210"]
    # the same number registered from a new device replaces the old registration
    client.delete("/sites/office/alarm")
    _, code = register(client, T2, "+91 98765 43210")
    client.post("/sites/office/verify", json={"token": T2, "code": code})
    phones = [p["phone"] for p in client.get("/sites/office/control").json()["people"]]
    assert phones.count("+91 98•••••210") == 1


def test_code_limits(client):
    _, code = register(client, T1, "9876543210")
    r = client.post("/sites/office/register", json={"token": T1, "phone": "9876543210"})
    assert r.status_code == 422 and "30 seconds" in r.json()["detail"]
    for _ in range(5):
        client.post("/sites/office/verify", json={"token": T1, "code": "999999" if code != "999999" else "888888"})
    r = client.post("/sites/office/verify", json={"token": T1, "code": code})
    assert r.status_code == 422 and "Too many" in r.json()["detail"]


def test_sns_sandbox_uses_amazons_own_code(client, monkeypatch):
    calls = []

    class FakeSns:
        def get_sms_sandbox_account_status(self):
            return {"IsInSandbox": True}

        def list_sms_sandbox_phone_numbers(self, **kw):
            return {"PhoneNumbers": [{"PhoneNumber": "+919000000001", "Status": "Verified"}]}

        def create_sms_sandbox_phone_number(self, PhoneNumber, LanguageCode):
            calls.append(("create", PhoneNumber))

        def verify_sms_sandbox_phone_number(self, PhoneNumber, OneTimePassword):
            calls.append(("verify", PhoneNumber, OneTimePassword))
            if OneTimePassword != "424242":
                raise RuntimeError("VerificationException")

        def publish(self, PhoneNumber, Message, MessageAttributes):
            calls.append(("publish", PhoneNumber, Message))
            return {"MessageId": "m1"}

    monkeypatch.setenv("NIKAAS_SMS", "sns")
    monkeypatch.setattr(sms, "_sns", lambda: FakeSns())
    monkeypatch.setattr(sms, "_sandbox_cache", (0.0, None))
    me = client.post("/sites/office/register", json={"token": T1, "phone": "9876543210"}).json()
    assert me["verify"] == "sandbox" and ("create", "+919876543210") in calls
    assert client.post("/sites/office/verify", json={"token": T1, "code": "111111"}).status_code == 422
    assert client.post("/sites/office/verify", json={"token": T1, "code": "424242"}).json()["person"]["phone_verified"]
    # a number Amazon already verified needs no code
    me = client.post("/sites/office/register", json={"token": T2, "phone": "+91 90000 00001"}).json()
    assert me["verify"] == "none" and me["person"]["phone_verified"]
    client.post("/sites/office/alarm", json={"type": "fire"})
    assert sorted(c[1] for c in calls if c[0] == "publish") == ["+919000000001", "+919876543210"]
    c = client.get("/sites/office/control").json()
    assert c["sms"]["sandbox"] is True and c["sms"]["sandbox_limit"] == 10


def test_test_sms_from_the_control_room(client):
    _, code = register(client, T1, "9876543210")
    client.post("/sites/office/verify", json={"token": T1, "code": code})
    short = client.get("/sites/office/control").json()["people"][0]["token"]
    sms.OUTBOX.clear()
    r = client.post("/sites/office/sms/test", json={"person": short}).json()
    assert r == {"sent": 1, "failed": 0} and sms.OUTBOX[0]["text"].startswith("Test from Block C")


class FakeGate:
    """Stands in for api.sms-gate.app: records each request."""
    def __init__(self):
        self.sent = []

    def __call__(self, req, timeout=10):
        import base64 as b64
        import io
        import json as js
        assert req.full_url == "https://api.sms-gate.app/3rdparty/v1/messages"
        assert req.get_header("Authorization") == "Basic " + b64.b64encode(b"user1:pass1").decode()
        body = js.loads(req.data)
        self.sent.append((body["phoneNumbers"][0], body["textMessage"]["text"]))
        r = io.BytesIO(js.dumps({"id": f"g{len(self.sent)}", "state": "Pending"}).encode())
        r.__enter__ = lambda *a: r
        r.__exit__ = lambda *a: None
        return r


def test_android_gateway_sends_codes_and_alarm_texts(client, monkeypatch):
    gate = FakeGate()
    monkeypatch.setenv("NIKAAS_SMS", "sns")
    monkeypatch.setenv("NIKAAS_SMSGATE", "user1:pass1")
    monkeypatch.setattr(sms.urllib.request, "urlopen", gate)
    assert sms.provider() == "smsgate"
    r = client.post("/sites/office/register", json={"token": T1, "phone": "98765 43210"})
    assert r.status_code == 200 and r.json()["verify"] == "code"
    to, text = gate.sent[-1]
    code = re.search(r"\d{6}", text).group()
    assert to == "+919876543210"
    assert client.post("/sites/office/verify", json={"token": T1, "code": code}).status_code == 200
    assert client.post("/sites/office/alarm", json={"kind": "fire"}).status_code == 200
    assert "FIRE ALARM" in gate.sent[-1][1] and "/r/" in gate.sent[-1][1]


def test_when_texts_cannot_be_sent_people_are_told_to_continue_without_a_number(client, monkeypatch):
    monkeypatch.setenv("NIKAAS_SMS", "twilio")  # no credentials: every send fails
    r = client.post("/sites/office/register", json={"token": T1, "phone": "98765 43210"})
    assert r.status_code in (400, 422) and r.json()["detail"].startswith("Text messages cannot be sent")


def test_phone_can_send_itself_a_test_notification(client, monkeypatch):
    got = []
    monkeypatch.setattr(push, "send", lambda sub, msg, ttl=600: got.append(msg) or 201)
    assert client.post("/sites/office/checkin", json={"token": T1, "room": None}).status_code == 200
    r = client.post("/sites/office/push/test", json={"token": T1})
    assert r.status_code in (400, 422) and "not turned on" in r.json()["detail"]
    sub = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "x", "auth": "y"}}
    assert client.post("/sites/office/push", json={"token": T1, "subscription": sub}).status_code == 200
    assert client.post("/sites/office/push/test", json={"token": T1}).json() == {"ok": True}
    assert got[-1]["title"].startswith("Test alert")
    assert client.post("/sites/office/push/test", json={"token": T1}).status_code in (400, 422)  # once every 10 s
    assert client.get("/sites/office/control").json()["push"] == {"on": 1, "total": 1}
    client.post("/sites/office/alarm", json={"type": "fire"})
    assert got[-1]["alarm"] is True and "FIRE" in got[-1]["title"]


def test_alarm_notification_always_names_an_exit(client, monkeypatch):
    got = {}
    monkeypatch.setattr(push, "send", lambda sub, msg, ttl=600: got.__setitem__(sub["endpoint"], msg) or 201)
    sub = lambda n: {"endpoint": f"https://push.example/{n}", "keys": {"p256dh": "x", "auth": "y"}}
    room = next(n["id"] for n in client.get("/sites/office").json()["building"]["nodes"] if n["type"] == "room")
    client.post("/sites/office/checkin", json={"token": T1, "room": room})
    client.post("/sites/office/checkin", json={"token": T2, "room": None})
    client.post("/sites/office/push", json={"token": T1, "subscription": sub(1)})
    client.post("/sites/office/push", json={"token": T2, "subscription": sub(2)})
    ex = next(n for n in client.get("/sites/office").json()["building"]["nodes"] if n["type"] == "exit")
    client.post("/sites/office/hazards", json={"kind": "fire", "node": ex["id"]})
    client.post("/sites/office/alarm", json={"type": "fire"})
    with_room, without = got["https://push.example/1"]["body"], got["https://push.example/2"]["body"]
    assert with_room.startswith("Leave now by ") and " m." in with_room
    assert "nearest open exit" in without and "choose your room" in without
    label = ex.get("label", ex["id"])
    assert f"Do not use {label}" in without
    assert client.get(f"/sites/office/me?token={T2}").json()["blocked_exits"] == [ex["id"]]
