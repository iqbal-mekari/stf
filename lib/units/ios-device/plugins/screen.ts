import syrup from '@devicefarmer/stf-syrup'
import WebSocket, {WebSocketServer} from 'ws'

import logger from '../../../util/logger.js'
import lifecycle from '../../../util/lifecycle.js'
import {IosFrameProducer} from '../screen/producer.js'
import identitySyrup from './identity.js'
import wdaSyrup from './wda.js'
import type {IosDeviceOptions, WdaStreamSettings} from '../types.js'
import type {IosIdentity, WdaPlugin} from './types.js'
import {errorMessage} from '../util.js'

const DEFAULT_FALLBACK_TIMEOUT = 5000
const DEFAULT_POLL_FRAME_RATE = 2
const DEFAULT_MJPEG_RETRY_INTERVAL = 60000
// Skip frames for a client that has this much still queued, so a slow
// connection gets the newest image instead of an ever growing backlog.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024

export interface IosScreenPlugin {
  producer: IosFrameProducer
  port: number
  close(): Promise<void>
}

export default syrup.serial()
  .dependency(wdaSyrup)
  .dependency(identitySyrup)
  .define(function(
    options: IosDeviceOptions
  , wda: WdaPlugin
  , identity: IosIdentity
  ): Promise<IosScreenPlugin> {
    const log = logger.createLogger('ios-device:plugins:screen')
    const producer = new IosFrameProducer({
      mjpegUrl: function() {
        return wda.mjpegUrl
      }
    , screenshot: function() {
        return wda.client.screenshotPng()
      }
    }, {
      fallbackTimeout: options.screenFallbackTimeout ?? DEFAULT_FALLBACK_TIMEOUT
    , pollFrameRate: options.screenPollFrameRate ?? DEFAULT_POLL_FRAME_RATE
    , mjpegRetryInterval: options.screenMjpegRetryInterval ??
        DEFAULT_MJPEG_RETRY_INTERVAL
    })
    const viewers = new Set<WebSocket>()

    const banner = {
      version: 1
    , length: 24
    , pid: process.pid
    , realWidth: identity.display.width
    , realHeight: identity.display.height
    , virtualWidth: identity.display.width
    , virtualHeight: identity.display.height
    , orientation: 0
    , quirks: {
        dumb: false
      , alwaysUpright: false
      , tear: false
      }
    }

    function applyStreamSettings() {
      const settings: WdaStreamSettings = {quality: options.screenJpegQuality}
      if (options.screenFrameRate > 0) {
        settings.framerate = options.screenFrameRate
      }
      wda.client.setStreamSettings(settings).catch(function(err) {
        log.warn('Unable to apply MJPEG settings: %s', errorMessage(err))
      })
    }

    applyStreamSettings()

    wda.on('start', function() {
      applyStreamSettings()
      producer.restart()
    })

    producer.on('frame', function(frame) {
      for (const ws of viewers) {
        if (ws.readyState === WebSocket.OPEN &&
            ws.bufferedAmount < MAX_BUFFERED_BYTES) {
          ws.send(frame, {binary: true})
        }
      }
    })

    function startViewing(ws: WebSocket) {
      if (!viewers.has(ws)) {
        viewers.add(ws)
        producer.start()
      }
    }

    function stopViewing(ws: WebSocket) {
      if (viewers.delete(ws) && !viewers.size) {
        producer.stop()
      }
    }

    const wss = new WebSocketServer({
      port: options.screenPort
    , perMessageDeflate: false
    })

    wss.on('connection', function(ws) {
      const sendText = function(text: string) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(text)
        }
      }
      const pingTimer = setInterval(function() {
        sendText('ping')
      }, options.screenPingInterval)

      sendText('start ' + JSON.stringify(banner))

      ws.on('message', function(data) {
        const text = data.toString()
        if (text === 'on') {
          sendText('start ' + JSON.stringify(banner))
          startViewing(ws)
        }
        else if (text === 'off') {
          stopViewing(ws)
        }
        else if (/^size \d+x\d+$/.test(text)) {
          // WebDriverAgent always sends full size images.
        }
      })

      ws.on('close', function() {
        clearInterval(pingTimer)
        stopViewing(ws)
      })

      ws.on('error', function(err) {
        log.debug('Screen client error: %s', err.message)
      })
    })

    function close() {
      producer.stop()
      return new Promise<void>(function(resolve) {
        for (const ws of wss.clients) {
          ws.terminate()
        }
        wss.close(function() {
          resolve()
        })
      })
    }

    lifecycle.observe(close)

    return new Promise<IosScreenPlugin>(function(resolve, reject) {
      wss.once('error', reject)
      wss.once('listening', function() {
        wss.off('error', reject)
        wss.on('error', function(err) {
          log.error('Screen WebSocket server error: %s', err.message)
        })
        const address = wss.address()
        const port = address && typeof address === 'object' ? address.port : options.screenPort
        log.info('Screen WebSocket listening on port %d', port)
        resolve({producer: producer, port: port, close: close})
      })
    })
  })
