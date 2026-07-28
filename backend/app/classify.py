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


# The bands the spec pins to chess.com's algorithm. Only the top one is split
# further below -- inaccuracy, mistake and blunder are where they were.
EXCELLENT_DROP = 0.02
INACCURACY_DROP = 0.05
MISTAKE_DROP = 0.10
BLUNDER_DROP = 0.20

# A Miss is a bad move with a particular shape: the position was winning and
# after the move it isn't. Losing a won game is a different mistake from
# drifting from equal to slightly worse, and it is the one worth practising.
MISS_WINNING_WP = 0.80
MISS_LOST_WP = 0.55


def classify_drop(drop: float) -> str:
    if drop < INACCURACY_DROP:
        return "good"
    if drop < MISTAKE_DROP:
        return "inaccuracy"
    if drop < BLUNDER_DROP:
        return "mistake"
    return "blunder"


def _label(drop: float, wp_before: float, wp_after: float, is_best: bool | None) -> str:
    """The band, then the two splits inside it that need more than the drop.

    `is_best` is None when nobody asked the engine which move it preferred, in
    which case the top band stays the single 'good' it has always been rather
    than guessing.
    """
    band = classify_drop(drop)
    if band in ("mistake", "blunder"):
        if wp_before >= MISS_WINNING_WP and wp_after <= MISS_LOST_WP:
            return "miss"
        return band
    if band != "good" or is_best is None:
        return band
    if is_best:
        return "best"
    return "excellent" if drop < EXCELLENT_DROP else "good"


def classify_moves(
    cp_evals: list[float],
    *,
    played_ucis: list[str] | None = None,
    best_ucis: list[str | None] | None = None,
    second_cp: list[float | None] | None = None,
) -> list[dict]:
    """cp_evals has N+1 entries for a game of N moves: cp_evals[i] is the
    mover-perspective eval of the position after i moves have been played
    (cp_evals[0] = starting position, cp_evals[N] = final position).
    Returns one classification dict per move (N of them), 1-indexed by ply.

    The three optional lists are what a MultiPV search adds and a plain one
    can't give: which move the engine preferred, and what the *second* best
    move was worth. Without them the classification is exactly what it has
    always been; with them the top band splits into best/excellent/good and
    the only-move tests that Great and Brilliant now need have something to
    read. `second_cp[i]` is None when the position had one legal move, which
    is how a forced move is recognised.
    """
    moves = []
    for i in range(len(cp_evals) - 1):
        wp_before = win_prob(cp_evals[i])
        # eval[i+1] is from the perspective of whoever is now to move (the
        # opponent) -- flip it back into the mover's terms before comparing.
        wp_after = 1.0 - win_prob(cp_evals[i + 1])
        drop = max(0.0, wp_before - wp_after)

        is_best = None
        if best_ucis and played_ucis and i < len(best_ucis) and i < len(played_ucis):
            is_best = bool(best_ucis[i]) and best_ucis[i] == played_ucis[i]

        # How much worse the position's second-best move was, in the same win
        # probability the rest of this file speaks: "there was nothing else".
        forced = None
        gap = None
        if second_cp is not None and i < len(second_cp):
            forced = second_cp[i] is None
            if not forced:
                gap = max(0.0, wp_before - win_prob(second_cp[i]))

        moves.append({
            "ply": i + 1,
            "cp_before": cp_evals[i],
            "cp_after": cp_evals[i + 1],
            "wp_before": wp_before,
            "wp_after": wp_after,
            "drop": drop,
            "is_best": is_best,
            "forced": forced,
            "only_move_gap": gap,
            "classification": _label(drop, wp_before, wp_after, is_best),
        })
    return moves


# ---------------------------------------------------------------------------
# Great / Brilliant (spec section 8, the part that needs Maia)
# ---------------------------------------------------------------------------

# Defaults for the two criteria the spec asked to pin down rather than
# improvise. Both are per-user settings; these are the fallbacks.
DEFAULT_GREAT_MAX_DROP = 0.02       # "close to the engine's own best move"
DEFAULT_GREAT_MAX_MATCH_RATE = 0.20  # "most players of that strength wouldn't find it"

