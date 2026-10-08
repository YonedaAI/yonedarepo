"""Assemble measured narration, supplied presenter clips and authentic captures."""

import hashlib
import json
from pathlib import Path
import subprocess
from . import captions, diagrams, frames, media


def render(manifest_path, edit_path, production, output, capture_root):
    manifest = json.loads(manifest_path.read_text())
    if not manifest["voice"].get("production_ready", False):
        raise ValueError("Narration voice is awaiting acceptance; do not render superseded takes")
    edits = json.loads(edit_path.read_text())["scenes"]
    evidence = json.loads(Path("docs/release-evidence.json").read_text())
    output.mkdir(parents=True, exist_ok=True)
    movies, subtitles, ratios, measured, alignment_models = [], [], {}, {}, {}
    chapters = [";FFMETADATA1", "title=YonedaRepo: concurrent agents, preserved context",
                "comment=AI presenter and voice; actual captures; edited walkthrough"]
    cursor = 0
    # Validate every input before encoding any scene.
    for scene in manifest["scenes"]:
        if scene["start_seconds"] != cursor:
            raise ValueError("Scenes must be contiguous")
        audio = production/"narration"/f"scene-{scene['id']}.mp3"
        measured[scene["id"]] = media.duration(audio)
        alignment_path = production/"alignment"/f"scene-{scene['id']}.json"
        alignment = json.loads(alignment_path.read_text())
        alignment_models[scene["id"]] = alignment.get("alignment_model")
        if alignment.get("source_sha256") != hashlib.sha256(audio.read_bytes()).hexdigest():
            raise ValueError(f"Stale narration alignment in scene {scene['id']}")
        captions.scene_captions(scene, measured[scene["id"]], alignment_path, 1)
        if measured[scene["id"]] > scene["duration_seconds"]-1:
            raise ValueError(f"Narration overruns reading hold in scene {scene['id']}")
        timeline = edits[scene["id"]]
        if abs(sum(item["seconds"] for item in timeline)-scene["duration_seconds"]) > 0.01:
            raise ValueError(f"Visual duration mismatch in scene {scene['id']}")
        for item in timeline:
            if item["kind"] == "presenter":
                path = production/"presenter"/item["file"]
                if media.duration(path)+0.05 < item["seconds"]:
                    raise ValueError("Presenter input is too short")
            elif item["kind"] == "capture":
                path = resolve_capture(item["file"], capture_root)
                if not path.is_file():
                    raise ValueError(f"Missing actual capture: {path}")
        cursor += scene["duration_seconds"]
    if cursor != manifest["duration_seconds"] or cursor != 528:
        raise ValueError("The intended edit must be 8:48")
    for scene in manifest["scenes"]:
        work = output/f"scene-{scene['id']}"
        work.mkdir(exist_ok=True)
        parts = []
        for index, item in enumerate(edits[scene["id"]]):
            target = work/f"part-{index:02}.mp4"
            if item["kind"] == "presenter":
                overlay = work/"presenter-overlay.png"
                frames.presenter_overlay(scene, overlay)
                media.presenter_segment(production/"presenter"/item["file"],
                                        item["seconds"], overlay, target)
            else:
                image = work/f"frame-{index:02}.jpg"
                if item["kind"] == "capture":
                    frames.screenshot(scene, resolve_capture(item["file"], capture_root),
                                      image, item.get("label", "Actual product capture"),
                                      item.get("crop"))
                elif item["kind"] == "diagram":
                    diagrams.diagram(scene, item["name"], evidence, image)
                else:
                    raise ValueError(f"Unsupported visual kind: {item['kind']}")
                media.still_segment(image, item["seconds"], target)
            parts.append(target)
        movie = output/f"scene-{scene['id']}.mp4"
        media.join_scene(parts, production/"narration"/f"scene-{scene['id']}.mp3",
                         scene["duration_seconds"], movie, work)
        movies.append(movie)
        items, ratio = captions.scene_captions(
            scene, measured[scene["id"]],
            production/"alignment"/f"scene-{scene['id']}.json", len(subtitles)+1)
        subtitles.extend(items)
        ratios[scene["id"]] = round(ratio, 4)
        chapters.extend([
            "[CHAPTER]", "TIMEBASE=1/1000", f"START={scene['start_seconds']*1000}",
            f"END={(scene['start_seconds']+scene['duration_seconds'])*1000}",
            f"title={scene['title']}",
        ])
        print(f"Rendered chapter {scene['id']}/10", flush=True)
    listing, srt, metadata = output/"segments.txt", output/"yonedarepo-presenter.srt", output/"chapters.ffmetadata"
    listing.write_text("\n".join("file "+media.quoted(p) for p in movies)+"\n")
    srt.write_text("\n".join(subtitles))
    (output/"yonedarepo-presenter.vtt").write_text(
        "WEBVTT\n\n" + captions.webvtt_timestamps("\n".join(subtitles)))
    metadata.write_text("\n".join(chapters)+"\n")
    final = output/"yonedarepo-presenter.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
        "-i", str(srt), "-f", "ffmetadata", "-i", str(metadata),
        "-map", "0:v", "-map", "0:a", "-map", "1:0", "-map_chapters", "2", "-map_metadata", "2",
        "-c", "copy", "-c:s", "mov_text", "-movie_timescale", "1000",
        "-movflags", "+faststart", str(final),
    ], check=True)
    actual = media.duration(final)
    if abs(actual-528) > 0.1:
        raise ValueError(f"Final duration is {actual:.3f}s; expected 528s")
    (output/"video-metadata.json").write_text(json.dumps({
        "duration_seconds": actual, "chapters": 10, "format": manifest["format"],
        "voice": {key: manifest["voice"].get(key) for key in ("provider", "name", "model", "voice_clone")},
        "narration_seconds": measured, "reading_hold_seconds": round(528-sum(measured.values()), 3),
        "caption_method": "Approved transcript aligned to local Whisper word timestamps",
        "asr_alignment_ratios": ratios, "captures": "Actual captures; diagrams are editor-created",
        "alignment_models": alignment_models,
        "presenter": "AI likeness video supplied separately; original portrait is not composited",
        "presenter_windows": {scene["id"]: scene["presenter_windows_seconds"]
                              for scene in manifest["scenes"] if scene["presenter_windows_seconds"]},
    }, indent=2)+"\n")
    print(f"Completed {final}: {actual:.3f}s", flush=True)


def resolve_capture(name, capture_root):
    return capture_root/name[8:] if name.startswith("release:") else Path(name)
