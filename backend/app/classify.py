"""Stockfish-only move classification (spec section 8). This algorithm is
validated against chess.com's own move-quality labels -- reproduce it
exactly, don't improvise on the thresholds or the N+1-eval scheme."""

import math

import chess

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


# ---------------------------------------------------------------------------
# Great / Brilliant (spec section 8, the part that needs Maia)
# ---------------------------------------------------------------------------

# Defaults for the two criteria the spec asked to pin down rather than
# improvise. Both are per-user settings; these are the fallbacks.
DEFAULT_GREAT_MAX_DROP = 0.02       # "close to the engine's own best move"
DEFAULT_GREAT_MAX_MATCH_RATE = 0.20  # "most players of that strength wouldn't find it"

# Enough of a material concession to read as a sacrifice rather than a trade.
SACRIFICE_CP = 150

SEE_PIECE_VALUES = {
    chess.PAWN: 100, chess.KNIGHT: 320, chess.BISHOP: 330,
    chess.ROOK: 500, chess.QUEEN: 900, chess.KING: 20000,
}


def _least_valuable_attacker(board: chess.Board, square: int, color: bool):
    """Cheapest piece of `color` attacking `square`, which is the one a sane
    exchange sequence uses next."""
    best_square, best_value = None, None
    for attacker_square in board.attackers(color, square):
        piece = board.piece_at(attacker_square)
        if piece is None:
            continue
        value = SEE_PIECE_VALUES[piece.piece_type]
        if best_value is None or value < best_value:
            best_square, best_value = attacker_square, value
    return best_square


def static_exchange_eval(board: chess.Board, move: chess.Move) -> int:
    """Centipawns the mover nets from the capture sequence on the destination
    square, assuming both sides keep taking with their least valuable piece.

    Standard swap-off SEE. Used to tell a sacrifice apart from an even trade
    without asking the engine for another search.
    """
    target = board.piece_at(move.to_square)
    attacker = board.piece_at(move.from_square)
    if attacker is None:
        return 0

    gains = [SEE_PIECE_VALUES[target.piece_type] if target else 0]
    working = board.copy(stack=False)
    working.push(move)

    # Value now standing on the square, i.e. what the opponent wins by taking.
    on_square = SEE_PIECE_VALUES[
        move.promotion if move.promotion else attacker.piece_type
    ]
    side = not board.turn
    depth = 0
    while True:
        from_square = _least_valuable_attacker(working, move.to_square, side)
        if from_square is None:
            break
        depth += 1
        gains.append(on_square - gains[-1])
        moving = working.piece_at(from_square)
        on_square = SEE_PIECE_VALUES[moving.piece_type]
        try:
            working.push(chess.Move(from_square, move.to_square))
        except AssertionError:
            break
        side = not side
        if depth > 31:
            break

    # Fold back: at each point the side to move can stop rather than continue.
    for i in range(len(gains) - 2, -1, -1):
        gains[i] = -max(-gains[i], gains[i + 1])
    return gains[0]


def is_sacrifice(fen_before: str, uci: str) -> bool:
    """True when the move concedes material, either by capturing into a losing
    exchange or by leaving something hanging that the opponent can now win.

    SEE on the moved-to square alone would miss a quiet sacrifice, so the
    position after the move is also checked for a capture the opponent gains
    from.
    """
    board = chess.Board(fen_before)
    try:
        move = chess.Move.from_uci(uci)
    except ValueError:
        return False
    if move not in board.legal_moves:
        return False

    if board.is_capture(move) and static_exchange_eval(board, move) <= -SACRIFICE_CP:
        return True

    after = board.copy(stack=False)
    after.push(move)
    for reply in after.legal_moves:
        if after.is_capture(reply) and static_exchange_eval(after, reply) >= SACRIFICE_CP:
            return True
    return False


def match_rate_near(grid: list[int], row: list[float], target_elo: float, band: float = 150.0) -> float | None:
    """How often Maia played this move at strengths around `target_elo`.

    This is the "would someone at your level find it" number. It's read off
    the cached sweep matrix rather than re-querying the engine, and uses a
    band around the estimate rather than the single nearest grid point so one
    noisy grid value can't decide a Great on its own. The band widens if it
    would otherwise be empty.
    """
    if not grid or not row:
        return None
    while True:
        hits = [row[i] for i, elo in enumerate(grid) if abs(elo - target_elo) <= band]
        if hits:
            return sum(hits) / len(hits)
        band *= 2
        if band > (max(grid) - min(grid)) + 1:
            return sum(row) / len(row)


def apply_great_brilliant(
    moves: list[dict],
    *,
    sweep_rows: dict[int, list[float]],
    grid: list[int],
    estimated_elo: float | None,
    fens_before: dict[int, str],
    ucis: dict[int, str],
    max_drop: float = DEFAULT_GREAT_MAX_DROP,
    max_match_rate: float = DEFAULT_GREAT_MAX_MATCH_RATE,
    brilliant_enabled: bool = True,
) -> None:
    """Upgrades qualifying moves in place to 'great' or 'brilliant'.

    A move qualifies when it gave up essentially nothing against the engine's
    own best play (`drop` is exactly that loss, so no extra search is needed)
    *and* players around the estimated strength mostly wouldn't have found it.
    Brilliant additionally requires a material sacrifice.
    """
    if estimated_elo is None:
        return
    for move in moves:
        ply = move["ply"]
        row = sweep_rows.get(ply)
        if row is None or move["classification"] != "good" or move["drop"] > max_drop:
            continue
        rate = match_rate_near(grid, row, estimated_elo)
        if rate is None or rate > max_match_rate:
            continue
        move["maia_match_rate"] = rate
        fen, uci = fens_before.get(ply), ucis.get(ply)
        if brilliant_enabled and fen and uci and is_sacrifice(fen, uci):
            move["classification"] = "brilliant"
        else:
            move["classification"] = "great"


def blunder_elo_correlation(
    moves: list[dict],
    *,
    sweep_rows: dict[int, list[float]],
    grid: list[int],
) -> None:
    """For every Mistake or Blunder, the lowest swept Elo whose Maia top-1 was
    the move actually played -- 'even a player this weak would have been
    expected to avoid it'. None when no swept Elo plays it, which the spec
    treats as no correlation to report rather than a result.
    """
    for move in moves:
        if move["classification"] not in ("mistake", "blunder"):
            continue
        row = sweep_rows.get(move["ply"])
        if not row:
            continue
        matches = [grid[i] for i, hit in enumerate(row) if hit]
        move["lowest_matching_elo"] = min(matches) if matches else None
