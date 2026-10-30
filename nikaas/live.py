"""The live safety layer (docs/PLATFORM.md): people check in to a site with their phone, the control room raises
an alarm, everyone gets a personal route out, hazards and sensors re-plan routes, and the control room sees who is
inside, safe, missing or asking for help.

Routing reuses the validated model: `door_paths` / `shortest_path` for routes and `simulate` to compare plans.
Re-plans must be quick (a hazard can arrive any second), so the planner tries a few good plans and keeps the one the
simulator clears fastest instead of running the full optimiser on big multi-floor buildings.
"""
import copy
import hashlib
import math
import re
import time
import uuid

from . import push, detect, sms
from . import sites as S
from .building import Building, load, shortest_path
from .optimise import optimise
from .sim import SPECIFIC_FLOW, WALK_SPEED, door_paths, effective_width, simulate
from .store import store

PERSON_TTL = 24 * 3600
EVENT_TTL = 24 * 3600
COLORS = ["#0e7490", "#b45309", "#7e22ce", "#4d7c0f", "#be185d", "#1d4ed8"]
CONCERN, CRUSH = 2.7, 4.0  # p/m2, docs/CROWD_RESEARCH.md
HEAT_C = 57.0  # rating of a standard fixed-temperature heat detector
ALARM_TYPES = {"fire": "Fire", "earthquake": "Earthquake", "collapse": "Structural collapse", "gas": "Gas leak", "drill": "Evacuation drill", "other": "Emergency"}
HAZARD_KINDS = {"fire", "smoke", "heat", "collapse", "blocked"}
TOKEN = re.compile(r"[A-Za-z0-9-]{8,64}")


def pk(sid: str) -> str:
    return f"SITE#{sid}"


def _site(sid: str) -> dict:
    s = S.get_site(sid)
    if s is None:
        raise KeyError(f"unknown site {sid}")
    return s


_loaded: dict[str, tuple[float, Building]] = {}


def _building(site: dict) -> Building:
    key, stamp = site["id"], site.get("updated_at", 0)
    hit = _loaded.get(key)
    if hit and hit[0] == stamp:
        return hit[1]
    b = load(site["building"])
    _loaded[key] = (stamp, b)
    return b


def _nodes(site: dict) -> dict:
    return {n["id"]: n for n in site["building"]["nodes"]}


def _floor_names(site: dict) -> dict:
    return {f["id"]: f.get("name", f["id"]) for f in site["building"].get("floors") or []}


def _label(n: dict) -> str:
    return n.get("label") or n["id"].replace("_", " ")


def event(sid: str, kind: str, text: str) -> None:
    store().put(pk(sid), f"EVENT#{time.time():.3f}#{uuid.uuid4().hex[:4]}", {"at": time.time(), "kind": kind, "text": text}, EVENT_TTL)


# ---------- people ----------
def _check_token(token: str) -> None:
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError("token: 8-64 letters, digits or dashes")


def _person(sid: str, token: str) -> dict | None:
    return store().get(pk(sid), f"P#{token}")


def _save_person(sid: str, p: dict) -> None:
    p["updated_at"] = time.time()
    store().put(pk(sid), f"P#{p['token']}", p, PERSON_TTL)


def people(sid: str) -> list[dict]:
    return [d for _, d in store().query(pk(sid), "P#")]


def checkin(sid: str, token: str, room: str | None = None, gate: str | None = None) -> dict:
    _check_token(token)
    site = _site(sid)
    nodes = _nodes(site)
    if room is not None and (room not in nodes or nodes[room]["type"] != "room"):
        raise ValueError(f"unknown room {room}")
    if gate is not None and (gate not in nodes or nodes[gate]["type"] != "exit"):
        raise ValueError(f"unknown entrance {gate}")
    p = _person(sid, token)
    new = p is None
    if new:
        p = {"token": token, "checked_in_at": time.time(), "status": "inside", "need": None, "room": None, "gate": None,
             "push": None, "seen": 0, "safe_verified": None}
    if room:
        p["room"] = room
    if gate:
        p["gate"] = gate
    if p["status"] == "safe" and not alarm(sid):
        p["status"] = "inside"
    _save_person(sid, p)
    if new:
        where = _label(nodes[room]) if room else f"entrance {_label(nodes[gate])}" if gate else "the building"
        event(sid, "info", f"Checked in: {where}")
    return me(sid, token)


LINK_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"  # no 0/o, 1/l/i: easy to read from a text message


def register(sid: str, token: str, phone: str) -> dict:
    """Register this phone's number for emergency texts at `sid`. Sends a one-time code unless the number is
    already verified. Returns Me plus {"verify": "sandbox" | "code" | "none"}."""
    _check_token(token)
    site = _site(sid)
    try:
        e164 = sms.normalize(phone)
    except sms.SmsError as e:
        raise ValueError(str(e))
    p = _person(sid, token) or {"token": token, "checked_in_at": time.time(), "status": "inside", "need": None, "room": None,
                                "gate": None, "push": None, "seen": 0, "safe_verified": None}
    v = p.get("verify") or {}
    if p.get("phone") == e164 and not p.get("phone_verified") and time.time() - v.get("sent_at", 0) < 30:
        raise ValueError("A code was sent less than 30 seconds ago. Wait a moment before asking again.")
    sends = [t for t in v.get("history", []) if time.time() - t < 3600]
    if len(sends) >= 5:
        raise ValueError("Too many codes for this phone in the last hour. Try again later.")
    for other in people(sid):  # the same number on another device: keep only the newest registration
        if other.get("phone") == e164 and other["token"] != token:
            store().delete(pk(sid), f"P#{other['token']}")
    try:
        r = sms.start_verify(e164, token, site["name"])
    except sms.SmsError as e:
        raise ValueError(str(e))
    p["phone"], p["phone_verified"] = e164, r["method"] == "none"
    p["verify"] = {"method": r["method"], "hash": r.get("hash"), "sent_at": time.time(), "attempts": 0, "history": sends + [time.time()]}
    if p["phone_verified"]:
        _registered(sid, p)
    _save_person(sid, p)
    return {**me(sid, token), "verify": r["method"]}


def verify_phone(sid: str, token: str, code: str) -> dict:
    _check_token(token)
    _site(sid)
    p = _person(sid, token)
    if p is None or not p.get("phone"):
        raise KeyError("not registered")
    if p.get("phone_verified"):
        return me(sid, token)
    v = p.get("verify") or {}
    if time.time() - v.get("sent_at", 0) > 600:
        raise ValueError("That code has expired. Ask for a new one.")
    if v.get("attempts", 0) >= 5:
        raise ValueError("Too many wrong codes. Ask for a new one.")
    v["attempts"] = v.get("attempts", 0) + 1
    ok = sms.finish_verify(p["phone"], p["token"], code, v.get("method", "code"), v.get("hash"))
    p["verify"] = v
    if not ok:
        _save_person(sid, p)
        raise ValueError("That code is not right. Check the text message and try again.")
    p["phone_verified"] = True
    _registered(sid, p)
    _save_person(sid, p)
    return me(sid, token)


