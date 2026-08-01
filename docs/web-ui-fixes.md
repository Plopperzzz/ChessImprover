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
| `lib/moveTree.ts` | the game as a tree: mainline, branches, saved lines |
| `lib/pieces.ts` | piece identity across positions, which is what animates |
| `lib/sound.ts` | the sounds a board makes |
| `lib/quality.ts` | the classification → icon/colour table |
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
- ~~`assets/audio/*.{mp3,webm}` — currently one flat directory, no sets.~~
  Now `assets/audio/<set>/`, listed by `GET /api/audio-sets`.

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

**Board & pieces** holds the account defaults, A7's per-screen overrides and
the sound settings.

### A6a. Theme content — **done**

Three palettes — **Stone** (warm, the default), **Slate** (cool), **Graphite**
(neutral) — each defined for both light and dark, and five accents — **Amber**
(the default, unchanged), Sky, Emerald, Violet, Rose. They are two independent
choices: `data-palette` sets only neutral tokens and `data-accent` only accent
ones, so no combination can leave a token undefined.

Each accent carries its own **secondary** (`--er-accent-2`), which is what B15
reads. It travels with the accent rather than being a third picker, because
the pair has to stay distinguishable — a secondary chosen freely could land
one hue away from the primary and make two things that mean different things
look like one. It is *not* a chart's second series: D2 draws a plot's line as
a lighter tint of its own dots.

Palette swatches are split chips: a panel colour against a text colour from the
same ramp. Three dark circles would have been three identical dots — what
separates these ramps is temperature, which only shows when two values from one
of them sit against each other.

### A7. Global board/piece/audio defaults, overridable per screen — **done**

A `screen_prefs` table, not nine more columns on `users`. Three screens times
three kinds of asset is nine today, and every screen or asset kind added later
would be another migration on the table that holds accounts. `NULL` means
"follow the default" and is the normal state — a row exists only for a screen
someone has actually overridden, and a row that ends up overriding nothing is
deleted rather than left behind, so *reset* leaves no trace.

`GET /api/settings/screens` returns three things: the account `defaults`, the
per-screen overrides, and the `effective` resolution of the two. Effective is
computed server-side because both front ends draw the same boards, and a
resolution rule that lives in one browser is one the other gets subtly wrong.
`PUT /api/settings/screens/{screen}` takes a patch, where an omitted field
means "leave alone" and `""` means "back to the default" — a distinction the UI
has to be able to make, and the reason it isn't spelled as a JSON null.

The Board & pieces pane is now defaults on top and a screen × kind grid under
it. Puzzles and Play vs Maia are still classic-UI screens, and the preferences
apply there too, since both front ends read them.

`backend/sims/screen_prefs_check.py` covers the absence rules, which are the
part that rots quietly: a screen following the default has to keep following it
when the default changes later.

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

### B3–B5. Pieces can't be moved, no variations, no dragging — **done**

One piece of work, as the item says, and it came apart in the order the item
lists.

**Variations.** `lib/moveTree.ts` is modelled on the classic UI's
`frontend/js/explorer.js` and keeps its two load-bearing rules: `children[0]`
is the move that continues the line, so stepping forward never wanders into a
branch by accident; and `mainline` is fixed when a node is made and never
changes, which is what makes "delete this variation" a safe button — the game
as played can be added to but not edited.

The new part is that lines have identities on the server. A row in `variations`
is a *whole line* rather than a move — one row per line, because a line is what
a person means by "that variation", and because the common case (play four
moves, keep them) is then one insert. `parent_id` is what makes nesting work,
and the self-referencing cascade is what makes deleting a line take its nested
ones with it, which the classic UI does by hand in `deleteVariation`.

Playing a move that is already in the tree navigates to it rather than
branching — otherwise stepping through the game by hand slowly fills the table
with duplicates of itself. Anything else branches and is written immediately: a
variation you have to remember to save is a variation you lose. At the tip of a
saved line the move extends that row; anywhere else it starts a new one.

Every line is replayed server-side before it is stored, and a line that doesn't
play out is refused with the move that failed. A stored variation that cannot
be reached is worse than none: months later it is indistinguishable from a bug
in the board.

**Dragging.** Pointer events, the piece following the cursor's centre,
`cursor: grab` over a piece you can move and `grabbing` while held. A press
that doesn't travel is still a click, so click-to-move works through the same
handlers. Promotion is asked rather than assumed — chess.js reports four moves
to the same square, and defaulting to a queen quietly loses games where a
knight was the point.

**Animation.** The board no longer rebuilds its grid from the FEN. The squares
are a grid; the pieces are a layer of positioned elements above it, each with
an identity carried between positions by `lib/pieces.ts` — matching by square,
by the move that was played, and by the rook a castling king drags along with
it. A promotion keeps the piece's identity and changes its type, so the pawn
*becomes* a queen instead of one vanishing as another appears. Because the
element survives, moving it is a change of coordinates, and the tween is CSS's
problem. Jumping to an arbitrary ply deliberately passes no move, so unrelated
positions snap rather than sliding pieces along paths they never took.

