/**
 * Submits the LOCAL player's own final score to the same Vercel backend
 * hallOfFame.ts reads from, once per round, right when that round ends.
 * Ported from the user-supplied reference (a Godot/JS client method from
 * another one of their games) to this scene's own conventions.
 *
 * Each connected client submits only ITS OWN score, signed with its own
 * identity — not the host submitting on everyone's behalf. MSG_ROUND_END is
 * broadcast to every peer (see host.ts's bus.emit), so every client's own
 * bus.on callback below fires independently and reports for itself, the
 * same shape as the reference implementation (which reads its own local
 * resources["userData"], not some other player's).
 *
 * SCORE TIMING: reading ScoreState live from inside the MSG_ROUND_END
 * handler would race host.ts's startRound(), which resets ScoreState to
 * empty in the same call that emits this message — depending on network
 * timing, a client could see the reset before or after the event. To avoid
 * that, trackSystem below caches this player's own current-round score once
 * a second into `myCurrentScore`, and the round-end handler submits that
 * cached snapshot rather than re-querying possibly-already-reset state.
 *
 * SIGNATURE: submitHighscore() below builds the `signature` field the
 * backend expects, matching the reference implementation's own signing
 * scheme. Worth being clear-eyed about what this actually buys: everything
 * involved ships inside this scene's own compiled bundle, which every
 * player's client downloads and runs — same bundle this project has
 * repeatedly opened directly (bin/index.js) to debug earlier in this
 * session. It's a real speed bump against a casual "curl a fake score in"
 * attempt, not protection against a determined one — worth knowing if this
 * leaderboard needs to hold up under real scrutiny, but not a reason not to
 * still do it (it costs nothing and stops the trivial case).
 *
 * OPEN QUESTION: the reference body includes a `game` field (their example
 * hardcodes "cmaze", a different one of the author's games) with no
 * confirmed value for THIS scene — left as GAME_SLUG below, currently a
 * guess. Flag the right value and it's a one-line fix.
 *
 * This module does NOT decide when to submit — it used to subscribe to
 * MSG_ROUND_END itself, but that meant hallOfFame.ts's refresh had no real
 * signal for "has the submit actually finished," only a guessed flat delay
 * (which can just as easily fire before a slow submission lands as after a
 * fast one). Submission is now a plain exported async function; index.ts
 * (the one file that already wires every setupX(bus) together) awaits it
 * before triggering the refresh — see that file's MSG_ROUND_END handler.
 */

import { engine } from '@dcl/sdk/ecs'
import { getUserData } from '~system/UserIdentity'
import { ANALYTICS_HOST, SCENE_ID } from './analytics'
import { getLeaderboard } from './state'
import { sha256Hex } from './sha256'

const INSERT_HIGHSCORE_URL = `${ANALYTICS_HOST}/insert_highscore`

/** Fixed value the backend's signature check expects — NOT the scene's
 * actual current realm despite the reference implementation naming its
 * variable "reqrealm". See this file's header SIGNATURE note for context. */
const REALM_URL = 'https://play.decentraland.org'

/** Unconfirmed — see this file's header "OPEN QUESTION". */
const GAME_SLUG = 'scrabbleparkour'

/** How often to refresh the cached own-score snapshot. 1s matches this
 * project's other host-tick-adjacent cadences (see HOST_TICK_MS). */
const TRACK_INTERVAL_S = 1

let myAddress: string | null = null
let myCurrentScore = 0
let trackAccum = 0

/** MUST be called once from main() — just starts identity resolution and the
 * own-score tracking system. Submission itself is triggered externally, see
 * submitOwnScoreForRound(). */
export function setupHighscoreSubmission(): void {
  void resolveIdentity()
  engine.addSystem(trackSystem)
}

/**
 * Submits this client's own cached current-round score, if it's worth
 * submitting. Resolves once the attempt is fully done (success OR failure —
 * network errors are caught and logged, never rejected) specifically so a
 * caller can safely `await` this as a real "submission attempt has finished"
 * signal, unlike a guessed delay.
 */
export async function submitOwnScoreForRound(): Promise<void> {
  // Skip submitting a true zero — a player who never picked up or placed a
  // tile that round isn't a meaningful highscore entry, just backend noise.
  if (myCurrentScore <= 0) return
  await submitHighscore(myCurrentScore)
}

async function resolveIdentity(): Promise<void> {
  const { data } = await getUserData({})
  if (data && data.userId) myAddress = data.userId.toLowerCase()
}

function trackSystem(dt: number): void {
  trackAccum += dt
  if (trackAccum < TRACK_INTERVAL_S) return
  trackAccum = 0
  if (myAddress === null) return
  const mine = getLeaderboard().find((row) => row.address.toLowerCase() === myAddress)
  myCurrentScore = mine ? mine.points : 0
}

async function submitHighscore(score: number): Promise<void> {
  const { data } = await getUserData({})
  if (!data || !data.userId) return
  const useraddr = data.userId.toLowerCase()
  const username = data.displayName || 'Player'
  const signature = sha256Hex(useraddr + REALM_URL + score)

  const body = {
    username,
    useraddr,
    score,
    game_id: SCENE_ID,
    game: GAME_SLUG,
    signature,
    realm: REALM_URL
  }
  try {
    const resp = await fetch(INSERT_HIGHSCORE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then((r) => r.text())
    console.log('[highscore] submitted', score, 'SUCCESS', resp)
  } catch (err) {
    console.log('[highscore] submit failed', body, err)
  }
}