def _registered(sid: str, p: dict) -> None:
    if not p.get("link"):
        code = "".join(LINK_CHARS[b % len(LINK_CHARS)] for b in uuid.uuid4().bytes[:7])
        p["link"] = code
        store().put("LINK", code, {"site": sid, "token": p["token"]}, PERSON_TTL)
    event(sid, "info", f"Phone registered for SMS alerts: {sms.mask(p['phone'])}")


def resolve_link(code: str) -> dict | None:
    """Short link in a text message -> {site, token}."""
    if not re.fullmatch(r"[a-z0-9]{4,12}", code or ""):
        return None
    return store().get("LINK", code)


def _text_people(sid: str, ppl: list[dict], text_for, kind: str) -> dict:
    """Text every verified phone. Records the result on each person; returns {sent, failed}."""
    targets = [p for p in ppl if p.get("phone") and p.get("phone_verified")]
    results = sms.send_many([(p["phone"], text_for(p)) for p in targets])
    sent = failed = 0
    for p, r in zip(targets, results):
        sent += r["ok"]
        failed += not r["ok"]
        q = _person(sid, p["token"])
        if q:
            q["sms_last"] = {"kind": kind, "ok": r["ok"], "error": r.get("error"), "at": time.time()}
            _save_person(sid, q)
    if targets:
        event(sid, "info" if not failed else "warn", f"SMS {kind}: sent to {sent} phone{'s' if sent != 1 else ''}" + (f", {failed} failed" if failed else ""))
        store().put(pk(sid), "SMSLAST", {"kind": kind, "sent": sent, "failed": failed, "at": time.time()}, EVENT_TTL)
    return {"sent": sent, "failed": failed}


def test_sms(sid: str, short_id: str) -> dict:
    """Send a test text to one registered phone (picked in the control room by its short id)."""
    site = _site(sid)
    p = next((q for q in people(sid) if hashlib.sha1(q["token"].encode()).hexdigest()[:8] == short_id), None)
    if p is None or not p.get("phone"):
        raise KeyError("no registered phone with that id")
    if not p.get("phone_verified"):
        raise ValueError("that phone has not finished verifying its number")
    return _text_people(sid, [p], lambda q: f"Test from {_ascii(site['name'])[:40]}: emergency texts will reach this phone.", "test")


def test_push(sid: str, token: str) -> dict:
    """The phone asks for a test notification to itself (at most one every 10 s)."""
    _check_token(token)
    site = _site(sid)
    p = _person(sid, token)
    if p is None:
        raise KeyError("not checked in")
    if not p.get("push"):
        raise ValueError("Alerts are not turned on for this phone yet.")
    if time.time() - p.get("push_test_at", 0) < 10:
        raise ValueError("A test alert was sent a moment ago.")
    p["push_test_at"] = time.time()
    code = push.send(p["push"], {"title": f"Test alert · {site['name']}", "body": "Alerts work on this phone. In a real alarm, tap the notification for your exit route.",
                                 "tag": "test", "url": f"/#/go?site={sid}"}, ttl=120)
    if code in (404, 410):
        p["push"] = None
    _save_person(sid, p)
    if not 200 <= code < 300:
        raise ValueError("The test alert could not be delivered. Turn alerts off and on again." if code in (404, 410) else "The test alert could not be sent. Try again in a minute.")
    return {"ok": True}


def _ascii(s: str) -> str:
    return s.encode("ascii", "ignore").decode().strip() or "the building"


def checkout(sid: str, token: str) -> None:
    _check_token(token)
    if _person(sid, token):
        store().delete(pk(sid), f"P#{token}")


def save_push(sid: str, token: str, sub: dict) -> None:
    _check_token(token)
    p = _person(sid, token)
    if p is None:
        raise KeyError("not checked in")
    if not (isinstance(sub, dict) and str(sub.get("endpoint", "")).startswith("https://") and sub.get("keys", {}).get("p256dh") and sub.get("keys", {}).get("auth")):
        raise ValueError("not a push subscription")
    p["push"] = {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["keys"]["p256dh"], "auth": sub["keys"]["auth"]}}
    _save_person(sid, p)


def set_status(sid: str, token: str, status: str, need: str | None = None, lat=None, lng=None, accuracy=None) -> dict:
    _check_token(token)
    if status not in ("safe", "help", "inside"):
        raise ValueError("status: safe, help or inside")
    if need not in (None, "stairs", "medical", "trapped"):
        raise ValueError("need: stairs, medical or trapped")
    site = _site(sid)
    p = _person(sid, token)
    if p is None:
        raise KeyError("not checked in")
    p["status"], p["need"] = status, need if status == "help" else None
    p["safe_verified"], p["safe_distance_m"] = None, None
    nodes = _nodes(site)
    where = _label(nodes[p["room"]]) if p.get("room") in nodes else "unknown room"
    if status == "safe":
        a = alarm(sid)
        ex = (a or {}).get("plan", {}).get("rooms", {}).get(p.get("room"), {}).get("exit")
        pts = [x for x in S.assembly_points(site) if x.get("lat") is not None]
        target = S.assembly_for_exit(site, ex) if ex else None
        if target and target.get("lat") is None:
            target = None
        if lat is not None and lng is not None and pts:
            near = min(pts, key=lambda x: S.haversine_m(lat, lng, x["lat"], x["lng"]))
            target = target or near
            d = min(S.haversine_m(lat, lng, target["lat"], target["lng"]), S.haversine_m(lat, lng, near["lat"], near["lng"]))
            p["safe_distance_m"] = round(d)
            p["safe_verified"] = d <= max(120.0, float(accuracy or 0) * 1.5)
        event(sid, "good", f"Safe: from {where}" + ("" if p["safe_verified"] is None else " (at the assembly point)" if p["safe_verified"] else f" ({p['safe_distance_m']} m from the assembly point)"))
    elif status == "help":
        what = {"stairs": "cannot use stairs", "medical": "medical help", "trapped": "trapped"}.get(need or "", "needs help")
        event(sid, "danger", f"Help requested in {where}: {what}")
    _save_person(sid, p)
    return me(sid, token)


# ---------- hazards, sensors, cameras ----------
def alarm(sid: str) -> dict | None:
    return store().get(pk(sid), "ALARM")


