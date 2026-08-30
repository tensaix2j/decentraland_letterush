/**
 * HUD. Mobile-first: the phone layout is the primary design, desktop is the
 * variant.
 *
 * Sizing is NOT done by multiplying font sizes. `platform.ts` hands the renderer
 * a small virtual canvas on phones (720 design px wide vs 1920 on desktop), so
 * the renderer scales the entire layout ~2.7x and text is legible without a
 * parallel set of numbers. Everything below is written in design pixels.
 *
 * Mobile is deliberately minimal: no custom STAGE/SUBMIT/DROP/arrow buttons.
 * The explorer's own touch HUD already exposes E (IA_PRIMARY, stage a tile on
 * the board) and F (IA_SECONDARY, submit the staged word — or drop the
 * selected bag tile if nothing's staged) as on-screen buttons — the same
 * `inputSystem` polling in tiles.ts drives both, so nothing scene-side needs
 * to duplicate them. The only thing this UI adds on top is a single tappable
 * row of the player's bag, since choosing WHICH tile to place has no other
 * physical control. Status text stays silent unless something needs the
 * player's attention — except while a word is staged, when "press F to
 * submit" takes over the hint line.
 */

import ReactEcs, { Label, PositionUnit, ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { Color4 } from '@dcl/sdk/math'
import { MAX_INVENTORY, TEXTURE_ALPHABET_UI } from './config'
import { getLeaderboard, getRound } from './state'
import {
  activeToasts,
  getHoverReason,
  getHoveredCell,
  getInventory,
  getSelectedIndex,
  getStagedCount,
  getWinnerBanner,
  isAwaitingHost,
  selectSlot
} from './tiles'
import { letterUiUvs } from './letters'
import { isHost, myAddress } from './players'
import { Theme, theme, watchPlatform } from './platform'

const PANEL_BG = Color4.create(0.05, 0.05, 0.08, 0.68)
const ACCENT = Color4.create(0.95, 0.76, 0.27, 1)
const TEXT = Color4.create(0.96, 0.95, 0.92, 1)
const MUTED = Color4.create(0.72, 0.72, 0.76, 1)
const WARN_TEXT = Color4.create(1, 0.55, 0.45, 1)
const SLOT_EMPTY_BORDER = Color4.create(1, 1, 1, 0.16)

function clock(msRemaining: number): string {
  const total = Math.max(0, Math.floor(msRemaining / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

// round.endsAt stays 0 until the host's first startRound() actually runs —
// covers both "still syncing with the server" and the brief window after
// that where a host exists but hasn't started round 1 yet. Shown in place of
// the countdown digits during that window, per explicit user request (was
// just "--:--", which reads as broken rather than "hang on").
const CONNECTING_LABEL = 'Connecting... Pls wait'

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

/**
 * Desktop only now — mobile's round number moved into MobileClock (rendered
 * right next to the countdown, top-centre) and the clock moved out into its
 * own MobileClock component, so mobile no longer calls this at all.
 */
function StatusPanel(props: { t: Theme }) {
  const t = props.t
  const round = getRound()
  const connecting = !round || !round.endsAt
  const remaining = round && round.endsAt ? round.endsAt - Date.now() : 0
  const label = connecting ? CONNECTING_LABEL : clock(remaining)

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 16 + t.insets.top, left: 16 + t.insets.left },
        width: 300,
        height: 'auto',
        flexDirection: 'column',
        padding: t.panelPad,
        borderRadius: t.radius
      }}
      uiBackground={{ color: PANEL_BG }}
    >
      <Label
        value={`ROUND ${round ? round.roundId : '—'}`}
        fontSize={t.font.title}
        color={ACCENT}
        textWrap="nowrap"
        uiTransform={{ width: '100%', height: 24 }}
      />
      <Label
        value={label}
        // Smaller + wrap-capable while connecting: "Connecting... Pls wait"
        // is far too wide to read as one nowrap line at clock-digit size.
        fontSize={connecting ? t.font.small : t.font.clock}
        color={TEXT}
        textWrap={connecting ? 'wrap' : 'nowrap'}
        uiTransform={{ width: '100%', height: connecting ? 56 : 46 }}
      />
      {isHost() ? (
        // Without an explicit width, this leaf had no box to size against and
        // was wrapping "host" onto two lines mid-word ("hos" / "t") — a
        // 4-character string had no business wrapping at all. width: 100%
        // gives it the panel's actual width to lay out against, and nowrap is
        // belt-and-braces so it can't happen again regardless of that.
        <Label
          value="host"
          fontSize={t.font.tiny}
          color={MUTED}
          textWrap="nowrap"
          uiTransform={{ width: '100%', height: 20 }}
        />
      ) : null}
    </UiEntity>
  )
}

