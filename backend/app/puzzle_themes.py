"""Puzzle themes: Lichess's vocabulary, and how to apply it to your own games.

Two jobs in one module, because they have to agree on the words:

* **The catalog.** Lichess tags every puzzle with theme keys like
  `hangingPiece` or `mateIn2`. Those keys arrive with the imported database
  and are what the theme picker filters on, so the labels, the descriptions
  and the grouping live here rather than being scattered through the UI.
* **The tagger.** Puzzles built from your own games arrive with no themes at
  all, and a theme picker that only works on half the puzzles is not much of
  a feature. `derive_themes` labels a home-grown puzzle with the same
  vocabulary, so one picker and one per-theme progress table cover both
  sources.

The tagger deliberately stops short of what Lichess does. Lichess tags with
the full engine analysis of the solution line in hand; this runs off the
position, the solution move and the evaluation the app already stored, so it
detects motifs that are visible in the position and skips the ones that are
not. `deflection`, `attraction`, `interference`, `clearance`, `zugzwang` and
`intermezzo` all need to reason about why the *refutation* fails, which needs
lines this doesn't have. They are listed in the catalog -- imported Lichess
puzzles carry them -- and simply never applied to a home-grown one.

That asymmetry is deliberate and worth stating plainly: a theme count for
your own games is a count of what could be detected, not a claim that the
motif is absent from the rest.
"""

import chess

# ---------------------------------------------------------------------------
# The catalog
# ---------------------------------------------------------------------------

# Grouped the way someone picking themes thinks about them, not the way the
# CSV lists them. Order within a group is roughly common-to-rare, because the
# picker renders them in this order and the useful ones should be reachable
# without scrolling.
#
# Each entry is (key, label, description). The label is a name -- it goes on a
# chip in a row of sixty and into a comma-separated line under the board, so
# it has to be short. The description is the sentence explaining the motif and
# belongs in a tooltip. Collapsing the two makes the picker read like prose
# and the theme line read like a paragraph.
THEME_GROUPS: list[tuple[str, str, list[tuple[str, str, str]]]] = [
    ("motifs", "Tactical motifs", [
        ("fork", "Fork", "One piece attacking two"),
        ("pin", "Pin", "A piece that cannot move without exposing a better one"),
        ("skewer", "Skewer", "A valuable piece forced to move, exposing the one behind"),
        ("hangingPiece", "Hanging piece", "An undefended piece there for the taking"),
        ("discoveredAttack", "Discovered attack", "Moving one piece to unleash another"),
        ("doubleCheck", "Double check", "Check from two pieces at once"),
        ("sacrifice", "Sacrifice", "Giving up material for a bigger return"),
        ("deflection", "Deflection", "Luring a defender off its job"),
        ("attraction", "Attraction", "Forcing a piece onto a square that loses"),
        ("trappedPiece", "Trapped piece", "A piece with nowhere to go"),
        ("capturingDefender", "Remove the defender",
         "Taking the piece that was holding it together"),
        ("interference", "Interference", "Cutting a defender off from what it defends"),
        ("clearance", "Clearance", "Vacating a square or line with tempo"),
        ("xRayAttack", "X-ray", "Attacking through a piece"),
        ("intermezzo", "Zwischenzug", "An in-between move before the expected recapture"),
        ("zugzwang", "Zugzwang", "Every move makes it worse"),
    ]),
    ("mates", "Checkmate", [
        ("mate", "Mate", "Ends in checkmate"),
        ("mateIn1", "Mate in 1", "Mate in one move"),
        ("mateIn2", "Mate in 2", "Mate in two moves"),
        ("mateIn3", "Mate in 3", "Mate in three moves"),
        ("mateIn4", "Mate in 4", "Mate in four moves"),
        ("mateIn5", "Mate in 5+", "Mate in five moves or more"),
        ("backRankMate", "Back rank", "Mate on the back rank"),
        ("smotheredMate", "Smothered",
         "Mate by a knight, the king boxed in by its own pieces"),
        ("hookMate", "Hook mate", "Rook, knight and pawn mating net"),
        ("anastasiaMate", "Anastasia's",
         "Rook and knight mate against a king on the edge"),
        ("arabianMate", "Arabian", "Rook and knight mate in the corner"),
        ("bodenMate", "Boden's", "Two bishops on crossing diagonals"),
        ("doubleBishopMate", "Double bishop", "Two bishops on adjacent diagonals"),
        ("dovetailMate", "Dovetail",
         "Queen mate with the king's own pieces in the way"),
    ]),
    ("phases", "Game phase", [
        ("opening", "Opening", "In the opening"),
        ("middlegame", "Middlegame", "In the middlegame"),
        ("endgame", "Endgame", "In the endgame"),
        ("rookEndgame", "Rook ending", "An endgame with only rooks left"),
        ("pawnEndgame", "Pawn ending", "An endgame with only pawns left"),
        ("queenEndgame", "Queen ending", "An endgame with only queens left"),
        ("bishopEndgame", "Bishop ending", "An endgame with only bishops left"),
        ("knightEndgame", "Knight ending", "An endgame with only knights left"),
        ("queenRookEndgame", "Queen + rook ending",
         "An endgame with queens and rooks left"),
    ]),
    ("goals", "What it wins", [
        ("crushing", "Crushing", "Wins decisively"),
        ("advantage", "Advantage", "Wins a clear advantage"),
        ("equality", "Equality", "Saves the position"),
        ("defensiveMove", "Defensive", "A defensive resource, not an attack"),
    ]),
    ("length", "How long", [
        ("oneMove", "1 move", "One move to find"),
        ("short", "2 moves", "Two moves to find"),
        ("long", "3 moves", "Three moves to find"),
        ("veryLong", "4+ moves", "Four moves or more to find"),
    ]),
    ("special", "Special moves and situations", [
        ("promotion", "Promotion", "A pawn promotes"),
        ("underPromotion", "Underpromotion", "Promoting to something other than a queen"),
        ("advancedPawn", "Advanced pawn", "A pawn deep in enemy territory"),
        ("enPassant", "En passant", "An en passant capture"),
        ("castling", "Castling", "The solution is to castle"),
        ("quietMove", "Quiet move", "No check, no capture, no threat -- and it wins"),
        ("exposedKing", "Exposed king", "A king stripped of its cover"),
        ("kingsideAttack", "Kingside attack", "An attack on the kingside"),
        ("queensideAttack", "Queenside attack", "An attack on the queenside"),
        ("attackingF2F7", "f2 / f7", "Hitting the square only the king defends"),
        ("master", "Master game", "From a game between titled players"),
        ("superGM", "Super-GM game", "From a game between the very strongest players"),
    ]),
]