def hazards(sid: str) -> list[dict]:
    return [d for _, d in store().query(pk(sid), "HAZ#")]


def _blocked(hz: list[dict]) -> set:
    return {h["node"] for h in hz}


def add_hazard(sid: str, kind: str, node: str, source: str = "manual", confidence: float | None = None) -> dict:
    site = _site(sid)
    nodes = _nodes(site)
    if kind not in HAZARD_KINDS:
        raise ValueError(f"kind: one of {sorted(HAZARD_KINDS)}")
    if node not in nodes:
        raise ValueError(f"unknown node {node}")
    for h in hazards(sid):
        if h["node"] == node:
            return h
    floors = _floor_names(site)
    n = nodes[node]
    h = {"id": "h" + uuid.uuid4().hex[:6], "kind": kind, "node": node, "floor": n.get("floor_id"),
         "label": _label(n) + (f", {floors[n['floor_id']]}" if n.get("floor_id") in floors and floors[n["floor_id"]] not in _label(n) else ""),
         "source": source, "confidence": confidence, "at": time.time()}
    store().put(pk(sid), f"HAZ#{h['id']}", h)
    how = source + (f", {round(confidence * 100)}% confidence" if confidence else "")
    event(sid, "danger", f"{kind.title()} reported at {h['label']} ({how})")
    a = alarm(sid)
    if a:
        replan(sid, f"{kind} at {h['label']}")
    elif source in ("sensor", "camera") and kind in ("fire", "smoke", "heat"):
        start_alarm(sid, "fire", f"{kind.title()} detected at {h['label']}", origin=node)
    return h


def remove_hazard(sid: str, hid: str) -> None:
    h = store().get(pk(sid), f"HAZ#{hid}")
    if h is None:
        raise KeyError(hid)
    store().delete(pk(sid), f"HAZ#{hid}")
    event(sid, "good", f"Cleared: {h['kind']} at {h['label']}")
    if alarm(sid):
        replan(sid, f"{h['label']} cleared")


def sensor_reading(sid: str, sensor_id: str, node: str, temp_c: float | None = None, smoke: float | None = None) -> str | None:
    site = _site(sid)
    if node not in _nodes(site):
        raise ValueError(f"unknown node {node}")
    store().put(pk(sid), f"SENSOR#{sensor_id}", {"sensor_id": sensor_id, "node": node, "temp_c": temp_c, "smoke": smoke, "at": time.time()}, EVENT_TTL)
    if (temp_c is not None and temp_c >= HEAT_C) or (smoke is not None and smoke >= 0.5):
        kind = "smoke" if smoke is not None and smoke >= 0.5 else "heat"
        return add_hazard(sid, kind, node, "sensor", None)["id"]
    return None


def camera_report(sid: str, camera_id: str, node: str, people_n: int | None = None, fire: float = 0, smoke: float = 0, image: str | None = None) -> dict:
    site = _site(sid)
    nodes = _nodes(site)
    if node not in nodes:
        raise ValueError(f"unknown node {node}")
    if people_n is not None and not 0 <= people_n <= 5000:
        raise ValueError("people must be between 0 and 5000")
    old = store().get(pk(sid), f"CAM#{camera_id}") or {}
    rec = {"camera_id": camera_id, "node": node, "people": people_n, "fire": round(fire, 2), "smoke": round(smoke, 2), "at": time.time(),
           "confirmed": old.get("confirmed") if old.get("node") == node else None, "confirmed_at": old.get("confirmed_at") if old.get("node") == node else None}
    out: dict = {"confirmed": None, "hazard": None}
    if max(fire, smoke) >= 0.6:
        c = detect.confirm(image) if image else None
        if c is not None:
            ok = max(c["fire"], c["smoke"]) >= 0.6
            kind = "fire" if c["fire"] >= c["smoke"] else "smoke"
            score = max(c["fire"], c["smoke"])
            rec["confirmed"] = out["confirmed"] = ok
            rec["confirmed_at"] = time.time()
        else:  # no second opinion available: only a strong browser score counts
            ok, kind, score = max(fire, smoke) >= 0.85, "fire" if fire >= smoke else "smoke", max(fire, smoke)
        if ok:
            out["hazard"] = add_hazard(sid, kind, node, "camera", round(score, 2))["id"]
    store().put(pk(sid), f"CAM#{camera_id}", rec, EVENT_TTL)
    a = alarm(sid)
    if a and people_n is not None and old.get("people") != people_n and nodes[node]["type"] == "room" and time.time() - a.get("replanned_at", 0) > 10:
        replan(sid, f"camera count in {_label(nodes[node])}: {people_n}")
    return out


def _cameras(sid):
    return [d for _, d in store().query(pk(sid), "CAM#")]


def _sensors(sid):
    return [d for _, d in store().query(pk(sid), "SENSOR#")]


# ---------- planning ----------
def _occupancy(site: dict, ppl: list[dict], cams: list[dict]) -> dict:
    """People to plan for in each room: the floor plan's number, raised to the phones checked in there,
    replaced by a camera's head count where a camera watches the room."""
    occ = {n["id"]: int(n.get("people", 0)) for n in site["building"]["nodes"] if n["type"] == "room"}
    checked: dict = {}
    for p in ppl:
        if p.get("room") in occ and p.get("status") != "safe":
            checked[p["room"]] = checked.get(p["room"], 0) + 1
    for r, c in checked.items():
        occ[r] = max(occ[r], c)
    for c in cams:
        if c.get("node") in occ and c.get("people") is not None and time.time() - c.get("at", 0) < 120:
            occ[c["node"]] = max(int(c["people"]), checked.get(c["node"], 0))
    return occ


def _path_len(b: Building, path: list) -> float:
    total = 0.0
    for u, v in zip(path, path[1:]):
        total += min(e.length for nb, e in b.adj[u] if nb == v)
    return total


def _edge(b: Building, u: str, v: str):
    return min((e for nb, e in b.adj[u] if nb == v), key=lambda e: e.length)


def _routes(b: Building, rooms: list, exits: list, blocked: set) -> dict:
    """(room, exit) -> (distance, path) through the room's best door, for every reachable pair."""
    out = {}
    for r in rooms:
        for x in exits:
            best = None
            for _, p in door_paths(b, r, x, blocked):
                d = _path_len(b, p)
                if best is None or d < best[0]:
                    best = (d, p)
            if best:
                out[(r, x)] = best
    return out


def _stair_group(b: Building, path: list) -> str | None:
    for u, v in zip(path, path[1:]):
        e = _edge(b, u, v)
        if e.kind == "stair":
            return e.capacity_group or f"{u}-{v}"
    return None