/**
 * Mobile-only: the countdown clock plus the round-number chip, standalone and
 * centred top as one unit — the chip sits just to the clock's right, rather
 * than either sharing the old top-left StatusPanel strip or stacking with the
 * leaderboard on the right.
 *
 * Added per explicit user request working around an SDK7 7.26.0 (15 Aug)
 * regression that broke this HUD's mobile Godot layout — desktop Unity was
 * unaffected. positionType 'absolute' takes it out of MobileUi's
 * space-between flow entirely, so it can't be shoved around by the
 * leaderboard/bag rows the way an in-flow element sharing that layout would.
 */
// 0, not t.insets.top: on-device, insets.top is coming back far bigger than
// the 18% floor in platform.ts expects (observed pushing this down to roughly
// a third of the screen height, overlapping the avatar nametag). The avatar/
// system icon cluster lives in the top-left corner only, so this horizontally
// centred element doesn't need any clearance margin from it at all — flush
// against the true top edge of the canvas.
const MOBILE_CLOCK_TOP = 0

/**
 * Small fixed safe-area margins used instead of t.insets.* for MobileUi's
 * space-between column — see that padding's own comment for why insets can't
 * be trusted here.
 */
const MOBILE_TOP_MARGIN = 16
const MOBILE_BOTTOM_MARGIN = 16
const MOBILE_SIDE_MARGIN = 12

function MobileClock(props: { t: Theme }) {
  const t = props.t
  const round = getRound()
  const connecting = !round || !round.endsAt
  const remaining = round && round.endsAt ? round.endsAt - Date.now() : 0
  const label = connecting ? CONNECTING_LABEL : clock(remaining)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: MOBILE_CLOCK_TOP },
        width: '100%',
        // Taller while connecting so the wrapped 2-line message has room —
        // back to the normal single-line clock height once a round exists.
        height: connecting ? 56 : 46,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <OutlinedLabel
        value={label}
        // Smaller + wider + wrap-capable while connecting: "Connecting... Pls
        // wait" doesn't come close to fitting the normal 140px clock-digit box.
        fontSize={connecting ? t.font.tiny : t.font.clock}
        color={TEXT}
        width={connecting ? 260 : 140}
        height={connecting ? 52 : 44}
        textAlign="middle-center"
      />
      {connecting ? null : (
        <UiEntity uiTransform={{ width: 40, height: 40, margin: { left: 4 } }}>
          <OutlinedLabel value={`R${round ? round.roundId : '-'}`} fontSize={t.font.tiny} color={MUTED} textAlign="middle-left" />
        </UiEntity>
      )}
    </UiEntity>
  )
}

// Leaderboard-only text scale — 20% smaller per explicit user request, and
// MOBILE ONLY (desktop's leaderboard was already fine and wasn't part of the
// ask). Scoped to this component rather than the shared theme font sizes
// since tiny/small/body/title are also used by Hint, StatusPanel, Toasts,
// etc. on both platforms.
const LEADERBOARD_TEXT_SCALE = 0.8
function lbFont(t: Theme, n: number): number {
  return t.mobile ? Math.round(n * LEADERBOARD_TEXT_SCALE) : n
}