THEME_LABELS: dict[str, str] = {
    key: label for _, _, items in THEME_GROUPS for key, label, _ in items
}

THEME_DESCRIPTIONS: dict[str, str] = {
    key: description for _, _, items in THEME_GROUPS for key, _, description in items
}

# Themes the tagger can actually apply to a puzzle built from your own games.
# Everything else in the catalog is import-only, and the UI says so rather
# than offering a filter that would silently return nothing.
DERIVABLE_THEMES = frozenset({
    "fork", "pin", "skewer", "hangingPiece", "discoveredAttack", "doubleCheck",
    "sacrifice", "trappedPiece", "capturingDefender",
    "mate", "mateIn1", "mateIn2", "mateIn3", "mateIn4", "mateIn5",
    "backRankMate", "smotheredMate",
    "opening", "middlegame", "endgame", "rookEndgame", "pawnEndgame",
    "queenEndgame", "bishopEndgame", "knightEndgame", "queenRookEndgame",
    "crushing", "advantage", "equality", "defensiveMove",
    "oneMove", "short", "long", "veryLong",
    "promotion", "underPromotion", "advancedPawn", "enPassant", "castling",
    "quietMove", "exposedKing", "kingsideAttack", "queensideAttack",
    "attackingF2F7",
})


def catalog() -> list[dict]:
    """The catalog as the browser wants it: groups, each with its themes."""
    return [
        {
            "key": group_key,
            "label": group_label,
            "themes": [
                {"key": key, "label": label, "description": description,
                 "derivable": key in DERIVABLE_THEMES}
                for key, label, description in items
            ],
        }
        for group_key, group_label, items in THEME_GROUPS
    ]


def parse(raw: str | None) -> list[str]:
    """Lichess stores themes as one space-separated string."""
    return [t for t in (raw or "").split() if t]


# ---------------------------------------------------------------------------
# The tagger
# ---------------------------------------------------------------------------

