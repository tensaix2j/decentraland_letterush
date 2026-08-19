/**
 * All-time top-15 leaderboard, written directly onto the fortress's own
 * exterior wall — per explicit user decision: no separate monument/panel
 * structure, just text placed at the exact spot they stood and picked
 * in-client (57, 0.5, 81 -> since nudged, see POSITION below), facing the
 * way anyone arriving from the West zone's own gate (east of here) would be
 * looking.
 *
 * ROTATION: a TextShape's local +Z is its "front" — the same axis the
 * Billboard component rotates to face the camera (see ADR-198). 90° read
 * mirrored in-client (confirmed by the user, exactly the failure mode a
 * front/back mix-up produces) — flipped to 270° to match, per their own
 * "rotate 180" report.
 *
 * POSITION: nudged per explicit user feedback after seeing it in-client —
 * pulled toward the wall and raised off the ground so it clears the wall's
 * lighter base "skirt" trim, then walked forward a couple more times
 * (54.7 -> 55.5 on x) once the layout below existed to react to. All
 * first-pass corrections sized off screenshots, not measured — flag it if
 * it still needs to move.
 *
 * RENDERING REWRITE: the original version was a single multi-line monospace
 * TextShape (one string, one entity) with a flat PBR-lit black plane placed
 * behind it to fight "text sometimes looks black" on mobile Godot — a
 * platform this project has already confirmed renders NO dynamic lights
 * (see gen-world.mjs's INTERIOR_LIFT/CORRIDOR_LIFT comments). Two problems
 * with that version, both raised by the user directly: the PBR-lit backing
 * plane was itself still angle-sensitive (a lit material reads differently
 * depending on viewing angle, the same root cause as the text problem it was
 * meant to fix), and layering TextShape's own width/height/fontAutoSize/
 * textWrapping fields onto the single padded-monospace string to try to fit
 * it inside the panel broke rendering outright (collapsed to one oversized
 * line).
 *
 * Replaced with the structure from github.com/dcl-regenesislabs/dead-surge's
 * LeaderboardPanel.ts (user-provided reference, confirmed working and
 * angle-stable in their own game): one small TextShape entity PER cell
 * (title, subtitle, 2 header labels, and rank/name/score for each of the 15
 * rows), each explicitly positioned as a child of a single root entity
 * rather than one block of manually-padded monospace text relying on
 * line-wrapping to line up columns. Column alignment now comes from
 * TAM_MIDDLE_LEFT/RIGHT on each cell instead of padRight/padLeft + a
 * monospace font. The reference also has a background plane rendered with
 * an unlit "basic" material; this project tried that too (mobile only,
 * angle-independent since it ignores scene lighting entirely) but removed
 * it once the per-cell rewrite alone made the text legible — the plane
 * turned out not to be needed.
 *
 * MOBILE GODOT: gets a font-size boost via MOBILE_BOOST, same
 * +15%-on-top-of-the-desktop-bump ratio as before. Branching still needs
 * isMobile() resolved before entities are created (not just read once at
 * call time) — see setupHallOfFame's own comment for why, same reasoning as
 * bgm.ts's platform-poll gate.
 *
 * DATA: fetched from the confirmed endpoint —
 * `${ANALYTICS_HOST}/get_highscores?game_id=GAME_ID&limit=15` — returns
 * `{status, msg, data}`, `data` an array of
 * `{id, username, useraddr, datetime, score, ip, game_id}`. `username`/
 * `score` are what get read; the rest is ignored (explicit privacy
 * constraint — the rest of the fields are confidential).
 *
 * REFRESH: no polling timer, and no guessed flat delay either — index.ts
 * awaits highscore.ts's submitOwnScoreForRound() (a real completion signal)
 * before calling refreshHallOfFame(), so this client's own score is
 * guaranteed landed before the GET fires. GRACE_S below is the honest
 * remainder of an earlier guessed delay, now scoped to just the unobservable
 * gap of OTHER players' independent submissions landing on their own
 * clients, not this client's own timing.
 */

import { engine, Entity, TextAlignMode, TextShape, Transform } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import { getPlatform, isMobile } from '@dcl/sdk/platform'
import { ANALYTICS_HOST, SCENE_ID } from './analytics'

const ROW_COUNT = 15
const HIGHSCORES_URL = `${ANALYTICS_HOST}/get_highscores?game_id=${SCENE_ID}&limit=${ROW_COUNT}`

