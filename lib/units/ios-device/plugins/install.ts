import fs from 'fs'
import os from 'os'
import path from 'path'
import {Readable} from 'stream'
import {pipeline} from 'stream/promises'

import syrup from '@devicefarmer/stf-syrup'

import logger from '../../../util/logger.js'
import wire from '../../../wire/index.js'
import wireutil from '../../../wire/util.js'
import type {Router, ZmqSocket} from '../../../types/device-plugins.js'
import routerSyrup from '../../device/support/router.js'
import pushSyrup from '../../device/support/push.js'
import backendSyrup from '../support/backend.js'
import type {IosBackend, IosDeviceOptions} from '../types.js'
import {errorMessage} from '../util.js'

const DOWNLOAD_TIMEOUT = 5 * 60000
const INSTALL_TIMEOUT = 5 * 60000
const LAUNCH_TIMEOUT = 30000

class TimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise
  , new Promise<never>(function(resolve, reject) {
      timer = setTimeout(function() {
        reject(new TimeoutError(what + ' timed out'))
      }, ms)
    })
  ])
    .finally(function() {
      clearTimeout(timer)
    })
}

export default syrup.serial()
  .dependency(backendSyrup)
  .dependency(routerSyrup)
  .dependency(pushSyrup)
  .define(function(
    options: IosDeviceOptions
  , backend: IosBackend
  , router: Router
  , push: ZmqSocket
  ) {
    const log = logger.createLogger('ios-device:plugins:install')

    async function download(href: string, target: string, progress: (n: number) => void) {
      const res = await fetch(new URL(href, options.storageUrl), {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT)
      })
      if (!res.ok || !res.body) {
        throw new Error('Download failed with HTTP ' + res.status)
      }
      const length = Number(res.headers.get('content-length')) || 0
      let received = 0
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      body.on('data', function(chunk: Buffer) {
        received += chunk.length
        if (length) {
          progress(Math.min(1, received / length))
        }
      })
      await pipeline(body, fs.createWriteStream(target))
    }

    router.on(wire.InstallMessage, function(channel, message) {
      const reply = wireutil.reply(options.serial)

      function sendProgress(data: string, progress: number) {
        push.send([
          channel
        , reply.progress(data, progress)
        ])
      }

      log.info('Installing app from "%s"', message.href)

      ;(async function() {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'stf-ios-install-'))
        try {
          const app = path.join(dir, 'app.ipa')

          // Same progress phases as Android: transfer up to 50%, install
          // up to 90%, launch at 90%.
          sendProgress('pushing_app', 0)
          let lastStep = 0
          await download(message.href, app, function(fraction) {
            const step = Math.floor(fraction * 10)
            if (step > lastStep) {
              lastStep = step
              sendProgress('pushing_app', 50 * fraction)
            }
          })

          let guess = 50
          sendProgress('installing_app', guess)
          const ticker = setInterval(function() {
            guess = Math.min(90, guess + (90 - guess) / 10)
            sendProgress('installing_app', guess)
          }, 1000)
          try {
            await withTimeout(backend.install(options.serial, app), INSTALL_TIMEOUT, 'Install')
          }
          finally {
            clearInterval(ticker)
          }

          if (message.launch) {
            const info = await backend.readAppInfo(app)
            log.info('Launching "%s"', info.bundleId)
            sendProgress('launching_app', 90)
            await withTimeout(
              backend.launch(options.serial, info.bundleId)
            , LAUNCH_TIMEOUT
            , 'Launch'
            )
          }
        }
        finally {
          await fs.promises.rm(dir, {recursive: true, force: true})
        }
      })()
        .then(function() {
          push.send([
            channel
          , reply.okay('INSTALL_SUCCEEDED')
          ])
        })
        .catch(function(err) {
          log.error('Installation failed: %s', errorMessage(err, options.serial))
          push.send([
            channel
          , reply.fail(err instanceof TimeoutError ?
              'INSTALL_ERROR_TIMEOUT' :
              'INSTALL_ERROR_UNKNOWN')
          ])
        })
    })

    router.on(wire.UninstallMessage, function(channel, message) {
      const reply = wireutil.reply(options.serial)
      log.info('Uninstalling "%s"', message.packageName)

      backend.uninstall(options.serial, message.packageName)
        .then(function() {
          push.send([
            channel
          , reply.okay('success')
          ])
        })
        .catch(function(err) {
          log.error('Uninstallation failed: %s', errorMessage(err, options.serial))
          push.send([
            channel
          , reply.fail('fail')
          ])
        })
    })
  })
