import cp from 'node:child_process'
import net from 'node:net'
import type {AddressInfo} from 'node:net'

import {expect} from 'chai'
import zmq from 'zeromq/v5-compat.js'

import wire from '../../lib/wire/index.js'
import wireutil from '../../lib/wire/util.js'

const SERIAL = '00000000-FAKE00000000001'

function freePort() {
  return new Promise<number>(function(resolve, reject) {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', function() {
      const port = (server.address() as AddressInfo).port
      server.close(function() {
        resolve(port)
      })
    })
  })
}

interface Received {
  type: number
  message: Buffer
}

describe('ios-device worker process', function() {
  this.timeout(60000)

  let worker: cp.ChildProcess | undefined
   , pull: ReturnType<typeof zmq.socket>, pub: ReturnType<typeof zmq.socket>
  const received: Received[] = []
  const waiters: Array<() => void> = []

  function waitFor(predicate: (entry: Received) => boolean, timeout: number) {
    return new Promise<Received>(function(resolve, reject) {
      const deadline = setTimeout(function() {
        reject(new Error('Timed out waiting for a message'))
      }, timeout)
      function check() {
        const found = received.find(predicate)
        if (found) {
          clearTimeout(deadline)
          resolve(found)
          return true
        }
        return false
      }
      if (!check()) {
        waiters.push(function poll() {
          if (!check()) {
            waiters.push(poll)
          }
        })
      }
    })
  }

  before(async function() {
    const [pullPort, pubPort, screenPort, wdaPort, mjpegPort] = await Promise.all([
      freePort()
    , freePort()
    , freePort()
    , freePort()
    , freePort()
    ])

    pull = zmq.socket('pull')
    pull.bindSync('tcp://127.0.0.1:' + pullPort)
    pull.on('message', function(channel: Buffer, data: Buffer) {
      const envelope = wire.Envelope.decode(data)
      received.push({type: envelope.type, message: envelope.message as Buffer})
      waiters.splice(0).forEach(function(fn) {
        fn()
      })
    })

    pub = zmq.socket('pub')
    pub.bindSync('tcp://127.0.0.1:' + pubPort)

    worker = cp.spawn('./bin/stf', [
      'ios-device'
    , '--serial', SERIAL
    , '--provider', 'test-provider'
    , '--public-ip', '127.0.0.1'
    , '--connect-push', 'tcp://127.0.0.1:' + pullPort
    , '--connect-sub', 'tcp://127.0.0.1:' + pubPort
    , '--storage-url', 'http://127.0.0.1:1/'
    , '--heartbeat-interval', '200'
    , '--screen-port', String(screenPort)
    , '--wda-port', String(wdaPort)
    , '--mjpeg-port', String(mjpegPort)
    , '--battery-interval', '0'
    , '--keep-awake-interval', '0'
    , '--ios-backend', 'fake'
    ], {stdio: 'ignore'})
  })

  after(function(done) {
    pull.close()
    pub.close()
    if (!worker || worker.exitCode !== null) {
      done()
      return
    }
    worker.once('exit', function() {
      done()
    })
    worker.kill('SIGTERM')
  })

  it('sends heartbeats', async function() {
    const entry = await waitFor(function(e) {
      return e.type === wire.MessageType.DeviceHeartbeatMessage
    }, 30000)
    expect(wire.DeviceHeartbeatMessage.decode(entry.message).serial).to.equal(SERIAL)
  })

  it('becomes ready once WebDriverAgent is up', async function() {
    const entry = await waitFor(function(e) {
      return e.type === wire.MessageType.DeviceReadyMessage
    }, 30000)
    const ready = wire.DeviceReadyMessage.decode(entry.message)
    expect(ready.serial).to.equal(SERIAL)
    expect(ready.channel).to.be.a('string').and.not.empty
  })

  it('answers a probe with an iOS identity', async function() {
    const ready = wire.DeviceReadyMessage.decode((await waitFor(function(e) {
      return e.type === wire.MessageType.DeviceReadyMessage
    }, 30000)).message)

    // A SUB socket only sees messages published after it joined, so keep
    // probing until the answer arrives.
    const probe = setInterval(function() {
      pub.send([ready.channel, wireutil.envelope(new wire.ProbeMessage())])
    }, 200)
    try {
      const entry = await waitFor(function(e) {
        return e.type === wire.MessageType.DeviceIdentityMessage
      }, 20000)
      const identity = wire.DeviceIdentityMessage.decode(entry.message)
      expect(identity.serial).to.equal(SERIAL)
      expect(identity.platform).to.equal('iOS')
      expect(identity.manufacturer).to.equal('Apple')
      expect(identity.model).to.equal('iPad Air (4th generation)')
      expect(identity.version).to.equal('27.0.1')
      expect(identity.sdk).to.equal('27')
      expect(identity.product).to.equal('iPad13,1')
      expect(identity.display.width).to.equal(1640)
      expect(identity.display.height).to.equal(2360)
      expect(identity.display.density).to.equal(2)
      expect(identity.display.url).to.match(/^ws:\/\/127\.0\.0\.1:\d+$/)
    }
    finally {
      clearInterval(probe)
    }
  })

  it('exits cleanly on SIGTERM', function(done) {
    worker!.once('exit', function(code, signal) {
      expect(code === 0 || signal === 'SIGTERM').to.equal(true)
      done()
    })
    worker!.kill('SIGTERM')
  })
})
