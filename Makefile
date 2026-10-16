export UV_CACHE_DIR ?= $(CURDIR)/.cache/uv
export npm_config_cache ?= $(CURDIR)/.cache/npm

.PHONY: setup fetch audit api dev test web-build lint contract fixtures atlas-fetch atlas actions lineup-fetch lineups shot-model

setup:
	uv sync --locked
	cd apps/web && npm ci

fetch:
	uv run basketball fetch

audit:
	uv run basketball audit

api:
	uv run basketball serve

dev:
	cd apps/web && npm run dev

test:
	uv run pytest
	cd apps/web && npm test
	cd apps/web && npm run typecheck

lint:
	uv run ruff check packages tests scripts

web-build:
	cd apps/web && npm run build

contract:
	uv run python scripts/export_schema.py

fixtures:
	uv run python scripts/generate_motion_fixture.py
	uv run python scripts/generate_annotation_fixture.py
	uv run python scripts/generate_action_fixture.py
	uv run python scripts/generate_lineup_fixture.py

atlas-fetch:
	uv run basketball fetch --config config/atlas-sources.json

atlas:
	uv run basketball atlas

actions:
	uv run basketball actions

lineup-fetch:
	uv run basketball fetch --config config/lineup-sources.json

lineups:
	uv run basketball lineups

shot-model:
	uv run basketball shot-model
