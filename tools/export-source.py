#!/usr/bin/env python3
"""Export a committed public source snapshot without private drafting history."""

import argparse
import io
from pathlib import Path
import subprocess
import tarfile


def export(revision: str, destination: Path) -> None:
    if destination.exists() and any(destination.iterdir()):
        raise SystemExit("Destination must be new or empty; existing files are never removed")
    commit = subprocess.check_output(
        ["git", "rev-parse", "--verify", revision + "^{commit}"], text=True
    ).strip()
    archive = subprocess.check_output(["git", "archive", commit])
    destination.mkdir(parents=True, exist_ok=True)
    excluded = {"context", ".local", ".superpowers", ".wrangler", "artifacts"}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
        members = [m for m in source.getmembers() if m.name.split("/")[0] not in excluded]
        source.extractall(destination, members=members, filter="data")
    (destination / "context").mkdir(exist_ok=True)
    (destination / "context" / "README.md").write_text(
        "# Public design context\n\n"
        "Read [the architecture](../docs/architecture.md), "
        "[product plan](../docs/product-mvp-plan.md), "
        "and [release evidence](../docs/release-evidence.md).\n\n"
        "Raw private drafting conversations are omitted from this public snapshot. "
        "The platform implementation and its Apache-2.0 license are included.\n"
    )
    (destination / "PUBLIC_SOURCE.md").write_text(
        "# Source provenance\n\n"
        f"This source snapshot was exported from implementation commit `{commit}`.\n\n"
        "It contains committed implementation, tests, configuration and public documentation. "
        "Private drafting conversations, local credentials, generated builds, recordings "
        "and private Git history are excluded. Subsequent public commits retain their own history.\n"
    )
    print(f"Exported {commit} to {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    export(args.revision, args.output.resolve())
