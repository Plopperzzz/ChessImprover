"""Per-screen board/piece/sound preferences, over the real app.

A7 gave each screen its own board, pieces and sounds on top of the account
defaults. The rules are small and entirely about absence -- a screen with no
row follows the defaults, an override of `''` clears back to them, and a row
that overrides nothing is deleted rather than kept -- which is exactly the kind
of thing that rots silently, because every wrong answer is still a plausible
set name.

Run it with `python backend/sims/screen_prefs_check.py`.

What matters most here, in order:

* **The default keeps being followed.** A screen left alone must track the
  account default when that changes later, not be pinned to whatever it
  happened to be when the screen was first looked at.
* **Clearing is possible at all.** An omitted field means "leave alone", so
  there has to be a way to say "put this back" -- the empty string -- and it
  has to leave no trace behind.
* **`effective` is the server's answer.** Both front ends draw boards from it;
  a rule that lives in one browser is a rule the other gets subtly wrong.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="screen-prefs-check-")
os.environ["CHESSIMPROVER_DB"] = os.path.join(SCRATCH, "check.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import db_cursor, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.paths import AUDIO_REQUIRED, list_audio_sets  # noqa: E402

failures = []


def check(label: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}{(': ' + detail) if detail else ''}")


def rows(user_id: int) -> int:
    with db_cursor() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS n FROM screen_prefs WHERE user_id = ?", (user_id,)
        ).fetchone()["n"]


def main():
    init_db()
    client = TestClient(app)

    print("The sound sets on disk:")
    sets = list_audio_sets()
    names = {s["name"] for s in sets}
    check("default exists", "default" in names, str(sorted(names)))
    check(
        "and carries the sounds a set is required to have",
        all(key in next(s for s in sets if s["name"] == "default")["sounds"]
            for key in AUDIO_REQUIRED),
    )
    check("marked complete", next(s for s in sets if s["name"] == "default")["complete"])

    print("\nEverything is behind a login:")
    check("401 without a session", client.get("/api/settings/screens").status_code == 401)

    client.post("/api/auth/accounts", json={"username": "checker", "display_name": "Checker"})
    assert client.post("/api/auth/login", json={"username": "checker"}).status_code == 200
    user_id = client.get("/api/auth/me").json()["id"]

    print("\nA fresh account overrides nothing:")
    prefs = client.get("/api/settings/screens").json()
    check("no overrides", all(v is None for screen in prefs["screens"].values()
                              for v in screen.values()), str(prefs["screens"]))
    check("effective is the defaults",
          prefs["effective"]["analysis"] == prefs["defaults"], str(prefs["effective"]))
    check("and no rows were written", rows(user_id) == 0, str(rows(user_id)))

    print("\nAn override applies to one screen and no other:")
    response = client.put("/api/settings/screens/analysis", json={"piece_set": "neo"})
    check("accepted", response.status_code == 200, response.text)
    prefs = response.json()
    check("analysis takes it", prefs["effective"]["analysis"]["piece_set"] == "neo",
          str(prefs["effective"]["analysis"]))
    check("puzzles does not", prefs["effective"]["puzzles"]["piece_set"] == "default",
          str(prefs["effective"]["puzzles"]))
    check("the default is untouched", prefs["defaults"]["piece_set"] == "default",
          str(prefs["defaults"]))
    check("board and sounds still follow it",
          prefs["screens"]["analysis"]["board_set"] is None
          and prefs["screens"]["analysis"]["sound_set"] is None,
          str(prefs["screens"]["analysis"]))

    print("\nA screen following the default tracks it when it changes:")
    client.put("/api/settings/profile", json={"piece_set": "neo_angled"})
    prefs = client.get("/api/settings/screens").json()
    check("puzzles moved with the default",
          prefs["effective"]["puzzles"]["piece_set"] == "neo_angled",
          str(prefs["effective"]["puzzles"]))
    check("analysis kept its own", prefs["effective"]["analysis"]["piece_set"] == "neo",
          str(prefs["effective"]["analysis"]))

    print("\nClearing an override puts the screen back on the default:")
    prefs = client.put("/api/settings/screens/analysis", json={"piece_set": ""}).json()
    check("back on the default", prefs["effective"]["analysis"]["piece_set"] == "neo_angled",
          str(prefs["effective"]["analysis"]))
    check("and the empty row is gone", rows(user_id) == 0, f"{rows(user_id)} row(s) left")

    print("\nA row with one override left is kept:")
    client.put("/api/settings/screens/play", json={"board_set": "neo", "sound_set": "default"})
    client.put("/api/settings/screens/play", json={"sound_set": ""})
    prefs = client.get("/api/settings/screens").json()
    check("the board override survives", prefs["screens"]["play"]["board_set"] == "neo",
          str(prefs["screens"]["play"]))
    check("the sound one is cleared", prefs["screens"]["play"]["sound_set"] is None)
    check("and the row is still there", rows(user_id) == 1, str(rows(user_id)))

    print("\nBad input is refused rather than stored:")
    check("an unknown screen is a 400",
          client.put("/api/settings/screens/nowhere", json={"piece_set": "neo"}).status_code == 400)
    check("an unknown piece set is a 400",
          client.put("/api/settings/screens/analysis",
                     json={"piece_set": "nonesuch"}).status_code == 400)
    check("an unknown sound set is a 400",
          client.put("/api/settings/screens/analysis",
                     json={"sound_set": "nonesuch"}).status_code == 400)
    check("an empty body is a 400",
          client.put("/api/settings/screens/analysis", json={}).status_code == 400)
    check("and none of that wrote a row", rows(user_id) == 1, str(rows(user_id)))

    print("\nThe account's own sound set:")
    check("rejects an unknown one",
          client.put("/api/settings/profile", json={"sound_set": "nonesuch"}).status_code == 400)
    check("accepts the real one",
          client.put("/api/settings/profile", json={"sound_set": "default"}).status_code == 200)
    check("and /api/auth/me carries it",
          client.get("/api/auth/me").json().get("sound_set") == "default",
          str(client.get("/api/auth/me").json().get("sound_set")))


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
