import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import lifecycle from '../../../util/lifecycle.js'
import wdaSyrup from './wda.js'
import {errorMessage} from '../util.js'
import type {IosDeviceOptions} from '../types.js'
import type {WdaPlugin} from './types.js'

// Unlocks the device whenever it locked itself, so the screen stays usable
// for remote users. Simulators and supervised devices with auto-lock set to
// never simply never report locked.
export default syrup.serial()
  .dependency(wdaSyrup)
  .define(function(options: IosDeviceOptions, wda: WdaPlugin) {
    const log = logger.createLogger('ios-device:plugins:keep-awake')
    let timer: NodeJS.Timeout | undefined
    let busy = false

    async function check() {
      if (busy || !wda.isRunning()) {
        return
      }
      busy = true
      try {
        if (await wda.client.isLocked()) {
          log.debug('Device is locked, unlocking')
          await wda.client.unlock()
        }
      }
      catch (err) {
        log.debug('Keep-awake check failed: %s', errorMessage(err))
      }
      finally {
        busy = false
      }
    }

    function stop() {
      clearInterval(timer)
    }

    if (options.keepAwakeInterval > 0) {
      timer = setInterval(check, options.keepAwakeInterval)
    }

    lifecycle.observe(stop)

    return {
      check: check
    , stop: stop
    }
  })
