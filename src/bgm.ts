/**
 * Continuous background music, streamed directly from the user's own hosted
 * URL rather than a local file — explicit choice (they're paying to host it
 * there, so a local copy in assets/sounds/ isn't wanted).
 *
 * That means AudioStream, not AudioSource: AudioSource only accepts local
 * file paths, while AudioStream takes a URL directly. The tradeoff is
 * AudioStream has no `loop` field (see audio_stream.proto — just
 * playing/volume/url/spatial), so a one-shot music file played through it
 * finishes once and stops rather than looping the way AudioSource would.
 * bgmLoopSystem below works around that: it watches the stream's MediaState
 * and restarts playback (toggle playing off then on, which re-triggers the
 * URL fetch from the start) once state drops out of MS_PLAYING after having
 * genuinely reached it — i.e. only once the clip has actually finished, not
 * while it's still loading/buffering on the very first connect. There will
 * be a brief gap between loops while it reconnects — a real limitation of
 * streaming a finite file instead of a true loop, not a bug.
 *
 * Reported: plays on desktop Unity, silent on mobile Godot. Nothing in this
 * file is platform-branched, so the divergence is almost certainly outside
 * this code — two likely causes, in order of likelihood:
 *
 * 1. CORS on the R2 bucket. The SDK docs are explicit that the stream's host
 *    "should have CORS policies that permit externally accessing it" —
 *    Cloudflare R2's public r2.dev domain does NOT send
 *    Access-Control-Allow-Origin by default, it has to be configured on the
 *    bucket. Unity's desktop stream loader may not enforce this while the
 *    Godot mobile client's does, which would exactly explain "works on
 *    desktop, silent on mobile." Fix is on the Cloudflare side (R2 bucket →
 *    Settings → CORS Policy → allow origin "*"), not in this file.
 * 2. Mobile OS-level autoplay/user-gesture gating on audio that starts
 *    playing before the player has touched the screen. bgmLoopSystem now
 *    logs every state transition and retries on MS_ERROR — if it's this,
 *    the logs will show it stuck rather than erroring, which points back to
 *    cause 1 or a genuine network failure instead.
 *
 * Can't reproduce mobile Godot from this sandbox, so the fix here is making
 * the failure observable (console logging) and self-healing on transient
 * errors, not a blind guess at the platform bug itself.
 */

import { AudioStream, Entity, MediaState, engine } from '@dcl/sdk/ecs'

const BGM_URL = 'https://pub-bf766ea06d2944ffb279490084a5a4a7.r2.dev/bluesky.mp3'
const BGM_VOLUME = 0.3
/** Cooldown before retrying after MS_ERROR — long enough not to hammer a
 * genuinely-down host, short enough that a transient blip self-heals fast. */
const RETRY_COOLDOWN_MS = 5000

let bgmEntity: Entity | null = null
let everPlayed = false
let lastLoggedState: MediaState | undefined = undefined
let lastRetryAt = 0

// MediaState is a const enum (inlined at compile time), so it can't be
// reverse-indexed like a normal enum for logging — spell the names out.
const MEDIA_STATE_NAME: Record<MediaState, string> = {
  [MediaState.MS_NONE]: 'MS_NONE',
  [MediaState.MS_LOADING]: 'MS_LOADING',
  [MediaState.MS_READY]: 'MS_READY',
  [MediaState.MS_PLAYING]: 'MS_PLAYING',
  [MediaState.MS_PAUSED]: 'MS_PAUSED',
  [MediaState.MS_BUFFERING]: 'MS_BUFFERING',
  [MediaState.MS_SEEKING]: 'MS_SEEKING',
  [MediaState.MS_ERROR]: 'MS_ERROR'
}

/** MUST be called once from main(), same as setupSfx(). */
export function setupBgm(): void {
  bgmEntity = engine.addEntity()
  AudioStream.create(bgmEntity, { url: BGM_URL, playing: true, volume: BGM_VOLUME })
  engine.addSystem(bgmLoopSystem)
}

function bgmLoopSystem(): void {
  if (bgmEntity === null) return
  const state = AudioStream.getAudioState(bgmEntity)?.state

  if (state !== lastLoggedState) {
    // Visible in the client's own dev console on either platform — the one
    // piece of ground truth we don't otherwise have for a mobile-only bug.
    console.log(`[bgm] stream state -> ${state === undefined ? 'undefined' : MEDIA_STATE_NAME[state]}`)
    lastLoggedState = state
  }

  if (state === MediaState.MS_PLAYING) {
    everPlayed = true
    return
  }

  // Stream errored (host unreachable, CORS rejection, bad format, etc.) —
  // retry after a cooldown rather than sitting silently forever.
  if (state === MediaState.MS_ERROR) {
    const now = Date.now()
    if (now - lastRetryAt >= RETRY_COOLDOWN_MS) {
      lastRetryAt = now
      const mut = AudioStream.getMutable(bgmEntity)
      mut.playing = false
      mut.playing = true
    }
    return
  }

  // Only restart once we've actually SEEN it play and it has since dropped to
  // an idle/finished-looking state — not on MS_LOADING/MS_BUFFERING/MS_SEEKING,
  // which are normal transient states during the initial connect or a seek.
  const finished = state === MediaState.MS_READY || state === MediaState.MS_NONE || state === undefined
  if (everPlayed && finished) {
    everPlayed = false
    const mut = AudioStream.getMutable(bgmEntity)
    mut.playing = false
    mut.playing = true
  }
}
