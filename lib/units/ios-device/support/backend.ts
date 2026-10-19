import syrup from '@devicefarmer/stf-syrup'

import {createBackend} from '../backend/index.js'
import type {IosBackend, IosDeviceOptions} from '../types.js'

export default syrup.serial()
  .define(function(options: IosDeviceOptions): IosBackend {
    return createBackend(options.backend, options.backendOptions)
  })
