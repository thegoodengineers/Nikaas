"""Graph Quality Analysis (QA) and Auto-Repair Engine for building evacuation graphs.

Analyzes building graphs produced by Bedrock vision or user edits against structural,
topological, and geometric plausibility criteria before simulation or optimisation.
"""
from __future__ import annotations

import copy
import math
from typing import Any

from .sim import BOUNDARY, SPECIFIC_FLOW

PENALTY_WEIGHTS = {
    # Critical violations
    "NO_EXITS": 50.0,
    "ISOLATED_ROOM": 40.0,
    "ZERO_WIDTH": 30.0,
    "NON_POSITIVE_ROOM_DIM": 30.0,
    # Warning violations
    "UNKNOWN_FLOOR_REFERENCE": 40.0,
    "CROSS_FLOOR_NON_STAIR": 30.0,
    "OCCUPIED_FLOOR_DISCONNECTED": 40.0,
    "STAIR_MISSING_LENGTH": 20.0,
    "STAIR_INVALID_PHYSICAL_LENGTH": 20.0,
    "MALFORMED_FLOOR_METADATA": 25.0,
    "DISCONNECTED_CAPACITY_GROUP": 25.0,
    "NON_ADJACENT_FLOOR_STAIR": 20.0,
    "INCONSISTENT_CAPACITY_GROUP": 10.0,
    "INSUFFICIENT_EXIT_CAPACITY": 15.0,
    "INSUFFICIENT_EXIT_COUNT": 15.0,
    "DISCONNECTED_EXIT": 15.0,
    "UNREACHABLE_EXIT": 15.0,
    "DISCONNECTED_COMPONENTS": 15.0,
    "SUSPICIOUS_AUTO_LINK": 10.0,
    "HIGH_INFERRED_RATIO": 10.0,
    "SELF_LOOP_EDGE": 5.0,
    "ZERO_LENGTH_EDGE": 5.0,
    "DUPLICATE_EDGE": 5.0,
    "SUSPICIOUS_DOOR_LENGTH": 5.0,
    "NARROW_PASSAGE": 5.0,
    "EXCESSIVE_WIDTH": 5.0,
    "EXTREME_DENSITY": 5.0,
    "EXTREME_ASPECT_RATIO": 5.0,
    "ORPHAN_NODE": 5.0,
    # Informational
    "DEAD_END_CORRIDOR": 2.0,
}

KIND_PRIORITY = {"stair": 3, "door": 2, "corridor": 1}
PROV_PRIORITY = {"model": 3, "manual": 3, "unspecified": 2, "merge_exits": 1, "auto_connect": 0}


def _euclidean_dist(n1: dict[str, Any], n2: dict[str, Any]) -> float:
    return math.hypot(float(n1.get("x", 0.0)) - float(n2.get("x", 0.0)),
                      float(n1.get("z", 0.0)) - float(n2.get("z", 0.0)))


def _effective_door_span(n_u: dict[str, Any], n_v: dict[str, Any]) -> float:
    """Distance from room wall perimeter to corridor point, or centre-to-centre if not a room."""
    u_type = n_u.get("type")
    v_type = n_v.get("type")
    if "room" in (u_type, v_type):
        r, p = (n_u, n_v) if u_type == "room" else (n_v, n_u)
        w, d = float(r.get("w", 0.0)), float(r.get("d", 0.0))
        if w > 0 and d > 0:
            rx, rz = float(r.get("x", 0.0)), float(r.get("z", 0.0))
            px, pz = float(p.get("x", 0.0)), float(p.get("z", 0.0))
            dx = max(0.0, abs(px - rx) - w / 2.0)
            dz = max(0.0, abs(pz - rz) - d / 2.0)
            return math.hypot(dx, dz)
    return _euclidean_dist(n_u, n_v)


def exit_flow_capacity(width: Any, kind: str | None = None) -> float:
    """Calculate egress flow capacity (persons/s) using the SFPE hydraulic model from nikaas/sim.py.

    Boundary layer deduction and specific flow constants match the simulator exactly:
    - effective_width = max(0.3, width - 2 * BOUNDARY[kind])
    - capacity = effective_width * SPECIFIC_FLOW[kind]
    """
    if not (isinstance(width, (int, float)) and width > 0):
        return 0.0
    k = str(kind) if kind in SPECIFIC_FLOW else "door"
    b = BOUNDARY.get(k, BOUNDARY["door"])
    eff_w = max(0.3, float(width) - 2.0 * b)
    return eff_w * SPECIFIC_FLOW[k]


