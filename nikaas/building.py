"""Building graph: load the shared JSON contract, shortest paths, nearest-exit plan."""
import heapq
import json
import math
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Edge:
    a: str
    b: str
    width: float  # metres of clear width
    length: float  # metres
    kind: str = "corridor"  # corridor | door | stair
    capacity_group: str | None = None

    @property
    def key(self):
        return f"{self.a}-{self.b}"


@dataclass
class Building:
    name: str
    nodes: dict  # id -> node dict (type, x, z, ...)
    edges: list
    adj: dict = field(default_factory=dict)  # id -> [(neighbour, Edge)]
    floors: dict = field(default_factory=dict)  # id -> floor dict (id, name, elevation_m)

    @property
    def rooms(self):
        return [n for n, v in self.nodes.items() if v["type"] == "room"]

    @property
    def exits(self):
        return [n for n, v in self.nodes.items() if v["type"] == "exit"]

    def people(self):
        return {r: int(self.nodes[r].get("people", 0)) for r in self.rooms}

    def floor_of(self, node_id: str) -> str | None:
        return self.nodes.get(node_id, {}).get("floor_id")

    def elevation_of(self, node_id: str) -> float:
        f_id = self.floor_of(node_id)
        if f_id and f_id in self.floors:
            elev = self.floors[f_id].get("elevation_m", 0.0)
            return float(elev) if isinstance(elev, (int, float)) else 0.0
        return 0.0


def validate(d):
    """Check a building dict against docs/CONTRACT.md. Returns a list of human-readable problems (empty = OK).
    Used on anything that did not come from our own files: vision output, editor saves, API calls."""
    if isinstance(d, (str, Path)):
        try:
            d = json.loads(Path(d).read_text(encoding="utf-8-sig"))
        except Exception as err:
            return [f"could not parse building JSON: {err}"]
    probs = []
    if not isinstance(d, dict) or "nodes" not in d or "edges" not in d:
        return ["building must be an object with 'nodes' and 'edges'"]
    ids = [n.get("id") for n in d["nodes"]]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        probs.append(f"duplicate node ids: {sorted(dup)}")
    nodes = {n.get("id"): n for n in d["nodes"]}

    # Floor validations if multi-floor metadata is provided
    floor_ids = set()
    if "floors" in d:
        if not isinstance(d["floors"], list):
            probs.append("building 'floors' must be a list")
        else:
            f_ids = [f.get("id") for f in d["floors"] if isinstance(f, dict)]
            dup_f = {fid for fid in f_ids if f_ids.count(fid) > 1}
            if dup_f:
                probs.append(f"duplicate floor ids: {sorted(dup_f)}")
            for i, f in enumerate(d["floors"]):
                if not isinstance(f, dict):
                    probs.append(f"floor {i}: must be an object")
                    continue
                fid = f.get("id")
                if not fid or not isinstance(fid, str):
                    probs.append(f"floor {i}: must have a non-empty string 'id'")
                else:
                    floor_ids.add(fid)
                if not isinstance(f.get("name"), str):
                    probs.append(f"floor {fid or i}: name must be a string")
                elev = f.get("elevation_m")
                if not (isinstance(elev, (int, float)) and math.isfinite(elev)):
                    probs.append(f"floor {fid or i}: elevation_m must be a finite number")

    for n in d["nodes"]:
        if n.get("type") not in ("room", "corridor", "exit"):
            probs.append(f"node {n.get('id')}: type must be room, corridor or exit")
        if not all(isinstance(n.get(k), (int, float)) for k in ("x", "z")):
            probs.append(f"node {n.get('id')}: x and z must be numbers (metres)")
        if n.get("type") == "room" and not (isinstance(n.get("people", 0), int) and n.get("people", 0) >= 0):
            probs.append(f"room {n.get('id')}: people must be a whole number >= 0")
        if "floors" in d and d["floors"]:
            n_floor = n.get("floor_id")
            if not n_floor or n_floor not in floor_ids:
                probs.append(f"node {n.get('id')}: unknown floor_id '{n_floor}'")

    for i, e in enumerate(d["edges"]):
        for end in ("from", "to"):
            if e.get(end) not in nodes:
                probs.append(f"edge {i}: unknown node '{e.get(end)}'")
        if not (isinstance(e.get("width"), (int, float)) and e["width"] > 0):
            probs.append(f"edge {e.get('from')}-{e.get('to')}: width must be > 0 m")
        if e.get("kind") not in (None, "door", "corridor", "stair"):
            probs.append(f"edge {e.get('from')}-{e.get('to')}: kind must be door, corridor or stair")
        if e.get("length") is not None:
            if not (isinstance(e["length"], (int, float)) and e["length"] > 0 and math.isfinite(e["length"])):
                probs.append(f"edge {e.get('from')}-{e.get('to')}: length must be > 0 m")
        if e.get("capacity_group") is not None:
            if not (isinstance(e["capacity_group"], str) and e["capacity_group"].strip()):
                probs.append(f"edge {e.get('from')}-{e.get('to')}: capacity_group must be a non-empty string")
            elif e.get("kind") != "stair":
                probs.append(f"edge {e.get('from')}-{e.get('to')}: only stair edges may belong to a capacity_group")

        # Multi-floor edge rules
        if "floors" in d and d["floors"] and e.get("from") in nodes and e.get("to") in nodes:
            f_from = nodes[e["from"]].get("floor_id")
            f_to = nodes[e["to"]].get("floor_id")
            if f_from and f_to and f_from != f_to:
                if e.get("kind") != "stair":
                    probs.append(f"cross-floor edge {e.get('from')}-{e.get('to')} between {f_from} and {f_to} must have kind 'stair'")
                if e.get("length") is None:
                    probs.append(f"cross-floor stair edge {e.get('from')}-{e.get('to')} must specify explicit positive 'length'")

    # Check capacity group continuity
    cap_groups = {}
    for e in d["edges"]:
        cg = e.get("capacity_group")
        if cg and isinstance(cg, str) and cg.strip():
            cap_groups.setdefault(cg.strip(), []).append(e)

    for cg, g_edges in cap_groups.items():
        if len(g_edges) > 1:
            cg_adj = {}
            for e in g_edges:
                u, v = e.get("from"), e.get("to")
                if u in nodes and v in nodes:
                    cg_adj.setdefault(u, set()).add(v)
                    cg_adj.setdefault(v, set()).add(u)
            visited = set()
            start_n = next(iter(cg_adj), None)
            if start_n:
                q = [start_n]
                visited.add(start_n)
                while q:
                    curr = q.pop(0)
                    for nb in cg_adj.get(curr, ()):
                        if nb not in visited:
                            visited.add(nb)
                            q.append(nb)
                if len(visited) < len(cg_adj):
                    probs.append(f"capacity group '{cg}': edges are disconnected and do not form a contiguous shaft")

    if not any(n.get("type") == "exit" for n in d["nodes"]):
        probs.append("building has no exit")
    if probs:
        return probs
    b = load(d)
    for r in b.rooms:
        if not any(shortest_path(b, r, x)[1] for x in b.exits):
            probs.append(f"room {r} cannot reach any exit")
    return probs


