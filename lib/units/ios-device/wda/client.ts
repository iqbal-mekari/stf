import logger from '../../../util/logger.js'
import type {
  WdaButton
, WdaClient
, WdaGesturePointer
, WdaScreenInfo
, WdaStreamSettings
} from '../types.js'

const DEFAULT_TIMEOUT_MS = 10000

// Carries only the method, path and status. Request bodies are never included
// because they may hold typed text.
class WdaHttpError extends Error {
  status: number
  errorCode?: string

  constructor(method: string, path: string, status: number, errorCode?: string) {
    super('WDA ' + method + ' ' + path + ' failed with HTTP ' + status +
      (errorCode ? ' (' + errorCode + ')' : ''))
    this.name = 'WdaHttpError'
    this.status = status
    if (errorCode) {
      this.errorCode = errorCode
    }
  }
}

interface WdaEnvelope {
  value?: unknown
  sessionId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isInvalidSession(err: unknown) {
  return err instanceof WdaHttpError &&
    err.status === 404 &&
    err.errorCode === 'invalid session id'
}

function buildActions(pointers: WdaGesturePointer[]) {
  return pointers.map(function(pointer, index) {
    const actions: Record<string, unknown>[] = []
    pointer.steps.forEach(function(step, stepIndex) {
      if (stepIndex === 0) {
        actions.push({
          type: 'pointerMove'
        , duration: 0
        , x: step.x
        , y: step.y
        , origin: 'viewport'
        })
        actions.push({type: 'pointerDown', button: 0})
      }
      else {
        actions.push({
          type: 'pointerMove'
        , duration: step.delayMs
        , x: step.x
        , y: step.y
        , origin: 'viewport'
        })
      }
    })
    actions.push({type: 'pointerUp', button: 0})
    return {
      type: 'pointer'
    , id: 'finger' + (index + 1)
    , parameters: {pointerType: 'touch'}
    , actions: actions
    }
  })
}

export function createWdaClient(
  baseUrl: string
, opts?: {timeoutMs?: number}
): WdaClient {
  const log = logger.createLogger('ios-device:wda:client')
  const root = baseUrl.replace(/\/+$/, '')
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let sessionId: string | undefined, pendingSession: Promise<string> | undefined

  async function request(method: string, path: string, body?: unknown) {
    const init: RequestInit = {
      method: method
    , signal: AbortSignal.timeout(timeoutMs)
    }
    if (body !== undefined) {
      init.headers = {'Content-Type': 'application/json'}
      init.body = JSON.stringify(body)
    }

    let res: Response, text: string
    try {
      res = await fetch(root + path, init)
      text = await res.text()
    }
    catch (err) {
      const name = err instanceof Error ? err.name : 'Error'
      throw new Error('WDA ' + method + ' ' + path + ' failed: ' + name)
    }

    let parsed: WdaEnvelope = {}
    try {
      const json: unknown = JSON.parse(text)
      if (isRecord(json)) {
        parsed = json as WdaEnvelope
      }
    }
    catch {
      // Non-JSON body, handled below by status.
    }

    if (!res.ok) {
      const value = parsed.value
      const code = isRecord(value) && typeof value.error === 'string' ?
        value.error :
        undefined
      throw new WdaHttpError(method, path, res.status, code)
    }
    return parsed
  }

  async function createSession() {
    const reply = await request('POST', '/session', {
      capabilities: {alwaysMatch: {}}
    })
    const value = reply.value
    const id = isRecord(value) && typeof value.sessionId === 'string' ?
      value.sessionId :
      reply.sessionId
    if (typeof id !== 'string' || !id) {
      throw new Error('WDA POST /session returned no session id')
    }
    sessionId = id
    log.debug('WDA session established')
    return id
  }

  function ensureSession() {
    if (sessionId) {
      return Promise.resolve(sessionId)
    }
    if (!pendingSession) {
      pendingSession = createSession().finally(function() {
        pendingSession = undefined
      })
    }
    return pendingSession
  }

  async function sessionRequest(method: string, sub: string, body?: unknown) {
    const id = await ensureSession()
    try {
      return await request(method, '/session/' + id + sub, body)
    }
    catch (err) {
      if (!isInvalidSession(err)) {
        throw err
      }
      if (sessionId === id) {
        sessionId = undefined
      }
      const fresh = await ensureSession()
      return await request(method, '/session/' + fresh + sub, body)
    }
  }

  return {
    baseUrl: root

  , async status() {
      const reply = await request('GET', '/status')
      const value = isRecord(reply.value) ? reply.value : {}
      const os = isRecord(value.os) ? value.os : {}
      const result: {ready: boolean, osVersion?: string} = {
        ready: value.ready === true
      }
      if (typeof os.version === 'string') {
        result.osVersion = os.version
      }
      return result
    }

  , ensureSession: ensureSession

  , async screen(): Promise<WdaScreenInfo> {
      const reply = await request('GET', '/wda/screen')
      const value = isRecord(reply.value) ? reply.value : {}
      const size = isRecord(value.screenSize) ? value.screenSize : {}
      if (typeof size.width !== 'number' || typeof size.height !== 'number') {
        throw new Error('WDA GET /wda/screen returned no screen size')
      }
      return {
        width: size.width
      , height: size.height
      , scale: typeof value.scale === 'number' ? value.scale : 1
      }
    }

  , async tap(x: number, y: number) {
      await sessionRequest('POST', '/wda/tap', {x: x, y: y})
    }

  , async gesture(pointers: WdaGesturePointer[]) {
      await sessionRequest('POST', '/actions', {actions: buildActions(pointers)})
    }

  , async typeText(text: string) {
      await sessionRequest('POST', '/wda/keys', {value: [text]})
    }

  , async pressButton(button: WdaButton) {
      await sessionRequest('POST', '/wda/pressButton', {name: button})
    }

  , async homescreen() {
      await request('POST', '/wda/homescreen', {})
    }

  , async isLocked() {
      const reply = await request('GET', '/wda/locked')
      return reply.value === true
    }

  , async unlock() {
      await request('POST', '/wda/unlock', {})
    }

  , async setStreamSettings(settings: WdaStreamSettings) {
      const mapped: Record<string, number> = {}
      if (settings.framerate !== undefined) {
        mapped.mjpegServerFramerate = settings.framerate
      }
      if (settings.quality !== undefined) {
        mapped.mjpegServerScreenshotQuality = settings.quality
      }
      if (settings.scalingFactor !== undefined) {
        mapped.mjpegScalingFactor = settings.scalingFactor
      }
      await sessionRequest('POST', '/appium/settings', {settings: mapped})
    }

  , async screenshotPng() {
      const reply = await request('GET', '/screenshot')
      if (typeof reply.value !== 'string') {
        throw new Error('WDA GET /screenshot returned no image')
      }
      return Buffer.from(reply.value, 'base64')
    }
  }
}
