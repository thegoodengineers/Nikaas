"""Evacuation simulator: people walk shortest paths to their assigned exit; every edge
admits at most width x specific-flow people per second (a queue forms in front of it).

Model: flow-limited network ("hydraulic" egress model), the standard engineering method in
SFPE Handbook of Fire Protection Engineering, Ch. "Emergency Movement" (Gwynne & Rosenbaum).
Constants below are the handbook's commonly quoted maxima; they are inputs, not tuned results.
"""
import math
import random
from dataclasses import dataclass

from .building import Building, shortest_path

FT = 0.3048  # metres per foot
# Values from the SFPE hydraulic model as used in SFPE Engineering Guide Example 1 (worked in
# Thunderhead Pathfinder docs, "SFPE Example 1", verified 30 Oct 2026) and the SFPE Handbook chapter
# "Employing the Hydraulic Model in Assessing Emergency Movement" (Gwynne & Rosenbaum).
WALK_SPEED = 3.9 * FT  # 1.19 m/s unimpeded horizontal speed
STAIR_SPEED = 0.85 * 212 * FT / 60  # 0.915 m/s along a 7/11 in stair at maximum flow
SPECIFIC_FLOW = {  # persons / s / metre of EFFECTIVE width
    "door": 24 / 60 / FT,  # 1.312
    "corridor": 24 / 60 / FT,  # 1.312
    "stair": 18.5 / 60 / FT,  # 1.012, 7/11 in stair
}
# boundary layer removed from EACH side of the clear width. Door jamb 6 in (SFPE Example 1, verified).
# Stair and corridor walls: SFPE table values as commonly quoted (15 cm, 20 cm) - see docs/QUESTIONS.md.
BOUNDARY = {"door": 6 * 0.0254, "stair": 0.15, "corridor": 0.20}


def effective_width(e):
    return max(0.3, e.width - 2 * BOUNDARY[e.kind])


DT = 0.25  # s


@dataclass
class Person:
    pid: int
    room: str
    exit: str
    path: list  # node ids, room ... exit
    leg: int = 0  # index of the edge being walked (path[leg] -> path[leg+1])
    s: float = 0.0  # metres walked on current edge
    state: str = "inside"  # inside | walking | queuing | stairs | out
    start: float = 0.0  # pre-movement delay, s
    ox: float = 0.0  # spawn offset inside the room
    oz: float = 0.0
    t_out: float = math.nan


def door_paths(b: Building, room, ex, blocked=()):
    """Every door of `room` that can still reach exit `ex`: [(door width, path room -> ... -> ex)].
    A path never goes back through the room (people leave by the door they are nearest to)."""
    out = []
    for nb, e in b.adj[room]:
        if nb == ex:
            out.append((e.width, [room, ex]))
            continue
        if nb in blocked:
            continue
        d, rest = shortest_path(b, nb, ex, set(blocked) | {room})
        if rest:
            out.append((e.width, [room] + rest))
    return out


