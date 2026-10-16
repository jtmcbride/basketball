"""Evaluate frozen candidate logic offline; no automatic labels enter the API."""

import json
from pathlib import Path

from bkbdata.acquire import sha256
from bkbdata.annotations import AnnotationSet
from bkbdata.catalog import Catalog
from bkbdata.catch_evaluation import evaluate

collection = AnnotationSet.model_validate_json(Path("annotations/curated-v1.json").read_text())
result = evaluate(collection, Catalog(Path("data/db/basketball.duckdb")))
result["annotation_sha256"] = sha256(Path("annotations/curated-v1.json"))
result["candidate_code_sha256"] = sha256(Path("packages/bkbdata/src/bkbdata/catch_evaluation.py"))
Path("artifacts/m3-candidate-evaluation.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
