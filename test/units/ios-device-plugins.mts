import events from 'node:events'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import type {Readable} from 'node:stream'

import {expect} from 'chai'
import sinon from 'sinon'

import wire from '../../lib/wire/index.js'
import createRouter from '../../lib/wire/router.js'
import lifecycle from '../../lib/util/lifecycle.js'
import {createFakeBackend} from '../../lib/units/ios-device/backend/fake.js'
import {startFakeWda} from '../../lib/units/ios-device/wda/fake-server.js'
import {createWdaClient} from '../../lib/units/ios-device/wda/client.js'
import wdaSyrup from '../../lib/units/ios-device/plugins/wda.js'
import identitySyrup from '../../lib/units/ios-device/plugins/identity.js'
import soloSyrup from '../../lib/units/ios-device/plugins/solo.js'
import groupSyrup from '../../lib/units/ios-device/plugins/group.js'
import inputSyrup from '../../lib/units/ios-device/plugins/input.js'
import installSyrup from '../../lib/units/ios-device/plugins/install.js'
import captureSyrup from '../../lib/units/ios-device/plugins/capture.js'
import rebootSyrup from '../../lib/units/ios-device/plugins/reboot.js'
import batterySyrup, {toBatteryEvent} from '../../lib/units/ios-device/plugins/battery.js'
import keepAwakeSyrup from '../../lib/units/ios-device/plugins/keep-awake.js'
import unsupportedSyrup, {
  NOT_SUPPORTED
, UNSUPPORTED_TRANSACTIONS
} from '../../lib/units/ios-device/plugins/unsupported.js'
import type {FakeBackend} from '../../lib/units/ios-device/backend/fake.js'
import type {
  FakeWdaServer
, IosDeviceOptions
, WdaHandle
, WdaPorts
} from '../../lib/units/ios-device/types.js'
import type {IosIdentity, WdaPlugin} from '../../lib/units/ios-device/plugins/types.js'

const SERIAL = '00000000-FAKE00000000001'

type Sent = {channel: string, type: number, message: Buffer}

function capturePush() {
  const sent: Sent[] = []
  return {
    sent: sent
  , send: function(parts: Array<string | Buffer>) {
      const envelope = wire.Envelope.decode(parts[1] as Buffer)
      sent.push({
        channel: String(parts[0])
      , type: envelope.type
      , message: envelope.message as Buffer
      })
    }
  }
}

function done(sent: Sent[]) {
  return sent
    .filter(function(s) {
      return s.type === wire.MessageType.TransactionDoneMessage
    })
    .map(function(s) {
      return wire.TransactionDoneMessage.decode(s.message)
    })
}

function eventually(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  return new Promise<void>(function(resolve, reject) {
    (function poll() {
      if (check()) {
        resolve()
      }
      else if (Date.now() > deadline) {
        reject(new Error('Condition not met in time'))
      }
      else {
        setTimeout(poll, 10)
      }
    })()
  })
}

function baseOptions(overrides?: Partial<IosDeviceOptions>): IosDeviceOptions {
  return Object.assign({
    serial: SERIAL
  , provider: 'test'
  , publicIp: '127.0.0.1'
  , endpoints: {sub: [], push: []}
  , groupTimeout: 1000
  , storageUrl: 'http://127.0.0.1:1/'
  , heartbeatInterval: 10000
  , screenPort: 7400
  , screenWsUrlPattern: 'ws://${publicIp}:${publicPort}'
  , screenPingInterval: 30000
  , screenFrameRate: 10
  , screenJpegQuality: 80
  , wdaPort: 0
  , mjpegPort: 0
  , backend: 'fake'
  , backendOptions: {}
  , keepAwakeInterval: 0
  , wdaRestartDelay: 10
  , wdaMaxFailures: 3
  }, overrides)
}

