import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import SeqQueue from '../../../wire/seqqueue.js'
import type {Router} from '../../../types/device-plugins.js'
import routerSyrup from '../../device/support/router.js'
import wdaSyrup from './wda.js'
import type {IosDeviceOptions, WdaGesturePointer, WdaScreenInfo} from '../types.js'
import type {WdaPlugin} from './types.js'
import {errorMessage} from '../util.js'

// A single contact released within this time, without moving further than
// this, is a tap. Anything else is replayed as a gesture.
export const TAP_MAX_DURATION = 300
export const TAP_MAX_DISTANCE = 10 // points
// Upper bound for the recorded commits of one gesture.
const MAX_TICKS = 1000

interface Point {
  x: number
  y: number
}

export interface Tick {
  at: number
  // Positions of the contacts that are down, normalised 0..1.
  contacts: Map<number, Point>
}

export type TouchAction =
  {type: 'tap', x: number, y: number} |
  {type: 'gesture', pointers: WdaGesturePointer[]}

function clamp(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}

function samePoint(a: Point | undefined, b: Point | undefined) {
  return !!a && !!b && a.x === b.x && a.y === b.y
}

// Turns a finished recording into one WebDriverAgent action. Coordinates go
// from normalised 0..1 to points.
export function toAction(
  ticks: Tick[]
, releasedAt: number
, screen: WdaScreenInfo
): TouchAction | null {
  if (!ticks.length) {
    return null
  }

  function toPoints(point: Point) {
    return {
      x: Math.round(point.x * screen.width * 100) / 100
    , y: Math.round(point.y * screen.height * 100) / 100
    }
  }

  const ids: number[] = []
  for (const tick of ticks) {
    for (const id of tick.contacts.keys()) {
      if (ids.indexOf(id) === -1) {
        ids.push(id)
      }
    }
  }
  if (!ids.length) {
    return null
  }

  const duration = releasedAt - ticks[0]!.at

  if (ids.length === 1) {
    const id = ids[0]!
    let first: Point | undefined
    let farthest = 0
    for (const tick of ticks) {
      const point = tick.contacts.get(id)
      if (point) {
        first = first || point
        farthest = Math.max(
          farthest
        , Math.hypot(
            (point.x - first.x) * screen.width
          , (point.y - first.y) * screen.height
          )
        )
      }
    }
    if (first && duration <= TAP_MAX_DURATION && farthest <= TAP_MAX_DISTANCE) {
      const at = toPoints(first)
      return {type: 'tap', x: at.x, y: at.y}
    }
  }

  // W3C actions advance all pointers tick by tick, so every pointer gets a
  // step for every kept commit, which keeps the fingers in sync. A contact
  // that went down late or up early holds its nearest known position.
  const known = new Map<number, Point>()
  for (const tick of ticks) {
    for (const [id, point] of tick.contacts) {
      if (!known.has(id)) {
        known.set(id, point)
      }
    }
  }

  const kept: Array<{delay: number, contacts: Map<number, Point>}> = []
  let previous: Map<number, Point> | null = null
  let carried = 0
  ticks.forEach(function(tick, index) {
    const delay = index ? tick.at - ticks[index - 1]!.at : 0
    const positions = new Map<number, Point>()
    for (const id of ids) {
      const point = tick.contacts.get(id) || known.get(id)!
      known.set(id, point)
      positions.set(id, point)
    }
    const moved = !previous || ids.some(function(id) {
      return !samePoint(previous!.get(id), positions.get(id))
    })
    carried += delay
    if (moved) {
      kept.push({delay: carried, contacts: positions})
      previous = positions
      carried = 0
    }
  })
  carried += releasedAt - ticks[ticks.length - 1]!.at

  return {
    type: 'gesture'
  , pointers: ids.map(function(id) {
      const steps = kept.map(function(step) {
        const at = toPoints(step.contacts.get(id)!)
        return {x: at.x, y: at.y, delayMs: Math.max(0, Math.round(step.delay))}
      })
      // Hold the last position until the release.
      const last = steps[steps.length - 1]!
      steps.push({x: last.x, y: last.y, delayMs: Math.max(0, Math.round(carried))})
      return {steps: steps}
    })
  }
}

// Accumulates the wire touch messages of one gesture. Positions only take
// effect on commit, like minitouch on Android.
export class TouchRecorder {
  private ticks: Tick[] = []
  private down = new Map<number, Point>()

  constructor(
    private onAction: (ticks: Tick[], releasedAt: number) => void
  , private now: () => number = Date.now
  ) {}

  touchDown(contact: number, x: number, y: number) {
    this.down.set(contact, {x: clamp(x), y: clamp(y)})
  }

  touchMove(contact: number, x: number, y: number) {
    if (this.down.has(contact)) {
      this.down.set(contact, {x: clamp(x), y: clamp(y)})
    }
  }

  touchUp(contact: number) {
    this.down.delete(contact)
  }

  commit() {
    const at = this.now()
    if (!this.down.size) {
      this.finish(at)
      return
    }
    const tick = {at: at, contacts: new Map(this.down)}
    if (this.ticks.length >= MAX_TICKS) {
      this.ticks[this.ticks.length - 1] = tick
    }
    else {
      this.ticks.push(tick)
    }
  }

  // Releases every contact, e.g. on reset or when the gesture stops.
  reset() {
    this.down.clear()
    this.finish(this.now())
  }

  private finish(at: number) {
    const ticks = this.ticks
    this.ticks = []
    if (ticks.length) {
      this.onAction(ticks, at)
    }
  }
}

export default syrup.serial()
  .dependency(wdaSyrup)
  .dependency(routerSyrup)
  .define(function(options: IosDeviceOptions, wda: WdaPlugin, router: Router) {
    const log = logger.createLogger('ios-device:plugins:touch')
    const queue = new SeqQueue(100, 4)
    // One WebDriverAgent action at a time, in order.
    let pending: Promise<void> = Promise.resolve()

    function perform(ticks: Tick[], releasedAt: number) {
      const action = toAction(ticks, releasedAt, wda.screen)
      if (!action) {
        return
      }
      pending = pending
        .then(function() {
          return action.type === 'tap' ?
            wda.client.tap(action.x, action.y) :
            wda.client.gesture(action.pointers)
        })
        .catch(function(err) {
          log.warn('Touch %s failed: %s', action.type, errorMessage(err))
        })
    }

    const recorder = new TouchRecorder(perform)

    router
      .on(wire.GestureStartMessage, function(channel, message) {
        queue.start(message.seq)
      })
      .on(wire.GestureStopMessage, function(channel, message) {
        queue.push(message.seq, function() {
          recorder.reset()
          queue.stop()
        })
      })
      .on(wire.TouchDownMessage, function(channel, message) {
        queue.push(message.seq, function() {
          recorder.touchDown(message.contact, message.x, message.y)
        })
      })
      .on(wire.TouchMoveMessage, function(channel, message) {
        queue.push(message.seq, function() {
          recorder.touchMove(message.contact, message.x, message.y)
        })
      })
      .on(wire.TouchUpMessage, function(channel, message) {
        queue.push(message.seq, function() {
          recorder.touchUp(message.contact)
        })
      })
      .on(wire.TouchCommitMessage, function(channel, message) {
        queue.push(message.seq, function() {
          recorder.commit()
        })
      })
      .on(wire.TouchResetMessage, function(channel, message) {
        queue.push(message.seq, function() {
          recorder.reset()
        })
      })

    return {
      recorder: recorder
    , idle: function() {
        return pending
      }
    }
  })