/** Extra wait, AFTER this client's own submission is confirmed done, purely
 * to give other players' independent submissions a chance too — see this
 * file's REFRESH header comment. Short, since it's now only covering that
 * one unavoidable gap rather than doing all the work. */
const GRACE_S = 2

/** World-space spot on the fortress's own wall — see this file's POSITION
 * header comment for the rounds of correction that got it here. Same
 * position on both platforms — mobile-only position tweaks were tried
 * before and explicitly reverted; only font size and the background plane
 * differ on mobile now. */
const POS = Vector3.create(54.7, 5.5, 81)
const FACE_YAW_DEG = 270

/** Panel footprint in meters — used purely for row/column layout math below,
 * no longer backed by any actual plane geometry (the black backing plane
 * was removed as unneeded once the per-cell rendering rewrite made the text
 * itself legible). First-pass sizing, tuned down twice already off user
 * feedback (started at 5.5x11, now 5.5x7) — flag it if rows still don't fit
 * or spill past where the panel would have been. */
const PANEL_WIDTH = 5.5
const PANEL_HEIGHT = 7

/** Row/column font sizes at desktop scale — same relative proportions as
 * the dead-surge reference (title biggest, header/rows similar), scaled to
 * this project's own established desktop text size (2.2, from the earlier
 * +10% bump) rather than copied verbatim, since DCL's fontSize units aren't
 * literal meters and the reference's own panel is a different size. */
const TITLE_SIZE = 2.04
const SUBTITLE_SIZE = 1.2
const HEADER_SIZE = 1.2
const ROW_SIZE = 1.26
/** Mobile-only multiplier — matches the earlier +15% mobile readability
 * bump, now applied uniformly to every label instead of just the row
 * text. */
const MOBILE_BOOST = 1.15

/** Row layout, top to bottom inside the PANEL_HEIGHT box: title, subtitle,
 * column header, then ROW_COUNT evenly-spaced rows down to near the bottom
 * edge. All first-pass offsets — nudge these, not fontSize, if rows still
 * crowd or spill. */
const TITLE_Y = PANEL_HEIGHT / 2 - 0.6
const SUBTITLE_Y = TITLE_Y - 0.55
const HEADER_Y = SUBTITLE_Y - 0.6
const CONTENT_TOP_Y = HEADER_Y - 0.55
const CONTENT_BOTTOM_Y = -PANEL_HEIGHT / 2 + 0.35
const ROW_GAP = (CONTENT_TOP_Y - CONTENT_BOTTOM_Y) / (ROW_COUNT - 1)

const RANK_X = -PANEL_WIDTH / 2 + 0.4
const NAME_X = -PANEL_WIDTH / 2 + 0.9
const SCORE_X = PANEL_WIDTH / 2 - 0.4

type ScoreRow = { name: string; points: number }

/** `data` rows look like `{id, username, useraddr, datetime, score, ip,
 * game_id}` — only username/score matter here. Still defensive about the
 * types (not just presence) since this is an external response, not
 * something this project controls the shape of. */
function parseRow(raw: unknown): ScoreRow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.username !== 'string' || typeof r.score !== 'number') return null
  return { name: r.username, points: r.score }
}

let boardRoot: Entity | null = null
let nameEntities: Entity[] = []
let scoreEntities: Entity[] = []
let platformPollAccum = 0
/** How often to poll for the platform report while waiting for it to
 * resolve — see createBoard's own comment for why this waits at all. */
const PLATFORM_POLL_S = 0.5

/** MUST be called once from main(). Doesn't create the board entities
 * synchronously — see createBoard(). */
export function setupHallOfFame(): void {
  engine.addSystem(platformPollSystem)
}

/**
 * Waits for the platform report before creating the board, rather than
 * calling isMobile() immediately in setupHallOfFame(). getPlatform() reports
 * null for the first several frames after scene start (same caveat
 * platform.ts's own watchPlatform and bgm.ts's platform gate both work
 * around) — creating entities before then risks baking in the wrong
 * (desktop-default) font size/background on an actual mobile client. Stops
 * polling for good once resolved either way.
 */
function platformPollSystem(dt: number): void {
  if (boardRoot !== null) return
  platformPollAccum += dt
  if (platformPollAccum < PLATFORM_POLL_S) return
  platformPollAccum = 0
  if (getPlatform() === null) return
  createBoard()
}