// The fake backend, with WebDriverAgent servers the test can inspect, kill
// and make fail.
function testBackend() {
  const base = createFakeBackend({fakeDeviceCount: 1})
  const servers: FakeWdaServer[] = []
  const kills: Array<() => Promise<void>> = []
  const state = {starts: 0, failNext: 0}
  const backend: FakeBackend = Object.assign({}, base, {
    startWda: async function(udid: string, ports: WdaPorts): Promise<WdaHandle> {
      state.starts += 1
      if (state.failNext > 0) {
        state.failNext -= 1
        throw new Error('WDA failed for ' + udid)
      }
      const server = await startFakeWda({wdaPort: ports.wdaPort, mjpegPort: ports.mjpegPort})
      servers.push(server)
      let markExited: () => void = () => undefined
      const exited = new Promise<void>(function(resolve) {
        markExited = resolve
      })
      const stop = function() {
        return server.close().then(markExited)
      }
      kills.push(stop)
      return {
        wdaUrl: server.wdaUrl
      , mjpegUrl: server.mjpegUrl
      , exited: exited
      , stop: stop
      }
    }
  })
  return {
    backend: backend
  , servers: servers
  , state: state
  , kill: function() {
      return kills[kills.length - 1]!()
    }
  }
}

// A WdaPlugin stand-in over a fake WDA server.
async function wdaStub() {
  const server = await startFakeWda()
  const plugin = Object.assign(new events.EventEmitter(), {
    client: createWdaClient(server.wdaUrl)
  , mjpegUrl: server.mjpegUrl
  , screen: {...server.screen}
  , isRunning: function() {
      return true
    }
  , stop: function() {
      return server.close()
    }
  }) as unknown as WdaPlugin
  return {server: server, wda: plugin}
}

function calls(server: FakeWdaServer, path: RegExp) {
  return server.calls.filter(function(call) {
    return path.test(call.path)
  })
}