function Leaderboard(props: { t: Theme }) {
  const t = props.t
  const limit = t.mobile ? 3 : 8
  const rows = getLeaderboard().slice(0, limit)
  const me = myAddress()

  const body =
    rows.length === 0 ? (
      <Label
        value={t.mobile ? 'no words yet' : 'No words yet — be first!'}
        fontSize={lbFont(t, t.font.tiny)}
        color={MUTED}
        uiTransform={{ height: t.mobile ? 22 : 24 }}
      />
    ) : (
      rows.map((row, i) => (
        <UiEntity
          key={row.address}
          uiTransform={{
            width: '100%',
            height: t.mobile ? 26 : 24,
            flexDirection: 'row',
            alignItems: 'center'
          }}
        >
          <Label
            value={`${i + 1}.`}
            fontSize={lbFont(t, t.font.small)}
            color={i === 0 ? ACCENT : MUTED}
            uiTransform={{ width: t.mobile ? 22 : 28, height: '100%' }}
          />
          <Label
            value={row.name.length > (t.mobile ? 9 : 16) ? row.name.slice(0, t.mobile ? 9 : 16) + '…' : row.name}
            fontSize={lbFont(t, t.font.small)}
            color={row.address === me ? ACCENT : TEXT}
            uiTransform={{ width: t.mobile ? 100 : 170, height: '100%' }}
          />
          <Label
            value={`${row.points}`}
            fontSize={lbFont(t, t.font.body)}
            color={TEXT}
            uiTransform={{ width: t.mobile ? 52 : 50, height: '100%' }}
          />
        </UiEntity>
      ))
    )

  if (t.mobile) {
    return (
      <UiEntity
        uiTransform={{
          width: 190,
          flexDirection: 'column',
          padding: { left: 10, right: 10, top: 6, bottom: 6 },
          borderRadius: t.radius
        }}
        uiBackground={{ color: PANEL_BG }}
      >
        {body}
      </UiEntity>
    )
  }

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: 16 + t.insets.top, right: 16 + t.insets.right },
        width: 320,
        height: 60 + Math.max(1, rows.length) * 26,
        flexDirection: 'column',
        padding: t.panelPad,
        borderRadius: t.radius
      }}
      uiBackground={{ color: PANEL_BG }}
    >
      <Label value="LEADERBOARD" fontSize={lbFont(t, t.font.title)} color={ACCENT} uiTransform={{ height: 26 }} />
      {body}
    </UiEntity>
  )
}

/**
 * A filled slot. The sprite sheet already renders each letter's score as a
 * subscript, so this is just the cropped glyph — no overlaid value.
 */
function TileSlot(props: { key?: string; t: Theme; letter: number; index: number; selected: boolean }) {
  const t = props.t
  return (
    <UiEntity
      uiTransform={{
        width: t.slot,
        height: t.slot,
        margin: { left: t.gap, right: t.gap },
        borderRadius: t.radius,
        borderWidth: props.selected ? (t.mobile ? 4 : 3) : 1,
        borderColor: props.selected ? ACCENT : Color4.create(0, 0, 0, 0.6),
        pointerFilter: 'block'
      }}
      // No `color` here on purpose. In DCL UI the background colour is a solid
      // fill painted BEHIND the texture, not a tint on it — so Color4.White()
      // was drawing a hard white square with square corners that ignored
      // borderRadius. The sprite sheet is already black glyphs on a fully
      // transparent background, so dropping the fill leaves just the glyph.
      uiBackground={{
        texture: { src: TEXTURE_ALPHABET_UI },
        textureMode: 'stretch',
        uvs: letterUiUvs(props.letter)
      }}
      onMouseDown={() => selectSlot(props.index)}
    />
  )
}

