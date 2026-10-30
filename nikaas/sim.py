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
WHEELCHAIR_SPEED = 0.69  # m/s; SFPE Handbook "Accessibility and Egress" mean unimpeded wheelchair speed
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
    state: str = "inside"  # inside | walking | queuing | stairs | out | refuge
    start: float = 0.0  # pre-movement delay, s
    ox: float = 0.0  # spawn offset inside the room
    oz: float = 0.0
    t_out: float = math.nan
    is_wheelchair: bool = False  # uses WHEELCHAIR_SPEED; cannot traverse stair edges


def _stair_free_path(b, src, dst, blocked=()):
    """Dijkstra that refuses stair edges. Returns (distance, [node ids]) or (inf, [])."""
    import heapq
    stair_pairs = {(e.a, e.b) for e in b.edges if e.kind == "stair"} | \
                  {(e.b, e.a) for e in b.edges if e.kind == "stair"}
    dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if u == dst:
            break
        if d > dist.get(u, math.inf):
            continue
        for v, e in b.adj[u]:
            if v in blocked or (u, v) in stair_pairs:
                continue
            nd = d + e.length
            if nd < dist.get(v, math.inf):
                dist[v], prev[v] = nd, u
                heapq.heappush(pq, (nd, v))
    if dst not in prev and src != dst:
        return math.inf, []
    path, cur = [], dst
    while cur != src:
        path.append(cur); cur = prev.get(cur)
        if cur is None:
            return math.inf, []
    path.append(src); path.reverse()
    return dist.get(dst, math.inf), path


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


