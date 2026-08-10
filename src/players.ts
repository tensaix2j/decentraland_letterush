/**
 * Local identity + host election.
 *
 * There is no server, so one client is deterministically elected "host": the
 * player whose address sorts lowest among everyone currently in the scene. Every
 * client computes the same answer, so exactly one of them runs the authoritative
 * work (spawning tiles, applying placements, resetting rounds). If the host
 * leaves, the next-lowest address takes over on the following tick and the
 * synced state carries on untouched.
 */

import { engine, Entity, PlayerIdentityData, Transform } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { Vector3 } from '@dcl/sdk/math'

let cachedAddress = ''
let cachedName = ''

/** Lower-cased address of the local player. Falls back to a stable guest id. */
export function myAddress(): string {
  if (cachedAddress) return cachedAddress
  const me = getPlayer()
  if (me && me.userId) cachedAddress = me.userId.toLowerCase()
  return cachedAddress
}

export function myName(): string {
  if (cachedName) return cachedName
  const me = getPlayer()
  if (me && me.name) cachedName = me.name
  return cachedName || 'Player'
}

/** Every address currently in the scene, including the local player. */
export function connectedAddresses(): string[] {
  const out: string[] = []
  for (const [, data] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (data.address) out.push(data.address.toLowerCase())
  }
  const mine = myAddress()
  if (mine && out.indexOf(mine) === -1) out.push(mine)
  return out
}

/** The elected host address, or '' if identity is not resolved yet. */
export function hostAddress(): string {
  const all = connectedAddresses()
  if (!all.length) return ''
  let lowest = all[0]
  for (const a of all) if (a < lowest) lowest = a
  return lowest
}

export function isHost(): boolean {
  const mine = myAddress()
  return !!mine && hostAddress() === mine
}

/** World position of the local avatar, or null before the engine reports one. */
export function myPosition(): Vector3 | null {
  const t = Transform.getOrNull(engine.PlayerEntity as Entity)
  return t ? t.position : null
}
