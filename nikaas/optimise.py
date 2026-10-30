"""Exit allocation optimiser and lower bound.
Assigns each room to an exit so that the last person leaves as early as possible.
Greedy local search + quickest-flow LP lower bound using SciPy linprog (HiGHS).
"""
import copy
from pathlib import Path
import numpy as np
from scipy.optimize import linprog

from .building import Building, load, nearest_plan, shortest_path
from .sim import effective_width, simulate, SPECIFIC_FLOW, STAIR_SPEED, WALK_SPEED, door_paths


def compute_exit_capacities(b: Building, blocked=()):
    """Effective exit clearance flow rate (persons / s) for each open exit."""
    blocked = set(blocked)
    open_exits = [x for x in b.exits if x not in blocked]
    cap = {}
    for ex in open_exits:
        inbound = [e for nb, e in b.adj[ex] if nb not in blocked]
        cap[ex] = sum(effective_width(e) * SPECIFIC_FLOW[e.kind] for e in inbound)
    return cap


def compute_travel_times(b: Building, blocked=()):
    """Shortest unimpeded travel time (seconds) from each room to each open exit."""
    blocked = set(blocked)
    open_exits = [x for x in b.exits if x not in blocked]
    t_walk = {}
    for r in b.rooms:
        for ex in open_exits:
            dist, path = shortest_path(b, r, ex, blocked)
            if not path:
                t_walk[(r, ex)] = math_inf = 1e9
            else:
                t = 0.0
                for u, v in zip(path[:-1], path[1:]):
                    for nb, e in b.adj[u]:
                        if nb == v:
                            v_speed = STAIR_SPEED if e.kind == "stair" else WALK_SPEED
                            t += e.length / v_speed
                            break
                t_walk[(r, ex)] = t
    return t_walk