PIECE_VALUE = {
    chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
    chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0,
}

# The same pieces ordered by what you would rather not lose, which is a
# different question from what they are worth in material. The king is zero
# above because it is never traded; here it outranks everything, because
# "which of these two is the one that must move" is exactly what separates a
# pin from a skewer. Using PIECE_VALUE for that comparison makes every skewer
# against a king look like a pin.
PIECE_RANK = {
    chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
    chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100,
}

# How many major and minor pieces may be left before the position stops being
# an endgame. Counting pieces rather than summing their values is deliberate:
# by value, a queen-and-rook ending for both sides (28 points) looks like a
# middlegame, when it is obviously an ending. Six is the line Lichess's own
# phase divider draws, so a home-grown puzzle and an imported one agree about
# which phase they came from.
ENDGAME_PIECES = 6

# A pawn on the 6th rank or beyond (from its own side) is 'advanced'.
ADVANCED_PAWN_RANK = 5  # 0-indexed, so rank 6 for White


def _heavy_pieces(board: chess.Board) -> list[chess.Piece]:
    """Everything that isn't a pawn or a king."""
    return [
        piece for piece in board.piece_map().values()
        if piece.piece_type not in (chess.PAWN, chess.KING)
    ]


def _phase_themes(board: chess.Board) -> set[str]:
    """Opening, middlegame or endgame -- and which kind of endgame.

    Endgame is decided by how many pieces are left, opening by move number;
    both follow Lichess. The endgame *type* names the pieces left besides
    pawns and kings, which is what makes 'rookEndgame' a useful thing to
    practise.
    """
    themes = set()
    pieces = _heavy_pieces(board)
    if len(pieces) <= ENDGAME_PIECES:
        themes.add("endgame")
        kinds = {piece.piece_type for piece in pieces}
        if not kinds:
            themes.add("pawnEndgame")
        elif kinds == {chess.ROOK}:
            themes.add("rookEndgame")
        elif kinds == {chess.BISHOP}:
            themes.add("bishopEndgame")
        elif kinds == {chess.KNIGHT}:
            themes.add("knightEndgame")
        elif kinds == {chess.QUEEN}:
            themes.add("queenEndgame")
        elif kinds == {chess.QUEEN, chess.ROOK}:
            themes.add("queenRookEndgame")
    elif board.fullmove_number <= 10:
        themes.add("opening")
    else:
        themes.add("middlegame")
    return themes


def _attacked_by_lesser(board: chess.Board, square: int, colour: bool) -> bool:
    """Whether `colour` attacks `square` with something cheaper than what sits
    on it. This is the test behind both 'is it hanging' and 'is it a fork'."""
    piece = board.piece_at(square)
    if piece is None:
        return False
    value = PIECE_VALUE[piece.piece_type]
    for attacker_square in board.attackers(colour, square):
        attacker = board.piece_at(attacker_square)
        if attacker and PIECE_VALUE[attacker.piece_type] < value:
            return True
    return False


def _is_hanging(board: chess.Board, square: int, owner: bool) -> bool:
    """Undefended and attacked, or attacked by something worth less."""
    piece = board.piece_at(square)
    if piece is None or piece.piece_type == chess.KING:
        return False
    enemy = not owner
    if not board.attackers(enemy, square):
        return False
    if not board.attackers(owner, square):
        return True
    return _attacked_by_lesser(board, square, enemy)


def _fork_targets(board: chess.Board, square: int, mover: bool) -> int:
    """How many enemy pieces worth taking the piece on `square` now hits.

    'Worth taking' means the king, or something the forking piece can win --
    a queen attacking two pawns is not a fork, and counting it as one is the
    thing that makes a naive fork detector useless.
    """
    piece = board.piece_at(square)
    if piece is None:
        return 0
    value = PIECE_VALUE[piece.piece_type]
    targets = 0
    for target_square in board.attacks(square):
        target = board.piece_at(target_square)
        if target is None or target.color == mover:
            continue
        if target.piece_type == chess.KING:
            targets += 1
        elif PIECE_VALUE[target.piece_type] > value or not board.attackers(not mover, target_square):
            targets += 1
    return targets


