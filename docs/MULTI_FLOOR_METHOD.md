# Multi-Floor Evacuation Modeling Methodology

**Nikaas Engineering Documentation**  
**Standards & References:** SFPE Handbook of Fire Protection Engineering (5th Ed., Ch. 56), SFPE Engineering Guide to Human Behavior in Fire, National Building Code of India (NBC 2016 Part 4).

---

## 1. Scope & Objective

This document defines the mathematical, physical, and computational methodology governing multi-floor evacuation modeling in Nikaas. It formalizes:
1. Multi-level building topology and finished floor elevation datums.
2. Vertical pedestrian kinematics along stair flights.
3. Coupled stairwell discharge physics via shared capacity grouping.
4. Quickest-flow Linear Programming (LP) lower bounds under multi-floor shaft constraints.
5. Algorithmic evacuation optimization across multi-level egress pathways.

---

## 2. Graph Topology & Geometric Conventions

### 2.1 Multi-Storey Graph Definition
A multi-floor building is modeled as a unified topological network $G = (V, E, \Phi)$, where:
- $\Phi = \{F_1, F_2, \dots, F_k\}$ is an ordered set of floor levels, each characterized by a stable identifier $\text{id}$, display name, and elevation datum $y \in \mathbb{R}$ in metres above building datum ($y = 0.0\text{ m}$).
- $V$ is the set of topological nodes (rooms, corridors, stair landings, and outdoor exits). Every node $v \in V$ possesses planar coordinates $(x_v, z_v) \in \mathbb{R}^2$ and a designated floor assignment $\text{floor\_id}(v) \in \Phi$.
- $E$ is the set of directed/undirected edges connecting node pairs.

### 2.2 Horizontal vs. Vertical Edges
Edges are classified based on the floor assignments of their endpoints:
1. **Horizontal Edges ($u, v$ on the same floor):**
   - Connect spaces within a single level ($y_u = y_v$).
   - Permissible kinds: `"door"`, `"corridor"`.
   - Length defaults to planar Euclidean distance:
     $$L_{\text{horiz}} = \sqrt{(x_u - x_v)^2 + (z_u - z_v)^2}$$
2. **Vertical Stair Edges ($u, v$ on different floors):**
   - Connect landing nodes across consecutive levels ($\text{floor\_id}(u) \ne \text{floor\_id}(v)$).
   - Must have `kind: "stair"`.
   - **Mandatory Explicit Physical Length ($L_{\text{stair}}$):** Vertical stair shafts typically stack directly above one another in floor plans ($x_u \approx x_v, z_u \approx z_v$). Using planar distance would yield near-zero travel times. Therefore, $L_{\text{stair}}$ must be explicitly specified as the actual diagonal pitch-line walking distance along the stair treads plus intermediate landings.

### 2.3 Exclusion of Elevators
Per standard international life-safety codes (NBC 2016 Part 4 Clause 4.4.2.4; NFPA 101 Clause 7.2.12), passenger elevators are recalled to ground level upon fire alarm and are strictly prohibited as primary emergency egress routes. Elevators are excluded from Nikaas evacuation routing.

---

## 3. Vertical Pedestrian Kinematics

### 3.1 Movement Speeds
Nikaas implements standard SFPE hydraulic egress constants:
- **Horizontal Walk Speed:** $v_{\text{walk}} = 1.19\text{ m/s}$ (3.9 ft/s).
- **Stair Descent Speed:** $v_{\text{stair}} = 0.915\text{ m/s}$ ($0.85 \times 212\text{ ft/min} = 3.00\text{ ft/s}$ along standard 7/11-inch institutional stair risers/treads under unimpeded maximum flow conditions).

### 3.2 Effective Width & Flow Capacities
In accordance with the boundary layer concept (SFPE Engineering Guide Example 1; Gwynne & Rosenbaum):
- Boundary layer deduction: $B_{\text{stair}} = 0.15\text{ m}$ on each side (total deduction $2B = 0.30\text{ m}$).
- Effective clear width:
  $$w_{\text{eff}} = \max(0.3\text{ m}, w - 2 B_{\text{stair}})$$
- Specific flow rate: $F_{s, \text{stair}} = 1.012\text{ persons/s/m of effective width}$ ($18.5\text{ persons/min/ft}$).
- Edge clearance capacity:
  $$C_e = w_{\text{eff}} \times F_{s, \text{stair}} \quad [\text{persons/second}]$$

---

## 4. Shared Stairwell Capacity Model

### 4.1 The Physical Hydraulic Problem
In a multi-level structure, a vertical stairwell comprises multiple sequential flight segments (e.g., Level 3 $\to$ Level 2, Level 2 $\to$ Level 1, Level 1 $\to$ Ground). If each flight is modeled as an independent capacity resource, an uncoupled simulator admits flow into each flight independently. In a 5-storey building, this would permit $4 \times C_e$ persons to enter the shaft concurrently, creating an unphysical 400% throughput multiplication that masks severe crush bottlenecks on lower landings.