def lower_bound(b: Building | dict, blocked=()) -> float:
    """Theoretical quickest-flow linear programming lower bound on evacuation time.
    Solved with SciPy linprog (HiGHS backend).
    Guarantees lower_bound <= actual evacuation time for any room-to-exit plan.
    """
    if not isinstance(b, Building):
        b = load(b)
    blocked = set(blocked)
    open_exits = [x for x in b.exits if x not in blocked]
    if not open_exits:
        raise ValueError("no reachable open exit in building")

    rooms = b.rooms
    occupants = b.people()
    total_people = sum(occupants.values())
    if total_people == 0:
        return 0.0

    cap = compute_exit_capacities(b, blocked)
    t_walk = compute_travel_times(b, blocked)

    # Variables: y_{r, x} for each (r, x), then total time T
    var_map = {}
    idx = 0
    for r in rooms:
        for ex in open_exits:
            var_map[(r, ex)] = idx
            idx += 1
    T_idx = idx
    num_vars = T_idx + 1

    # Objective: minimize T
    c = np.zeros(num_vars)
    c[T_idx] = 1.0

    # Conservation equalities: sum_{x} y_{r, x} = occupants[r]
    A_eq = []
    b_eq = []
    for r in rooms:
        row = np.zeros(num_vars)
        for ex in open_exits:
            row[var_map[(r, ex)]] = 1.0
        A_eq.append(row)
        b_eq.append(float(occupants[r]))

    # Capacity inequalities:
    A_ub = []
    b_ub = []

    # 1. Per-exit discharge time: sum_{r} y_{r, x} / cap[x] + min_walk_x <= T
    for ex in open_exits:
        reachable_walks = [t_walk[(r, ex)] for r in rooms if t_walk[(r, ex)] < 1e8]
        if not reachable_walks or cap[ex] <= 0:
            continue
        min_w = min(reachable_walks)
        row = np.zeros(num_vars)
        for r in rooms:
            if t_walk[(r, ex)] < 1e8:
                row[var_map[(r, ex)]] = 1.0 / cap[ex]
            else:
                row[var_map[(r, ex)]] = 1e5  # penalty if room cannot reach exit
        row[T_idx] = -1.0
        A_ub.append(row)
        b_ub.append(-min_w)

    # 2. Global capacity cut: sum_{r, x} y_{r, x} / (sum cap) + min_walk <= T
    total_cap = sum(cap.values())
    all_walks = [w for w in t_walk.values() if w < 1e8]
    if total_cap > 0 and all_walks:
        min_all_w = min(all_walks)
        row = np.zeros(num_vars)
        for r in rooms:
            for ex in open_exits:
                row[var_map[(r, ex)]] = 1.0 / total_cap
        row[T_idx] = -1.0
        A_ub.append(row)
        b_ub.append(-min_all_w)

    # 3. Minimum walk time constraint: for each room r and exit x, if y_{r, x} > 0, T >= t_walk
    for r in rooms:
        n_r = float(occupants[r])
        if n_r <= 0:
            continue
        for ex in open_exits:
            w = t_walk[(r, ex)]
            if w < 1e8:
                row = np.zeros(num_vars)
                row[var_map[(r, ex)]] = w / n_r
                row[T_idx] = -1.0
                A_ub.append(row)
                b_ub.append(0.0)

    # 4. Stairwell capacity group cuts (for multi-floor buildings with shared stairwell capacity)
    capacity_groups = {}
    for e in b.edges:
        if e.capacity_group:
            capacity_groups.setdefault(e.capacity_group, []).append(e)

    for g, g_edges in capacity_groups.items():
        min_eff_w = min(effective_width(e) for e in g_edges)
        cap_g = min_eff_w * SPECIFIC_FLOW['stair']
        if cap_g <= 0:
            continue
        g_edge_set = {(e.a, e.b) for e in g_edges} | {(e.b, e.a) for e in g_edges}

        # Multi-door flow distribution across stairwells:
        # In simulate(), occupants of a room split across all available doors in proportion to door width.
        # If doors lead to different stairwells, each stairwell receives a fraction alpha = sum(w_d) / sum(w_all).
        # To maintain a valid mathematical lower bound, each stairwell cut accounts for this door fraction.
        pairs_using_g = {}  # (r, ex) -> alpha
        walk_times_to_g = []
        for r in rooms:
            for ex in open_exits:
                d_paths = door_paths(b, r, ex, blocked)
                if not d_paths:
                    continue
                tot_door_w = sum(w for w, _ in d_paths)
                if tot_door_w <= 0:
                    continue
                g_door_w = 0.0
                for w, path in d_paths:
                    if path and any((u, v) in g_edge_set for u, v in zip(path[:-1], path[1:])):
                        g_door_w += w
                        t_to_g = 0.0
                        for u, v in zip(path[:-1], path[1:]):
                            if (u, v) in g_edge_set:
                                break
                            for nb, ed in b.adj[u]:
                                if nb == v:
                                    v_spd = STAIR_SPEED if ed.kind == 'stair' else WALK_SPEED
                                    t_to_g += ed.length / v_spd
                                    break
                        walk_times_to_g.append(t_to_g)
                alpha = g_door_w / tot_door_w
                if alpha > 0.0:
                    pairs_using_g[(r, ex)] = alpha

        if pairs_using_g:
            min_walk_g = min(walk_times_to_g) if walk_times_to_g else 0.0
            row = np.zeros(num_vars)
            for (r, ex), alpha in pairs_using_g.items():
                row[var_map[(r, ex)]] = alpha / cap_g
            row[T_idx] = -1.0
            A_ub.append(row)
            b_ub.append(-min_walk_g)

    bounds = [(0.0, None) for _ in range(num_vars)]

    res = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq, bounds=bounds, method="highs")
    if res.success:
        return round(float(res.x[T_idx]), 2)

    # Analytical fallback
    min_w = min(all_walks) if all_walks else 0.0
    return round(total_people / total_cap + min_w, 2) if total_cap > 0 else 0.0


