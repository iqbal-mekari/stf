import {createRequire} from 'module'
import type {Argv} from 'yargs'
import type {CommandArgv} from '../../types/cli.js'
import type {IosBackendOptions} from '../../units/ios-device/types.js'

var require = createRequire(import.meta.url)

var command = 'ios-device'

var describe = 'Start an iOS device unit.'

var builder = function(yargs: Argv) {
  return yargs
    .strict()
    .option('battery-interval', {
      describe: 'Interval in milliseconds for reading the battery state. 0 disables.'
    , type: 'number'
    , default: 60000
    })
    .option('command-timeout', {
      describe: 'Upper bound in milliseconds for any single backend command.'
    , type: 'number'
    })
    .option('connect-push', {
      alias: 'p'
    , describe: 'Device-side ZeroMQ PULL endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('connect-sub', {
      alias: 's'
    , describe: 'Device-side ZeroMQ PUB endpoint to connect to.'
    , array: true
    , demand: true
    })
    .option('fake-device-count', {
      describe: 'Number of fake devices (fake backend).'
    , type: 'number'
    })
    .option('go-ios-path', {
      describe: 'Path to the go-ios binary (goios backend).'
    , type: 'string'
    })
    .option('group-timeout', {
      alias: 't'
    , describe: 'Timeout in seconds for automatic release of inactive devices.'
    , type: 'number'
    , default: 900
    })
    .option('heartbeat-interval', {
      describe: 'Send interval in milliseconds for heartbeat messages.'
    , type: 'number'
    , default: 10000
    })
    .option('ios-backend', {
      describe: 'How to talk to the device.'
    , choices: ['goios', 'simulator', 'fake'] as const
    , default: 'goios' as const
    })
    .option('keep-awake-interval', {
      describe: 'Interval in milliseconds for checking the lock state and ' +
        'waking the device. 0 disables.'
    , type: 'number'
    , default: 30000
    })
    .option('mjpeg-port', {
      describe: 'Host port for the WebDriverAgent MJPEG server.'
    , type: 'number'
    , demand: true
    })
    .option('provider', {
      alias: 'n'
    , describe: 'Name of the provider.'
    , type: 'string'
    , demand: true
    })
    .option('public-ip', {
      describe: 'The IP or hostname to use in URLs.'
    , type: 'string'
    , demand: true
    })
    .option('screen-fallback-timeout', {
      describe: 'Switch to screenshot polling when no MJPEG frame arrives ' +
        'for this many milliseconds.'
    , type: 'number'
    , default: 5000
    })
    .option('screen-frame-rate', {
      describe: 'The frame rate (frames/s) of the screen stream.'
    , type: 'number'
    , default: 10
    })
    .option('screen-jpeg-quality', {
      describe: 'The JPG quality to use for the screen.'
    , type: 'number'
    , default: 80
    })
    .option('screen-mjpeg-retry-interval', {
      describe: 'Interval in milliseconds for trying MJPEG again while ' +
        'polling screenshots. 0 never retries.'
    , type: 'number'
    , default: 60000
    })
    .option('screen-ping-interval', {
      describe: 'The interval at which to send ping messages to keep the ' +
        'screen WebSocket alive.'
    , type: 'number'
    , default: 30000
    })
    .option('screen-poll-frame-rate', {
      describe: 'Upper bound for the screenshot polling frame rate.'
    , type: 'number'
    , default: 2
    })
    .option('screen-port', {
      describe: 'Port allocated to the screen WebSocket.'
    , type: 'number'
    , demand: true
    })
    .option('screen-reset', {
      describe: 'Go back to home screen when user releases device. ' +
        'Negate with --no-screen-reset.'
    , type: 'boolean'
    , default: true
    })
    .option('screen-ws-url-pattern', {
      describe: 'The URL pattern to use for the screen WebSocket.'
    , type: 'string'
    , default: 'ws://${publicIp}:${publicPort}'
    })
    .option('serial', {
      describe: 'The UDID of the device.'
    , type: 'string'
    , demand: true
    })
    .option('storage-url', {
      alias: 'r'
    , describe: 'The URL to the storage unit.'
    , type: 'string'
    , demand: true
    })
    .option('wda-bundle-id', {
      describe: 'WebDriverAgent runner bundle id (goios backend).'
    , type: 'string'
    })
    .option('wda-max-failures', {
      describe: 'Consecutive WebDriverAgent start failures before giving up.'
    , type: 'number'
    , default: 5
    })
    .option('wda-port', {
      describe: 'Host port for the WebDriverAgent HTTP server.'
    , type: 'number'
    , demand: true
    })
    .option('wda-restart-delay', {
      describe: 'Initial WebDriverAgent restart delay in milliseconds, ' +
        'doubled on every failure.'
    , type: 'number'
    , default: 1000
    })
    .option('wda-simulator-build-dir', {
      describe: 'Directory with the prebuilt WebDriverAgent .xctestrun (simulator backend).'
    , type: 'string'
    })
    .option('wda-test-runner-bundle-id', {
      describe: 'WebDriverAgent test runner bundle id (goios backend).'
    , type: 'string'
    })
    .option('wda-xctest-config', {
      describe: 'WebDriverAgent xctest configuration name (goios backend).'
    , type: 'string'
    })
}

