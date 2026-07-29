# Engine Room v2 — Build Spec

## 1. Goals

- A web app, run on a home server, reachable from a phone browser.
- Two independent users (Christian and his wife). Fully separate accounts: separate
  saved analyses, separate saved games, separate Elo-trend history. No data mixing.
- Both users can run analyses concurrently without blocking or slowing each other
  down beyond genuine CPU contention.
- Local engines only: Stockfish and Maia3 (via a UCI-speaking wrapper). Both
  engines are user-configured via an in-app settings dialog (see §11), not env
  vars alone (though env-var/default fallback for the binary path is fine).

## 2. Multi-user & Auth

- Lightweight auth — this is a two-person home app, not public-facing. A simple
  login (username/password, or a fixed pair of profile picks with a PIN) is
  enough. No OAuth, email verification, etc.
- Every persisted entity (saved analysis run, saved played-vs-Maia game,
  uploaded PGN, Elo-trend data point) is scoped to a user_id from the very
  first schema design — this must not be retrofitted later.
- Sessions are per-browser-tab/connection, not global — one user's
  in-progress analysis job must never appear in the other user's UI.

## 3. Engine Process Management (critical)

- **One persistent engine process per live-analysis session**, not one per
  request. When a user opens the board/eval-bar view, spin up a single
  long-lived Stockfish process (and, separately, a single long-lived Maia
  process if the user is querying Maia interactively) for that session. Reuse
  it across every position change until the session ends.
- **Rapid navigation must not spawn concurrent evaluations.** Use a sequence
  number per request: issue `go` to the engine for the latest position only;
  if a newer position request arrives before the previous one resolves, send
  `stop` to the same engine and discard the stale result rather than queuing
  both. Never start a second process to service a newer request while the
  first is still busy.
- **Idle timeout + cleanup.** If a session's engine process is idle for a
  configurable period (e.g. 5–10 minutes) or the client disconnects
  (WebSocket/SSE closes, tab closed), the server tears down that process. Use
  a heartbeat or connection-close hook — don't rely solely on garbage
  collection.
- **Batch/analysis-pass engines are separate from live-eval engines.** A full
  game or batch analysis run uses its own short-lived worker process(es) from
  the worker pool (§10), which exit when the job completes. These must never
  be confused with, or compete unmanaged against, the persistent live-eval
  engine for the same user.
- **Process accounting.** Log or expose (admin/debug endpoint or server log)
  how many engine processes are alive and who owns each, so runaway spawning
  is obvious during development.
- On server shutdown/restart, all engine subprocesses must be terminated —
  no orphans left running.

## 4. PGN Input & Game Parsing

- Accept one or more `.pgn` file uploads, or a pasted PGN string.
- Each file may contain a single game or a multi-game dump (e.g. a chess.com
  bulk export). Parse all games from all inputs into one combined, indexed
  list, with a stable index per game across the whole batch.
- A game picker lists every parsed game (opponent, date, result, source
  file/index) so the user can select which to view/analyze.
- PGN dates: prefer the `UTCDate` header over `Date` (chess.com/lichess
  exports carry UTCDate); a game whose year or month can't be parsed is
  excluded from any date-bucketed view, not guessed at.
- Determine which color the logged-in user played by matching their
  configured display name against the `White`/`Black` headers
  (case-insensitive, trimmed). If neither matches, flag the game as
  unassigned rather than silently guessing — surface it to the user instead
  of dropping it.

## 5. Board & Viewer UI

- Board on the left. Piece/board art loaded from asset sets at
  `/assets/sets/{set_name}/` (board.png, wp.png, bp.png, etc.). Initially one
  set exists; more can be added later via directory scan/manifest with no
  code changes.
- Eval bar tied to the live Stockfish process for the currently viewed
  position (see §3). Its placement is a board setting: along the top of the
  board, or standing to the left or right of it.
- Move table to the right of the board, two columns. Built oriented to the
  selected player; now **White always on the left**, with the player's name
  (and `(you)`) in the column header instead — a table whose columns swap
  between games has to be read from its header either way.
- Move navigation buttons below the *move table*, which is what they step
  through (first/prev/next/last; keyboard arrow support is a nice-to-have).
  Flip and the board-settings button stay under the board.
- Piece movement animation on navigation and on played moves: slide the
  moved piece to its destination, fade out any captured piece, then settle
  to the exact resulting position (handles captures, castling rook,
  en passant, promotion cleanly by snapping to the authoritative FEN after
  the slide).
