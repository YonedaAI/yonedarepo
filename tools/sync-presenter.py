#!/usr/bin/env python3
"""Retime an existing presenter locally to accepted narration; no paid inference.

Supply the local ASR speech-check JSON containing reference_segments and
generated_segments. This corrects timing drift, not incorrect mouth shapes.
"""

import argparse
from pathlib import Path
from presenter.sync import render


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--speech-check", type=Path, required=True)
    parser.add_argument("--section", default="opening")
    parser.add_argument("--seconds", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.seconds <= 0:
        parser.error("--seconds must be positive")
    render(args.source.resolve(), args.reference.resolve(), args.speech_check.resolve(),
           args.section, args.seconds, args.output.resolve())
