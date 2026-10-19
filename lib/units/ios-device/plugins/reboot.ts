import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {Router, ZmqSocket} from '../../../types/device-plugins.js'
import routerSyrup from '../../device/support/router.js'
import pushSyrup from '../../device/support/push.js'
import backendSyrup from '../support/backend.js'
import {errorMessage} from '../util.js'
import type {IosBackend, IosDeviceOptions} from '../types.js'

export default syrup.serial()
  .dependency(backendSyrup)
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .define(function(
    options: IosDeviceOptions
  , backend: IosBackend
  , router: Router
  , push: ZmqSocket
  ) {
    const log = logger.createLogger('ios-device:plugins:reboot')

    // WebDriverAgent goes away with the reboot; the wda plugin restarts it.
    router.on(wire.RebootMessage, function(channel) {
      const reply = wireutil.reply(options.serial)

      log.important('Rebooting')

      backend.reboot(options.serial)
        .then(function() {
          push.send([
            channel
          , reply.okay()
          ])
        })
        .catch(function(err) {
          log.error('Reboot failed: %s', errorMessage(err, options.serial))
          push.send([
            channel
          , reply.fail(errorMessage(err, options.serial))
          ])
        })
    })
  })