def _exit_flow(b: Building, x: str) -> float:
    return sum(effective_width(e) * SPECIFIC_FLOW[e.kind] for _, e in b.adj[x]) or 1.0


def _plan(site: dict, occ: dict, blocked: set) -> dict:
    """Pick room -> exit for the rooms that can still get out. Candidates: nearest exit, a load-balanced plan that
    spreads people over exits and stairwells, and (small single-floor buildings) the full optimiser. The
    simulator times each; the fastest wins."""
    bd = copy.deepcopy(site["building"])
    for n in bd["nodes"]:
        if n["type"] == "room":
            n["people"] = occ.get(n["id"], 0)
    b = load(bd)
    exits = [x for x in b.exits if x not in blocked]
    rooms = sorted(b.rooms)
    routes = _routes(b, rooms, exits, blocked)
    reach = [r for r in rooms if any((r, x) in routes for x in exits)]
    trapped = [r for r in rooms if r not in reach]
    if not reach:
        return {"plan": {}, "routes": routes, "trapped": trapped, "time_s": None, "method": "none", "b": b}
    nearest = {r: min((routes[(r, x)][0], x) for x in exits if (r, x) in routes)[1] for r in reach}
    stair_flow = {}
    for e in b.edges:
        if e.kind == "stair":
            g = e.capacity_group or f"{e.a}-{e.b}"
            stair_flow[g] = min(stair_flow.get(g, 1e9), effective_width(e) * SPECIFIC_FLOW["stair"])
    load_x, load_s, balanced = {}, {}, {}
    for r in sorted(reach, key=lambda r: min(routes[(r, x)][0] for x in exits if (r, x) in routes)):
        n = occ.get(r, 0)
        best, bc = None, math.inf
        for x in exits:
            if (r, x) not in routes:
                continue
            d, p = routes[(r, x)]
            g = _stair_group(b, p)
            c = d / WALK_SPEED + (load_x.get(x, 0) + n) / _exit_flow(b, x) + ((load_s.get(g, 0) + n) / stair_flow.get(g, 1.0) if g else 0)
            if c < bc:
                bc, best = c, x
        balanced[r] = best
        load_x[best] = load_x.get(best, 0) + n
        g = _stair_group(b, routes[(r, best)][1])
        if g:
            load_s[g] = load_s.get(g, 0) + n
    # simulate on a copy without the trapped rooms (they cannot reach any exit)
    sub = copy.deepcopy(bd)
    if trapped:
        gone = set(trapped)
        sub["nodes"] = [n for n in sub["nodes"] if n["id"] not in gone]
        sub["edges"] = [e for e in sub["edges"] if e["from"] not in gone and e["to"] not in gone]
    bs = load(sub)
    cands = [("nearest exit", nearest), ("balanced", balanced)]
    if not bd.get("floors") and len(bd["nodes"]) <= 80 and not trapped:
        try:
            cands.append(("optimised", optimise(bs, blocked)["plan"]))
        except Exception:
            pass
    best = None
    for name, plan in cands:
        try:
            t = simulate(bs, plan, blocked, frame_every=1e9)["total_time_s"]
        except Exception:
            continue
        if t is not None and (best is None or t < best[0]):
            best = (t, name, plan)
    if best is None:
        best = (None, "balanced", balanced)
    return {"plan": best[2], "routes": routes, "trapped": trapped, "time_s": best[0], "method": best[1], "b": b}


def _steps(site: dict, b: Building, path: list, mode: str = "exit") -> list[dict]:
    """Spoken-style directions from a node path: walks merged until a turn or a stair, stairs merged across floors."""
    nodes = _nodes(site)
    floors = {f["id"]: f for f in site["building"].get("floors") or []}
    fname = lambda f: floors[f].get("name", f) if f in floors else ""
    steps = [{"kind": "start", "text": f"Leave {_label(nodes[path[0]])} through the nearest door" if nodes[path[0]]["type"] == "room" else f"Start at {_label(nodes[path[0]])}",
              "floor": nodes[path[0]].get("floor_id"), "node": path[0], "distance_m": 0}]
    walk, heading, target = 0.0, None, None

    def flush():
        nonlocal walk
        if walk > 0.5 and target:
            t = nodes[target]
            where = f"to {_label(t)}" if t.get("label") and t["type"] != "exit" else "along the corridor"
            steps.append({"kind": "walk", "text": f"Walk {round(walk)} m {where}", "floor": t.get("floor_id"), "node": target, "distance_m": round(walk, 1)})
        walk = 0.0

    i = 0
    edges = list(zip(path, path[1:]))
    while i < len(edges):
        u, v = edges[i]
        e = _edge(b, u, v)
        if e.kind == "stair" or nodes[u].get("floor_id") != nodes[v].get("floor_id"):
            flush()
            start_f, label, dist = nodes[u].get("floor_id"), e.label if getattr(e, "label", None) else None, 0.0
            while i < len(edges):
                uu, vv = edges[i]
                ee = _edge(b, uu, vv)
                if not (ee.kind == "stair" or nodes[uu].get("floor_id") != nodes[vv].get("floor_id")):
                    break
                dist += ee.length
                i += 1
            end_f = nodes[edges[i - 1][1]].get("floor_id")
            up = floors.get(end_f, {}).get("elevation_m", 0) > floors.get(start_f, {}).get("elevation_m", 0)
            n_fl = abs([f["id"] for f in sorted(floors.values(), key=lambda f: f.get("elevation_m", 0))].index(end_f) -
                       [f["id"] for f in sorted(floors.values(), key=lambda f: f.get("elevation_m", 0))].index(start_f)) if start_f in floors and end_f in floors else 1
            name = label or (_label(nodes[u]).split(",")[0] if "stair" in _label(nodes[u]).lower() else "the stairs")
            steps.append({"kind": "stairs", "text": f"Take {name if name.startswith('the') else 'the ' + name} {'up' if up else 'down'} {n_fl} floor{'s' if n_fl != 1 else ''} to {fname(end_f)}",
                          "floor": end_f, "node": edges[i - 1][1], "distance_m": round(dist, 1)})
            heading, target = None, edges[i - 1][1]
            continue
        vec = (nodes[v]["x"] - nodes[u]["x"], nodes[v]["z"] - nodes[u]["z"])
        if heading and math.hypot(*vec) > 0.5 and math.hypot(*heading) > 0.5:
            cross = heading[0] * vec[1] - heading[1] * vec[0]
            dot = heading[0] * vec[0] + heading[1] * vec[1]
            ang = math.degrees(math.atan2(cross, dot))
            if abs(ang) > 35 and nodes[u]["type"] != "room":
                flush()
                at = f" at {_label(nodes[u])}" if nodes[u].get("label") else ""
                steps.append({"kind": "turn", "text": f"Turn {'right' if ang > 0 else 'left'}{at}" if abs(ang) < 150 else f"Turn around{at}",
                              "floor": nodes[u].get("floor_id"), "node": u, "distance_m": 0})
        if math.hypot(*vec) > 0.5:
            heading = vec
        walk += e.length
        target = v
        i += 1
    last = nodes[path[-1]]
    if mode == "exit" and last["type"] == "exit":
        flush()
        steps.append({"kind": "exit", "text": f"Leave the building through {_label(last)}", "floor": last.get("floor_id"), "node": path[-1], "distance_m": 0})
    else:
        flush()
    return steps


