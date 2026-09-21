// Normalises Even Hub input events (temple touchpad + R1 ring) into one gesture vocabulary.
// CLICK_EVENT is 0 and protobuf omits zero-valued fields, so a plain tap arrives with
// `eventType === undefined` inside its envelope; resolve that default per-envelope only.

import { EventSourceType, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type GestureKind =
  | 'tap'
  | 'double'
  | 'up'
  | 'down'
  | 'long'
  | 'long_release'
  | 'fg_enter'
  | 'fg_exit'
  | 'exit'
  | 'menu'

export interface Gesture {
  kind: GestureKind
  source: 'ring' | 'glasses' | 'unknown'
  /** For taps on a list container: the selected row. */
  listIndex?: number
  listItem?: string
  container?: string
  menuItemId?: number
}

function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function sourceOf(src?: EventSourceType): Gesture['source'] {
  if (src === EventSourceType.TOUCH_EVENT_FROM_RING) return 'ring'
  if (src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_L || src === EventSourceType.TOUCH_EVENT_FROM_GLASSES_R)
    return 'glasses'
  return 'unknown'
}

function mapType(t: OsEventTypeList | null): GestureKind | null {
  switch (t) {
    case OsEventTypeList.CLICK_EVENT:
      return 'tap'
    case OsEventTypeList.DOUBLE_CLICK_EVENT:
      return 'double'
    case OsEventTypeList.SCROLL_TOP_EVENT:
      return 'up'
    case OsEventTypeList.SCROLL_BOTTOM_EVENT:
      return 'down'
    case OsEventTypeList.LONG_PRESS_EVENT:
      return 'long'
    case OsEventTypeList.LONG_PRESS_RELEASE_EVENT:
      return 'long_release'
    case OsEventTypeList.FOREGROUND_ENTER_EVENT:
      return 'fg_enter'
    case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      return 'fg_exit'
    case OsEventTypeList.SYSTEM_EXIT_EVENT:
    case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      return 'exit'
    default:
      return null
  }
}

/** Returns the gesture carried by an event, or null for audio / IMU / unknown payloads. */
export function gestureFrom(event: EvenHubEvent): Gesture | null {
  if (event.menuItemClickEvent?.itemID !== undefined) {
    return { kind: 'menu', source: 'unknown', menuItemId: Number(event.menuItemClickEvent.itemID) }
  }
  const sys = event.sysEvent
  if (sys && sys.eventType !== OsEventTypeList.IMU_DATA_REPORT) {
    const kind = mapType(typeOf(sys))
    if (kind) return { kind, source: sourceOf(sys.eventSource) }
  }
  const list = event.listEvent
  if (list) {
    const kind = mapType(typeOf(list))
    if (kind)
      return {
        kind,
        source: 'unknown',
        listIndex: list.currentSelectItemIndex,
        listItem: list.currentSelectItemName,
        container: list.containerName,
      }
  }
  const text = event.textEvent
  if (text) {
    const kind = mapType(typeOf(text))
    if (kind) return { kind, source: 'unknown', container: text.containerName }
  }
  return null
}
