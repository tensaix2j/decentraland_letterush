/**
 * Mobile performance work: distance culling of static scenery.
 *
 * The scene ships ~1,700 authored entities spread over 192 x 192 m, but a player
 * can only ever be in one 64 m zone at a time. On phones everything beyond a
 * radius is hidden.
 *
 * This is safe for walkable geometry because `VisibilityComponent` controls
 * RENDERING ONLY — a hidden platform keeps its `MeshCollider` and is still solid.
 * (That separation is the same reason an invisible wall is authored as a
 * MeshCollider with no MeshRenderer.) So nothing can be culled out from under a
 * player, and in any case the radius is comfortably larger than a zone.
 *
 * Landmarks are exempt. Mountains, snow peaks, the pyramid cap and the big zone
 * floor slabs are meant to be seen from across the world; popping those in and
 * out would be far more distracting than the frames it saves.
 */

import { engine, Entity, MeshRenderer, Transform, VisibilityComponent } from '@dcl/sdk/ecs'
import { getPlatform } from '@dcl/sdk/platform'
import { quality } from './platform'
import { myPosition } from './players'

/** Wide enough to be scenery rather than a prop. */
const LANDMARK_FOOTPRINT = 12
/** Tall enough to be a skyline element. */
const LANDMARK_HEIGHT = 18

type Cullable = { entity: Entity; x: number; z: number; visible: boolean }

let cullable: Cullable[] = []
let landmarks = 0
let started = false

/**
 * Record the static scenery worth culling.
 *
 * MUST be called at the very top of main(): composite entities already exist by
 * then (they load at tick 1), but nothing the scene creates at runtime does — so
 * this never catches a tile, the placement highlight, or a board letter, all of
 * which must stay visible on their own terms.
 */
export function snapshotDecor(): void {
  cullable = []
  landmarks = 0

  for (const [entity] of engine.getEntitiesWith(MeshRenderer)) {
    const t = Transform.getOrNull(entity)
    if (!t) continue

    const footprint = Math.max(t.scale.x, t.scale.z)
    const top = t.position.y + t.scale.y / 2
    if (footprint >= LANDMARK_FOOTPRINT || top >= LANDMARK_HEIGHT) {
      landmarks++
      continue
    }
    cullable.push({ entity, x: t.position.x, z: t.position.z, visible: true })
  }
}

export const cullableCount = (): number => cullable.length
export const landmarkCount = (): number => landmarks

export function setupPerformance(): void {
  let accum = 0

  function performanceSystem(dt: number): void {
    accum += dt
    if (accum < quality().cullInterval) return
    accum = 0

    if (getPlatform() === null) return

    // Desktop renders everything — restore, then stop paying for the check.
    if (quality().cullRadius <= 0) {
      if (started) restoreAll()
      engine.removeSystem(performanceSystem)
      return
    }

    started = true
    cull()
  }

  engine.addSystem(performanceSystem)
}

function cull(): void {
  const pos = myPosition()
  if (!pos) return
  const radius = quality().cullRadius
  const r2 = radius * radius

  for (const item of cullable) {
    const dx = item.x - pos.x
    const dz = item.z - pos.z
    const shouldShow = dx * dx + dz * dz < r2
    // Only write when the state actually flips — a no-op write is still a write.
    if (shouldShow === item.visible) continue
    item.visible = shouldShow
    VisibilityComponent.createOrReplace(item.entity, { visible: shouldShow })
  }
}

function restoreAll(): void {
  for (const item of cullable) {
    if (item.visible) continue
    item.visible = true
    VisibilityComponent.createOrReplace(item.entity, { visible: true })
  }
}