var handler = function(argv: CommandArgv<typeof builder>) {
  var backendOptions: IosBackendOptions = {}
  if (argv.goIosPath !== undefined) {
    backendOptions.goIosPath = argv.goIosPath
  }
  if (argv.wdaBundleId !== undefined) {
    backendOptions.wdaBundleId = argv.wdaBundleId
  }
  if (argv.wdaTestRunnerBundleId !== undefined) {
    backendOptions.wdaTestRunnerBundleId = argv.wdaTestRunnerBundleId
  }
  if (argv.wdaXctestConfig !== undefined) {
    backendOptions.wdaXctestConfig = argv.wdaXctestConfig
  }
  if (argv.wdaSimulatorBuildDir !== undefined) {
    backendOptions.wdaSimulatorBuildDir = argv.wdaSimulatorBuildDir
  }
  if (argv.fakeDeviceCount !== undefined) {
    backendOptions.fakeDeviceCount = argv.fakeDeviceCount
  }
  if (argv.commandTimeout !== undefined) {
    backendOptions.commandTimeout = argv.commandTimeout
  }

  return require('../../units/ios-device/index.js').default({
    serial: argv.serial
  , provider: argv.provider
  , publicIp: argv.publicIp
  , endpoints: {
      sub: argv.connectSub
    , push: argv.connectPush
    }
  , groupTimeout: argv.groupTimeout * 1000 // change to ms
  , storageUrl: argv.storageUrl
  , heartbeatInterval: argv.heartbeatInterval
  , screenPort: argv.screenPort
  , screenWsUrlPattern: argv.screenWsUrlPattern
  , screenPingInterval: argv.screenPingInterval
  , screenFrameRate: argv.screenFrameRate
  , screenJpegQuality: argv.screenJpegQuality
  , screenReset: argv.screenReset
  , screenFallbackTimeout: argv.screenFallbackTimeout
  , screenPollFrameRate: argv.screenPollFrameRate
  , screenMjpegRetryInterval: argv.screenMjpegRetryInterval
  , batteryInterval: argv.batteryInterval
  , wdaPort: argv.wdaPort
  , mjpegPort: argv.mjpegPort
  , wdaMaxFailures: argv.wdaMaxFailures
  , wdaRestartDelay: argv.wdaRestartDelay
  , keepAwakeInterval: argv.keepAwakeInterval
  , backend: argv.iosBackend
  , backendOptions: backendOptions
  })
}

export {command, describe, builder, handler}
