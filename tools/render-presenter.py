#!/usr/bin/env python3
"""Offline assembly of the 8:48 presenter edit from already-generated media.

Optional dependencies: ffmpeg, ffprobe, Pillow. It does not contact providers,
spend credits, upload portraits, drive browsers or start platform agent runs.
Generate voice, presenter clips and local word alignments separately.
"""

import argparse
from pathlib import Path
from presenter.assembly import render


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=Path("docs/video/presenter-scenes.json"))
    parser.add_argument("--edit", type=Path, default=Path("docs/video/presenter-edit.json"))
    parser.add_argument("--production", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--captures", type=Path, default=Path("artifacts/screenshots"))
    args = parser.parse_args()
    render(args.manifest, args.edit, args.production.resolve(), args.output.resolve(), args.captures.resolve())