### B6–B8. Move-quality icons — **done**

`lib/quality.ts` now carries an `icon` per classification, derived from the
label because the file names match one-to-one. The board draws it at 35×35
centred **on** the square's top-right corner, the move table at 25×25, and the
per-side summary at 16×16 beside its count.

Two things worth knowing:

- **At the board's edges the icon tucks inside.** The board clips to its
  rounded border, so an icon straddling the top rank or the h file would be
  sliced in half; those two edges hold it in instead. Everywhere else it
  straddles as asked.
- **35px is capped at 52% of a square.** On a phone-sized board 35px spans
  most of three squares.

The colours in `quality.ts` were re-taken from the icons' own fills, so the
chart dots and the Progress pie now match the icon beside them rather than
being a second opinion about what colour a blunder is. The Tailwind `badge`
classes are gone — nothing rendered them once the icons landed.

### B9–B10. Audio — **done**

The files moved into `assets/audio/default/` (moved, not copied — it is the
same set), `GET /api/audio-sets` lists the subdirectories, and `lib/sound.ts`
plays them. A set has to carry the four board sounds to be offered at all; the
puzzle and clock sounds are optional and fall back to the default set's copies,
so a set can restyle a piece landing without having to ship a puzzle jingle.

The React UI now makes a sound when you step onto a move — read off the SAN, so
a capture, a check, a castle and a promotion each sound like themselves, and a
brilliant move gets its own. Never while an analysis job is running, which
walks a hundred positions and would be unbearable. Mute is the `sound` key in
`localStorage`, which is the one the classic UI already used, so muting in
either UI mutes both.

The classic UI was updated in the same change, as the item asks: it plays from
`assets/audio/<set>/` and follows the account's `sound_set`, so a set chosen in
either front end is heard in both.

### B11. Nav buttons belong under the board — **done**

Moved into `AnalysisScreen`, directly under the board and its name plate.
Keyboard nav is untouched and still works.

### B12. Game library table — **done**

- ~~Fixed height and internally scrollable.~~ **Done.** The cause was one
  level up: `App.tsx` sized the page with `min-h-screen`, so the row holding
  the two columns had no height to divide and both grew instead of scrolling
  inside themselves. It is `h-screen` now, the rail is full height on a
  desktop, and on a phone the panel is a full-screen sheet (D3), which is a
  fixed height for the same reason. The upload controls stay on screen either
  way.
- ~~Needs a **database selection**.~~ **Dropped** — asked, and the group
  dropdown as it stands is what was wanted.
- ~~The bullet cut off mid-sentence.~~ It was **download only the new games
  from chess.com**, which is now the *Get new* button under Upload PGN.

The backend already had the whole of it (`chesscom.import_months`), and the
point of the button is that it doesn't re-download: a month that is over and
already read is not requested at all, everything else is requested
conditionally so an unchanged archive answers 304 with no body, and a game
already held is matched on chess.com's permanent link (`games.external_id`).
Pressing it on an up-to-date library is one archive lookup and one import call
that adds nothing.

The sync loops because the server caps *downloads* per request and hands back
the months it didn't reach — five years of archive is a handful of requests
rather than one that outlives its own timeout. The username defaults to your
display name (it is the name games are matched against already) and is stored
under `cc:username`, the same key the classic UI uses, so the two agree about
who you are.

Month-by-month picking, and re-fetching games deleted from the library, stay
in the classic UI — the rail links across to it.

### B13. Engine lines must not collapse between moves — **done**

Both halves of it. `useLiveEval` no longer clears on request: it tracks which
sequence the lines on screen belong to, holds them while the next search
starts, and replaces them when that search's first `info` arrives — which is
what the sequence number was already there to tell it. The held set is flagged
`stale`, and the panel dims it slightly and says "searching…".

The chart above was also sized by whether there were lines *yet*, so it grew
and shrank between moves; it now keys off whether the engine panel is open.
Before the first search of a session lands, three empty rows hold the space the
lines will take.

### B14. Sweep card: reveal detail on hover — **done**

The card shows a one-line count — "3 things the fit is unsure about" — and the
list itself slides over the card on hover. Done with `group-hover` rather than
state, which gets keyboard focus for free: the card is focusable when it has
caveats, so tabbing to it reveals them too.

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

## D. Second pass: the phone, the ultrawide, and what A–C left behind

A–C were written from a review at one window size. This round is the same
screens looked at on a phone and on a monitor twice as wide as it is tall,
plus four things the earlier passes got subtly wrong.

### D1. Focus leaves the board on every step — **done**

Stepping through a game with the buttons, or clicking a move in the list, left
focus on the control that was pressed. The next Space re-fired it, and on a
phone the browser scrolled to the button rather than to the board that had
just changed. The board wrapper is `tabIndex={-1}` now — out of the tab order,
but able to hold focus — and everything that moves the board puts focus back
on it with `preventScroll`. Keyboard nav is unchanged; it was always a window
listener and never depended on what had focus.

The move list was the other half of it: its "keep the current move in view"
used `scrollIntoView`, which walks up every ancestor, so on a narrow screen it
dragged the page down to the move list. It scrolls its own container and
nothing else now.

