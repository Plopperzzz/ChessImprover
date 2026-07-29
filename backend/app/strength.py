"""Pooled strength estimate across a whole library of games (spec section 9).

One game is about 25 of your moves, and under the top-1 objective that was not
enough to estimate anything: simulated at that size it gave a spread of 275 Elo
over seeds and an interval that covered the truth 62% of the time. The
likelihood objective (`policy_likelihood`) brings that to 80 Elo and 97%, so a
single game is now worth showing -- but the interval is still around +-180 Elo
and rests on treating one game's moves as independent, which they are not.

So pooling is still where the number to act on comes from. This fits one curve
to every position from every game that has a stored sweep.

Two things fall out of pooling that a single game can't give you:

* **A real interval.** The bootstrap resamples *games*, not moves, because
  moves from one game share an opponent, an opening and a sitting. Resampling
  moves would report an interval far tighter than the data supports.
* **A calibration.** The sweep already scores your opponents' moves as well as
  yours, and the PGN headers say what those opponents were actually rated. So
  the same run that estimates you also estimates the field you played, and the
  gap between the field's Maia estimate and the field's real average rating is
  the offset between the two scales. Maia-3's SelfElo is calibrated to Lichess
  ratings, which sit a few hundred points above Chess.com at club level; rather
  than asking you to remember the conversion, it is measured from your own
  opponents.

Nothing here runs an engine. It re-reads the per-position scores stored by
section 13 and re-fits, so it is as cheap to run as loading the rows.
"""

import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException

from . import elo_sweep, maia_accuracy
from .auth import require_user
from .db import db_cursor
from .engine_settings import get_effective_settings

router = APIRouter(prefix="/api/strength", tags=["strength"])

MIN_COMMON_GRID = 3


def _header_elo(headers_json: str, side: str):
    try:
        headers = json.loads(headers_json or "{}")
    except ValueError:
        return None
    raw = headers.get("WhiteElo" if side == "w" else "BlackElo")
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return None
    return value if 100 <= value <= 4000 else None


def collect(user_id: int, run_id: int | None = None) -> tuple[list[dict], dict]:
    """One entry per analysed game, carrying both sides' score rows.

    Only the latest analysis of each game is used: a game re-analysed, or
    appended into a second run, would otherwise contribute its positions twice
    and tighten every interval for free.
    """
    skipped = {"no_full_analysis": 0, "unassigned_color": 0,
               "no_sweep_positions": 0, "no_header_elo": 0}
    params: list = [user_id]
    run_clause = ""
    if run_id is not None:
        run_clause = " AND rg.run_id = ?"
        params.append(run_id)

    # A standalone Elo sweep produces the same swept grid and the same
    # per-position rows a full run does -- it just skips the Stockfish pass --
    # so the fit has no reason to ignore one. Full first when a game has both,
    # since it is the more recent shape of the same data.
    swept_modes = ("full", "sweep")

    with db_cursor() as conn:
        skipped["no_full_analysis"] = conn.execute(
            """SELECT COUNT(*) AS n FROM games g
               WHERE g.user_id = ? AND NOT EXISTS (
                 SELECT 1 FROM run_games rg
                 WHERE rg.game_id = g.id AND rg.user_id = g.user_id
                   AND rg.mode IN ('full', 'sweep'))""",
            (user_id,),
        ).fetchone()["n"]

        rows = conn.execute(
            f"""SELECT rg.id AS run_game_id, rg.grid_json, rg.analyzed_at,
                       rg.maia_model_size, rg.engine_note,
                       g.id AS game_id, g.your_color, g.white, g.black,
                       g.utc_date_header, g.date_header, g.headers_json
                FROM run_games rg
                JOIN games g ON g.id = rg.game_id
                WHERE rg.user_id = ? AND rg.mode IN (?, ?){run_clause}
                ORDER BY g.id, (rg.mode = 'full') DESC, rg.analyzed_at DESC""",
            [user_id, *swept_modes] + params[1:],
        ).fetchall()

        seen: set[int] = set()
        entries = []
        for row in rows:
            if row["game_id"] in seen:
                continue
            seen.add(row["game_id"])
            if row["your_color"] not in ("w", "b"):
                skipped["unassigned_color"] += 1
                continue
            try:
                grid = json.loads(row["grid_json"] or "null")
            except ValueError:
                grid = None
            if not grid:
                skipped["no_sweep_positions"] += 1
                continue
            yours, theirs = row["your_color"], "b" if row["your_color"] == "w" else "w"
            scores = {"w": [], "b": []}
            for r in conn.execute(
                "SELECT side, scores, policies, think_ms FROM sweep_positions "
                "WHERE run_game_id = ? ORDER BY ply",
                (row["run_game_id"],),
            ):
                if r["scores"] and len(r["scores"]) == len(grid):
                    # The policy string is twice as long as the grid, so a row
                    # whose length disagrees is from a different grid and is
                    # dropped back to the rank surrogate rather than misread.
                    policies = r["policies"] if (
                        r["policies"] and len(r["policies"]) == 2 * len(grid)) else None
                    scores.setdefault(r["side"], []).append(
                        (r["scores"], policies, r["think_ms"]))
            if not scores[yours]:
                skipped["no_sweep_positions"] += 1
                continue
            your_elo = _header_elo(row["headers_json"], yours)
            if your_elo is None:
                skipped["no_header_elo"] += 1
            entries.append({
                "game_id": row["game_id"],
                "grid": [int(v) for v in grid],
                # Backfilled at startup, but fall back to the note here too so
                # a row written between a schema upgrade and the backfill still
                # gets anchored.
                "model_size": (row["maia_model_size"]
                               or maia_accuracy.model_size_from_note(row["engine_note"])),
                "you": scores[yours],
                "opponent": scores[theirs],
                "your_elo": your_elo,
                "opponent_elo": _header_elo(row["headers_json"], theirs),
                "opponent_name": row["black"] if yours == "w" else row["white"],
                "date": row["utc_date_header"] or row["date_header"],
                "day_known": _day_known(row),
            })
    return entries, skipped


