/**
 * Visitor tracking against the author's own Vercel-hosted analytics API.
 * Entirely unrelated to gameplay — a one-shot "someone opened this scene"
 * ping, fired once per session.
 */

import { getUserData } from '~system/UserIdentity'

/** Exported so other modules hitting the same backend (e.g. hallOfFame.ts's
 * all-time top-scores fetch, highscore.ts's submissions) share one source of
 * truth for the host and the scene/game id. */
export const ANALYTICS_HOST = 'https://myvercel-puce.vercel.app/api'
/** Identifies THIS scene to the shared analytics backend across game jams —
 * same id space for visitor tracking (scene_id) and highscores (game_id). */
export const SCENE_ID = 20260811

async function registerVisitor(address: string, displayName: string): Promise<void> {
  const url = `${ANALYTICS_HOST}/insert_visitor`
  const body = {
    useraddr: address.toLowerCase(),
    username: displayName,
    scene_id: SCENE_ID
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then((response) => response.text())
    console.log('sent request to URL', url, 'SUCCESS', resp)
  } catch (err) {
    console.log('error to do', url, body, err)
  }
}

/**
 * MUST be called once from main(). No polling: `~system/UserIdentity`'s
 * `getUserData` is a single async round trip to the platform that resolves
 * exactly once with the local player's identity already attached — so this
 * just awaits that and fires the ping the moment the data is actually ready,
 * rather than guessing when to check via a per-frame system.
 *
 * Deliberately not awaited by main() — this is a fire-and-forget network call
 * that shouldn't hold up scene bootstrap either way.
 */
export async function setupAnalytics(): Promise<void> {
  const { data } = await getUserData({})
  if (!data || !data.userId) return
  await registerVisitor(data.userId, data.displayName || 'Player')
}
