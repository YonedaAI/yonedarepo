"""Local media inspection and encoding. No provider calls or credentials."""

import json
from pathlib import Path
import subprocess


def inspect(path):
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_format", "-show_streams",
        "-of", "json", str(path),
    ], text=True))


def duration(path):
    return float(inspect(path)["format"]["duration"])


def encode(args, target):
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", *args,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "21",
        "-pix_fmt", "yuv420p", "-r", "30", "-threads", "4",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-movflags", "+faststart", str(target),
    ], check=True)


def quoted(path):
    # ffmpeg's concat format has its own quoting rules; this is not shell text.
    return "'" + str(Path(path).resolve()).replace("'", "'\\''") + "'"


def still_segment(image, seconds, target):
    encode([
        "-loop", "1", "-framerate", "30", "-i", str(image),
        "-t", f"{seconds:.6f}", "-an",
    ], target)


def presenter_segment(movie, seconds, overlay, target):
    if duration(movie) + 0.05 < seconds:
        raise ValueError(f"Presenter clip is shorter than its window: {movie}")
    encode([
        "-i", str(movie), "-loop", "1", "-i", str(overlay),
        "-filter_complex",
        "[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,"
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b1120[base];"
        "[base][1:v]overlay=0:0:format=auto[v]",
        "-map", "[v]", "-t", f"{seconds:.6f}", "-an",
    ], target)


def join_scene(parts, audio, seconds, target, workdir):
    listing = workdir / "parts.txt"
    listing.write_text("\n".join("file " + quoted(p) for p in parts) + "\n")
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
        "-i", str(listing), "-i", str(audio), "-map", "0:v", "-map", "1:a",
        "-af", "apad", "-t", str(seconds), "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", str(target),
    ], check=True)
