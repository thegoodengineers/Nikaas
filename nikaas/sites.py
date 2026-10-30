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


def delete_site(site_id: str) -> None:
    """Remove a building made or imported here. The demo buildings ship with the code and stay."""
    if site_id in _BUILTIN:
        raise ValueError("the demo buildings cannot be deleted")
    if store().get(PK, site_id) is None:
        raise KeyError(f"unknown site {site_id}")
    store().delete(PK, site_id)


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
    # plan pictures and walls are only written through save_media: keep the stored ones for floors that still exist
    s.pop("media", None)
    old = get_site(s["id"]) if site.get("id") else None
    if old and old.get("media"):
        floors = {f["id"] for f in s["building"].get("floors") or []} or {"_"}
        kept = {f: m for f, m in old["media"].items() if f in floors}
        if kept:
            s["media"] = kept
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


# ---------- plan pictures and traced walls per floor (docs/PLATFORM.md, "Media") ----------
MEDIA_IMAGE_MAX = 4_000_000  # bytes of JPEG/PNG; Lambda requests stop at 6 MB of base64
MEDIA_WALLS_MAX = 250_000  # characters of run-length text per floor (sites live in one DynamoDB item, 400 KB)


def _bucket():
    import os

    return os.environ.get("PHOTO_BUCKET")


def save_media(site_id: str, floor: str, image: str | None = None, plan: dict | None = None, walls: dict | None = None) -> dict:
    """Store a floor's plan picture (base64 or data URL) and/or its traced wall grid with the site."""
    import base64
    import binascii

    s = get_site(site_id)
    if s is None:
        raise KeyError(site_id)
    floors = {f["id"] for f in s["building"].get("floors") or []} or {"_"}
    if floor not in floors:
        raise ValueError(f"unknown floor {floor}")
    media = s.setdefault("media", {})
    m = media.setdefault(floor, {})
    if plan is not None:
        try:
            m["plan"] = {**{k: m.get("plan", {}).get(k) for k in ("key", "data")}, **{k: float(plan[k]) for k in ("x", "z", "w", "h")}}
        except (KeyError, TypeError, ValueError):
            raise ValueError("plan needs x, z, w, h in metres")
    if image is not None:
        head, _, body = image.partition(",") if image.startswith("data:") else ("", "", image)
        try:
            data = base64.b64decode(body, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("image is not base64")
        if len(data) > MEDIA_IMAGE_MAX:
            raise ValueError("image over 4 MB: send a smaller JPEG")
        kind = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg" if data[:3] == b"\xff\xd8\xff" else None
        if kind is None:
            raise ValueError("image must be JPEG or PNG")
        m.setdefault("plan", {})
        if _bucket():
            import boto3

            key = f"sites/{site_id}/{floor}.{'png' if kind == 'png' else 'jpg'}"
            boto3.client("s3").put_object(Bucket=_bucket(), Key=key, Body=data, ContentType=f"image/{kind}")
            m["plan"]["key"], m["plan"]["data"] = key, None
        else:  # local runs: keep the picture inline
            m["plan"]["data"] = f"data:image/{kind};base64,{base64.b64encode(data).decode()}"
    if walls is not None:
        try:
            g = {"res": float(walls["res"]), "x0": float(walls["x0"]), "z0": float(walls["z0"]),
                 "cols": int(walls["cols"]), "rows": int(walls["rows"]), "rle": str(walls["rle"])}
        except (KeyError, TypeError, ValueError):
            raise ValueError("walls need res, x0, z0, cols, rows, rle")
        if not (0.05 <= g["res"] <= 1 and 0 < g["cols"] <= 4000 and 0 < g["rows"] <= 4000):
            raise ValueError("walls grid out of range")
        if len(g["rle"]) > MEDIA_WALLS_MAX:
            raise ValueError("walls grid too detailed: use a coarser resolution")
        try:
            runs = [int(r) for r in g["rle"].split(",")] if g["rle"] else []
        except ValueError:
            raise ValueError("walls rle must be comma-separated counts")
        if any(r < 0 for r in runs) or sum(runs) != g["cols"] * g["rows"]:
            raise ValueError("walls rle does not cover the grid")
        m["walls"] = g
    s["updated_at"] = time.time()
    store().put(PK, s["id"], s)
    return s


def media_public(site: dict) -> dict:
    """Site media for the browser: plan pictures as short-lived links (private bucket) or inline data (local)."""
    out = {}
    for floor, m in (site.get("media") or {}).items():
        fm = {k: v for k, v in m.items() if k != "plan"}
        p = m.get("plan")
        if p and all(p.get(k) is not None for k in ("x", "z", "w", "h")):
            url = p.get("data")
            if not url and p.get("key") and _bucket():
                import boto3

                url = boto3.client("s3").generate_presigned_url("get_object", Params={"Bucket": _bucket(), "Key": p["key"]}, ExpiresIn=12 * 3600)
            fm["plan"] = {"url": url, "x": p["x"], "z": p["z"], "w": p["w"], "h": p["h"]}
        out[floor] = fm
    return out
