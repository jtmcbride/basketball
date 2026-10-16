"""Controlled tied-clock substitutions and temporal model counts; no NBA records."""

import json
from pathlib import Path

from bkbdata.lineups import DEFINITION, possession_records, reconstruct
from bkbdata.shot_model import fit_report


def generate():
    players = [
        dict(
            player_id=f"{t}{i}",
            name=f"Generated {t} player {i}",
            team_id=t,
            jersey=str(i),
            position=None,
        )
        for t in ["10", "20"]
        for i in range(1, 7)
    ]
    game = dict(
        game_id="0000000001",
        game_date="2000-01-01",
        away_team="AWY",
        home_team="HOM",
        away_team_id="10",
        home_team_id="20",
        players=players,
        shots=3,
        unique_frames=0,
        source_event_windows=0,
        continuous_windows=0,
        partial_windows=0,
        empty_windows=0,
        periods=[dict(period=1, unique_frames=0, clock_min_s=0, clock_max_s=720)],
        joins={"shot_to_event": {"matched": 3}, "shot_to_tracking": {"matched": 0}},
        findings=[],
        examples=[],
    )
    events = []

    def event(kind, clock_s, p1="0", p2="0", score="", description=""):
        def team(p):
            return p[:2] if p != "0" else ""

        events.append(
            dict(
                GAME_ID="1",
                EVENTNUM=str(len(events)),
                EVENTMSGTYPE=str(kind),
                EVENTMSGACTIONTYPE="1",
                PERIOD="1",
                PCTIMESTRING=clock_s,
                PLAYER1_ID=p1,
                PLAYER1_TEAM_ID=team(p1),
                PLAYER2_ID=p2,
                PLAYER2_TEAM_ID=team(p2),
                PLAYER3_ID="0",
                PLAYER3_TEAM_ID="",
                HOMEDESCRIPTION="",
                VISITORDESCRIPTION=description,
                SCORE=score,
            )
        )

    event(12, "12:00")
    for i in range(1, 6):
        event(6, f"11:{60 - i:02d}", f"10{i}", f"20{i}")
    event(1, "10:00", "101", score="2 - 0", description="Generated A make")
    before = events[-1]["EVENTNUM"]
    event(8, "10:00", "101", "106")
    event(8, "10:00", "201", "206")
    event(2, "10:00", "106", description="MISS Generated A6")
    after = events[-1]["EVENTNUM"]
    event(1, "9:59", "206", score="2 - 3", description="Generated B make 3PT")
    other = events[-1]["EVENTNUM"]
    event(13, "0:00", score="2 - 3")
    shots = []
    for num, pid, value, made, x, y in [
        (before, "101", 2, True, 2, 8),
        (after, "106", 2, False, -8, 12),
        (other, "206", 3, True, 18, 20),
    ]:
        shots.append(
            dict(
                shot_id=f"shotchart:0000000001:{num}",
                game_id=game["game_id"],
                source_event_id=num,
                player_id=pid,
                player_name=next(p["name"] for p in players if p["player_id"] == pid),
                team_id=pid[:2],
                period=1,
                game_clock_s=600 if num != other else 599,
                made=made,
                action_type="Generated jump shot",
                lateral_ft=x,
                forward_ft=y,
                shot_value=value,
                recorded_distance_ft=10,
                event_join=dict(status="matched", reason=None),
                tracking_join=dict(
                    status="unavailable",
                    reason="Generated fixture: no tracking",
                    segment_id=None,
                    clock_delta_s=None,
                    timing_confidence="unavailable",
                    window_continuity=None,
                ),
            )
        )
    box = []
    for p in players:
        s = [s for s in shots if s["player_id"] == p["player_id"]]
        i = int(p["jersey"])
        box.append(
            dict(
                player_id=p["player_id"],
                name=p["name"],
                team_id=p["team_id"],
                starter=i <= 5,
                seconds=120 if i == 1 else 600 if i == 6 else 720,
                fga=len(s),
                fgm=sum(x["made"] for x in s),
                points=sum(x["made"] * x["shot_value"] for x in s),
                official_plus_minus=0,
            )
        )
    bundle = reconstruct(game, events, shots, box)
    possession_rows = [
        dict(
            GAMEID="1",
            OPPONENT="HOM",
            PERIOD="1",
            STARTTIME="10:01",
            ENDTIME="10:00",
            FG2A="1",
            FG2M="1",
            FG3A="0",
            FG3M="0",
            STARTTYPE="Generated start",
            EVENTS="Generated A make",
            DESCRIPTION="A",
            URL="",
        )
    ]
    possession_records(possession_rows, bundle)
    rows = []
    for s, date, gid in [
        (0, "20151101", "fit-game"),
        (1, "20151215", "calibration-game"),
        (2, "20160101", "test-game"),
    ]:
        for cell, n, made, x, y in [("0:0", 100, 70 - s, 0, 0), ("2:2", 100, 35 + s, 12.99, 7.5)]:
            rows.append(dict(game_id=gid, game_date=date, cell=cell, n=n, made=made, cx=x, cy=y))
    model = fit_report(
        rows,
        dict(
            model_fingerprint="generated-model",
            atlas_source_fingerprint="generated-atlas",
            source_attempts=600,
            event_unmatched=0,
            outside=0,
        ),
    )
    options = dict(
        schema_version="basketball-lineups-v1",
        source_fingerprint="generated-lineups",
        index_fingerprint="generated-index",
        definition=DEFINITION,
        input_identity={"sources": []},
        games=[
            dict(
                game_id=game["game_id"],
                game_date=game["game_date"],
                home_team="HOM",
                away_team="AWY",
                stints=2,
                available=2,
                shots=3,
                possession_coverage="incomplete",
            )
        ],
    )
    return dict(
        description="Generated tied-clock substitutions and model counts; no public trajectories",
        game=game,
        events=events,
        box=box,
        shots=shots,
        possession_rows=possession_rows,
        bundle=bundle.model_dump(),
        options=options,
        model_rows=rows,
        model=model,
        truth=dict(
            stint_durations_s=[120, 600],
            before_sub_shot=shots[0]["shot_id"],
            after_sub_shot=shots[1]["shot_id"],
            total_player_seconds=7200,
        ),
    )


if __name__ == "__main__":
    Path("tests/fixtures/m5-lineups.json").write_text(json.dumps(generate(), indent=2) + "\n")