def analyze_graph(building: dict[str, Any]) -> dict[str, Any]:
    """Inspect building graph and return a comprehensive quality assessment report."""
    if not isinstance(building, dict):
        return {
            "status": "critical",
            "score": 0.0,
            "metrics": {},
            "checks": {},
            "warnings": [{
                "code": "INVALID_INPUT",
                "severity": "critical",
                "message": "Building input must be a dictionary object.",
                "elements": [],
                "suggestion": "Provide a valid building JSON dictionary."
            }],
            "inferred_edges": [],
            "repair_suggestions": [],
        }

    raw_nodes = building.get("nodes", [])
    raw_edges = building.get("edges", [])

    nodes = {str(n.get("id")): n for n in raw_nodes if isinstance(n, dict) and "id" in n}
    rooms = {nid: n for nid, n in nodes.items() if n.get("type") == "room"}
    exits = {nid: n for nid, n in nodes.items() if n.get("type") == "exit"}
    corridors = {nid: n for nid, n in nodes.items() if n.get("type") == "corridor"}

    warnings: list[dict[str, Any]] = []
    repair_suggestions: list[str] = []
    inferred_edges: list[dict[str, Any]] = []

    # Check for legacy auto_links listed in vision metadata
    legacy_auto_links: set[tuple[str, str]] = set()
    for al in building.get("vision", {}).get("auto_links", []):
        if isinstance(al, str) and "-" in al:
            p1, p2 = al.split("-", 1)
            legacy_auto_links.add((min(p1, p2), max(p1, p2)))

    # Backward compatibility: recognize exits added by secondary pass in historical files
    exits_added_list = building.get("vision", {}).get("exits_added", [])
    added_exit_ids: set[str] = set()
    if exits_added_list:
        all_exit_nodes = [n for n in raw_nodes if isinstance(n, dict) and n.get("type") == "exit"]
        n_added = len(exits_added_list)
        candidate_nodes = all_exit_nodes[-n_added:] if len(all_exit_nodes) >= n_added else all_exit_nodes
        for n in candidate_nodes:
            lbl = n.get("label")
            nid = str(n.get("id"))
            if lbl in exits_added_list or nid in exits_added_list or nid.startswith("EXIT_"):
                added_exit_ids.add(nid)

    # Adjacency structures
    adj: dict[str, list[str]] = {nid: [] for nid in nodes}
    edge_pairs: dict[tuple[str, str], list[dict[str, Any]]] = {}

    self_loop_count = 0
    duplicate_count = 0
    zero_len_count = 0
    suspicious_auto_links = 0
    suspicious_doors = 0
    implausible_widths = 0

    provenance_counts = {
        "model": 0,
        "auto_connect": 0,
        "merge_exits": 0,
        "manual": 0,
        "unspecified": 0,
    }

    for idx, e in enumerate(raw_edges):
        if not isinstance(e, dict):
            continue
        u = str(e.get("from"))
        v = str(e.get("to"))
        w = float(e.get("width", 0.0))

        pair_unordered = (min(u, v), max(u, v))
        has_explicit_provenance = ("inferred" in e) or ("source" in e)

        if has_explicit_provenance:
            is_inferred = bool(e.get("inferred", False))
            source = str(e.get("source", "auto_connect" if is_inferred else "unspecified"))
        else:
            # Check historical fallback
            if pair_unordered in legacy_auto_links:
                is_inferred = True
                source = "auto_connect"
            elif (u in added_exit_ids and nodes.get(v, {}).get("type") == "corridor") or \
                 (v in added_exit_ids and nodes.get(u, {}).get("type") == "corridor"):
                is_inferred = True
                source = "merge_exits"
            else:
                is_inferred = False
                source = "unspecified"

        if source in provenance_counts:
            provenance_counts[source] += 1
        elif is_inferred:
            provenance_counts["auto_connect"] += 1
        else:
            provenance_counts["unspecified"] += 1

        if is_inferred or source in ("auto_connect", "merge_exits"):
            inferred_edges.append({
                "from": u,
                "to": v,
                "kind": e.get("kind", "corridor"),
                "width": w,
                "source": source,
            })

        # Self loops
        if u == v:
            self_loop_count += 1
            warnings.append({
                "code": "SELF_LOOP_EDGE",
                "severity": "warning",
                "message": f"Edge {idx} is a self-loop on node '{u}'.",
                "elements": [u],
                "suggestion": f"Remove redundant self-loop on node '{u}'."
            })
            repair_suggestions.append(f"Remove self-loop on node '{u}'.")
            continue

        if u not in nodes or v not in nodes:
            # Skip invalid nodes from geometric analysis
            continue

        adj[u].append(v)
        adj[v].append(u)

        edge_pairs.setdefault(pair_unordered, []).append(e)

        # Geometric edge length
        n_u, n_v = nodes[u], nodes[v]
        fu = n_u.get('floor_id')
        fv = n_v.get('floor_id')
        if fu and fv and fu != fv:
            dist = float(e.get('length', 0.0))
        else:
            dist = _euclidean_dist(n_u, n_v)

        # Zero length edge check
        if dist < 0.10:
            zero_len_count += 1
            warnings.append({
                "code": "ZERO_LENGTH_EDGE",
                "severity": "warning",
                "message": f"Edge between '{u}' and '{v}' has near-zero length ({dist:.2f} m).",
                "elements": [u, v],
                "suggestion": f"Nodes '{u}' and '{v}' overlap. Merge them into a single node or separate their coordinates."
            })
            repair_suggestions.append(f"Merge overlapping nodes '{u}' and '{v}' (distance {dist:.2f} m).")

        # Suspicious auto-link
        if is_inferred or source == "auto_connect":
            if dist > 12.0:
                suspicious_auto_links += 1
                warnings.append({
                    "code": "SUSPICIOUS_AUTO_LINK",
                    "severity": "warning",
                    "message": f"Auto-connected link between '{u}' and '{v}' spans {dist:.1f} m without intermediate corridor points.",
                    "elements": [u, v],
                    "suggestion": f"Verify whether '{u}' and '{v}' are genuinely connected or add intermediate walkway points."
                })
                repair_suggestions.append(f"Add intermediate walkway points between '{u}' and '{v}'.")

        # Suspicious door length
        kind = e.get("kind")
        if kind == "door":
            u_type = nodes[u].get("type")
            v_type = nodes[v].get("type")
            has_room = "room" in (u_type, v_type)
            has_exit = "exit" in (u_type, v_type)

            if has_room:
                door_span = _effective_door_span(n_u, n_v)
                if door_span > 5.0:
                    suspicious_doors += 1
                    warnings.append({
                        "code": "SUSPICIOUS_DOOR_LENGTH",
                        "severity": "warning",
                        "message": f"Door link between '{u}' and '{v}' spans {door_span:.1f} m from room boundary, exceeding standard doorway bounds.",
                        "elements": [u, v],
                        "suggestion": f"Change link between '{u}' and '{v}' to 'corridor' or add intermediate corridor points."
                    })
            elif has_exit:
                # Exit-to-corridor door link where neither endpoint is a room (10 m threshold)
                dist_exit = _euclidean_dist(n_u, n_v)
                if dist_exit > 10.0:
                    suspicious_doors += 1
                    exit_id = u if u_type == "exit" else v
                    corr_id = v if u_type == "exit" else u
                    warnings.append({
                        "code": "SUSPICIOUS_DOOR_LENGTH",
                        "severity": "warning",
                        "message": f"Door link between exit '{exit_id}' and corridor point '{corr_id}' spans {dist_exit:.1f} m, exceeding standard doorway bounds.",
                        "elements": [u, v],
                        "suggestion": f"Verify connection between exit '{exit_id}' and corridor '{corr_id}' or add intermediate walkway points."
                    })
            else:
                # Neither room nor exit (e.g. corridor to corridor mislabeled as door)
                dist_other = _euclidean_dist(n_u, n_v)
                if dist_other > 5.0:
                    suspicious_doors += 1
                    warnings.append({
                        "code": "SUSPICIOUS_DOOR_LENGTH",
                        "severity": "warning",
                        "message": f"Door link between '{u}' and '{v}' spans {dist_other:.1f} m, exceeding standard doorway bounds.",
                        "elements": [u, v],
                        "suggestion": f"Change link between '{u}' and '{v}' to 'corridor'."
                    })

        # Width checks
        if w <= 0:
            implausible_widths += 1
            warnings.append({
                "code": "ZERO_WIDTH",
                "severity": "critical",
                "message": f"Edge between '{u}' and '{v}' has non-positive width ({w} m).",
                "elements": [u, v],
                "suggestion": f"Assign realistic passage width (e.g. 1.2 m for door, 2.0 m for corridor)."
            })
            repair_suggestions.append(f"Set width of edge '{u}'-'{v}' to default (1.2 m door / 2.0 m corridor).")
        elif w < 0.60:
            implausible_widths += 1
            warnings.append({
                "code": "NARROW_PASSAGE",
                "severity": "warning",
                "message": f"Edge between '{u}' and '{v}' has width {w:.2f} m, narrower than minimum emergency egress code (0.60 m).",
                "elements": [u, v],
                "suggestion": f"Widen passage between '{u}' and '{v}' to at least 0.80 m."
            })
            repair_suggestions.append(f"Widen edge '{u}'-'{v}' to 0.80 m.")
        elif w > 6.00:
            implausible_widths += 1
            warnings.append({
                "code": "EXCESSIVE_WIDTH",
                "severity": "warning",
                "message": f"Edge between '{u}' and '{v}' has excessive width ({w:.1f} m).",
                "elements": [u, v],
                "suggestion": f"Verify whether passage between '{u}' and '{v}' is truly {w:.1f} m wide."
            })

    # Duplicate edges check
    for (u, v), plist in edge_pairs.items():
        if len(plist) > 1:
            duplicate_count += len(plist) - 1
            warnings.append({
                "code": "DUPLICATE_EDGE",
                "severity": "warning",
                "message": f"Nodes '{u}' and '{v}' have {len(plist)} parallel edges.",
                "elements": [u, v],
                "suggestion": f"Deduplicate parallel edges between '{u}' and '{v}' into a single link."
            })
            repair_suggestions.append(f"Remove {len(plist) - 1} redundant duplicate edge(s) between '{u}' and '{v}'.")

    # Check 2: Connected components & Room-to-Exit Reachability
    visited: set[str] = set()
    components: list[list[str]] = []
    for nid in nodes:
        if nid not in visited:
            comp: list[str] = []
            queue = [nid]
            visited.add(nid)
            while queue:
                curr = queue.pop(0)
                comp.append(curr)
                for nbr in adj.get(curr, []):
                    if nbr not in visited:
                        visited.add(nbr)
                        queue.append(nbr)
            components.append(comp)

    # Check for isolated rooms and disconnected components
    isolated_rooms: list[str] = []
    unreachable_exits: list[str] = []

    if len(components) > 1:
        warnings.append({
            "code": "DISCONNECTED_COMPONENTS",
            "severity": "warning",
            "message": f"Building graph contains {len(components)} disconnected components.",
            "elements": [c[0] for c in components if c],
            "suggestion": "Connect separate graph components using corridors or walkway links."
        })

    # Exit check
    if not exits:
        warnings.append({
            "code": "NO_EXITS",
            "severity": "critical",
            "message": "Building graph has 0 designated exits.",
            "elements": [],
            "suggestion": "Add at least one exit node connecting corridors to the building exterior."
        })

    # For each room, check if it can reach at least one exit
    reachable_exits: set[str] = set()
    for rid in rooms:
        comp = next((c for c in components if rid in c), [])
        comp_exits = [eid for eid in exits if eid in comp]
        if not comp_exits:
            isolated_rooms.append(rid)
            warnings.append({
                "code": "ISOLATED_ROOM",
                "severity": "critical",
                "message": f"Room '{rid}' cannot reach any building exit.",
                "elements": [rid],
                "suggestion": f"Connect room '{rid}' to adjacent corridors or exits."
            })
            repair_suggestions.append(f"Connect isolated room '{rid}' to nearest corridor point.")
        else:
            for eid in comp_exits:
                reachable_exits.add(eid)

    # Unreachable or disconnected exits
    for eid in exits:
        if len(adj.get(eid, [])) == 0:
            unreachable_exits.append(eid)
            warnings.append({
                "code": "DISCONNECTED_EXIT",
                "severity": "warning",
                "message": f"Exit '{eid}' has no connecting links (degree 0).",
                "elements": [eid],
                "suggestion": f"Link exit '{eid}' to the nearest corridor point."
            })
            repair_suggestions.append(f"Connect exit '{eid}' to nearest walkway node.")
        elif eid not in reachable_exits and rooms:
            unreachable_exits.append(eid)
            warnings.append({
                "code": "UNREACHABLE_EXIT",
                "severity": "warning",
                "message": f"Exit '{eid}' cannot be reached from any room.",
                "elements": [eid],
                "suggestion": f"Verify corridor pathing to exit '{eid}'."
            })

    # Check 3: Room dimensions and density
    dim_issues = 0
    for rid, r in rooms.items():
        w = float(r.get("w", 0.0))
        d = float(r.get("d", 0.0))
        people = int(r.get("people", 0))

        if w <= 0 or d <= 0:
            dim_issues += 1
            warnings.append({
                "code": "NON_POSITIVE_ROOM_DIM",
                "severity": "critical",
                "message": f"Room '{rid}' has non-positive dimensions (w={w}, d={d}).",
                "elements": [rid],
                "suggestion": f"Provide positive width and depth for room '{rid}'."
            })
            continue

        aspect = max(w / d, d / w)
        if aspect > 10.0:
            dim_issues += 1
            warnings.append({
                "code": "EXTREME_ASPECT_RATIO",
                "severity": "warning",
                "message": f"Room '{rid}' has extreme aspect ratio ({aspect:.1f}:1, w={w}m, d={d}m). May be an unclassified corridor.",
                "elements": [rid],
                "suggestion": f"Verify whether '{rid}' is a corridor or re-measure its bounding box."
            })

        area = w * d
        if area > 0:
            density = people / area
            if density > 4.0:
                dim_issues += 1
                warnings.append({
                    "code": "EXTREME_DENSITY",
                    "severity": "warning",
                    "message": f"Room '{rid}' has dangerous occupant density ({density:.2f} people/m², {people} people in {area:.1f} m²).",
                    "elements": [rid],
                    "suggestion": f"Review room use classification or scale down occupant count for '{rid}'."
                })

    # Check 4: Topology anomalies (orphans and dead-ends)
    orphan_nodes = 0
    dead_end_corridors = 0
    for nid, n in nodes.items():
        deg = len(adj.get(nid, []))
        if deg == 0 and n.get("type") != "exit":
            orphan_nodes += 1
            warnings.append({
                "code": "ORPHAN_NODE",
                "severity": "warning",
                "message": f"Node '{nid}' ({n.get('type')}) has no connecting links (degree 0).",
                "elements": [nid],
                "suggestion": f"Connect or remove isolated node '{nid}'."
            })
            repair_suggestions.append(f"Connect or remove orphan node '{nid}'.")
        elif deg == 1 and n.get("type") == "corridor":
            dead_end_corridors += 1
            warnings.append({
                "code": "DEAD_END_CORRIDOR",
                "severity": "info",
                "message": f"Corridor node '{nid}' is a dead-end with only 1 connection.",
                "elements": [nid],
                "suggestion": f"Verify if walkway at '{nid}' extends to adjacent spaces."
            })

    # Check 5: High inferred connection ratio
    total_edges = len(raw_edges)
    inferred_count = len(inferred_edges)
    inferred_ratio = (inferred_count / total_edges) if total_edges > 0 else 0.0
    if total_edges >= 5 and inferred_ratio > 0.35:
        warnings.append({
            "code": "HIGH_INFERRED_RATIO",
            "severity": "warning",
            "message": f"High ratio of software-inferred links ({inferred_count}/{total_edges} = {inferred_ratio*100:.1f}%).",
            "elements": [],
            "suggestion": "Verify building layout manually; excessive auto-links suggest missing doorways in the visual model output."
        })

    # Total occupancy
    total_occupancy = sum(int(r.get("people", 0)) for r in rooms.values())

    # Check 6: Exit Capacity & Adequacy (SFPE Hydraulic Flow Model from nikaas/sim.py)
    exit_capacities: dict[str, float] = {}
    for eid in exits:
        incident_egress = [
            e for e in raw_edges
            if isinstance(e, dict)
            and ((e.get("from") == eid and e.get("to") in nodes and nodes[e["to"]].get("type") in ("corridor", "room"))
                 or (e.get("to") == eid and e.get("from") in nodes and nodes[e["from"]].get("type") in ("corridor", "room")))
        ]
        cap = sum(exit_flow_capacity(e.get("width"), e.get("kind")) for e in incident_egress)
        exit_capacities[eid] = cap

    # Aggregate exit capacity: unique physical egress edges connecting reachable exits to interior spaces
    egress_edge_indices: set[int] = set()
    for idx, e in enumerate(raw_edges):
        if not isinstance(e, dict):
            continue
        u = str(e.get("from"))
        v = str(e.get("to"))
        if u in reachable_exits and v in nodes and nodes[v].get("type") in ("corridor", "room"):
            egress_edge_indices.add(idx)
        elif v in reachable_exits and u in nodes and nodes[u].get("type") in ("corridor", "room"):
            egress_edge_indices.add(idx)

    aggregate_exit_capacity_pps = sum(
        exit_flow_capacity(raw_edges[i].get("width"), raw_edges[i].get("kind"))
        for i in egress_edge_indices
    )

    if aggregate_exit_capacity_pps > 0:
        estimated_capacity_time_s = total_occupancy / aggregate_exit_capacity_pps
    else:
        estimated_capacity_time_s = math.inf

    # Threshold: 150 s (project evacuation flow heuristic from build lead notes)
    CAPACITY_TIME_HEURISTIC_S = 150.0
    if total_occupancy > 0 and estimated_capacity_time_s > CAPACITY_TIME_HEURISTIC_S:
        warnings.append({
            "code": "INSUFFICIENT_EXIT_CAPACITY",
            "severity": "warning",
            "message": (
                f"Total occupant load ({total_occupancy}) requires estimated {estimated_capacity_time_s:.1f} s "
                f"to flow through aggregate exit capacity ({aggregate_exit_capacity_pps:.2f} persons/s), "
                f"exceeding the {CAPACITY_TIME_HEURISTIC_S:.0f} s evacuation flow heuristic."
            ),
            "elements": sorted(reachable_exits),
            "suggestion": "Add additional exit doors or widen existing exits to increase aggregate egress flow capacity.",
        })
        repair_suggestions.append(
            f"Increase exit capacity by adding exits or widening doors to achieve <= {CAPACITY_TIME_HEURISTIC_S:.0f} s flow time."
        )

    # Check 7: Minimum Exit Count Analysis (NBC 2016 Part 4, Clause 4.4.2.1)
    # Buildings/floors with occupant load > 50 require at least 2 remote exits.
    if total_occupancy > 50 and len(reachable_exits) == 1:
        only_exit = next(iter(reachable_exits))
        warnings.append({
            "code": "INSUFFICIENT_EXIT_COUNT",
            "severity": "warning",
            "message": (
                f"Building has only 1 accessible exit ('{only_exit}') for {total_occupancy} occupants. "
                f"Under NBC 2016 Part 4 (Clause 4.4.2.1), spaces with > 50 occupants require at least "
                f"2 remote exits to prevent single-point-of-failure trapping."
            ),
            "elements": [only_exit],
            "suggestion": "Verify building perimeter for missing exterior doors, emergency exits, or fire escapes.",
        })
        repair_suggestions.append(
            "Add a second remote exit to comply with NBC 2016 Part 4 minimum egress requirements (> 50 occupants)."
        )


    # Check 8: Multi-Floor Integrity (when floors are defined)
    raw_floors = building.get("floors")
    mf_status = "pass"
    if raw_floors is not None:
        if not isinstance(raw_floors, list):
            warnings.append({
                "code": "MALFORMED_FLOOR_METADATA",
                "severity": "warning",
                "message": "Building 'floors' must be a list of floor specifications.",
                "elements": [],
                "suggestion": "Provide a valid list of floor objects with 'id', 'name', and 'elevation_m'."
            })
            mf_status = "warning"
            floor_ids = set()
        else:
            floor_ids = set()
            f_id_list = []
            for i, f in enumerate(raw_floors):
                if isinstance(f, dict):
                    fid = f.get("id")
                    if fid and isinstance(fid, str):
                        floor_ids.add(fid)
                        f_id_list.append(fid)
                    else:
                        warnings.append({
                            "code": "MALFORMED_FLOOR_METADATA",
                            "severity": "warning",
                            "message": f"Floor at index {i} is missing a non-empty string 'id'.",
                            "elements": [],
                            "suggestion": "Assign a unique string identifier to each floor."
                        })
                        mf_status = "warning"
                    elev = f.get("elevation_m")
                    if not (isinstance(elev, (int, float)) and math.isfinite(elev)):
                        warnings.append({
                            "code": "MALFORMED_FLOOR_METADATA",
                            "severity": "warning",
                            "message": f"Floor '{fid or i}' has invalid elevation_m ({elev}).",
                            "elements": [fid] if fid else [],
                            "suggestion": f"Specify a finite numerical elevation in metres for floor '{fid or i}'."
                        })
                        mf_status = "warning"

            dup_f = {fid for fid in f_id_list if f_id_list.count(fid) > 1}
            if dup_f:
                warnings.append({
                    "code": "MALFORMED_FLOOR_METADATA",
                    "severity": "warning",
                    "message": f"Duplicate floor IDs detected: {sorted(dup_f)}.",
                    "elements": list(dup_f),
                    "suggestion": "Ensure every floor has a unique ID."
                })
                mf_status = "warning"

            # Check node floor references
            for nid, n in nodes.items():
                n_floor = n.get("floor_id")
                if not n_floor or n_floor not in floor_ids:
                    warnings.append({
                        "code": "UNKNOWN_FLOOR_REFERENCE",
                        "severity": "critical",
                        "message": f"Node '{nid}' references unknown floor '{n_floor}'.",
                        "elements": [nid],
                        "suggestion": f"Assign node '{nid}' to a valid floor in {sorted(floor_ids)}."
                    })
                    mf_status = "critical"

            # Check cross-floor edges
            for idx, e in enumerate(raw_edges):
                u, v = e.get("from"), e.get("to")
                if u in nodes and v in nodes:
                    fu = nodes[u].get("floor_id")
                    fv = nodes[v].get("floor_id")
                    if fu and fv and fu != fv:
                        if e.get("kind") != "stair":
                            warnings.append({
                                "code": "CROSS_FLOOR_NON_STAIR",
                                "severity": "critical",
                                "message": f"Cross-floor edge between '{u}' (floor {fu}) and '{v}' (floor {fv}) has kind '{e.get('kind')}' instead of 'stair'.",
                                "elements": [u, v],
                                "suggestion": f"Change edge '{u}-{v}' kind to 'stair' or connect nodes on the same floor."
                            })
                            mf_status = "critical"
                        length = e.get("length")
                        if length is None:
                            warnings.append({
                                "code": "STAIR_MISSING_LENGTH",
                                "severity": "warning",
                                "message": f"Cross-floor stair edge between '{u}' and '{v}' is missing explicit physical 'length'.",
                                "elements": [u, v],
                                "suggestion": f"Specify the physical walking travel length (m) for stair edge '{u}-{v}'."
                            })
                            if mf_status != "critical":
                                mf_status = "warning"
                        elif not (isinstance(length, (int, float)) and length > 0 and math.isfinite(length)):
                            warnings.append({
                                "code": "STAIR_INVALID_PHYSICAL_LENGTH",
                                "severity": "warning",
                                "message": f"Cross-floor stair edge between '{u}' and '{v}' has invalid length ({length}).",
                                "elements": [u, v],
                                "suggestion": f"Specify a positive finite length for stair edge '{u}-{v}'."
                            })
                            if mf_status != "critical":
                                mf_status = "warning"

            # Check occupied floors reaching exits
            if exits and rooms:
                for fid in floor_ids:
                    floor_rooms = [rid for rid, r in rooms.items() if r.get("floor_id") == fid and int(r.get("people", 0)) > 0]
                    if floor_rooms:
                        floor_can_reach = any(
                            any(x in next((c for c in components if rid in c), []) for x in exits)
                            for rid in floor_rooms
                        )
                        if not floor_can_reach:
                            warnings.append({
                                "code": "OCCUPIED_FLOOR_DISCONNECTED",
                                "severity": "critical",
                                "message": f"Occupied floor '{fid}' ({len(floor_rooms)} rooms) cannot reach any outdoor exit.",
                                "elements": floor_rooms,
                                "suggestion": f"Connect floor '{fid}' to the stairwell / exit network."
                            })
                            mf_status = "critical"

