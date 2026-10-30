# Multi-Floor Evacuation Engine — Architecture & Contract Proposal

**Status:** Proposed architectural design and contract extension  
**Author:** Ayush V U (Nikaas Core Team)  
**Target Reviewer:** Chirag R H (Build Lead)  
**Date:** 30 October 2026  

---

## 1. Executive Summary & Context

Nikaas currently simulates single-floor evacuation digital twins using an SFPE-based hydraulic network flow model. While effective for single-level facilities (such as the IIT Kharagpur NMST museum block and single-floor lab layouts), real-world facilities—especially university academic blocks, hospitals, commercial complexes, and stadium stands—are multi-level structures.

This document proposes a backward-compatible, additive architectural extension to Nikaas enabling:
1. Multi-floor building representation with explicit vertical levels and elevations.
2. Vertical stair transitions governed by physical stair lengths and SFPE stair movement physics.
3. **Shared stairwell capacity modeling**, preventing multi-floor stairwells from multiplying physical discharge rates.
4. Floor-aware crowd tracking and visualization frames without breaking existing single-floor 2D web renderers.
5. Multi-floor routing optimization and theoretical LP quickest-flow lower bounds.
6. Comprehensive multi-floor graph quality assurance (QA).

---

## 2. Current Architecture & Limitations

### 2.1 Current Model
- A building is defined as an undirected graph $G = (V, E)$ with nodes $V$ (rooms, corridors, exits) possessing 2D plane coordinates $(x, z)$.
- Edges $E$ have clear width $w$ and length $L$, defaulting to Euclidean distance $\sqrt{(x_1 - x_2)^2 + (z_1 - z_2)^2}$.
- All nodes implicitly reside on a single datum plane ($y = 0$).

### 2.2 Key Limitations for Multi-Level Buildings
1. **Zero Elevation / Z-Axis Semantic:** Graph coordinates represent planar $(x, z)$ metres. Connecting two rooms on different storeys via 2D coordinates produces either zero or distorted horizontal distances that ignore true riser/tread travel distance.
2. **Artificial Capacity Multiplication:** In a 4-storey building, a single continuous stairwell might be modeled as 3 separate vertical edges (Floor 3 $\to$ Floor 2, Floor 2 $\to$ Floor 1, Floor 1 $\to$ Ground). If each edge is treated as an independent capacity resource with clearance rate $C$, the stairwell artificially admits $3 \times C$ persons simultaneously into the same physical stair column, severely underestimating evacuation times and masking deadly crushing bottlenecks.
3. **No Floor Attribution:** Agents cannot be isolated or viewed by floor level; frames currently emit flat $[x, z, \text{state}]$ tuples.

---

## 3. Proposed Additive JSON Contract

To preserve complete backward compatibility with all existing datasets (`sample_floor.json`, `lab_block.json`, `iit_kgp_museum.json`, and vision outputs), all multi-floor fields are strictly **optional** and additive.

### 3.1 Building-Level Schema (`floors`)
A building may optionally include a top-level `floors` array:

```json
{
  "name": "Representative Multi-Floor Academic Complex",
  "floors": [
    {
      "id": "GF",
      "name": "Ground Floor",
      "elevation_m": 0.0
    },
    {
      "id": "F1",
      "name": "First Floor",
      "elevation_m": 4.0
    },
    {
      "id": "F2",
      "name": "Second Floor",
      "elevation_m": 8.0
    }
  ],
  "nodes": [...],
  "edges": [...]
}
```

- When `floors` is omitted or empty, the building is treated as a legacy single-floor facility with a virtual default floor (`floor_id = null` or `"default"`).
- `elevation_m` defines the elevation datum of the finished floor level (FFL) in metres.

### 3.2 Node-Level Schema (`floor_id`)
Each node in `nodes[]` may specify a `floor_id`:

```json
{
  "id": "r201",
  "type": "room",
  "floor_id": "F2",
  "x": 12.0,
  "z": 8.5,
  "w": 6.0,
  "d": 5.0,
  "people": 45
}
```