def _day_known(row) -> bool:
    for raw in (row["utc_date_header"], row["date_header"]):
        if raw:
            parts = str(raw).replace("-", ".").split(".")
            return len(parts) > 2 and parts[2].isdigit()
    return False


def common_grid(entries: list[dict], key: str = "you") -> tuple[list[int], list[dict], int]:
    """Games may have been swept on different grids -- a single-game sweep at
    step 100 and a batch at step 200 over the same range. Pool on the Elos they
    share rather than interpolating: every score used is one the engine
    actually produced. Falls back to the most-represented grid when the shared
    set is too thin to fit, and says how many games that dropped."""
    usable = [e for e in entries if e.get(key)]
    if not usable:
        return [], [], 0
    shared = set(usable[0]["grid"])
    for entry in usable[1:]:
        shared &= set(entry["grid"])
    if len(shared) >= MIN_COMMON_GRID:
        return sorted(shared), usable, 0

    tally: dict[tuple, int] = {}
    for entry in usable:
        tally[tuple(entry["grid"])] = tally.get(tuple(entry["grid"]), 0) + len(entry[key])
    best = list(max(tally, key=lambda g: tally[g]))
    kept = [e for e in usable if set(best) <= set(e["grid"])]
    return best, kept, len(usable) - len(kept)


# Refuse to apply the think-time filter when it would take more than this
# share of the positions. That is not a filter, it is a different (much
# smaller) dataset, and it happens the moment someone points this at a bullet
# library where every move is under a second.
MAX_FILTERED_FRACTION = 0.6


def apply_think_filter(entries: list[dict], key: str, min_think_ms: int) -> dict:
    """Drops positions the player barely thought about, and reports what it
    did. A move played in half a second is a premove or an automatic
    recapture; it says nothing about how well someone plays.

    Positions with no clock recorded are kept -- unknown is not instant, and
    every game uploaded before clocks were captured has no clock at all.
    """
    info = {"applied": False, "min_think_ms": int(min_think_ms),
            "eligible": 0, "would_drop": 0, "dropped": 0, "reason": None}
    if min_think_ms <= 0:
        info["reason"] = "off"
        return info
    eligible = would_drop = 0
    for entry in entries:
        for *_row, think in entry.get(key, []):
            if think is None:
                continue
            eligible += 1
            if think < min_think_ms:
                would_drop += 1
    info["eligible"] = eligible
    info["would_drop"] = would_drop
    if not eligible:
        info["reason"] = "these games carry no clock times"
        return info
    if would_drop >= MAX_FILTERED_FRACTION * eligible:
        info["reason"] = (f"{would_drop / eligible:.0%} of your moves were played in under "
                          f"{min_think_ms / 1000:g}s, so filtering them would leave a different "
                          f"library rather than a cleaner one -- left off")
        return info

    for entry in entries:
        entry[key] = [row for row in entry.get(key, [])
                      if row[-1] is None or row[-1] >= min_think_ms]
    info["applied"] = True
    info["dropped"] = would_drop
    return info