- Copyable FEN box showing the current position.
- FEN input box to jump the board to an arbitrary position.
- Click-to-move: click a piece to see its legal destinations highlighted,
  click a destination to move; promotion prompts for the piece choice when
  a move is ambiguous.
- Drag-to-move: press a piece and it is picked up under the cursor, with the
  square it is over outlined as the one it would land on; let go on a legal
  destination to play the move, anywhere else to put it back. Selecting a
  square sweeps a filled circle out over it, quiet destinations grow their
  dot in, and a destination holding a piece you'd capture tints the whole
  square around a circular hole cut for the piece instead of a dot.
- Board sized responsively from available viewport space, clamped to a
  sensible min/max — must work acceptably on a phone screen.
- Move classification (beyond the four bands of section 8): Best, Excellent
  and Good split the top band by whether the engine picked the move and how
  much it gave up; Book comes from the opening database; Miss is a
  mistake/blunder that threw away a won position. Great and Brilliant now
  require the move to have been the *only* move — the second-best line at
  least 0.15 win probability worse, and more than one legal move to choose
  from — which is why the analysis pass searches MultiPV 2.
- Opening database (beyond the spec): a panel beside the analysis board
  listing every move a reference PGN library played from the current
  position, with game counts, the white/draw/black split and average
  rating; clicking a row plays the move. Built once from a PGN dump by
  `app.opening_import` into its own SQLite file, keyed by EPD.

## 6. Board Animation During Analysis

While a game (or a game within a batch) is being analyzed, the board should
visibly step through that game's positions in sync with analysis progress —
not sit static or blank behind a progress bar. As each position is evaluated
server-side, advance the board to that position using the same
slide/fade animation as manual navigation (§5), driven by the progress
events streamed from the job. This applies to single-game analysis and,
for batch mode, to whichever game is currently being processed.

## 7. Variations

- While stepping through a loaded game, the user can play a different move
  than the mainline to branch into a variation.
- Variations are tracked as a real move tree (not a flat list) — represent
  this as a proper tree on both backend and frontend rather than a bespoke
  flat format.
- Variations can be deleted. The mainline is always preserved.
- Open question to confirm with Christian before building: whether saving a
  game preserves variations or only the mainline.

## 8. Move Classification (Stockfish pass)

This is the validated algorithm — reproduce it exactly, since its output has
already been checked against chess.com's own move-quality labels and holds up
well.

**Win probability**, from centipawn eval `cp` (from the side-to-move's
perspective):

```
wp(cp) = 1 / (1 + exp(-0.00368208 * cp))
```

**Per-move classification**, using one Stockfish eval per position (not two
per move): for a game with N plies, evaluate the position *before* each move
(N evals) plus the final resulting position (1 eval) — N+1 evals total per
game, versus a naive 2N.

For move *i*, played by the side to move at that point:

```
wp_before = wp(eval_i)          # mover's own perspective, before the move
wp_after  = 1 - wp(eval_{i+1})  # flip: eval_{i+1} is from the opponent's
                                 # perspective (they're now to move), so
                                 # 1 - wp gives it back in the mover's terms
drop = max(0, wp_before - wp_after)
```

Classify by `drop` against these thresholds, in order, first match wins:

| drop <  | classification |
|---------|-----------------|
| 0.05    | Good            |
| 0.10    | Inaccuracy      |
| 0.20    | Mistake         |
| else    | Blunder         |

**End-of-game handling**: if the final position is checkmate or stalemate,
don't run the engine on it — use a fixed eval instead (±10000 cp for the
side that's checkmated / delivered mate, 0 for a draw), consistent with how
mate scores are handled everywhere else in the pipeline.