def _route_payload(site: dict, b: Building, path: list, exit_id: str | None, mode: str = "exit") -> dict:
    nodes = _nodes(site)
    dist = _path_len(b, path)
    steps = _steps(site, b, path, mode)
    a = S.assembly_for_exit(site, exit_id) if exit_id and mode == "exit" else None
    if a:
        ex = nodes[exit_id]
        out_m = round(math.hypot(a["x"] - ex["x"], a["z"] - ex["z"]))
        steps.append({"kind": "outside", "text": f"Walk {out_m} m to {a['label']}", "floor": None, "node": None, "distance_m": out_m})
    if mode == "refuge":
        steps.append({"kind": "refuge", "text": f"Wait at {_label(nodes[path[-1]])}. The control room has your location and rescue teams are told.",
                      "floor": nodes[path[-1]].get("floor_id"), "node": path[-1], "distance_m": 0})
    return {"mode": mode, "exit": exit_id, "exit_label": _label(nodes[exit_id]) if exit_id else None, "path": path,
            "distance_m": round(dist, 1), "walk_s": round(dist / WALK_SPEED), "steps": steps,
            "assembly": {k: a.get(k) for k in ("id", "label", "lat", "lng")} if a else None}


def _refuge(site: dict, b: Building, start: str, blocked: set) -> dict | None:
    """Nearest stair landing on the person's own floor: a protected place to wait for rescue."""
    nodes = _nodes(site)
    f = nodes[start].get("floor_id")
    landings = {e.a for e in b.edges if e.kind == "stair"} | {e.b for e in b.edges if e.kind == "stair"}
    cands = [n for n in landings if nodes[n].get("floor_id") == f and n not in blocked]
    # never wait in a stairwell that has a fire or smoke in it on another floor, if there is another one
    shaft = {}
    for e in b.edges:
        if e.kind == "stair":
            shaft[e.a] = shaft[e.b] = e.capacity_group or f"{e.a}-{e.b}"
    bad = {shaft[n] for n in blocked if n in shaft}
    safer = [n for n in cands if shaft.get(n) not in bad]
    cands = safer or cands
    best = None
    for c in cands:
        d, p = shortest_path(b, start, c, blocked - {start})
        if p and (best is None or d < best[0]):
            best = (d, p)
    return _route_payload(site, b, best[1], None, "refuge") if best else None


def _waves(site: dict, a: dict, hz: list[dict]) -> dict:
    """Phased evacuation (BS 9999): the incident floor and the floor above go first, the floors above them
    next, one wave each, then the floors below. Returns floor -> wave."""
    floors = sorted(site["building"].get("floors") or [], key=lambda f: f.get("elevation_m", 0))
    if not a.get("phased") or len(floors) < 2:
        return {f["id"]: 0 for f in floors}
    nodes = _nodes(site)
    origin = nodes.get(a.get("origin") or "", {}).get("floor_id") or (hz[0]["floor"] if hz and hz[0].get("floor") else floors[-1]["id"])
    ids = [f["id"] for f in floors]
    o = ids.index(origin) if origin in ids else len(ids) - 1
    order = [ids[o]] + ids[o + 1:] + list(reversed(ids[:o]))
    out, w = {}, 0
    for k, f in enumerate(order):
        out[f] = w
        if k >= 1:
            w += 1
    return out


def replan(sid: str, reason: str, notify: bool = True) -> dict | None:
    a = alarm(sid)
    if a is None:
        return None
    site = _site(sid)
    ppl, hz, cams = people(sid), hazards(sid), _cameras(sid)
    occ = _occupancy(site, ppl, cams)
    blocked = _blocked(hz)
    r = _plan(site, occ, blocked)
    b = r["b"]
    old = a.get("plan", {}).get("rooms", {})
    groups = a.get("groups", {})
    used = sorted(set(r["plan"].values()), key=lambda x: -sum(occ.get(rm, 0) for rm, ex in r["plan"].items() if ex == x))
    for x in used:
        if x not in groups:
            k = len(groups)
            groups[x] = {"letter": chr(65 + k), "color": COLORS[k % len(COLORS)]}
    rooms = {}
    for rm, x in r["plan"].items():
        d, path = r["routes"][(rm, x)]
        rooms[rm] = {**_route_payload(site, b, path, x), "group": groups[x]["letter"], "group_color": groups[x]["color"],
                     "alts": {ex: round(r["routes"][(rm, ex)][0], 1) for ex in b.exits if (rm, ex) in r["routes"]}}
    changed = sorted(rm for rm in rooms if rm in old and old[rm]["exit"] != rooms[rm]["exit"])
    newly_trapped = sorted(rm for rm in r["trapped"] if rm not in a.get("plan", {}).get("trapped", []))
    version = a.get("version", 0) + 1
    changed_v = dict(a.get("changed_v", {}))  # room -> version its route last changed in (phones compare with theirs)
    for rm in changed + newly_trapped:
        changed_v[rm] = version
    a.update({
        "groups": groups, "version": version, "replanned_at": time.time(), "changed_v": changed_v,
        "changed": changed + newly_trapped, "waves": _waves(site, a, hz),
        "plan": {"rooms": rooms, "trapped": r["trapped"], "blocked": sorted(blocked), "time_s": r["time_s"], "method": r["method"], "occupancy": occ},
    })
    store().put(pk(sid), "ALARM", a)
    if a["version"] > 1 and (changed or newly_trapped):
        nodes = _nodes(site)
        txt = ", ".join(f"{_label(nodes[rm])} to {rooms[rm]['exit_label']}" for rm in changed[:4])
        event(sid, "warn", f"Re-planned after {reason}: {len(changed)} room(s) re-routed" + (f" ({txt})" if txt else "") +
              (f"; cut off: {', '.join(_label(nodes[t]) for t in newly_trapped)}" if newly_trapped else ""))
        if notify:
            _notify(sid, [p for p in ppl if p.get("room") in set(changed) | set(newly_trapped)],
                    lambda p: {"title": "Your route has changed", "body": f"Go to {rooms[p['room']]['exit_label']} instead." if p["room"] in rooms else "Your way out is blocked. Go to the stair landing and wait for rescue.",
                               "tag": f"route-{a['id']}", "url": f"/#/go?site={sid}"})
    return a


