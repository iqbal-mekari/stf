import events from 'events'

import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import lifecycle from '../../../util/lifecycle.js'
import {createWdaClient} from '../wda/client.js'
import backendSyrup from '../support/backend.js'
import type {
  IosBackend
, IosDeviceOptions
, WdaClient
, WdaHandle
, WdaScreenInfo
} from '../types.js'
import type {WdaPlugin} from './types.js'
import {errorMessage} from '../util.js'

const DEFAULT_MAX_FAILURES = 5
const DEFAULT_RESTART_DELAY = 1000
const MAX_RESTART_DELAY = 30000

export default syrup.serial()
  .dependency(backendSyrup)
  .define(function(options: IosDeviceOptions, backend: IosBackend): Promise<WdaPlugin> {
    const log = logger.createLogger('ios-device:plugins:wda')
    const maxFailures = Math.max(1, options.wdaMaxFailures ?? DEFAULT_MAX_FAILURES)
    const restartDelay = Math.max(0, options.wdaRestartDelay ?? DEFAULT_RESTART_DELAY)
    const plugin = new events.EventEmitter() as WdaPlugin
    let current: WdaClient | null = null
    let handle: WdaHandle | null = null
    let stopping = false
    let failures = 0
    let retryTimer: NodeJS.Timeout | null = null
    let wakeRetry: (() => void) | null = null

    function client() {
      if (!current) {
        throw new Error('WebDriverAgent is not running')
      }
      return current
    }

    // Every call goes to whichever client is current at call time, so the
    // other plugins never hold on to a client of a WebDriverAgent that has
    // since been restarted.
    plugin.client = {
      get baseUrl() {
        return current ? current.baseUrl : ''
      }
    , status: async() => client().status()
    , ensureSession: async() => client().ensureSession()
    , screen: async() => client().screen()
    , tap: async(x, y) => client().tap(x, y)
    , gesture: async(pointers) => client().gesture(pointers)
    , typeText: async(text) => client().typeText(text)
    , pressButton: async(button) => client().pressButton(button)
    , homescreen: async() => client().homescreen()
    , isLocked: async() => client().isLocked()
    , unlock: async() => client().unlock()
    , setStreamSettings: async(settings) => client().setStreamSettings(settings)
    , screenshotPng: async() => client().screenshotPng()
    }
    plugin.mjpegUrl = ''
    plugin.screen = {width: 0, height: 0, scale: 1}

    plugin.isRunning = function() {
      return current !== null
    }

    function sleep(ms: number) {
      return new Promise<void>(function(resolve) {
        wakeRetry = resolve
        retryTimer = setTimeout(resolve, ms)
      })
        .finally(function() {
          retryTimer = null
          wakeRetry = null
        })
    }

    async function startOnce() {
      const started = await backend.startWda(options.serial, {
        wdaPort: options.wdaPort
      , mjpegPort: options.mjpegPort
      })
      if (stopping) {
        await started.stop()
        throw new Error('Stopped while WebDriverAgent was starting')
      }
      try {
        const next = createWdaClient(started.wdaUrl)
        const screen: WdaScreenInfo = await next.screen()
        handle = started
        current = next
        plugin.mjpegUrl = started.mjpegUrl
        plugin.screen = screen
      }
      catch (err) {
        await started.stop().catch(function() {
          // Already failing.
        })
        throw err
      }

      started.exited.then(function() {
        if (handle !== started) {
          return
        }
        handle = null
        current = null
        if (stopping) {
          return
        }
        log.warn('WebDriverAgent exited, restarting it')
        plugin.emit('exit')
        startWithRetries()
          .then(function() {
            plugin.emit('start')
          })
          .catch(function(err) {
            if (!stopping) {
              log.fatal('Unable to restart WebDriverAgent: %s', errorMessage(err, options.serial))
              lifecycle.fatal()
            }
          })
      })
    }

    async function startWithRetries() {
      for (;;) {
        if (stopping) {
          throw new Error('Stopped')
        }
        try {
          await startOnce()
          failures = 0
          log.info('WebDriverAgent is running')
          return
        }
        catch (err) {
          failures += 1
          log.warn(
            'WebDriverAgent failed to start (attempt %d of %d): %s'
          , failures
          , maxFailures
          , errorMessage(err, options.serial)
          )
          if (failures >= maxFailures || stopping) {
            throw err
          }
          await sleep(Math.min(
            MAX_RESTART_DELAY
          , restartDelay * Math.pow(2, failures - 1)
          ))
        }
      }
    }

    plugin.stop = async function() {
      stopping = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      wakeRetry?.()
      const last = handle
      handle = null
      current = null
      if (last) {
        await last.stop()
      }
    }

    lifecycle.observe(function() {
      return plugin.stop()
    })

    log.info('Starting WebDriverAgent')
    return startWithRetries().then(function() {
      return plugin
    })
  })