def simulate(b: Building, plan: dict, blocked=(), seed=7, max_t=1800.0, frame_every=1.0, premove=(0.0, 0.0)):
    """Run one evacuation. plan: room -> exit. Returns a dict in the API contract shape."""
    rng = random.Random(seed)
    blocked = set(blocked)
    edge_of = {}
    for e in b.edges:
        edge_of[(e.a, e.b)] = e
        edge_of[(e.b, e.a)] = e
    people, pid, routes, door_routes = [], 0, {}, {}
    for room, n in b.people().items():
        ex = plan[room]
        if ex in blocked:
            raise ValueError(f"plan sends {room} to blocked exit {ex}")
        doors = door_paths(b, room, ex, blocked)
        if not doors:
            raise ValueError(f"no route from {room} to {ex}")
        door_routes[room] = [path for _, path in doors]
        routes[room] = max(doors, key=lambda d: d[0])[1]  # widest door's route (kept for the UI contract)
        node = b.nodes[room]
        total_w = sum(w for w, _ in doors)
        # occupants split across the room's usable doors in proportion to door width
        counts = [int(n * w / total_w) for w, _ in doors]
        for i in range(n - sum(counts)):
            counts[i % len(counts)] += 1
        for (_, path), k in zip(doors, counts):
            for _ in range(k):
                people.append(Person(pid, room, ex, path, start=rng.uniform(*premove),
                                     ox=(rng.random() - .5) * node.get("w", 4) * .8,
                                     oz=(rng.random() - .5) * node.get("d", 4) * .8))
                pid += 1

    # Base capacities
    cap = {e.key: effective_width(e) * SPECIFIC_FLOW[e.kind] for e in b.edges}  # persons / s
    credit = {k: 0.0 for k in cap}
    queues = {k: [] for k in cap}  # FIFO of person ids waiting to enter the edge
    peak_q = {k: 0 for k in cap}
    exit_count = {x: 0 for x in b.exits}

    # Shared capacity groups for stairwells
    capacity_groups = {}
    for e in b.edges:
        if e.capacity_group:
            capacity_groups.setdefault(e.capacity_group, []).append(e)

    # Bottleneck discharge rate per capacity group: narrowest segment governs the stairwell
    group_cap = {}
    group_credit = {}
    for g, g_edges in capacity_groups.items():
        min_eff_w = min(effective_width(e) for e in g_edges)
        group_cap[g] = min_eff_w * SPECIFIC_FLOW["stair"]
        group_credit[g] = 0.0

    frames, t, next_frame = [], 0.0, 0.0

    def pos_2d_and_3d(p):
        if p.state == "inside" or (p.state == "queuing" and p.leg == 0):
            # still in the room: spread over the room floor, drifting toward the door while queuing
            n = b.nodes[p.room]
            k = 0.45 if p.state == "queuing" else 1.0
            door = b.nodes[p.path[1]]
            x, z = n["x"] + p.ox * k, n["z"] + p.oz * k
            if p.state == "queuing":
                x, z = x + (door["x"] - x) * 0.35, z + (door["z"] - z) * 0.35
            y = b.elevation_of(p.room)
            fl = b.floor_of(p.room) or "default"
            return (x, z), (x, y, z, fl)

        if p.state == "queuing":
            # waiting in front of a corridor junction or stair
            u_id = p.path[p.leg]
            a = b.nodes[u_id]
            x, z = a["x"] + p.ox * 0.15, a["z"] + p.oz * 0.15
            y = b.elevation_of(u_id)
            fl = b.floor_of(u_id) or "default"
            return (x, z), (x, y, z, fl)

        u_id = p.path[p.leg]
        v_id = p.path[min(p.leg + 1, len(p.path) - 1)]
        a, c = b.nodes[u_id], b.nodes[v_id]
        e = edge_of.get((u_id, v_id))
        f = 0.0 if not e else min(1.0, p.s / e.length)
        x = a["x"] + (c["x"] - a["x"]) * f
        z = a["z"] + (c["z"] - a["z"]) * f
        y_a = b.elevation_of(u_id)
        y_c = b.elevation_of(v_id)
        y = y_a + (y_c - y_a) * f
        # Floor attribution transitions at mid-flight during vertical traversal
        fl = (b.floor_of(u_id) if f < 0.5 else b.floor_of(v_id)) or "default"
        return (x, z), (x, y, z, fl)

    def want_edge(p):
        k = edge_of[(p.path[p.leg], p.path[p.leg + 1])].key
        if p.pid not in queues[k]:
            queues[k].append(p.pid)
        p.state = "queuing"

    # Pre-classify edges by capacity group
    edge_to_group = {e.key: e.capacity_group for e in b.edges if e.capacity_group}
    grouped_keys = set(edge_to_group.keys())
    ungrouped_keys = [e.key for e in b.edges if not e.capacity_group]

    # Persistent round-robin pointers and landing zipper-merge toggles for fair sharing
    group_rr_ptr = {g: 0 for g in capacity_groups}
    landing_toggle = {e.key: True for e in b.edges}

    while t <= max_t:
        # 1) people whose pre-movement ended join the queue of their first edge
        for p in people:
            if p.state == "inside" and t >= p.start:
                want_edge(p)

        # 2a) Ungrouped edges admit people independently
        for k in ungrouped_keys:
            q = queues[k]
            credit[k] += cap[k] * DT
            while q and credit[k] >= 1.0:
                credit[k] -= 1.0
                p = people[q.pop(0)]
                e = edge_of[(p.path[p.leg], p.path[p.leg + 1])]
                p.state, p.s = ("stairs" if e.kind == "stair" else "walking"), 0.0
            if not q:
                credit[k] = min(credit[k], 1.0)
            peak_q[k] = max(peak_q[k], len(q))

        # 2b) Grouped edges: shared capacity resource with fair round-robin scheduling and landing zipper-merge
        for g, g_edges in capacity_groups.items():
            g_keys = [e.key for e in g_edges]
            group_credit[g] += group_cap[g] * DT

            # Accumulate per-edge credit for each flight in the group
            for e in g_edges:
                credit[e.key] += cap[e.key] * DT

            progress = True
            while progress:
                progress = False

                # 1. Internal descending continuity: advance internal evacuees with zipper merge at landings
                for k in g_keys:
                    if credit[k] < 1.0 or not queues[k]:
                        continue
                    internal_indices = [idx for idx, pid in enumerate(queues[k])
                                        if (people[pid].leg > 0 and
                                            edge_of.get((people[pid].path[people[pid].leg - 1], people[pid].path[people[pid].leg])) and
                                            edge_of[(people[pid].path[people[pid].leg - 1], people[pid].path[people[pid].leg])].capacity_group == g)]
                    external_indices = [idx for idx, pid in enumerate(queues[k])
                                        if idx not in internal_indices]

                    serve_internal = False
                    if internal_indices and not external_indices:
                        serve_internal = True
                    elif internal_indices and external_indices:
                        # 1:1 alternating zipper merge at landing
                        if landing_toggle[k] or group_credit[g] < 1.0:
                            serve_internal = True
                        else:
                            serve_internal = False

                    if serve_internal and internal_indices:
                        idx = internal_indices[0]
                        credit[k] -= 1.0
                        p = people[queues[k].pop(idx)]
                        e = edge_of[(p.path[p.leg], p.path[p.leg + 1])]
                        p.state, p.s = "stairs", 0.0
                        landing_toggle[k] = not landing_toggle[k]
                        progress = True
                        break

                # 2. Fair round-robin admission of external entrants into the stairwell across floors
                if not progress and group_credit[g] >= 1.0:
                    n_edges = len(g_keys)
                    start_ptr = group_rr_ptr[g]
                    for offset in range(n_edges):
                        cand_idx = (start_ptr + offset) % n_edges
                        cand_k = g_keys[cand_idx]
                        if credit[cand_k] < 1.0 or not queues[cand_k]:
                            continue
                        ext_idx = next((idx for idx, pid in enumerate(queues[cand_k])
                                        if (people[pid].leg == 0 or
                                            not edge_of.get((people[pid].path[people[pid].leg - 1], people[pid].path[people[pid].leg])) or
                                            edge_of[(people[pid].path[people[pid].leg - 1], people[pid].path[people[pid].leg])].capacity_group != g)), None)
                        if ext_idx is not None:
                            group_credit[g] -= 1.0
                            credit[cand_k] -= 1.0
                            p = people[queues[cand_k].pop(ext_idx)]
                            e = edge_of[(p.path[p.leg], p.path[p.leg + 1])]
                            p.state, p.s = "stairs", 0.0
                            landing_toggle[cand_k] = not landing_toggle[cand_k]
                            group_rr_ptr[g] = (cand_idx + 1) % n_edges
                            progress = True
                            break

            # If all queues in group are empty, clamp leftover capacity
            if not any(queues[k] for k in g_keys):
                group_credit[g] = min(group_credit[g], 1.0)
            for k in g_keys:
                if not queues[k]:
                    credit[k] = min(credit[k], 1.0)
                peak_q[k] = max(peak_q[k], len(queues[k]))

        # 3) walkers advance; at the end of an edge they reach a node
        for p in people:
            if p.state not in ("walking", "stairs"):
                continue
            e = edge_of[(p.path[p.leg], p.path[p.leg + 1])]
            p.s += (STAIR_SPEED if e.kind == "stair" else WALK_SPEED) * DT
            if p.s >= e.length:
                p.leg += 1
                if p.leg == len(p.path) - 1:  # reached the exit node
                    p.state, p.t_out = "out", t + DT
                    exit_count[p.exit] += 1
                else:
                    want_edge(p)
        t += DT
        if t >= next_frame:
            frame_2d = []
            frame_3d = []
            for p in people:
                (x, z), (x3, y3, z3, fl) = pos_2d_and_3d(p)
                frame_2d.append([round(x, 2), round(z, 2), p.state])
                if b.floors:
                    frame_3d.append([round(x3, 2), round(y3, 2), round(z3, 2), p.state, fl])
            f_dict = {"t": round(t, 2), "people": frame_2d}
            if b.floors:
                f_dict["people_3d"] = frame_3d
            frames.append(f_dict)
            next_frame += frame_every
        if all(p.state == "out" for p in people):
            break

    done = all(p.state == "out" for p in people)
    bottleneck = max(peak_q, key=peak_q.get) if peak_q else None
    tot_time = round(max(p.t_out for p in people), 2) if done and people else None

    # Multi-floor progress and stairwell metrics
    per_floor = {}
    if b.floors:
        for fid, fdict in b.floors.items():
            rooms_f = [r for r in b.rooms if b.floor_of(r) == fid]
            occ_f = sum(b.nodes[r].get("people", 0) for r in rooms_f)
            ppl_f = [p for p in people if p.room in rooms_f]
            done_f = all(p.state == "out" for p in ppl_f) if ppl_f else True
            clear_t = round(max((p.t_out for p in ppl_f), default=0.0), 2) if done_f and ppl_f else None
            per_floor[fid] = {
                "name": fdict.get("name", fid),
                "elevation_m": fdict.get("elevation_m", 0.0),
                "occupants": occ_f,
                "completed": done_f,
                "clearance_time_s": clear_t,
            }
    else:
        per_floor["default"] = {
            "name": "Ground Floor",
            "elevation_m": 0.0,
            "occupants": len(people),
            "completed": done,
            "clearance_time_s": tot_time,
        }

    stairwell_load = {}
    for g, g_edges in capacity_groups.items():
        g_keys = [e.key for e in g_edges]
        stairwell_load[g] = {
            "peak_queue": max((peak_q[k] for k in g_keys), default=0),
            "capacity_pps": round(group_cap[g], 2),
            "bottleneck_edge": max(g_keys, key=lambda k: peak_q[k]) if g_keys else None,
            "edges": g_keys,
        }

    stair_users = sum(1 for p in people if any(edge_of.get((u, v)) and edge_of[(u, v)].kind == "stair"
                                               for u, v in zip(p.path[:-1], p.path[1:])))

    return {
        "total_time_s": tot_time,
        "completed": done,
        "people": len(people),
        "per_exit": exit_count,
        "bottleneck": bottleneck,
        "peak_queue": peak_q.get(bottleneck, 0) if bottleneck else 0,
        "edge_load": {k: v for k, v in sorted(peak_q.items(), key=lambda kv: -kv[1])},
        "routes": routes,
        "door_routes": door_routes,
        "frames": frames,
        # Additive multi-floor metrics
        "per_floor": per_floor,
        "stairwell_load": stairwell_load,
        "vertical_movement": {
            "people_using_stairs": stair_users,
            "total_floors": len(b.floors) if b.floors else 1,
        },
    }
