#!/usr/bin/env python3
"""Render the edited release walkthrough from actual captures and synthetic narration.

Optional production tool: macOS say, ffmpeg/ffprobe and Pillow. It never drives UI
or starts agents. Capture evidence separately in the served browser.
"""

import argparse
import json
from pathlib import Path
import subprocess
import textwrap

from PIL import Image, ImageDraw, ImageFont

SIZE = (1920, 1080)
INK, BLUE, MUTED = "#142b40", "#155c9c", "#59768a"


def font(size):
    for path in ["/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if Path(path).is_file():
            return ImageFont.truetype(path, size)
    raise SystemExit("Install Arial or DejaVu Sans for video production")


def lines(draw, text, at, width=78, size=32, color=INK):
    x, y = at
    for line in textwrap.wrap(text, width=width):
        draw.text((x, y), line, font=font(size), fill=color)
        y += size + 14
    return y


def frame(scene, capture, target, evidence):
    canvas = Image.new("RGB", SIZE, "#f0f5f8")
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 1920, 8), fill=BLUE)
    lines(draw, scene["title"], (70, 40), width=70, size=43)
    if capture:
        screenshot = Image.open(capture).convert("RGB")
        screenshot.thumbnail((1770, 840), Image.Resampling.LANCZOS)
        canvas.paste(screenshot, ((1920-screenshot.width)//2, 145+(840-screenshot.height)//2))
    elif scene["card"] == "concurrency":
        concurrency = evidence["hosted"]["concurrency"]
        starts, ends = concurrency["start_milliseconds"], concurrency["transcript_milliseconds"]
        origin, span = min(starts), max(ends)-min(starts)
        for i, label in enumerate(["Luna · gpt-5.6-luna", "Sonnet · claude-sonnet-4-6"]):
            y = 270 + i*200
            draw.text((100, y), label, font=font(38), fill=INK)
            left, right = 100+(starts[i]-origin)/span*1650, 100+(ends[i]-origin)/span*1650
            draw.rounded_rectangle((left, y+65, right, y+125), radius=12,
                                   fill=["#155c9c", "#187965"][i])
        lines(draw, "87.117 seconds of actual harness overlap", (100, 760), size=50)
        lines(draw, "Measured from harness_running to trusted transcript registration; epoch 1 completed.",
              (100, 850), width=92, size=30, color=MUTED)
    elif scene["card"] == "mcp":
        entries = [
            "Fresh client reads: repo_context · context_search · context_get",
            "Exact source history: why → decision → artifact_get",
            "Finds prior scope: static site; membership backend deferred",
            "Isolated Git fork → push → attempt_submit",
            "Fresh platform capture: 0e9551767036469317baaab2338bb15324a0eeae",
            "Independent check: eligible · publication: awaiting owner review",
        ]
        for i, entry in enumerate(entries):
            lines(draw, entry, (100, 210+i*120), width=83, size=33)
    else:
        rows = [
            ("Browser / remote MCP / scoped Git", "Authenticated Worker + thin SDK adapters"),
            ("Rust Workspace + Repo Durable Objects", "SQLite authority; state + graph + events + outbox"),
            ("Queues → isolated Containers", "Agent harness → fresh capture → independent evaluator"),
            ("Cloudflare Artifacts + R2", "Canonical Git / isolated forks + immutable evidence"),
            ("D1 / Live projections + Sites Worker", "Discovery / resync hints + isolated static hosting"),
        ]
        for i, (title, detail) in enumerate(rows):
            y = 175+i*155
            draw.rounded_rectangle((95, y, 1825, y+125), radius=14, fill="#e2edf4", outline="#9cb9cb", width=2)
            draw.text((125, y+18), title, font=font(35), fill=INK)
            draw.text((125, y+70), detail, font=font(29), fill=MUTED)
    lines(draw, scene["caption"], (70, 1010), width=115, size=25, color=MUTED)
    canvas.save(target, quality=93)


def duration(path):
    return float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path)], text=True))