def matrix(entries: list[dict], grid: list[int], key: str = "you"):
    """(rank rows, game_ids, log policy rows) for the pooled fit.

    The game id per row is what lets the interval treat a game rather than a
    move as the independent unit. Rows carry Maia's rank for the played move,
    which `elo_sweep.estimate_from_ranks` turns into whichever objective is
    asked for.

    The policy block comes back only when *every* pooled row has one. A library
    part-swept by a policy-reporting build and part by a stock one would
    otherwise be fitted with two different scales mixed down one column, and
    the rank surrogate applied to all of it is both consistent and only a
    little less precise.
    """
    rows, groups, policies = [], [], []
    for entry in entries:
        index = {elo: i for i, elo in enumerate(entry["grid"])}
        columns = [index[elo] for elo in grid]
        for scores, policy, _think in entry.get(key, []):
            decoded = elo_sweep.decode_scores(scores)
            rows.append([decoded[i] for i in columns])
            logs = elo_sweep.decode_policies(policy)
            policies.append([logs[i] for i in columns] if logs else None)
            groups.append(entry["game_id"])
    if not rows:
        return np.zeros((0, len(grid))), np.zeros(0, dtype=int), None
    log_policies = (np.asarray(policies, dtype=float)
                    if policies and all(p is not None for p in policies) else None)
    return np.asarray(rows, dtype=float), np.asarray(groups, dtype=int), log_policies


def model_counts(entries: list[dict], key: str) -> dict:
    """{model_size: positions} over the games that made it into the fit.

    Weighted by positions rather than games because that is what the pooled
    curve is an average over -- a 40-move game swept with 79m should pull the
    anchor further than a 20-move one swept with 5m.
    """
    counts: dict = {}
    for entry in entries:
        n = len(entry.get(key, []))
        if n:
            counts[entry.get("model_size")] = counts.get(entry.get("model_size"), 0) + n
    return counts


def _side_estimate(entries: list[dict], key: str, top_n: int = 1,
                   accuracy_offset: float = 0.0,
                   objective: str = elo_sweep.DEFAULT_OBJECTIVE) -> dict:
    grid, usable, excluded = common_grid(entries, key)
    if not grid or len(grid) < 2:
        return {"estimate": None, "confidence": "low", "games": 0,
                "reasons": ["no comparable sweep data"], "grid": grid,
                "games_excluded_grid_mismatch": excluded}
    ranks, groups, log_policies = matrix(usable, grid, key)
    # One curve for the pool. The sizes differ by two or three points of match
    # rate at master level and barely at all at 800, so a library swept with a
    # mixture is anchored against the mixture rather than against whichever
    # model happened to sweep the most games.
    counts = model_counts(usable, key)
    accuracy = maia_accuracy.blend(counts, accuracy_offset)
    result = elo_sweep.estimate_from_ranks(grid, ranks, groups=groups,
                                           accuracy=accuracy, top_n=top_n,
                                           objective=objective,
                                           log_policies=log_policies)
    result["games"] = len({int(g) for g in groups})
    result["top_n"] = top_n
    result["model_sizes"] = {(size or "unknown"): n for size, n in counts.items()}
    # How much of the extra ordering information there is to use. Sweeps run
    # before MultiPV was recorded, or against a build without it, only ever
    # stored rank 1, and a top-N objective on those is just top-1 again.
    result["max_rank_seen"] = int(ranks.max()) if ranks.size else 0
    result["games_excluded_grid_mismatch"] = excluded
    return result


