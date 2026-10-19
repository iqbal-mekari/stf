import cp from 'child_process'
import path from 'path'
import Promise from 'bluebird'

import logger from '../../util/logger.js'
import wire from '../../wire/index.js'
import wireutil from '../../wire/util.js'
import wirerouter from '../../wire/router.js'
import procutil from '../../util/procutil.js'
import lifecycle from '../../util/lifecycle.js'
import srv from '../../util/srv.js'
import zmqutil from '../../util/zmqutil.js'
import timeutil from '../../util/timeutil.js'
import {createBackend} from '../ios-device/backend/index.js'
import type {ChildProcess} from 'child_process'
import type {HostServiceHandle, IosBackend, IosProviderOptions} from '../ios-device/types.js'

// The part of a ZeroMQ push socket the provider uses.
export interface ProviderPush {
  send(message: unknown[]): unknown
  close(): unknown
}

// The part of a ZeroMQ sub socket the provider uses.
export interface ProviderSub {
  subscribe(channel: string): unknown
  on(event: 'message', listener: (...args: never[]) => void): unknown
  close(): unknown
}

// Everything that touches the outside world can be replaced, which is how the
// tests drive the provider without ZeroMQ, child processes or a device.
export interface IosProviderDeps {
  // Starts a device worker with the given CLI arguments.
  fork?: (args: string[]) => ChildProcess
  backend?: IosBackend
  // When both are given the provider does not connect them to the endpoints.
  push?: ProviderPush
  sub?: ProviderSub
  // How long to wait for a DeviceRegisteredMessage before going ahead anyway.
  registerTimeout?: number
  // Delay before a crashed worker is started again.
  restartDelay?: number
}

export interface IosProviderHandle {
  // Idempotent. Also what runs on SIGTERM/SIGINT through lifecycle.
  stop(): Promise<void>
}

// Ports each worker gets, in this order: screen, WebDriverAgent, MJPEG.
var PORTS_PER_DEVICE = 3

type CliArg = string | number

interface DeviceState {
  udid: string
  label: string // Stable log label, device names and UDIDs stay out of info logs.
  ports: number[]
  proc: ChildProcess | null
  registered: boolean
  removed: boolean
  retired: boolean // Worker stopped on its own, deliberately. Not restarted.
  timer: NodeJS.Timeout | null // Registration fallback or restart delay.
  killed: Promise<unknown> | null
}

// The CLI arguments of an `ios-device` worker. This is the contract between
// this provider and lib/cli/ios-device.
export function buildWorkerArgs(
  options: IosProviderOptions
, udid: string
, ports: number[]
): CliArg[] {
  var args: CliArg[] = [
    'ios-device'
  , '--serial', udid
  , '--provider', options.name
  , '--public-ip', options.publicIp
  , '--storage-url', options.storageUrl
  // Seconds, same as the Android provider. The worker CLI converts to ms.
  , '--group-timeout', options.groupTimeout
  , '--heartbeat-interval', options.heartbeatInterval
  , '--screen-port', ports[0]!
  , '--wda-port', ports[1]!
  , '--mjpeg-port', ports[2]!
  , '--screen-ws-url-pattern', options.screenWsUrlPattern
  , '--screen-frame-rate', options.screenFrameRate
  , '--screen-jpeg-quality', options.screenJpegQuality
  , '--keep-awake-interval', options.keepAwakeInterval
  , '--ios-backend', options.backend
  ]

  options.endpoints.sub.forEach(function(val) {
    args.push('--connect-sub', val)
  })
  options.endpoints.push.forEach(function(val) {
    args.push('--connect-push', val)
  })

  var bo = options.backendOptions
  if (bo.goIosPath !== undefined) {
    args.push('--go-ios-path', bo.goIosPath)
  }
  if (bo.wdaBundleId !== undefined) {
    args.push('--wda-bundle-id', bo.wdaBundleId)
  }
  if (bo.wdaTestRunnerBundleId !== undefined) {
    args.push('--wda-test-runner-bundle-id', bo.wdaTestRunnerBundleId)
  }
  if (bo.wdaXctestConfig !== undefined) {
    args.push('--wda-xctest-config', bo.wdaXctestConfig)
  }
  if (bo.wdaSimulatorBuildDir !== undefined) {
    args.push('--wda-simulator-build-dir', bo.wdaSimulatorBuildDir)
  }
  if (bo.fakeDeviceCount !== undefined) {
    args.push('--fake-device-count', bo.fakeDeviceCount)
  }
  if (bo.commandTimeout !== undefined) {
    args.push('--command-timeout', bo.commandTimeout)
  }

  return args
}

function defaultFork(options: IosProviderOptions) {
  return function(args: string[]): ChildProcess {
    if (options.workerCommand) {
      return cp.spawn(options.workerCommand, args, {stdio: 'inherit'})
    }
    return cp.fork(path.resolve(import.meta.dirname, '..', '..', 'cli'), args)
  }
}

