# Integrating the Jumbotron into Ooga Booga Land

> **Status (2026-09): executed, then superseded in part.** This walkthrough
> describes the original schema_version 1 integration and was carried out.
> Since then the system moved to **schema_version 2**: org-wide multi-repo
> stats (no comments, no contributor/ticker views; org totals → per-repo
> boards → commit/PR/review leaderboards), the site's CSP was opened
> (`connect-src https:`) so the page **does** poll the deployed worker's
> `/v1/stats` every minute for live updates and contribution fireworks, and
> the scheduled snapshot refresh lives in **oogaboogaland**
> (`.github/workflows/refresh-jumbotron.yml`, repo variable
> `OOGATRON_STATS_URL`) — the `snapshot.yml` workflow described in Step 0
> was never built here. The baked `jumbotron-data.js` remains as the initial
> paint. Steps below are kept for the mechanics that still apply (geometry,
> fonts, build wiring).

A step-by-step walkthrough for mounting the oogatron jumbotron on the inner
cliff wall of the island — high on the wall, facing the meadow, stadium-style
(the spot circled in the placement reference: the north wall band above the
cave rim, roughly opposite the default camera).

This is the oogatron spec's "Phase 5". The work happens in
[OogaBoogaX/oogaboogaland](https://github.com/OogaBoogaX/oogaboogaland) and
must follow that repo's `AGENTS.md` to the letter. The constraints that shape
every step below:

- **Vanilla JS only, no modules.** Every file is a classic script IIFE with
  `"use strict"` sharing `window.BL`; the `<script>` tags in `src/index.html`
  are the dependency and build order.
- **Network-free page, strict CSP.** `default-src 'none'`; the build pins
  inline hashes. The jumbotron data must be baked in at build time — the page
  itself never fetches. (Freshness comes from a scheduled CI rebuild, where
  the network is allowed.)
- **No textures.** The renderer draws flat-colored faces with an emissive
  channel — nothing in the world uses a texture. The oogatron WebGL screen
  (`jumbotron/screen.js`, canvas-to-texture) therefore does **not** port;
  the board is re-meshed as native geometry instead (step 4).
- **Agents never run git.** The maintainer commits. `npm test` (build + the
  full headless Chrome suite, ~9 min) must pass before finishing, and new
  behaviour needs its own check.

What ports cleanly from oogatron, and what gets replaced:

| oogatron source | becomes in oogaboogaland | notes |
| --- | --- | --- |
| `jumbotron/data.js` | part of `src/js/jumbotron.js` | parser/ticker logic ports almost verbatim; drop the ES `export`s |
| `jumbotron/views.js` | part of `src/js/jumbotron.js` | the 2D board renderer ports verbatim (it only uses `fillRect`); the identicon can be upgraded to the island's real `BL.lifehash` |
| `jumbotron/screen.js` | **replaced** by native `box()`/`BL.models.merge` geometry | no texture path in the engine |
| `harness/fixtures/stats.json` | `src/js/jumbotron-data.js` | same payload, wrapped as a script that sets `BL.jumbotronData` |

---

## Step 0 — (in oogatron) keep the snapshot fresh

The oogaboogaland rebuild should never need a secret or a personal worker URL.
Point it at the committed snapshot in the **oogatron repo** instead:

```
https://raw.githubusercontent.com/OogaBoogaX/oogatron/rock/harness/fixtures/stats.json
```

Prerequisite in oogatron (one small workflow, not part of this repo yet): a
scheduled `snapshot.yml` that runs `node scripts/snapshot.mjs --url <worker>`
against the deployed worker (URL kept in a repo secret/variable, so it appears
nowhere in either repo's files) and commits `harness/fixtures/stats.json` when
it changed. Daily is plenty for a stats board.

## Step 1 — bake the data in: `src/js/jumbotron-data.js`

A generated, committed file — the island equivalent of the snapshot:

```js
// Generated from oogatron /v1/stats — do not edit by hand.
(() => {
  "use strict";
  window.BL = window.BL || {};
  BL.jumbotronData = /* the stats JSON, verbatim */;
})();
```

Add its `<script>` tag to `src/index.html` (step 5 gives the position). The
page stays network-free: the data is source code by the time it ships.

## Step 2 — port the board: `src/js/jumbotron.js`

One new IIFE exposing `BL.jumbotron`, made from oogatron's `data.js` +
`views.js` with the ES module syntax removed:

- `parseStats(json)`, `deriveTicker`, `displayLabel` — port as-is. The parser
  validates `schema_version === 1` and tolerates unknown fields, so future
  additive API changes cannot break the island.
- The bitmap font, `drawText`, `fitText`, and the four view renderers
  (`totals`, `leaderboard`, `contributor`, `ticker`) — port as-is. They draw
  with nothing but `fillStyle`/`fillRect` on a small offscreen canvas
  (192×108), which is exactly what step 4 consumes.
- Identicons: replace oogatron's spectrum-approximation with the real thing —
  `BL.lifehash.make("contributor:" + login)` returns a 32×32 RGB grid;
  render it where oogatron drew its 8×8 grid. (oogatron chose its identicon
  colors from the LifeHash spectrum precisely so this swap is seamless.)
- Palette stays as oogatron's `DEFAULT_PALETTE` — those values were extracted
  *from* oogaboogaland (paper `#f3efe4`, accent `#d8892b`, matrix green
  `#46ff70`, lab teal `#3fd1c5`, wood/plank/nail tones), so they are already
  the island's own.

Public surface, mirroring oogatron's frozen API where it still applies:

```js
BL.jumbotron = {
  create(opts),          // -> { node, update(t), setView(name, params),
                         //      nextView(), autoRotate(seconds), dispose() }
};
```

## Step 3 — the cabinet, as native geometry

Build the frame with `BL.models` boxes and `merge`, matching the island's own
proportions (these all exist in `hub-models.js` today — copy the ratios, not
new inventions):

- Plank slab cabinet in `PLANK #a9773f`, dark-wood frame rails `WOOD_DK
  #5c4425` at the crate's ratio (frame member ≈ 1/9 of the panel span,
  standing ~0.02 proud), corner nails `#3a2a18` — i.e. a scaled-up cousin of
  `caveSign()`.
- Screen bezel: the lab wall-screen recipe (`SCREEN` in `hub-models.js`):
  `#1d2326` bezel, the lit panel sitting ~0.01 proud, `emissive: 0.9`.
- Since it hangs on the wall, use the cave-sign mounting language (hanging
  bar + hooks) rather than the free-standing legs oogatron's harness shows.

## Step 4 — the screen content, as run-merged emissive quads

The engine precedent for "an image on a surface" is the LifeHash bed linen:
`headquarters-models.js` prints a 32×32 pixel grid by merging same-color runs
into single quads (`fabric()`). Do the same for the board:

1. Render the current view onto the offscreen 2D canvas (step 2) —
   at **96×54** rather than 192×108. The views were designed on a 192×108
   grid, so either render at half scale or keep 192×108 and accept ~2–4× the
   quads; start at 96×54 and only go finer if text reads poorly in-scene.
2. `getImageData()` once per view change, run-merge horizontal same-color
   spans into quads (skip background pixels entirely — the bezel panel behind
   them *is* the background), `emissive` ≈ 0.9 like the lab screens.
3. Rebuild that one node's geometry **only when the board changes**: on the
   auto-rotation tick (every ~6 s) and on tap/poke interactions. A typical
   view is a few hundred quads after merging — negligible against the island.
4. The ticker view animates every frame in oogatron's harness; in-world,
   either drop it from the rotation or step its scroll at ~4 Hz so the
   rebuild stays cheap. Measure with `?debug=1` `stats()` before deciding.

The Canvas-2D fallback (`?canvas2d=1`) needs no extra work: the fallback
renderer draws the same faces.

## Step 5 — wire it into the page

`src/index.html` script order (after everything it uses, before the scene
that places it):

```
... js/hub-models.js  js/lifehash.js  ...
    js/jumbotron-data.js      <— new
    js/jumbotron.js           <— new
... js/scene-hub.js ...
```

## Step 6 — mount it on the inner wall (the red-circle spot)

Placement mechanics, copying the cave-sign pattern in `scene-hub.js`:

1. **Find the bearing.** Open the page with `?debug=1`; `__ooga.island.mouths`
   lists every cave mouth as `{ id, angle, x, z, ry, floorY }`, and
   `__ooga.camera` gives the current view. The circled spot is the wall band
   on the far (north) side of the default view — identify the two mouths it
   sits between and take an angle between theirs (world convention:
   `x = sin(angle) * r`, `z = -cos(angle) * r`, facing `ry = facing(angle)`).
2. **Anchor a node** on the inner wall face at that angle — position it the
   way cave signs are (they sit at `y ≈ 4.5` over their mouth, hung on the
   rock). The jumbotron wants the band *above* the sign line, near the rim
   crest (`y ≈ 6–7` over `floorY`), pitched a few degrees downward toward the
   meadow so it reads from the ground. Scale ≈ 1.6–2× the cave sign — big
   enough to read, not so big it fights the "Ooga Booga Land" sign.
3. Mark it `matrixEmissiveLiving: true` like the cave signs so the screen
   glow participates in the same emissive treatment, and hang a lantern off
   the bracket if it reads too dark at night (dusk-fade like the entrance
   torches).
4. **Register it as a prop** (`addProp`) with a tap tip in `PROP_TIPS`
   (e.g. `"Jumbotron · entropylab on the big screen"`) and an `onTap` that
   calls `nextView()` — every prop worth a reaction answers `onTap`, and the
   `?debug=1` round-trip check enforces it.
5. Check the spot for conflicts: no cave mouth, ladder, or sign bracket at
   that angle band, and confirm the camera-collision guides
   (`wall-apertures.js` / `rock-guides.js`) don't need to know about it — it
   is wall dressing, not walkable geometry.

## Step 7 — the "poke an Ooga" hook

`contributors.js` already maps cavemen to entropylab contributor handles.
In the hub's tap handling, when a tapped caveman resolves to a contributor
login, call:

```js
jumbotron.setView("contributor", { login });
```

and resume `autoRotate` after ~12 s of no interaction. This is the feature
the per-contributor view exists for; it should feel like the crowd putting a
player on the big screen.

## Step 8 — tests (the suite gate)

New behaviour needs a check. Add `test/jumbotron.mjs` following the existing
case style (open with `?debug=1&nosim=1&hour=12`, assert on real interaction,
return plain fields from evaluates — never scene nodes):

- the prop exists in the hub scene at the expected bearing;
- auto-rotation advances the view (compare a cheap board fingerprint, e.g.
  the current view name exposed on `__ooga`);
- tapping the jumbotron changes the view; poking a contributor caveman shows
  their card;
- console stays clean in both renderers (`?canvas2d=1` variant included);
- `BL.jumbotron` parses `BL.jumbotronData` (guards the generated file).

Then run the full `npm test` and fix anything it raises — never weaken a
check.

## Step 9 — build and ship

- `npm run build` regenerates `oogaboogaland.html` (inlines the two new
  scripts, re-pins the CSP hashes). Commit is the **maintainer's** job — per
  AGENTS.md, agents never run git there.
- Freshness: add a scheduled workflow in oogaboogaland (mirroring its
  existing `pages.yml` style) that fetches the snapshot from the oogatron raw
  URL (step 0), rewrites `src/js/jumbotron-data.js`, runs `npm run build`,
  and opens a commit/PR when the data changed. The network use lives entirely
  in CI; the shipped page remains network-free, CSP untouched.

## Field notes (from the working integration in the rules-without-rulers fork)

This plan has now been executed once, in
[rules-without-rulers/oogaboogaland](https://github.com/rules-without-rulers/oogaboogaland).
Lessons that save time on the next pass:

- **Face colors are 0–255**, not 0–1: `models.js` `hexToRgb` returns byte
  values and `gl-renderer.js` normalizes at upload. Screen quads built with
  0–1 colors render as near-black ghosts.
- **The gate prop occupies bearing 0** at (0, −28) on the rim crest — the
  exact center-north spot. The board stands on the crest just west of it at
  (−7, −27, ground 6.25), `ry = atan2(-x, -z)` to face the meadow center,
  scale 2.6.
- **Legibility sets the scale.** At meadow-center distance (~47 units) a
  192×108 board needs scale ≈ 2.6 before the scale-2 digits match the
  cave-sign glyph pixel size (~0.06 world units). Smaller boards read as a
  black rectangle.
- **Skip the scanline tint when meshing** (it shimmers at distance) and set
  `castShadow = false` on the screen geometry so a thousand tiny quads stay
  out of the shadow pass. Pair every screen-geometry swap with
  `renderer.releaseGeometry(old)`.
- **The board sits above the default camera framing**; suite checks should
  `pilot.navigate` up to it before projecting/picking, like the camera tests
  do.
- **Roster names are mostly GitHub handles but not always** (e.g. `bc1gui`
  is a display name in the stats); `showContributor` matches login first,
  then display name, and ignores unknowns.
- Expose the jumbotron API through the hub debug object **and** director.js's
  `__ooga` key list, or the suite can't reach it.

## Order of attack, summarized

1. oogatron: scheduled snapshot-refresh workflow (step 0).
2. oogaboogaland: `jumbotron-data.js` + `jumbotron.js` ports (steps 1–2),
   verified standalone via a temporary `?debug=1` console poke.
3. Cabinet + quad meshing (steps 3–4), tuned with `?debug=1` `stats()`.
4. Wall mount + prop registration at the circled bearing (step 6).
5. Ooga-poke hook (step 7).
6. Suite check + full `npm test` (step 8); build; hand to maintainer (step 9).