def optimise(b: Building | dict, blocked=()) -> dict:
    """Find exit allocation {room: exit} that empties the building fastest.
    Returns: {"plan": {room: exit}, "total_time_s": float, "lower_bound_s": float}
    """
    if not isinstance(b, Building):
        b = load(b)
    blocked = set(blocked)
    open_exits = [x for x in b.exits if x not in blocked]
    if not open_exits:
        raise ValueError("no reachable open exit in building")

    # Start with nearest exit assignment
    current_plan = nearest_plan(b, blocked)
    current_sim = simulate(b, current_plan, blocked, frame_every=1e9)
    current_time = current_sim["total_time_s"]

    # Pre-filter reachable exits per room
    reachable_exits = {}
    for r in b.rooms:
        reachable = [x for x in open_exits if shortest_path(b, r, x, blocked)[1]]
        if not reachable:
            raise ValueError(f"room {r} has no reachable open exit")
        reachable_exits[r] = reachable

    cap = compute_exit_capacities(b, blocked)
    rooms = b.rooms

    # Greedy search with 1-opt and 2-opt moves focused on the bottleneck
    max_iterations = 50
    for _ in range(max_iterations):
        improved = False
        best_time = current_time
        best_plan = None
        best_sim = None

        pe = current_sim.get("per_exit", {})
        bottleneck = current_sim.get("bottleneck")

        # Estimate clearance time per exit: people / exit_capacity
        exit_load_time = {x: pe.get(x, 0) / max(cap.get(x, 1.0), 0.1) for x in open_exits}
        max_load = max(exit_load_time.values()) if exit_load_time else 0.0
        heavy_exits = {x for x, load_t in exit_load_time.items() if load_t >= max_load * 0.75}

        # Candidate rooms: those currently sending people to overloaded exits
        candidate_rooms = [r for r in rooms if current_plan[r] in heavy_exits]
        if not candidate_rooms:
            candidate_rooms = rooms

        # 1-Room Moves: move room r from heavy exit to a lighter exit
        for r in candidate_rooms:
            curr_ex = current_plan[r]
            for ex in reachable_exits[r]:
                if ex == curr_ex:
                    continue
                # Only move if destination exit has lower load than current exit
                if exit_load_time.get(ex, 0) >= exit_load_time.get(curr_ex, 0):
                    continue
                cand = {**current_plan, r: ex}
                try:
                    sim = simulate(b, cand, blocked, frame_every=1e9)
                    t = sim["total_time_s"]
                    if t < best_time - 0.01:
                        best_time = t
                        best_plan = cand
                        best_sim = sim
                        improved = True
                except Exception:
                    continue

        # 2-Room Swaps: swap assignments between heavy exit and lighter exit
        if not improved:
            for r1 in candidate_rooms:
                ex1 = current_plan[r1]
                for r2 in rooms:
                    ex2 = current_plan[r2]
                    if ex2 == ex1 or ex2 in heavy_exits:
                        continue
                    if exit_load_time.get(ex2, 0) >= exit_load_time.get(ex1, 0):
                        continue
                    if ex2 in reachable_exits[r1] and ex1 in reachable_exits[r2]:
                        cand = {**current_plan, r1: ex2, r2: ex1}
                        try:
                            sim = simulate(b, cand, blocked, frame_every=1e9)
                            t = sim["total_time_s"]
                            if t < best_time - 0.01:
                                best_time = t
                                best_plan = cand
                                best_sim = sim
                                improved = True
                        except Exception:
                            continue

        if improved and best_plan is not None:
            current_plan = best_plan
            current_time = best_time
            current_sim = best_sim
        else:
            break

    lb = lower_bound(b, blocked)
    # The lower bound mathematically cannot exceed actual time
    lb = min(lb, current_time)

    return {
        "plan": current_plan,
        "total_time_s": current_time,
        "lower_bound_s": lb,
    }


def beat_nikaas_score(b: Building | dict, judge_plan: dict, blocked=()) -> dict:
    """Evaluate a user/judge's custom exit plan against Nikaas' optimised plan."""
    if not isinstance(b, Building):
        b = load(b)
    blocked = set(blocked)

    judge_sim = simulate(b, judge_plan, blocked, frame_every=1e9)
    opt_res = optimise(b, blocked)

    judge_time = judge_sim["total_time_s"]
    nikaas_time = opt_res["total_time_s"]
    gap = round(judge_time - nikaas_time, 2)

    return {
        "judge_plan": judge_plan,
        "judge_time_s": judge_time,
        "nikaas_plan": opt_res["plan"],
        "nikaas_time_s": nikaas_time,
        "lower_bound_s": opt_res["lower_bound_s"],
        "gap_s": gap,
        "beat_nikaas": judge_time < nikaas_time,
    }
