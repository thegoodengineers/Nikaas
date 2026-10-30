"""Crowd density analysis — crush-risk detection.

Computes people per m² on each corridor/door edge over time from a simulate() result.
Thresholds from docs/CROWD_RESEARCH.md: our cautious flags, set below G. Keith Still's published 5 p/m² "Maximum".
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field


CRUSH_THRESHOLD = 4.0    # p/m²  — our cautious early-warning flag, below G.K. Still's 5 p/m² "Maximum" (gkstill.com)
CONCERN_THRESHOLD = 2.7  # p/m²  — LoS E boundary; UK Green Guide cap for stadia
PHYSICAL_CAP = 10.0      # p/m²  — absolute physical maximum for standing humans; clamped because
                          #         the simulator stacks queuing people at grid nodes, not spread physically


def _edge_area(edge_id: str, building: dict) -> float:
    """Return the floor area (m²) of an edge: length × effective width.

    effective_width = clear_width − 2 × boundary_layer
    Boundary layers (SFPE): door 0.152 m, corridor 0.20 m, stair 0.15 m.
    Falls back to clear_width when kind is unknown.
    """
    nodes = {n["id"]: n for n in building["nodes"]}
    edge = None
    for e in building["edges"]:
        if f"{e['from']}-{e['to']}" == edge_id or f"{e['to']}-{e['from']}" == edge_id:
            edge = e
            break
    if edge is None:
        return 1.0  # unknown edge: 1 m² avoids division-by-zero

    from_node = nodes.get(edge["from"], {})
    to_node = nodes.get(edge["to"], {})
    # doors connect a room to a non-room; corridors connect non-rooms
    if from_node.get("type") == "room" or to_node.get("type") == "room":
        kind = edge.get("kind", "door")
    else:
        kind = edge.get("kind", "corridor")

    boundary = {"door": 0.152, "corridor": 0.20, "stair": 0.15}.get(kind, 0.15)
    eff_width = max(0.3, edge["width"] - 2 * boundary)

    if "length" in edge:
        length = edge["length"]
    else:
        fn, tn = nodes.get(edge["from"]), nodes.get(edge["to"])
        if fn and tn:
            length = math.hypot(fn["x"] - tn["x"], fn["z"] - tn["z"])
        else:
            length = 1.0

    return max(0.1, eff_width * length)


def _in_any_room(px: float, pz: float, nodes: dict) -> bool:
    """Return True if (px, pz) lies inside any room's bounding rectangle."""
    for n in nodes.values():
        if n.get("type") != "room":
            continue
        hw = n.get("w", 0) / 2
        hd = n.get("d", 0) / 2
        rx, rz = n.get("x", 0), n.get("z", 0)
        if rx - hw <= px <= rx + hw and rz - hd <= pz <= rz + hd:
            return True
    return False


def _point_to_segment_dist(px: float, pz: float, ax: float, az: float, bx: float, bz: float) -> float:
    """Minimum distance from point (px, pz) to segment (ax,az)-(bx,bz)."""
    dx, dz = bx - ax, bz - az
    seg_len2 = dx * dx + dz * dz
    if seg_len2 == 0.0:
        return math.hypot(px - ax, pz - az)
    t = max(0.0, min(1.0, ((px - ax) * dx + (pz - az) * dz) / seg_len2))
    return math.hypot(px - (ax + t * dx), pz - (az + t * dz))


@dataclass
class EdgeDensityRecord:
    edge_id: str
    peak_density: float       # p/m² peak over all frames
    peak_time: float          # t (s) when peak occurred
    crush_risk: list = field(default_factory=list)   # [{t, density, level}]


