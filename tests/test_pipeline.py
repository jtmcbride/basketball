import json

import duckdb
import pytest
from bkbdata.api import create_app
from bkbdata.audit import build_audit
from bkbdata.catalog import Catalog
from bkbdata.contracts import ReplayBundle
from conftest import event_row, shot_row
from fastapi.testclient import TestClient
from pydantic import ValidationError


def test_offline_ingest_parquet_catalog_and_export_are_consistent(catalog_sample):
    report, paths = catalog_sample
    assert report["cached"] is False
    catalog = Catalog(paths["database"])
    assert catalog.games()[0]["shots"] == 2
    assert len(catalog.shots("0000000001")) == 2
    for segment in catalog.segments("0000000001"):
        bundle = catalog.replay("0000000001", segment["segment_id"])
        assert bundle.frames[0].elapsed_s == 0
        assert ReplayBundle.model_validate_json(bundle.model_dump_json()) == bundle
    with duckdb.connect() as db:
        count = db.read_parquet(str(paths["lake"] / "frames.parquet")).count("*").fetchone()[0]
    assert count == 4


def test_identical_ingest_is_idempotent_and_corrupt_outputs_fail(catalog_sample):
    report, paths = catalog_sample
    before = paths["database"].stat().st_mtime_ns
    second = build_audit(**paths)
    assert second["cached"] is True
    assert before == paths["database"].stat().st_mtime_ns
    assert second["source_fingerprint"] == report["source_fingerprint"]
    (paths["lake"] / "frames.parquet").write_bytes(b"corrupt")
    with pytest.raises(ValueError, match="Parquet missing or changed"):
        build_audit(**paths)


def test_raw_mutation_is_rejected(catalog_sample):
    _, paths = catalog_sample
    with (paths["raw"] / "tracking.7z").open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(ValueError, match="checksum mismatch"):
        build_audit(**paths)


def test_empty_shot_and_event_sources_remain_inspectable(sample_sources):
    from bkbdata.acquire import sha256

    paths = sample_sources
    for filename, row in (("shots.tar.xz", shot_row()), ("events.tar.xz", event_row())):
        archive = paths["raw"] / filename
        # Write the column header without data rows.
        import io
        import tarfile

        content = (",".join(row) + "\n").encode()
        with tarfile.open(archive, "w:xz") as stream:
            member = tarfile.TarInfo("generated.csv")
            member.size = len(content)
            stream.addfile(member, io.BytesIO(content))
        manifest_path = paths["raw"] / f"{filename}.manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["sha256"] = sha256(archive)
        manifest_path.write_text(json.dumps(manifest))
    report = build_audit(**paths)
    assert report["games"][0]["shots"] == 0
    assert Catalog(paths["database"]).shots("0000000001") == []


def test_api_pagination_missing_records_and_schema(catalog_sample):
    _, paths = catalog_sample
    client = TestClient(create_app(paths["database"]))
    assert client.get("/health").json()["catalog_available"] is True
    assert len(client.get("/games").json()["games"]) == 1
    response = client.get("/games/0000000001/shots?limit=1&offset=1")
    assert response.json()["total"] == 2
    assert len(response.json()["shots"]) == 1
    assert client.get("/games/0000000001/shots?limit=0").status_code == 422
    assert client.get("/games/missing").status_code == 404
    assert client.get("/games/missing/shots").status_code == 404
    segments = client.get("/games/0000000001/segments").json()["segments"]
    response = client.get(f"/games/0000000001/segments/{segments[0]['segment_id']}")
    assert response.status_code == 200
    assert ReplayBundle.model_validate(response.json()).segment_kind == "source_event_window"
    assert response.json()["events"][0]["source_event_id"] == "5"
    assert all(event["game_id"] == "0000000001" for event in response.json()["events"])
    assert client.get("/games/0000000001/segments/missing").status_code == 404


def test_absent_catalog_has_actionable_unavailable_state(tmp_path):
    client = TestClient(create_app(tmp_path / "missing.duckdb"))
    assert client.get("/health").json()["catalog_available"] is False
    assert client.get("/data-health").status_code == 503
    assert "make audit" in client.get("/games").json()["detail"]


def test_replay_rejects_unknown_version_and_nonfinite_positions(catalog_sample):
    _, paths = catalog_sample
    catalog = Catalog(paths["database"])
    segment = catalog.segments("0000000001")[0]
    data = json.loads(catalog.replay("0000000001", segment["segment_id"]).model_dump_json())
    data["schema_version"] = "unknown"
    with pytest.raises(ValidationError):
        ReplayBundle.model_validate(data)
    data["schema_version"] = "basketball-replay-v1"
    data["frames"][0]["entities"][0]["x_ft"] = float("inf")
    with pytest.raises(ValidationError):
        ReplayBundle.model_validate(data)


def test_replay_elapsed_time_is_bound_to_source_timestamps(catalog_sample):
    _, paths = catalog_sample
    catalog = Catalog(paths["database"])
    segment = catalog.segments("0000000001")[0]
    data = catalog.replay("0000000001", segment["segment_id"]).model_dump()
    data["frames"][1]["elapsed_s"] += 5
    with pytest.raises(ValidationError, match="Elapsed time must agree"):
        ReplayBundle.model_validate(data)
