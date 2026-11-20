"""Time-expanded quickest-flow lower bound on evacuation time.

Ford and Fulkerson's flows over time (Oper. Res. 6(3), 1958) and the quickest transshipment problem
(Hoppe and Tardos, Math. Oper. Res. 25(1), 2000): copy the building graph once per time step of dt seconds.
An edge e of travel time L_e / v_e becomes arcs (u, t) -> (w, t + tau_e) that carry at most c_e * dt people
per step, and people may wait at any node. The smallest horizon H in which every occupant can reach an
exit is a lower bound on the movement time of ANY plan, because each simplification only adds freedom:

- travel times are rounded DOWN to whole steps, and people may split freely across routes and exits;
- per-step capacities are rounded UP, waiting is free and queues are unbounded;
- the shared entry capacity of a stairwell is not applied (each flight keeps its own capacity).

Unlike lower_bound() in optimise.py, which only limits exits and stairwells, every door, corridor and stair
limits the flow here, so the bound is much tighter when an internal corridor is the bottleneck.
"""
import math

import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import maximum_flow

from .building import Building, load
from .sim import STAIR_SPEED, WALK_SPEED, SPECIFIC_FLOW, effective_width

SCALE = 1000  # people are scaled to integers for the integer max-flow solver


def _arcs(b: Building, blocked, dt):
    """Directed arcs (u, w, tau_steps, cap_per_step_scaled) between open nodes, both directions."""
    arcs = []
    for e in b.edges:
        if e.a in blocked or e.b in blocked:
            continue
        speed = STAIR_SPEED if e.kind == "stair" else WALK_SPEED
        tau = int(math.floor(e.length / speed / dt + 1e-9))
        cap = int(math.ceil(effective_width(e) * SPECIFIC_FLOW[e.kind] * dt * SCALE - 1e-9))
        arcs += [(e.a, e.b, tau, cap), (e.b, e.a, tau, cap)]
    return arcs


def _max_flow(b: Building, blocked, dt, horizon, arcs, supply):
    """Max flow (scaled people) that reaches an open exit within `horizon` steps."""
    nodes = [n for n in b.nodes if n not in blocked]
    idx = {n: i for i, n in enumerate(nodes)}
    layers = horizon + 1
    nid = lambda n, t: idx[n] * layers + t
    S, Z = len(nodes) * layers, len(nodes) * layers + 1
    rows, cols, caps = [], [], []
    big = sum(supply.values()) + 1
    for n in nodes:  # waiting in place
        i = idx[n] * layers
        rows += range(i, i + horizon); cols += range(i + 1, i + layers); caps += [big] * horizon
    for u, w, tau, cap in arcs:
        if tau > horizon:
            continue
        iu, iw = idx[u] * layers, idx[w] * layers
        n_t = horizon - tau + 1
        rows += range(iu, iu + n_t); cols += range(iw + tau, iw + tau + n_t); caps += [cap] * n_t
    for r, q in supply.items():
        rows.append(S); cols.append(nid(r, 0)); caps.append(q)
    for x in b.exits:
        if x not in blocked:
            rows.append(nid(x, horizon)); cols.append(Z); caps.append(big)
    g = csr_matrix((np.array(caps, dtype=np.int64).clip(max=2**31 - 1).astype(np.int32),
                    (np.array(rows), np.array(cols))), shape=(Z + 1, Z + 1))
    g.sum_duplicates()
    return maximum_flow(g, S, Z).flow_value


def time_expanded_bound(b: Building | dict, blocked=(), dt: float = 1.0, upper: float | None = None) -> float:
    """Lower bound (s) on the movement time of any exit plan. `upper` is any known achievable time
    (for example the nearest-exit simulation); it only narrows the search."""
    if not isinstance(b, Building):
        b = load(b)
    blocked = set(blocked)
    supply = {r: q * SCALE for r, q in b.people().items() if q > 0 and r not in blocked}
    need = sum(supply.values())
    if need == 0:
        return 0.0
    if not any(x not in blocked for x in b.exits):
        raise ValueError("no reachable open exit in building")
    arcs = _arcs(b, blocked, dt)
    hi = int(math.ceil((upper if upper else 600.0) / dt)) + 2
    while _max_flow(b, blocked, dt, hi, arcs, supply) < need:  # grow until feasible
        hi *= 2
        if hi * dt > 36000:
            raise ValueError("time-expanded bound did not converge (unreachable occupants?)")
    lo = 0  # infeasible horizon
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if _max_flow(b, blocked, dt, mid, arcs, supply) >= need:
            hi = mid
        else:
            lo = mid
    # a real schedule finishing at time T fits in ceil(T / dt) steps, so T >= (hi - 1) * dt
    return round(max(0.0, (hi - 1) * dt), 2)
