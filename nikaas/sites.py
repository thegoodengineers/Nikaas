"""Sites: a building graph plus where it is on the map and where people gather outside (docs/PLATFORM.md).

Demo sites ship in nikaas/sites_data/; sites made in the control room (or edited demo sites, e.g. after
setting their map location) are kept in the store and win over the shipped copy.
"""
import copy
import json
import math
import re
import time
from pathlib import Path

from .building import validate
from .store import store

DATA = Path(__file__).resolve().parent / "sites_data"
PK = "SITES"


def _builtin() -> dict[str, dict]:
    out = {}
    for f in sorted(DATA.glob("*.json")):
        s = json.loads(f.read_text(encoding="utf-8"))
        out[s["id"]] = s
    return out


_BUILTIN = _builtin()


def get_site(site_id: str) -> dict | None:
    s = store().get(PK, site_id)
    if s is None and site_id in _BUILTIN:
        s = copy.deepcopy(_BUILTIN[site_id])
    return s


def list_sites() -> list[dict]:
    ids = list(_BUILTIN) + [sk for sk, _ in store().query(PK) if sk not in _BUILTIN]
    return [summary(get_site(i)) for i in ids]


def summary(s: dict) -> dict:
    b = s["building"]
    nodes = b["nodes"]
    return {
        "id": s["id"], "name": s["name"], "address": s.get("address", ""), "demo": bool(s.get("demo")),
        "floors": len(b.get("floors") or []) or 1,
        "rooms": sum(1 for n in nodes if n["type"] == "room"),
        "exits": sum(1 for n in nodes if n["type"] == "exit"),
        "people": sum(int(n.get("people", 0)) for n in nodes if n["type"] == "room"),
        "geo": s.get("geo"),
    }


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40]
    return s or "site"


def save_site(site: dict) -> dict:
    if not isinstance(site.get("building"), dict):
        raise ValueError("site needs a building")
    probs = validate(site["building"])
    if probs:
        raise ValueError("; ".join(probs[:5]))
    s = copy.deepcopy(site)
    s["name"] = (s.get("name") or s["building"].get("name") or "Untitled building").strip()[:120]
    if not s.get("id"):
        base, n = slug(s["name"]), 1
        s["id"] = base
        while get_site(s["id"]) is not None:
            n += 1
            s["id"] = f"{base}-{n}"
    elif not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", s["id"]):
        raise ValueError("site id: lowercase letters, digits and dashes")
    exits = {n["id"] for n in s["building"]["nodes"] if n["type"] == "exit"}
    if not s.get("assembly"):
        s["assembly"] = default_assembly(s["building"])
    for a in s["assembly"]:
        a["exits"] = [e for e in a.get("exits", []) if e in exits]
    s.setdefault("geo", None)
    s["updated_at"] = time.time()
    store().put(PK, s["id"], s)
    return s


def default_assembly(b: dict) -> list[dict]:
    """One assembly point 25 m outside each exit, away from the building's centre."""
    nodes = b["nodes"]
    cx = sum(n["x"] for n in nodes) / len(nodes)
    cz = sum(n["z"] for n in nodes) / len(nodes)
    out = []
    for i, n in enumerate(n for n in nodes if n["type"] == "exit"):
        dx, dz = n["x"] - cx, n["z"] - cz
        d = math.hypot(dx, dz) or 1
        out.append({"id": f"A{i + 1}", "label": f"Assembly {chr(65 + i)} · outside {n.get('label', n['id'])}",
                    "x": round(n["x"] + dx / d * 25, 1), "z": round(n["z"] + dz / d * 25, 1),
                    "exits": [n["id"]], "lat": None, "lng": None})
    return out


def set_geo(site_id: str, geo: dict | None = None, assembly: list | None = None) -> dict:
    s = get_site(site_id)
    if s is None:
        raise KeyError(site_id)
    if geo is not None:
        lat, lng = float(geo["lat"]), float(geo["lng"])
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            raise ValueError("lat/lng out of range")
        s["geo"] = {"lat": lat, "lng": lng, "rotation_deg": float(geo.get("rotation_deg", 0) or 0)}
    if assembly is not None:
        by_id = {a["id"]: a for a in s["assembly"]}
        for a in assembly:
            if a.get("id") in by_id:
                for k in ("label", "lat", "lng", "x", "z", "exits"):
                    if k in a:
                        by_id[a["id"]][k] = a[k]
    s["updated_at"] = time.time()
    store().put(PK, s["id"], s)
    return s


