"""Photo of a floor plan -> building graph (docs/CONTRACT.md), using Amazon Bedrock (Amazon Nova).

The model marks rooms as boxes and walkway/exit points on a 0-1000 grid over the photo (the grounding
format Nova is trained on). We turn that into metres ourselves: the drawn building is scaled so its
east-west extent equals `width_m`, the building's real length. Occupancy comes from room area and use
(people per m², see DENSITY) rather than the model's guess, so it is consistent and easy to explain.
Every result goes through `building.validate`; if it has problems we send them back to the model once.

    from nikaas.vision import read_map
    building, problems = read_map(open("plan.jpg", "rb").read(), "jpeg", width_m=80)
"""
import json
import math
import os
import re
import struct
from concurrent.futures import ThreadPoolExecutor

from .building import validate
from .graph_qa import analyze_graph

MODEL_ID = os.environ.get("BEDROCK_MODEL", "us.amazon.nova-pro-v1:0")
REGION = os.environ.get("BEDROCK_REGION", "us-east-1")

# people per m² of floor on a busy day, by room use
DENSITY = {"seated_hall": 1.5, "classroom": 1.0, "lab": 0.5, "gallery": 0.3, "lobby": 0.3, "study": 0.5,
           "office": 0.15, "washroom": 0.3, "store": 0.05, "other": 0.3}

PROMPT = """You are digitising a building floor plan (a photo of an evacuation map or a floor-plan panel) into a graph
for an evacuation simulator.

Coordinates: use a 0-1000 grid over the WHOLE PHOTO: x from 0 (left edge of the photo) to 1000 (right edge),
y from 0 (top edge of the photo) to 1000 (bottom edge). Boxes are [x1, y1, x2, y2].

Only the drawn plan counts. Ignore the title box, legends, logos, sponsor text and anything outside the walls.

Return ONLY one JSON object, no other text:
{
  "rooms": [{"id": "short_snake_case", "label": "name exactly as printed", "use": "gallery", "box": [x1, y1, x2, y2]}],
  "points": [{"id": "p1", "at": [x, y]}, {"id": "stair_a", "at": [x, y], "stair": true, "label": "Stair A"}],
  "exits": [{"id": "EXIT_MAIN", "label": "what it is", "at": [x, y]}],
  "links": [{"from": "id", "to": "id", "width": 1.2, "kind": "door"}]
}

- rooms: EVERY enclosed room, gallery or hall with walls, including small ones (study, washroom, guest room,
  store). The box must hug that room's walls tightly; rooms have different sizes, measure each one.
  "use" is one of: seated_hall, classroom, lab, gallery, lobby, study, office, washroom, store, other.
- points: walkway points along corridors/passages/verandahs, at every junction and in front of every room door,
  about every 5-10% of the photo width along long passages.
- stair landings: for every staircase drawn INSIDE the building that leads to another floor, add one point
  with "stair": true where people step onto the stairs (inside the stairwell), and link it to the nearest
  walkway point. These are not exits; stacked floors are joined through them.
- exits: every place people can leave the building: main entrance, outside doors, gaps in the outer wall
  that lead outside, steps drawn outside the walls, doors onto a verandah or courtyard. Look along the
  whole outer wall; most buildings have 2 or more.
- links: room->point "door" links for each doorway (a room with two doors gets two links), point->point
  "corridor" links following the real walkways, exit->point "door" links ("stair" for steps), and
  room->room "door" links through shared doorways. width = clear width in METRES: door 0.9-1.5,
  double door 1.8-2.4, corridor 1.8-3.
- Every room must reach an exit through links. Every id in a link must exist."""


