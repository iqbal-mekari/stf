import {Readable} from 'stream'

import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {Router, ZmqSocket} from '../../../types/device-plugins.js'
import type {Storage} from '../../../types/device.js'
import routerSyrup from '../../device/support/router.js'
import pushSyrup from '../../device/support/push.js'
import storageSyrup from '../../device/support/storage.js'
import wdaSyrup from './wda.js'
import {errorMessage} from '../util.js'
import type {IosDeviceOptions} from '../types.js'
import type {WdaPlugin} from './types.js'

export default syrup.serial()
  .dependency(wdaSyrup)
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .dependency(storageSyrup)
  .define(function(
    options: IosDeviceOptions
  , wda: WdaPlugin
  , router: Router
  , push: ZmqSocket
  , storage: Storage
  ) {
    const log = logger.createLogger('ios-device:plugins:capture')

    async function capture() {
      log.info('Capturing screenshot')
      const png = await wda.client.screenshotPng()
      if (!png.length) {
        throw new Error('Empty screenshot')
      }
      // Not named after the serial, which is the UDID on iOS.
      return storage.store('image', Readable.from([png]), {
        filename: 'screenshot.png'
      , contentType: 'image/png'
      , knownLength: png.length
      })
    }

    router.on(wire.ScreenCaptureMessage, function(channel) {
      const reply = wireutil.reply(options.serial)
      capture()
        .then(function(file) {
          push.send([
            channel
          , reply.okay('success', file)
          ])
        })
        .catch(function(err) {
          log.error('Screen capture failed: %s', errorMessage(err))
          push.send([
            channel
          , reply.fail(errorMessage(err))
          ])
        })
    })

    return {
      capture: capture
    }
  })