def load(src):
    """src: path or already-parsed dict in the contract format (see docs/CONTRACT.md)."""
    # utf-8-sig tolerates a BOM written by some Windows editors
    d = json.loads(Path(src).read_text(encoding="utf-8-sig")) if not isinstance(src, dict) else src
    nodes = {n["id"]: n for n in d["nodes"]}
    floors_list = d.get("floors", [])
    floors = {f["id"]: f for f in floors_list} if isinstance(floors_list, list) and all(isinstance(f, dict) for f in floors_list) else {}
    edges, adj = [], {n: [] for n in nodes}
    for e in d["edges"]:
        a, b = nodes[e["from"]], nodes[e["to"]]
        length = e.get("length")
        if length is None:
            length = math.hypot(a["x"] - b["x"], a["z"] - b["z"])
        kind = e.get("kind") or ("door" if "room" in (a["type"], b["type"]) else "corridor")
        cap_group = e.get("capacity_group")
        ed = Edge(e["from"], e["to"], float(e["width"]), float(length), kind, cap_group)
        edges.append(ed)
        adj[ed.a].append((ed.b, ed))
        adj[ed.b].append((ed.a, ed))
    return Building(d.get("name", "building"), nodes, edges, adj, floors)


def shortest_path(b, src, dst, blocked=()):
    """Dijkstra on edge length. Returns (distance, [node ids]) or (inf, []) if unreachable."""
    dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst:
            break
        if d > dist.get(u, math.inf):
            continue
        for v, e in b.adj[u]:
            if v in blocked:
                continue
            nd = d + e.length
            if nd < dist.get(v, math.inf):
                dist[v], prev[v] = nd, u
                heapq.heappush(pq, (nd, v))
    if dst not in dist:
        return math.inf, []
    path, n = [dst], dst
    while n != src:
        n = prev[n]
        path.append(n)
    return dist[dst], path[::-1]


def nearest_plan(b, blocked=()):
    """Today's rule: every room goes to its closest open exit."""
    plan = {}
    for r in b.rooms:
        best = min(((shortest_path(b, r, x, blocked)[0], x) for x in b.exits if x not in blocked), default=(math.inf, None))
        if best[1] is None:
            raise ValueError(f"room {r} has no reachable open exit")
        plan[r] = best[1]
    return plan
