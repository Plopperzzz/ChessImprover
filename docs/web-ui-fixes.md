# React UI — fixes and gaps

Everything wrong with, or missing from, the React UI in [`web/`](../web/README.md)
as first landed. This is a *defects and polish* list, deliberately separate
from [`TODO.md`](TODO.md), which is for new features.

Written from a review of the first version, so a good deal of it is "this was
built the quick way and needs doing properly" rather than "this broke".

---

## Orientation

The whole UI is about 2,400 lines under `web/src`:

| File | What it owns |
| --- | --- |
| `App.tsx` | auth gate, screen routing, settings modal wiring, theme state |
| `components/Header.tsx` | top bar, nav, the two icon buttons |
| `components/SettingsModal.tsx` | the five-pane settings dialog |
| `components/ThemeToggle.tsx` | the light/system/dark segmented control |
| `lib/theme.ts` | theme mode, palette, accent, and the chart colours |
| `components/Board.tsx` | squares, pieces, highlights, quality badge |
| `components/GameAnalysis/AnalysisScreen.tsx` | all analysis state, board/eval-bar layout |
| `components/GameAnalysis/MoveList.tsx` | move table, nav buttons, the analysis buttons |
| `components/GameAnalysis/EvalChart.tsx` | eval plot + live engine lines |
| `components/GameAnalysis/EloSweepPanel.tsx` | sweep estimates and the match-rate curve |
| `components/GameAnalysis/GameLibraryPanel.tsx` | right-hand library rail |
| `components/Dashboard/ProgressScreen.tsx` | strength, trend, move-quality pie |
| `components/InfoPopover.tsx` | the `i`-in-a-circle popover |
| `lib/api.ts` | every `/api` call, typed |
| `lib/useAnalysisJob.ts` | job start/cancel/attach over `/ws/analysis/{id}` |
| `lib/useLiveEval.ts` | `/ws/live-eval` session |
| `lib/quality.ts` | the classification → colour/symbol table |
| `lib/chess.ts` | PGN parsing, FEN walking, eval formatting |

Assets that already exist on disk and are not yet used:

- `assets/icons/classification/*.svg` — **all ten**, named exactly for the
  backend's classification labels (`best`, `blunder`, `book`, `brilliant`,
  `excellent`, `good`, `great`, `inaccuracy`, `miss`, `mistake`). No new art
  is needed for the icon work below.
- `assets/boards/*.png` — ~20 board images, served at `/assets/boards/{name}.png`
  and listed by `GET /api/board-images`.
- `assets/sets/{name}/{w,b}{k,q,r,b,n,p}.png` — piece sets, listed by
  `GET /api/asset-sets` with `has_board` / `has_pieces` flags.
- `assets/audio/*.{mp3,webm}` — currently one flat directory, no sets.

---

## A. Global: header, theming, settings

### A1. The signed-in account isn't editable — **done**

Both are in the settings dialog's **Account** pane: rename (display name and
username together, one `PATCH`) and delete, behind a confirmation that names
what goes with it — the game, analysis and puzzle counts come from
`GET /api/auth/accounts`. Deleting the account you are signed into logs you
out server-side, so the app drops the user it was holding and falls back to the
picker.

The rename reports what it moved. `reassign_your_colors` returns
`{changed, assigned, unassigned}` rather than a count, and the panel says which:
"13 games re-matched: 13 now yours, 0 left unassigned" is the answer to "did
that fix my library", where a bare "13" is not.

### A2. No light/dark selector — **done**

Was: the UI was hard-coded dark, every component carrying literal
`bg-stone-900`, `text-stone-100` and so on, with no theme state anywhere.

The palette now lives in `index.css` as `--er-*` custom properties, in two
blocks — `:root, [data-theme='dark']` and `[data-theme='light']` — mapped into
utilities by an `@theme inline` block, so `--color-surface` gives `bg-surface`,
`text-surface`, `border-surface`. No component names a Tailwind palette shade
any more; the three exceptions are deliberate and commented where they sit:

- the board's own squares, coordinates and fallback glyphs (`Board.tsx`), which
  read against the board art rather than the page,
- the eval bar, which is white-vs-black by definition and holds
  `--er-eval-white` / `--er-eval-black` in both themes (B2 restyles it),
- `lib/quality.ts`, whose badge colours mean a classification, not a surface.