function Bag(props: { t: Theme }) {
  const t = props.t
  const inventory = getInventory()
  const selected = getSelectedIndex()
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: t.slot + 10,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        flexWrap: 'wrap'
      }}
    >
      {inventory.map((slot, i) => (
        <TileSlot
          key={`${slot.entity}`}
          t={t}
          letter={slot.letter}
          index={i}
          selected={i === selected}
        />
      ))}
    </UiEntity>
  )
}

/**
 * Nudges the whole bag row right, clear of the emote button that now sits in
 * the bottom-right touch cluster alongside E/F/+/jump, per explicit user
 * request. Room to do this opened up when the slots became fixed-size
 * squares below instead of flex-stretched to fill a wide percentage row —
 * the row is narrower now, so it no longer needs to hug the left edge.
 */
const MOBILE_BAG_ROW_SHIFT_RIGHT = 62 // was 36; +26 (~half a slot) per explicit user request

/**
 * Mobile bag: always exactly MAX_INVENTORY slots in one row, so it never
 * reflows or changes width as tiles are picked up — filled slots show the
 * glyph and are tappable; empty ones are just an outline placeholder.
 *
 * Slots are fixed square boxes (t.mobileBagSlot x t.mobileBagSlot) rather
 * than a flex share of a wide percentage-width row — per explicit user
 * request for smaller, squarer tiles. The row itself sizes to its content
 * (width: 'auto') instead of reserving a fixed percentage of the screen, so
 * it naturally stays clear of the explorer's own bottom-right touch cluster
 * without needing a capacity/percentage trick the way the old layout did.
 */
function MobileBagRow(props: { t: Theme }) {
  const t = props.t
  const inventory = getInventory()
  const selected = getSelectedIndex()
  const slots = []
  for (let i = 0; i < MAX_INVENTORY; i++) {
    const slot = inventory[i]
    slots.push(
      <UiEntity
        // Keyed by occupant, not position: a stable `slot-${i}` key made a
        // filled->empty (or filled->different-letter) transition a prop patch
        // on the same node instead of a fresh mount, and the texture/uvs swap
        // didn't reliably take — the slot kept showing the old glyph even
        // though it had already fallen out of `inventory` and stopped being
        // selectable. Forcing a remount on occupant change fixes that.
        key={slot ? `slot-${slot.entity}` : `empty-${i}`}
        uiTransform={{
          width: t.mobileBagSlot,
          height: t.mobileBagSlot,
          margin: { left: 2, right: 2 },
          borderRadius: t.radius,
          borderWidth: slot && i === selected ? 4 : 1,
          borderColor: slot && i === selected ? ACCENT : SLOT_EMPTY_BORDER,
          pointerFilter: slot ? 'block' : 'none'
        }}
        uiBackground={
          slot
            ? {
                // No `color` — see TileSlot: it's a solid fill behind the
                // texture, not a tint, and it was the white square.
                texture: { src: TEXTURE_ALPHABET_UI },
                textureMode: 'stretch',
                uvs: letterUiUvs(slot.letter)
              }
            : undefined
        }
        onMouseDown={slot ? () => selectSlot(i) : undefined}
      />
    )
  }
  return (
    <UiEntity
      uiTransform={{
        width: 'auto',
        height: t.mobileBagSlot,
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: 10, right: 10 },
        margin: { left: MOBILE_BAG_ROW_SHIFT_RIGHT }
      }}
    >
      {slots}
    </UiEntity>
  )
}

/**
 * Tiny control legend under the mobile bag row.
 *
 * Desktop has always shown this (the `[1] drop · [2]/[3] switch · [E] stage ·
 * [F] submit` line in DesktopUi below), but mobile never did — its E/F
 * buttons come from the explorer's own touch HUD, not something this scene
 * draws, so there was nothing here to explain them. That silence reads fine
 * for "E places the tile you've selected," but F silently doing double duty
 * (drop the selected tile if nothing's staged, else submit the staged word)
 * is not discoverable by tapping around — mobile players were reporting they
 * had no idea how to drop a tile. This mirrors the desktop line's content in
 * mobile's own button vocabulary, sized well under t.font.tiny so it fits
 * the sliver of space between the bag row and the explorer's own version
 * string without crowding it.
 */