def _usable_for_calibration(result: dict) -> str | None:
    """Why this estimate can't anchor a scale conversion, or None if it can.

    The offset is only as good as the field estimate it is measured from. A
    flat curve or a peak pinned to the edge of the grid gives a number, and
    subtracting that number from yours would produce a confident-looking
    figure built on nothing.
    """
    if result.get("estimate") is None:
        return "the opposition sweep produced no estimate"
    if result.get("confidence") == "low":
        return "the opposition estimate is low confidence"
    grid = result.get("grid") or []
    if len(grid) >= 2:
        edge = 0.02 * (grid[-1] - grid[0])
        if result["estimate"] <= grid[0] + edge or result["estimate"] >= grid[-1] - edge:
            return ("the opposition estimate sits on the edge of the swept Elo range, "
                    "so it is a bound rather than a measurement")
    return None


def _calibrate(you: dict, field: dict, opponent_ratings: list) -> dict:
    if not opponent_ratings:
        return {"available": False,
                "reason": "no opponent ratings in the PGN headers to calibrate against"}
    for result, who in ((field, "opposition"), (you, "your own")):
        blocker = _usable_for_calibration(result)
        if blocker:
            return {"available": False,
                    "reason": blocker if who == "opposition"
                    else "your own estimate isn't firm enough to convert"}

    field_actual = float(np.mean(opponent_ratings))
    offset = field["estimate"] - field_actual
    return {
        "available": True,
        "field_estimate": field["estimate"],
        "field_actual": round(field_actual, 1),
        "field_actual_n": len(opponent_ratings),
        "offset": round(offset, 1),
        # Your estimate moved onto the same scale your opponents' ratings are
        # on -- measured from your own games, not a lookup table.
        "your_calibrated": round(you["estimate"] - offset),
        "your_calibrated_low": (round(you["ci_low"] - offset)
                                if you.get("ci_low") is not None else None),
        "your_calibrated_high": (round(you["ci_high"] - offset)
                                 if you.get("ci_high") is not None else None),
    }


def _predictability(you: dict, think: dict, top_n: int) -> dict:
    """How predictable this player is, against the model's published curve.

    Two numbers come out of the same fit and mean different things. The
    estimate is read off *where* the match rate peaks; this is read off *how
    high* it peaked. A player whose moves are all of a piece hits the curve for
    their rating; one who alternates brilliance and blunders averages out to
    the same estimate but never gets near it, because no single Elo setting
    predicts both halves of their play.

    So the gap between the two is the interesting quantity, and it is not an
    error bar -- it is the part of someone's play that strength alone doesn't
    describe.
    """
    # Under the likelihood objective this comes out of the fit itself. Mean log
    # probability per move sits between two fixed points -- what the model
    # manages on a player whose rating it has right, and what guessing among
    # legal moves scores -- so "how predictable is this player" needs no
    # published curve, no model-size anchor and no blitz caveat. It is the same
    # quantity the top-1 branch below approximates with a match rate, measured
    # better.
    if (you or {}).get("mean_logp") is not None and you.get("well_predicted_logp"):
        best = max(you.get("full_match_rates") or [you["mean_logp"]])
        expected, floor = you["well_predicted_logp"], you["unpredictable_logp"]
        reached = (best - floor) / (expected - floor) if expected != floor else None
        return {
            "available": True,
            "scale": "logp",
            "observed": round(best, 3),
            "expected": round(expected, 3),
            "unpredictable": round(floor, 3),
            # 1.0 means "as predictable as the population Maia was measured on",
            # 0.0 means "no better than guessing".
            "reached": round(reached, 3) if reached is not None else None,
            "think_filtered": bool(think.get("applied")),
            "note": ("Measured on an absolute scale -- log probability per move -- so it is "
                     "comparable across your games and grids without the blitz correction the "
                     "top-1 match rate needs."),
        }

    ceiling = (you or {}).get("ceiling")
    if not ceiling:
        return {
            "available": False,
            "reason": ("the top-N objective has no published accuracy to compare against "
                       "-- switch to top-1" if top_n > 1 else
                       "none of these sweeps recorded which Maia model produced them"),
        }
    implied = ceiling.get("implied_rating")
    implied_se = ceiling.get("implied_rating_se")
    gap = (round(implied - you["estimate"])
           if implied is not None and you.get("estimate") is not None else None)
    # The curve is shallow enough that a point of match rate is worth about 140
    # Elo, so an implied rating carries a huge interval and most gaps are not
    # distinguishable from zero. Say which it is rather than letting a
    # three-figure number imply it means something.
    gap_significant = bool(gap is not None and implied_se and abs(gap) > 1.96 * implied_se)
    return {
        "available": True,
        "model": ceiling["model"],
        "observed": ceiling["observed"],
        "expected": ceiling["expected"],
        "ratio": ceiling["ratio"],
        "implied_rating": implied,
        "implied_rating_se": implied_se,
        # Positive means you are more predictable than your estimate suggests,
        # negative that your moves are spread wider than one strength explains.
        "gap": gap,
        "gap_significant": gap_significant,
        "share_known": ceiling["share_known"],
        "bound": ceiling.get("bound"),
        # The filter drops the *least* predictable moves, so a filtered library
        # scores above an unfiltered one on exactly the same games. Worth
        # saying, because the two are not comparable.
        "think_filtered": bool(think.get("applied")),
        "note": (
            "Maia's accuracy is measured on Lichess blitz. Slower games sit a little under "
            "the curve as a matter of course -- longer thinking finds more moves the policy "
            "net doesn't expect -- so read this against your own history rather than as an "
            "absolute score, or set an accuracy offset in Settings."
        ),
    }


