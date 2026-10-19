import fs from 'node:fs'
import path from 'node:path'

import {run, spawnLongRunning, superviseWda} from './exec.js'
import {extractIpa, isIpa, readAppInfo} from './info-plist.js'
import type {
  IosBackend
, IosBackendOptions
, IosDeviceInfo
, IosDeviceSummary
, WdaPorts
} from '../types.js'

interface SimDevice {
  udid: string
  name: string
  state: string
  deviceTypeIdentifier?: string
  isAvailable?: boolean
}

export interface SimulatorBackendOptions extends IosBackendOptions {
  wdaStartTimeout?: number
  wdaPollInterval?: number
  killTimeout?: number
}

const RUNTIME_RE = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/

export function createSimulatorBackend(opts: SimulatorBackendOptions = {}): IosBackend {
  const timeout = opts.commandTimeout
  const simctl = (args: string[]) => run('xcrun', ['simctl', ...args], {timeout})

  async function listInfo(): Promise<IosDeviceInfo[]> {
    const {stdout} = await simctl(['list', 'devices', 'booted', '-j'])
    const parsed = JSON.parse(stdout) as {devices?: Record<string, SimDevice[]>}
    const result: IosDeviceInfo[] = []
    for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
      const match = RUNTIME_RE.exec(runtime)
      if (!match) {
        continue
      }
      const osVersion = (match[1] ?? '').replace(/-/g, '.')
      for (const device of devices) {
        if (device.state !== 'Booted') {
          continue
        }
        const productType = (device.deviceTypeIdentifier ?? '').split('.').pop() ?? ''
        result.push({
          udid: device.udid
        , name: device.name
        , productType
        , osVersion
        , connection: 'simulator'
        , marketName: device.name
        })
      }
    }
    return result
  }

  async function listDevices(): Promise<IosDeviceSummary[]> {
    return listInfo()
  }

  async function getInfo(udid: string): Promise<IosDeviceInfo> {
    const found = (await listInfo()).find(device => device.udid === udid)
    if (!found) {
      throw new Error('Simulator is not booted: ' + udid)
    }
    return found
  }

  async function install(udid: string, appPath: string) {
    if (!isIpa(appPath)) {
      await simctl(['install', udid, appPath])
      return
    }
    const extracted = await extractIpa(appPath)
    try {
      await simctl(['install', udid, extracted.appPath])
    }
    finally {
      extracted.cleanup()
    }
  }

  async function startWda(udid: string, ports: WdaPorts) {
    const dir = opts.wdaSimulatorBuildDir
    if (!dir) {
      throw new Error('wdaSimulatorBuildDir is required to run WDA on a simulator')
    }
    const xctestrun = fs.existsSync(dir) ?
      fs.readdirSync(dir).sort().find(name => name.endsWith('.xctestrun')) :
      undefined
    if (!xctestrun) {
      throw new Error('No .xctestrun found in ' + dir)
    }
    // DEVELOPER_DIR, when set, is inherited from the environment.
    const proc = spawnLongRunning('xcodebuild', [
      'test-without-building'
    , '-xctestrun', path.join(dir, xctestrun)
    , '-destination', `id=${udid}`
    ], {
      env: {
        TEST_RUNNER_USE_PORT: String(ports.wdaPort)
      , TEST_RUNNER_MJPEG_SERVER_PORT: String(ports.mjpegPort)
      }
    , killTimeout: opts.killTimeout
    })
    return superviseWda({
      label: 'simulator'
    , procs: [proc]
    , wdaUrl: `http://127.0.0.1:${ports.wdaPort}`
    , mjpegUrl: `http://127.0.0.1:${ports.mjpegPort}`
    , startTimeout: opts.wdaStartTimeout ?? 120000
    , pollInterval: opts.wdaPollInterval ?? 500
    })
  }

  return {
    name: 'simulator'
  , listDevices
  , getInfo
  , install
  , async uninstall(udid, bundleId) {
      await simctl(['uninstall', udid, bundleId])
    }
  , async launch(udid, bundleId) {
      await simctl(['launch', udid, bundleId])
    }
  , async reboot(udid) {
      await simctl(['shutdown', udid])
      await simctl(['boot', udid])
    }
  , readAppInfo
  , startWda
  }
}
