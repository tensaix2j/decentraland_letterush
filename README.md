# LetteRush — Decentraland Game Jam 2026
A fast-paced multiplayer game where you parkour around the world hunting for letters, then use them to build words on a shared board and compete for points.

![](https://github.com/tensaix2j/decentraland_letterush/blob/master/assets/images/navmapThumbnail.jpg?raw=true)


## Scene
A 12×12 parcel (144 parcels, 192 × 192 m) multiplayer world. Four themed parkour
and maze zones scatter letter tiles; A giant 21 × 21 Scrabble like board in the middle
is where you spend them. 

## Rounds
Each round lasts 10 minutes, then everything wipes and a new race starts.


## World layout

Nine 4×4-parcel blocks arranged 3×3. The five gameplay zones form a plus; the
four diagonals are mountain scenery.

```
        x → 0            64           128          192
z 192 ┌────────────┬────────────┬────────────┐
      │ Mountains  │  NORTH     │ Mountains  │
      │            │ Frozen     │            │
      │            │ Peaks      │            │
z 128 ├────────────┼────────────┼────────────┤
      │  WEST      │  CENTER    │  EAST      │
      │ The        │ Main       │ Jungle     │
      │ Foundry    │ Board      │ Maze       │
      │            │ 21×21      │            │
z  64 ├────────────┼────────────┼────────────┤
      │ Mountains  │  SOUTH     │ Mountains  │
      │            │ Desert     │            │
      │            │ Tomb       │            │
z   0 └────────────┴────────────┴────────────┘
```

| Zone | Theme | What's in it |
| --- | --- | --- |
| **CENTER** | Main board | 21×21 board on a raised podium, four stepped pyramids, a 24-pillar glyph ring, one ceremonial gate per zone |
| **EAST** | Jungle | 19×19 braided hedge maze, canopy trees, ruin blocks |
| **WEST** | Industrial | 46-platform spiralling catwalk course, 6 tweened moving platforms, silos, pipe runs, climbable crate stacks |
| **SOUTH** | Egyptian desert | 4-storey tomb tower, a fresh maze per floor, connecting ramps, stepped pyramid roof, obelisks |
| **NORTH** | Ice & snow | 40-step ascending ice-floe course, 8 rotating frozen discs, ice spikes, mountain backdrop |
| **Diagonals** | Mountains | Layered peaks with snowcaps and boulders |

## How to play

1. **Run out** to any of the four zones. Letter tiles spin in place — walk into
   one to pick it up. You can carry 8.
2. **Run back** to the board, tap a bag tile to select it (desktop: **[2]/[3]**
   cycles, **[1]** drops the selected tile), and walk onto roughly the square
   you want. A green pad and light beam mark where it will land; red means no
   legal square is nearby.
3. **Press E** to stage it there. This is NOT a submission yet — it's just a
   preview. Keep staging more tiles from your bag to build out a word.
4. **Press F** to submit the turn. Every word your staged tiles form — checked
   both across and down through each staged cell, same as real Scrabble — has
   to be a real word. If any one of them isn't, the WHOLE turn is rejected and
   every staged tile goes straight back to your bag; nothing is wasted.
   If nothing is staged, **F** instead drops the currently selected bag tile
   back onto the ground for anyone to grab.
5. A successful submit scores every newly-completed word at once. Premium
   squares (DL / TL / DW / TW / centre star) multiply, and words of 7+ letters
   get a +15 bonus.

The target square **snaps to the nearest legal cell** within two squares of where
you stand. Landing precisely on a 2 m square with a touch joystick is not
realistic, so the game finds the nearest legal one for you — it never relaxes the
rules, it only saves you from pixel-hunting.

Rules:

- The first tile of a round must go on the centre star.
- Every tile (staged this turn, or already on the board) must touch another
  tile orthogonally — nothing can float unconnected.
- Staging doesn't touch your bag's underlying state — a tile you've staged is
  still yours until you actually submit, so a rejected turn costs you nothing.
- A given word run only pays out once, even if it's re-formed in a later turn.

## Tile economy

- 50 tiles maximum in existence at any moment — that count includes tiles sitting
  in players' bags. A tile only leaves the count once it is submitted onto the
  board as part of a valid word.
- Every 60 s the host tops the world back up, adding at most 10 tiles per cycle,
  round-robin across the four zones.
- Letters are drawn with standard Scrabble bag frequencies and use standard
  Scrabble letter values.
- Tiles held by a player who disconnects return to the wild after 20 s.

## Multiplayer architecture

Serverless CRDT sync (`syncEntity` from `@dcl/sdk/network`) plus a `MessageBus`
for placement requests.

**Synced entities** (all created once inside `main()`, all with stable sync IDs):

| Sync ID | Entity | Component | Contents |
| --- | --- | --- | --- |
| 1 | round | `RoundState` | round number, round end time, next spawn time |
| 2 | board | `BoardState` | 441 cell letters |
| 3 | scores | `ScoreState` | leaderboard rows + already-scored word runs |
| 100–139 | tile pool | `TileState` + `Transform` | letter, status, holder |

The 40 tiles are a **fixed pool** — entities are never destroyed and recreated,
which sidesteps the `id provided is already in use` failure mode entirely. A tile
in a `FREE` slot is parked at y = −50 and does not count toward the 40.

**Host election.** There is no server, so the player whose address sorts lowest
among everyone in the scene is the host. Every client computes the same answer
independently. The host owns spawning, board writes, scoring, round resets, and
reclaiming abandoned tiles. If the host leaves, the next-lowest address takes
over on the following tick and the synced state carries on untouched.

**Why board writes are host-mediated.** CRDT resolution is last-write-wins per
component, so two players placing in the same frame would lose one write. Clients
send a `sp:place` message instead; the host validates and applies it, and refunds
the tile if the cell was taken in the meantime.

**Pickups are client-written** for responsiveness (you are running at speed), then
re-verified 1.2 s later — if someone else won the race, you get a "someone grabbed
that tile first" toast.

**Visuals never touch synced Transforms.** Each tile's appearance lives on a
local child entity, so the idle spin and bob cost zero network traffic and never
fight the CRDT for ownership.

## Letter tiles

A pure white cube whose six faces are UV-cropped to a single glyph out of
`assets/textures/alphabets.png` — a 512×512 sheet laid out as an 8×8 grid of
64 px cells with **A in the bottom-left**, running left-to-right then upward.
Each cell bakes in the letter's Scrabble value as a subscript, so neither the 3D
tile nor the HUD draws a separate number.

`letterBoxUvs()` in `src/letters.ts` emits **96** floats — `PBMeshRenderer_BoxMesh.uvs`
is "2D × 6 faces × **2 sides** × 4 vertices", so the same cropped quad is repeated
12 times and the tile reads the same letter from any angle, inside and out. Hand
it 48 and the renderer silently falls back to default UVs, painting the whole
sheet onto every face. A 0.0015 inset stops neighbouring glyphs bleeding in
through bilinear filtering.

**The mesh and UI vertex windings differ, deliberately.** Meshes want
bottom-left → bottom-right → top-right → top-left; `PBUiBackground.uvs` is
documented as *"starting from bottom-left vertex clock-wise"*, i.e. bottom-left →
**top-left** → top-right → bottom-right. The two are diagonal transposes of each
other, so using the wrong one renders the glyph rotated and mirrored. Hence the
separate `meshQuad()` and `letterUiUvs()` helpers, and the checks that assert
their second vertices disagree.

## Mobile

The jam is mobile-first, so the phone build is the primary target rather than a
scaled-down desktop one.

**Sizing.** Font sizes are not multiplied by hand. `src/platform.ts` hands the
renderer a small virtual canvas on phones — 720 design px wide against 1920 on
desktop — so the renderer scales the whole layout ~2.7x and everything is legible.
The virtual height comes from the real canvas aspect ratio, so portrait and
landscape both work from one set of numbers. `getPlatform()` returns null for the
first few frames, so the UI renders once with desktop defaults and re-declares the
canvas as soon as the explorer reports what it is.

**Controls.** Every action has an on-screen button — PLACE, DROP, ◀ ▶ selection,
and tappable bag slots. Nothing in the game is reachable by keyboard alone. The
explorer owns the bottom-left joystick and bottom-right action buttons and will
not let a scene move them, so scene controls sit in a centred column and the whole
tree is inset by the renderer-reported `interactableArea` and `screenInsetArea`.

**`borderRadius` is unsupported on mobile**, so the theme sets it to 0 there.

**Performance budget** (`quality()` in `src/platform.ts`):

| | mobile | desktop |
| --- | --- | --- |
| tile spin/bob | 10 Hz | every frame |
| tile pickup scan | 5 Hz | 8 Hz |
| board reconcile | 2 Hz | 4 Hz |
| bag rebuild | ~3 Hz | 5 Hz |
| placement target | 10 Hz | every frame |
| distance culling | 75 m | off |

Key polling stays per-frame on both — throttling that would drop presses.

**Distance culling** (`src/perf.ts`) hides 1,373 of the 1,719 rendered entities
when they are more than 75 m away. This is safe for walkable geometry because
`VisibilityComponent` controls *rendering only* — a hidden platform keeps its
`MeshCollider` and is still solid, which is the same reason an invisible wall is
authored as a collider with no renderer. Landmarks (footprint ≥ 12 m or top ≥ 18 m:
mountains, snow peaks, the pyramid cap, zone floor slabs) are exempt so the
skyline does not pop. On desktop the system unregisters itself after the first
tick.

**Dynamic lights do not render on mobile.** This matters for the Sunken Tomb —
see below.

## Lighting

The sky is pinned to **noon** (43200 s past midnight) in three places, because
they have a precedence order and only the last one covers local preview:
`skyboxConfig.fixedTime` at the top level of `scene.json`, the same key inside
`worldConfiguration` (which outranks it), and a `SkyboxTime` component on
`engine.RootEntity` set in `main()` (which outranks both). Delete the component
call in `src/index.ts` to get the normal day/night cycle back.

A bright sky does nothing for enclosed spaces, so the Sunken Tomb also gets:

- **An emissive lift** on interior surfaces (`INTERIOR_LIFT = 0.55` in
  `tools/gen-world.mjs`), which self-illuminates a material with its own albedo.
  Jungle hedges get a gentler `CORRIDOR_LIFT = 0.22`. Raise these if it is still
  too dark — they are the cheapest lever, since emissive costs no draw calls.
- **23 point lights** — a brazier every few corridors on each storey plus a torch
  at each ramp. The renderer only draws the handful nearest the player, so
  spreading them liberally costs almost nothing.

The order matters: **scene dynamic lights are not rendered on mobile at all**, so
on a phone the braziers contribute nothing and the emissive lift is the only thing
keeping the tomb navigable. It is tuned to be readable with no lights whatsoever;
on desktop the lights sit on top of it. `npm run check` asserts the scene has far
more emissive materials than lights, so a future change cannot quietly make the
interior depend on lighting that half the players will never see.

## Word list

`assets/data/wordlist.txt` is the source of truth — the TWL Scrabble dictionary,
178,691 words of 2–15 letters, one per line. `npm run gen:dict` compiles it into
`src/data/dictionary-data.ts`, front-coded from 1.7 MB down to 560 KB. (The scene
runs in QuickJS and cannot read files at runtime, so the list has to be baked into
the bundle. `assets/data` is in `.dclignore` — it is a build input, not a deployed
asset.)

Encoding: each entry is one UPPERCASE marker character (`'A'` + shared prefix
length with the previous word) followed by that word's lowercase suffix. The two
alphabets are deliberately disjoint so the decoder knows where an entry ends —
a base36 marker would collide, since a shared prefix of 10 encodes as `a`, which
is also a valid suffix character. `gen:dict` round-trips the encoding before
writing and refuses to emit a file that does not decode back to the input.

It decodes once (~36 ms in Node, called eagerly by `preloadDictionary()` during
scene load) into one fixed-width concatenated string per word length, so lookup is
a plain binary search with no `Set` allocation — 10,000 lookups in ~7 ms.

To swap in a different list:

```bash
npm run gen:dict -- assets/data/wordlist.txt --max 15
```

## Project layout

```
assets/
  scene/main.composite     generated — all 1,703 static entities
  textures/alphabets.png   the 8x8 letter sheet
  data/wordlist.txt        source word list (build input, not deployed)
  Models/                  optional GLB props (see npm run fetch:models)
src/
  index.ts                 wiring
  config.ts                sync IDs, tuning constants, message types
  platform.ts              mobile/desktop detection, UI theme, quality budget
  perf.ts                  mobile distance culling
  state.ts                 synced components + the four singletons + tile pool
  players.ts               identity and host election
  host.ts                  authoritative loop
  tiles.ts                 pickup / drop / place, inventory, toasts
  board.ts                 board geometry, Scrabble rules, scoring
  letters.ts               letter values, draw bag, sprite-sheet UVs
  dictionary.ts            lazy front-coded word lookup
  view.ts                  everything rendered from synced state
  ui.tsx                   HUD
  generated/layout.ts      generated — zone constants + tile spawn anchors
tools/
  gen-world.mjs            procedural world generator
  gen-dictionary.mjs       wordlist.txt -> src/data/dictionary-data.ts
  check-logic.mjs          headless checks
  fetch-models.sh          optional GLB downloads
```

`tools/gen-world.mjs` is the single source of truth for layout: it writes both
the composite and `src/generated/layout.ts`, so the two can never drift. Change
`SEED` at the top to reroll every maze and parkour course.

## Deploying

`scene.json` is configured for a Decentraland World. Set your name first:

```json
"worldConfiguration": { "name": "your-name.dcl.eth" }
```

then `npm run deploy -- --target-content https://worlds-content-server.decentraland.org`.

## Tuning

Everything gameplay-facing lives at the top of `src/config.ts`:

```ts
MAX_TILES = 50           // tiles in existence (world + all bags)
MAX_INVENTORY = 8        // per-player carry limit (also the mobile bag row width)
SPAWN_INTERVAL_MS = 60s  // top-up cadence
SPAWN_BATCH = 10         // tiles added per top-up
ROUND_LENGTH_MS = 10min  // round length
PICKUP_RADIUS = 2        // metres — must stay under DROP_DISTANCE
DROP_DISTANCE = 3.2      // metres in front of the player
```