def build(user_id: int, run_id: int | None = None, top_n: int = 1,
          min_think_ms: int | None = None,
          objective: str = elo_sweep.DEFAULT_OBJECTIVE) -> dict:
    entries, skipped = collect(user_id, run_id)
    if objective not in elo_sweep.OBJECTIVES:
        objective = elo_sweep.DEFAULT_OBJECTIVE
    top_n = max(1, min(int(top_n), elo_sweep.MAX_TOP_N))
    if min_think_ms is None:
        min_think_ms = get_effective_settings(user_id).get("min_think_ms", 0) or 0
    think = apply_think_filter(entries, "you", min_think_ms)
    # The opposition is filtered on the same rule, so the calibration compares
    # like with like rather than your considered moves against their premoves.
    apply_think_filter(entries, "opponent", min_think_ms)
    offset = float(get_effective_settings(user_id).get("maia_accuracy_offset", 0.0) or 0.0)
    you = _side_estimate(entries, "you", top_n, offset, objective)
    field = _side_estimate(entries, "opponent", top_n, offset, objective)

    # The field's real average rating, from the headers of the same games that
    # produced the field estimate.
    opponent_ratings = [e["opponent_elo"] for e in entries if e["opponent_elo"] is not None]
    your_ratings = [e["your_elo"] for e in entries if e["your_elo"] is not None]

    calibration = _calibrate(you, field, opponent_ratings)

    return {
        "you": you,
        "field": field,
        "calibration": calibration,
        "predictability": _predictability(you, think, top_n),
        "your_rating_mean": round(float(np.mean(your_ratings)), 1) if your_ratings else None,
        "your_rating_n": len(your_ratings),
        "games": len(entries),
        "top_n": top_n,
        "objective": objective,
        "policy_source": you.get("policy_source"),
        "think_filter": think,
        "max_rank_seen": max(you.get("max_rank_seen", 0), field.get("max_rank_seen", 0)),
        "skipped": skipped,
        "scale_note": (
            "Maia-3's SelfElo is calibrated to Lichess ratings, so the raw estimate is on "
            "the Lichess scale -- a few hundred points above Chess.com or FIDE at club "
            "level. The calibrated figure removes that by measuring the gap on your own "
            "opponents."
        ),
    }


@router.get("")
def get_strength(run_id: int | None = None, top_n: int = 1,
                 min_think_ms: int | None = None,
                 objective: str = elo_sweep.DEFAULT_OBJECTIVE,
                 user: dict = Depends(require_user)):
    """Pooled estimate over every game with a stored sweep. Pure re-fit of
    cached scores -- no engine runs -- so it is safe to call on every load,
    and so `objective` can be switched from the UI to compare the likelihood
    fit against the top-1 one on exactly the same games."""
    return build(user["id"], run_id, top_n, min_think_ms, objective)