`lib/theme.ts` owns the mode (`light` / `dark` / `system`), persists it to
`localStorage` under `engine-room:theme`, follows the OS while on `system`, and
is applied in `main.tsx` *before* the first render so a light-theme user never
gets a frame of dark. The selector is the three-way toggle at the top of the
settings dialog; it sits outside the dialog's `draft` check, so the theme is
still reachable when the engine settings fail to load.

Recharts takes colours as props rather than classes, so `useChartTheme()` reads
the chart tokens back off `<html>` and re-reads them when `data-theme` changes.
That keeps one definition of every colour in `index.css`.

Palettes and the accent choice landed with A6a, as `data-palette` and
`data-accent` blocks alongside these. The secondary accent B15 wants is
`--er-accent-2`, and every accent defines one.

### A3–A6. Settings dialog needs a left-hand sub-menu — **done**

Five panes, in the order listed: **Theme** (the default), **Analysis engine**,
**Maia engine**, **Board & pieces**, **Account**. The rail is a column on a
desktop and a horizontal scroller on a phone, where 12rem of sub-menu would
have taken half the width.

The backend constraint is respected: one `EngineSettings` draft object is
shared by every pane and sent in a single `PUT`, and the profile fields are
collected into one patch alongside it. Nothing PUTs per pane.

Theme, palette and accent are deliberately outside that: they are browser
settings the server never sees, and they apply on click rather than on Save,
because the point of picking a colour is watching it land. The footer says so.

**Board & pieces** holds the global board, piece set and legal-move toggle for
now; A7's per-screen overrides and B11's sound sets slot into that pane when
their schema exists.

### A6a. Theme content — **done**

Three palettes — **Stone** (warm, the default), **Slate** (cool), **Graphite**
(neutral) — each defined for both light and dark, and five accents — **Amber**
(the default, unchanged), Sky, Emerald, Violet, Rose. They are two independent
choices: `data-palette` sets only neutral tokens and `data-accent` only accent
ones, so no combination can leave a token undefined.

Each accent carries its own **secondary** (`--er-accent-2`), which is what B15
and the second chart series read. It travels with the accent rather than being
a third picker, because the pair has to stay distinguishable — a secondary
chosen freely could land one hue away from the primary and make two chart
series look like one.

Palette swatches are split chips: a panel colour against a text colour from the
same ramp. Three dark circles would have been three identical dots — what
separates these ramps is temperature, which only shows when two values from one
of them sit against each other.

### A7. Global board/piece/audio defaults, overridable per screen

Right now `user.board_set` / `user.piece_set` are global and there is no
per-screen override at all. Wanted: a global default, overridden
independently on Game Analysis, Puzzles and Play vs Maia — a different board,
piece set and sound set per screen.

The backend today stores exactly one `board_set` / `piece_set` / `asset_set`
per user (`auth.USER_FIELDS`, `PUT /api/settings/profile`), so **this needs a
schema change** — either three more columns per screen or a small
`screen_prefs` table. Worth designing once with sound sets (B11) included,
since they want the same treatment.

---

## B. Game Analysis

### B1. Last-move highlight paints over the piece — **done**

Real bug, and the cause was specific: in `Board.tsx` the highlight, hint,
selection and target-dot layers are all `position: absolute`, while the piece
`<img>` was static in-flow. Positioned elements paint above non-positioned
siblings in the same stacking context regardless of DOM order, so the piece
ended up behind its own highlight.

The piece — both the `<img>` and the unicode fallback — now carries
`relative z-10`. Two neighbours had to move up with it, because they were only
above the piece by virtue of being positioned at all: the rank/file
coordinates, and the target ring drawn around a capturable piece, both now at
`z-20`. The quality badge was already there.

### B2. Board settings dialog is just the global one

The board button in the analysis header opens the same `SettingsModal`. It
needs its own, containing:

- piece set and board selection (`/api/asset-sets`, `/api/board-images`)
- eval bar placement: vertical-left or horizontal-top. The backend's
  `eval_bar_side` already accepts `{top, left, right}`, so no schema work.
- eval bar restyle: **borderless**, primary-accent vs black rather than
  white vs black, with a slight gradient at the dividing line instead of a
  hard edge.
- sound set (B11)

### B3–B5. Pieces can't be moved, no variations, no dragging

