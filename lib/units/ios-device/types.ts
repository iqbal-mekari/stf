// Shared contracts for iOS device support.
//
// Every iOS-specific piece (provider, device worker, backends, WebDriverAgent
// client, fakes used in tests) is written against these types, so the parts
// can be developed and tested independently of a physical device.

// --- Device backends --------------------------------------------------------

export type IosBackendName = 'goios' | 'simulator' | 'fake'

export interface IosDeviceSummary {
  udid: string
  // Human readable name as reported by the device. May contain personal data,
  // so it is only used for display and never logged at info level.
  name: string
  productType: string // e.g. iPad13,1
  osVersion: string // e.g. 27.0.1
  connection: 'usb' | 'network' | 'simulator' | 'unknown'
}

export interface IosDeviceInfo extends IosDeviceSummary {
  marketName: string // e.g. iPad Air (4th generation); falls back to productType
  buildVersion?: string
  // Battery level 0..100 when the backend can read it.
  batteryLevel?: number
  batteryCharging?: boolean
}

export interface IosAppInfo {
  bundleId: string
  name?: string
  version?: string
}

export interface WdaPorts {
  // Host ports the WebDriverAgent HTTP and MJPEG servers must be reachable on.
  wdaPort: number
  mjpegPort: number
}

export interface WdaHandle {
  wdaUrl: string // e.g. http://127.0.0.1:8100
  mjpegUrl: string // e.g. http://127.0.0.1:9100
  // Resolves when WDA (and any port forwarding) exits for any reason.
  exited: Promise<void>
  stop(): Promise<void>
}

export interface HostServiceHandle {
  stop(): Promise<void>
}

export interface IosBackend {
  readonly name: IosBackendName
  // Optional host-wide setup run once by the provider before any worker
  // starts, e.g. the go-ios tunnel agent required for iOS 17+.
  prepareHost?(): Promise<HostServiceHandle>
  listDevices(): Promise<IosDeviceSummary[]>
  getInfo(udid: string): Promise<IosDeviceInfo>
  install(udid: string, appPath: string): Promise<void>
  uninstall(udid: string, bundleId: string): Promise<void>
  launch(udid: string, bundleId: string): Promise<void>
  reboot(udid: string): Promise<void>
  // Reads bundle metadata from a local .ipa or .app without touching a device.
  readAppInfo(appPath: string): Promise<IosAppInfo>
  // Starts WebDriverAgent on the device and makes it reachable on the given
  // host ports. Must not resolve before the HTTP endpoint answers /status.
  startWda(udid: string, ports: WdaPorts): Promise<WdaHandle>
}

export interface IosBackendOptions {
  // go-ios binary (goios backend).
  goIosPath?: string
  // WebDriverAgent runner bundle ids on real devices (goios backend).
  wdaBundleId?: string
  wdaTestRunnerBundleId?: string
  wdaXctestConfig?: string
  // Prebuilt WebDriverAgent for simulators (simulator backend), the
  // directory containing the .xctestrun produced by build-for-testing.
  wdaSimulatorBuildDir?: string
  // Fake backend: number of fake devices to expose.
  fakeDeviceCount?: number
  // Upper bound for any single backend command.
  commandTimeout?: number
}

// --- WebDriverAgent client ---------------------------------------------------

export interface WdaScreenInfo {
  // Logical size in points and the points->pixels scale.
  width: number
  height: number
  scale: number
}

export type WdaButton = 'home' | 'volumeup' | 'volumedown'

export interface WdaStreamSettings {
  framerate?: number
  quality?: number
  scalingFactor?: number
}

export interface WdaPointerStep {
  // Coordinates in points.
  x: number
  y: number
  // Milliseconds since the previous step of the same pointer.
  delayMs: number
}

export interface WdaGesturePointer {
  steps: WdaPointerStep[]
}

export interface WdaClient {
  readonly baseUrl: string
  status(): Promise<{ready: boolean, osVersion?: string}>
  ensureSession(): Promise<string>
  screen(): Promise<WdaScreenInfo>
  tap(x: number, y: number): Promise<void>
  // One entry per finger, replayed with W3C pointer actions.
  gesture(pointers: WdaGesturePointer[]): Promise<void>
  typeText(text: string): Promise<void>
  pressButton(button: WdaButton): Promise<void>
  homescreen(): Promise<void>
  isLocked(): Promise<boolean>
  unlock(): Promise<void>
  setStreamSettings(settings: WdaStreamSettings): Promise<void>
  screenshotPng(): Promise<Buffer>
}

// --- Fake WebDriverAgent (tests and the fake backend) ---------------------

export interface FakeWdaRecordedCall {
  method: string
  path: string
  body?: unknown
}

export interface FakeWdaServer {
  wdaUrl: string
  mjpegUrl: string
  calls: FakeWdaRecordedCall[]
  // Logical screen size in points, and scale. Defaults to an iPad Air 4.
  screen: WdaScreenInfo
  locked: boolean
  // While true the MJPEG server keeps connections open but sends no frames,
  // like a real WebDriverAgent that cannot take screenshots.
  mjpegPaused: boolean
  close(): Promise<void>
}

export interface FakeWdaOptions {
  // 0 lets the OS choose.
  wdaPort?: number
  mjpegPort?: number
  framerate?: number
  screen?: WdaScreenInfo
  mjpegPaused?: boolean
}

// --- Worker options ---------------------------------------------------------

export interface IosDeviceOptions {
  serial: string // the device UDID
  provider: string
  publicIp: string
  endpoints: {
    sub: string[]
    push: string[]
  }
  groupTimeout: number
  storageUrl: string
  heartbeatInterval: number
  screenPort: number
  screenWsUrlPattern: string
  screenPingInterval: number
  screenFrameRate: number
  screenJpegQuality: number
  wdaPort: number
  mjpegPort: number
  backend: IosBackendName
  backendOptions: IosBackendOptions
  // How often to check the lock state and wake the device. 0 disables.
  keepAwakeInterval: number
  // Whether to go back to the home screen when a user releases the device.
  screenReset?: boolean
  // Switch from MJPEG to screenshot polling when no MJPEG frame arrives for
  // this long (ms).
  screenFallbackTimeout?: number
  // Upper bound for the screenshot polling frame rate.
  screenPollFrameRate?: number
  // How often to try MJPEG again while polling (ms). 0 never retries.
  screenMjpegRetryInterval?: number
  // How often to read the battery state (ms). 0 disables.
  batteryInterval?: number
  // Consecutive WebDriverAgent start failures before the worker gives up.
  wdaMaxFailures?: number
  // Initial WebDriverAgent restart delay (ms), doubled on every failure.
  wdaRestartDelay?: number
}

export interface IosProviderOptions {
  name: string
  publicIp: string
  endpoints: {
    sub: string[]
    push: string[]
  }
  ports: number[]
  pollInterval: number
  killTimeout: number
  groupTimeout: number
  storageUrl: string
  heartbeatInterval: number
  screenWsUrlPattern: string
  screenFrameRate: number
  screenJpegQuality: number
  keepAwakeInterval: number
  backend: IosBackendName
  backendOptions: IosBackendOptions
  // Only manage these UDIDs when non-empty.
  filter: string[]
  // Command used to spawn device workers (defaults to this stf CLI).
  workerCommand?: string
}
