"""Add a narrated voice-over (ElevenLabs) to the showcase film made by video/film.py.

The API key is read from the ELEVENLABS_API_KEY environment variable or from the file ~/.elevenlabs_key
(one line, never committed, never printed). Each line of narration starts at its film section
(video/out/film_segments.json, written by film.py). Numbers spoken are the ones in runs/.

Usage (repo root):  python video/voiceover.py [--voice Brian]
Writes video/out/nikaas_film_voice.mp4.
"""
import argparse
import json
import os
import pathlib
import subprocess
import urllib.request

OUT = pathlib.Path("video/out")
FILM = OUT / "nikaas_film.mp4"
# (film section, seconds into it, text). Sections: 0 home + fire, 1 scroll story, 2 tower, 3 live drill, 4-5 3D Sim
LINES = [
    (0, 0.4, "A fire blocks the main entrance. Nikaas re-plans every room's exit, in seconds."),
    (1, 0.6, "It starts from a photo of the exit map on the wall. Every door and stair moves people at the fire-engineering "
             "handbook's rate. Same doors, same people: twenty-one seconds faster."),
    (2, 0.3, "Five floors, two stairwells: forty-five percent faster."),
    (3, 0.1, "In a live drill, every phone in the room gets its own way out."),
    (5, 1.0, "Nikaas. Photograph the exit map. Get everyone out faster."),
]

ap = argparse.ArgumentParser()
ap.add_argument("--voice", default="Brian", help="name of an ElevenLabs voice in your account")
ap.add_argument("--model", default="eleven_multilingual_v2")
a = ap.parse_args()

key = os.environ.get("ELEVENLABS_API_KEY") or (pathlib.Path.home() / ".elevenlabs_key").read_text(encoding="utf-8-sig").strip()
H = {"xi-api-key": key, "content-type": "application/json"}


def api(path, body=None):
    req = urllib.request.Request(f"https://api.elevenlabs.io{path}", data=None if body is None else json.dumps(body).encode(), headers=H)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


voices = json.loads(api("/v1/voices"))["voices"]
voice = next((v for v in voices if v["name"].lower().startswith(a.voice.lower())), voices[0])
print("voice:", voice["name"])

segs = json.loads((OUT / "film_segments.json").read_text())
starts = [sum(segs[:i]) for i in range(len(segs))]
dur = lambda f: float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]))  # noqa: E731
clips = []
for n, (sec, off, text) in enumerate(LINES):
    mp3 = OUT / f"vo_{n:02d}.mp3"
    mp3.write_bytes(api(f"/v1/text-to-speech/{voice['voice_id']}?output_format=mp3_44100_128",
                        {"text": text, "model_id": a.model, "voice_settings": {"stability": 0.5, "similarity_boost": 0.75}}))
    at = starts[sec] + off
    clips.append((mp3, at))
    nxt = starts[LINES[n + 1][0]] + LINES[n + 1][1] if n + 1 < len(LINES) else sum(segs)
    print(f"line {n}: {at:5.1f}-{at + dur(mp3):5.1f} s" + ("   OVERLAPS the next line, shorten it" if at + dur(mp3) > nxt else ""))

inputs = [x for c, _ in clips for x in ("-i", str(c))]
mix = "".join(f"[{i + 1}:a]adelay={int(at * 1000)}|{int(at * 1000)}[a{i}];" for i, (_, at) in enumerate(clips))
mix += "".join(f"[a{i}]" for i in range(len(clips))) + f"amix=inputs={len(clips)}:normalize=0,apad,loudnorm=I=-16:TP=-1.5[a]"
out = OUT / "nikaas_film_voice.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(FILM), *inputs, "-filter_complex", mix, "-map", "0:v", "-map", "[a]",
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(out)], check=True)
print(out, round(dur(out), 1), "s")
