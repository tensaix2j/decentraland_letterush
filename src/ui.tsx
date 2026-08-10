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
import { MAX_INVENTORY, TEXTURE_ALPHABET } from './config'
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

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

function StatusPanel(props: { t: Theme }) {
  const t = props.t
  const round = getRound()
  const remaining = round && round.endsAt ? round.endsAt - Date.now() : 0
  const label = round && round.endsAt ? clock(remaining) : '--:--'

  if (t.mobile) {
    // One compact strip; a phone has no room for a boxed panel. No backing
    // plate at all — the outline on the glyphs is what keeps the clock legible
    // over whatever the world happens to be behind it, and it reads cleaner
    // than a black rectangle floating in the corner.
    return (
      <UiEntity
        uiTransform={{
          height: 46,
          flexDirection: 'row',
          alignItems: 'center',
          padding: { left: 12, right: 12 },
          margin: { top: 8 }
        }}
      >
        <OutlinedLabel
          value={label}
          fontSize={t.font.clock}
          color={TEXT}
          width={140}
          height={44}
          textAlign="middle-left"
        />
        <OutlinedLabel
          value={`R${round ? round.roundId : '-'}`}
          fontSize={t.font.tiny}
          color={MUTED}
          width={60}
          height={40}
          textAlign="middle-left"
        />
      </UiEntity>
    )
  }

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
        uiTransform={{ height: 24 }}
      />
      <Label value={label} fontSize={t.font.clock} color={TEXT} uiTransform={{ height: 46 }} />
      {isHost() ? (
        <Label value="host" fontSize={t.font.tiny} color={MUTED} uiTransform={{ height: 20 }} />
      ) : null}
    </UiEntity>
  )
}

/**
 * Extra drop for the mobile leaderboard, as a fraction of the top inset.
 *
 * The explorer's own profile/eye icons sit in the top-right corner and were
 * still clipping the panel even after the inset floor in platform.ts. Scaling
 * the nudge off `insets.top` rather than using a fixed pixel count keeps it
 * proportional: the icons occupy roughly a constant share of screen height,
 * so this stays correct in portrait and landscape and across device sizes.
 */
const LEADERBOARD_DROP_FRACTION = 0.4

function Leaderboard(props: { t: Theme }) {
  const t = props.t
  const limit = t.mobile ? 3 : 8
  const rows = getLeaderboard().slice(0, limit)
  const me = myAddress()

  const body =
    rows.length === 0 ? (
      <Label
        value={t.mobile ? 'no words yet' : 'No words yet — be first!'}
        fontSize={t.font.tiny}
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
            fontSize={t.font.small}
            color={i === 0 ? ACCENT : MUTED}
            uiTransform={{ width: t.mobile ? 22 : 28, height: '100%' }}
          />
          <Label
            value={row.name.length > (t.mobile ? 9 : 16) ? row.name.slice(0, t.mobile ? 9 : 16) + '…' : row.name}
            fontSize={t.font.small}
            color={row.address === me ? ACCENT : TEXT}
            uiTransform={{ width: t.mobile ? 100 : 170, height: '100%' }}
          />
          <Label
            value={`${row.points}`}
            fontSize={t.font.body}
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
          margin: { top: Math.round(t.insets.top * LEADERBOARD_DROP_FRACTION) },
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
      <Label value="LEADERBOARD" fontSize={t.font.title} color={ACCENT} uiTransform={{ height: 26 }} />
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
        texture: { src: TEXTURE_ALPHABET },
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
 * How many slots span a FULL-width bag row — i.e. what sets one slot's size.
 *
 * This is intentionally separate from MAX_INVENTORY. The two were the same
 * number when the row filled the whole screen, but the row shares the bottom
 * of the screen with the explorer's own E/F touch buttons in the
 * bottom-right, which a scene cannot move or draw over. Keeping slot size
 * pegged here means lowering the carry limit buys back real estate on the
 * right instead of just making each slot bigger.
 */
const BAG_ROW_CAPACITY = 10

/**
 * Mobile bag: always exactly MAX_INVENTORY slots in one row, so it never
 * reflows or changes width as tiles are picked up — filled slots show the
 * glyph and are tappable; empty ones are just an outline placeholder. Slot
 * width is a flex share of the row rather than a fixed px value, so it stays
 * correct regardless of the device's actual screen width.
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
          flexGrow: 1,
          flexBasis: 0,
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
                texture: { src: TEXTURE_ALPHABET },
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
        // Deliberately NOT 100%. Slot size is pinned to BAG_ROW_CAPACITY, so
        // carrying fewer tiles shortens the ROW instead of fattening the
        // slots — the gap it leaves on the right is the point, that's where
        // the explorer draws its own E/F touch buttons.
        width: `${Math.round((MAX_INVENTORY / BAG_ROW_CAPACITY) * 100)}%`,
        height: t.mobileBagSlot,
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: 10, right: 10 }
      }}
    >
      {slots}
    </UiEntity>
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
    text = 'Find tiles in the four zones'
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
    <UiEntity
      uiTransform={{
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: {
          top: t.insets.top,
          right: t.insets.right,
          bottom: t.insets.bottom,
          left: t.insets.left
        }
      }}
    >
      <UiEntity uiTransform={{ width: '100%', height: 'auto', flexDirection: 'row', justifyContent: 'space-between' }}>
        <StatusPanel t={t} />
        <Leaderboard t={t} />
      </UiEntity>

      <UiEntity uiTransform={{ width: '100%', height: 'auto', flexDirection: 'column' }}>
        <Toasts t={t} />
        <Hint t={t} />
        <MobileBagRow t={t} />
      </UiEntity>

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
        <Label
          value={`BAG  ${getInventory().length} / ${MAX_INVENTORY}   ·   [1] drop   ·   [2]/[3] switch   ·   [E] stage   ·   [F] submit`}
          fontSize={t.font.tiny}
          color={MUTED}
          uiTransform={{ height: 22 }}
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
    virtualHeight: t.virtualHeight
  })
}

export function setupUi(): void {
  // getPlatform() is null for the first frames, so start with the current best
  // guess and re-declare the canvas once the explorer reports what it is. A later
  // setUiRenderer call replaces the earlier one, which is exactly what we want.
  render(theme())
  watchPlatform(render)
}
