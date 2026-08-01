"""Saved variations, over the real app and a real board.

Run it with `python backend/sims/variations_check.py`.

What matters most here, in order:

* **A stored line replays.** Every line is played out from its anchor before
  it is stored, because a variation that cannot be reached is worse than no
  variation: months later it is indistinguishable from a bug in the board.
* **The anchor of a nested line.** A line off a line starts from *that line*
  replayed to the branch point, not from the mainline. Getting this wrong
  still produces a legal-looking position, which is exactly why it is checked
  rather than eyeballed.
* **Deleting takes the nested lines with it**, and never touches the mainline
  -- the same guarantee the classic UI's tree makes in memory.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="variations-check-")
os.environ["CHESSIMPROVER_DB"] = os.path.join(SCRATCH, "check.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import init_db  # noqa: E402
from app.main import app  # noqa: E402

failures = []


def check(label: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}{(': ' + detail) if detail else ''}")


# 1. e4 e5 2. Nf3 Nc6 3. Bb5 -- the Ruy, so the alternatives below are real
# moves in a real position rather than shuffling in the corner.
PGN = """[Event "Check"]
[White "Checker"]
[Black "Other"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *
"""


def main():
    init_db()
    client = TestClient(app)

    print("Everything is behind a login:")
    check("401 without a session", client.get("/api/games/1/variations").status_code == 401)

    client.post("/api/auth/accounts", json={"username": "checker", "display_name": "Checker"})
    assert client.post("/api/auth/login", json={"username": "checker"}).status_code == 200

    upload = client.post(
        "/api/games/upload",
        files={"files": ("check.pgn", PGN, "application/x-chess-pgn")},
    )
    assert upload.status_code == 200, upload.text
    game_id = upload.json()["games"][0]["id"]

    print("\nA line off the mainline:")
    check("nothing saved yet", client.get(f"/api/games/{game_id}/variations").json() == [])
    # After 3. Bb5, black's a6 is the game; Nf6 (Berlin) is the variation.
    made = client.post(
        f"/api/games/{game_id}/variations",
        json={"start_ply": 5, "moves": ["Nf6", "O-O", "Nxe4"], "label": "Berlin"},
    )
    check("created", made.status_code == 200, made.text)
    berlin = made.json()
    check("keeps the moves", berlin["moves"] == ["Nf6", "O-O", "Nxe4"], str(berlin["moves"]))
    check("and the branch point", berlin["start_ply"] == 5, str(berlin["start_ply"]))
    check("off the mainline", berlin["parent_id"] is None)
    check("listed", len(client.get(f"/api/games/{game_id}/variations").json()) == 1)

    print("\nA line that doesn't play is refused, not stored:")
    bad = client.post(
        f"/api/games/{game_id}/variations", json={"start_ply": 5, "moves": ["Nf6", "Qxh8"]}
    )
    check("400", bad.status_code == 400, bad.text)
    check("and says which move", "move 2" in bad.text, bad.text)
    check("nothing was written", len(client.get(f"/api/games/{game_id}/variations").json()) == 1)
    check(
        "a move that is legal elsewhere but not here is still refused",
        client.post(f"/api/games/{game_id}/variations",
                    json={"start_ply": 5, "moves": ["e5"]}).status_code == 400,
    )
    check(
        "an empty line is refused",
        client.post(f"/api/games/{game_id}/variations",
                    json={"start_ply": 5, "moves": []}).status_code == 400,
    )
    check(
        "a branch point past the end of the game is refused",
        client.post(f"/api/games/{game_id}/variations",
                    json={"start_ply": 99, "moves": ["e5"]}).status_code == 400,
    )

    print("\nA line off that line, anchored to it and not to the mainline:")
    # Two moves into the Berlin it is black to move after 4. O-O; Bc5 there is
    # a line off a line.
    nested = client.post(
        f"/api/games/{game_id}/variations",
        json={"parent_id": berlin["id"], "start_ply": 2, "moves": ["Bc5"]},
    )
    check("created", nested.status_code == 200, nested.text)
    check("hangs off the parent", nested.json()["parent_id"] == berlin["id"])
    # Nxe4 is only playable with a knight on f6, which is true two moves into
    # the Berlin and false in the mainline position at the same depth. So the
    # pair below passes only if each line was anchored where it says it is --
    # a wrong anchor swaps both answers.
    check(
        "a move that needs the parent line is accepted here",
        client.post(f"/api/games/{game_id}/variations",
                    json={"parent_id": berlin["id"], "start_ply": 2, "moves": ["Nxe4"]}
                    ).status_code == 200,
    )
    check(
        "and refused off the mainline at the same depth",
        client.post(f"/api/games/{game_id}/variations",
                    json={"start_ply": 5, "moves": ["Nxe4"]}).status_code == 400,
    )
    check(
        "a branch point past the end of the parent is refused",
        client.post(f"/api/games/{game_id}/variations",
                    json={"parent_id": berlin["id"], "start_ply": 9, "moves": ["Bc5"]}
                    ).status_code == 400,
    )

    print("\nExtending a line rewrites it rather than starting another:")
    grown = client.put(
        f"/api/variations/{berlin['id']}", json={"moves": ["Nf6", "O-O", "Nxe4", "d4"]}
    )
    check("accepted", grown.status_code == 200, grown.text)
    check("four moves now", len(grown.json()["moves"]) == 4, str(grown.json()["moves"]))
    check("still three rows", len(client.get(f"/api/games/{game_id}/variations").json()) == 3)
    check(
        "an illegal extension leaves the stored line alone",
        client.put(f"/api/variations/{berlin['id']}",
                   json={"moves": ["Nf6", "Qh4"]}).status_code == 400,
    )
    check("really alone",
          len(client.get(f"/api/games/{game_id}/variations").json()[0]["moves"]) == 4)
    check("and its nested lines are untouched",
          len(client.get(f"/api/games/{game_id}/variations").json()) == 3)

    print("\nA line cannot be truncated out from under a line nested in it:")
    cut = client.put(f"/api/variations/{berlin['id']}", json={"moves": ["Nf6"]})
    check("400", cut.status_code == 400, cut.text)
    check("and says why", "branches off later" in cut.text, cut.text)

    print("\nDeleting takes the nested lines with it:")
    removed = client.delete(f"/api/variations/{berlin['id']}")
    check("ok", removed.status_code == 200, removed.text)
    check("counted the nested ones", removed.json()["deleted"] == 3, str(removed.json()))
    check("nothing left", client.get(f"/api/games/{game_id}/variations").json() == [])
    check("deleting it again is a 404",
          client.delete(f"/api/variations/{berlin['id']}").status_code == 404)

    print("\nAnother account's variation is not reachable:")
    mine = client.post(
        f"/api/games/{game_id}/variations", json={"start_ply": 5, "moves": ["Nf6"]}
    ).json()
    client.post("/api/auth/accounts", json={"username": "other", "display_name": "Other"})
    client.post("/api/auth/login", json={"username": "other"})
    check("not listed", client.get(f"/api/games/{game_id}/variations").status_code == 404)
    check("not deletable", client.delete(f"/api/variations/{mine['id']}").status_code == 404)
    check("not editable",
          client.put(f"/api/variations/{mine['id']}", json={"label": "mine now"}).status_code == 404)

    print("\nDeleting the game takes its variations with it:")
    client.post("/api/auth/login", json={"username": "checker"})
    deleted = client.post("/api/games/bulk-delete", json={"game_ids": [game_id]})
    check("the game went", deleted.status_code == 200 and deleted.json()["deleted"] == 1,
          deleted.text)
    check("gone with it", client.get(f"/api/games/{game_id}/variations").status_code == 404)


if __name__ == "__main__":
    try:
        main()
    finally:
        import shutil

        shutil.rmtree(SCRATCH, ignore_errors=True)
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for line in failures:
            print("  - " + line)
        sys.exit(1)
    print("all checks passed")
