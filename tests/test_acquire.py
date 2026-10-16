import json

import pytest
from bkbdata.acquire import fetch_sources, sha256


def test_cached_fetch_never_uses_network_and_checks_bytes(tmp_path, monkeypatch):
    raw = tmp_path / "raw"
    raw.mkdir()
    (raw / "sample").write_bytes(b"generated")
    source = {"id": "generated", "filename": "sample", "url": "https://example.invalid/sample"}
    (raw / "sample.manifest.json").write_text(
        json.dumps({**source, "sha256": sha256(raw / "sample")})
    )
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"sources": [source]}))

    def forbidden(*args, **kwargs):
        raise AssertionError("Cached fetch must not use network")

    monkeypatch.setattr("bkbdata.acquire.urlopen", forbidden)
    assert fetch_sources(config, raw)[0]["cached"] is True
    (raw / "sample").write_bytes(b"changed")
    with pytest.raises(ValueError, match="Checksum mismatch"):
        fetch_sources(config, raw)


def test_partial_cache_is_not_silently_overwritten(tmp_path):
    (tmp_path / "sample").write_bytes(b"interrupted")
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"sources": [{"filename": "sample"}]}))
    with pytest.raises(ValueError, match="Incomplete cache entry"):
        fetch_sources(config, tmp_path)
