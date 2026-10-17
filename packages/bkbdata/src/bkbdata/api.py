"""Local read-only service. Data acquisition is an explicit CLI action."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query

from bkbdata.actions import Actions
from bkbdata.annotations import annotation_index
from bkbdata.arcs import Arcs
from bkbdata.assists import Assists
from bkbdata.atlas import Atlas
from bkbdata.catalog import Catalog
from bkbdata.contracts import AUDIT_VERSION, ReplayBundle
from bkbdata.lineups import Lineups
from bkbdata.shot_model import ShotModel


def create_app(
    database: Path = Path("data/db/basketball.duckdb"),
    atlas_database: Path | None = None,
    annotations_path: Path = Path("annotations/curated-v1.json"),
    actions_database: Path | None = None,
    lineups_database: Path | None = None,
    shot_model_path: Path | None = None,
    arcs_path: Path | None = None,
    assists_database: Path | None = None,
) -> FastAPI:
    app = FastAPI(title="Basketball Motion Lab", version="0.1.0")
    catalog = Catalog(database)
    atlas = Atlas(atlas_database or database.with_name("atlas.duckdb"))
    actions = Actions(
        actions_database or database.with_name("actions.duckdb"), catalog, annotations_path
    )
    lineups = Lineups(lineups_database or database.with_name("lineups.duckdb"), database)
    shot_model = ShotModel(
        shot_model_path or database.parent.parent / "models/location-v1.json",
        atlas_database or database.with_name("atlas.duckdb"),
    )

    assists = Assists(
        assists_database or database.with_name("assists.duckdb"),
        atlas_database or database.with_name("atlas.duckdb"),
    )
    arcs = Arcs(arcs_path or database.parent.parent / "exports/arcs-v1.json", database)

    def read(action):
        try:
            return action()
        except FileNotFoundError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except KeyError as error:
            raise HTTPException(status_code=404, detail=error.args[0]) from error

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "catalog_available": database.is_file(),
            "audit_schema": AUDIT_VERSION,
        }

    @app.get("/data-health")
    def data_health():
        return read(catalog.health)

    @app.get("/games")
    def games():
        return {"games": read(catalog.games)}

    @app.get("/games/{game_id}")
    def game(game_id: str):
        return read(lambda: catalog.game(game_id))

    @app.get("/games/{game_id}/shots")
    def shots(game_id: str, limit: int = Query(200, ge=1, le=500), offset: int = Query(0, ge=0)):
        rows = read(lambda: catalog.shots(game_id))
        return {"shots": rows[offset : offset + limit], "total": len(rows)}

    @app.get("/games/{game_id}/segments")
    def segments(game_id: str, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0)):
        rows = read(lambda: catalog.segments(game_id))
        return {"segments": rows[offset : offset + limit], "total": len(rows)}

    @app.get("/games/{game_id}/segments/{segment_id}", response_model=ReplayBundle)
    def replay(game_id: str, segment_id: str):
        return read(lambda: catalog.replay(game_id, segment_id))

    @app.get("/annotations")
    def annotations():
        return read(lambda: annotation_index(annotations_path, catalog))

    @app.get("/lineups/options")
    def lineup_options():
        return read(lineups.read)

    @app.get("/lineups/games/{game_id}")
    def lineup_game(game_id: str):
        return read(lambda: lineups.read(game_id))

    @app.get("/models/location")
    def location_model():
        return read(shot_model.read)

    @app.get("/arcs")
    def ball_flights():
        return read(arcs.read)

    @app.get("/assists/options")
    def assist_options():
        return read(assists.options)

    @app.get("/assists/summary")
    def assist_summary(
        season: str,
        team_id: str,
        player_id: str | None = None,
        role: Literal["shooter", "passer"] = "shooter",
    ):
        return read(lambda: assists.summary(season, team_id, player_id, role))

    @app.get("/actions/options")
    def action_options():
        return read(actions.options)

    @app.get("/actions/features/{candidate_id}")
    def action_feature(candidate_id: str):
        return read(lambda: actions.feature(candidate_id))

    @app.get("/actions/search")
    def action_search(
        seed_id: str | None = None,
        annotation_id: str | None = None,
        player_id: str | None = None,
        feature_id: str | None = None,
        profile: Literal["start_relative", "court_location"] = "start_relative",
        same_player: bool = False,
        other_game: bool = False,
        limit: int = Query(12, ge=1, le=30),
    ):
        return read(
            lambda: actions.search(
                seed_id,
                annotation_id,
                player_id,
                feature_id,
                profile,
                same_player,
                other_game,
                limit,
            )
        )

    @app.get("/atlas/options")
    def atlas_options():
        return read(atlas.options)

    @app.get("/atlas/summary")
    def atlas_summary(
        season: str,
        player_id: str | None = None,
        team_id: str | None = None,
        opponent: str | None = None,
        period: int | None = Query(None, ge=1, le=20),
        shot_value: int | None = Query(None, ge=2, le=3),
    ):
        filters = dict(
            season=season,
            player_id=player_id,
            team_id=team_id,
            opponent=opponent,
            period=period,
            shot_value=shot_value,
        )
        return read(lambda: atlas.summary(filters))

    @app.get("/atlas/attempts")
    def atlas_attempts(
        season: str,
        player_id: str | None = None,
        team_id: str | None = None,
        opponent: str | None = None,
        period: int | None = Query(None, ge=1, le=20),
        shot_value: int | None = Query(None, ge=2, le=3),
        cell: str | None = None,
        offset: int = Query(0, ge=0),
        limit: int = Query(50, ge=1, le=100),
    ):
        filters = dict(
            season=season,
            player_id=player_id,
            team_id=team_id,
            opponent=opponent,
            period=period,
            shot_value=shot_value,
        )
        result = read(lambda: atlas.attempts(filters, cell, offset, limit))
        # Historical shots gain a replay link only through the audited M0/M1 join.
        games = {g["game_id"] for g in catalog.games()} if database.exists() else set()
        sample = {
            gid: {s["shot_id"]: s for s in catalog.shots(gid)}
            for gid in {s["game_id"] for s in result["attempts"]} & games
        }
        for row in result["attempts"]:
            audited = sample.get(row["game_id"], {}).get(row["shot_id"])
            agrees = (
                row["event_matched"]
                and audited
                and all(
                    audited[key] == row[key]
                    for key in (
                        "player_id",
                        "team_id",
                        "period",
                        "game_clock_s",
                        "made",
                        "shot_value",
                        "lateral_ft",
                        "forward_ft",
                        "action_type",
                    )
                )
            )
            row["tracking_status"] = audited["tracking_join"]["status"] if agrees else "unavailable"
            row["tracking_reason"] = (
                audited["tracking_join"]["reason"]
                if agrees
                else "No audited tracking window in the local sample"
            )
        return result

    return app