def _line_motifs(board: chess.Board, mover: bool) -> set[str]:
    """Pins, skewers and x-rays, found by walking the sliding pieces' rays.

    One walk finds all three: along a ray from a slider, the first enemy piece
    and the next one behind it are a pin if the back one is worth more (it
    can't move without losing it) and a skewer if the front one is.
    """
    themes = set()
    directions = {
        chess.BISHOP: [9, 7, -7, -9],
        chess.ROOK: [8, 1, -1, -8],
        chess.QUEEN: [9, 8, 7, 1, -1, -7, -8, -9],
    }
    for square, piece in board.piece_map().items():
        if piece.color != mover or piece.piece_type not in directions:
            continue
        for step in directions[piece.piece_type]:
            found = []
            current = square
            while True:
                previous_file = chess.square_file(current)
                current += step
                if not (0 <= current <= 63):
                    break
                # Stepping off the side of the board wraps the index around;
                # a file jump of more than one is what that looks like.
                if abs(chess.square_file(current) - previous_file) > 1:
                    break
                occupant = board.piece_at(current)
                if occupant is None:
                    continue
                if occupant.color == mover:
                    break
                found.append(occupant)
                if len(found) == 2:
                    break
            if len(found) != 2:
                continue
            front, back = found
            front_rank = PIECE_RANK[front.piece_type]
            back_rank = PIECE_RANK[back.piece_type]
            if back_rank > front_rank:
                # The cheaper piece is in front and daren't move: a pin.
                themes.add("pin")
            elif front_rank > back_rank:
                # The dearer piece is in front and must: a skewer.
                themes.add("skewer")
            # Two pieces of equal value on a ray is an x-ray only if the line
            # actually wins something, which needs the follow-up this doesn't
            # have. Left untagged rather than guessed at.
    return themes


def _king_zone_themes(board: chess.Board, mover: bool, endgame: bool) -> set[str]:
    """Whether the enemy king is exposed, and which wing is under attack.

    Skipped entirely in an endgame. A king with no pawns around it is the
    normal state of a rook ending, not a weakness, and tagging every ending
    'exposedKing' would make the filter useless -- which is exactly what the
    first version of this did.
    """
    themes = set()
    if endgame:
        return themes
    enemy = not mover
    king_square = board.king(enemy)
    if king_square is None:
        return themes

    # Exposed: few of its own pawns anywhere near it. Counting the pawns in
    # the 3x3 box plus the files either side is crude but matches how the
    # position reads -- a castled king with its pawns pushed is exposed.
    file_index = chess.square_file(king_square)
    shelter = 0
    for file_offset in (-1, 0, 1):
        f = file_index + file_offset
        if not (0 <= f <= 7):
            continue
        for rank in range(8):
            piece = board.piece_at(chess.square(f, rank))
            if piece and piece.piece_type == chess.PAWN and piece.color == enemy:
                shelter += 1
    if shelter <= 1:
        themes.add("exposedKing")

    # Which wing: where the king is, and whether the mover actually has
    # pieces pointed at it.
    wing = "kingsideAttack" if file_index >= 4 else "queensideAttack"
    attackers = 0
    for square in chess.SquareSet(chess.BB_ALL):
        piece = board.piece_at(square)
        if piece and piece.color == mover and piece.piece_type not in (chess.PAWN, chess.KING):
            if any(chess.square_distance(target, king_square) <= 2
                   for target in board.attacks(square)):
                attackers += 1
    if attackers >= 2:
        themes.add(wing)
    return themes


def _weak_square_theme(board: chess.Board, move: chess.Move, mover: bool) -> set[str]:
    """f7 for White, f2 for Black -- the square defended only by the king."""
    target = chess.F7 if mover == chess.WHITE else chess.F2
    if move.to_square == target and board.piece_at(target) is not None:
        return {"attackingF2F7"}
    return set()