# How far behind the second-best move has to be before the move played counts
# as the *only* move. In win probability, because a raw centipawn gap says
# nothing on its own -- +20 against +15 is a 500cp gap between two moves that
# both win trivially, and neither is a find.
#
# For scale: +7.0 falling to +2.0 is a gap of 0.25; dropping a rook for
# nothing from level material is around 0.4; two pawns near equality is
# about 0.15, which is where this sits.
DEFAULT_ONLY_MOVE_GAP = 0.15

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


def best_capture_gain(board: chess.Board) -> int:
    """The most material the side to move can win by capturing, by SEE."""
    best = 0
    for reply in board.legal_moves:
        if board.is_capture(reply):
            best = max(best, static_exchange_eval(board, reply))
    return best


def _if_it_were_their_move(board: chess.Board) -> chess.Board:
    """The same position with the other side to move.

    Not a legal position -- the side that just lost the move may be giving
    check -- but the only question asked of it is "what could they take", and
    move generation answers that whether or not the king is attacked. A null
    move would be the tidy way to do this and is illegal exactly when the
    mover is in check, which is the case this exists for.
    """
    passed = board.copy(stack=False)
    passed.turn = not passed.turn
    passed.ep_square = None
    return passed


def is_sacrifice(fen_before: str, uci: str) -> bool:
    """True when the move *offers* material: it captures into a losing
    exchange, or it leaves something hanging that the opponent couldn't
    already have taken.

    That last clause is the whole difficulty. Material that was hanging before
    the move is not something the move gave up -- when a knight forks king and
    rook, the king's escape doesn't sacrifice the rook, the fork already won
    it. Comparing what the opponent can win after the move against what they
    could have won anyway is what tells a sacrifice from an ordinary loss.
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

    already = best_capture_gain(_if_it_were_their_move(board))
    after = board.copy(stack=False)
    after.push(move)
    # A sacrifice has to put something new on the table, and enough of it.
    return best_capture_gain(after) >= already + SACRIFICE_CP


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
    min_only_move_gap: float = DEFAULT_ONLY_MOVE_GAP,
    brilliant_enabled: bool = True,
) -> None:
    """Upgrades qualifying moves in place to 'great' or 'brilliant'.

    Four things have to be true of a Great:

    * the move gave up essentially nothing (`drop`, which is that loss);
    * it was the **only** move -- the second-best the engine could find was
      `min_only_move_gap` worse, so this was a position with one answer and
      the player found it;
    * the position had more than one legal move, because a move you had no
      choice about is not a find however good it is;
    * players around the estimated strength mostly wouldn't have played it.

    Brilliant is a Great that also gives up material. Everything above still
    has to hold: without the only-move test, every quiet move in a position
    where something happened to be hanging read as a sacrifice worth
    celebrating, which is how a king stepping out of a knight fork ended up
    marked brilliant -- the rook it "sacrificed" was already lost to the fork.
    """
    if estimated_elo is None:
        return
    for move in moves:
        ply = move["ply"]
        row = sweep_rows.get(ply)
        if row is None or move["drop"] > max_drop:
            continue
        if move["classification"] not in ("best", "excellent", "good"):
            continue
        # False means "there was a second move and it was worse". True is a
        # move with no alternative; None is a single-PV search that never
        # looked -- and rather than fall back to the old, looser rule, a run
        # that can't answer the question awards nothing.
        if move.get("forced") is not False:
            continue
        gap = move.get("only_move_gap")
        if gap is None or gap < min_only_move_gap:
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


# How many games in the reference library it takes before a move counts as
# theory rather than something one person tried once.
BOOK_MIN_GAMES = 5


def apply_book(moves: list[dict], *, fens_before: dict, ucis: dict, lookup) -> None:
    """Relabels moves that the opening database says are theory.

    `lookup(fen) -> {uci: games}` keeps this file free of the database; pass
    something that returns nothing and every move keeps the label it earned.

    Only sound moves become Book. A move being played a thousand times is a
    fact about openings, not a defence -- if the engine says it dropped the
    game, the label that says so is the more useful one.
    """
    for move in moves:
        if move["classification"] not in ("best", "excellent", "good"):
            continue
        ply = move["ply"]
        fen, uci = fens_before.get(ply), ucis.get(ply)
        if not fen or not uci:
            continue
        counts = lookup(fen) or {}
        if counts.get(uci, 0) >= BOOK_MIN_GAMES:
            move["classification"] = "book"
            move["book_games"] = counts[uci]


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
