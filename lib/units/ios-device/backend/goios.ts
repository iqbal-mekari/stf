import fs from 'node:fs'

import logger from '../../../util/logger.js'
import {
  httpStatus
, run
, sleep
, spawnLongRunning
, superviseWda
} from './exec.js'
import type {LongRunning} from './exec.js'
import {readAppInfo} from './info-plist.js'
import type {
  IosBackend
, IosBackendOptions
, IosDeviceInfo
, IosDeviceSummary
, WdaPorts
} from '../types.js'

const log = logger.createLogger('ios-device:backend:goios')

const DEFAULT_WDA_DEVICE_PORT = 8100
const DEFAULT_MJPEG_DEVICE_PORT = 9100
const DEFAULT_TUNNEL_PORT = 60105
const DEFAULT_PAIR_RECORD_PATH = '/Users/Shared/go-ios'

// Verified market names only. Everything else falls back to ProductType.
const MARKET_NAMES: Record<string, string> = {
  'iPad13,1': 'iPad Air (4th generation)'
}

// Extra knobs on top of the shared contract. All optional.
export interface GoIosBackendOptions extends IosBackendOptions {
  tunnelInfoPort?: number
  tunnelReadyTimeout?: number
  tunnelPairRecordPath?: string
  wdaStartTimeout?: number
  wdaPollInterval?: number
  killTimeout?: number
}

interface ListedDevice {
  Udid: string
  ProductName?: string
  ProductType?: string
  ProductVersion?: string
  ConnectionType?: string
}

function parseJson<T>(stdout: string): T {
  const text = stdout.trim()
  try {
    return JSON.parse(text) as T
  }
  catch {
    // Tolerate log noise before the JSON document.
    const start = text.indexOf('{')
    if (start < 0) {
      throw new Error('go-ios returned no JSON')
    }
    return JSON.parse(text.slice(start)) as T
  }
}

function mapConnection(type: string | undefined): IosDeviceSummary['connection'] {
  switch (type) {
    case 'USB':
      return 'usb'
    case 'Network':
      return 'network'
    default:
      return 'unknown'
  }
}

