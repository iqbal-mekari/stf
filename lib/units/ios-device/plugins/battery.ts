import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import lifecycle from '../../../util/lifecycle.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {ZmqSocket} from '../../../types/device-plugins.js'
import pushSyrup from '../../device/support/push.js'
import backendSyrup from '../support/backend.js'
import {errorMessage} from '../util.js'
import type {IosBackend, IosDeviceInfo, IosDeviceOptions} from '../types.js'

const DEFAULT_INTERVAL = 60000

// Uses the Android BatteryManager vocabulary the UI translates. iOS does
// not report health, power source, temperature or voltage.
export function toBatteryEvent(serial: string, info: IosDeviceInfo) {
  if (typeof info.batteryLevel !== 'number') {
    return null
  }
  const level = Math.max(0, Math.min(100, Math.round(info.batteryLevel)))
  let status = 'discharging'
  if (info.batteryCharging) {
    status = level >= 100 ? 'full' : 'charging'
  }
  return new wire.BatteryEvent(
    serial
  , status
  , ''
  , info.batteryCharging && info.connection === 'usb' ? 'usb' : ''
  , level
  , 100
  , 0
  , 0
  )
}

export default syrup.serial()
  .dependency(backendSyrup)
  .dependency(pushSyrup)
  .define(function(options: IosDeviceOptions, backend: IosBackend, push: ZmqSocket) {
    const log = logger.createLogger('ios-device:plugins:battery')
    const interval = options.batteryInterval ?? DEFAULT_INTERVAL
    let last = ''
    let timer: NodeJS.Timeout | undefined
    let stopped = false

    async function check() {
      try {
        const event = toBatteryEvent(options.serial, await backend.getInfo(options.serial))
        if (event) {
          const key = [event.status, event.source, event.level].join(':')
          if (key !== last) {
            last = key
            push.send([
              wireutil.global
            , wireutil.envelope(event)
            ])
          }
        }
      }
      catch (err) {
        log.debug('Unable to read battery state: %s', errorMessage(err, options.serial))
      }
    }

    function schedule() {
      if (!stopped) {
        timer = setTimeout(function() {
          check().finally(schedule)
        }, interval)
      }
    }

    function stop() {
      stopped = true
      clearTimeout(timer)
    }

    if (interval > 0) {
      check().finally(schedule)
    }

    lifecycle.observe(stop)

    return {
      check: check
    , stop: stop
    }
  })