def _notify(sid: str, ppl: list[dict], message_for) -> None:
    items = [(p["token"], p["push"]) for p in ppl if p.get("push")]
    by_tok = {p["token"]: p for p in ppl}
    codes = push.send_many(items, lambda tok: message_for(by_tok[tok]))
    for tok, code in codes.items():
        if code in (404, 410):  # the browser dropped this subscription
            p = _person(sid, tok)
            if p:
                p["push"] = None
                _save_person(sid, p)


def start_alarm(sid: str, type_: str = "fire", message: str = "", origin: str | None = None, phased: bool = False, wave_gap_s: float = 60, link_base: str = "") -> dict:
    site = _site(sid)
    if type_ not in ALARM_TYPES:
        raise ValueError(f"type: one of {sorted(ALARM_TYPES)}")
    if origin is not None and origin not in _nodes(site):
        raise ValueError(f"unknown origin {origin}")
    a = {"id": "a" + uuid.uuid4().hex[:6], "type": type_, "message": message[:200], "origin": origin, "started_at": time.time(),
         "phased": bool(phased), "wave_gap_s": max(10.0, min(600.0, float(wave_gap_s))), "version": 0, "groups": {}, "plan": {}, "changed": [], "last_divert": 0}
    store().put(pk(sid), "ALARM", a)
    for p in people(sid):
        if p["status"] != "help":
            p["status"], p["safe_verified"] = "inside", None
            _save_person(sid, p)
    event(sid, "danger", f"Alarm: {ALARM_TYPES[type_]}" + (f" ({message})" if message else ""))
    a = replan(sid, "alarm", notify=False)
    rooms = a["plan"]["rooms"]
    title = f"{ALARM_TYPES[type_].upper()} · {site['name']}"

    def msg(p):
        r = rooms.get(p.get("room") or "")
        first = "Drop, cover and hold on until the shaking stops. Then " if type_ == "earthquake" else ""
        body = f"{first}{'l' if first else 'L'}eave now by {r['exit_label']} (Group {r['group']})." if r else f"{first}{'l' if first else 'L'}eave the building now. Open Nikaas for your route."
        return {"title": title, "body": body, "tag": a["id"], "url": f"/#/go?site={sid}", "alarm": True}
    _notify(sid, people(sid), msg)
    # the text message: short and plain (one SMS part), with this person's own link to their route
    head = {"earthquake": "EARTHQUAKE", "fire": "FIRE ALARM", "gas": "GAS LEAK", "collapse": "COLLAPSE", "drill": "EVACUATION DRILL"}.get(type_, "EMERGENCY")
    first = "Drop, cover, hold on. When shaking stops, leave." if type_ == "earthquake" else "Leave now. No lifts."
    _text_people(sid, people(sid), lambda p: f"{head} at {_ascii(site['name'])[:40]}. {first} Your exit route: {link_base}/r/{p.get('link', '')}", "alarm")
    return a


def stop_alarm(sid: str) -> None:
    site = _site(sid)
    if alarm(sid) is None:
        return
    store().delete(pk(sid), "ALARM")
    for p in people(sid):
        p["status"], p["need"], p["safe_verified"] = "inside", None, None
        _save_person(sid, p)
    event(sid, "good", "All clear. The alarm is off.")
    _notify(sid, people(sid), lambda p: {"title": f"All clear · {site['name']}", "body": "The alarm is over. Follow staff instructions before going back in.", "tag": "all-clear", "url": f"/#/go?site={sid}"})
    _text_people(sid, people(sid), lambda p: f"ALL CLEAR at {_ascii(site['name'])[:40]}. The emergency is over. Follow staff instructions before going back in.", "all clear")


# ---------- what one phone sees ----------
def _map(site: dict) -> dict:
    b = site["building"]
    return {"nodes": [[n["id"], n["type"], n["x"], n["z"], n.get("w", 0), n.get("d", 0), n.get("floor_id")] for n in b["nodes"]],
            "edges": [[e["from"], e["to"], e.get("kind", "corridor")] for e in b["edges"]]}


def me(sid: str, token: str) -> dict:
    _check_token(token)
    site = _site(sid)
    p = _person(sid, token)
    if p is None:
        raise KeyError("not checked in")
    nodes = _nodes(site)
    a = alarm(sid)
    hz = hazards(sid)
    b = _building(site)
    route = None
    room = p.get("room")
    if room in nodes:
        if a:
            plan = a.get("plan", {})
            if p["status"] == "help" and p.get("need") in ("stairs", "trapped") and nodes[room].get("floor_id") not in (None, _ground(site)):
                route = _refuge(site, b, room, set(plan.get("blocked", [])))
            elif room in plan.get("rooms", {}):
                route = {k: v for k, v in plan["rooms"][room].items() if k != "alts"}
                wave = a.get("waves", {}).get(nodes[room].get("floor_id"), 0)
                route.update({"wave": wave, "release_at": wave * a.get("wave_gap_s", 60)})
            elif room in plan.get("trapped", []):
                route = _refuge(site, b, room, set(plan.get("blocked", []))) or {"mode": "stay", "steps": [{"kind": "refuge", "text": "Stay in the room, close the door, and tell the control room with the help button.", "floor": nodes[room].get("floor_id"), "node": room, "distance_m": 0}], "path": [room]}
            if route is not None:
                route["changed"] = bool(p.get("seen")) and a.get("changed_v", {}).get(room, 0) > p["seen"]
                if p.get("seen") != a["version"]:
                    p["seen"] = a["version"]
                    _save_person(sid, p)
        else:
            blocked = _blocked(hz)
            best = None
            for x in b.exits:
                if x in blocked:
                    continue
                for _, path in door_paths(b, room, x, blocked):
                    d = _path_len(b, path)
                    if best is None or d < best[0]:
                        best = (d, path, x)
            if best:
                route = {**_route_payload(site, b, best[1], best[2]), "group": None, "group_color": None, "wave": 0, "release_at": 0, "changed": False}
    floors = [{"id": f["id"], "name": f.get("name", f["id"]), "elevation_m": f.get("elevation_m", 0)} for f in sorted(site["building"].get("floors") or [], key=lambda f: f.get("elevation_m", 0))]
    public = {k: v for k, v in p.items() if k not in ("push", "verify", "phone", "link")}
    public["phone"] = sms.mask(p.get("phone"))
    public["phone_verified"] = bool(p.get("phone_verified"))
    public["verify_pending"] = bool(p.get("phone")) and not p.get("phone_verified")
    public["room_label"] = _label(nodes[room]) if room in nodes else None
    public["floor"] = nodes[room].get("floor_id") if room in nodes else None
    public["push"] = bool(p.get("push"))
    return {
        "site": {"id": site["id"], "name": site["name"], "floors": floors,
                 "rooms": [[n["id"], _label(n), n.get("floor_id")] for n in site["building"]["nodes"] if n["type"] == "room"],
                 "exits": [[n["id"], _label(n)] for n in site["building"]["nodes"] if n["type"] == "exit"]},
        "person": public,
        "alarm": {k: a[k] for k in ("id", "type", "message", "started_at", "origin", "version", "phased", "wave_gap_s")} if a else None,
        "route": route,
        "hazards": [{k: h[k] for k in ("id", "kind", "node", "floor", "label")} for h in hz],
        "map": _map(site),
        "version": a["version"] if a else 0,
    }


