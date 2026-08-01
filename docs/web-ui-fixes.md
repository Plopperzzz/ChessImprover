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
| `App.tsx` | auth gate, screen routing, settings modal wiring |
| `components/Header.tsx` | top bar, nav, the two icon buttons |
| `components/SettingsModal.tsx` | the single flat settings dialog |
| `components/Board.tsx` | squares, pieces, highlights, quality badge |
| `components/GameAnalysis/AnalysisScreen.tsx` | all analysis state, board/eval-bar layout |
| `components/GameAnalysis/MoveList.tsx` | move table, nav buttons, the analysis buttons |
| `components/GameAnalysis/EvalChart.tsx` | eval plot + live engine lines |
| `components/GameAnalysis/EloSweepPanel.tsx` | sweep estimates and the match-rate curve |
| `components/GameAnalysis/GameLibraryPanel.tsx` | right-hand library rail |
| `components/Dashboard/ProgressScreen.tsx` | strength + trend |
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

### A1. The signed-in account isn't editable

The header shows `display_name` and nothing more. The backend already has
`PATCH /api/auth/accounts/{id}` (rename, which also re-matches every game's
`your_color` against the new names) and `DELETE /api/auth/accounts/{id}`.
The classic UI exposes both from its login screen; the React one exposes
neither. `lib/api.ts` has no wrapper for either yet.

Renaming is not cosmetic here — it is the documented fix for a library that
imported as `unassigned`, so it needs to be reachable.

### A2. No light/dark selector

The UI is hard-coded dark: every component carries literal `bg-stone-900`,
`text-stone-100` and so on. There is no theme state anywhere, and the
uploaded design's three-way toggle was dropped when the mock was rebuilt.

This one is structural, not a toggle to bolt on. Doing it properly means
moving the palette into CSS custom properties on `:root` (Tailwind v4 reads
them via `@theme`), and rewriting the literal colour classes to reference
them. Every other theming item below depends on this landing first, so it's
worth doing carefully rather than twice.

### A3–A6. Settings dialog needs a left-hand sub-menu

`SettingsModal.tsx` is one flat scroll with three `<section>`s. It should be a
two-pane dialog — sub-menu on the left, panel on the right — with:

- **Theme** (the default pane)
- **Analysis engine** — the Stockfish half of the settings row
- **Maia engine** — the Maia half, including the Elo sweep grid
- **Board & pieces** — see A7
- **Account** — A1

Note the backend constraint: `PUT /api/settings` takes the **whole**
`EngineSettings` model and resets any field left out. Splitting one dialog
into several panes must not turn into several partial PUTs. `api.saveSettings`
already documents this; keep a single draft object across all panes and send it
once.

### A6a. Theme content

- Predefined palettes, each defined for both light and dark, rather than free
  colour pickers.
- A separate accent-colour choice within the palette. **Keep the current
  amber/orange as the default** — it's the look the user asked to preserve.
- A *secondary* accent is also needed, because item B12 calls for it.

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

### B1. Last-move highlight paints over the piece

Real bug, and the cause is specific: in `Board.tsx` the highlight, hint,
selection and target-dot layers are all `position: absolute`, while the piece
`<img>` is static in-flow. Positioned elements paint above non-positioned
siblings in the same stacking context regardless of DOM order, so the piece
ends up behind its own highlight.

Fix: give the piece `relative z-10` (and keep the quality badge above it at
`z-20`, which it already is).

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

### C1. Move "what the fit is unsure about" into an info popover

Currently a card at the bottom. Should be an `i`-in-a-circle next to the
**ESTIMATED VS ACTUAL ELO** chart title, opening a popover.

### C2. Configurable time window, snapped to the bucket size

`/api/trend` already takes a `window` parameter spelled as a count and unit
(`8w`, `6m`, `2y`, or `all`) — see `trend.get_trend`. The React screen never
sends it. The picker should offer windows that make sense for the chosen
granularity (last 5 days / last 4 weeks / last 4 months), not a fixed list.

### C3. Missing the overall calibrated estimate

Unlike B15, **this one needs no backend work**: `/api/strength` already
returns a `calibration` object with `your_calibrated`,
`your_calibrated_low/high`, `field_actual` and `offset`.

Note the `Strength['calibration']` type in `lib/api.ts` is currently a
placeholder with the wrong field names — fix it against `strength._calibrate`
rather than trusting it.

### C4–C5. Drop the confidence card

- Remove it. Fold a concise explanation of confidence into an info `i` beside
  the **ESTIMATED ELO** header, aligned above the estimate itself.
- Replace the freed card with a **brilliant move count**.

### C6. Move-quality pie chart, right of the estimate chart

**C5 and C6 both need a new endpoint.** No current route aggregates
classifications: `/api/strength` and `/api/trend` both work from sweep
matrices and neither touches the `classification` column. The data is all in
`analysis_moves` (`backend/app/db.py:230`) — a `GROUP BY classification` over
the user's latest analysis per game, filtered the same way the strength fit
filters, is enough for both the count and the pie.

Filter it through the same `LibraryFilter` the other two use, or the pie will
describe a different set of games than the number beside it.

### C7. Remember the last-selected granularity

`ProgressScreen` resets to `month` on every mount. Persist the choice the way
`App.tsx` persists the current screen in `localStorage`.

### C8. Split the estimate chart in two

Estimated Elo on top, actual Elo below, stacked vertically with independent
scales. They're on one axis today, which flattens whichever has the smaller
range.

---

## Suggested order

1. **A2 (theming)** first, and properly. A6, B2's eval-bar restyle and B15's
   secondary accent all depend on a palette existing.
2. **B1** — a one-line fix, no reason to wait.
3. **C1, C4–C8** — the Progress screen is self-contained, and C5/C6 share one
   new endpoint worth writing once.
4. **A3–A6** — the settings dialog, once there is a theme pane to put in it.
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