These are one piece of work, not three.

`AnalysisScreen` passes `interactive={false}` to the board — deliberately,
because there was nowhere to put a move that leaves the mainline. So:

- **Variations** are the blocker. Playing a move that isn't the game's next
  move should branch; the branch should show in the move table, be
  deletable, and be persistable to the database and still deletable after.
  The classic UI has a full move tree already (see the README's variation
  notes and `frontend/js/app.js`) — read how it models the tree before
  designing a second one. Persisting them needs a new table and endpoints;
  nothing stores variations today.
- **Dragging**: pointer-events drag, piece snapping to the cursor centre on
  press, `cursor: grab` over pieces and `grabbing` while held. Currently
  click-to-select-then-click-to-move only.
- **Animation**: pieces teleport. Moves need to tween between squares, which
  means the board must key pieces by identity across renders rather than
  rebuilding the grid from the FEN each time — worth knowing before starting,
  because `Board.tsx` currently does exactly the latter.

### B6–B8. Move-quality icons

Replace the text glyphs in `lib/quality.ts` (`!!`, `?`, `★` …) with the SVGs
in `assets/icons/classification/`. The file names already match the labels
one-to-one, so this is a mapping change, not new art.

- On the board: positioned **on** the top-right corner of the square (i.e.
  straddling it, not inset), **35×35**.
- In the move table: the same icons at **25×25**.

Keep `lib/quality.ts` as the single source — the chart, board and table all
read from it, which is what stops them drifting.

### B9–B10. Audio

Nothing is wired up: the React UI plays no sound at all. The files exist but
sit in one flat `assets/audio/`. To make sets selectable they need
subdirectories — `assets/audio/default/`, `assets/audio/space/`, … — with the
same file names inside each, and a listing endpoint alongside
`/api/asset-sets`.

Moving the existing files into `default/` will break the classic UI's audio
paths unless it's updated in the same change; check `frontend/js/` before
moving anything.

### B11. Nav buttons belong under the board

The four step buttons live at the bottom of `MoveList.tsx`. They should sit
directly beneath the board in `AnalysisScreen.tsx`. Keyboard nav (arrows,
Home/End) is already wired and should keep working.

### B12. Game library table

- Fixed height and internally scrollable. It currently grows with the flex
  column, so a long library pushes the upload controls off-screen.
- Needs a **database selection**. Ambiguous as written — most likely the
  `collections` groups the backend already has (`GET /api/collections`), which
  the panel currently exposes only as a filter dropdown. Confirm before
  building.