export function createGoIosBackend(opts: GoIosBackendOptions = {}): IosBackend {
  const bin = opts.goIosPath || 'ios'
  const timeout = opts.commandTimeout
  const tunnelPort = opts.tunnelInfoPort ?? DEFAULT_TUNNEL_PORT
  const readyUrl = `http://127.0.0.1:${tunnelPort}/ready`

  const runnerIds = [
    opts.wdaBundleId
  , opts.wdaTestRunnerBundleId
  , opts.wdaXctestConfig
  ]
  const given = runnerIds.filter(Boolean).length
  if (given !== 0 && given !== 3) {
    throw new Error(
      'go-ios: wdaBundleId, wdaTestRunnerBundleId and wdaXctestConfig ' +
      'must be given together or not at all'
    )
  }

  const goios = (args: string[]) => run(bin, args, {timeout})

  async function prepareHost() {
    if (await httpStatus(readyUrl) === 200) {
      log.info('Reusing existing go-ios tunnel agent on port %d', tunnelPort)
      return {stop: async() => undefined}
    }

    // go-ios keeps its own identity in the pair-record dir and the agent exits
    // with "failed to get self identity" when the directory does not exist.
    const pairRecordPath = opts.tunnelPairRecordPath ?? DEFAULT_PAIR_RECORD_PATH
    try {
      fs.mkdirSync(pairRecordPath, {recursive: true})
    }
    catch (err) {
      log.warn('Unable to create go-ios pair record dir: %s', (err as Error).message)
    }

    log.info('Starting go-ios tunnel agent')
    const tunnel = spawnLongRunning(bin, [
      'tunnel', 'start'
    , '--userspace'
    , `--pair-record-path=${pairRecordPath}`
    , `--tunnel-info-port=${tunnelPort}`
    ], {killTimeout: opts.killTimeout})

    const limit = opts.tunnelReadyTimeout ?? 30000
    const deadline = Date.now() + limit
    let died = false
    tunnel.exited.then(() => {
      died = true
    })
    for (;;) {
      if (await httpStatus(readyUrl) === 200) {
        // A concurrently started agent may own the port; either way it is up.
        return {stop: () => tunnel.stop()}
      }
      if (died) {
        throw new Error(
          'go-ios tunnel agent exited before becoming ready: ' +
          tunnel.stderrTail()
        )
      }
      if (Date.now() >= deadline) {
        await tunnel.stop()
        throw new Error(`go-ios tunnel agent not ready within ${limit}ms`)
      }
      await sleep(250)
    }
  }

  async function listDevices(): Promise<IosDeviceSummary[]> {
    const {stdout} = await goios(['list', '--details'])
    const parsed = parseJson<{deviceList?: ListedDevice[]}>(stdout)
    return (parsed.deviceList ?? []).map(device => ({
      udid: device.Udid
    // ProductName is the OS name ("iPhone OS"), not the device name. Use
    // productType as a placeholder; getInfo() supplies the real DeviceName.
    , name: device.ProductType ?? ''
    , productType: device.ProductType ?? ''
    , osVersion: device.ProductVersion ?? ''
    , connection: mapConnection(device.ConnectionType)
    }))
  }

  async function getInfo(udid: string): Promise<IosDeviceInfo> {
    const [infoOut, battery] = await Promise.all([
      goios(['info', `--udid=${udid}`])
    , goios(['batterycheck', `--udid=${udid}`]).then(
        result => parseJson<{
          BatteryCurrentCapacity?: number
          BatteryIsCharging?: boolean
        }>(result.stdout)
      , () => null
      )
    ])
    const info = parseJson<Record<string, string>>(infoOut.stdout)
    const productType = info.ProductType ?? ''
    const result: IosDeviceInfo = {
      udid: info.UniqueDeviceID ?? udid
    , name: info.DeviceName ?? ''
    , productType
    , osVersion: info.ProductVersion ?? ''
    , connection: 'unknown'
    , marketName: MARKET_NAMES[productType] ?? productType
    }
    if (info.BuildVersion) {
      result.buildVersion = info.BuildVersion
    }
    if (battery && typeof battery.BatteryCurrentCapacity === 'number') {
      result.batteryLevel = battery.BatteryCurrentCapacity
      result.batteryCharging = Boolean(battery.BatteryIsCharging)
    }
    return result
  }

  async function startWda(udid: string, ports: WdaPorts) {
    const procOpts = {killTimeout: opts.killTimeout}
    const runnerArgs = given === 3 ?
      [
          `--bundleid=${opts.wdaBundleId}`
        , `--testrunnerbundleid=${opts.wdaTestRunnerBundleId}`
        , `--xctestconfig=${opts.wdaXctestConfig}`
        ] :
      []
    const procs: LongRunning[] = []
    procs.push(spawnLongRunning(bin, [
      'runwda'
    , ...runnerArgs
    , `--udid=${udid}`
    , '--env', `USE_PORT=${DEFAULT_WDA_DEVICE_PORT}`
    , '--env', `MJPEG_SERVER_PORT=${DEFAULT_MJPEG_DEVICE_PORT}`
    ], procOpts))
    procs.push(spawnLongRunning(bin, [
      'forward', String(ports.wdaPort), String(DEFAULT_WDA_DEVICE_PORT)
    , `--udid=${udid}`
    ], procOpts))
    procs.push(spawnLongRunning(bin, [
      'forward', String(ports.mjpegPort), String(DEFAULT_MJPEG_DEVICE_PORT)
    , `--udid=${udid}`
    ], procOpts))

    return superviseWda({
      label: 'goios'
    , procs
    , wdaUrl: `http://127.0.0.1:${ports.wdaPort}`
    , mjpegUrl: `http://127.0.0.1:${ports.mjpegPort}`
    , startTimeout: opts.wdaStartTimeout ?? 120000
    , pollInterval: opts.wdaPollInterval ?? 500
    })
  }

  return {
    name: 'goios'
  , prepareHost
  , listDevices
  , getInfo
  , async install(udid, appPath) {
      await goios(['install', `--path=${appPath}`, `--udid=${udid}`])
    }
  , async uninstall(udid, bundleId) {
      await goios(['uninstall', bundleId, `--udid=${udid}`])
    }
  , async launch(udid, bundleId) {
      await goios(['launch', bundleId, `--udid=${udid}`])
    }
  , async reboot(udid) {
      await goios(['reboot', `--udid=${udid}`])
    }
  , readAppInfo
  , startWda
  }
}
