#!/usr/bin/env python3
"""Align supplied narration locally with Whisper; no provider calls or uploads.

Optional dependencies: openai-whisper and its local PyTorch runtime. The first
use downloads the selected public model unless it is already cached.
"""

import argparse
from difflib import SequenceMatcher
import hashlib
import json
import os
from pathlib import Path
import re


def words(value):
    return re.findall(r"[a-z0-9]+", value.lower())


def align(manifest, production, model_name, threads):
    import torch
    import whisper

    torch.set_num_threads(threads)
    model = whisper.load_model(model_name, device="cpu")
    output = production / "alignment"
    output.mkdir(parents=True, exist_ok=True)
    scenes = json.loads(manifest.read_text())["scenes"]
    for scene in scenes:
        audio = production / "narration" / f"scene-{scene['id']}.mp3"
        digest = hashlib.sha256(audio.read_bytes()).hexdigest()
        target = output / f"scene-{scene['id']}.json"
        result = json.loads(target.read_text()) if target.exists() else {}
        if result.get("source_sha256") != digest or result.get("alignment_model") != model_name:
            result = model.transcribe(
                str(audio), language="en", fp16=False, word_timestamps=True,
                condition_on_previous_text=False, verbose=None,
            )
            result.update(source_sha256=digest, alignment_model=model_name)
            target.write_text(json.dumps(result, indent=2) + "\n")
        matcher = SequenceMatcher(None, words(scene["narration"]),
                                  words(result["text"]), autojunk=False)
        differences = [
            {"operation": kind, "reference": " ".join(words(scene["narration"])[i:j]),
             "asr": " ".join(words(result["text"])[k:l])}
            for kind, i, j, k, l in matcher.get_opcodes() if kind != "equal"
        ]
        (output / f"scene-{scene['id']}-diff.json").write_text(
            json.dumps(differences, indent=2) + "\n")
        print(f"Scene {scene['id']}: local ASR token match {matcher.ratio():.3f}; "
              f"{len(differences)} differences", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("docs/video/presenter-scenes.json"))
    parser.add_argument("--production", type=Path, required=True)
    parser.add_argument("--model", default="base.en")
    parser.add_argument("--threads", type=int, default=min(8, os.cpu_count() or 1))
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("--threads must be positive")
    align(args.manifest, args.production, args.model, args.threads)