### D2. The line in a plot is a lighter tint of its dots — **done**

B15 put the *line* in the secondary accent and the *dots* in the primary,
which read as two quantities on one chart. One hue at two lightnesses instead:
the dots keep the series colour and the line is `lighten()`ed
(`lib/theme.ts`). Applies to both trend charts and to the sweep curve in
`EloSweepPanel`. `--er-accent-2` stays what it was, for the calibrated
estimate and the engine's hint on the board — it is just no longer a chart's
second series.

### D3. The library doesn't collapse properly on a phone — **done**

Collapsed, it became a 44px vertical rail below the board; open, a block you
had to scroll past. Both are desktop shapes. Below `lg` it is a full-screen
sheet with an X, and what's left when it's closed is a floating LIBRARY button
over the board. It opens closed on a phone, since opening over the board would
hide the thing the screen is for. The rail, the column and everything about
the desktop layout are untouched.

### D4. Estimated Elo on every row of the library — **done**

The estimate only appeared on games swept *this session*, because it was
client-side state. `GET /api/games` carries `estimated_elo` now — your side's
number from the sweep, by the same precedence `load_for_game` uses, so a row
and the open game can't disagree. A game with no sweep reports null and the
row draws dashes, which keeps every row the same height and the numbers in a
column. `backend/sims/library_estimates_check.py` covers whose estimate it is
and which sweep it comes from.

### D5. The board is bounded by the short side of the screen — **done**

Half of an ultrawide is far taller than the screen, and the board — being
square — grew to fill it, so the plates and the step buttons ended up below
the fold. The board column is capped at `min(100%, calc(100svh - 15rem))`,
15rem being what the two name plates and the step buttons take. On a phone the
width binds instead and the cap does nothing.

### D6. No eval bar on a phone — **done**

It is 20px of a screen the board wants all of, and with the engine on, the
lines above the board print the same number. Hidden below `lg`; the board
takes the full width.

### D7. Time control filter on the trend — **done**

The same speeds the library filters by, offered from the same facets endpoint,
passed to `/api/trend` — which has always accepted a `LibraryFilter`. Rapid
and bullet are different games and a trend pooled over both is two lines drawn
as one. The filter is on the chart only: the pooled estimate above it is your
strength, not a per-speed figure.

### D8. The delete-variation button is invisible — **done**

It was `opacity-0` until hover, over a 12px icon — hover doesn't exist on a
touch screen, and on a desktop you had to find it by guessing. Always drawn
now, muted, in a 24px target.

### D9. The header gets out of the way on a phone — **done**

It is a sixth of a phone's screen on a page whose point is a board. Below
`lg` it leaves upwards as you scroll down and comes back the moment you scroll
up, as a negative margin of its own measured height so the content moves up
into the space rather than sliding under it. It stopped being `sticky` in the
same change: the app shell doesn't scroll, so sticking meant nothing except
pinning the header in place against exactly this.

Scroll is watched in the capture phase, because every screen scrolls inside
its own panel rather than moving the window and scroll events don't bubble.

### D10. The eval plot goes above the board on a phone — **done**

With the engine lines still at the bottom of it, so the evaluation of the
position and the lines that produced it are the first thing on the screen and
the board is directly under them. The right-hand column is `display: contents`
below `xl`, which is what lets the plot be ordered above the board while the
move list stays below it, without duplicating any of the three panels.

### D11. …and short enough that all four fit at once — **done**

The plot is `h-20` on a phone with the engine open and `h-28` without, against
`h-36`/`h-56` on a desktop, and the card's padding tightens with it. On a
390×844 phone that puts the plot, three engine lines, the board and the step
buttons on screen together once the header has hidden (D9). A phone shorter
than about 700px can't fit all four — the board alone is its full width — and
scrolls instead.

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
5. ~~**B6–B8, B11, B12, B13, B14** — analysis-screen polish, all independent.~~
   **Done.**
6. ~~**A7 + B9–B10** — per-screen preferences and sound sets together, since
   they want the same storage.~~ **Done**, and they did want the same storage:
   `sound_set` is a column beside `board_set`/`piece_set` in both places.
7. ~~**B3–B5** — variations, dragging and animation last. It is the largest item
   by a distance and it changes how `Board.tsx` is structured.~~ **Done**, and
   it did: `Board.tsx` is a square grid with a piece layer over it now.
8. ~~**D1–D11** — a second pass over the same screens at sizes the first review
   never opened them at.~~ **Done.** D3, D6, D9–D11 are one layout between
   them and were done together; D1, D2, D4, D5, D7 and D8 are independent.

## Needs a decision before starting

- ~~**B12**: what "database selection" means~~ — answered: no change wanted.
- ~~**B12**: the truncated bullet~~ — answered: the chess.com "get new games"
  button, now built.
- ~~**A7**: schema shape for per-screen preferences~~ — decided: a
  `screen_prefs` table, for the reasons under A7 above.
- **B15**: what to show when one game can't support a calibrated estimate.
