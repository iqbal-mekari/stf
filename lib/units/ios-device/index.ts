import syrup from '@devicefarmer/stf-syrup'

import logger from '../../util/logger.js'
import lifecycle from '../../util/lifecycle.js'
import loggerSyrup from '../device/plugins/logger.js'
import heartbeatSyrup from '../device/plugins/heartbeat.js'
import wdaSyrup from './plugins/wda.js'
import soloSyrup from './plugins/solo.js'
import screenSyrup from './plugins/screen.js'
import captureSyrup from './plugins/capture.js'
import touchSyrup from './plugins/touch.js'
import inputSyrup from './plugins/input.js'
import installSyrup from './plugins/install.js'
import groupSyrup from './plugins/group.js'
import rebootSyrup from './plugins/reboot.js'
import batterySyrup from './plugins/battery.js'
import keepAwakeSyrup from './plugins/keep-awake.js'
import unsupportedSyrup from './plugins/unsupported.js'
import type {SoloPlugin} from '../../types/device-plugins.js'
import type {IosDeviceOptions} from './types.js'

export default function(options: IosDeviceOptions) {
  // Show serial number in logs
  logger.setGlobalIdentifier(options.serial)

  const log = logger.createLogger('ios-device')

  return syrup.serial()
    // We want to send logs before anything else starts happening
    .dependency(loggerSyrup)
    .define(function(options: IosDeviceOptions) {
      log.info('Preparing iOS device')
      return syrup.serial()
        .dependency(heartbeatSyrup)
        // Nothing is ready to serve before WebDriverAgent answers.
        .dependency(wdaSyrup)
        .dependency(soloSyrup)
        .dependency(screenSyrup)
        .dependency(captureSyrup)
        .dependency(touchSyrup)
        .dependency(inputSyrup)
        .dependency(installSyrup)
        .dependency(groupSyrup)
        .dependency(rebootSyrup)
        .dependency(batterySyrup)
        .dependency(keepAwakeSyrup)
        .dependency(unsupportedSyrup)
        .define(function(
          options: IosDeviceOptions
        , heartbeat: unknown
        , wda: unknown
        , solo: SoloPlugin
        ) {
          if (process.send) {
            // Only if we have a parent process
            process.send('ready')
          }
          log.info('Fully operational')
          return solo.poke()
        })
        .consume(options)
    })
    .consume(options)
    .catch(function(err) {
      log.fatal('Setup had an error', err.stack)
      lifecycle.fatal()
    })
}
