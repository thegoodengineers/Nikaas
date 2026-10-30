# Nikaas Platform: sites, check-in, alerts, personal routes, control room

The building-safety layer on top of the planner. People scan a QR code when they enter a building, get a
push alert when the alarm goes off, follow their own route out, and mark themselves safe at the assembly
point. A control room sees everyone, raises and clears alarms, adds hazards and watches crowding.

All endpoints are on the same API as `/simulate` (`nikaas/api.py`). JSON in, JSON out.
Control endpoints need the header `x-control-key: <key>` when the server has `NIKAAS_CONTROL_KEY` set
(local runs without it are open). A wrong or missing key returns 401.

## Site

A site is a building graph (`docs/CONTRACT.md`, multi-floor fields from `docs/MULTI_FLOOR_DESIGN.md`)
plus where it is in the world and where people gather outside.

```json
{
  "id": "office",
  "name": "Block C, three-storey office",
  "address": "optional free text",
  "demo": true,
  "building": { "name": "...", "floors": [...], "nodes": [...], "edges": [...] },
  "geo": { "lat": 19.0784, "lng": 72.8814, "rotation_deg": 0 },
  "assembly": [
    { "id": "A1", "label": "Assembly A · North car park", "x": 10, "z": -20, "exits": ["exit_north"], "lat": null, "lng": null }
  ],
  "updated_at": 1793350000.0
}
```

- `geo` is the building's origin (x = 0, z = 0) on the map; +x is east and +z is south when `rotation_deg` is 0.
  `null` until someone sets it in the control room. Building units are metres.
- `assembly[].lat/lng` are explicit when set; otherwise they are derived from `geo` and `x/z`.
- Single-floor buildings have no `floors`; their nodes have no `floor_id`.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/sites` | | `[{id, name, address, demo, floors, rooms, exits, people, geo}]` |
| GET | `/sites/{id}` | | the site |
| POST | `/sites` (key) | a site (no `id` = new id from the name) | the saved site |
| POST | `/sites/{id}/geo` (key) | `{geo?, assembly?}` | the saved site |
| POST | `/plans/link-floors` | `{building, tolerance_m?: 4}` | `{building, links: [{from, to, group}]}` stair edges added between floors |

## People (the phone)

A phone makes a random `token` once (uuid, kept in localStorage). No names. Records expire 24 h after the
last update.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/sites/{id}/checkin` | `{token, room?, gate?}` | `Me` |
| POST | `/sites/{id}/checkout` | `{token}` | `{ok}` |
| GET | `/sites/{id}/me?token=` | | `Me` (phones poll every 4 s while open) |
| POST | `/sites/{id}/status` | `{token, status: "safe"\|"help"\|"inside", need?: "stairs"\|"medical"\|"trapped", lat?, lng?, accuracy?}` | `Me` |
| POST | `/sites/{id}/push` | `{token, subscription}` (browser PushSubscription JSON) | `{ok}` |
| GET | `/push/key` | | `{public_key}` (VAPID, base64url) |

```json
// Me
{
  "site": {"id": "office", "name": "...", "floors": [{"id": "GF", "name": "Ground Floor"}]},
  "person": {"token": "...", "room": "r_F2_1", "room_label": "Room 2.1", "floor": "F2", "status": "inside",
             "need": null, "checked_in_at": 0, "updated_at": 0, "safe_verified": null},
  "alarm": null | {"id": "a1", "type": "fire"|"earthquake"|"collapse"|"gas"|"drill"|"other", "message": "",
                   "started_at": 0, "origin": "r_F1_2", "version": 3},
  "route": null | {
    "mode": "exit" | "refuge",
    "exit": "exit_north", "exit_label": "North Exit", "group": "B", "group_color": "#f59e0b",
    "distance_m": 41.5, "walk_s": 38, "wave": 0, "release_at": 0,      // phased release: leave at started_at + release_at
    "path": ["r_F2_1", "stair_north_F2", "..."],
    "steps": [{"text": "Leave Room 2.1 by the door on your left", "floor": "F2", "node": "r_F2_1", "kind": "start"|"walk"|"turn"|"stairs"|"exit"|"outside"|"refuge", "distance_m": 4}],
    "assembly": {"id": "A1", "label": "...", "lat": 0, "lng": 0} | null,
    "changed": false            // true once when the route moved since this phone last asked
  },
  "hazards": [{"id": "h1", "kind": "fire", "node": "corr_F1_mid", "floor": "F1", "label": "Corridor, First Floor"}],
  "map": {"nodes": [[id, type, x, z, w, d, floor_id]], "edges": [[from, to, kind]]},
  "version": 3
}
```