def timestamp(seconds):
    milliseconds = round(seconds*1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def render(captures, output):
    scenes = json.loads(Path("docs/demo-scenes.json").read_text())
    evidence = json.loads(Path("docs/release-evidence.json").read_text())
    output.mkdir(parents=True, exist_ok=True)
    captions, chapters, concat, cursor = [], [";FFMETADATA1"], [], 0.0
    for i, scene in enumerate(scenes):
        prefix = output / f"scene-{i:02}"
        text = prefix.with_suffix(".txt")
        text.write_text(scene["narration"])
        audio, movie = prefix.with_suffix(".aiff"), prefix.with_suffix(".mp4")
        subprocess.run(["say", "-v", "Samantha", "-r", "150", "-f", str(text), "-o", str(audio)], check=True)
        seconds = duration(audio)
        inputs = [captures/p for p in scene.get("captures", [])] or [None]
        # The last scene also shows captured real filter/RSVP transitions.
        if i == 5:
            inputs.extend(sorted((output/"interaction").glob("frame-*.jpg")))
        image_list = []
        for j, capture in enumerate(inputs):
            target = output / f"scene-{i:02}-{j:02}.jpg"
            frame(scene, capture, target, evidence)
            image_list.extend([f"file '{target.resolve()}'", f"duration {seconds/len(inputs):.6f}"])
        image_list.append(f"file '{target.resolve()}'")
        timeline = prefix.with_suffix(".frames")
        timeline.write_text("\n".join(image_list)+"\n")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(timeline),
                        "-i", str(audio), "-t", str(seconds), "-r", "24", "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "25", "-pix_fmt", "yuv420p", "-threads", "4", "-c:a", "aac", "-b:a", "128k",
                        str(movie)], check=True)
        words = scene["narration"].split()
        for j in range(0, len(words), 14):
            start, end = cursor+seconds*j/len(words), cursor+seconds*min(j+14,len(words))/len(words)
            captions.append(f"{len(captions)+1}\n{timestamp(start)} --> {timestamp(end)}\n"+
                            "\n".join(textwrap.wrap(" ".join(words[j:j+14]), 70))+"\n")
        chapters.extend(["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(cursor*1000)}",
                         f"END={round((cursor+seconds)*1000)}", f"title={scene['title']}"])
        concat.append(f"file '{movie.resolve()}'")
        cursor += seconds
        print(f"Rendered {i+1}/{len(scenes)}: {seconds:.1f}s", flush=True)
    (output/"segments.txt").write_text("\n".join(concat)+"\n")
    (output/"yonedarepo-mvp.srt").write_text("\n".join(captions))
    (output/"chapters.ffmetadata").write_text("\n".join(chapters)+"\n")
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(output/"segments.txt"),
                    "-i", str(output/"yonedarepo-mvp.srt"), "-f", "ffmetadata", "-i", str(output/"chapters.ffmetadata"),
                    "-map", "0:v", "-map", "0:a", "-map", "1:0", "-map_chapters", "2", "-map_metadata", "2",
                    "-c", "copy", "-c:s", "mov_text", "-movflags", "+faststart", str(output/"yonedarepo-mvp.mp4")], check=True)
    actual = duration(output/"yonedarepo-mvp.mp4")
    if not 300 <= actual <= 600:
        raise SystemExit(f"Video length {actual:.1f}s is outside the required 5–10 minutes")
    (output/"video-metadata.json").write_text(json.dumps({"duration_seconds":actual,"chapters":len(scenes),
        "narration":"Synthetic macOS Samantha, 150 words/minute", "captures":"Actual served UI and recorded run evidence; edited walkthrough"},indent=2)+"\n")
    print(f"Video complete: {actual:.1f}s", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, default=Path("artifacts/screenshots"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/video"))
    args = parser.parse_args()
    render(args.captures.resolve(), args.output.resolve())
