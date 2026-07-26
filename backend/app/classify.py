"""Stockfish-only move classification (spec section 8). This algorithm is
validated against chess.com's own move-quality labels -- reproduce it
exactly, don't improvise on the thresholds or the N+1-eval scheme."""

import math

WP_K = 0.00368208

# Mate scores are converted to this cp magnitude everywhere in the pipeline
# (not just the final-position special case) -- wp() saturates well before
# this magnitude anyway, so a flat conversion (no mate-distance scaling) is
# both simple and consistent.
MATE_CP = 10000.0


def win_prob(cp: float) -> float:
    """wp(cp) = 1 / (1 + exp(-0.00368208 * cp)), from the side-to-move's
    perspective."""
    return 1.0 / (1.0 + math.exp(-WP_K * cp))


def mate_to_cp(mate_in: int) -> float:
    return MATE_CP if mate_in > 0 else -MATE_CP


def eval_to_cp(info: dict) -> float:
    """info: {'cp': int|None, 'mate': int|None, ...} as returned by
    parse_info_line / evaluate_position -- mover's own perspective."""
    if info.get("mate") is not None:
        return mate_to_cp(info["mate"])
    return float(info.get("cp") or 0)


def classify_drop(drop: float) -> str:
    if drop < 0.05:
        return "good"
    if drop < 0.10:
        return "inaccuracy"
    if drop < 0.20:
        return "mistake"
    return "blunder"


def classify_moves(cp_evals: list[float]) -> list[dict]:
    """cp_evals has N+1 entries for a game of N moves: cp_evals[i] is the
    mover-perspective eval of the position after i moves have been played
    (cp_evals[0] = starting position, cp_evals[N] = final position).
    Returns one classification dict per move (N of them), 1-indexed by ply."""
    moves = []
    for i in range(len(cp_evals) - 1):
        wp_before = win_prob(cp_evals[i])
        # eval[i+1] is from the perspective of whoever is now to move (the
        # opponent) -- flip it back into the mover's terms before comparing.
        wp_after = 1.0 - win_prob(cp_evals[i + 1])
        drop = max(0.0, wp_before - wp_after)
        moves.append({
            "ply": i + 1,
            "cp_before": cp_evals[i],
            "cp_after": cp_evals[i + 1],
            "wp_before": wp_before,
            "wp_after": wp_after,
            "drop": drop,
            "classification": classify_drop(drop),
        })
    return moves