- **One bullet in the original request was cut off mid-sentence** ("the game
  library …"). Ask before assuming.

### B13. Engine lines must not collapse between moves

`useLiveEval` clears `lines` to `[]` on every new position, so the panel
empties and the card shrinks while Stockfish starts the next search — the
whole column jumps. At minimum reserve the height; ideally keep the previous
lines on screen and swap them for the new ones as they arrive.

The sequence-number machinery to do this properly is already there — the hook
knows which position each `info` belongs to, so it can hold the old set until
the first line of the new one lands rather than clearing on request.

### B14. Sweep card: reveal detail on hover

The estimate cards in `EloSweepPanel.tsx` always show the full list of the
fit's caveats, which is a wall of text. It should appear only when hovering
that player's card.

### B15. Sweep card is missing the calibrated estimate

Wanted on the right of the card, in the theme's **secondary** accent.

**This needs backend work.** `strength._calibrate` (`backend/app/strength.py:346`)
computes exactly this — it takes the opposition's estimate, compares it to
their PGN header ratings, and shifts your estimate by the offset, returning
`your_calibrated` plus a calibrated interval. But it is only called from the
pooled `/api/strength` fit. The per-game path (`sweep_job._estimates`) never
calls it, so `/api/sweep/full` returns no calibrated number.

Also check whether it's meaningful for one game: `_usable_for_calibration`
rejects estimates that aren't firm enough, and a single game against a single
opponent may well fail that test. If it does, the honest answer is to show
why rather than to loosen the check.

---

## C. Progress

### C1. Move "what the fit is unsure about" into an info popover — **done**

Now an `i` beside the **ESTIMATED VS ACTUAL ELO** title; the card at the
bottom is gone. `components/InfoPopover.tsx` is the shared control — click to
open, outside-click or Escape to close, deliberately not hover, because the
content is a paragraph and a panel that vanishes when the pointer crosses a
gap can't be read. C4 uses the same one.

### C2. Configurable time window, snapped to the bucket size — **done**

The screen now sends `window`, and offers it in the unit the buckets are drawn
in: weeks for weekly (4/12/26), months for monthly (3/6/12), years for yearly
(2/5), each plus *All time*. Changing the bucket size snaps the window to one
that bucket has an option for, so "26 weeks" can't survive a switch to a
yearly axis. The panel says what the window actually covered, because
`trend._apply_window` ends it at your most recent analysed game rather than at
today.

While here: the granularity picker offered **Quarterly**, which
`trend.GRANULARITIES` doesn't accept — every press was a 400. It is Yearly
now, which is the third bucket the backend actually has.

### C3. Missing the overall calibrated estimate — **done**

Under the raw estimate in the header card, in the secondary accent, with its
own interval and an `i` explaining where the offset came from. When
`_usable_for_calibration` rejects the fit, the card says which of its reasons
applied rather than showing nothing — the same honesty B15 asks for.

The `Strength['calibration']` type in `lib/api.ts` was a placeholder with the
wrong field names; it is now a discriminated union on `available`, matching
`strength._calibrate`.

### C4–C5. Drop the confidence card — **done**

Gone. The `i` beside **ESTIMATED ELO** now gives the confidence, the
discriminative-position count behind it, and what "discriminative" means. The
freed card is the brilliant-move count, which notes how many games were
quick-analysed — Brilliant can only come out of a swept game, so those
contribute a structural zero.

### C6. Move-quality pie chart, right of the estimate chart — **done**

A donut to the right of the two trend charts, with a legend carrying counts
and percentages. Colours come from `lib/quality.ts`, so a blunder is the same
colour here as on the board and in the move list.

**C5 and C6 both needed a new endpoint**, which is now
`GET /api/move-quality` (`backend/app/move_quality.py`). No current route aggregates
classifications: `/api/strength` and `/api/trend` both work from sweep
matrices and neither touches the `classification` column. The data is all in
`analysis_moves` (`backend/app/db.py:230`) — a `GROUP BY classification` over
the user's latest analysis per game, filtered the same way the strength fit
filters, is enough for both the count and the pie.

It counts *your* moves — `analysis_moves` stores no side, so it is a parity
test against `games.your_color` — over the latest analysis per game, taking
the same `LibraryFilter` the other two do. It also reports `games_swept` and
`games_quick_only`, because a library that is mostly quick analyses reads low
on Great and Brilliant by construction and the count would otherwise look like
a verdict on your play.

### C7. Remember the last-selected granularity — **done**

Both the granularity and the window persist, under
`engine-room:trend-granularity` and `engine-room:trend-window`.

### C8. Split the estimate chart in two — **done**

Two charts, estimated above actual, each with its own y domain. Only the lower
one draws the x axis, since they share it. A series with nothing in the window
says so in place rather than drawing an empty grid.

---

## Suggested order

1. ~~**A2 (theming)** first, and properly. A6, B2's eval-bar restyle and B15's
   secondary accent all depend on a palette existing.~~ **Done** — the tokens
   A6, B2 and B15 were waiting on are in `index.css`.
2. ~~**B1** — a one-line fix, no reason to wait.~~ **Done.**
3. ~~**C1, C4–C8** — the Progress screen is self-contained, and C5/C6 share one
   new endpoint worth writing once.~~ **Done**, and C2 and C3 with them — they
   are the same screen, and leaving them out would have meant touching it
   twice.
4. ~~**A3–A6** — the settings dialog, once there is a theme pane to put in it.~~
   **Done**, with A6a's palettes and A1's account pane in it.
5. **B6–B8, B11, B12, B13, B14** — analysis-screen polish, all independent.
6. **A7 + B9–B10** — per-screen preferences and sound sets together, since
   they want the same storage.
7. **B3–B5** — variations, dragging and animation last. It is the largest item
   by a distance and it changes how `Board.tsx` is structured.

## Needs a decision before starting

- **B12**: what "database selection" means — collections, or something else.
- **B12**: the truncated bullet in the original request.
- **A7**: schema shape for per-screen preferences (extra columns vs. a table).
- **B15**: what to show when one game can't support a calibrated estimate.