def _mate_theme(board_after: chess.Board, mover: bool) -> set[str]:
    """The mating pattern, when the solution move is mate itself."""
    themes = {"mate", "mateIn1"}
    enemy = not mover
    king_square = board_after.king(enemy)
    if king_square is None:
        return themes

    # White's back rank is rank 1 (index 0) and Black's is rank 8 (index 7);
    # the escape squares are the rank in front of it, which is *towards* the
    # centre and so runs the other way for each colour.
    back_rank = 0 if enemy == chess.WHITE else 7
    checkers = board_after.checkers()
    delivered_by = {
        board_after.piece_at(square).piece_type
        for square in checkers if board_after.piece_at(square)
    }
    # A back-rank mate is a rook or queen mate along the rank. Without that
    # condition a smothered mate -- king on its back rank, hemmed in by its
    # own pawns -- matches the geometry too and comes back tagged as both.
    if (chess.square_rank(king_square) == back_rank
            and delivered_by & {chess.ROOK, chess.QUEEN}):
        # Back rank proper: the king is hemmed in by its own pieces in front.
        escape_rank = back_rank + 1 if enemy == chess.WHITE else back_rank - 1
        blocked = True
        for file_offset in (-1, 0, 1):
            f = chess.square_file(king_square) + file_offset
            if not (0 <= f <= 7):
                continue
            occupant = board_after.piece_at(chess.square(f, escape_rank))
            if occupant is None or occupant.color != enemy:
                blocked = False
                break
        if blocked:
            themes.add("backRankMate")

    # Smothered: the king is surrounded entirely by its own men and a knight
    # gives the mate.
    if len(checkers) == 1:
        checker = board_after.piece_at(next(iter(checkers)))
        if checker and checker.piece_type == chess.KNIGHT:
            smothered = True
            for square in board_after.attacks(king_square):
                occupant = board_after.piece_at(square)
                if occupant is None or occupant.color != enemy:
                    smothered = False
                    break
            if smothered:
                themes.add("smotheredMate")
    return themes


def length_theme(user_moves: int) -> str | None:
    """Lichess's length buckets, by how many moves the solver plays."""
    if user_moves <= 1:
        return "oneMove"
    if user_moves == 2:
        return "short"
    if user_moves == 3:
        return "long"
    if user_moves >= 4:
        return "veryLong"
    return None


def mate_in_theme(plies_to_mate: int) -> str | None:
    """`mateIn1`..`mateIn5`, counting the solver's own moves."""
    if plies_to_mate <= 0:
        return None
    return f"mateIn{min(plies_to_mate, 5)}"


def outcome_theme(cp_after: float | None) -> str | None:
    """What the solution achieves, on Lichess's own thresholds: a winning
    position is 'crushing', a clear edge is 'advantage', and holding a level
    one is 'equality'."""
    if cp_after is None:
        return None
    if abs(cp_after) >= 600:
        return "crushing"
    if abs(cp_after) >= 200:
        return "advantage"
    if abs(cp_after) <= 60:
        return "equality"
    return None


def position_themes(fen: str) -> list[str]:
    """The themes readable off the position alone, with no solution move.

    Only the phase ones qualify, but they are worth having early: a puzzle
    built from your own games has no solution until an engine works one out,
    and without this a freshly-built library would answer "endgame" with
    nothing at all. `derive_themes` supersedes these once the move is known.
    """
    try:
        board = chess.Board(fen)
    except ValueError:
        return []
    return sorted(_phase_themes(board) & DERIVABLE_THEMES)


