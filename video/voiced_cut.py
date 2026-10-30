"""30-second narrated cut of the showcase film (video/out/nikaas_film.mp4 from video/film.py).

Each narration line gets one window of the film; the window is retimed to the line's length (the footage may be
sped up or slowed, the voice never is). Voice: edge-tts (free), en-US-AndrewMultilingualNeural by default.
Numbers spoken are the ones in runs/ (museum 21.25 s saved, tower 45.1% faster).

Usage (repo root):  python video/voiced_cut.py [--voice en-US-AndrewMultilingualNeural]
Writes video/out/nikaas_30s_voice.mp4.
"""
import argparse
import asyncio
import json
import pathlib
import subprocess

import edge_tts

OUT = pathlib.Path("video/out")
FILM = OUT / "nikaas_film.mp4"
# (film window as (section, start offset, section to end in, end offset), narration). Sections as in film_segments.json:
# 0 home + fire, 1 scroll story, 2 tower, 3 live drill, 4 3D Sim briefing, 5 3D Sim alarm
LINES = [
    ((0, 0.6, 0, None), "A fire blocks the main entrance. Nikaas re-plans every room's exit, in seconds."),
    ((1, 0.2, 1, -5.0), "It turns the exit map on the wall into a live building. Same doors, same people: twenty-one seconds faster."),
    ((2, 0.2, 2, -0.1), "Five floors, two stairwells: forty-five percent faster."),
    ((3, 0.1, 4, -0.2), "And in a live drill, every phone in the room gets its own way out."),
    ((5, 0.0, 5, None), "Nikaas. Photograph the exit map. Get everyone out faster."),
]
LEAD, TAIL, END = 0.25, 0.25, 1.0  # s of picture before and after each line; extra hold at the very end

ap = argparse.ArgumentParser()
ap.add_argument("--voice", default="en-US-AndrewMultilingualNeural")
ap.add_argument("--rate", default="+5%")
a = ap.parse_args()

dur = lambda f: float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(f)]))  # noqa: E731
segs = json.loads((OUT / "film_segments.json").read_text())
starts = [sum(segs[:i]) for i in range(len(segs))] + [sum(segs)]


async def speak():
    for n, (_, text) in enumerate(LINES):
        await edge_tts.Communicate(text, a.voice, rate=a.rate).save(str(OUT / f"vo_{n:02d}.mp3"))

asyncio.run(speak())

parts, audio, t = [], [], 0.0
for n, ((s0, o0, s1, o1), _) in enumerate(LINES):
    w0 = starts[s0] + o0
    w1 = starts[s1 + 1] + (o1 or 0.0)
    line = dur(OUT / f"vo_{n:02d}.mp3")
    length = LEAD + line + TAIL + (END if n == len(LINES) - 1 else 0.0)
    k = (w1 - w0) / length  # >1: footage sped up, <1: slowed down
    parts.append(f"[0:v]trim=start={w0:.2f}:end={w1:.2f},setpts=(PTS-STARTPTS)/{k:.4f},fps=30[v{n}]")
    audio.append((n, t + LEAD))
    print(f"line {n}: {line:4.1f} s voice, film {w0:5.1f}-{w1:5.1f} s shown at {k:.2f}x, starts at {t:4.1f} s")
    t += length

vf = ";".join(parts) + ";" + "".join(f"[v{n}]" for n in range(len(LINES))) + f"concat=n={len(LINES)}:v=1:a=0[v];"
vf += "".join(f"[{n + 1}:a]adelay={int(at * 1000)}|{int(at * 1000)}[a{n}];" for n, at in audio)
vf += "".join(f"[a{n}]" for n in range(len(LINES))) + f"amix=inputs={len(LINES)}:normalize=0,apad,loudnorm=I=-16:TP=-1.5[a]"
inputs = [x for n in range(len(LINES)) for x in ("-i", str(OUT / f"vo_{n:02d}.mp3"))]
out = OUT / "nikaas_30s_voice.mp4"
subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(FILM), *inputs, "-filter_complex", vf, "-map", "[v]", "-map", "[a]",
                "-t", f"{t:.2f}", "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "+faststart", str(out)], check=True)
print(out, round(dur(out), 1), "s")
