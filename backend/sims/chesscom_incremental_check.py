"""Driving the chess.com importer against a stand-in for chess.com.

The real API can't be reached from a test, and shouldn't be: this needs to
control what the server answers -- ETags, 304s, a month that gains a game,
a month that never had one -- and to *count the requests*, which is the whole
point of the change. So it runs a small HTTP server that speaks the same
protocol and records every request made to it.

Run it with `python backend/sims/chesscom_incremental_check.py`.

What it is actually checking:

* **Finished months are not requested at all.** A monthly archive holds the
  games that ended in that month, so once the month is over it can't gain
  one. Re-running an import must therefore make *zero* requests for those
  months -- not a cheap request, none.
* **Everything else is asked conditionally**, and a 304 stores nothing.
* **A month that really did change contributes only its new games**, because
  the ones already held are matched on their permanent chess.com link.
* **`mode="refetch"` still works**, because the caching would otherwise make
  it impossible to get back games deleted from the library.

The request log is the assertion in most of these. Counting games imported
would pass just as happily on a version that re-downloads a decade every
time, which is exactly the bug being fixed.
"""

import http.server
import json
import os
import sys
import tempfile
import threading
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

SCRATCH = tempfile.mkdtemp(prefix="chesscom-check-")
os.environ["CHESSIMPROVER_DB"] = os.path.join(SCRATCH, "check.db")

from fastapi.testclient import TestClient  # noqa: E402

from app import chesscom  # noqa: E402
from app.db import db_cursor, init_db  # noqa: E402
from app.main import app  # noqa: E402

failures = []


def check(label: str, ok: bool, detail: str = ""):
    print(f"  {'ok  ' if ok else 'FAIL'} {label}{(' -- ' + detail) if detail else ''}")
    if not ok:
        failures.append(f"{label}{(': ' + detail) if detail else ''}")


# ---------------------------------------------------------------------------
# A stand-in for api.chess.com
# ---------------------------------------------------------------------------

NOW = datetime.now(timezone.utc)


def month_before(n: int) -> tuple[int, int]:
    """(year, month) n months back from now. Month 0 is the current one, which
    is the only one that can still gain games."""
    year, month = NOW.year, NOW.month
    for _ in range(n):
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return year, month


def game_pgn(username: str, year: int, month: int, index: int) -> str:
    """One game, with the `Link` header the dedupe hangs off."""
    return (
        f'[Event "Live Chess"]\n'
        f'[Site "Chess.com"]\n'
        f'[Date "{year:04d}.{month:02d}.15"]\n'
        f'[White "{username}"]\n'
        f'[Black "Opponent{index}"]\n'
        f'[Result "1-0"]\n'
        f'[UTCDate "{year:04d}.{month:02d}.15"]\n'
        f'[TimeControl "600"]\n'
        f'[Link "https://www.chess.com/game/live/{year}{month:02d}{index:04d}"]\n'
        f'\n1. e4 {{[%clk 0:09:58]}} e5 {{[%clk 0:09:57]}} 2. Nf3 1-0\n\n'
    )


