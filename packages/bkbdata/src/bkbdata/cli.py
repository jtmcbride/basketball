"""Explicit fetch, offline audit, validated export, and local serving commands."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from bkbdata.acquire import fetch_sources
from bkbdata.annotations import annotation_index
from bkbdata.atlas import build_atlas
from bkbdata.audit import build_audit
from bkbdata.catalog import Catalog
from bkbdata.contracts import ReplayBundle


def main() -> None:
    parser = argparse.ArgumentParser(prog="basketball")
    sub = parser.add_subparsers(dest="command", required=True)
    fetch = sub.add_parser("fetch", help="Download and checksum the pinned sample sources")
    fetch.add_argument("--config", type=Path, default=Path("config/sources.json"))
    fetch.add_argument("--raw", type=Path, default=Path("data/raw"))
    audit = sub.add_parser("audit", help="Build the local catalog and measured audit offline")
    audit.add_argument("--config", type=Path, default=Path("config/sources.json"))
    audit.add_argument("--raw", type=Path, default=Path("data/raw"))
    audit.add_argument("--database", type=Path, default=Path("data/db/basketball.duckdb"))
    audit.add_argument("--lake", type=Path, default=Path("data/lake/sample"))
    audit.add_argument("--report", type=Path, default=Path("data/exports/data-audit.json"))
    atlas = sub.add_parser("atlas", help="Build verified season shot partitions offline")
    atlas.add_argument("--config", type=Path, default=Path("config/atlas-sources.json"))
    atlas.add_argument("--raw", type=Path, default=Path("data/raw"))
    atlas.add_argument("--database", type=Path, default=Path("data/db/atlas.duckdb"))
    atlas.add_argument("--lake", type=Path, default=Path("data/lake/atlas"))
    for command in ("health", "games", "export", "serve", "annotations"):
        child = sub.add_parser(command)
        child.add_argument("--database", type=Path, default=Path("data/db/basketball.duckdb"))
        if command == "annotations":
            child.add_argument("--path", type=Path, default=Path("annotations/curated-v1.json"))
        if command == "export":
            child.add_argument("--game-id", required=True)
            child.add_argument("--segment-id", required=True)
            child.add_argument("--output", required=True, type=Path)
        if command == "serve":
            child.add_argument("--host", default="127.0.0.1")
            child.add_argument("--port", default=8007, type=int)
    validate = sub.add_parser("validate-replay")
    validate.add_argument("path", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "fetch":
            result = fetch_sources(args.config, args.raw)
        elif args.command == "atlas":
            result = build_atlas(args.config, args.raw, args.database, args.lake)
        elif args.command == "audit":
            result = build_audit(args.config, args.raw, args.database, args.lake, args.report)
            result = {
                "cached": result["cached"],
                "games": [
                    {
                        k: game[k]
                        for k in (
                            "game_id",
                            "shots",
                            "unique_frames",
                            "continuous_windows",
                            "partial_windows",
                            "joins",
                        )
                    }
                    for game in result["games"]
                ],
                "report": str(args.report),
            }
        elif args.command == "annotations":
            result = annotation_index(args.path, Catalog(args.database))
        elif args.command == "health":
            result = Catalog(args.database).health()
        elif args.command == "games":
            result = Catalog(args.database).games()
        elif args.command == "export":
            bundle = Catalog(args.database).replay(args.game_id, args.segment_id)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(bundle.model_dump_json(indent=2) + "\n")
            result = {
                "output": str(args.output),
                "frames": len(bundle.frames),
                "schema_version": bundle.schema_version,
            }
        elif args.command == "validate-replay":
            bundle = ReplayBundle.model_validate_json(args.path.read_text())
            result = {
                "valid": True,
                "schema_version": bundle.schema_version,
                "frames": len(bundle.frames),
            }
        elif args.command == "serve":
            import uvicorn

            from bkbdata.api import create_app

            uvicorn.run(create_app(args.database), host=args.host, port=args.port)
            return
        print(json.dumps(result, indent=2))
    except (ValueError, FileNotFoundError, KeyError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
