/**
 * Continuous background music — platform-branched implementation.
 *
 * Desktop Unity: AudioStream off a Cloudflare R2-hosted URL. This is the
 * ORIGINAL approach, restored — it played fine on desktop from the start.
 * AudioStream has no `loop` field (just playing/volume/url/spatial — see
 * audio_stream.proto), so bgmLoopSystem below watches the stream's
 * MediaState and restarts playback once it's actually finished (not while
 * still loading/buffering), plus retries after a cooldown on MS_ERROR.
 *
 * Mobile Godot: AudioSource off a local file at assets/Audio/apalonbeats.mp3.
 * AudioStream (the R2 URL) played on desktop but stayed silent on mobile —
 * most likely a CORS/streaming limitation specific to Godot's stream loader,
 * never fully confirmed since it can't be reproduced from this sandbox. Local
 * AudioSource sidesteps that class of problem entirely and mobile has been
 * confirmed working, so per explicit request this path is untouched.
 *
 * Tried making mobile's approach (AudioSource + local file) the ONLY
 * implementation for both platforms, since it's the simpler one component-
 * wise — but that broke desktop: setting `playing: true` on AudioSource
 * before the clip had necessarily finished loading left desktop Unity
 * silent, even after deferring the start by ~0.5s. Rather than keep chasing
 * a desktop-specific AudioSource timing bug, this reverts desktop to the
 * AudioStream implementation that was already proven to work there, and
 * keeps AudioSource only where it's proven to work (mobile). Two code paths,
 * but each one matches what's actually been confirmed on that platform.
 */

import { AudioSource, AudioStream, Entity, MediaState, engine } from '@dcl/sdk/ecs'
import { watchPlatform } from './platform'

const BGM_URL = 'https://pub-bf766ea06d2944ffb279490084a5a4a7.r2.dev/apalonbeats.mp3'
const BGM_CLIP = 'assets/Audio/apalonbeats.mp3'
const BGM_VOLUME_DESKTOP = 0.4
// Mobile device speakers are quieter and usually held further from the ear
// than a desktop setup, and this track was getting lost under footstep/SFX
// noise on Godot — bumped well above desktop's per explicit request.
const BGM_VOLUME_MOBILE = 0.65
/** Cooldown before retrying after MS_ERROR (AudioStream / desktop only) — long
 * enough not to hammer a genuinely-down host, short enough that a transient
 * blip self-heals fast. */
const RETRY_COOLDOWN_MS = 5000

let bgmEntity: Entity | null = null
/** Which component the active entity uses — decides how mute/retry/loop are applied. */
let usingStream = false
/** Session-local only — resets on reload. No persistence layer to save this to. */
let muted = false
/** The platform-appropriate volume to restore to on unmute — starts at the
 * desktop value since isMobile() isn't trustworthy until watchPlatform's
 * first callback (same caveat platform.ts documents for theme()/quality()). */
let baseVolume = BGM_VOLUME_DESKTOP
let started = false

/** MUST be called once from main(), same as setupSfx(). Waits for the
 * platform report (same mechanism ui.tsx's setupUi() uses) before deciding
 * which implementation to create, then only ever runs that one branch for
 * the rest of the session — see the module header for why they differ. */
export function setupBgm(): void {
  watchPlatform((t) => {
    baseVolume = t.mobile ? BGM_VOLUME_MOBILE : BGM_VOLUME_DESKTOP

    if (!started) {
      started = true
      if (t.mobile) {
        bgmEntity = engine.addEntity()
        AudioSource.create(bgmEntity, {
          audioClipUrl: BGM_CLIP,
          playing: true,
          loop: true,
          volume: baseVolume,
          global: true
        })
      } else {
        usingStream = true
        bgmEntity = engine.addEntity()
        AudioStream.create(bgmEntity, { url: BGM_URL, playing: true, volume: baseVolume })
        engine.addSystem(bgmLoopSystem)
      }
      console.log('[bgm] started, mobile =', t.mobile)
      return
    }

    // Later firings (window resize/orientation change) only ever re-apply
    // volume — the branch/entity itself is locked in by `started` above.
    if (bgmEntity !== null && !muted) {
      if (usingStream) AudioStream.getMutable(bgmEntity).volume = baseVolume
      else AudioSource.getMutable(bgmEntity).volume = baseVolume
    }
  })
}

export function isBgmMuted(): boolean {
  return muted
}

/**
 * Mute behaviour differs per component, because they turned out not to be
 * symmetric:
 *
 * - AudioSource (mobile): zeroing `volume` on an already-playing clip takes
 *   effect live, so mute just sets volume to 0 and unmute restores it — the
 *   track keeps advancing silently in between, no restart either way.
 * - AudioStream (desktop): reported not to respond to a live `volume` change
 *   at all while already connected/playing — Unity's stream implementation
 *   most likely only reads volume at connect time, same as this file's
 *   existing loop/retry logic already has to force a full reconnect
 *   (`playing` off then on) to pick up ANY change. So mute instead stops the
 *   stream outright (`playing = false`) and unmute reconnects it from the
 *   start (`playing = true`) — bgmLoopSystem's `muted` check below stops it
 *   from mistaking that manual pause for "the stream finished" and
 *   auto-restarting it out from under the mute.
 */
export function toggleBgmMute(): void {
  if (bgmEntity === null) return
  muted = !muted

  if (usingStream) {
    const mut = AudioStream.getMutable(bgmEntity)
    mut.playing = !muted
    mut.volume = baseVolume
    if (!muted) everPlayed = false // reconnecting from scratch — let it "arrive" at MS_PLAYING again before finish-detection re-arms
  } else {
    AudioSource.getMutable(bgmEntity).volume = muted ? 0 : baseVolume
  }
}

/* ------------------------------------------------------------------ *
 * Desktop-only: AudioStream has no native loop, so this watches MediaState
 * and manually restarts playback once the stream has genuinely finished
 * (not while still connecting/buffering), plus retries after a cooldown on
 * MS_ERROR (host unreachable, CORS rejection, bad format, etc.).
 * ------------------------------------------------------------------ */

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

function bgmLoopSystem(): void {
  if (bgmEntity === null) return
  // While muted, `playing` is deliberately false (see toggleBgmMute) — that
  // looks identical to "the stream finished" from MediaState's own
  // perspective, so this system must stand down entirely rather than
  // "helpfully" restarting playback and undoing the mute.
  if (muted) return
  const state = AudioStream.getAudioState(bgmEntity)?.state

  if (state !== lastLoggedState) {
    console.log(`[bgm] stream state -> ${state === undefined ? 'undefined' : MEDIA_STATE_NAME[state]}`)
    lastLoggedState = state
  }

  if (state === MediaState.MS_PLAYING) {
    everPlayed = true
    return
  }

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
