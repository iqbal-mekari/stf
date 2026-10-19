import syrup from '@devicefarmer/stf-syrup'
import _ from 'lodash'

import logger from '../../../util/logger.js'
import backendSyrup from '../support/backend.js'
import wdaSyrup from './wda.js'
import type {IosBackend, IosDeviceOptions} from '../types.js'
import type {IosIdentity, WdaPlugin} from './types.js'

// Nominal points per inch on iOS. Apple does not report the physical
// density, and the UI only uses it for display.
const POINTS_PER_INCH = 160

export function screenUrl(options: IosDeviceOptions) {
  return _.template(options.screenWsUrlPattern)({
    publicIp: options.publicIp
  , publicPort: options.screenPort
  , serial: options.serial
  })
}

export default syrup.serial()
  .dependency(backendSyrup)
  .dependency(wdaSyrup)
  .define(async function(
    options: IosDeviceOptions
  , backend: IosBackend
  , wda: WdaPlugin
  ): Promise<IosIdentity> {
    const log = logger.createLogger('ios-device:plugins:identity')
    const info = await backend.getInfo(options.serial)
    const screen = wda.screen
    const scale = screen.scale || 1
    // The UI shows marketName before anything else. It is the public model
    // name, never the user-chosen device name, which is personal data.
    const marketName = info.marketName || info.productType
    const version = info.osVersion

    log.info('Running iOS %s on %s', version, marketName)

    return {
      serial: options.serial
    , platform: 'iOS'
    , manufacturer: 'Apple'
    , operator: null
    , model: marketName
    , version: version
    , abi: 'arm64'
    , sdk: version.split('.')[0] || version
    , product: info.productType
    , cpuPlatform: null
    , openGLESVersion: null
    , marketName: marketName
    , display: {
        id: 0
      , width: Math.round(screen.width * scale)
      , height: Math.round(screen.height * scale)
      , rotation: 0
      , xdpi: POINTS_PER_INCH * scale
      , ydpi: POINTS_PER_INCH * scale
      , fps: options.screenFrameRate > 0 ? options.screenFrameRate : 0
      , density: scale
      , secure: false
      , url: screenUrl(options)
      }
    , phone: {}
    }
  })
