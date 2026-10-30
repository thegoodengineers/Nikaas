"""Confirm a camera's suspected fire or smoke with Amazon Rekognition (labels Fire, Flame, Smoke).

The browser runs a quick colour check on every frame and sends one still only when it suspects fire or
smoke, so video never leaves the camera's laptop. Returns None when Rekognition is not reachable (local
runs without AWS credentials); the caller then falls back to the browser's own score.
"""
import base64


def confirm(image_b64: str) -> dict | None:
    try:
        import boto3

        data = base64.b64decode(image_b64.split(",", 1)[-1], validate=False)
        if len(data) > 5_000_000:
            return None
        r = boto3.client("rekognition").detect_labels(Image={"Bytes": data}, MaxLabels=30, MinConfidence=50)
    except Exception:  # no credentials locally, throttling, bad image: the browser score decides
        return None
    conf = {"fire": 0.0, "smoke": 0.0, "people": 0}
    for lab in r.get("Labels", []):
        name, c = lab["Name"].lower(), lab["Confidence"] / 100
        if name in ("fire", "flame", "bonfire"):
            conf["fire"] = max(conf["fire"], c)
        elif name == "smoke":
            conf["smoke"] = max(conf["smoke"], c)
        elif name == "person":
            conf["people"] = len(lab.get("Instances", []))
    return conf