/** Creates one small TextShape entity, parented to boardRoot, at a local
 * (x, y) offset — the building block every label/row cell in this file is
 * made of. */
function addLabel(x: number, y: number, text: string, fontSize: number, textAlign: TextAlignMode): Entity {
  const e = engine.addEntity()
  Transform.create(e, {
    parent: boardRoot!,
    position: Vector3.create(x, y, 0)
  })
  TextShape.create(e, {
    text,
    fontSize,
    textAlign,
    textColor: { r: 1, g: 0.92, b: 0.7, a: 1 },
    outlineColor: { r: 0, g: 0, b: 0 },
    outlineWidth: 0.15
  })
  return e
}

function createBoard(): void {
  const mobile = isMobile()
  const boost = mobile ? MOBILE_BOOST : 1

  boardRoot = engine.addEntity()
  Transform.create(boardRoot, {
    position: POS,
    rotation: Quaternion.fromEulerDegrees(0, FACE_YAW_DEG, 0)
  })

  addLabel(0, TITLE_Y, 'HALL OF FAME', TITLE_SIZE * boost, TextAlignMode.TAM_MIDDLE_CENTER)
  addLabel(0, SUBTITLE_Y, 'TOP 15 · ALL TIME', SUBTITLE_SIZE * boost, TextAlignMode.TAM_MIDDLE_CENTER)
  addLabel(NAME_X, HEADER_Y, 'PLAYER', HEADER_SIZE * boost, TextAlignMode.TAM_MIDDLE_LEFT)
  addLabel(SCORE_X, HEADER_Y, 'PTS', HEADER_SIZE * boost, TextAlignMode.TAM_MIDDLE_RIGHT)

  nameEntities = []
  scoreEntities = []
  for (let i = 0; i < ROW_COUNT; i++) {
    const y = CONTENT_TOP_Y - i * ROW_GAP
    addLabel(RANK_X, y, `${i + 1}.`, ROW_SIZE * boost, TextAlignMode.TAM_MIDDLE_LEFT)
    nameEntities.push(addLabel(NAME_X, y, '—', ROW_SIZE * boost, TextAlignMode.TAM_MIDDLE_LEFT))
    scoreEntities.push(addLabel(SCORE_X, y, '—', ROW_SIZE * boost, TextAlignMode.TAM_MIDDLE_RIGHT))
  }

  void refresh()
}

/** Waits GRACE_S (letting other players' independent submissions have a
 * shot at landing too), then re-fetches. Call this AFTER awaiting this
 * client's own submitOwnScoreForRound() — see index.ts's MSG_ROUND_END
 * handler, and this file's REFRESH header comment for why. */
export async function refreshHallOfFame(): Promise<void> {
  await delaySeconds(GRACE_S)
  await refresh()
}

/** Promise-based wait, built on the same system+dt pattern used everywhere
 * else in this project for timing (see e.g. host.ts's HOST_TICK_MS
 * accumulator) rather than setTimeout, which nothing here has relied on
 * before now. */
function delaySeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    let remaining = seconds
    const tick = (dt: number): void => {
      remaining -= dt
      if (remaining > 0) return
      engine.removeSystem(tick)
      resolve()
    }
    engine.addSystem(tick)
  })
}

async function refresh(): Promise<void> {
  if (boardRoot === null) return
  try {
    const resp = await fetch(HIGHSCORES_URL)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const body = (await resp.json()) as { status?: number; data?: unknown[] }
    if (!Array.isArray(body.data)) throw new Error('unexpected response shape')
    const rows = body.data.map(parseRow).filter((r): r is ScoreRow => r !== null)
    for (let i = 0; i < ROW_COUNT; i++) {
      const row = rows[i]
      TextShape.getMutable(nameEntities[i]).text = row ? row.name : '—'
      TextShape.getMutable(scoreEntities[i]).text = row ? String(row.points) : '—'
    }
  } catch (err) {
    // Backend's reachable and confirmed working (get_highscores returns
    // {status,msg,data} today) — a failure here is a real network hiccup or a
    // response-shape change, not "endpoint doesn't exist" anymore. Still just
    // logs rather than crashing or leaving garbage text up.
    console.log('[hallOfFame] could not load top scores', err)
  }
}
