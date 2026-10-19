import crypto from 'crypto'

import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {Router, SoloPlugin, ZmqSocket} from '../../../types/device-plugins.js'
import subSyrup from '../../device/support/sub.js'
import pushSyrup from '../../device/support/push.js'
import routerSyrup from '../../device/support/router.js'
import identitySyrup from './identity.js'
import type {IosDeviceOptions} from '../types.js'
import type {IosIdentity} from './types.js'

export default syrup.serial()
  .dependency(subSyrup)
  .dependency(pushSyrup)
  .dependency(routerSyrup)
  .dependency(identitySyrup)
  .define(function(
    options: IosDeviceOptions
  , sub: ZmqSocket
  , push: ZmqSocket
  , router: Router
  , identity: IosIdentity
  ): SoloPlugin {
    const log = logger.createLogger('ios-device:plugins:solo')

    // Same channel derivation as Android, so it is stable across restarts.
    const channel = crypto.createHash('sha1')
      .update(options.serial)
      .digest('base64')

    log.info('Subscribing to permanent channel "%s"', channel)
    sub.subscribe(channel)

    router.on(wire.ProbeMessage, function() {
      push.send([
        wireutil.global
      , wireutil.envelope(new wire.DeviceIdentityMessage(
          options.serial
        , identity.platform
        , identity.manufacturer
        , identity.operator
        , identity.model
        , identity.version
        , identity.abi
        , identity.sdk
        , new wire.DeviceDisplayMessage(identity.display)
        , new wire.DevicePhoneMessage(Object.assign({}, identity.phone))
        , identity.product
        , identity.cpuPlatform
        , identity.openGLESVersion
        , identity.marketName
        ))
      ])
    })

    return {
      channel: channel
    , poke: function() {
        push.send([
          wireutil.global
        , wireutil.envelope(new wire.DeviceReadyMessage(
            options.serial
          , channel
          ))
        ])
      }
    }
  })