- If `floors` is defined, any node referencing a `floor_id` not in `floors` is rejected during validation.
- Rooms, corridors, and exits belong to a designated floor level.
- Outdoor exits typically reside on the ground level (`elevation_m = 0.0`), but elevated external bridge exits or podium discharge exits can reside on any defined level.

### 3.3 Edge-Level Schema (`length` and `capacity_group`)
Edges connect nodes either within a floor (horizontal) or between floors (vertical stairs):

```json
{
  "from": "landing_F2_north",
  "to": "landing_F1_north",
  "width": 1.5,
  "length": 6.8,
  "kind": "stair",
  "capacity_group": "stairwell_north"
}
```

#### Rules for Horizontal Edges:
- `from` and `to` nodes must reside on the same `floor_id`.
- Permissible kinds: `"door"`, `"corridor"`.

#### Rules for Vertical Edges:
- Must have `kind: "stair"`.
- Must connect landing/corridor nodes on different floors.
- **Mandatory explicit `length`:** Because 2D coordinates of stacked stair landings often coincide ($x_1 \approx x_2, z_1 \approx z_2$), `length` must be explicitly provided in metres (representing true diagonal flight distance along the pitch line plus intermediate landings). It must NOT default to 2D Euclidean distance.
- **Optional `capacity_group`:** Identifies the physical shaft/stairwell enclosure to which this segment belongs. All segments sharing the same `capacity_group` share a coupled admission capacity.

#### Elevators:
- Elevators are strictly excluded from evacuation routing per standard fire safety guidelines (e.g., NBC 2016 Part 4 Clause 4.4.2.4 & NFPA 101). They must not be modeled as evacuation edges.

---

## 4. Stairwell Capacity-Sharing Design

### 4.1 The Physical Problem
In multi-storey buildings, evacuees from upper floors descend through continuous vertical stair enclosures. At each intermediate floor, occupants entering from that floor merge with the descending flow already in the stairwell.

If Floor 2 $\to$ Floor 1 has capacity $C$ (persons/s) and Floor 1 $\to$ Ground has capacity $C$, treating them as uncoupled edges allows Floor 2 to discharge $C$ into Floor 1 while Floor 1 simultaneously discharges $C$ from its own rooms into Ground. This creates an unphysical instantaneous throughput through the stairwell.

### 4.2 Shared-Resource Mathematical Formulation
For each `capacity_group` $g \in G_{\text{stair}}$:
1. **Bottleneck Width & Discharge Rate:**
   The maximum throughput $C_g$ of the stairwell group is governed by its narrowest segment:
   $$w_{\text{eff}, g} = \min_{e \in g} \max(0.3, w_e - 2 \cdot B_{\text{stair}})$$
   $$C_g = w_{\text{eff}, g} \times F_{s, \text{stair}}$$
   where $F_{s, \text{stair}} = 1.012 \text{ persons/s/m}$ and $B_{\text{stair}} = 0.15 \text{ m}$ (SFPE).

2. **Group Credit Accumulator:**
   The simulator tracks a shared capacity credit $\text{credit}_g$ for the group:
   $$\text{credit}_g \leftarrow \text{credit}_g + C_g \times \Delta t$$

3. **Admission & Internal Continuity Priority:**
   To prevent internal congestion and gridlock on intermediate landings:
   - **Internal descending transit** (people already in the stairwell progressing from one flight to the next) is given continuity priority over new arrivals trying to enter from intermediate floor corridors.
   - Entry from floor corridors into the stairwell group consumes 1.0 credit from $\text{credit}_g$.
   - This accurately reproduces physical stairwell entry resistance and prevents artificial queue teleportation.

---

## 5. Simulation Engine Extensions

1. **Vertical Speed:** People on stair edges move at $\text{STAIR\_SPEED} = 0.915 \text{ m/s}$ along the edge's explicit physical `length`.
2. **Floor Transition Semantics:**
   - While walking horizontal edges on floor $F$, an agent's floor identity is $F$.
   - While descending a stair edge from $F_{\text{from}}$ to $F_{\text{to}}$, the agent's elevation interpolates smoothly:
     $$y(t) = y(F_{\text{from}}) + \frac{s}{L_{\text{stair}}} \left(y(F_{\text{to}}) - y(F_{\text{from}})\right)$$
   - The agent transitions their discrete floor attribution to $F_{\text{to}}$ upon reaching the destination landing.
