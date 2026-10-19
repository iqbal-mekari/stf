import {createFakeBackend} from './fake.js'
import {createGoIosBackend} from './goios.js'
import {createSimulatorBackend} from './simulator.js'
import type {IosBackend, IosBackendName, IosBackendOptions} from '../types.js'

export function createBackend(
  name: IosBackendName
, opts: IosBackendOptions
): IosBackend {
  switch (name) {
    case 'goios':
      return createGoIosBackend(opts)
    case 'simulator':
      return createSimulatorBackend(opts)
    case 'fake':
      return createFakeBackend(opts)
    default:
      throw new Error('Unknown iOS backend: ' + String(name))
  }
}