def simulate(b: Building, plan: dict, blocked=(), seed=7, max_t=1800.0, frame_every=1.0, premove=(0.0, 0.0),
             compliance: float = 1.0, nearest: dict | None = None, wheelchair_fraction: float = 0.0):
    """Run one evacuation. plan: room -> exit. Returns a dict in the API contract shape.

    compliance: fraction of occupants who follow `plan` (1.0 = everyone obeys).
    The rest are "rebels" who follow `nearest` (computed if not supplied).
    """
    rng = random.Random(seed)
    blocked = set(blocked)
    # build rebel plan once (nearest exit per room ignoring compliance)
    if compliance < 1.0:
        from .building import nearest_plan as _nearest_plan
        rebel_plan = nearest or _nearest_plan(b, blocked)
    else:
        rebel_plan = plan
    edge_of = {}
    for e in b.edges:
        edge_of[(e.a, e.b)] = e
        edge_of[(e.b, e.a)] = e
    people, pid, routes, door_routes = [], 0, {}, {}
    wheelchair_fraction = max(0.0, min(1.0, wheelchair_fraction))
    for room, n in b.people().items():
        node = b.nodes[room]

        # split: wheelchair users first, then ambulatory (compliant vs rebel)
        n_wheelchair = round(n * wheelchair_fraction)
        n_ambulatory = n - n_wheelchair

        # compliant vs rebel split applies only to ambulatory occupants
        n_compliant = round(n_ambulatory * compliance)
        groups = [(plan[room], n_compliant, False), (rebel_plan[room], n_ambulatory - n_compliant, False)]

        primary_ex = plan[room]  # used for the UI route ribbons
        if primary_ex in blocked:
            raise ValueError(f"plan sends {room} to blocked exit {primary_ex}")
        primary_doors = door_paths(b, room, primary_ex, blocked)
        if not primary_doors:
            raise ValueError(f"no route from {room} to {primary_ex}")
        door_routes[room] = [path for _, path in primary_doors]
        routes[room] = max(primary_doors, key=lambda d: d[0])[1]

        # wheelchair group: find the best stair-free exit for this room
        if n_wheelchair > 0:
            best_wc = min(
                ((_stair_free_path(b, room, x, blocked)[0], x) for x in b.exits if x not in blocked),
                default=(math.inf, None),
            )
            if best_wc[1] is not None and best_wc[0] < math.inf:
                groups.append((best_wc[1], n_wheelchair, True))
            else:
                # no stair-free exit: put them all in refuge immediately
                for _ in range(n_wheelchair):
                    p = Person(pid, room, primary_ex, [room, primary_ex],
                               state="refuge", start=0.0, is_wheelchair=True,
                               ox=(rng.random() - .5) * node.get("w", 4) * .8,
                               oz=(rng.random() - .5) * node.get("d", 4) * .8)
                    people.append(p); pid += 1

        for ex, count, is_wc in groups:
            if count == 0:
                continue
            if ex in blocked:
                ex = primary_ex  # fall back to compliant exit if rebel exit is blocked
            if is_wc:
                _, wc_path = _stair_free_path(b, room, ex, blocked)
                if not wc_path:
                    for _ in range(count):
                        p = Person(pid, room, ex, [room, ex], state="refuge", is_wheelchair=True,
                                   ox=(rng.random() - .5) * node.get("w", 4) * .8,
                                   oz=(rng.random() - .5) * node.get("d", 4) * .8)
                        people.append(p); pid += 1
                else:
                    for _ in range(count):
                        people.append(Person(pid, room, ex, wc_path, start=rng.uniform(*premove),
                                             is_wheelchair=True,
                                             ox=(rng.random() - .5) * node.get("w", 4) * .8,
                                             oz=(rng.random() - .5) * node.get("d", 4) * .8))
                        pid += 1
                continue
            doors = door_paths(b, room, ex, blocked)
            if not doors:
                doors = primary_doors  # fallback
            total_w = sum(w for w, _ in doors)
            counts = [int(count * w / total_w) for w, _ in doors]
            for i in range(count - sum(counts)):
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

    multi = bool(b.floors)  # 3D positions only for multi-floor buildings: single-floor frames never carry them

    def pos_2d_and_3d(p):
        if p.state == "inside" or (p.state == "queuing" and p.leg == 0):
            # still in the room: spread over the room floor, drifting toward the door while queuing
            n = b.nodes[p.room]
            k = 0.45 if p.state == "queuing" else 1.0
            door = b.nodes[p.path[1]]
            x, z = n["x"] + p.ox * k, n["z"] + p.oz * k
            if p.state == "queuing":
                x, z = x + (door["x"] - x) * 0.35, z + (door["z"] - z) * 0.35
            return (x, z), ((x, b.elevation_of(p.room), z, b.floor_of(p.room) or "default") if multi else None)

        if p.state == "queuing":
            # waiting in front of a corridor junction or stair
            u_id = p.path[p.leg]
            a = b.nodes[u_id]
            x, z = a["x"] + p.ox * 0.15, a["z"] + p.oz * 0.15
            return (x, z), ((x, b.elevation_of(u_id), z, b.floor_of(u_id) or "default") if multi else None)

        u_id = p.path[p.leg]
        v_id = p.path[min(p.leg + 1, len(p.path) - 1)]
        a, c = b.nodes[u_id], b.nodes[v_id]
        e = edge_of.get((u_id, v_id))
        f = 0.0 if not e else min(1.0, p.s / e.length)
        x = a["x"] + (c["x"] - a["x"]) * f
        z = a["z"] + (c["z"] - a["z"]) * f
        if not multi:
            return (x, z), None
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

    # people still in pre-movement (kept in id order, so queues fill in the same order as a scan of everyone),
    # and a running count of people out: the loop no longer scans all occupants twice per step
    waiting = [p for p in people if p.state == "inside"]
    n_out = sum(p.state == "out" for p in people)
    n_refuge = sum(p.state == "refuge" for p in people)
    while t <= max_t:
        # 1) people whose pre-movement ended join the queue of their first edge
        if waiting:
            still = []
            for p in waiting:
                if t >= p.start:
                    want_edge(p)
                else:
                    still.append(p)
            waiting = still

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
            speed = WHEELCHAIR_SPEED if p.is_wheelchair else (STAIR_SPEED if e.kind == "stair" else WALK_SPEED)
            p.s += speed * DT
            if p.s >= e.length:
                p.leg += 1
                if p.leg == len(p.path) - 1:  # reached the exit node
                    p.state, p.t_out = "out", t + DT
                    exit_count[p.exit] += 1
                    n_out += 1
                else:
                    want_edge(p)
        t += DT
        if t >= next_frame:
            frame_2d = []
            frame_3d = []
            for p in people:
                (x, z), p3 = pos_2d_and_3d(p)
                frame_2d.append([round(x, 2), round(z, 2), p.state])
                if multi:
                    frame_3d.append([round(p3[0], 2), round(p3[1], 2), round(p3[2], 2), p.state, p3[3]])
            f_dict = {"t": round(t, 2), "people": frame_2d}
            if b.floors:
                f_dict["people_3d"] = frame_3d
            frames.append(f_dict)
            next_frame += frame_every
        if n_out + n_refuge == len(people):
            break

    done = all(p.state in ("out", "refuge") for p in people)
    bottleneck = max(peak_q, key=peak_q.get) if peak_q else None
    tot_time = round(max(p.t_out for p in people), 2) if done and people else None
    # refuge people never exit; count them but exclude from timing stats
    refuge_count = sum(p.state == "refuge" for p in people)
    t_outs = sorted(p.t_out for p in people if not math.isnan(p.t_out))
    p95 = round(t_outs[int(len(t_outs) * 0.95)] if t_outs else 0, 2)

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
        "p95_time_s": p95,
        "completed": done,
        "people": len(people),
        "wheelchair_refuge": refuge_count,
        "compliance": round(compliance, 2),
        "per_exit": exit_count,
        "bottleneck": bottleneck,
        "peak_queue": peak_q.get(bottleneck, 0) if bottleneck else 0,
        "edge_load": {k: v for k, v in sorted(peak_q.items(), key=lambda kv: -kv[1])},
        "routes": routes,
        "door_routes": door_routes,
        "frames": frames,
        "per_floor": per_floor,
        "stairwell_load": stairwell_load,
        "vertical_movement": {
            "people_using_stairs": stair_users,
            "total_floors": len(b.floors) if b.floors else 1,
        },
    }
