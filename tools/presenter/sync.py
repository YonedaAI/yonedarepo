"""Retiming for a presenter whose generated speech differs from supplied narration.

The generated clip must already have mouth motion aligned to its own audio.
This maps matching spoken-word boundaries onto the accepted narration's clock;
it does not synthesize or repair mouth shapes. No provider calls are made.
"""

from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re
import subprocess
from . import media


def word(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


def anchors(check, seconds, source_seconds):
    reference = [w for s in check["reference_segments"] for w in s["words"]]
    generated = [w for s in check["generated_segments"] for w in s["words"]]
    matcher = SequenceMatcher(None, [word(w["word"]) for w in reference],
                              [word(w["word"]) for w in generated], autojunk=False)
    if matcher.ratio() < 0.9:
        raise ValueError("Presenter speech differs too much; regenerate instead of retiming")
    points = [(0.0, 0.0)]
    for block in matcher.get_matching_blocks():
        for index in range(block.size):
            accepted, supplied = reference[block.a+index], generated[block.b+index]
            for edge in ("start", "end"):
                target, source = float(accepted[edge]), float(supplied[edge])
                if (target <= points[-1][1]+0.08 or source <= points[-1][0]+0.08
                        or target >= seconds-0.08 or source >= source_seconds-0.08):
                    continue
                slope = (target-points[-1][1])/(source-points[-1][0])
                if not 1/3 <= slope <= 3:
                    raise ValueError("Implausible timing anchor; inspect the speech alignment")
                points.append((source, target))
    points.append((source_seconds, seconds))
    if len(points) < 8:
        raise ValueError("Not enough matching speech boundaries to retime reliably")
    return points


def time_expression(points):
    # setpts evaluates in source time. Each interval maps onto narration time.
    expression = f"{points[-1][1]:.8f}"
    for (source, target), (end_source, end_target) in reversed(list(zip(points, points[1:]))):
        rate = (end_target-target)/(end_source-source)
        value = f"({target:.8f}+(T-{source:.8f})*{rate:.8f})"
        expression = f"if(lte(T,{end_source:.8f}),{value},{expression})"
    return f"setpts='{expression}/TB',fps=30"


def render(source, reference, check_path, section, seconds, target):
    source_info = media.inspect(source)
    video = next(s for s in source_info["streams"] if s["codec_type"] == "video")
    source_seconds = float(video["duration"])
    # The source must already be trimmed to a complete spoken phrase. Its
    # duration may differ deliberately from the accepted delivery's window.
    if not 0.5 <= seconds/source_seconds <= 2:
        raise ValueError("Source/output duration ratio is too large to retime reliably")
    if media.duration(reference)+0.01 < seconds:
        raise ValueError("Accepted narration is too short")
    points = anchors(json.loads(check_path.read_text())[section], seconds, source_seconds)
    target.parent.mkdir(parents=True, exist_ok=True)
    media.encode([
        "-i", str(source), "-i", str(reference), "-map", "0:v", "-map", "1:a",
        "-vf", time_expression(points), "-t", str(seconds),
    ], target)
    if abs(media.duration(target)-seconds) > 0.05:
        raise ValueError("Retimed clip duration is incorrect")
    report = {
        "method": "Matching spoken-word boundaries; presenter video follows accepted audio",
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "reference_sha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "source_seconds": source_seconds, "output_seconds": seconds,
        "anchors": [{"source": a, "output": b} for a, b in points],
        "max_original_drift_seconds": round(max(abs(a-b) for a, b in points), 3),
        "limitation": "Timing correction assumes native generated audio and mouth motion agree",
    }
    target.with_suffix(".timing.json").write_text(json.dumps(report, indent=2)+"\n")
    print(f"Retimed {section}: {len(points)} anchors; original drift "
          f"{report['max_original_drift_seconds']:.3f}s; {target}", flush=True)
