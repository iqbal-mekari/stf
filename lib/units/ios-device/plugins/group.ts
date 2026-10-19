import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import type {
  Channels
, Router
, SoloPlugin
, ZmqSocket
} from '../../../types/device-plugins.js'
import {createGroupPlugin} from '../../device/plugins/util/group.js'
import routerSyrup from '../../device/support/router.js'
import pushSyrup from '../../device/support/push.js'
import subSyrup from '../../device/support/sub.js'
import channelsSyrup from '../../device/support/channels.js'
import soloSyrup from './solo.js'
import identitySyrup from './identity.js'
import wdaSyrup from './wda.js'
import type {IosDeviceOptions} from '../types.js'
import type {IosIdentity, WdaPlugin} from './types.js'
import {errorMessage} from '../util.js'

export default syrup.serial()
  .dependency(soloSyrup)
  .dependency(identitySyrup)
  .dependency(wdaSyrup)
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .dependency(subSyrup)
  .dependency(channelsSyrup)
  .define(function(
    options: IosDeviceOptions
  , solo: SoloPlugin
  , ident: IosIdentity
  , wda: WdaPlugin
  , router: Router
  , push: ZmqSocket
  , sub: ZmqSocket
  , channels: Channels
  ) {
    const log = logger.createLogger('ios-device:plugins:group')
    const plugin = createGroupPlugin(
      options
    , solo
    , ident
    , router
    , push
    , sub
    , channels
    , 'ios-device:plugins:group'
    )

    // Make sure the new user does not land on a lock screen.
    plugin.on('join', function() {
      wda.client.isLocked()
        .then(function(locked) {
          if (locked) {
            return wda.client.unlock()
          }
          return Promise.resolve()
        })
        .catch(function(err) {
          log.warn('Unable to unlock on join: %s', errorMessage(err))
        })
    })

    plugin.on('leave', function() {
      if (options.screenReset !== false) {
        wda.client.homescreen()
          .catch(function(err) {
            log.warn('Unable to go home on leave: %s', errorMessage(err))
          })
      }
    })

    return plugin
  })
