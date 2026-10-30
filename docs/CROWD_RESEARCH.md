# Crowd Density Research — crush-risk thresholds

Sources opened and cited below. All thresholds are for indoor horizontal movement unless stated.

## Fruin Level of Service (LoS) — the standard reference

John J. Fruin, *Pedestrian Planning and Design* (1971), updated in SFPE Handbook.
LoS is measured in persons per square metre (p/m²):

| LoS | Density (p/m²) | Description |
|-----|---------------|-------------|
| A   | < 0.54        | Free flow; individuals freely choose speed and direction |
| B   | 0.54 – 0.91   | Slightly restricted; minor conflicts |
| C   | 0.91 – 1.35   | Restricted; speeds begin to converge |
| D   | 1.35 – 1.80   | Crowded; contact with others likely |
| E   | 1.80 – 2.70   | Speed severely restricted; shuffling gait |
| F   | > 2.70        | Breakdown; pushing and shoving begin |

**Source:** J.J. Fruin, "Designing for Pedestrians: A Level of Service Concept", *Highway Research Record* 355, 1971.
Reproduced in SFPE Handbook of Fire Protection Engineering, 5th ed., Ch. 64 (Gwynne & Rosenbaum).
https://link.springer.com/book/10.1007/978-1-4939-2565-0

## G. Keith Still — crowd safety thresholds

Keith Still (Crowd Risk Analysis, Manchester Metropolitan University) defines:

| Density (p/m²) | Risk level |
|---------------|-----------|
| > 2           | Uncomfortable; risk of falls |
| > 4           | **Crush risk** — crowd forces can exceed 4.5 kN/m (fatal compressive load) |
| > 6           | Extreme crush; recorded in disasters (Hillsborough 1989, Mecca 2015) |

**Source:** G.K. Still, "Introduction to Crowd Science", CRC Press, 2014.
https://www.gkstill.com/Support/crowd-density/

> **Correction (30 Oct 18:15, checked against the primary page).** Still's crowd-density visualisation page
> (https://www.gkstill.com/Support/crowd-density/CrowdDensity-2.html, read 30 Oct 2026) labels
> **5 people/m² "Maximum"** and **6 people/m² "High Risk"**. It does not give 4 p/m² as a crush threshold, and the
> 4.5 kN/m figure in the table above is not on that page; we could not check the book. Treat the table above as
> unverified. Our `CRUSH_THRESHOLD = 4.0` is a deliberately cautious flag of our own, set one person per square
> metre below Still's "Maximum", not a value from Still.

## UK Guide to Safety at Sports Grounds (Green Guide, 6th ed., 2018)

For stadia and spectator areas:
- Maximum standing density: **2.7 p/m²** (LoS E boundary) recommended as design cap
- Evacuation corridors: must maintain flow ≤ **1.8 p/m²** to avoid crowd pressure injuries

**Source:** UK Home Office / Sports Grounds Safety Authority, *Guide to Safety at Sports Grounds*, 6th ed., 2018.
https://sgsa.org.uk/greenguide/

## Chinnaswamy Stadium crush — 4 June 2025, Bengaluru

11 people killed and 56 injured outside M. Chinnaswamy Stadium during the RCB IPL title celebration.
Wikipedia ("2025 Bengaluru crowd crush", read 30 Oct 2026) reports crushes at **several gates: 2, 2A, 6, 7, 15,
17, 18 and 21**. We have **not** verified any density figure or a single root cause, so we state none.
(Earlier draft text about "6–7 p/m² near Gate 6" and "a single narrow gate" was removed: no source was found.)

Relevance to Nikaas: Crowd mode detects exactly this pattern — a narrow corridor near an exit
accumulates dangerous density that the nearest-exit plan does not surface.

## National Building Code of India 2016 — Part 4 (Fire and Life Safety)

Relevant provisions for crowd and exit sizing:

| Requirement | NBC 2016 Part 4 value |
|---|---|
| Minimum exit width | 1.0 m (≤ 50 persons); +300 mm per additional 50 persons |
| Travel distance to exit (unsprinklered) | ≤ 30 m |
| Travel distance to exit (sprinklered) | ≤ 45 m |
| Minimum 2 exits required | Any occupancy > 50 persons |
| Assembly occupancies (stadia, theatres) | Exit capacity: 1 exit unit = 560 mm; 1 person/unit/0.75 s |

**Source:** Bureau of Indian Standards, *National Building Code of India 2016*, Part 4: Fire and Life Safety.
https://www.bis.gov.in/

Relevance to Nikaas: in our **representative** stadium (`data/stadium_gates.json`, not a model of Chinnaswamy),
Gate South is 2.0 m wide while the south stand holds ~4 800 people. That is an assumption to illustrate the check, not a measurement.

## Threshold used in nikaas/crowd.py

```
CRUSH_THRESHOLD = 4.0  # p/m²  (our cautious flag, 1 p/m² below Still's 5 p/m² "Maximum")
CONCERN_THRESHOLD = 2.7  # p/m²  (LoS E boundary; Green Guide cap)
```

These are the values the `crush_risk` list is generated against.
At 4.0 p/m² we flag `crush` as an early warning: below Still's 5 p/m² "Maximum" and 6 p/m² "High Risk".
At 2.7 p/m² flow begins to break down; we flag it as `concern`.

The API also returns `first_crush_t` (seconds) — the earliest simulated time any edge exceeds the
crush threshold.  For the stadium model this answers: "how many seconds into a panic does Gate South
become dangerous?"  In the pitch: quote this number with its source (`runs/`).
