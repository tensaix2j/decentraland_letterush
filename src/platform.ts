/**
 * Platform detection and UI sizing.
 *
 * This game is mobile-first, so the UI is designed against a SMALL virtual
 * canvas on phones and a large one on desktop. Everything downstream is written
 * in virtual pixels against `theme()`, and the renderer scales that to the real
 * screen — which is a far more reliable way to get readable mobile text than
 * multiplying every font size by hand.
 *
 *   desktop  design width 1920  ->  1x
 *   mobile   design width  720  ->  ~2.7x everything
 *
 * The virtual height is derived from the real canvas aspect ratio, so the layout
 * is correct in portrait and landscape without a second set of numbers.
 */

import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { getPlatform, isMobile } from '@dcl/sdk/platform'

const DESIGN_WIDTH_DESKTOP = 1920
const DESIGN_WIDTH_MOBILE = 720
const FALLBACK_ASPECT = 16 / 9

export type Insets = { top: number; right: number; bottom: number; left: number }

export type Theme = {
  mobile: boolean
  /** Design-space canvas size handed to setUiRenderer. */
  virtualWidth: number
  virtualHeight: number
  /** Areas covered by the explorer's own HUD / the device notch, in design px. */
  insets: Insets
  font: {
    tiny: number
    small: number
    body: number
    title: number
    clock: number
    /** The round-end winner announcement — bigger than everything else on screen. */
    banner: number
  }
  slot: number
  /** Height of a slot in the always-10-wide mobile bag row (width is flex, not fixed). */
  mobileBagSlot: number
  button: { height: number; width: number; font: number }
  panelPad: number
  gap: number
  radius: number
}

/**
 * Per-platform performance budget. Phones get lower system tick rates and
 * distance culling of decorative geometry; desktop runs everything at full rate.
 */
export type Quality = {
  /** Seconds between tile spin/bob updates. 0 = every frame. */
  spinInterval: number
  /** Seconds between loose-tile proximity scans. */
  pickupInterval: number
  /** Seconds between board reconciliation passes. */
  boardInterval: number
  /** Seconds between bag rebuilds. */
  inventoryInterval: number
  /** Seconds between placement-target recalculations. */
  targetInterval: number
  /** Metres beyond which decorative (non-collidable) props are hidden. 0 = never. */
  cullRadius: number
  /** Seconds between culling passes. */
  cullInterval: number
}

const MOBILE_QUALITY: Quality = {
  spinInterval: 0.1,
  pickupInterval: 0.2,
  boardInterval: 0.5,
  inventoryInterval: 0.35,
  targetInterval: 0.1,
  cullRadius: 75,
  cullInterval: 1
}

const DESKTOP_QUALITY: Quality = {
  spinInterval: 0,
  pickupInterval: 0.12,
  boardInterval: 0.25,
  inventoryInterval: 0.2,
  targetInterval: 0,
  cullRadius: 0,
  cullInterval: 2
}

export function quality(): Quality {
  return isMobile() ? MOBILE_QUALITY : DESKTOP_QUALITY
}

let resolved = false
let cached: Theme | null = null

function readCanvas(): { width: number; height: number; insets: Insets } | null {
  const info = UiCanvasInformation.getOrNull(engine.RootEntity)
  if (!info || !info.width || !info.height) return null
  const hud = info.interactableArea
  const safe = info.screenInsetArea
  return {
    width: info.width,
    height: info.height,
    insets: {
      top: (hud ? hud.top : 0) + (safe ? safe.top : 0),
      right: (hud ? hud.right : 0) + (safe ? safe.right : 0),
      bottom: (hud ? hud.bottom : 0) + (safe ? safe.bottom : 0),
      left: (hud ? hud.left : 0) + (safe ? safe.left : 0)
    }
  }
}

/**
 * `UiCanvasInformation.interactableArea`/`screenInsetArea` are supposed to
 * report how much of the screen the explorer's own chrome covers, but this is
 * unreliable across explorer builds — observed returning 0 on a build whose
 * chat/discover/share icons (top-left) and profile/eye icons (top-right)
 * visibly overlapped scene UI pinned at `top: 0`. A percentage-of-height floor
 * is used instead of trusting the reported value alone: fixed-pixel margins
 * would be way too small on a tall portrait phone and way too large on a short
 * landscape window, but "these icons occupy roughly the top N% of the screen"
 * holds reasonably well across aspect ratios.
 */
const MOBILE_TOP_FLOOR_FRACTION = 0.18

function build(): Theme {
  const mobile = isMobile()
  const canvas = readCanvas()
  const designWidth = mobile ? DESIGN_WIDTH_MOBILE : DESIGN_WIDTH_DESKTOP

  const aspect = canvas ? canvas.width / canvas.height : FALLBACK_ASPECT
  const virtualWidth = designWidth
  const virtualHeight = Math.round(designWidth / (aspect || FALLBACK_ASPECT))

  // Canvas insets are reported in real pixels; convert them to design space.
  const toDesign = canvas ? designWidth / canvas.width : 1
  const insets: Insets = canvas
    ? {
        top: Math.round(canvas.insets.top * toDesign),
        right: Math.round(canvas.insets.right * toDesign),
        bottom: Math.round(canvas.insets.bottom * toDesign),
        left: Math.round(canvas.insets.left * toDesign)
      }
    : { top: 0, right: 0, bottom: 0, left: 0 }

  if (mobile) {
    insets.top = Math.max(insets.top, Math.round(virtualHeight * MOBILE_TOP_FLOOR_FRACTION))
  }

  return mobile
    ? {
        mobile: true,
        virtualWidth,
        virtualHeight,
        insets,
        font: { tiny: 15, small: 18, body: 22, title: 24, clock: 46, banner: 64 },
        slot: 82,
        mobileBagSlot: 74,
        button: { height: 92, width: 210, font: 30 },
        panelPad: 14,
        gap: 8,
        radius: 12
      }
    : {
        mobile: false,
        virtualWidth,
        virtualHeight,
        insets,
        font: { tiny: 13, small: 15, body: 18, title: 20, clock: 40, banner: 56 },
        slot: 62,
        mobileBagSlot: 62,
        button: { height: 52, width: 170, font: 20 },
        panelPad: 14,
        gap: 5,
        radius: 10
      }
}

/** Current theme. Safe to call every frame — it only recomputes when it must. */
export function theme(): Theme {
  if (!cached) cached = build()
  return cached
}

export function platformResolved(): boolean {
  return resolved
}

/**
 * Watches for the platform report and for canvas/orientation changes, calling
 * `onChange` whenever the virtual canvas needs re-declaring.
 *
 * getPlatform() is null for the first frames after scene start, so the UI is
 * built once with desktop defaults and re-declared as soon as the explorer says
 * otherwise.
 */
export function watchPlatform(onChange: (t: Theme) => void): void {
  let accum = 0
  let lastSignature = ''

  engine.addSystem((dt: number) => {
    accum += dt
    if (accum < 0.5) return
    accum = 0

    const platform = getPlatform()
    if (platform === null) return
    resolved = true

    const next = build()
    const signature = `${next.mobile}:${next.virtualWidth}:${next.virtualHeight}:${next.insets.top},${next.insets.right},${next.insets.bottom},${next.insets.left}`
    if (signature === lastSignature) return
    lastSignature = signature

    cached = next
    onChange(next)
  })
}
