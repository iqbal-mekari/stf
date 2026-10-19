import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {Router, ZmqSocket} from '../../../types/device-plugins.js'
import routerSyrup from '../../device/support/router.js'
import pushSyrup from '../../device/support/push.js'
import wdaSyrup from './wda.js'
import type {IosDeviceOptions, WdaClient} from '../types.js'
import type {WdaPlugin} from './types.js'
import {errorMessage} from '../util.js'

// Keys that become typed characters, as XCUITest's typeText understands
// them.
const TYPED_KEYS: Record<string, string> = {
  enter: '\n'
, del: '\b'
, tab: '\t'
}

const KEY_ACTIONS: Record<string, (client: WdaClient) => Promise<void>> = {
  home: function(client) {
    return client.homescreen()
  }
, volume_up: function(client) {
    return client.pressButton('volumeup')
  }
, volume_down: function(client) {
    return client.pressButton('volumedown')
  }
}

export default syrup.serial()
  .dependency(wdaSyrup)
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .define(function(
    options: IosDeviceOptions
  , wda: WdaPlugin
  , router: Router
  , push: ZmqSocket
  ) {
    const log = logger.createLogger('ios-device:plugins:input')
    // Keep keys and text in the order they were sent.
    let pending: Promise<void> = Promise.resolve()

    function enqueue(what: string, action: () => Promise<void>) {
      const next = pending.then(action)
      pending = next.catch(function(err) {
        log.warn('%s failed: %s', what, errorMessage(err))
      })
      return next
    }

    function key(name: string) {
      const action = KEY_ACTIONS[name]
      if (action) {
        return enqueue('Key', function() {
          return action(wda.client)
        })
      }
      const typed = TYPED_KEYS[name]
      if (typed) {
        return enqueue('Key', function() {
          return wda.client.typeText(typed)
        })
      }
      log.debug('Ignoring key "%s", not supported on iOS', name)
      return pending
    }

    function type(text: string) {
      return enqueue('Typing', function() {
        return wda.client.typeText(text)
      })
    }

    router
      .on(wire.KeyDownMessage, function(channel, message) {
        key(message.key)
      })
      .on(wire.KeyPressMessage, function(channel, message) {
        key(message.key)
      })
      .on(wire.KeyUpMessage, function() {
        // Keys act on the way down.
      })
      .on(wire.TypeMessage, function(channel, message) {
        if (message.text) {
          type(message.text)
        }
      })
      // iOS has no shared clipboard over WebDriverAgent; type it instead.
      .on(wire.PasteMessage, function(channel, message) {
        const reply = wireutil.reply(options.serial)
        type(message.text)
          .then(function() {
            push.send([
              channel
            , reply.okay()
            ])
          })
          .catch(function(err) {
            push.send([
              channel
            , reply.fail(errorMessage(err))
            ])
          })
      })

    return {
      idle: function() {
        return pending
      }
    }
  })
