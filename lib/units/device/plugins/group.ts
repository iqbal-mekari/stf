import syrup from '@devicefarmer/stf-syrup'

import type {
  Channels
, DeviceIdentity
, DevicePluginOptions
, Router
, ServicePlugin
, SoloPlugin
, ZmqSocket
} from '../../../types/device-plugins.js'
import soloSyrup from './solo.js'
import identitySyrup from './util/identity.js'
import serviceSyrup from './service.js'
import {createGroupPlugin} from './util/group.js'
import routerSyrup from '../support/router.js'
import pushSyrup from '../support/push.js'
import subSyrup from '../support/sub.js'
import channelsSyrup from '../support/channels.js'

export default syrup.serial()
  .dependency(soloSyrup)
  .dependency(identitySyrup)
  .dependency(serviceSyrup)
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .dependency(subSyrup)
  .dependency(channelsSyrup)
  .define(function(
    options: DevicePluginOptions
  , solo: SoloPlugin
  , ident: DeviceIdentity
  , service: ServicePlugin
  , router: Router
  , push: ZmqSocket
  , sub: ZmqSocket
  , channels: Channels
  ) {
    var plugin = createGroupPlugin(
      options
    , solo
    , ident
    , router
    , push
    , sub
    , channels
    , 'device:plugins:group'
    )

    plugin.on('join', function() {
      service.wake()
      service.acquireWakeLock()
    })

    plugin.on('leave', function() {
      if (options.screenReset) {
        service.pressKey('home')
        service.thawRotation()
      }
      service.releaseWakeLock()
    })

    return plugin
  })