# Sort floors by elevation to verify adjacent floor transitions
            floor_elev_map = {}
            for f in raw_floors:
                if isinstance(f, dict) and "id" in f and isinstance(f.get("elevation_m"), (int, float)):
                    floor_elev_map[f["id"]] = float(f["elevation_m"])
            sorted_floors = sorted(floor_elev_map.keys(), key=lambda fid: floor_elev_map[fid])
            floor_rank = {fid: idx for idx, fid in enumerate(sorted_floors)}

            # Check for non-adjacent floor transitions
            for e in raw_edges:
                if e.get("kind") == "stair":
                    u, v = e.get("from"), e.get("to")
                    if u in nodes and v in nodes:
                        fu = nodes[u].get("floor_id")
                        fv = nodes[v].get("floor_id")
                        if fu and fv and fu != fv and fu in floor_rank and fv in floor_rank:
                            if abs(floor_rank[fu] - floor_rank[fv]) > 1:
                                warnings.append({
                                    "code": "NON_ADJACENT_FLOOR_STAIR",
                                    "severity": "warning",
                                    "message": f"Stair edge '{u}-{v}' connects non-adjacent floors '{fu}' and '{fv}' without an intermediate floor landing.",
                                    "elements": [u, v],
                                    "suggestion": f"Ensure stair edge connects consecutive vertical floors or provide intermediate landings."
                                })
                                if mf_status != "critical":
                                    mf_status = "warning"

            # Check capacity groups
            cap_groups = {}
            for e in raw_edges:
                cg = e.get("capacity_group")
                if cg:
                    cap_groups.setdefault(cg, []).append(e)
            for cg, g_edges in cap_groups.items():
                non_stairs = [e for e in g_edges if e.get("kind") != "stair"]
                if non_stairs:
                    warnings.append({
                        "code": "INCONSISTENT_CAPACITY_GROUP",
                        "severity": "warning",
                        "message": f"Capacity group '{cg}' contains {len(non_stairs)} non-stair edges.",
                        "elements": [f"{e.get('from')}-{e.get('to')}" for e in non_stairs],
                        "suggestion": f"Ensure all edges in capacity group '{cg}' represent physical stair flights."
                    })
                    if mf_status != "critical":
                        mf_status = "warning"

                # Check vertical shaft continuity across flights in this capacity group
                if len(g_edges) > 1:
                    cg_adj = {}
                    for e in g_edges:
                        u, v = str(e.get("from")), str(e.get("to"))
                        cg_adj.setdefault(u, set()).add(v)
                        cg_adj.setdefault(v, set()).add(u)
                    visited = set()
                    comps = 0
                    for n in cg_adj:
                        if n not in visited:
                            comps += 1
                            q = [n]
                            visited.add(n)
                            while q:
                                curr = q.pop(0)
                                for nb in cg_adj.get(curr, ()):
                                    if nb not in visited:
                                        visited.add(nb)
                                        q.append(nb)
                    if comps > 1:
                        warnings.append({
                            "code": "DISCONNECTED_CAPACITY_GROUP",
                            "severity": "warning",
                            "message": f"Capacity group '{cg}' contains disconnected stair flights that do not form a contiguous vertical shaft ({comps} disconnected components).",
                            "elements": [f"{e.get('from')}-{e.get('to')}" for e in g_edges],
                            "suggestion": f"Ensure all stair flights in capacity group '{cg}' connect continuously at floor landings."
                        })
                        if mf_status != "critical":
                            mf_status = "warning"

                    # Check contiguous vertical floor coverage in capacity group
                    cg_floors = set()
                    for e in g_edges:
                        u, v = str(e.get("from")), str(e.get("to"))
                        if u in nodes and "floor_id" in nodes[u]:
                            cg_floors.add(nodes[u]["floor_id"])
                        if v in nodes and "floor_id" in nodes[v]:
                            cg_floors.add(nodes[v]["floor_id"])
                    cg_ranks = [floor_rank[fid] for fid in cg_floors if fid in floor_rank]
                    if cg_ranks and (max(cg_ranks) - min(cg_ranks) + 1 != len(set(cg_ranks))):
                        missing_ranks = set(range(min(cg_ranks), max(cg_ranks) + 1)) - set(cg_ranks)
                        missing_fids = [sorted_floors[r] for r in sorted(missing_ranks)]
                        warnings.append({
                            "code": "DISCONNECTED_CAPACITY_GROUP",
                            "severity": "warning",
                            "message": f"Capacity group '{cg}' has missing intermediate floors ({', '.join(missing_fids)}) in its vertical span.",
                            "elements": [f"{e.get('from')}-{e.get('to')}" for e in g_edges],
                            "suggestion": f"Include stair flights for intermediate floors {missing_fids} in capacity group '{cg}'."
                        })
                        if mf_status != "critical":
                            mf_status = "warning"

    # Compute heuristic score
    total_penalty = 0.0
    critical_count = 0
    for w in warnings:
        code = w["code"]
        sev = w["severity"]
        if sev == "critical":
            critical_count += 1
        penalty = PENALTY_WEIGHTS.get(code, 5.0)
        total_penalty += penalty

    score = max(0.0, min(100.0, round(100.0 - total_penalty, 1)))

    if critical_count > 0 or score < 50.0:
        status = "critical"
    elif score < 85.0 or len(warnings) > 0:
        status = "warning"
    else:
        status = "pass"

    report = {
        "status": status,
        "score": score,
        "metrics": {
            "nodes_count": len(nodes),
            "rooms_count": len(rooms),
            "exits_count": len(exits),
            "corridors_count": len(corridors),
            "edges_count": total_edges,
            "inferred_edges_count": inferred_count,
            "provenance": provenance_counts,
            "components_count": len(components),
            "total_occupancy": total_occupancy,
            "aggregate_exit_capacity_pps": round(aggregate_exit_capacity_pps, 2),
            "estimated_capacity_time_s": round(estimated_capacity_time_s, 1) if estimated_capacity_time_s != math.inf else None,
            "per_exit_capacity_pps": {eid: round(c, 2) for eid, c in exit_capacities.items()},
        },
        "checks": {
            "connectivity": {
                "status": "critical" if isolated_rooms else ("warning" if len(components) > 1 else "pass"),
                "isolated_rooms": isolated_rooms,
                "components": len(components),
            },
            "exit_accessibility": {
                "status": "critical" if not exits else ("warning" if unreachable_exits else "pass"),
                "unreachable_exits": unreachable_exits,
            },
            "exit_capacity": {
                "status": "warning" if (estimated_capacity_time_s > CAPACITY_TIME_HEURISTIC_S and total_occupancy > 0) else "pass",
                "aggregate_capacity_pps": round(aggregate_exit_capacity_pps, 2),
                "estimated_capacity_time_s": round(estimated_capacity_time_s, 1) if estimated_capacity_time_s != math.inf else None,
                "threshold_s": CAPACITY_TIME_HEURISTIC_S,
                "per_exit": {eid: round(c, 2) for eid, c in exit_capacities.items()},
            },
            "exit_count": {
                "status": "warning" if (total_occupancy > 50 and len(reachable_exits) == 1) else ("critical" if not exits else "pass"),
                "accessible_exits": len(reachable_exits),
                "min_required": 2 if total_occupancy > 50 else 1,
                "standard": "NBC 2016 Part 4, Clause 4.4.2.1",
            },
            "self_loops": {
                "status": "warning" if self_loop_count > 0 else "pass",
                "count": self_loop_count,
            },
            "duplicate_edges": {
                "status": "warning" if duplicate_count > 0 else "pass",
                "count": duplicate_count,
            },
            "zero_length_edges": {
                "status": "warning" if zero_len_count > 0 else "pass",
                "count": zero_len_count,
            },
            "suspicious_auto_links": {
                "status": "warning" if (suspicious_auto_links + suspicious_doors) > 0 else "pass",
                "count": suspicious_auto_links + suspicious_doors,
            },
            "implausible_widths": {
                "status": "warning" if implausible_widths > 0 else "pass",
                "count": implausible_widths,
            },
            "room_dimensions": {
                "status": "warning" if dim_issues > 0 else "pass",
                "count": dim_issues,
            },
            "topology_anomalies": {
                "status": "warning" if orphan_nodes > 0 else ("info" if dead_end_corridors > 0 else "pass"),
                "orphans": orphan_nodes,
                "dead_ends": dead_end_corridors,
            },
            "provenance": {
                "status": "warning" if (total_edges >= 5 and inferred_ratio > 0.35) else "pass",
                "inferred_ratio": round(inferred_ratio, 3),
            },
            "multi_floor": {
                "status": mf_status,
                "floors_count": len(raw_floors) if isinstance(raw_floors, list) else (1 if raw_floors is None else 0),
            },
        },
        "warnings": warnings,
        "inferred_edges": inferred_edges,
        "repair_suggestions": repair_suggestions,
    }

    return report