## Alarm, hazards, sensors, cameras (control room)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/sites/{id}/alarm` (key) | `{type, message?, origin?, phased?: false, wave_gap_s?: 60}` | `Control` |
| DELETE | `/sites/{id}/alarm` (key) | | `Control` (all clear pushed) |
| POST | `/sites/{id}/hazards` (key) | `{kind: "fire"\|"smoke"\|"heat"\|"collapse"\|"blocked", node, source?: "manual"\|"sensor"\|"camera", confidence?}` | `Control` |
| DELETE | `/sites/{id}/hazards/{hid}` (key) | | `Control` |
| POST | `/sites/{id}/sensors` (key) | `{sensor_id, node, temp_c?, smoke?: 0..1}` | `{hazard?: id, Control}` |
| POST | `/sites/{id}/cameras` (key) | `{camera_id, node, people?, fire?: 0..1, smoke?: 0..1, image?: base64 jpeg}` | `{confirmed?, hazard?, Control}` |
| GET | `/sites/{id}/control` (key) | | `Control` (dashboards poll every 3 s) |

Rules:
- A hazard blocks its node for routing; everyone is re-planned; phones whose route changed get a push.
- Sensor: `temp_c >= 57` (fixed-temperature heat detector rating) or `smoke >= 0.5` raises a hazard at its node,
  and starts a fire alarm if none is running.
- Camera: `fire >= 0.6` or `smoke >= 0.6` from the browser's quick check is confirmed by Amazon Rekognition
  when `image` is sent (labels Fire, Flame, Smoke); confirmed = hazard (+ alarm). `people` is the camera's
  head count for that node (used for occupancy and density).
- Phased release (`phased: true`): the incident floor and the floor above leave first, then the other floors
  in waves `wave_gap_s` apart (phased evacuation, BS 9999). Single-floor buildings ignore it.
- Divert: when one exit's estimated clearing time is over 1.5 x the best exit's and over 60 s, rooms are moved
  to other exits and their phones are told.
- Density per room (people / floor area) and per camera node: early-warning flags `concern` at 2.7 p/m² and `crush` (warning) at 4.0 p/m²
  (`docs/CROWD_RESEARCH.md`).

```json
// Control
{
  "site": {...}, "alarm": null | {...},
  "counts": {"checked_in": 0, "inside": 0, "safe": 0, "help": 0, "missing": 0},
  "floors": [{"id": "F2", "name": "...", "inside": 0, "safe": 0, "help": 0}],
  "rooms": {"r_F2_1": {"label": "...", "floor": "F2", "people": 0, "planned": 30, "camera": null, "area_m2": 30, "density": 0, "level": "ok"|"concern"|"crush"}},
  "people": [{"token": "ab12", "room": "...", "floor": "...", "status": "...", "need": null, "updated_at": 0, "exit": "...", "group": "A", "safe_verified": true}],
  "help": [...same shape, status help...],
  "missing": [...inside, alarm running, not safe...],
  "hazards": [{"id": "h1", "kind": "fire", "node": "...", "floor": "...", "label": "...", "source": "sensor", "at": 0}],
  "exits": [{"id": "...", "label": "...", "group": "A", "color": "#22d3ee", "assigned": 12, "out": 3, "eta_s": 40, "rooms": ["..."], "blocked": false}],
  "waves": [{"wave": 0, "floors": ["F1", "F2"], "release_at": 0}],
  "sensors": [{"sensor_id": "...", "node": "...", "temp_c": 24, "smoke": 0, "at": 0}],
  "cameras": [{"camera_id": "...", "node": "...", "people": 3, "fire": 0, "smoke": 0, "at": 0}],
  "events": [{"at": 0, "kind": "info"|"warn"|"danger"|"good", "text": "..."}],
  "version": 0
}
```

## QR codes

- Entrance: `<site url>/#/go?site=<id>&gate=<exit id>`. Scanning it while already checked in asks "Leaving?".
- Room sticker: `<site url>/#/go?site=<id>&room=<room id>`.
The control room prints both (A4 poster per entrance, a sheet of room stickers).

## Storage

`nikaas/store.py`: one DynamoDB table (`NIKAAS_TABLE`) keyed `pk` = `SITE#<id>`, `sk` = `META` | `P#<token>` |
`ALARM` | `HAZ#<id>` | `SENSOR#<id>` | `CAM#<id>` | `EVENT#<time>`; local runs keep the same items in memory.
Push needs HTTPS: the site is served through CloudFront.