const MOBILE_HINT_FONT = 9

function MobileControlsHint(props: { t: Theme }) {
  const t = props.t
  return (
    <OutlinedLabel
      value={`BAG ${getInventory().length}/${MAX_INVENTORY}  ·  [E] place  ·  [F] submit  · [1] drop`}
      fontSize={MOBILE_HINT_FONT}
      color={MUTED}
      height={16}
    />
  )
}

/**
 * Text with a hard outline around it.
 *
 * SDK7's 2D UI text has no stroke of any kind — `PBUiText` exposes only
 * colour, font, size, alignment and wrapping. (The 3D `TextShape` component
 * does have outlineColor/outlineWidth, but that's a different component and
 * can't be used in the HUD.) So the outline is faked the old-fashioned way:
 * the same string drawn eight times in black, nudged one design pixel in each
 * direction, with the real fill drawn last so it lands on top.
 *
 * Every copy is absolutely positioned at full width with the same centred
 * alignment, so they stay registered with each other regardless of how long
 * the string is or how wide the screen gets. Offsets are in design pixels, so
 * the renderer scales the outline along with the text (~2.7x on a phone) and
 * it stays proportional.
 */
const OUTLINE = Color4.create(0, 0, 0, 1)
const OUTLINE_OFFSETS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1]
]

function OutlinedLabel(props: {
  value: string
  fontSize: number
  color: Color4
  /** Explicit box, needed when this sits inline in a row rather than filling its parent. */
  width?: PositionUnit
  height?: PositionUnit
  textAlign?: 'middle-left' | 'middle-center' | 'middle-right'
}) {
  const width = props.width === undefined ? '100%' : props.width
  const height = props.height === undefined ? '100%' : props.height
  const textAlign = props.textAlign || 'middle-center'
  return (
    <UiEntity uiTransform={{ width, height }}>
      {OUTLINE_OFFSETS.map(([dx, dy], i) => (
        <Label
          key={`outline-${i}`}
          value={props.value}
          fontSize={props.fontSize}
          color={OUTLINE}
          textAlign={textAlign}
          uiTransform={{
            positionType: 'absolute',
            position: { left: dx, top: dy },
            width: '100%',
            height: '100%'
          }}
        />
      ))}
      <Label
        value={props.value}
        fontSize={props.fontSize}
        color={props.color}
        textAlign={textAlign}
        uiTransform={{ positionType: 'absolute', position: { left: 0, top: 0 }, width: '100%', height: '100%' }}
      />
    </UiEntity>
  )
}

/**
 * A single line of feedback, shown only when the player needs to know
 * something — a word staged and waiting on F, bag empty, or standing
 * somewhere a placement would fail. When everything is fine this renders
 * nothing: the 3D highlight beam already shows a valid target in green, so a
 * persistent "Press E to place" caption would just be repeating what the
 * world is already saying.
 */
function Hint(props: { t: Theme }) {
  const t = props.t
  const cell = getHoveredCell()
  const reason = getHoverReason()
  const inventory = getInventory()
  const staged = getStagedCount()

  let text = ''
  let urgent = false
  if (isAwaitingHost()) {
    text = 'Checking your word…'
    urgent = true
  } else if (staged > 0) {
    text = `Press F to submit (${staged} tile${staged === 1 ? '' : 's'})`
    urgent = true
  } else if (inventory.length === 0) {
    text = 'Find letter tiles in the four themed zones'
  } else if (cell >= 0 && reason) {
    text = reason
  }

  if (!text) return <UiEntity uiTransform={{ width: '100%', height: 0 }} />
  // White fill by default; the urgent/warning states keep their own colour so
  // the meaning still reads at a glance. The black outline goes on all of
  // them — this line sits directly over the 3D world with nothing behind it,
  // so without one it disappears against pale ground or bright sky.
  const fill = urgent ? ACCENT : text === reason ? WARN_TEXT : Color4.White()
  return (
    <UiEntity uiTransform={{ width: '100%', height: t.mobile ? 26 : 24, justifyContent: 'center' }}>
      <OutlinedLabel value={text} fontSize={t.font.small} color={fill} />
    </UiEntity>
  )
}