export default function(
  options: IosProviderOptions
, deps?: IosProviderDeps
): IosProviderHandle {
  var log = logger.createLogger('ios-provider')
  var d = deps || {}
  var registerTimeout = d.registerTimeout ?? 15000
  var restartDelay = d.restartDelay ?? 500
  var fork = d.fork || defaultFork(options)
  var backend = d.backend || createBackend(options.backend, options.backendOptions)
  var solo = wireutil.makePrivateChannel()
  var devices = new Map<string, DeviceState>()
  var freePorts = options.ports.slice()
  var allowed = options.filter.length ? new Set(options.filter) : null
  var counter = 0
  var stopping = false
  var pollTimer: NodeJS.Timeout | null = null
  var polling: Promise<void> = Promise.resolve()
  var hostHandle: HostServiceHandle | null = null
  var stopPromise: Promise<void> | null = null

  // Output and input
  var push: ProviderPush, sub: ProviderSub
  if (d.push && d.sub) {
    push = d.push
    sub = d.sub
  }
  else {
    var pushSock = zmqutil.socket('push')
    var subSock = zmqutil.socket('sub')
    push = pushSock as unknown as ProviderPush
    sub = subSock as unknown as ProviderSub

    Promise.map(options.endpoints.push, function(endpoint) {
      return srv.resolve(endpoint).then(function(records) {
        return srv.attempt(records, function(record) {
          log.info('Sending output to "%s"', record.url)
          pushSock.connect(record.url)
          return Promise.resolve(true)
        })
      })
    })
    .catch(function(err) {
      log.fatal('Unable to connect to push endpoint', err)
      lifecycle.fatal()
    })

    Promise.map(options.endpoints.sub, function(endpoint) {
      return srv.resolve(endpoint).then(function(records) {
        return srv.attempt(records, function(record) {
          log.info('Receiving input from "%s"', record.url)
          subSock.connect(record.url)
          return Promise.resolve(true)
        })
      })
    })
    .catch(function(err) {
      log.fatal('Unable to connect to sub endpoint', err)
      lifecycle.fatal()
    })
  }

  log.info('Subscribing to permanent channel "%s"', solo)
  sub.subscribe(solo)

  sub.on('message', wirerouter()
    .on(wire.DeviceRegisteredMessage, function(channel, message) {
      var state = devices.get(message.serial)
      if (state && !state.registered) {
        markRegistered(state, true)
      }
    })
    .handler() as unknown as (...args: never[]) => void)

  function sendAbsent(udid: string) {
    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceAbsentMessage(udid))
    ])
  }

  function clearTimer(state: DeviceState) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  function releasePorts(state: DeviceState) {
    if (state.ports.length) {
      Array.prototype.push.apply(freePorts, state.ports)
      state.ports = []
    }
  }

  function markRegistered(state: DeviceState, viaAck: boolean) {
    if (state.registered || state.removed) {
      return
    }
    state.registered = true
    clearTimer(state)
    if (!viaAck) {
      log.warn(
        'Registration ack for device %s not received in %dms; proceeding anyway'
      , state.label
      , registerTimeout
      )
    }
    startWorker(state)
  }

  function startWorker(state: DeviceState) {
    clearTimer(state)
    if (state.removed || state.retired || state.proc || stopping) {
      return
    }

    if (freePorts.length < PORTS_PER_DEVICE) {
      // Stays registered without a worker; the next poll tries again.
      log.error(
        'No free ports for device %s (need %d, have %d); will retry'
      , state.label
      , PORTS_PER_DEVICE
      , freePorts.length
      )
      return
    }

    state.ports = freePorts.splice(0, PORTS_PER_DEVICE)

    var proc: ChildProcess
    try {
      proc = fork(buildWorkerArgs(options, state.udid, state.ports).map(String))
    }
    catch (err) {
      log.error('Unable to start worker for device %s: %s', state.label, (err as Error).message)
      releasePorts(state)
      state.timer = setTimeout(function() {
        state.timer = null
        startWorker(state)
      }, restartDelay)
      return
    }
    state.proc = proc
    log.info('Started worker for device %s', state.label)

    var done = false
    function finish(code: number | null, signal: NodeJS.Signals | null) {
      if (done) {
        return
      }
      done = true
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      state.proc = null
      releasePorts(state)

      if (state.removed || stopping) {
        return
      }
      if (signal) {
        log.warn(
          'Worker for device %s was killed with signal %s, assuming ' +
          'deliberate action and not restarting'
        , state.label
        , signal
        )
        retire(state)
      }
      else if (code === 0) {
        log.info('Worker for device %s stopped cleanly', state.label)
        retire(state)
      }
      else {
        log.error('Worker for device %s died with code %s', state.label, code)
        log.info('Restarting worker for device %s', state.label)
        state.timer = setTimeout(function() {
          state.timer = null
          startWorker(state)
        }, restartDelay)
      }
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      finish(code, signal)
    }
    function onError(err: Error) {
      log.error('Worker for device %s had an error: %s', state.label, err.message)
    }
    proc.on('exit', onExit)
    proc.on('error', onError)
  }

  function retire(state: DeviceState) {
    state.retired = true
    log.info('Worker for device %s has retired', state.label)
    sendAbsent(state.udid)
  }

  function killWorker(state: DeviceState) {
    var proc = state.proc
    if (!proc) {
      return Promise.resolve()
    }
    if (!state.killed) {
      log.info('Gracefully killing worker for device %s', state.label)
      state.killed = procutil.gracefullyKill(proc, options.killTimeout)
        .catch(function(err: Error) {
          log.error('Worker for device %s did not stop in time: %s', state.label, err.message)
        })
    }
    return state.killed
  }

  function addDevice(udid: string) {
    var state: DeviceState = {
      udid: udid
    , label: '#' + (++counter)
    , ports: []
    , proc: null
    , registered: false
    , removed: false
    , retired: false
    , timer: null
    , killed: null
    }
    devices.set(udid, state)
    log.info('Found device %s (%d tracked)', state.label, devices.size)
    log.debug('Device %s is %s', state.label, udid)

    // Tell others we found a device
    push.send([
      wireutil.global
    , wireutil.envelope(new wire.DeviceIntroductionMessage(
        udid
      , wireutil.toDeviceStatus('device')!
      , new wire.ProviderMessage(solo, options.name)
      , timeutil.now('nano')
      ))
    ])

    state.timer = setTimeout(function() {
      state.timer = null
      markRegistered(state, false)
    }, registerTimeout)
  }

  function removeDevice(state: DeviceState) {
    log.info('Lost device %s', state.label)
    state.removed = true
    clearTimer(state)
    devices.delete(state.udid)
    sendAbsent(state.udid)
    return killWorker(state)
  }

  function poll(): Promise<void> {
    return Promise.resolve(backend.listDevices())
      .then(function(list) {
        if (stopping) {
          return
        }
        var seen = new Set<string>()
        list.forEach(function(summary) {
          if (allowed && !allowed.has(summary.udid)) {
            return
          }
          seen.add(summary.udid)
          if (!devices.has(summary.udid)) {
            addDevice(summary.udid)
          }
        })
        devices.forEach(function(state) {
          if (!seen.has(state.udid)) {
            removeDevice(state)
          }
          else if (state.registered && !state.proc && !state.retired && !state.timer) {
            // Waiting for ports to free up.
            startWorker(state)
          }
        })
      })
      .catch(function(err: Error) {
        log.warn('Unable to list devices: %s', err.message)
      })
  }

  function schedulePoll() {
    if (stopping) {
      return
    }
    pollTimer = setTimeout(function() {
      pollTimer = null
      polling = poll().finally(schedulePoll)
    }, options.pollInterval)
  }

  // Host-wide setup (e.g. the go-ios tunnel agent for iOS 17+). A failure is
  // logged and the provider carries on: simulators, the fake backend and older
  // devices do not need it, and a device that does will fail in its own worker
  // with a specific error, where it is retried, instead of taking every other
  // device on this host down with the provider.
  var prepared: Promise<void> = Promise.resolve()
  if (backend.prepareHost) {
    prepared = Promise.resolve(backend.prepareHost())
      .then(function(handle) {
        if (stopping) {
          return handle.stop().catch(function() {
            return undefined
          })
        }
        hostHandle = handle
        return undefined
      })
      .catch(function(err: Error) {
        log.error('Unable to prepare the host, continuing without: %s', err.message)
      }) as Promise<void>
  }

  prepared.then(function() {
    if (stopping) {
      return
    }
    log.info('Tracking devices')
    polling = poll().finally(schedulePoll)
  })

  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise
    }
    log.info('Shutting down')
    stopping = true
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }

    stopPromise = Promise.all([prepared, polling])
      .then(function() {
        var states = Array.from(devices.values())
        devices.clear()
        return Promise.all(states.map(function(state) {
          state.removed = true
          clearTimer(state)
          sendAbsent(state.udid)
          return killWorker(state)
        }))
      })
      .then(function() {
        var handle = hostHandle
        hostHandle = null
        return handle ? handle.stop() : undefined
      })
      .catch(function(err: Error) {
        log.error('Error while shutting down: %s', err.message)
      })
      .then(function() {
        var socks: {close(): unknown}[] = [push, sub]
        socks.forEach(function(sock) {
          try {
            sock.close()
          }
          catch (err) {
            // No-op
          }
        })
      }) as Promise<void>

    return stopPromise
  }

  lifecycle.observe(stop)

  return {stop: stop}
}
