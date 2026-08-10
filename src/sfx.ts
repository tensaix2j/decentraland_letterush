/**
 * One-shot UI/feedback sound effects.
 *
 * Each clip gets ONE dedicated entity with `AudioSource.global = true`, which
 * plays at constant volume regardless of the entity's Transform — right for a
 * feedback sound, which should always be audible rather than fall off with
 * distance from some arbitrary anchor point.
 *
 * Retriggering is done via `currentTime: 0`, not by toggling `playing`. Per
 * the AudioSource docs: setting `playing = true` while a clip is ALREADY
 * playing and `currentTime` is left unset is a no-op — the clip just keeps
 * going from wherever it was. Explicitly setting `currentTime` is what forces
 * a restart from the beginning even mid-playback, which is what rapid repeat
 * taps (spamming the bag, placing tiles back-to-back) need.
 */

import { AudioSource, Entity, Transform, engine } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'

const CLIP_PLACE = 'assets/sounds/plop.mp3'
const CLIP_SELECT = 'assets/sounds/buttonclick.mp3'
const CLIP_PICKUP = 'assets/sounds/ding.mp3'
const CLIP_ACCEPTED = 'assets/sounds/correct.mp3'
const CLIP_REJECTED = 'assets/sounds/denied.mp3'
const CLIP_VICTORY = 'assets/sounds/victory.mp3'

type Sfx = { entity: Entity; clip: string }

function makeSfx(clip: string): Sfx {
  const entity = engine.addEntity()
  Transform.create(entity, { position: Vector3.create(0, 0, 0) })
  AudioSource.create(entity, { audioClipUrl: clip, playing: false, loop: false, volume: 1, global: true })
  return { entity, clip }
}

function trigger(sfx: Sfx | null, volume: number): void {
  if (!sfx) return
  AudioSource.createOrReplace(sfx.entity, {
    audioClipUrl: sfx.clip,
    playing: true,
    loop: false,
    volume,
    global: true,
    currentTime: 0
  })
}

let placeSfx: Sfx | null = null
let selectSfx: Sfx | null = null
let pickupSfx: Sfx | null = null
let acceptedSfx: Sfx | null = null
let rejectedSfx: Sfx | null = null
let victorySfx: Sfx | null = null

/** MUST be called once from main(), same as the other setup*() calls. */
export function setupSfx(): void {
  placeSfx = makeSfx(CLIP_PLACE)
  selectSfx = makeSfx(CLIP_SELECT)
  pickupSfx = makeSfx(CLIP_PICKUP)
  acceptedSfx = makeSfx(CLIP_ACCEPTED)
  rejectedSfx = makeSfx(CLIP_REJECTED)
  victorySfx = makeSfx(CLIP_VICTORY)
}

/** A tile has just been placed onto the board. */
export function playPlaceSound(): void {
  trigger(placeSfx, 0.8)
}

/** A bag slot was tapped/selected (mobile tap or desktop [1]/[2] cycle). */
export function playSelectSound(): void {
  trigger(selectSfx, 0.5)
}

/** A loose tile was scooped up off the ground. */
export function playPickupSound(): void {
  trigger(pickupSfx, 0.7)
}

/** Our submitted word was accepted and has landed on the board. */
export function playAcceptedSound(): void {
  trigger(acceptedSfx, 0.9)
}

/** Our submission was turned down — locally or by the host. */
export function playRejectedSound(): void {
  trigger(rejectedSfx, 0.8)
}

/** The round clock ran out and the winner is being announced. */
export function playVictorySound(): void {
  trigger(victorySfx, 1)
}
