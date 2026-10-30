"""HTTP API (FastAPI). Run locally: uvicorn nikaas.api:app --reload
Contract: docs/CONTRACT.md. Abhijeet wraps this for Lambda (Mangum) in the SAM template."""
import base64
import binascii
import json
import os
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel

from .building import load, nearest_plan, validate
from .crowd import analyse as crowd_analyse
from .graph_qa import analyze_graph
from .optimise import optimise
from .sim import simulate

app = FastAPI(title="Nikaas")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
# frames are large (5 MB for 528 people over 7 min); gzip keeps responses far below the 6 MB Lambda limit
app.add_middleware(GZipMiddleware, minimum_size=1000)


class SimRequest(BaseModel):
    building: dict
    plan: dict | None = None  # room -> exit; null = nearest open exit
    blocked: list[str] = []
    frame_every: float = 1.0  # seconds of simulated time between frames (bigger = smaller response)
    crowd: bool = False  # run the crowd-density analysis too (slower; off for interactive tap-to-block)
    compliance: float = 1.0  # fraction of occupants who follow the plan (0-1); rest take nearest exit
    # preset profiles override compliance: "guidance" = 0.9, "mixed" = 0.65, "panic" = 0.3
    profile: str | None = None  # "guidance" | "mixed" | "panic" | null
    wheelchair_fraction: float = 0.0  # fraction who need stair-free routes; routed to refuge if none exists

_PROFILES = {"guidance": 0.9, "mixed": 0.65, "panic": 0.3}


class OptimiseRequest(BaseModel):
    building: dict
    blocked: list[str] = []
    simulate: bool = False  # also return the simulated run of the plan (one round trip for the website)
    frame_every: float = 1.0  # frames in that run, as in /simulate (large buildings need 5 to fit a response)


try:  # AWS Lambda entry point (template.yaml points at nikaas.api.handler)
    from mangum import Mangum

    handler = Mangum(app)
except ImportError:  # local runs do not need mangum
    handler = None


@app.get("/health")
def health():
    # lists the POST routes this deployment serves, so a stale deploy is obvious (e.g. no "optimise")
    routes = sorted(r.path.strip("/") for r in app.routes if "POST" in getattr(r, "methods", set()))
    return {"ok": True, "routes": routes}


class BuildingRequest(BaseModel):
    building: dict


@app.post("/validate")
def check(req: BuildingRequest):
    probs = validate(req.building)
    return {"ok": not probs, "problems": probs}


@app.post("/qa")
def graph_qa(req: BuildingRequest):
    """Evaluate structural, topological, and geometric graph quality."""
    return analyze_graph(req.building)


@app.post("/simulate")
def run(req: SimRequest):
    probs = validate(req.building)
    if probs:
        raise HTTPException(422, {"problems": probs})
    try:
        b = load(req.building)
        blocked = set(req.blocked)
        plan = req.plan or nearest_plan(b, blocked)
        compliance = _PROFILES.get(req.profile, req.compliance) if req.profile else req.compliance
        compliance = max(0.0, min(1.0, compliance))
        wc = max(0.0, min(1.0, req.wheelchair_fraction))
        out = simulate(b, plan, blocked, frame_every=max(0.25, req.frame_every), compliance=compliance,
                       wheelchair_fraction=wc)
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))
    out["plan"] = plan
    out["profile"] = req.profile or "custom"
    # crowd density analysis: crush-risk on every corridor/door edge over time (only when asked: it doubles the cost)
    if req.crowd:
        try:
            out["crowd"] = crowd_analyse(out, req.building)
        except Exception:  # never fail /simulate because of crowd analysis
            out["crowd"] = None
    return out


@app.post("/optimise")
def run_optimise(req: OptimiseRequest):
    probs = validate(req.building)
    if probs:
        raise HTTPException(422, {"problems": probs})
    try:
        b = load(req.building)
        out = optimise(b, set(req.blocked))
        if req.simulate:
            run = simulate(b, out["plan"], set(req.blocked), frame_every=max(0.25, req.frame_every))
            run["plan"] = out["plan"]
            out["run"] = run
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))
    return out

class VisionRequest(BaseModel):
    image: str  # base64 photo (png/jpeg/webp), with or without a "data:image/...;base64," prefix
    width_m: float = 80.0  # the building's real east-west length in metres (photos have no scale)
    name: str | None = None