describe('iOS device worker plugins', function() {
  this.timeout(10000)

  let fatal: sinon.SinonStub

  beforeEach(function() {
    sinon.stub(lifecycle, 'observe')
    fatal = sinon.stub(lifecycle, 'fatal')
  })

  afterEach(function() {
    sinon.restore()
  })

  describe('wda', function() {
    let plugin: WdaPlugin | undefined

    afterEach(async function() {
      await plugin?.stop()
      plugin = undefined
    })

    it('resolves only once WebDriverAgent runs, retrying failed starts', async function() {
      const t = testBackend()
      t.state.failNext = 2
      plugin = await wdaSyrup.invoke(baseOptions(), t.backend)
      expect(t.state.starts).to.equal(3)
      expect(plugin!.isRunning()).to.equal(true)
      expect(plugin!.screen).to.eql({width: 820, height: 1180, scale: 2})
      await plugin!.client.tap(1, 2)
      expect(calls(t.servers[0]!, /\/wda\/tap$/)).to.have.length(1)
    })

    it('gives up after the configured number of failed starts', async function() {
      const t = testBackend()
      t.state.failNext = 10
      let error: Error | undefined
      try {
        await wdaSyrup.invoke(baseOptions({wdaMaxFailures: 3}), t.backend)
      }
      catch (err) {
        error = err as Error
      }
      expect(error).to.be.an('error')
      expect(t.state.starts).to.equal(3)
    })

    it('restarts WebDriverAgent after it exits', async function() {
      const t = testBackend()
      plugin = await wdaSyrup.invoke(baseOptions(), t.backend)
      const exited = events.once(plugin!, 'exit')
      const started = events.once(plugin!, 'start')
      await t.kill()
      await exited
      expect(plugin!.isRunning()).to.equal(false)
      let rejected = false
      await plugin!.client.homescreen().catch(function() {
        rejected = true
      })
      expect(rejected).to.equal(true)
      await started
      expect(t.state.starts).to.equal(2)
      await plugin!.client.homescreen()
      expect(calls(t.servers[1]!, /homescreen/)).to.have.length(1)
      expect(fatal.called).to.equal(false)
    })

    it('exits the worker when WebDriverAgent cannot be restarted', async function() {
      const t = testBackend()
      plugin = await wdaSyrup.invoke(baseOptions({wdaMaxFailures: 2}), t.backend)
      t.state.failNext = 10
      await t.kill()
      await eventually(function() {
        return fatal.called
      })
      expect(t.state.starts).to.equal(3)
    })
  })

  describe('identity and solo', function() {
    async function identity() {
      const stub = await wdaStub()
      const ident: IosIdentity = await identitySyrup.invoke(
        baseOptions()
      , createFakeBackend({fakeDeviceCount: 1})
      , stub.wda
      )
      await stub.server.close()
      return ident
    }

    it('describes the device as iOS with a pixel display', async function() {
      const ident = await identity()
      expect(ident.platform).to.equal('iOS')
      expect(ident.manufacturer).to.equal('Apple')
      expect(ident.model).to.equal('iPad Air (4th generation)')
      expect(ident.marketName).to.equal('iPad Air (4th generation)')
      expect(ident.product).to.equal('iPad13,1')
      expect(ident.version).to.equal('27.0.1')
      expect(ident.sdk).to.equal('27')
      expect(ident.abi).to.equal('arm64')
      expect(ident.display.width).to.equal(1640)
      expect(ident.display.height).to.equal(2360)
      expect(ident.display.density).to.equal(2)
      expect(ident.display.url).to.equal('ws://127.0.0.1:7400')
      // The user-chosen device name stays out of the identity.
      expect(JSON.stringify(ident)).to.not.contain('Fake iPad')
    })

    it('answers probes and pokes ready', async function() {
      const ident = await identity()
      const push = capturePush()
      const sub = {subscribe: sinon.spy()}
      const router = createRouter()
      const solo = soloSyrup.invoke(baseOptions(), sub, push, router, ident)

      expect(sub.subscribe.calledWith(solo.channel)).to.equal(true)
      router.emit(wire.ProbeMessage.$code, 'channel', new wire.ProbeMessage())
      expect(push.sent).to.have.length(1)
      expect(push.sent[0]!.type).to.equal(wire.MessageType.DeviceIdentityMessage)
      const message = wire.DeviceIdentityMessage.decode(push.sent[0]!.message)
      expect(message.platform).to.equal('iOS')
      expect(message.display.url).to.equal('ws://127.0.0.1:7400')

      solo.poke()
      expect(push.sent[1]!.type).to.equal(wire.MessageType.DeviceReadyMessage)
      expect(wire.DeviceReadyMessage.decode(push.sent[1]!.message).channel)
        .to.equal(solo.channel)
    })
  })

  describe('group', function() {
    async function setup() {
      const stub = await wdaStub()
      const push = capturePush()
      const router = createRouter()
      const sub = {subscribe: sinon.spy(), unsubscribe: sinon.spy()}
      const channels = Object.assign(new events.EventEmitter(), {
        register: sinon.spy()
      , unregister: sinon.spy()
      , keepalive: sinon.spy()
      })
      const plugin = groupSyrup.invoke(
        baseOptions()
      , {channel: 'solo-channel'}
      , {serial: SERIAL, platform: 'iOS'}
      , stub.wda
      , router
      , push
      , sub
      , channels
      )
      return {
        server: stub.server
      , push: push
      , router: router
      , channels: channels
      , plugin: plugin
      , owner: new wire.OwnerMessage('a@example.com', 'a', 'group-channel')
      }
    }

    it('joins, unlocks the device and reports it', async function() {
      const s = await setup()
      s.server.locked = true
      s.router.emit(
        wire.GroupMessage.$code
      , 'tx'
      , new wire.GroupMessage(s.owner, 1000, [], null)
      )
      await eventually(function() {
        return done(s.push.sent).length > 0 && !s.server.locked
      })
      expect(done(s.push.sent)[0]!.success).to.equal(true)
      expect(s.push.sent.some(function(m) {
        return m.type === wire.MessageType.JoinGroupMessage
      })).to.equal(true)
      expect(calls(s.server, /\/wda\/unlock$/)).to.have.length(1)
      expect(s.channels.register.calledWith('group-channel')).to.equal(true)
      await s.server.close()
    })

    it('goes home when the user leaves', async function() {
      const s = await setup()
      await s.plugin.join(s.owner, 1000, null)
      s.router.emit(wire.UngroupMessage.$code, 'tx', new wire.UngroupMessage([]))
      await eventually(function() {
        return calls(s.server, /homescreen/).length > 0
      })
      const leave = s.push.sent.find(function(m) {
        return m.type === wire.MessageType.LeaveGroupMessage
      })!
      expect(wire.LeaveGroupMessage.decode(leave.message).reason).to.equal('ungroup_request')
      await s.server.close()
    })

    it('releases the reservation when the group channel times out', async function() {
      const s = await setup()
      await s.plugin.join(s.owner, 1000, null)
      s.channels.emit('timeout', 'group-channel')
      await eventually(function() {
        return s.push.sent.some(function(m) {
          return m.type === wire.MessageType.LeaveGroupMessage
        })
      })
      const leave = s.push.sent.find(function(m) {
        return m.type === wire.MessageType.LeaveGroupMessage
      })!
      expect(wire.LeaveGroupMessage.decode(leave.message).reason).to.equal('automatic_timeout')
      await eventually(function() {
        return calls(s.server, /homescreen/).length > 0
      })
      await s.server.close()
    })
  })

  describe('input', function() {
    it('maps keys and text to WebDriverAgent', async function() {
      const stub = await wdaStub()
      const push = capturePush()
      const router = createRouter()
      const input = inputSyrup.invoke(baseOptions(), stub.wda, router, push)

      router.emit(wire.KeyPressMessage.$code, 'c', new wire.KeyPressMessage('home'))
      router.emit(wire.KeyPressMessage.$code, 'c', new wire.KeyPressMessage('volume_up'))
      router.emit(wire.KeyDownMessage.$code, 'c', new wire.KeyDownMessage('volume_down'))
      router.emit(wire.KeyUpMessage.$code, 'c', new wire.KeyUpMessage('volume_down'))
      router.emit(wire.KeyDownMessage.$code, 'c', new wire.KeyDownMessage('enter'))
      router.emit(wire.KeyDownMessage.$code, 'c', new wire.KeyDownMessage('del'))
      router.emit(wire.KeyPressMessage.$code, 'c', new wire.KeyPressMessage('menu'))
      router.emit(wire.TypeMessage.$code, 'c', new wire.TypeMessage('hello'))
      await input.idle()

      const actions = stub.server.calls
        .filter(function(call) {
          return !/^\/(session|status)$/.test(call.path)
        })
        .map(function(call) {
          return call.path.replace(/^\/session\/[^/]+/, '') + ' ' + JSON.stringify(call.body)
        })
      expect(actions).to.eql([
        '/wda/homescreen {}'
      , '/wda/pressButton {"name":"volumeup"}'
      , '/wda/pressButton {"name":"volumedown"}'
      , '/wda/keys {"value":["\\n"]}'
      , '/wda/keys {"value":["\\b"]}'
      , '/wda/keys {"value":["hello"]}'
      ])
      await stub.server.close()
    })

    it('types pasted text and replies', async function() {
      const stub = await wdaStub()
      const push = capturePush()
      const router = createRouter()
      inputSyrup.invoke(baseOptions(), stub.wda, router, push)
      router.emit(wire.PasteMessage.$code, 'tx', new wire.PasteMessage('pasted'))
      await eventually(function() {
        return done(push.sent).length > 0
      })
      expect(done(push.sent)[0]!.success).to.equal(true)
      expect(calls(stub.server, /\/wda\/keys$/)[0]!.body).to.eql({value: ['pasted']})
      await stub.server.close()
    })
  })

  describe('install', function() {
    let server: http.Server, origin: string
    const ipa = Buffer.from('PK fake ipa')

    before(function(next) {
      server = http.createServer(function(req, res) {
        if (req.url === '/s/apk/app.ipa') {
          res.setHeader('Content-Length', ipa.length)
          res.end(ipa)
        }
        else {
          res.statusCode = 404
          res.end()
        }
      })
      server.listen(0, '127.0.0.1', function() {
        origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/'
        next()
      })
    })

    after(function(next) {
      server.close(next)
    })

    function install(backend: FakeBackend, href: string, launch: boolean) {
      const push = capturePush()
      const router = createRouter()
      installSyrup.invoke(baseOptions({storageUrl: origin}), backend, router, push)
      router.emit(wire.InstallMessage.$code, 'tx', new wire.InstallMessage(
        href
      , launch
      , JSON.stringify({application: {launcherActivities: [], activities: {}}, ios: true})
      ))
      return eventually(function() {
        return done(push.sent).length > 0
      }).then(function() {
        return push.sent
      })
    }

    it('installs without launching', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      const sent = await install(backend, '/s/apk/app.ipa', false)
      const reply = done(sent)[0]!
      expect(reply.success).to.equal(true)
      expect(reply.data).to.equal('INSTALL_SUCCEEDED')
      expect(backend.log.map(function(e) {
        return e.op
      })).to.eql(['install'])
      expect(backend.log[0]!.arg).to.match(/\.ipa$/)
      expect(sent.some(function(m) {
        return m.type === wire.MessageType.TransactionProgressMessage
      })).to.equal(true)
    })

    it('installs and launches the bundle', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      const sent = await install(backend, '/s/apk/app.ipa', true)
      expect(done(sent)[0]!.success).to.equal(true)
      expect(backend.log.map(function(e) {
        return e.op + ':' + (e.op === 'launch' ? e.arg : '')
      })).to.eql(['install:', 'launch:dev.fake.app'])
    })

    it('reports a failed install', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      backend.install = function() {
        return Promise.reject(new Error('nope'))
      }
      const reply = done(await install(backend, '/s/apk/app.ipa', true))[0]!
      expect(reply.success).to.equal(false)
      expect(reply.data).to.equal('INSTALL_ERROR_UNKNOWN')
    })

    it('reports a failed download', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      const reply = done(await install(backend, '/s/apk/missing.ipa', false))[0]!
      expect(reply.success).to.equal(false)
      expect(backend.log).to.have.length(0)
    })

    it('uninstalls by bundle id', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      const push = capturePush()
      const router = createRouter()
      installSyrup.invoke(baseOptions(), backend, router, push)
      router.emit(wire.UninstallMessage.$code, 'tx', new wire.UninstallMessage('com.example.app'))
      await eventually(function() {
        return done(push.sent).length > 0
      })
      expect(done(push.sent)[0]!.success).to.equal(true)
      expect(backend.log).to.eql([{op: 'uninstall', udid: SERIAL, arg: 'com.example.app'}])
    })
  })

  describe('screenshot', function() {
    it('stores a WebDriverAgent screenshot and replies with the file', async function() {
      const stub = await wdaStub()
      const push = capturePush()
      const router = createRouter()
      const stored: Array<{type: string, size: number, contentType: string}> = []
      const storage = {
        store: function(type: string, stream: Readable, meta: {contentType: string}) {
          return new Promise(function(resolve) {
            let size = 0
            stream.on('data', function(chunk: Buffer) {
              size += chunk.length
            })
            stream.on('end', function() {
              stored.push({type: type, size: size, contentType: meta.contentType})
              resolve({href: '/s/image/x/screenshot.png', id: 'x'})
            })
          })
        }
      }
      captureSyrup.invoke(baseOptions(), stub.wda, router, push, storage)
      router.emit(wire.ScreenCaptureMessage.$code, 'tx', new wire.ScreenCaptureMessage())
      await eventually(function() {
        return done(push.sent).length > 0
      })
      const reply = done(push.sent)[0]!
      expect(reply.success).to.equal(true)
      expect(JSON.parse(reply.body!).href).to.equal('/s/image/x/screenshot.png')
      expect(stored).to.have.length(1)
      expect(stored[0]!.type).to.equal('image')
      expect(stored[0]!.contentType).to.equal('image/png')
      expect(stored[0]!.size).to.be.above(0)
      expect(calls(stub.server, /^\/screenshot$/)).to.have.length(1)
      await stub.server.close()
    })
  })

  describe('reboot', function() {
    it('reboots through the backend', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      const push = capturePush()
      const router = createRouter()
      rebootSyrup.invoke(baseOptions(), backend, router, push)
      router.emit(wire.RebootMessage.$code, 'tx', new wire.RebootMessage())
      await eventually(function() {
        return done(push.sent).length > 0
      })
      expect(done(push.sent)[0]!.success).to.equal(true)
      expect(backend.log).to.eql([{op: 'reboot', udid: SERIAL}])
    })

    it('reports a failed reboot without the UDID', async function() {
      const backend = createFakeBackend({fakeDeviceCount: 1})
      backend.reboot = function(udid: string) {
        return Promise.reject(new Error('cannot reboot ' + udid))
      }
      const push = capturePush()
      const router = createRouter()
      rebootSyrup.invoke(baseOptions(), backend, router, push)
      router.emit(wire.RebootMessage.$code, 'tx', new wire.RebootMessage())
      await eventually(function() {
        return done(push.sent).length > 0
      })
      const reply = done(push.sent)[0]!
      expect(reply.success).to.equal(false)
      expect(reply.data).to.equal('cannot reboot <udid>')
    })
  })

  describe('battery', function() {
    it('maps the battery state to the Android vocabulary', function() {
      const info = {
        udid: SERIAL
      , name: 'x'
      , productType: 'iPad13,1'
      , osVersion: '27.0'
      , connection: 'usb' as const
      , marketName: 'iPad'
      }
      expect(toBatteryEvent(SERIAL, info)).to.equal(null)
      const charging = toBatteryEvent(SERIAL, {...info, batteryLevel: 42.4, batteryCharging: true})!
      expect([charging.status, charging.source, charging.level, charging.scale])
        .to.eql(['charging', 'usb', 42, 100])
      expect(toBatteryEvent(SERIAL, {...info, batteryLevel: 100, batteryCharging: true})!.status)
        .to.equal('full')
      expect(toBatteryEvent(SERIAL, {...info, batteryLevel: 80, batteryCharging: false})!.status)
        .to.equal('discharging')
    })

    it('sends a battery event only when it changes', async function() {
      const push = capturePush()
      const battery = batterySyrup.invoke(
        baseOptions({batteryInterval: 0})
      , createFakeBackend({fakeDeviceCount: 1})
      , push
      )
      await battery.check()
      await battery.check()
      expect(push.sent).to.have.length(1)
      expect(push.sent[0]!.type).to.equal(wire.MessageType.BatteryEvent)
      const event = wire.BatteryEvent.decode(push.sent[0]!.message)
      expect([event.status, event.level, event.scale]).to.eql(['full', 100, 100])
      battery.stop()
    })
  })

  describe('keep-awake', function() {
    it('unlocks a locked device', async function() {
      const stub = await wdaStub()
      stub.server.locked = true
      const keepAwake = keepAwakeSyrup.invoke(baseOptions({keepAwakeInterval: 20}), stub.wda)
      await eventually(function() {
        return !stub.server.locked
      })
      expect(calls(stub.server, /\/wda\/unlock$/)).to.have.length(1)
      keepAwake.stop()
      await stub.server.close()
    })

    it('does nothing when disabled', async function() {
      const stub = await wdaStub()
      stub.server.locked = true
      const keepAwake = keepAwakeSyrup.invoke(baseOptions({keepAwakeInterval: 0}), stub.wda)
      await new Promise(function(resolve) {
        setTimeout(resolve, 60)
      })
      expect(stub.server.calls).to.have.length(0)
      keepAwake.stop()
      await stub.server.close()
    })
  })

  describe('unsupported messages', function() {
    UNSUPPORTED_TRANSACTIONS.forEach(function(name) {
      it('fails ' + name + ' immediately', function() {
        const push = capturePush()
        const router = createRouter()
        unsupportedSyrup.invoke(baseOptions(), router, push)
        router.emit((wire as unknown as Record<string, {$code: number}>)[name]!.$code, 'tx', {})
        const replies = done(push.sent)
        expect(replies).to.have.length(1)
        expect(push.sent[0]!.channel).to.equal('tx')
        expect(replies[0]!.success).to.equal(false)
        expect(replies[0]!.data).to.equal(NOT_SUPPORTED)
      })
    })

    it('ignores one-way messages without replying', function() {
      const push = capturePush()
      const router = createRouter()
      unsupportedSyrup.invoke(baseOptions(), router, push)
      router.emit(wire.RotateMessage.$code, 'c', new wire.RotateMessage(90))
      expect(push.sent).to.have.length(0)
    })
  })
})
