import {createRequire} from 'module'
import type {Argv} from 'yargs'
import type {CommandArgv} from '../../types/cli.js'
import type {IosBackendOptions} from '../../units/ios-device/types.js'

var require = createRequire(import.meta.url)

var command = 'ios-provider [serial..]'

var describe = 'Start an iOS provider unit.'

var builder = function(yargs: Argv) {
  var os = require('os')
  var ip = require('my-local-ip')

  return yargs
    .strict()
    .positional('serial', {
      describe: 'Only handle devices with these UDIDs.'
    , array: true
    , default: []
    })
    .env('STF_IOS_PROVIDER')
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
      describe: 'How to talk to the devices.'
    , choices: ['goios', 'simulator', 'fake'] as const
    , default: 'goios' as const
    })
    .option('keep-awake-interval', {
      describe: 'Interval in milliseconds for checking the lock state and ' +
        'waking the device. 0 disables.'
    , type: 'number'
    , default: 30000
    })
    .option('kill-timeout', {
      describe: 'How long to wait in milliseconds for a device worker to ' +
        'stop before killing it.'
    , type: 'number'
    , default: 10000
    })
    .option('max-port', {
      describe: 'Highest port number for device workers to use.'
    , type: 'number'
    , default: 7700
    })
    .option('min-port', {
      describe: 'Lowest port number for device workers to use.'
    , type: 'number'
    , default: 7400
    })
    .option('name', {
      alias: 'n'
    , describe: 'An easily identifiable name for the UI and/or log output.'
    , type: 'string'
    , default: os.hostname()
    })
    .option('poll-interval', {
      describe: 'How often in milliseconds to look for added and removed devices.'
    , type: 'number'
    , default: 2000
    })
    .option('public-ip', {
      describe: 'The IP or hostname to use in URLs.'
    , type: 'string'
    , default: ip()
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
    .option('screen-ws-url-pattern', {
      describe: 'The URL pattern to use for the screen WebSocket.'
    , type: 'string'
    , default: 'ws://${publicIp}:${publicPort}'
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
    .epilog('Each option can be be overwritten with an environment variable ' +
      'by converting the option to uppercase, replacing dashes with ' +
      'underscores and prefixing it with `STF_IOS_PROVIDER_` (e.g. ' +
      '`STF_IOS_PROVIDER_NAME`).')
}

var handler = function(argv: CommandArgv<typeof builder, {serial: (string | number)[]}>) {
  function range(from: number, to: number) {
    var items: number[] = []
    for (var i = from; i <= to; ++i) {
      items.push(i)
    }
    return items
  }

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

  return require('../../units/ios-provider/index.js').default({
    name: argv.name
  , publicIp: argv.publicIp
  , endpoints: {
      sub: argv.connectSub
    , push: argv.connectPush
    }
  , ports: range(argv.minPort, argv.maxPort)
  , pollInterval: argv.pollInterval
  , killTimeout: argv.killTimeout
  , groupTimeout: argv.groupTimeout // seconds, the worker CLI converts
  , storageUrl: argv.storageUrl
  , heartbeatInterval: argv.heartbeatInterval
  , screenWsUrlPattern: argv.screenWsUrlPattern
  , screenFrameRate: argv.screenFrameRate
  , screenJpegQuality: argv.screenJpegQuality
  , keepAwakeInterval: argv.keepAwakeInterval
  , backend: argv.iosBackend
  , backendOptions: backendOptions
  , filter: argv.serial.map(String)
  })
}

export {command, describe, builder, handler}