MAX_PHOTO = 3_750_000  # Bedrock's image size limit (bytes)


def photo_format(b):
    if b[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if b[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if b[:4] == b"RIFF" and b[8:12] == b"WEBP":
        return "webp"
    return None


def save(key, body, content_type):
    """Keep uploads and results in the photo bucket (set on Lambda by template.yaml; skipped locally)."""
    bucket = os.environ.get("PHOTO_BUCKET")
    if not bucket:
        return None
    import boto3

    boto3.client("s3").put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
    return key


@app.post("/vision")
def vision(req: VisionRequest):
    """Photo of a floor plan -> building graph (docs/CONTRACT.md). Takes ~15-20 s (Amazon Bedrock)."""
    from .vision import read_map

    data = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
    try:
        img = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "image must be base64")
    fmt = photo_format(img)
    if not fmt:
        raise HTTPException(415, "photo must be PNG, JPEG or WebP")
    if len(img) > MAX_PHOTO:
        raise HTTPException(413, f"photo is {len(img) / 1e6:.1f} MB; max 3.75 MB (resize it first)")
    if not 5 <= req.width_m <= 2000:
        raise HTTPException(422, "width_m must be the building length in metres (5-2000)")
    try:
        building, probs = read_map(img, fmt, width_m=req.width_m, name=req.name or "building from photo")
    except Exception as e:  # Bedrock down, throttled or no access: say so instead of a bare 500
        raise HTTPException(502, f"vision service failed: {type(e).__name__}: {e}")
    rid = uuid.uuid4().hex[:12]
    stored = None
    try:
        stored = save(f"photos/{rid}.{fmt}", img, f"image/{fmt}")
        save(f"results/{rid}.json", json.dumps({"building": building, "problems": probs}), "application/json")
    except Exception:  # storage is for our records; never fail the user's request over it
        stored = None
    qa_report = building.get("vision", {}).get("qa") or analyze_graph(building)
    return {"ok": not probs, "id": rid, "building": building, "problems": probs, "quality": qa_report, "photo_key": stored}


# ---- Live drill: presenter controls, phones follow (nikaas/drill.py) ----
from . import drill as drill_state  # noqa: E402


class DrillStart(BaseModel):
    building: dict
    blocked: list[str] = []
    reset: bool = False  # start over: update #1, no fires, no alerts (a clean drill before the pitch)


@app.post("/drill")
def drill_start(req: DrillStart):
    """Presenter: start or update the drill (block exits); the optimiser re-plans every room."""
    probs = validate(req.building)
    if probs:
        raise HTTPException(422, {"problems": probs})
    try:
        return drill_state.public(drill_state.start(req.building, req.blocked, None if req.reset else drill_state.read()))
    except (KeyError, ValueError) as e:
        raise HTTPException(422, str(e))


@app.get("/drill")
def drill_get(room: str | None = None, since: int = 0, accessible: bool = False):
    """Phones: current drill state; with ?room= only that room's instruction. ?since=<version> lets a phone
    tell whether anything changed. ?accessible=true filters to stair-free routes (for mobility-impaired users)."""
    s = drill_state.read()
    if not s:
        raise HTTPException(404, "no drill running")
    s = drill_state.public(s)
    if room is None:
        return s
    if room not in s["rooms"]:
        raise HTTPException(404, f"unknown room {room}")
    room_data = s["rooms"][room]
    if accessible and not room_data.get("accessible", True):
        room_data = {**room_data, "needs_assistance": True,
                     "guidance": "Please wait at the nearest refuge point or stairwell landing for assistance."}
    return {"version": s["version"], "updated": s["version"] > since, "room": room,
            "room_label": s["room_labels"].get(room, room),
            "blocked": s["blocked"], "blocked_labels": s["blocked_labels"],
            "alert": room in s["changed"], "map": s.get("map"),
            "people": s.get("people", {}).get(room), "live": s.get("live", {}).get(room),
            "accessible_mode": accessible, **room_data}


class Occupancy(BaseModel):
    room: str
    count: int | None = None  # people the camera sees; null = go back to the floor-plan number


@app.post("/occupancy")
def occupancy(req: Occupancy):
    """Nikaas Live: a camera's head count for one room. The drill re-plans with it (only when it changed).
    The video never leaves the camera's browser; this is the only thing sent."""
    if req.count is not None and not 0 <= req.count <= 5000:
        raise HTTPException(422, "count must be between 0 and 5000")
    try:
        state, replanned = drill_state.occupancy(req.room, req.count)
    except LookupError as e:
        if isinstance(e, KeyError):
            raise HTTPException(404, f"unknown room {req.room}")
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(422, str(e))
    return {"replanned": replanned, **drill_state.public(state)}


# ---------- platform: sites, check-in, alerts, control room (docs/PLATFORM.md) ----------
from fastapi import Header, Request  # noqa: E402
from fastapi.responses import RedirectResponse  # noqa: E402

from . import live, sites  # noqa: E402
from .push import vapid_keys  # noqa: E402

CONTROL_KEY = os.environ.get("NIKAAS_CONTROL_KEY", "")
_key_loaded = False


def _control_key() -> str:
    """The deployment's control-room key: NIKAAS_CONTROL_KEY, or the SSM parameter named in
    NIKAAS_CONTROL_KEY_PARAM (read once per Lambda instance). Empty = open (local runs)."""
    global CONTROL_KEY, _key_loaded
    if not CONTROL_KEY and not _key_loaded and os.environ.get("NIKAAS_CONTROL_KEY_PARAM"):
        _key_loaded = True
        try:
            import boto3

            CONTROL_KEY = boto3.client("ssm").get_parameter(Name=os.environ["NIKAAS_CONTROL_KEY_PARAM"], WithDecryption=True)["Parameter"]["Value"]
        except Exception:
            CONTROL_KEY = "locked: key not readable"  # the key exists in config but could not be read: fail closed
    return CONTROL_KEY


def _key(x_control_key: str | None):
    """Control endpoints need the deployment's key; local runs without one are open."""
    key = _control_key()
    if key and x_control_key != key:
        raise HTTPException(401, "control key required")


def _call(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except KeyError as e:
        raise HTTPException(404, str(e).strip("'"))
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.get("/sites")
def sites_list():
    return sites.list_sites()


@app.get("/sites/{sid}")
def site_get(sid: str):
    s = sites.get_site(sid)
    if s is None:
        raise HTTPException(404, f"unknown site {sid}")
    return {**s, "assembly": sites.assembly_points(s), "media": sites.media_public(s)}


class MediaRequest(BaseModel):
    image: str | None = None  # JPEG or PNG, base64 or a data URL
    plan: dict | None = None  # {x, z, w, h}: where the picture sits, in building metres
    walls: dict | None = None  # traced wall grid (web/src/platform/walls.ts)


@app.post("/sites/{sid}/media/{floor}")
def site_media(sid: str, floor: str, req: MediaRequest, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    s = _call(sites.save_media, sid, floor, req.image, req.plan, req.walls)
    return {**s, "assembly": sites.assembly_points(s), "media": sites.media_public(s)}


@app.post("/sites")
def site_save(site: dict, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    return _call(sites.save_site, site)


class GeoRequest(BaseModel):
    geo: dict | None = None
    assembly: list[dict] | None = None


@app.post("/sites/{sid}/geo")
def site_geo(sid: str, req: GeoRequest, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    s = _call(sites.set_geo, sid, req.geo, req.assembly)
    return {**s, "assembly": sites.assembly_points(s)}


class LinkRequest(BaseModel):
    building: dict
    tolerance_m: float = 4.0


@app.post("/plans/link-floors")
def plans_link(req: LinkRequest):
    b, links = sites.link_floors(req.building, req.tolerance_m)
    return {"building": b, "links": links, "problems": validate(b)}


class CheckinRequest(BaseModel):
    token: str
    room: str | None = None
    gate: str | None = None


@app.post("/sites/{sid}/checkin")
def site_checkin(sid: str, req: CheckinRequest):
    return _call(live.checkin, sid, req.token, req.room, req.gate)


class TokenRequest(BaseModel):
    token: str


@app.post("/sites/{sid}/checkout")
def site_checkout(sid: str, req: TokenRequest):
    _call(live.checkout, sid, req.token)
    return {"ok": True}


@app.get("/sites/{sid}/me")
def site_me(sid: str, token: str):
    return _call(live.me, sid, token)


class StatusRequest(BaseModel):
    token: str
    status: str
    need: str | None = None
    lat: float | None = None
    lng: float | None = None
    accuracy: float | None = None


@app.post("/sites/{sid}/status")
def site_status(sid: str, req: StatusRequest):
    return _call(live.set_status, sid, req.token, req.status, req.need, req.lat, req.lng, req.accuracy)


class PushRequest(BaseModel):
    token: str
    subscription: dict


@app.post("/sites/{sid}/push")
def site_push(sid: str, req: PushRequest):
    _call(live.save_push, sid, req.token, req.subscription)
    return {"ok": True}


@app.post("/sites/{sid}/push/test")
def site_push_test(sid: str, req: TokenRequest):
    return _call(live.test_push, sid, req.token)


@app.get("/push/key")
def push_key():
    return {"public_key": vapid_keys()[1]}


class AlarmRequest(BaseModel):
    type: str = "fire"
    message: str = ""
    origin: str | None = None
    phased: bool = False
    wave_gap_s: float = 60


def _base(request: Request) -> str:
    """This API's public address, for the short links in text messages."""
    host = request.headers.get("host", "")
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    return f"{proto}://{host}" if host else str(request.base_url).rstrip("/")


@app.post("/sites/{sid}/alarm")
def site_alarm(sid: str, req: AlarmRequest, request: Request, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    _call(live.start_alarm, sid, req.type, req.message, req.origin, req.phased, req.wave_gap_s, _base(request))
    return live.control(sid)


class RegisterRequest(BaseModel):
    token: str
    phone: str


@app.post("/sites/{sid}/register")
def site_register(sid: str, req: RegisterRequest):
    """Phone number for emergency texts. Sends a one-time code (or none if the number is already verified)."""
    return _call(live.register, sid, req.token, req.phone)


class VerifyRequest(BaseModel):
    token: str
    code: str


@app.post("/sites/{sid}/verify")
def site_verify(sid: str, req: VerifyRequest):
    return _call(live.verify_phone, sid, req.token, req.code)


SITE_URL = os.environ.get("NIKAAS_SITE_URL", "http://localhost:5173/")


@app.get("/r/{code}")
def short_link(code: str):
    """The link in an emergency text: opens the phone app as that person, on their building."""
    hit = live.resolve_link(code)
    target = f"{SITE_URL}#/go?site={hit['site']}&p={hit['token']}" if hit else f"{SITE_URL}#/go"
    return RedirectResponse(target, status_code=302, headers={"cache-control": "no-store", "referrer-policy": "no-referrer"})


class TestSmsRequest(BaseModel):
    person: str  # short id from the control room's people list


@app.post("/sites/{sid}/sms/test")
def site_sms_test(sid: str, req: TestSmsRequest, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    return _call(live.test_sms, sid, req.person)


@app.delete("/sites/{sid}/alarm")
def site_alarm_stop(sid: str, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    _call(live.stop_alarm, sid)
    return live.control(sid)


class HazardRequest(BaseModel):
    kind: str
    node: str
    source: str = "manual"
    confidence: float | None = None


@app.post("/sites/{sid}/hazards")
def site_hazard(sid: str, req: HazardRequest, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    h = _call(live.add_hazard, sid, req.kind, req.node, req.source, req.confidence)
    return {"hazard": h["id"], **live.control(sid)}


@app.delete("/sites/{sid}/hazards/{hid}")
def site_hazard_clear(sid: str, hid: str, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    _call(live.remove_hazard, sid, hid)
    return live.control(sid)


class SensorRequest(BaseModel):
    sensor_id: str
    node: str
    temp_c: float | None = None
    smoke: float | None = None


@app.post("/sites/{sid}/sensors")
def site_sensor(sid: str, req: SensorRequest, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    hid = _call(live.sensor_reading, sid, req.sensor_id, req.node, req.temp_c, req.smoke)
    return {"hazard": hid, **live.control(sid)}


class CameraRequest(BaseModel):
    camera_id: str
    node: str
    people: int | None = None
    fire: float = 0
    smoke: float = 0
    image: str | None = None  # one JPEG still, sent only when the browser suspects fire or smoke


@app.post("/sites/{sid}/cameras")
def site_camera(sid: str, req: CameraRequest, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    out = _call(live.camera_report, sid, req.camera_id, req.node, req.people, req.fire, req.smoke, req.image)
    return {**out, **live.control(sid)}


@app.get("/sites/{sid}/control")
def site_control(sid: str, x_control_key: str | None = Header(default=None)):
    _key(x_control_key)
    return _call(live.control, sid)
