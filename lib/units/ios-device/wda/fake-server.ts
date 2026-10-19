import http from 'node:http'
import {randomUUID} from 'node:crypto'
import type {AddressInfo, Socket} from 'node:net'

import jpeg from '@julusian/jpeg-turbo'

import type {
  FakeWdaOptions
, FakeWdaRecordedCall
, FakeWdaServer
, WdaScreenInfo
} from '../types.js'

const BOUNDARY = '--BoundaryString'
const FRAME_WIDTH = 200
const DEFAULT_SCREEN: WdaScreenInfo = {width: 820, height: 1180, scale: 2}
const SESSION_PATH = /^\/session\/([^/]+)(\/.*)?$/

function reply(res: http.ServerResponse, status: number, value: unknown, sessionId?: string) {
  const body = JSON.stringify({value: value, sessionId: sessionId ?? null})
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8'
  , 'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

function readBody(req: http.IncomingMessage) {
  return new Promise<unknown>(function(resolve) {
    const chunks: Buffer[] = []
    req.on('data', function(chunk: Buffer) {
      chunks.push(chunk)
    })
    req.on('end', function() {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) {
        return resolve(undefined)
      }
      try {
        resolve(JSON.parse(text))
      }
      catch {
        resolve(undefined)
      }
    })
    req.on('error', function() {
      resolve(undefined)
    })
  })
}

// Solid colour that differs for every frame number, so tests can tell frames
// apart.
function makeFrame(n: number, width: number, height: number) {
  const raw = Buffer.alloc(width * height * 4)
  const r = (n * 67 + 40) % 256
  const g = (n * 109 + 120) % 256
  const b = (n * 31 + 200) % 256
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = r
    raw[i + 1] = g
    raw[i + 2] = b
    raw[i + 3] = 255
  }
  return jpeg.compressSync(raw, {
    format: jpeg.FORMAT_RGBA
  , width: width
  , height: height
  , quality: 70
  , subsampling: jpeg.SAMP_444
  })
}

function listen(server: http.Server, port: number) {
  return new Promise<number>(function(resolve, reject) {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', function() {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

function closeServer(server: http.Server) {
  return new Promise<void>(function(resolve) {
    server.close(function() {
      resolve()
    })
    server.closeAllConnections()
  })
}

export async function startFakeWda(opts?: FakeWdaOptions): Promise<FakeWdaServer> {
  const framerate = opts?.framerate ?? 10
  const sockets = new Set<Socket>()
  const streams = new Set<http.ServerResponse>()
  let session: string | undefined, ticker: NodeJS.Timeout | undefined
  let frameNumber = 0

  const state: FakeWdaServer = {
    wdaUrl: ''
  , mjpegUrl: ''
  , calls: []
  , screen: opts?.screen ? {...opts.screen} : {...DEFAULT_SCREEN}
  , locked: false
  , mjpegPaused: opts?.mjpegPaused ?? false
  , close: close
  }

  function track(server: http.Server) {
    server.on('connection', function(socket) {
      sockets.add(socket)
      socket.on('close', function() {
        sockets.delete(socket)
      })
    })
  }

  function tick() {
    if (state.mjpegPaused) {
      return
    }
    const height = Math.max(
      1
    , Math.round(FRAME_WIDTH * state.screen.height / state.screen.width)
    )
    const data = makeFrame(frameNumber++, FRAME_WIDTH, height)
    const head = Buffer.from(
      BOUNDARY + '\r\nContent-type: image/jpeg\r\nContent-Length: ' +
      data.length + '\r\n\r\n'
    )
    const frame = Buffer.concat([head, data, Buffer.from('\r\n\r\n')])
    for (const res of streams) {
      if (!res.writableNeedDrain) {
        res.write(frame)
      }
    }
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker)
      ticker = undefined
    }
  }

  function route(
    method: string
  , path: string
  ): {status: number, value: unknown, sessionId?: string} {
    const notFound = {status: 404, value: {error: 'unknown command', message: path}}
    let sub = path
    const match = SESSION_PATH.exec(path)
    if (match) {
      if (match[1] !== session) {
        return {
          status: 404
        , value: {error: 'invalid session id', message: 'Session does not exist'}
        }
      }
      if (method === 'DELETE' && !match[2]) {
        session = undefined
        return {status: 200, value: null}
      }
      sub = match[2] ?? ''
    }

    switch (method + ' ' + sub) {
    case 'GET /status':
      return {
        status: 200
      , value: {ready: true, os: {version: '27.0.1'}, message: 'WebDriverAgent is ready'}
      }
    case 'POST /session':
      session = randomUUID()
      return {
        status: 200
      , value: {sessionId: session, capabilities: {}}
      , sessionId: session
      }
    case 'GET /wda/screen':
      return {
        status: 200
      , value: {
          screenSize: {width: state.screen.width, height: state.screen.height}
        , statusBarSize: {width: state.screen.width, height: 24}
        , scale: state.screen.scale
        }
      }
    case 'POST /wda/tap':
    case 'POST /actions':
    case 'POST /wda/keys':
    case 'POST /wda/pressButton':
    case 'POST /appium/settings':
    case 'POST /wda/homescreen':
      return {status: 200, value: null}
    case 'GET /wda/locked':
      return {status: 200, value: state.locked}
    case 'POST /wda/unlock':
      state.locked = false
      return {status: 200, value: null}
    case 'POST /wda/lock':
      state.locked = true
      return {status: 200, value: null}
    case 'GET /screenshot':
      return {
        status: 200
      , value: makeFrame(frameNumber++, 16, 16).toString('base64')
      }
    default:
      return notFound
    }
  }

  const wda = http.createServer(async function(req, res) {
    const method = req.method ?? 'GET'
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const body = await readBody(req)
    const call: FakeWdaRecordedCall = {method: method, path: path}
    if (body !== undefined) {
      call.body = body
    }
    state.calls.push(call)
    const result = route(method, path)
    reply(res, result.status, result.value, result.sessionId)
  })

  const mjpeg = http.createServer(function(req, res) {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=' + BOUNDARY
    , 'Cache-Control': 'no-cache'
    , Connection: 'close'
    })
    streams.add(res)
    res.on('close', function() {
      streams.delete(res)
      if (!streams.size) {
        stopTicker()
      }
    })
    if (!ticker) {
      ticker = setInterval(tick, Math.max(1, Math.round(1000 / framerate)))
    }
    tick()
  })

  track(wda)
  track(mjpeg)

  async function close() {
    stopTicker()
    for (const res of streams) {
      res.destroy()
    }
    streams.clear()
    for (const socket of sockets) {
      socket.destroy()
    }
    await Promise.all([closeServer(wda), closeServer(mjpeg)])
  }

  try {
    const wdaPort = await listen(wda, opts?.wdaPort ?? 0)
    const mjpegPort = await listen(mjpeg, opts?.mjpegPort ?? 0)
    state.wdaUrl = 'http://127.0.0.1:' + wdaPort
    state.mjpegUrl = 'http://127.0.0.1:' + mjpegPort
  }
  catch (err) {
    await close()
    throw err
  }
  return state
}
