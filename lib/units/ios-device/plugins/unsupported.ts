import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {Router, ZmqSocket} from '../../../types/device-plugins.js'
import routerSyrup from '../../device/support/router.js'
import pushSyrup from '../../device/support/push.js'
import type {IosDeviceOptions} from '../types.js'

export const NOT_SUPPORTED = 'Not supported on iOS'

// Transactions the Android worker serves and the iOS worker cannot. Each is
// answered with an immediate failure, so callers do not wait for a timeout.
export const UNSUPPORTED_TRANSACTIONS = [
  'AccountAddMenuMessage'
, 'AccountAddMessage'
, 'AccountCheckMessage'
, 'AccountGetMessage'
, 'AccountRemoveMessage'
, 'BluetoothCleanBondedMessage'
, 'BluetoothGetStatusMessage'
, 'BluetoothSetEnabledMessage'
, 'BrowserClearMessage'
, 'BrowserOpenMessage'
, 'ConnectStartMessage'
, 'ConnectStopMessage'
, 'CopyMessage'
, 'FileSystemGetMessage'
, 'FileSystemListMessage'
, 'ForwardCreateMessage'
, 'ForwardRemoveMessage'
, 'ForwardTestMessage'
, 'LogcatApplyFiltersMessage'
, 'LogcatStartMessage'
, 'LogcatStopMessage'
, 'PhysicalIdentifyMessage'
, 'RingerGetMessage'
, 'RingerSetMessage'
, 'SdStatusMessage'
, 'ShellCommandMessage'
, 'StoreOpenMessage'
, 'WifiGetStatusMessage'
, 'WifiSetEnabledMessage'
] as const

// One-way messages with no iOS meaning.
const IGNORED_MESSAGES = [
  'AdbKeysUpdatedMessage'
, 'RotateMessage'
, 'ShellKeepAliveMessage'
, 'VncAuthResponsesUpdatedMessage'
] as const

interface RoutableMessage {
  $code: number
  decode(buffer: Buffer | Uint8Array): unknown
}

export default syrup.serial()
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .define(function(options: IosDeviceOptions, router: Router, push: ZmqSocket) {
    const log = logger.createLogger('ios-device:plugins:unsupported')
    const messages = wire as unknown as Record<string, RoutableMessage>

    UNSUPPORTED_TRANSACTIONS.forEach(function(name) {
      router.on(messages[name]!, function(channel) {
        log.debug('Rejecting %s, not supported on iOS', name)
        push.send([
          channel
        , wireutil.reply(options.serial).fail(NOT_SUPPORTED)
        ])
      })
    })

    IGNORED_MESSAGES.forEach(function(name) {
      router.on(messages[name]!, function() {
        log.debug('Ignoring %s, not supported on iOS', name)
      })
    })
  })
