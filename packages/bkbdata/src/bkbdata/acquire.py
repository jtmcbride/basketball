"""Explicit network acquisition with immutable local manifests; no extraction."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_sources(config: Path, root: Path) -> list[dict]:
    """Download once; later calls verify cached bytes without using the network."""
    sources = json.loads(config.read_text())["sources"]
    root.mkdir(parents=True, exist_ok=True)
    results = []
    for source in sources:
        filename = source["filename"]
        if Path(filename).name != filename:
            raise ValueError("Source filenames must be basenames")
        target = root / filename
        manifest = root / f"{filename}.manifest.json"
        if target.exists() or manifest.exists():
            if not target.exists() or not manifest.exists():
                raise ValueError(
                    f"Incomplete cache entry: {filename}; restore or remove it explicitly"
                )
            saved = json.loads(manifest.read_text())
            if any(saved.get(key) != value for key, value in source.items()):
                raise ValueError(f"Source definition changed for cached file: {filename}")
            if sha256(target) != saved["sha256"]:
                raise ValueError(f"Checksum mismatch: {filename}")
            results.append({**saved, "cached": True})
            continue
        temporary = target.with_suffix(target.suffix + ".part")
        try:
            request = Request(source["url"], headers={"User-Agent": "BasketballMotionLab/0.1"})
            with urlopen(request, timeout=60) as response, temporary.open("wb") as stream:
                for block in iter(lambda: response.read(1024 * 1024), b""):
                    stream.write(block)
            checksum = sha256(temporary)
            if source.get("sha256") and checksum != source["sha256"]:
                raise ValueError(f"Downloaded checksum mismatch: {filename}")
            saved = {
                **source,
                "sha256": checksum,
                "bytes": temporary.stat().st_size,
                "acquired_at": datetime.now(timezone.utc).isoformat(),
            }
            os.replace(temporary, target)
            manifest.write_text(json.dumps(saved, indent=2) + "\n")
            results.append({**saved, "cached": False})
        finally:
            temporary.unlink(missing_ok=True)
    return results
