"""Floor plan pictures and traced walls stored with a site (sites.save_media, POST /sites/{sid}/media/{floor})."""
import base64

import pytest
from fastapi.testclient import TestClient

from nikaas import api, sites, store

PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 32).decode()
WALLS = {"res": 0.1, "x0": 0, "z0": 0, "cols": 4, "rows": 2, "rle": "2,3,3"}


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    store.reset_memory()
    monkeypatch.delenv("PHOTO_BUCKET", raising=False)
    monkeypatch.setattr(api, "CONTROL_KEY", "")


def floor_of(sid):
    return sites.get_site(sid)["building"]["floors"][0]["id"]


def test_picture_and_walls_are_stored_and_served():
    c = TestClient(api.app)
    f = floor_of("office")
    r = c.post(f"/sites/office/media/{f}", json={"image": f"data:image/png;base64,{PNG}", "plan": {"x": -5, "z": -4, "w": 60, "h": 30}, "walls": WALLS})
    assert r.status_code == 200, r.text
    m = c.get("/sites/office").json()["media"][f]
    assert m["plan"]["url"].startswith("data:image/png;base64,")
    assert m["plan"]["w"] == 60 and m["walls"]["rle"] == "2,3,3"


def test_saving_the_building_keeps_its_media():
    f = floor_of("office")
    sites.save_media("office", f, plan={"x": 0, "z": 0, "w": 10, "h": 10}, walls=WALLS)
    s = sites.get_site("office")
    s["media"] = {f: {"walls": {"rle": "forged"}}}  # clients cannot write media through the site itself
    sites.save_site(s)
    assert sites.get_site("office")["media"][f]["walls"]["rle"] == "2,3,3"


@pytest.mark.parametrize("kw,msg", [
    ({"image": base64.b64encode(b"GIF89a").decode()}, "JPEG or PNG"),
    ({"image": "not base64!"}, "base64"),
    ({"walls": {**WALLS, "rle": "2,3"}}, "cover"),
    ({"walls": {**WALLS, "rle": "a,b"}}, "counts"),
    ({"walls": {**WALLS, "res": 5}}, "range"),
    ({"plan": {"x": 0}}, "x, z, w, h"),
])
def test_bad_media_is_refused(kw, msg):
    with pytest.raises(ValueError, match=msg):
        sites.save_media("office", floor_of("office"), **kw)


def test_unknown_floor_is_refused():
    with pytest.raises(ValueError, match="unknown floor"):
        sites.save_media("office", "roof", walls=WALLS)