function Toasts(props: { t: Theme }) {
  const t = props.t
  const toasts = activeToasts()
  const lineHeight = t.mobile ? 26 : 24
  // Reserve no space at all when quiet — an empty banner is still clutter.
  if (!toasts.length) return <UiEntity uiTransform={{ width: '100%', height: 0 }} />
  return (
    <UiEntity
      uiTransform={{
        width: '100%',
        height: toasts.length * lineHeight,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end'
      }}
    >
      {toasts.map((toast, i) => (
        <Label
          key={`${i}-${toast.until}`}
          value={toast.text}
          fontSize={t.font.small}
          color={toast.good ? Color4.create(0.85, 0.95, 0.7, 1) : Color4.create(1, 0.6, 0.5, 1)}
          uiTransform={{ height: lineHeight }}
        />
      ))}
    </UiEntity>
  )
}

/**
 * Big centre-screen announcement of who won the round that just ended.
 * Separate from the small scrolling Toasts — this is meant to be
 * unmissable — and positioned absolutely so it overlays everything else
 * without shoving the rest of the layout around.
 */
function WinnerBanner(props: { t: Theme }) {
  const t = props.t
  const text = getWinnerBanner()
  // Both states MUST be positionType 'absolute', including the hidden one.
  // The mobile layout is a `space-between` column, so an in-flow 0x0
  // placeholder still counts as a third child and space-between redistributes
  // around it — which silently shoved the bag row up into the middle of the
  // screen. Out-of-flow means the banner cannot disturb anything.
  if (!text) return <UiEntity uiTransform={{ positionType: 'absolute', width: 0, height: 0 }} />
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '38%' },
        width: '100%',
        height: 'auto',
        flexDirection: 'column',
        alignItems: 'center'
      }}
    >
      <UiEntity
        uiTransform={{
          padding: { left: 28, right: 28, top: 16, bottom: 16 },
          borderRadius: t.radius,
          alignItems: 'center'
        }}
        uiBackground={{ color: Color4.create(0.05, 0.05, 0.08, 0.82) }}
      >
        <Label value={text} fontSize={t.font.banner} color={ACCENT} />
      </UiEntity>
    </UiEntity>
  )
}

/* ------------------------------------------------------------------ *
 * Layouts
 * ------------------------------------------------------------------ */

/**
 * Phone layout — deliberately minimal. No custom PLACE/DROP/arrow buttons: the
 * explorer's own touch HUD already exposes E (place) and F (drop) as on-screen
 * buttons, and it owns the bottom-left joystick / bottom-right action area and
 * will not let a scene move them. The only thing this UI needs to add is a way
 * to choose which tile is selected, which is the tap-to-select bag row. The
 * whole tree is inset by the renderer-reported interactable area.
 */