def _merge_duplicate_edges(e1: dict[str, Any], e2: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """Merge duplicate parallel edges preserving physical hierarchy and model reliability."""
    p1 = PROV_PRIORITY.get(str(e1.get("source", "unspecified")), 2)
    p2 = PROV_PRIORITY.get(str(e2.get("source", "unspecified")), 2)
    k1 = KIND_PRIORITY.get(str(e1.get("kind", "corridor")), 1)
    k2 = KIND_PRIORITY.get(str(e2.get("kind", "corridor")), 1)

    # Base selection: prefer model-detected provenance first, then kind priority
    if p1 > p2:
        base, other = copy.deepcopy(e1), e2
    elif p2 > p1:
        base, other = copy.deepcopy(e2), e1
    else:
        # Same provenance priority
        if k1 >= k2:
            base, other = copy.deepcopy(e1), e2
        else:
            base, other = copy.deepcopy(e2), e1

    conflict_note = None

    # Preserve physical edge kind hierarchy (stair > door > corridor)
    other_kind = str(other.get("kind", "corridor"))
    base_kind = str(base.get("kind", "corridor"))
    if KIND_PRIORITY.get(other_kind, 1) > KIND_PRIORITY.get(base_kind, 1):
        base["kind"] = other_kind

    # Width handling:
    # Only adopt other's width if other has equal or higher provenance priority and same/compatible kind.
    # Never overwrite reliable model-detected physical measurements with inferred widths.
    base_w = float(base.get("width", 1.0))
    other_w = float(other.get("width", 1.0))
    base_prov = PROV_PRIORITY.get(str(base.get("source", "unspecified")), 2)
    other_prov = PROV_PRIORITY.get(str(other.get("source", "unspecified")), 2)

    if other_prov >= base_prov:
        if other_w > base_w:
            base["width"] = other_w
    elif abs(base_w - other_w) > 0.5:
        conflict_note = f"width discrepancy ({base_w} m vs {other_w} m)"

    # Preserve unrelated metadata keys from other if not present in base
    for k, v in other.items():
        if k not in base:
            base[k] = v

    return base, conflict_note


def repair_graph(building: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Clean and repair common graph topological issues automatically.

    Repairs performed:
    1. Removes self-loops (from == to).
    2. Deduplicates parallel edges (preserves stair > door > corridor and model provenance).
    3. Preserves physical passage widths exactly; width anomalies remain in QA warnings.
    Returns (repaired_building_dict, actions_taken_list).
    """
    repaired = copy.deepcopy(building)
    actions: list[str] = []

    nodes = {str(n.get("id")): n for n in repaired.get("nodes", []) if isinstance(n, dict) and "id" in n}

    # 1. Strip self-loops and invalid references
    clean_edges: list[dict[str, Any]] = []
    for e in repaired.get("edges", []):
        if not isinstance(e, dict):
            continue
        u = str(e.get("from"))
        v = str(e.get("to"))
        if u == v:
            actions.append(f"Removed self-loop on node '{u}'")
            continue
        if u not in nodes or v not in nodes:
            actions.append(f"Removed edge with unknown endpoint '{u}' -> '{v}'")
            continue
        clean_edges.append(e)

    # 2. Deduplicate parallel edges (handling reversed endpoints (u, v) and (v, u) consistently)
    unique_edges: dict[tuple[str, str], dict[str, Any]] = {}
    for e in clean_edges:
        u = str(e.get("from"))
        v = str(e.get("to"))
        pair = (min(u, v), max(u, v))
        if pair not in unique_edges:
            unique_edges[pair] = e
        else:
            merged, conflict = _merge_duplicate_edges(unique_edges[pair], e)
            unique_edges[pair] = merged
            msg = f"Deduplicated parallel edge between '{u}' and '{v}'"
            if conflict:
                msg += f" (noted {conflict})"
            actions.append(msg)

    # Preserve original physical widths exactly without modification
    repaired["edges"] = list(unique_edges.values())
    return repaired, actions
