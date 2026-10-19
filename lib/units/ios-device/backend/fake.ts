import path from 'node:path'

import {startFakeWda} from '../wda/fake-server.js'
import type {
  IosAppInfo
, IosBackend
, IosBackendOptions
, IosDeviceInfo
, IosDeviceSummary
, WdaHandle
, WdaPorts
} from '../types.js'

export interface FakeBackendLogEntry {
  op: 'install' | 'uninstall' | 'launch' | 'reboot'
  udid: string
  // App path for install, bundle id for uninstall and launch.
  arg?: string
}

export interface FakeBackend extends IosBackend {
  // Every install, uninstall, launch and reboot, in call order.
  readonly log: FakeBackendLogEntry[]
}

const STATUS_TIMEOUT_MS = 5000

function fakeUdid(n: number) {
  return '00000000-FAKE' + String(n).padStart(11, '0')
}

async function waitForStatus(wdaUrl: string) {
  const deadline = Date.now() + STATUS_TIMEOUT_MS
  for (;;) {
    try {
      const res = await fetch(wdaUrl + '/status', {signal: AbortSignal.timeout(1000)})
      if (res.ok) {
        return
      }
    }
    catch {
      // Not answering yet.
    }
    if (Date.now() > deadline) {
      throw new Error('Fake WDA did not answer /status in time')
    }
    await new Promise(function(resolve) {
      setTimeout(resolve, 50)
    })
  }
}

export function createFakeBackend(opts?: IosBackendOptions): FakeBackend {
  const count = Math.max(0, opts?.fakeDeviceCount ?? 1)
  const devices: IosDeviceSummary[] = []
  for (let n = 1; n <= count; n++) {
    devices.push({
      udid: fakeUdid(n)
    , name: 'Fake iPad ' + n
    , productType: 'iPad13,1'
    , osVersion: '27.0.1'
    , connection: 'usb'
    })
  }
  const log: FakeBackendLogEntry[] = []

  function require(udid: string) {
    const device = devices.find(function(d) {
      return d.udid === udid
    })
    if (!device) {
      throw new Error('Unknown fake device ' + udid)
    }
    return device
  }

  return {
    name: 'fake'
  , log: log

  , async listDevices() {
      return devices.map(function(d) {
        return {...d}
      })
    }

  , async getInfo(udid: string): Promise<IosDeviceInfo> {
      return {
        ...require(udid)
      , marketName: 'iPad Air (4th generation)'
      , batteryLevel: 100
      , batteryCharging: true
      }
    }

  , async install(udid: string, appPath: string) {
      require(udid)
      log.push({op: 'install', udid: udid, arg: appPath})
    }

  , async uninstall(udid: string, bundleId: string) {
      require(udid)
      log.push({op: 'uninstall', udid: udid, arg: bundleId})
    }

  , async launch(udid: string, bundleId: string) {
      require(udid)
      log.push({op: 'launch', udid: udid, arg: bundleId})
    }

  , async reboot(udid: string) {
      require(udid)
      log.push({op: 'reboot', udid: udid})
    }

  , async readAppInfo(appPath: string): Promise<IosAppInfo> {
      return {bundleId: 'dev.fake.' + path.basename(appPath, path.extname(appPath))}
    }

  , async startWda(udid: string, ports: WdaPorts): Promise<WdaHandle> {
      require(udid)
      const server = await startFakeWda({
        wdaPort: ports.wdaPort
      , mjpegPort: ports.mjpegPort
      })
      try {
        await waitForStatus(server.wdaUrl)
      }
      catch (err) {
        await server.close()
        throw err
      }

      let markExited: () => void = () => undefined
      const exited = new Promise<void>(function(resolve) {
        markExited = resolve
      })
      let stopping: Promise<void> | undefined
      return {
        wdaUrl: server.wdaUrl
      , mjpegUrl: server.mjpegUrl
      , exited: exited
      , stop() {
          if (!stopping) {
            stopping = server.close().finally(markExited)
          }
          return stopping
        }
      }
    }
  }
}