**Great / Brilliant** (extends the above, needs Maia): a move that is Good
(or very close to the engine's own best move) additionally qualifies as
Great or Brilliant if Maia's top-1 match rate for that position, evaluated
at the player's own estimated Elo (§9), is low — i.e. most players of that
estimated strength would not have found it. Pin down the exact match-rate
threshold and the Good/Best-move closeness criterion before implementation
rather than leaving them to be improvised (flag as an open question if not
specified elsewhere).

**Blunder → Elo correlation**: for every move classified as Mistake or
Blunder, and swept by the Maia Elo pass (§9), find the *lowest* swept Elo
whose Maia top-1 choice equals the move actually played. If no swept Elo
plays it, there's no correlation to report. This answers "would a player of
the estimated strength have been expected to avoid this."

## 9. Elo Estimation (Maia3 sweep)

- For a selected game, sweep Maia3's Elo setting across a user-configured
  min/max range and record, at every Elo, what the model made of the move
  actually played — separately for each player (self vs. opponent). Record
  *where the move ranked* in Maia's ordering rather than only whether it was
  the top choice: at `go nodes 1` the policy net has already ordered every
  legal move, so several ranked candidates cost no extra engine time.
- Split positions into **discriminative** (what the model made of the move
  changes somewhere across the swept Elo grid) vs. **uninformative** (it
  doesn't) before fitting. Only discriminative positions feed the estimator —
  uninformative ones add variance without adding signal. Note this depends on
  the objective: under top-1 a position is uninformative unless Maia's
  *favourite* changes, under the likelihood unless its opinion of the played
  move changes at all, which is far more of them.
- **Objective function: the likelihood is the default**, and the top-1 match
  rate is kept reachable beside it. Score each move by the log probability
  Maia gave it and take `argmax_r sum log P(move | position, r)`; the peak is
  the estimate. Probe for policy at runtime rather than assuming — some UCI
  wrappers report value-head win/draw/loss numbers that look like
  probabilities but aren't policy probabilities, so confirm the semantics of
  whatever field is present before trusting it. **Maia3 is exactly this
  case**: its wrapper prints `score cp` and `wdl` from the value head and
  never prints the policy it computed, so those fields must be rejected, and
  `app/maia_policy.py` runs the same engine with the policy field added.
  Where no policy is available — every sweep already stored, and any build the
  shim can't drive — score the move by the rank the sweep recorded instead,
  through a fixed rank-to-probability model. The two feed the same estimator
  and the fit reports which it used.
- Fit the peak with **weights that fall away smoothly** from the maximum
  (weight `exp((L - Lmax)/tau)` over every grid point), not by choosing a
  window of points around it. A window picked from the data makes the
  estimate a discontinuous function of the data, and the extra spread that
  injects is invisible to any error bar computed afterwards. Do not smooth
  and take an argmax: smoothing drags the apex toward the flat tails, worse
  the wider the grid.
- Get the uncertainty from the fit rather than by resampling: a **delete-one
  jackknife over the independent unit** — games when several are pooled,
  moves otherwise, since moves from one game share an opponent, an opening
  and a sitting. Dropping a unit subtracts its own coefficients from the
  summed quadratic, so every leave-one-out peak is closed-form and the whole
  interval costs one vectorised expression.
- Attach an explicit High/Medium/Low confidence label backed by named
  reasons (sample size, interval width, whether the peak is at a grid edge)
  — not just the number. Include the **absolute** check the likelihood makes
  possible: mean log probability per move is comparable across players and
  grids without any calibration, so state whether the model predicted this
  player about as well as it predicts anyone, or no better than guessing
  among legal moves.
- Cache the full per-(position, Elo) score matrix so re-fitting (e.g. a
  different objective, or the trend view in §14) never requires re-running
  the engines.
- Support running this per-game or in batch across many games (§12), with a
  coarser default Elo-step resolution in batch mode to keep runtime
  reasonable — expose the resolution as a setting.

## 10. Concurrency & Job Queue

- Long-running analysis (single full-game or batch) runs as a queued
  background job, not inline in the request/response cycle. Progress
  streams to the client (SSE or WebSocket) keyed by job id, so a reconnect
  (e.g. phone screen lock) resumes watching the same job instead of losing
  progress.
- A bounded worker pool, sized to the server's actual CPU core count,
  processes queued jobs. Two users submitting jobs concurrently should both
  make progress, sharing the pool, without one blocking the other outright —
  but don't over-provision workers beyond what the hardware can run without
  thrashing.
- This job/worker system is distinct from the persistent live-eval engine
  processes in §3 — don't conflate the two pools.

## 11. Engine Settings

**Stockfish** (configurable per user, applies to both live-eval and analysis
passes unless overridden per-job):
- Binary path (via the in-app file picker described in §4's parent doc — a
  server-side browse endpoint, since browser file inputs can't expose
  absolute paths).
- Threads.
- Hash size (MB).
- Search limit for the analysis pass: depth or movetime, user's choice.
- Optional skill-level cap if the user ever wants sub-full-strength eval
  (nice-to-have, not required).

**Maia3**:
- Binary/weights path.
- **Model size picker: 5m / 25m / 79m** — the user selects which Maia3
  weight variant to use, both for live "ask Maia" queries and for the Elo
  sweep. Store this as part of the engine config, not hardcoded.
- Elo range (min/max) for the sweep pass, and the sweep's Elo step size.

Settings persist per user (not global), since the two users may want
different Stockfish thread/hash allocations or different Maia model sizes.

## 12. Analysis Modes

- **Quick mode**: Stockfish-only pass (§8, minus Great/Brilliant and the
  blunder-Elo correlation, which need Maia). Fast; useful when you just want
  blunder-checking.
- **Full mode**: Quick mode + Maia Elo-sweep estimate (§9) + Great/Brilliant
  + blunder-Elo correlation.
- **Batch mode**: run Full or Quick mode across many games from a
  multi-file upload, with a progress bar suitable for long runs (target:
  comfortably handle on the order of 1000 games), animating through
  whichever game is currently being processed (§6).

## 13. Persistence

- Save an analysis run (single game or batch) to storage, scoped to the
  owning user. Support loading a saved run later, and appending newly
  analyzed games to an existing run rather than only creating new runs.
- Store per-position data (not just final labels/estimates) so the trend
  view (§14) can be recomputed or re-bucketed without re-running any engine.

## 14. Play vs. Maia3

- A live-play mode: the user plays a game against Maia3 at a chosen Elo
  (drawing on the same model-size/Elo settings from §11), on the same board
  UI used for viewing/analysis.
- Standard legal-move enforcement. Open question to confirm with Christian:
  whether a clock is wanted.
- Optionally save the resulting game to the user's library, from which it
  can later be loaded into the analysis viewer like any other game.
- Architecturally separate from the analysis pipeline: it reuses the board
  UI and the Maia engine wrapper, but not the job queue or the Elo-sweep/
  classification code.

## 15. Trend-Over-Time

- Per user, plot estimated Elo (from saved analysis runs) against actual Elo
  (from PGN header fields such as WhiteElo/BlackElo, bucketed by UTCDate)
  over time.
- Configurable bucket granularity: year, month, or ISO week (or similar) —
  the user can switch granularity without re-running any analysis; compute
  from the cached per-position data in §13.
- Handle sparse periods sensibly (e.g. show, don't error on, buckets with
  very few games), and be explicit about when an apparent trend is or isn't
  distinguishable from the buckets' own confidence intervals — a headline
  "improving by X Elo" number is misleading if X is smaller than the noise
  in each bucket's own estimate.
- This view is being designed fresh with no constraints from any prior
  implementation.

## 16. Non-Functional

- Runs as a proper server process suitable for staying up continuously on a
  home machine, reachable from a phone browser on the home network or over
  something like Tailscale — not intended to be exposed to the open
  internet.
- Dependency-light where reasonable (numpy/scipy-class stats stack is fine);
  a frontend build step is acceptable this time if it genuinely simplifies
  the multi-user real-time UI — use judgment given the added complexity of
  auth/jobs/live engines.

## 17. Suggested Build Order

1. Schema + skeleton with multi-user support baked in from the start: PGN
   input, game picker, board/piece viewer, move table, nav, FEN box/input,
   piece animation.
2. Live Stockfish on the current position (eval bar, engine settings
   dialog including Stockfish threads/hash/depth and Maia model-size/Elo
   settings), built with the persistent-process/no-respawn model (§3) from
   day one.
3. Variation support on the game tree.
4. Quick mode: Stockfish-only move classification (§8), plus board
   animation during analysis (§6).
5. Play vs. Maia3 (live game loop + optional save).
6. Single-game Maia Elo-sweep (§9) + fitted-curve visualization +
   confidence.
7. Great/Brilliant classification + blunder-Elo correlation.
8. Persistence: save/load/append runs, per user.
9. Batch mode: multi-file ingestion, progress bar, coarser sweep
   resolution.
10. Multi-instance hardening: job queue, worker pool, concurrent-user
    testing.
11. Trend-over-time, per user.
12. Visual polish pass, once asset sets are filled in.

## 18. Open Questions for the Agent to Raise, Not Assume

- Exact Great/Brilliant Maia-match-rate threshold and Good/Best-move
  closeness criterion.
- Whether saved games preserve variations or only the mainline.
- Whether Play-vs-Maia needs a clock.
- Whether to simulate live Maia game move time so Maia does not make moves instantly
- Auth mechanism preference (simple password vs. something else).