def derive_themes(fen: str, solution_uci: str, *, cp_before: float | None = None,
                  cp_after: float | None = None) -> list[str]:
    """Tag a puzzle built from one of your own games.

    Takes the position, the move that should have been played, and the
    evaluations the analysis pass already stored. Returns theme keys from the
    same vocabulary the Lichess import uses, so both sources land in one
    picker and one progress table.

    Everything here is derived from a single move. See the module docstring
    for what that rules out.
    """
    try:
        board = chess.Board(fen)
        move = chess.Move.from_uci(solution_uci)
    except ValueError:
        return []
    if move not in board.legal_moves:
        return []

    mover = board.turn
    themes: set[str] = set()
    themes |= _phase_themes(board)
    themes |= _weak_square_theme(board, move, mover)
    endgame = "endgame" in themes

    captured = board.piece_at(move.to_square)
    captured_value = PIECE_VALUE[captured.piece_type] if captured else 0
    moving = board.piece_at(move.from_square)
    gives_check = board.gives_check(move)

    if board.is_castling(move):
        themes.add("castling")
    if board.is_en_passant(move):
        themes.add("enPassant")
        captured_value = 1
    if move.promotion:
        themes.add("promotion")
        if move.promotion != chess.QUEEN:
            themes.add("underPromotion")
    if moving and moving.piece_type == chess.PAWN:
        rank = chess.square_rank(move.to_square)
        # Mirrored for Black, so 'advanced' is the same distance from home
        # either way: rank 6+ for White, rank 3- for Black.
        advanced = (rank >= ADVANCED_PAWN_RANK if mover == chess.WHITE
                    else rank <= 7 - ADVANCED_PAWN_RANK)
        if advanced:
            themes.add("advancedPawn")

    # Was the piece being taken already hanging before the move?
    if captured and _is_hanging(board, move.to_square, not mover):
        themes.add("hangingPiece")
    # Taking a piece that was defending something is the 'remove the defender'
    # motif -- detected before the move, while the defence still exists.
    if captured and board.attacks(move.to_square) & board.occupied_co[not mover]:
        defended = [
            square for square in board.attacks(move.to_square)
            if (piece := board.piece_at(square)) and piece.color != mover
            and PIECE_VALUE[piece.piece_type] >= 3
        ]
        if defended:
            themes.add("capturingDefender")

    board_after = board.copy()
    board_after.push(move)

    if board_after.is_checkmate():
        themes |= _mate_theme(board_after, mover)
    if gives_check and len(board_after.checkers()) >= 2:
        themes.add("doubleCheck")

    # A sacrifice gives up more than it takes and is not simply a losing move
    # -- the evaluation is what tells those two apart, so it is only claimed
    # when the move is known to be good.
    if moving and moving.piece_type != chess.KING:
        risk = PIECE_VALUE[moving.piece_type] - captured_value
        if risk >= 2 and _is_hanging(board_after, move.to_square, mover):
            themes.add("sacrifice")

    # Quiet: no check, no capture, no promotion. Lichess reserves this for
    # moves that win anyway, which is the interesting case.
    if not gives_check and not captured and not move.promotion:
        themes.add("quietMove")

    if _fork_targets(board_after, move.to_square, mover) >= 2:
        themes.add("fork")
    themes |= _line_motifs(board_after, mover)
    themes |= _king_zone_themes(board_after, mover, endgame)

    # Discovered attack: a piece that was not the one that moved is now
    # attacking something valuable it wasn't attacking before.
    themes |= _discovered(board, board_after, move, mover)

    # Trapped: after the move an enemy piece of real value is attacked and has
    # nowhere safe to go.
    themes |= _trapped(board_after, mover)

    if theme := outcome_theme(cp_after):
        themes.add(theme)
    # Defensive when you were the one in trouble beforehand: the lesson is
    # holding on, not winning.
    if cp_before is not None and cp_before < -100:
        themes.add("defensiveMove")

    themes.add("oneMove")
    return sorted(themes & DERIVABLE_THEMES)


def _discovered(before: chess.Board, after: chess.Board, move: chess.Move,
                mover: bool) -> set[str]:
    """A piece other than the one that moved now hits something it didn't."""
    for square, piece in after.piece_map().items():
        if piece.color != mover or square == move.to_square:
            continue
        if piece.piece_type not in (chess.BISHOP, chess.ROOK, chess.QUEEN):
            continue
        gained = after.attacks(square) - before.attacks(square)
        for target_square in gained:
            target = after.piece_at(target_square)
            if target and target.color != mover and PIECE_VALUE[target.piece_type] >= 3:
                return {"discoveredAttack"}
    return set()


def _trapped(board: chess.Board, mover: bool) -> set[str]:
    """An enemy piece worth 3 or more, attacked, with no safe square.

    Not applied while the enemy is in check. In check every piece looks
    trapped -- the only legal moves are the king's -- so a fork that happens
    to give check would come back tagged 'trappedPiece' as well, which is
    both wrong and the noisiest kind of wrong.
    """
    if board.is_check():
        return set()
    enemy = not mover
    for square, piece in board.piece_map().items():
        if piece.color != enemy or piece.piece_type in (chess.PAWN, chess.KING):
            continue
        if not board.attackers(mover, square):
            continue
        if not _attacked_by_lesser(board, square, mover) and board.attackers(enemy, square):
            continue
        # It is already the enemy's turn here -- this runs on the position
        # after the solution move -- so their legal moves are the real ones.
        escapes = [
            m for m in board.legal_moves
            if m.from_square == square and not board.is_attacked_by(mover, m.to_square)
        ]
        if not escapes:
            return {"trappedPiece"}
    return set()