class FakeChessCom(http.server.BaseHTTPRequestHandler):
    # {(year, month): game_count}
    archive = {}
    log = []
    lock = threading.Lock()

    def log_message(self, *args):
        pass  # quiet

    def _month_from_path(self):
        parts = self.path.strip("/").split("/")
        # pub/player/<name>/games/<yyyy>/<mm>/pgn
        try:
            return int(parts[4]), int(parts[5])
        except (IndexError, ValueError):
            return None

    def do_GET(self):
        with FakeChessCom.lock:
            FakeChessCom.log.append({
                "path": self.path,
                "if_none_match": self.headers.get("If-None-Match"),
                "if_modified_since": self.headers.get("If-Modified-Since"),
            })

        if self.path.endswith("/games/archives"):
            months = sorted(FakeChessCom.archive)
            body = json.dumps({"archives": [
                f"https://api.chess.com/pub/player/tester/games/{y}/{m:02d}"
                for y, m in months
            ]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        month = self._month_from_path()
        if month is None or month not in FakeChessCom.archive:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        count = FakeChessCom.archive[month]
        # The ETag changes when the month's contents change, which is what a
        # real cache validator does.
        etag = f'"{month[0]}-{month[1]}-{count}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        body = "".join(
            game_pgn("tester", month[0], month[1], i) for i in range(count)
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/x-chess-pgn")
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", "Wed, 21 Oct 2026 07:28:00 GMT")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def requests_for_months() -> list[str]:
    """Just the month fetches, not the archive listing."""
    return [r["path"] for r in FakeChessCom.log if r["path"].endswith("/pgn")]


def reset_log():
    with FakeChessCom.lock:
        FakeChessCom.log = []


# ---------------------------------------------------------------------------


def main():
    init_db()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeChessCom)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    chesscom.API_ROOT = f"http://127.0.0.1:{port}/pub"

    # Three finished months and the current one, which is the only one that
    # can still gain a game.
    finished = [month_before(3), month_before(2), month_before(1)]
    current = month_before(0)
    FakeChessCom.archive = {m: 4 for m in finished}
    FakeChessCom.archive[current] = 2

    client = TestClient(app)
    client.post("/api/auth/accounts",
                json={"username": "tester", "display_name": "tester"})
    client.post("/api/auth/login", json={"username": "tester"})

    labels = [f"{y:04d}-{m:02d}" for y, m in sorted(FakeChessCom.archive)]

    print("The first import downloads everything:")
    reset_log()
    first = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": labels, "mode": "new"}).json()
    check("all four months fetched", len(requests_for_months()) == 4,
          f"{len(requests_for_months())} requests")
    check("and every game landed", first["added"] == 14, str(first["added"]))
    check("with their clocks", first["with_clocks"] == 14, str(first["with_clocks"]))
    check("none skipped", first["skipped"] == 0, str(first["skipped"]))

    print("\nThe same import again, with nothing changed:")
    reset_log()
    second = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": labels, "mode": "new"}).json()
    paths = requests_for_months()
    check("the finished months are not requested at all", len(paths) == 1,
          f"{len(paths)} requests: {paths}")
    check("and the one that is, is the current month",
          paths and paths[0].endswith(f"/{current[0]}/{current[1]:02d}/pgn"),
          str(paths))
    check("it was asked conditionally",
          FakeChessCom.log[-1]["if_none_match"] is not None,
          str(FakeChessCom.log[-1]))
    check("nothing new was added", second["added"] == 0, str(second["added"]))
    check("three months reported as already complete", second["settled"] == 3,
          str(second["settled"]))
    check("and the current month as unchanged", second["unchanged"] == 1,
          str(second["unchanged"]))
    check("no games were even parsed to find that out", second["skipped"] == 0,
          str(second["skipped"]))

    print("\nAfter playing two more games this month:")
    FakeChessCom.archive[current] = 4
    reset_log()
    third = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": labels, "mode": "new"}).json()
    check("still only the current month is fetched",
          len(requests_for_months()) == 1, str(requests_for_months()))
    check("the two new games are added", third["added"] == 2, str(third["added"]))
    check("and the two already held are skipped", third["skipped"] == 2,
          str(third["skipped"]))

    with db_cursor() as conn:
        total = conn.execute("SELECT COUNT(*) AS n FROM games").fetchone()["n"]
        distinct = conn.execute(
            "SELECT COUNT(DISTINCT external_id) AS n FROM games"
        ).fetchone()["n"]
    check("nothing is duplicated in the library", total == distinct == 16,
          f"{total} games, {distinct} distinct")

    print("\nThe month list says which months are settled:")
    listing = client.post("/api/games/chesscom/archives",
                          json={"username": "tester"}).json()
    by_label = {m["label"]: m for m in listing["months"]}
    check("the finished ones are marked",
          all(by_label[f"{y:04d}-{m:02d}"]["settled"] for y, m in finished),
          str([(k, v["settled"]) for k, v in by_label.items()]))
    check("the current one is not",
          not by_label[f"{current[0]:04d}-{current[1]:02d}"]["settled"])
    check("and the counts are there",
          by_label[f"{finished[0][0]:04d}-{finished[0][1]:02d}"]["imported"] == 4)
    check("with a summary of how much is left to check",
          listing["to_check"] == 1 and listing["settled"] == 3,
          f"to_check={listing['to_check']} settled={listing['settled']}")

    print("\nA month that never had games doesn't become a permanent re-fetch:")
    empty_month = month_before(4)
    FakeChessCom.archive[empty_month] = 0
    empty_label = f"{empty_month[0]:04d}-{empty_month[1]:02d}"
    client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": [empty_label], "mode": "new"})
    reset_log()
    client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": [empty_label], "mode": "new"})
    check("an empty finished month is settled after one read",
          len(requests_for_months()) == 0, str(requests_for_months()))

    print("\nrefetch ignores all of it, so deleted games can come back:")
    with db_cursor() as conn:
        victim = f"{finished[0][0]:04d}-{finished[0][1]:02d}"
        conn.execute(
            "DELETE FROM games WHERE source_name = ?",
            (chesscom.source_name_for("tester", *finished[0]),),
        )
        left = conn.execute("SELECT COUNT(*) AS n FROM games").fetchone()["n"]
    check("four games deleted from the library", left == 12, str(left))

    reset_log()
    skipped_run = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": [victim], "mode": "new"}).json()
    check("'new' will not bring them back -- the month is settled",
          skipped_run["added"] == 0 and len(requests_for_months()) == 0,
          f"added {skipped_run['added']}, {len(requests_for_months())} requests")

    reset_log()
    forced = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": [victim], "mode": "refetch"}).json()
    check("'refetch' downloads the month again", len(requests_for_months()) == 1,
          str(requests_for_months()))
    check("unconditionally", FakeChessCom.log[-1]["if_none_match"] is None,
          str(FakeChessCom.log[-1]))
    check("and the deleted games come back", forced["added"] == 4,
          str(forced["added"]))

    print("\nThe per-request cap counts downloads, not months:")
    # Twelve more finished months, none of them ever seen.
    for n in range(5, 17):
        FakeChessCom.archive[month_before(n)] = 1
    every = [f"{y:04d}-{m:02d}" for y, m in sorted(FakeChessCom.archive)]
    reset_log()
    capped = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": every, "mode": "new"}).json()
    check("it stops at the cap", capped["downloaded"] == chesscom.MAX_MONTHS_PER_REQUEST,
          str(capped["downloaded"]))
    check("and hands back what it didn't reach", len(capped["remaining"]) > 0,
          str(len(capped["remaining"])))
    check("having skipped the settled ones for free rather than queueing them",
          capped["settled"] > 0, str(capped["settled"]))

    rounds = 1
    remaining = capped["remaining"]
    while remaining:
        rounds += 1
        step = client.post("/api/games/chesscom/import", json={
            "username": "tester", "months": remaining, "mode": "new"}).json()
        remaining = step["remaining"]
        if rounds > 20:
            break
    check("and the loop terminates", not remaining, f"after {rounds} rounds")

    print("\nOnce everything is known, a full sync is free:")
    reset_log()
    idle = client.post("/api/games/chesscom/import", json={
        "username": "tester", "months": every, "mode": "new"}).json()
    paths = requests_for_months()
    check("one request for seventeen months of archive", len(paths) == 1,
          f"{len(paths)} requests for {len(every)} months")
    check("nothing added", idle["added"] == 0, str(idle["added"]))
    check("and nothing left over", not idle["remaining"], str(idle["remaining"]))

    print("\nBad input:")
    check("an unknown mode is refused",
          client.post("/api/games/chesscom/import", json={
              "username": "tester", "months": ["2024-01"],
              "mode": "sideways"}).status_code == 400)
    check("no months is refused",
          client.post("/api/games/chesscom/import", json={
              "username": "tester", "months": []}).status_code == 400)
    check("a malformed month is refused",
          client.post("/api/games/chesscom/import", json={
              "username": "tester", "months": ["nope"]}).status_code == 400)
    check("refetch still caps months per request",
          client.post("/api/games/chesscom/import", json={
              "username": "tester", "months": every,
              "mode": "refetch"}).status_code == 400)

    server.shutdown()


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