EXITS_PROMPT = """This is a photo of a building floor plan. Find ONLY the exits: every place where people can leave the
building to the outside. Look slowly along the entire outer wall of the drawn building and check:
- the main entrance (often near a reception or lobby), and any other entrances
- doors in the outer wall, gaps in the outer wall that lead outside, doors onto a verandah or courtyard
- steps or stairs drawn just outside the walls, ramps, fire escapes
- EXIT signs, green running-man symbols, arrows that point out of the building
Ignore the title box, legend and logos. Do not invent exits that are not drawn.

Coordinates: a 0-1000 grid over the WHOLE PHOTO (x 0 = left edge, 1000 = right edge; y 0 = top, 1000 = bottom).
Give the point in the doorway itself.

Return ONLY JSON: {"exits": [{"label": "what it is", "at": [x, y], "kind": "door", "width": 1.5}]}
kind is "door" or "stair"; width is the clear width in metres (door 0.9-1.5, double door 1.8-2.4)."""

def image_size(b):
    """(width, height) in pixels from PNG or JPEG bytes, or None if unknown."""
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", b[16:24])
    if b[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(b):
            if b[i] != 0xFF:
                i += 1
                continue
            marker = b[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", b[i + 5:i + 9])
                return w, h
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            i += 2 + struct.unpack(">H", b[i + 2:i + 4])[0]
    return None


def _extract_json(text):
    """Pull the first JSON object out of a model reply (handles ```json fences and chatter around it)."""
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    raw = m.group(1) if m else text[text.find("{"): text.rfind("}") + 1]
    return json.loads(raw)


def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def to_building(g, width_m, size=None):
    """Model reply (0-1000 photo grid) -> contract building in metres.
    size = (photo width, photo height) in px, so a square on the photo stays square in metres."""
    ax, ay = (1.0, size[1] / size[0]) if size else (1.0, 1.0)  # grid unit -> common unit per axis
    rooms, pts = [], []
    for r in g.get("rooms", []):
        bx = [_num(v) for v in (r.get("box") or [])]
        if len(bx) == 4 and None not in bx:
            x1, x2 = sorted((bx[0] * ax, bx[2] * ax))
            y1, y2 = sorted((bx[1] * ay, bx[3] * ay))
            rooms.append((r, x1, y1, x2, y2))
    for kind, items in (("corridor", g.get("points", [])), ("exit", g.get("exits", []))):
        for p in items:
            at = [_num(v) for v in (p.get("at") or [])]
            if len(at) == 2 and None not in at:
                pts.append((kind, p, at[0] * ax, at[1] * ay))
    # building extent (sets the scale) from rooms and walkways only: exits can sit outside the walls
    inner = [(x, y) for kind, _, x, y in pts if kind == "corridor"]
    xs = [v for _, x1, _, x2, _ in rooms for v in (x1, x2)] + [x for x, _ in inner]
    zs = [v for _, _, y1, _, y2 in rooms for v in (y1, y2)] + [y for _, y in inner]
    if not xs:  # nothing but exits: fall back to them
        xs, zs = [x for *_, x, _ in pts], [y for *_, y in pts]
    if not xs:
        return {"nodes": [], "edges": []}
    x0, z0 = min(xs), min(zs)
    k = width_m / max(1e-9, max(xs) - x0)  # metres per unit: drawn building width = width_m

    nodes = []
    for r, x1, y1, x2, y2 in rooms:
        w, d = (x2 - x1) * k, (y2 - y1) * k
        use = r.get("use") if r.get("use") in DENSITY else "other"
        nodes.append({"id": str(r.get("id")), "type": "room", "label": r.get("label") or r.get("id"), "use": use,
                      "x": round((x1 + x2) / 2 * k - x0 * k, 1), "z": round((y1 + y2) / 2 * k - z0 * k, 1),
                      "w": round(w, 1), "d": round(d, 1), "people": max(1, int(round(w * d * DENSITY[use])))})
    for kind, p, x, y in pts:
        n = {"id": str(p.get("id")), "type": kind, "x": round((x - x0) * k, 1), "z": round((y - z0) * k, 1)}
        if kind == "exit":
            n["label"] = p.get("label") or p.get("id")
        elif p.get("stair") is True or str(p.get("stair")).lower() == "true":
            n["stair"] = True  # a stair landing: sites.link_floors joins it to the floor above
            n["label"] = p.get("label") or "Stair"
        nodes.append(n)
    edges = []
    for e in g.get("links", []):
        ed = {"from": str(e.get("from")), "to": str(e.get("to")), "width": _num(e.get("width"), 1.0)}
        if e.get("kind") in ("door", "corridor", "stair"):
            ed["kind"] = e["kind"]
        ed["inferred"] = bool(e.get("inferred", False))
        ed["source"] = str(e.get("source", "model"))
        edges.append(ed)
    # where the whole photo sits in building metres [left, top, width, height], so an editor can draw the
    # photo under the graph (top-left of the photo is grid 0,0)
    photo_m = [round(-x0 * k, 2), round(-z0 * k, 2), round(1000 * ax * k, 2), round(1000 * ay * k, 2)]
    return {"nodes": nodes, "edges": edges, "photo_m": photo_m}


def _client(region):
    import boto3  # Lambda has boto3 built in; locally: pip install boto3

    return boto3.client("bedrock-runtime", region_name=region)


def _ask(client, model_id, messages):
    r = client.converse(modelId=model_id, messages=messages,
                        inferenceConfig={"maxTokens": 10000, "temperature": 0})
    return r["output"]["message"]["content"][0]["text"], r.get("usage", {})


def merge_exits(g, found, min_gap=30):
    """Add exits from the exits-only pass to the main reply `g` (both on the 0-1000 photo grid).
    Skips any within `min_gap` grid units of an exit we already have, and links each new exit to the nearest
    walkway point. Returns the labels of the exits it added."""
    have = [p["at"] for p in g.setdefault("exits", []) if len(p.get("at") or []) == 2]
    pts = [p for p in g.get("points", []) if len(p.get("at") or []) == 2]
    added = []
    for i, x in enumerate(found.get("exits", []), 1):
        at = [_num(v) for v in (x.get("at") or [])]
        if len(at) != 2 or None in at or any(math.dist(at, h) < min_gap for h in have):
            continue
        eid = f"EXIT_{i}"
        while any(p.get("id") == eid for p in g["exits"]):
            eid += "x"
        g["exits"].append({"id": eid, "label": x.get("label") or "exit", "at": at})
        have.append(at)
        if pts:
            near = min(pts, key=lambda p: math.dist(at, p["at"]))
            g.setdefault("links", []).append({"from": eid, "to": near["id"], "width": _num(x.get("width"), 1.5),
                                              "kind": "stair" if x.get("kind") == "stair" else "door",
                                              "inferred": True, "source": "merge_exits"})
        added.append(x.get("label") or eid)
    return added


def connect(b):
    """Make sure every room and exit is joined up: drop links to unknown ids, give unlinked rooms/exits a door to
    the nearest walkway point, then join separate pieces of the graph at their closest points.
    Returns the links it added as "a-b" strings, so a person can check them in the editor."""
    nodes = {n["id"]: n for n in b["nodes"]}
    b["edges"] = [e for e in b["edges"] if e["from"] in nodes and e["to"] in nodes and e["from"] != e["to"]]
    added = []

    def dist(a, c):
        return math.hypot(nodes[a]["x"] - nodes[c]["x"], nodes[a]["z"] - nodes[c]["z"])

    def link(a, c, width, kind):
        b["edges"].append({"from": a, "to": c, "width": width, "kind": kind,
                           "inferred": True, "source": "auto_connect"})
        added.append(f"{a}-{c}")

    walk = [i for i, n in nodes.items() if n["type"] == "corridor"]
    linked = {e[k] for e in b["edges"] for k in ("from", "to")}
    for i, n in nodes.items():
        if n["type"] in ("room", "exit") and i not in linked and walk:
            link(i, min(walk, key=lambda c: dist(i, c)), 1.2 if n["type"] == "room" else 1.5, "door")

    parent = {i: i for i in nodes}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for e in b["edges"]:
        parent[find(e["from"])] = find(e["to"])
    while True:
        groups = {}
        for i in nodes:
            groups.setdefault(find(i), []).append(i)
        if len(groups) < 2:
            break
        # join the closest pair of nodes in different pieces, preferring walkway points
        best = None
        for g1 in groups.values():
            for g2 in groups.values():
                if g1 is g2:
                    continue
                for a in g1:
                    for c in g2:
                        pa = 0 if nodes[a]["type"] == "corridor" else 5.0
                        pc = 0 if nodes[c]["type"] == "corridor" else 5.0
                        d = dist(a, c) + pa + pc
                        if best is None or d < best[0]:
                            best = (d, a, c)
        _, a, c = best
        kind = "corridor" if nodes[a]["type"] == nodes[c]["type"] == "corridor" else "door"
        link(a, c, 2.0 if kind == "corridor" else 1.2, kind)
        parent[find(a)] = find(c)
    return added


def read_map(image, fmt="jpeg", width_m=80.0, name="building from photo", model_id=None, region=None,
             client=None, repair=False, exits_pass=True):
    """image: bytes of a png/jpeg/webp photo. width_m: the building's real east-west length in metres.
    Two Bedrock calls run at the same time (about 15-20 s total): the full plan, and an exits-only look that
    catches exits the first one misses. `connect` then fixes any gaps in the walkways. repair=True sends the
    validator's problems back to the model for one more try (slower; usually not needed).
    Returns (building dict in the contract format, list of validation problems; empty = OK).
    The dict also carries `vision` metadata: model, token usage, exits added, links added by `connect`."""
    model_id = model_id or MODEL_ID
    client = client or _client(region or REGION)
    size = image_size(image)
    img = {"image": {"format": fmt, "source": {"bytes": image}}}
    messages = [{"role": "user", "content": [img, {"text": PROMPT}]}]
    usage, calls = {"inputTokens": 0, "outputTokens": 0}, 0

    def tally(u):
        for key in usage:
            usage[key] += u.get(key, 0)

    pool = ThreadPoolExecutor(max_workers=1)
    exits_job = (pool.submit(_ask, client, model_id, [{"role": "user", "content": [img, {"text": EXITS_PROMPT}]}])
                 if exits_pass else None)
    g, building, probs = None, None, ["model returned no JSON"]
    for _ in range(2 if repair else 1):
        calls += 1
        text, u = _ask(client, model_id, messages)
        tally(u)
        try:
            g = _extract_json(text)
            building = to_building(g, width_m, size)
            probs = validate(building)
        except (ValueError, TypeError, AttributeError) as e:
            probs = [f"model reply was not valid JSON: {e}"]
        if not probs:
            break
        messages += [{"role": "assistant", "content": [{"text": text}]},
                     {"role": "user", "content": [{"text": "The graph has these problems:\n- " + "\n- ".join(probs)
                                                   + "\nFix them and return the full corrected JSON only, same format."}]}]
    new_exits = []
    if exits_job is not None:
        calls += 1
        try:
            text, u = exits_job.result()
            tally(u)
            if isinstance(g, dict):
                new_exits = merge_exits(g, _extract_json(text))
                building = to_building(g, width_m, size)
        except Exception:  # the exits pass is a bonus; never lose the main result because of it
            pass
    pool.shutdown(wait=False)
    added = []
    if building is not None and any(n["type"] == "exit" for n in building["nodes"]):
        added = connect(building)
        probs = validate(building)
    building = building or {"nodes": [], "edges": []}
    photo_m = building.pop("photo_m", None)
    qa_report = analyze_graph(building)
    building.update(name=name, units="m", vision={"model": model_id, "width_m": width_m, "calls": calls,
                                                  "usage": usage, "exits_added": new_exits, "auto_links": added,
                                                  "photo_px": list(size) if size else None, "photo_m": photo_m,
                                                  "stairs": [n["id"] for n in building["nodes"] if n.get("stair")],
                                                  "qa": qa_report})
    return building, probs