3. **Additive Frame Schema:**
   - `frames[i].people`: retains `[[x, z, state], ...]` for backward compatibility with existing 2D renderers.
   - `frames[i].people_3d`: optional additive list `[[x, y, z, state, floor_id], ...]` providing full 3D coordinates and floor tags.
   - `per_floor`: summary object returning completed evacuee counts, initial occupants, and clearance times per floor.

---

## 6. Optimiser & LP Lower Bound Extensions

### 6.1 Multi-Floor Greedy Search
- Upper-floor rooms evaluate shortest paths through all available stairwells and ground-floor exits.
- Candidate plans $\{r \mapsto x\}$ are simulated on the full multi-floor model.

### 6.2 Extended Quickest-Flow Linear Program (LP)
The LP lower bound in `nikaas/optimise.py` is extended with stairwell capacity constraints:
- Let $y_{r, x}$ be the number of occupants of room $r$ assigned to exit $x$.
- For each stairwell group $g$, let $R_g$ be the set of rooms whose path to exit $x$ traverses stairwell $g$.
- Then the flow through stairwell $g$ must satisfy:
  $$\frac{\sum_{r \in R_g} y_{r, x}}{C_g} + \min_{r \in R_g} t_{\text{walk}}(r, g) \le T$$
- Because this constraint reflects a physical necessary condition for any evacuation plan, adding it ensures the LP remains a strictly valid **mathematical lower bound** while significantly tightening the bound on multi-storey structures.

---

## 7. Graph Quality Assurance (QA) Extensions

New automated QA checks:
1. `UNKNOWN_FLOOR_REFERENCE`: Node references a `floor_id` not in `floors`.
2. `CROSS_FLOOR_HORIZONTAL_EDGE`: A corridor or door edge connects nodes on different floors.
3. `STAIR_MISSING_LENGTH`: A cross-floor stair edge is missing explicit `length`.
4. `STAIR_INVALID_PHYSICAL_LENGTH`: Stair length $\le$ vertical elevation difference or $\le 0$.
5. `OCCUPIED_FLOOR_DISCONNECTED`: An occupied floor has no stair route to ground exits.
6. `INCONSISTENT_CAPACITY_GROUP`: Capacity group contains non-stair edges or disconnected segments.

---

## 8. Synthetic Multi-Floor Benchmark Specification

A representative 3-floor synthetic office building (`data/multi_floor_office.json`):
- **Ground Floor (GF):** 2 outdoor exits (North Exit 2.0 m, South Exit 2.0 m), central reception, 2 stairwell discharge lobbies.
- **First Floor (F1):** 4 rooms (120 people), corridors, access to North Stairwell and South Stairwell.
- **Second Floor (F2):** 4 rooms (160 people), corridors, access to North Stairwell and South Stairwell.
- **Total Occupancy:** 280 people.
- **Stairwells:** 
  - North Stair (1.5 m width, capacity group `"stair_north"`).
  - South Stair (1.2 m width, capacity group `"stair_south"`).

---

## 9. Contract Change Request for Build Lead

```text
To: Chirag R H (Build Lead)
From: Ayush V U (Optimiser & Multi-Floor Feature)
Subject: Request for Additive Multi-Floor Contract Extension

Hi Chirag,
For the multi-floor evacuation engine, we have designed a strictly additive extension to docs/CONTRACT.md:
1. Top-level optional "floors": [{"id", "name", "elevation_m"}]
2. Node optional "floor_id": string
3. Edge optional "capacity_group": string
4. Vertical edges require kind="stair" and explicit "length" (m).
5. Output frames retain existing "people": [[x, z, state]] while adding optional "people_3d": [[x, y, z, state, floor_id]] and "per_floor" metrics.

All existing single-floor datasets and tests remain 100% valid and unchanged.
Until formal approval, docs/CONTRACT.md remains frozen, and the full multi-floor specification is maintained in docs/MULTI_FLOOR_DESIGN.md.
```