def analyse(sim_result: dict, building: dict) -> dict:
    """Compute crowd density from a simulate() result.

    Parameters
    ----------
    sim_result : dict   Output of POST /simulate (with "frames").
    building   : dict   The building JSON passed to /simulate.

    Returns
    -------
    dict with:
      "edge_density"  : {edge_id: {"area_m2", "peak_density", "peak_t"}}
      "crush_risk"    : list of {edge_id, t, density, level}  sorted by t then density desc
      "max_density"   : float  — highest single density seen anywhere at any frame
      "worst_edge"    : str    — edge_id with highest peak density
      "first_crush_t" : float | None  — earliest t (s) any edge exceeds CRUSH_THRESHOLD
      "thresholds"    : {"concern": float, "crush": float}
    """
    frames = sim_result.get("frames", [])
    nodes = {n["id"]: n for n in building["nodes"]}

    # Build area cache and segment endpoints for all edges
    area_cache: dict[str, float] = {}
    seg_cache: dict[str, tuple] = {}   # edge_id -> (ax, az, bx, bz)
    for e in building["edges"]:
        eid = f"{e['from']}-{e['to']}"
        area_cache[eid] = _edge_area(eid, building)
        fn = nodes.get(e["from"])
        tn = nodes.get(e["to"])
        if fn and tn:
            seg_cache[eid] = (fn["x"], fn["z"], tn["x"], tn["z"])
        else:
            seg_cache[eid] = (0.0, 0.0, 0.0, 0.0)

    # Per-frame density per edge — assign each moving person to nearest edge by
    # perpendicular distance to the edge segment (more accurate than midpoint distance)
    per_edge: dict[str, list[float]] = {eid: [] for eid in area_cache}
    frame_times: list[float] = []

    for frame in frames:
        t = frame["t"]
        frame_times.append(t)
        counts: dict[str, int] = {eid: 0 for eid in area_cache}
        for (px, pz, st) in frame["people"]:
            if st in ("out", "inside"):
                continue
            # skip people who are still geometrically inside a room (e.g. queuing before the door)
            if _in_any_room(px, pz, nodes):
                continue
            best_eid, best_d = None, float("inf")
            for eid, (ax, az, bx, bz) in seg_cache.items():
                d = _point_to_segment_dist(px, pz, ax, az, bx, bz)
                if d < best_d:
                    best_d = d
                    best_eid = eid
            if best_eid:
                counts[best_eid] += 1
        for eid in counts:
            area = area_cache.get(eid, 1.0)
            per_edge[eid].append(counts[eid] / area)

    # Aggregate
    crush_risk: list[dict] = []
    edge_density: dict[str, dict] = {}
    max_density = 0.0
    worst_edge = ""
    first_crush_t: float | None = None

    for eid, densities in per_edge.items():
        if not densities:
            continue
        peak = min(max(densities), PHYSICAL_CAP)
        peak_t = frame_times[densities.index(max(densities))] if frame_times else 0.0
        area = area_cache.get(eid, 1.0)
        edge_density[eid] = {
            "area_m2": round(area, 2),
            "peak_density": round(peak, 2),
            "peak_t": peak_t,
        }
        if peak > max_density:
            max_density = peak
            worst_edge = eid
        for i, d in enumerate(densities):
            d = min(d, PHYSICAL_CAP)
            if d >= CRUSH_THRESHOLD:
                entry_t = frame_times[i]
                crush_risk.append({"edge_id": eid, "t": entry_t, "density": round(d, 2), "level": "crush"})
                if first_crush_t is None or entry_t < first_crush_t:
                    first_crush_t = entry_t
            elif d >= CONCERN_THRESHOLD:
                crush_risk.append({"edge_id": eid, "t": frame_times[i], "density": round(d, 2), "level": "concern"})

    crush_risk.sort(key=lambda x: (x["t"], -x["density"]))

    return {
        "edge_density": edge_density,
        "crush_risk": crush_risk,
        "max_density": round(max_density, 2),
        "worst_edge": worst_edge,
        "first_crush_t": first_crush_t,
        "thresholds": {
            "concern": CONCERN_THRESHOLD,
            "crush": CRUSH_THRESHOLD,
        },
    }


def narrative(crowd_result: dict, building_name: str = "") -> str:
    """Return a one-paragraph plain-English summary of the crowd density result.

    Intended for the pitch and for judge Q&A.  All numbers come from crowd_result —
    nothing is typed in.
    """
    n = building_name or "this building"
    worst = crowd_result.get("worst_edge", "")
    max_d = crowd_result.get("max_density", 0.0)
    first_t = crowd_result.get("first_crush_t")
    crush = [e for e in crowd_result.get("crush_risk", []) if e["level"] == "crush"]
    concern = [e for e in crowd_result.get("crush_risk", []) if e["level"] == "concern"]

    if max_d < CONCERN_THRESHOLD:
        return (
            f"In {n}, peak crowd density is {max_d:.1f} p/m² — below the concern "
            f"threshold of {CONCERN_THRESHOLD} p/m²."
        )

    lines = [
        f"In {n}, peak crowd density reaches {max_d:.1f} p/m² on edge '{worst}'."
    ]
    if first_t is not None:
        lines.append(
            f"Our crush warning ({CRUSH_THRESHOLD} p/m², set below G. Keith Still's 5 p/m² maximum) is first "
            f"exceeded at t = {first_t:.0f} s."
        )
    if crush:
        edges = sorted({e["edge_id"] for e in crush})
        lines.append(
            f"{len(crush)} frame(s) across {len(edges)} edge(s) exceed the crush threshold: "
            f"{', '.join(edges)}."
        )
    if concern:
        c_edges = sorted({e["edge_id"] for e in concern if e["edge_id"] not in {e2["edge_id"] for e2 in crush}})
        if c_edges:
            lines.append(
                f"Additional concern-level density (above {CONCERN_THRESHOLD} p/m²) on: "
                f"{', '.join(c_edges)}."
            )
    return "  ".join(lines)