### 4.2 Mathematical Shared-Resource Formulation
All flight segments belonging to the same physical shaft are tagged with a common `capacity_group` $g$:
1. **Bottleneck Shaft Capacity:**
   The aggregate discharge throughput of the stairwell is governed by its narrowest constriction:
   $$w_{\text{eff}, g} = \min_{e \in g} \max(0.3\text{ m}, w_e - 2 B_{\text{stair}})$$
   $$C_g = w_{\text{eff}, g} \times F_{s, \text{stair}}$$
2. **Fair Admission & Landing Zipper Merge:**
   To prevent upper-floor continuous streams from starving lower floors, the simulator implements a deterministic two-tier fair scheduler:
   - **Independent Flight Capacity:** Each stair flight edge $k$ accumulates credit $\text{credit}_k \leftarrow \text{credit}_k + C_k \times \Delta t$.
   - **Shaft Entrance Quota:** External admissions across all floor doors consume shared group credit $\text{group\_credit}_g \leftarrow \text{group\_credit}_g + C_g \times \Delta t$.
   - **Fair Multi-Floor Round-Robin:** External admissions rotate among waiting floor queues via a circular round-robin pointer $\text{group\_rr\_ptr}_g$, ensuring equal opportunity for occupants on every level.
   - **1:1 Landing Zipper Merge:** At intermediate floor landings where descending traffic meets floor door entrants, a deterministic alternating toggle (`landing_toggle`) alternates 1:1 between internal descending evacuees and floor door entrants. Neither flow stream can monopolize the descending flight or starve the other.

---

## 5. Multi-Floor Quickest-Flow LP Lower Bound

The theoretical quickest-flow Linear Program in `nikaas/optimise.py` computes an unassailable mathematical lower bound on evacuation time:

$$\min T$$
subject to:
1. **Occupant Conservation:**
   $$\sum_{x \in X} y_{r, x} = N_r \quad \forall r \in R$$
2. **Exit Discharge Capacity:**
   $$\sum_{r \in R} \frac{y_{r, x}}{C_x} + \min_{r} t_{\text{walk}}(r, x) \le T \quad \forall x \in X$$
3. **Stairwell Group Shaft Capacity with Multi-Door Distribution:**
   In real buildings and in `nikaas/sim.py`, rooms with multiple doors divide their occupants across all usable doors in proportion to door widths ($w_d / \sum w$). When doors lead to distinct stairwell shafts, the flow divides proportionally. For each stairwell group $g$ and room-exit pair $(r, x)$:
   $$\alpha_{r, x, g} = \frac{\sum_{d \in \text{doors}(r, x) \text{ using } g} w_d}{\sum_{d \in \text{doors}(r, x)} w_d}$$
   The stairwell cut enforces:
   $$\sum_{r, x} \alpha_{r, x, g} \frac{y_{r, x}}{C_g} + \min_{(r, x) : \alpha > 0} t_{\text{walk}}(r, g) \le T \quad \forall g \in G_{\text{stair}}$$
   - Single-door rooms: $\alpha_{r, x, g} \in \{0.0, 1.0\}$ (exact single-path assignment).
   - Multi-door rooms: $\alpha_{r, x, g}$ reflects the exact proportional door split, preventing unphysical over-constraining of single shafts.
4. **Minimum Walk Time:**
   $$y_{r, x} \frac{t_{\text{walk}}(r, x)}{N_r} \le T \quad \forall (r, x)$$

Because constraints (2), (3), and (4) represent necessary physical flow relaxations of the simulation mechanics:
$$T^* \le T_{\text{actual}}(\text{plan}) \quad \forall \text{ valid plans}$$
This lower-bound guarantee is strictly proven and mathematically verified under all single-door, multi-door, and multi-stairwell configurations.

---

## 6. What Evacuation Movement Time Means (and What It Does Not)

### 6.1 Movement Time vs. Required Safe Escape Time (RSET)
Nikaas strictly computes **evacuation movement time**:
$$\text{Total Time} = t_{\text{movement}}$$

In full fire safety engineering (SFPE Handbook Ch. 56; BSI PD 7974-6:2019), total Required Safe Egress Time comprises:
$$\text{RSET} = t_{\text{detection}} + t_{\text{alarm}} + t_{\text{pre-movement}} + t_{\text{movement}}$$

Nikaas optimizes the exit allocation and wayfinding plan. Because detection and alarm times depend on hardware sensor infrastructure and pre-movement varies with human training and behavioral factors, Nikaas focuses on the hydraulic movement phase where route choice directly saves lives.

### 6.2 Regulatory Disclaimer
> [!IMPORTANT]
> Nikaas is a digital twin simulation and optimization engine designed for engineering analysis, operational planning, and comparative route assessment. It does **not** constitute a formal National Building Code (NBC) certification, life-safety certification, or statutory occupancy license. Real emergency egress is subject to environmental smoke movement, fire barrier ratings, structural integrity, and human factors.