def latlng(site: dict, x: float, z: float) -> tuple[float, float] | None:
    """Building metres -> map position, from the site's origin and rotation (+x east, +z south at 0 deg)."""
    g = site.get("geo")
    if not g:
        return None
    r = math.radians(g.get("rotation_deg", 0) or 0)
    east = x * math.cos(r) + z * math.sin(r)
    north = x * math.sin(r) - z * math.cos(r)
    lat = g["lat"] + north / 111_320
    lng = g["lng"] + east / (111_320 * math.cos(math.radians(g["lat"])))
    return round(lat, 7), round(lng, 7)


def assembly_points(site: dict) -> list[dict]:
    out = []
    for a in site.get("assembly", []):
        a = dict(a)
        if a.get("lat") is None or a.get("lng") is None:
            p = latlng(site, a["x"], a["z"])
            a["lat"], a["lng"] = p if p else (None, None)
        out.append(a)
    return out


def assembly_for_exit(site: dict, exit_id: str) -> dict | None:
    pts = assembly_points(site)
    for a in pts:
        if exit_id in a.get("exits", []):
            return a
    if not pts:
        return None
    ex = next((n for n in site["building"]["nodes"] if n["id"] == exit_id), None)
    if ex is None:
        return pts[0]
    return min(pts, key=lambda a: math.hypot(a["x"] - ex["x"], a["z"] - ex["z"]))


def haversine_m(lat1, lng1, lat2, lng2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


# ---------- stairs across floors ----------
def _is_stair(n: dict) -> bool:
    if n.get("type") == "room" or n.get("type") == "exit":
        return False
    return bool(n.get("stair")) or "stair" in (n.get("id", "") + " " + n.get("label", "")).lower()


def link_floors(building: dict, tolerance_m: float = 4.0) -> tuple[dict, list[dict]]:
    """Connect stair landings that sit above each other on consecutive floors with stair edges.

    Landings are nodes marked `stair: true` (or named "stair"). Each landing is joined to the nearest landing
    on the next floor up within `tolerance_m` (floor plans drawn from photos rarely line up exactly). Joined
    landings form one shaft and share a capacity_group, so the simulator queues them as one stairwell."""
    b = copy.deepcopy(building)
    floors = sorted(b.get("floors") or [], key=lambda f: f.get("elevation_m", 0))
    if len(floors) < 2:
        return b, []
    nodes = b["nodes"]
    by_floor = {f["id"]: [n for n in nodes if n.get("floor_id") == f["id"] and _is_stair(n)] for f in floors}
    have = {frozenset((e["from"], e["to"])) for e in b["edges"]}
    group_of: dict[str, str] = {}
    for e in b["edges"]:
        if e.get("kind") == "stair" and e.get("capacity_group"):
            group_of[e["from"]] = group_of[e["to"]] = e["capacity_group"]
    links, next_group = [], 1
    for lower, upper in zip(floors, floors[1:]):
        rise = max(0.5, upper.get("elevation_m", 0) - lower.get("elevation_m", 0))
        taken = set()
        for a in by_floor[lower["id"]]:
            cands = [(math.hypot(a["x"] - u["x"], a["z"] - u["z"]), u["id"], u) for u in by_floor[upper["id"]] if u["id"] not in taken]
            cands = [c for c in cands if c[0] <= tolerance_m]
            if not cands:
                continue
            d, _, u = min(cands)
            taken.add(u["id"])
            if frozenset((a["id"], u["id"])) in have:
                continue
            g = group_of.get(a["id"]) or group_of.get(u["id"])
            if not g:
                while f"stair_{next_group}" in group_of.values():
                    next_group += 1
                g = f"stair_{next_group}"
                next_group += 1
            group_of[a["id"]] = group_of[u["id"]] = g
            width = float(a.get("width") or u.get("width") or 1.2)
            # walking length on the flights: about 1.85 m of stair per metre of rise, plus any horizontal offset
            e = {"from": u["id"], "to": a["id"], "width": width, "length": round(d + rise * 1.85, 2), "kind": "stair", "capacity_group": g}
            b["edges"].append(e)
            have.add(frozenset((a["id"], u["id"])))
            links.append({"from": u["id"], "to": a["id"], "group": g})
    return b, links
