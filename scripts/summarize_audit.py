"""Publish aggregate audit evidence without copying the raw tracking dataset."""

import json
import platform
from pathlib import Path

report = json.loads(Path("data/exports/data-audit.json").read_text())
games = []
for game in report["games"]:
    gid = game["game_id"]
    games.append(
        {
            **{key: value for key, value in game.items() if key != "players"},
            "diagnostics": report["diagnostics"][gid],
            "coordinate_checks": {
                **{
                    key: value
                    for key, value in report["coordinate_checks"][gid].items()
                    if key != "groups"
                },
                "groups": [
                    {key: value for key, value in group.items() if key != "examples"}
                    for group in report["coordinate_checks"][gid]["groups"]
                ],
            },
        }
    )
summary = {
    "schema_version": report["schema_version"],
    "source_fingerprint": report["source_fingerprint"],
    "pipeline_fingerprint": report["pipeline_fingerprint"],
    "software": report["software"],
    "sources": report["sources"],
    "thresholds": report["thresholds"],
    "boundaries": report["boundaries"],
    "games": games,
    "parquet_files": report["parquet_files"],
}
runtime = Path("data/exports/audit-runtime.json")
if runtime.exists() and all(
    json.loads(runtime.read_text()).get(key) == report[key]
    for key in ("source_fingerprint", "pipeline_fingerprint")
):
    summary["local_runtime_observation"] = {
        **json.loads(runtime.read_text()),
        "platform": platform.platform(),
        "note": "Single uncached local run; not a cross-machine performance guarantee.",
    }
output = Path("artifacts/audit-summary.json")
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(summary, indent=2) + "\n")
print(f"Wrote {output}")
