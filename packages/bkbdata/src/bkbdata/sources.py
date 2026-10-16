"""Read selected archive members without extracting arbitrary paths."""

from __future__ import annotations

import csv
import io
import json
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

import py7zr

from bkbdata.acquire import sha256


def game_id(value: str | int) -> str:
    """The CSV export lost NBA game-ID leading zeros; restore the ten-digit key."""
    text = str(value).strip()
    if not text.isdigit() or len(text) > 10:
        raise ValueError(f"Invalid NBA game ID: {value!r}")
    return text.zfill(10)


def read_manifests(config: Path, root: Path) -> list[dict]:
    config_data = json.loads(config.read_text())
    manifests = []
    for source in config_data["sources"]:
        manifest = json.loads((root / f"{source['filename']}.manifest.json").read_text())
        if any(manifest.get(key) != value for key, value in source.items()):
            raise ValueError(f"Source manifest does not match config: {source['id']}")
        if sha256(root / source["filename"]) != manifest["sha256"]:
            raise ValueError(f"Raw source checksum mismatch: {source['filename']}")
        manifests.append(manifest)
    return manifests


def read_tracking(path: Path) -> dict:
    """Only a single flat game JSON is supported in this source adapter."""
    with tempfile.TemporaryDirectory() as temporary:
        with py7zr.SevenZipFile(path) as archive:
            names = archive.getnames()
            if len(names) != 1 or PurePosixPath(names[0]).name != names[0]:
                raise ValueError("Expected one flat JSON member in tracking archive")
            if not names[0].endswith(".json"):
                raise ValueError("Tracking member must be JSON")
            archive.extract(path=temporary, targets=names)
        data = json.loads((Path(temporary) / names[0]).read_text())
    if not data.get("events"):
        raise ValueError("Tracking archive has no event windows")
    return data


def selected_csv_rows(path: Path, game_ids: set[str]) -> list[dict[str, str]]:
    """Stream the season CSV and retain only audited games."""
    with tarfile.open(path, "r:xz") as archive:
        members = [member for member in archive if member.isfile()]
        if len(members) != 1 or not members[0].name.endswith(".csv"):
            raise ValueError("Expected one CSV in the season archive")
        file = archive.extractfile(members[0])
        if file is None:
            raise ValueError("Cannot read source CSV")
        with io.TextIOWrapper(file, encoding="utf-8-sig", newline="") as stream:
            return [row for row in csv.DictReader(stream) if game_id(row["GAME_ID"]) in game_ids]


def parse_clock(value: str) -> float:
    minutes, seconds = value.split(":")
    return int(minutes) * 60 + float(seconds)
