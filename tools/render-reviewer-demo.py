#!/usr/bin/env python3
"""Render an explicitly edited, captioned walkthrough from real browser captures.

Optional production dependencies: Pillow and ffmpeg/ffprobe. No inference or TTS.
"""
import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def timestamp(seconds):
    milliseconds = round(seconds * 1000)
    hours, milliseconds = divmod(milliseconds, 3600000)
    minutes, milliseconds = divmod(milliseconds, 60000)
    seconds, milliseconds = divmod(milliseconds, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"


def lines(draw, text, font, width):
    result, current = [], ""
    for word in text.split():
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font) > width and current:
            result.append(current)
            current = word
        else:
            current = candidate
    return result + [current]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--scenes", type=Path, default=Path("docs/reviewer-demo-scenes.json"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--font", type=Path, default=Path("/System/Library/Fonts/Supplemental/Arial.ttf"))
    args = parser.parse_args()
    manifest = json.loads(args.scenes.read_text())
    duration = sum(scene["seconds"] for scene in manifest["scenes"])
    if not 300 <= duration <= 600:
        raise ValueError("Competition walkthrough must be between 5 and 10 minutes")
    args.output.mkdir(parents=True, exist_ok=True)
    heading = ImageFont.truetype(str(args.font), 40)
    caption = ImageFont.truetype(str(args.font), 31)
    small = ImageFont.truetype(str(args.font), 23)
    entries, subtitles, chapters = [], [], [";FFMETADATA1"]
    clock = 0.0
    for number, scene in enumerate(manifest["scenes"], 1):
        source = args.captures / scene["capture"]
        if source.name != scene["capture"]:
            raise ValueError("Capture must be a simple filename")
        screenshot = ImageOps.contain(Image.open(source).convert("RGB"), (1880, 790))
        interval = scene["seconds"] / len(scene["captions"])
        chapters += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={round(clock * 1000)}",
                     f"END={round((clock + scene['seconds']) * 1000)}", f"title={scene['title']}"]
        for index, text in enumerate(scene["captions"], 1):
            frame = Image.new("RGB", (1920, 1080), "#102334")
            draw = ImageDraw.Draw(frame)
            draw.text((40, 20), f"{number:02}  {scene['title']}", font=heading, fill="#ffffff")
            draw.text((40, 76), "YonedaRepo · yonedarepo.com · Edited current browser captures · Captioned, no narration", font=small, fill="#b8d6e8")
            frame.paste(screenshot, ((1920 - screenshot.width) // 2, 122 + (790 - screenshot.height) // 2))
            wrapped = lines(draw, text, caption, 1810)
            if len(wrapped) > 3:
                raise ValueError("Caption is too long to read at normal size")
            for row, line in enumerate(wrapped):
                draw.text((50, 934 + row * 40), line, font=caption, fill="#ffffff")
            path = args.output / f"scene-{number:02}-{index:02}.png"
            frame.save(path)
            entries += [f"file '{path.name}'", f"duration {interval}"]
            subtitles += [str(len(subtitles) // 4 + 1), f"{timestamp(clock)} --> {timestamp(clock + interval)}", text, ""]
            clock += interval
    entries.append(entries[-2])
    (args.output / "frames.txt").write_text("\n".join(entries) + "\n")
    (args.output / "chapters.ffmetadata").write_text("\n".join(chapters) + "\n")
    (args.output / "yonedarepo-reviewer.srt").write_text("\n".join(subtitles))
    video = args.output / "yonedarepo-reviewer.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
                    "-i", str(args.output / "frames.txt"), "-i", str(args.output / "chapters.ffmetadata"),
                    "-i", str(args.output / "yonedarepo-reviewer.srt"), "-map", "0:v:0", "-map", "2:0",
                    "-map_metadata", "1", "-t", str(duration), "-r", "25", "-c:v", "libx264",
                    "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:s", "mov_text",
                    "-movflags", "+faststart", str(video)], check=True)
    probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                                               "-show_chapters", "-of", "json", str(video)]))
    measured = float(probe["format"]["duration"])
    if abs(measured - duration) > 0.2 or len(probe["chapters"]) != len(manifest["scenes"]):
        raise ValueError("Rendered timing or chapters disagree with the scene manifest")
    (args.output / "video-metadata.json").write_text(json.dumps({"duration_seconds": measured,
        "format": "edited current browser captures; captioned without narration", "probe": probe}, indent=2))
    print(f"Rendered {video}: {measured:.2f}s, {len(probe['chapters'])} chapters")


if __name__ == "__main__":
    main()
