// Interfaces shared between the iOS device worker plugins.
import type {EventEmitter} from 'events'

import type {WdaClient, WdaScreenInfo} from '../types.js'

export interface WdaPluginEvents {
  // WebDriverAgent came up again after an exit.
  start: []
  // WebDriverAgent went away; a restart is under way.
  exit: []
}

export interface WdaPlugin extends EventEmitter<WdaPluginEvents> {
  // Stable facade over the current WebDriverAgent client. Calls made while
  // WebDriverAgent is restarting reject.
  client: WdaClient
  mjpegUrl: string
  // Screen size in points, read when WebDriverAgent starts.
  screen: WdaScreenInfo
  isRunning(): boolean
  stop(): Promise<void>
}

export interface IosDisplay {
  id: number
  width: number
  height: number
  rotation: number
  xdpi: number
  ydpi: number
  fps: number
  density: number
  secure: boolean
  url: string
}

export interface IosIdentity {
  serial: string
  platform: string
  manufacturer: string
  operator: string | null
  model: string
  version: string
  abi: string
  sdk: string
  product: string
  cpuPlatform: string | null
  openGLESVersion: string | null
  marketName: string
  display: IosDisplay
  phone: Record<string, string>
}