function MobileUi(t: Theme) {
  return (
    // Plain (non-flex-between) outer wrapper. MobileClock and WinnerBanner
    // are positionType 'absolute' overlays — see WinnerBanner's own comment
    // for why: this UI engine still counts absolute children as flex items
    // under justify-content: space-between, so adding them as siblings
    // INSIDE that column below was quietly reshuffling the two real rows'
    // spacing (the "ugly" regression). Keeping them as top-level siblings of
    // this plain wrapper instead means they can't touch that column's math
    // at all; their own screen position comes entirely from their own
    // explicit `position`.
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      <UiEntity
        uiTransform={{
          width: '100%',
          height: '100%',
          flexDirection: 'column',
          justifyContent: 'space-between',
          // Fixed on all four sides, not t.insets.* — that reporting bug (see
          // MOBILE_CLOCK_TOP) wasn't just a top/bottom problem: right was
          // still leaving the leaderboard short of the true right edge, and
          // left was eating into the row's available width, squeezing the
          // bag slots narrower than intended. MOBILE_TOP_MARGIN also
          // replaces the old LEADERBOARD_DROP_FRACTION nudge — that was
          // specifically clearing 7.25-era profile/eye icons that lived where
          // the leaderboard now sits; 7.26 moved them to the opposite corner,
          // so it's no longer needed at all.
          padding: {
            top: MOBILE_TOP_MARGIN,
            right: MOBILE_SIDE_MARGIN,
            bottom: MOBILE_BOTTOM_MARGIN,
            left: MOBILE_SIDE_MARGIN
          }
        }}
      >
        {/* SDK7 7.26.0 (15 Aug) moved the explorer's own system buttons —
            avatar, reload scene, chat/discover/share — from the right side to
            the left on mobile Godot. The leaderboard stacks top-right to stay
            clear of them; StatusPanel isn't used on mobile any more — the
            round number now renders next to the clock in MobileClock. */}
        <UiEntity uiTransform={{ width: '100%', height: 'auto', flexDirection: 'column', alignItems: 'flex-end' }}>
          <Leaderboard t={t} />
        </UiEntity>

        <UiEntity uiTransform={{ width: '100%', height: 'auto', flexDirection: 'column' }}>
          <Toasts t={t} />
          <Hint t={t} />
          <MobileBagRow t={t} />
          <MobileControlsHint t={t} />
        </UiEntity>
      </UiEntity>

      <MobileClock t={t} />
      <WinnerBanner t={t} />
    </UiEntity>
  )
}

function DesktopUi(t: Theme) {
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      <StatusPanel t={t} />
      <Leaderboard t={t} />
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { bottom: 24 + t.insets.bottom },
          width: '100%',
          height: 210,
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-end'
        }}
      >
        <Toasts t={t} />
        <Hint t={t} />
        <Bag t={t} />
        <OutlinedLabel
          value={`BAG  ${getInventory().length} / ${MAX_INVENTORY}   ·   [1] drop   ·   [2]/[3] switch   ·   [E] stage   ·   [F] submit`}
          fontSize={t.font.tiny}
          color={MUTED}
          height={22}
        />
      </UiEntity>

      <WinnerBanner t={t} />
    </UiEntity>
  )
}

const Ui = () => {
  const t = theme()
  return t.mobile ? MobileUi(t) : DesktopUi(t)
}

function render(t: Theme): void {
  ReactEcsRenderer.setUiRenderer(Ui, {
    virtualWidth: t.virtualWidth,
    virtualHeight: t.virtualHeight,
    // SDK7 7.26.0 added an automatic screen-inset behaviour to setUiRenderer
    // that's on by default — the renderer itself now shrinks/offsets the
    // whole canvas to dodge the explorer's own chrome, ON TOP OF the manual
    // `insets` padding platform.ts already computes from UiCanvasInformation
    // and applies by hand throughout this file. That's a double inset: it's
    // almost certainly why mobile elements pinned near the top were landing a
    // third of the way down the screen instead. 'none' opts back out so this
    // file stays the single source of truth for inset handling on mobile,
    // matching how it already worked pre-7.26.
    //
    // Desktop is explicitly excluded — it was never part of this bug (the
    // user confirmed desktop Unity stayed fine throughout), so it keeps the
    // renderer's own default ('device') rather than risk changing behaviour
    // that wasn't broken.
    screenInset: t.mobile ? 'none' : undefined
  })
}

export function setupUi(): void {
  // getPlatform() is null for the first frames, so start with the current best
  // guess and re-declare the canvas once the explorer reports what it is. A later
  // setUiRenderer call replaces the earlier one, which is exactly what we want.
  render(theme())
  watchPlatform(render)
}
