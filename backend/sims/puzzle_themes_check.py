"""Checking the home-grown puzzle tagger against positions with known motifs.

`app/puzzle_themes.derive_themes` labels a puzzle built from your own games
with Lichess's theme vocabulary, off nothing but the position, the solution
move and the stored evaluation. That is a pile of heuristics, and heuristics
that nobody drove over real positions are heuristics that are wrong.

Run it with `python backend/sims/puzzle_themes_check.py`.

Each case asserts two things: the themes that must be found, and the themes
that must *not* be. The negatives matter more. A tagger that says every
position is a fork is worse than one that says nothing -- the theme picker
would offer 'fork' and hand back a pile of unrelated positions, and the
per-theme progress numbers would be noise.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app.puzzle_themes import (  # noqa: E402
    DERIVABLE_THEMES, THEME_LABELS, catalog, derive_themes, length_theme,
    mate_in_theme, outcome_theme, parse,
)

failures = []


def case(name: str, fen: str, uci: str, expect: set[str], reject: set[str] = frozenset(),
         **kwargs):
    got = set(derive_themes(fen, uci, **kwargs))
    missing = expect - got
    wrong = reject & got
    ok = not missing and not wrong
    print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    print(f"       -> {' '.join(sorted(got)) or '(none)'}")
    if missing:
        failures.append(f"{name}: missing {sorted(missing)}")
        print(f"       MISSING {sorted(missing)}")
    if wrong:
        failures.append(f"{name}: wrongly tagged {sorted(wrong)}")
        print(f"       WRONGLY TAGGED {sorted(wrong)}")


def tactics():
    print("Tactical motifs:")

    # Ne7+ forks the king on g8 and the rook on c8. A full middlegame board on
    # purpose: the fork must be found without the phase heuristic sliding into
    # 'endgame', and the check must not also read as 'trappedPiece'.
    case("knight fork of king and rook",
         "2rq1rk1/pp3ppp/2n1b3/3N4/8/2P1B3/PP3PPP/2RQ1RK1 w - - 0 15", "d5e7",
         expect={"fork", "middlegame"},
         reject={"mate", "castling", "promotion", "trappedPiece", "endgame"})

    # Back rank: rook to e8 is mate, the king is walled in by its own pawns.
    case("back rank mate",
         "6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1", "e1e8",
         expect={"mate", "mateIn1", "backRankMate", "endgame"},
         reject={"smotheredMate", "quietMove"})

    # Nf7# with the king on h8 walled in by its own rook and pawns.
    case("smothered mate",
         "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1", "g5f7",
         expect={"mate", "mateIn1", "smotheredMate"}, reject={"backRankMate", "quietMove"})

    # Ra1-e1 puts the rook behind the king with the queen behind it: the king
    # must move and the queen falls.
    case("skewer, king in front of the queen",
         "8/4q3/8/8/4k3/8/8/R5K1 w - - 0 1", "a1e1",
         expect={"skewer"}, reject={"pin", "promotion"})

    # Bb3-a4 pins the knight on d7 against the king on e8.
    case("bishop pins knight to king",
         "4k3/3n4/8/8/8/1B6/8/4K3 w - - 0 1", "b3a4",
         expect={"pin"}, reject={"skewer", "fork"})

    # A free rook sitting undefended and attacked.
    case("taking a hanging rook",
         "4k3/8/8/3r4/8/8/3R4/4K3 w - - 0 1", "d2d5",
         expect={"hangingPiece", "endgame", "rookEndgame"}, reject={"quietMove", "sacrifice"})

    print("\nPawns and special moves:")
    case("promotion to a queen",
         "8/4P3/8/8/8/8/8/k1K5 w - - 0 1", "e7e8q",
         expect={"promotion", "advancedPawn", "endgame", "pawnEndgame"},
         reject={"underPromotion"})
    case("underpromotion to a knight",
         "8/4P3/8/8/8/8/8/k1K5 w - - 0 1", "e7e8n",
         expect={"promotion", "underPromotion", "advancedPawn"}, reject=set())
    case("castling",
         "4k3/8/8/8/8/8/8/4K2R w K - 0 1", "e1g1",
         expect={"castling"}, reject={"promotion", "mate"})
    case("en passant",
         "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "e5d6",
         expect={"enPassant"}, reject={"promotion"})
    # Black pawn deep in White's half is 'advanced' the same way White's is.
    case("black advanced pawn is mirrored",
         "4k3/8/8/8/8/8/3p4/4K3 b - - 0 1", "d2d1q",
         expect={"advancedPawn", "promotion"}, reject=set())

    print("\nPhase:")
    case("opening",
         "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "g1f3",
         expect={"opening", "quietMove"}, reject={"endgame", "middlegame"})
    case("rook endgame",
         "8/5pk1/8/8/8/8/5PK1/4R3 w - - 0 40", "e1e7",
         expect={"endgame", "rookEndgame"}, reject={"opening", "pawnEndgame", "middlegame"})
    case("queen and rook endgame",
         "8/5pk1/8/8/8/8/5PK1/3QR3 w - - 0 40", "d1d7",
         expect={"endgame", "queenRookEndgame"}, reject={"rookEndgame", "queenEndgame"})

    print("\nEvaluation-driven themes:")
    case("crushing, from the stored eval",
         "4k3/8/8/3r4/8/8/3R4/4K3 w - - 0 1", "d2d5",
         expect={"crushing"}, reject={"equality", "advantage"}, cp_after=900)
    case("equality, and defensive because you were worse",
         "4k3/8/8/3r4/8/8/3R4/4K3 w - - 0 1", "d2d5",
         expect={"equality", "defensiveMove"}, reject={"crushing"},
         cp_before=-350, cp_after=10)
    case("advantage sits between the two",
         "4k3/8/8/3r4/8/8/3R4/4K3 w - - 0 1", "d2d5",
         expect={"advantage"}, reject={"crushing", "equality"}, cp_after=320)


def sanity():
    print("\nSanity:")
    ok = derive_themes("not a fen", "e2e4") == []
    print(f"  {'ok  ' if ok else 'FAIL'} a broken FEN returns no themes")
    if not ok:
        failures.append("a broken FEN should return no themes")

    ok = derive_themes("4k3/8/8/8/8/8/8/4K3 w - - 0 1", "a1a8") == []
    print(f"  {'ok  ' if ok else 'FAIL'} an illegal move returns no themes")
    if not ok:
        failures.append("an illegal move should return no themes")

    # Nothing the tagger emits may fall outside the catalog, or the picker
    # would show a filter with no label and no way to reach it.
    emitted = set()
    for fen, uci in [
        ("2r3k1/5ppp/8/3N4/8/8/5PPP/6K1 w - - 0 1", "d5e7"),
        ("6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1", "e1e8"),
        ("8/4P3/8/8/8/8/8/k1K5 w - - 0 1", "e7e8n"),
        ("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", "g1f3"),
    ]:
        emitted |= set(derive_themes(fen, uci, cp_after=500))
    unknown = emitted - set(THEME_LABELS)
    ok = not unknown
    print(f"  {'ok  ' if ok else 'FAIL'} every emitted theme is in the catalog")
    if not ok:
        failures.append(f"themes emitted but not in the catalog: {sorted(unknown)}")

    outside = DERIVABLE_THEMES - set(THEME_LABELS)
    ok = not outside
    print(f"  {'ok  ' if ok else 'FAIL'} every derivable theme is in the catalog")
    if not ok:
        failures.append(f"derivable but uncatalogued: {sorted(outside)}")

    groups = catalog()
    keys = [t["key"] for g in groups for t in g["themes"]]
    ok = len(keys) == len(set(keys))
    print(f"  {'ok  ' if ok else 'FAIL'} no theme appears in two groups")
    if not ok:
        failures.append("a theme is listed in more than one group")

    ok = (length_theme(1), length_theme(2), length_theme(3), length_theme(7)) == \
         ("oneMove", "short", "long", "veryLong")
    print(f"  {'ok  ' if ok else 'FAIL'} length buckets")
    if not ok:
        failures.append("length_theme buckets are wrong")

    ok = (mate_in_theme(1), mate_in_theme(3), mate_in_theme(9), mate_in_theme(0)) == \
         ("mateIn1", "mateIn3", "mateIn5", None)
    print(f"  {'ok  ' if ok else 'FAIL'} mate-in buckets cap at 5")
    if not ok:
        failures.append("mate_in_theme buckets are wrong")

    ok = (outcome_theme(900), outcome_theme(-900), outcome_theme(300),
          outcome_theme(0), outcome_theme(None)) == \
         ("crushing", "crushing", "advantage", "equality", None)
    print(f"  {'ok  ' if ok else 'FAIL'} outcome buckets are symmetric in sign")
    if not ok:
        failures.append("outcome_theme buckets are wrong")

    ok = parse("  mateIn2   short  ") == ["mateIn2", "short"] and parse(None) == []
    print(f"  {'ok  ' if ok else 'FAIL'} theme strings parse")
    if not ok:
        failures.append("parse() is wrong")


if __name__ == "__main__":
    tactics()
    sanity()
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for line in failures:
            print("  - " + line)
        sys.exit(1)
    print("all checks passed")