def _ground(site: dict) -> str | None:
    fl = sorted(site["building"].get("floors") or [], key=lambda f: f.get("elevation_m", 0))
    return fl[0]["id"] if fl else None


# ---------- control room ----------
def _area(b: Building, site: dict, node: str) -> float:
    n = _nodes(site)[node]
    if n["type"] == "room":
        return max(1.0, float(n.get("w", 0)) * float(n.get("d", 0)))
    return max(1.0, sum(e.length / 2 * e.width for _, e in b.adj[node]))


def _level(d: float) -> str:
    return "crush" if d >= CRUSH else "concern" if d >= CONCERN else "ok"


def _divert(sid: str, site: dict, a: dict, ppl: list[dict], cams: list[dict]) -> dict:
    """When one exit would take much longer to clear than the best one, move a room to another exit."""
    now = time.time()
    if not a or now - a.get("last_divert", 0) < 20 or now - a.get("started_at", 0) < 15 or now - a.get("replanned_at", 0) < 20:
        return a
    plan = a.get("plan", {})
    rooms, occ = plan.get("rooms", {}), plan.get("occupancy", {})
    if len({r["exit"] for r in rooms.values()}) < 1 or not rooms:
        return a
    b = _building(site)
    safe_from: dict = {}
    for p in ppl:
        if p.get("status") == "safe" and p.get("room"):
            safe_from[p["room"]] = safe_from.get(p["room"], 0) + 1
    exits = [x for x in b.exits if x not in set(plan.get("blocked", []))]
    remaining = {x: 0.0 for x in exits}
    for rm, r in rooms.items():
        if r["exit"] in remaining:
            remaining[r["exit"]] += max(0, occ.get(rm, 0) - safe_from.get(rm, 0))
    for c in cams:  # a camera watching an exit's approach adds the queue it sees
        if c.get("people") and time.time() - c.get("at", 0) < 60:
            for nb, _ in b.adj.get(c["node"], []):
                if nb in remaining:
                    remaining[nb] += c["people"]
    eta = {x: remaining[x] / _exit_flow(b, x) for x in exits}
    if len(eta) < 2:
        return a
    worst = max(eta, key=eta.get)
    best_x = min(eta, key=eta.get)
    if not (eta[worst] > 60 and eta[worst] > 1.5 * max(eta[best_x], 1)):
        return a
    moves = []
    for rm, r in rooms.items():
        if r["exit"] != worst:
            continue
        alts = {x: d for x, d in r.get("alts", {}).items() if x != worst and x in eta}
        if not alts:
            continue
        x2 = min(alts, key=lambda x: eta[x] + alts[x] / WALK_SPEED)
        moves.append((alts[x2] - r["distance_m"], rm, x2))
    if not moves:
        return a
    # only divert when the simulator agrees it gets people out faster (a busy exit may still be the right one,
    # for example when the other route shares the same stairwell). Greedy: up to three rooms per check.
    rem = {rm: max(0, occ.get(rm, 0) - safe_from.get(rm, 0)) for rm in occ}
    blocked = set(plan.get("blocked", []))
    current = {rm: r["exit"] for rm, r in rooms.items()}
    base = best_t = _sim_time(site, rem, blocked, current, plan.get("trapped", []))
    moved: list[tuple[str, str]] = []
    cands = sorted(moves)[:4]
    for _ in range(3):
        if best_t is None:
            break
        tried = []
        for _, rm, x2 in cands:
            if any(rm == m[0] for m in moved):
                continue
            t = _sim_time(site, rem, blocked, {**current, rm: x2}, plan.get("trapped", []))
            if t is not None:
                tried.append((t, rm, x2))
        if not tried or min(tried)[0] >= best_t:
            break
        best_t, rm, x2 = min(tried)
        current[rm] = x2
        moved.append((rm, x2))
    if base is None or not moved or best_t > base * 0.97:
        a["last_divert"] = now  # checked: nothing clearly better; look again later
        store().put(pk(sid), "ALARM", a)
        return a
    groups = a["groups"]
    nodes = _nodes(site)
    version = a["version"] + 1
    for rm, x2 in moved:
        path = door_paths(b, rm, x2, blocked)
        if not path:
            continue
        best = min(((_path_len(b, p), p) for _, p in path))
        if x2 not in groups:
            k = len(groups)
            groups[x2] = {"letter": chr(65 + k), "color": COLORS[k % len(COLORS)]}
        rooms[rm] = {**_route_payload(site, b, best[1], x2), "group": groups[x2]["letter"], "group_color": groups[x2]["color"], "alts": rooms[rm].get("alts", {})}
    a.update({"version": version, "changed": [m[0] for m in moved], "last_divert": now})
    a["changed_v"] = {**a.get("changed_v", {}), **{m[0]: version for m in moved}}
    a["plan"]["time_s"] = best_t
    store().put(pk(sid), "ALARM", a)
    event(sid, "warn", f"Queue at {_label(nodes[worst])} (about {round(eta[worst])} s): " +
          ", ".join(f"{_label(nodes[rm])} diverted to {_label(nodes[x2])}" for rm, x2 in moved) +
          f"; simulated clearing time {round(base)} s -> {round(best_t)} s")
    by_room = dict(moved)
    _notify(sid, [p for p in ppl if p.get("room") in by_room], lambda p: {"title": "Use a different exit", "body": f"{_label(nodes[worst])} is crowded. Go to {_label(nodes[by_room[p['room']]])}.", "tag": f"route-{a['id']}", "url": f"/#/go?site={sid}"})
    return a


