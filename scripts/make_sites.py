"""Build the demo sites in nikaas/sites_data/ from the building files in data/.

A site is a building plus readable labels (for spoken-style directions on phones) and assembly points
outside each exit. Locations on the map (geo) are left empty: the control room sets them on site.
    python scripts/make_sites.py
"""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "nikaas" / "sites_data"


def read(name):
    return json.loads((ROOT / "data" / name).read_text(encoding="utf-8-sig"))


def office():
    b = copy.deepcopy(read("multi_floor_office.json"))
    b["name"] = "Block C, three-storey office"
    floor_no = {"GF": "G", "F1": "1", "F2": "2"}
    floor_name = {f["id"]: f["name"] for f in b["floors"]}
    for n in b["nodes"]:
        f = n.get("floor_id")
        if n["type"] == "room":
            n["label"] = f"Room {floor_no[f]}.{n['id'].rsplit('_', 1)[1]}"
        elif n["id"].startswith("stair_"):
            side = n["id"].split("_")[1]
            n["label"] = f"{side.title()} stair, {floor_name[f]}"
            n["stair"] = True
        elif n["id"].startswith("corr_"):
            n["label"] = f"Main corridor, {floor_name[f]}"
    for e in b["edges"]:
        if e.get("kind") == "stair":
            e["label"] = "North stair" if "north" in e["from"] else "South stair"
    return {
        "id": "office",
        "name": "Block C, three-storey office",
        "address": "Demo building (synthetic benchmark from the multi-floor engine)",
        "demo": True,
        "building": b,
        "geo": None,
        "assembly": [
            {"id": "A1", "label": "Assembly A · North car park", "x": 10, "z": -30, "exits": ["exit_north"], "lat": None, "lng": None},
            {"id": "A2", "label": "Assembly B · South lawn", "x": 10, "z": 60, "exits": ["exit_south"], "lat": None, "lng": None},
        ],
    }


def museum():
    b = read("iit_kgp_museum.json")
    nodes = b["nodes"]
    cx = sum(n["x"] for n in nodes) / len(nodes)
    cz = sum(n["z"] for n in nodes) / len(nodes)
    assembly = []
    for i, n in enumerate([n for n in nodes if n["type"] == "exit"]):
        dx, dz = n["x"] - cx, n["z"] - cz
        d = (dx * dx + dz * dz) ** 0.5 or 1
        assembly.append({"id": f"A{i + 1}", "label": f"Assembly {'ABC'[i]} · outside {n.get('label', n['id'])}",
                         "x": round(n["x"] + dx / d * 25, 1), "z": round(n["z"] + dz / d * 25, 1),
                         "exits": [n["id"]], "lat": None, "lng": None})
    return {
        "id": "museum",
        "name": "Nehru Museum of Science & Technology, Block B",
        "address": "IIT Kharagpur (digitised from the posted floor-plan panel)",
        "demo": True,
        "building": b,
        "geo": None,
        "assembly": assembly,
    }


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for site in (office(), museum()):
        (OUT / f"{site['id']}.json").write_text(json.dumps(site, indent=1) + "\n", encoding="utf-8")
        print("wrote", f"nikaas/sites_data/{site['id']}.json")