def _sim_time(site: dict, occ: dict, blocked: set, plan: dict, trapped: list) -> float | None:
    bd = copy.deepcopy(site["building"])
    gone = set(trapped)
    bd["nodes"] = [dict(n, people=occ.get(n["id"], 0)) if n["type"] == "room" else n for n in bd["nodes"] if n["id"] not in gone]
    bd["edges"] = [e for e in bd["edges"] if e["from"] not in gone and e["to"] not in gone]
    try:
        return simulate(load(bd), {r: x for r, x in plan.items() if r not in gone}, blocked, frame_every=1e9)["total_time_s"]
    except Exception:
        return None


def control(sid: str) -> dict:
    site = _site(sid)
    ppl, hz, cams, sens = people(sid), hazards(sid), _cameras(sid), _sensors(sid)
    a = alarm(sid)
    if a:
        a = _divert(sid, site, a, ppl, cams)
    nodes = _nodes(site)
    b = _building(site)
    floors = sorted(site["building"].get("floors") or [], key=lambda f: f.get("elevation_m", 0))
    plan = (a or {}).get("plan", {})
    occ_plan = plan.get("occupancy") or {n["id"]: int(n.get("people", 0)) for n in nodes.values() if n["type"] == "room"}

    def row(p):
        rm = p.get("room")
        r = plan.get("rooms", {}).get(rm or "", {})
        return {"token": hashlib.sha1(p["token"].encode()).hexdigest()[:8], "room": rm, "room_label": _label(nodes[rm]) if rm in nodes else None, "floor": nodes[rm].get("floor_id") if rm in nodes else None,
                "status": p["status"], "need": p.get("need"), "updated_at": p.get("updated_at"), "exit": r.get("exit"), "group": r.get("group"),
                "safe_verified": p.get("safe_verified"), "safe_distance_m": p.get("safe_distance_m"), "push": bool(p.get("push")),
                "phone": sms.mask(p.get("phone")), "phone_verified": bool(p.get("phone_verified")), "sms_last": p.get("sms_last")}
    rows = [row(p) for p in ppl]
    counts = {"checked_in": len(rows), "inside": sum(r["status"] == "inside" for r in rows), "safe": sum(r["status"] == "safe" for r in rows),
              "help": sum(r["status"] == "help" for r in rows), "missing": sum(r["status"] == "inside" for r in rows) if a else 0}
    cam_by_node = {c["node"]: c for c in cams if time.time() - c.get("at", 0) < 120}
    rooms = {}
    for rid, n in nodes.items():
        if n["type"] != "room":
            continue
        here = sum(1 for r in rows if r["room"] == rid and r["status"] != "safe")
        cam = cam_by_node.get(rid, {}).get("people")
        count = cam if cam is not None else here
        area = _area(b, site, rid)
        dens = round(count / area, 2)
        rooms[rid] = {"label": _label(n), "floor": n.get("floor_id"), "people": here, "planned": occ_plan.get(rid, int(n.get("people", 0))),
                      "camera": cam, "area_m2": round(area, 1), "density": dens, "level": _level(dens),
                      "exit": plan.get("rooms", {}).get(rid, {}).get("exit"), "group": plan.get("rooms", {}).get(rid, {}).get("group"),
                      "trapped": rid in plan.get("trapped", [])}
    spots = []
    for c in cam_by_node.values():
        if c.get("people") is not None and nodes.get(c["node"], {}).get("type") != "room":
            area = _area(b, site, c["node"])
            d = round(c["people"] / area, 2)
            spots.append({"node": c["node"], "label": _label(nodes[c["node"]]), "people": c["people"], "area_m2": round(area, 1), "density": d, "level": _level(d)})
    exits = []
    groups = (a or {}).get("groups", {})
    for x in b.exits:
        assigned_rooms = [rm for rm, r in plan.get("rooms", {}).items() if r["exit"] == x]
        planned = sum(occ_plan.get(rm, 0) for rm in assigned_rooms)
        out = sum(1 for r in rows if r["status"] == "safe" and r["exit"] == x)
        exits.append({"id": x, "label": _label(nodes[x]), "group": groups.get(x, {}).get("letter"), "color": groups.get(x, {}).get("color"),
                      "planned": planned, "assigned": sum(1 for r in rows if r["exit"] == x and r["status"] != "safe"), "out": out,
                      "eta_s": round(max(0, planned - out) / _exit_flow(b, x)) if a else None, "rooms": assigned_rooms,
                      "room_labels": [_label(nodes[rm]) for rm in assigned_rooms], "blocked": x in set(plan.get("blocked", [])) or x in _blocked(hz)})
    waves = {}
    for f, w in (a or {}).get("waves", {}).items():
        waves.setdefault(w, []).append(f)
    fl_rows = []
    for f in floors or [{"id": None, "name": "Ground"}]:
        fr = [r for r in rows if r["floor"] == f["id"]]
        fl_rows.append({"id": f["id"], "name": f.get("name", f["id"]), "inside": sum(r["status"] == "inside" for r in fr),
                        "safe": sum(r["status"] == "safe" for r in fr), "help": sum(r["status"] == "help" for r in fr),
                        "wave": (a or {}).get("waves", {}).get(f["id"], 0) if f["id"] else 0})
    ev = [d for _, d in store().query(pk(sid), "EVENT#")][-40:][::-1]
    return {
        "site": {**S.summary(site), "building": site["building"], "assembly": S.assembly_points(site), "geo": site.get("geo")},
        "alarm": {k: v for k, v in a.items() if k not in ("plan",)} | {"time_s": plan.get("time_s"), "method": plan.get("method"), "trapped": plan.get("trapped", [])} if a else None,
        "counts": counts, "floors": fl_rows, "rooms": rooms, "spots": spots,
        "people": rows, "help": [r for r in rows if r["status"] == "help"], "missing": [r for r in rows if a and r["status"] == "inside"],
        "hazards": sorted(hz, key=lambda h: h["at"]), "exits": exits,
        "waves": [{"wave": w, "floors": fs, "release_at": w * (a or {}).get("wave_gap_s", 60)} for w, fs in sorted(waves.items())],
        "sensors": sens, "cameras": list(cam_by_node.values()), "events": ev, "version": (a or {}).get("version", 0),
        "thresholds": {"concern": CONCERN, "crush": CRUSH, "heat_c": HEAT_C},
        "server_time": time.time(),
        "push": {"on": sum(1 for p in ppl if p.get("push")), "total": len(ppl)},
        "sms": {"provider": sms.provider(), "sandbox": sms.sandbox(), "registered": sum(1 for p in ppl if p.get("phone")),
                "verified": sum(1 for p in ppl if p.get("phone_verified")), "sandbox_limit": 10 if sms.sandbox() else None,
                "last": store().get(pk(sid), "SMSLAST")},
    }
