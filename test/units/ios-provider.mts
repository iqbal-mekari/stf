import events from 'node:events'

import {expect} from 'chai'
import sinon from 'sinon'
import type {ChildProcess} from 'node:child_process'

import wire from '../../lib/wire/index.js'
import wireutil from '../../lib/wire/util.js'
import iosProvider, {buildWorkerArgs} from '../../lib/units/ios-provider/index.js'
import type {IosProviderDeps} from '../../lib/units/ios-provider/index.js'
import type {
  IosBackend
, IosDeviceSummary
, IosProviderOptions
} from '../../lib/units/ios-device/types.js'

var POLL = 10
var REGISTER = 80
var RESTART = 30

function udid(n: number) {
  return 'TEST-UDID-' + n
}

function summary(n: number): IosDeviceSummary {
  return {
    udid: udid(n)
  , name: 'Test device ' + n
  , productType: 'iPad13,1'
  , osVersion: '27.0'
  , connection: 'usb'
  }
}

function sleep(ms: number) {
  return new Promise<void>(function(resolve) {
    setTimeout(resolve, ms)
  })
}

async function until(check: () => boolean, ms = 2000) {
  var deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition')
    }
    await sleep(5)
  }
}

class FakeProc extends events.EventEmitter {
  pid = 1234
  killed: (string | number | undefined)[] = []
  autoExit = true

  kill(signal?: string | number) {
    this.killed.push(signal)
    if (this.autoExit) {
      setImmediate(this.emit.bind(this, 'exit', null, signal))
    }
    return true
  }
}

interface Env {
  options: IosProviderOptions
  devices: IosDeviceSummary[]
  procs: FakeProc[]
  forks: string[][]
  sent: {channel: string, type: number, message: Buffer}[]
  sub: events.EventEmitter & {subscribe: sinon.SinonSpy, close: sinon.SinonSpy}
  backend: IosBackend
  deps: IosProviderDeps
  register: (n: number) => void
  provider?: ReturnType<typeof iosProvider>
}

function setup(over?: {
  options?: Partial<IosProviderOptions>
, backend?: Partial<IosBackend>
, deps?: IosProviderDeps
}): Env {
  var devices: IosDeviceSummary[] = []
  var procs: FakeProc[] = []
  var forks: string[][] = []
  var sent: Env['sent'] = []
  var sub = Object.assign(new events.EventEmitter(), {
    subscribe: sinon.spy()
  , close: sinon.spy()
  })
  var push = {
    send: function(msg: unknown[]) {
      var env = wire.Envelope.decode(msg[1] as Buffer)
      sent.push({channel: msg[0] as string, type: env.type, message: env.message})
    }
  , close: sinon.spy()
  }
  var backend = Object.assign({
    name: 'fake'
  , listDevices: function() {
      return Promise.resolve(devices.slice())
    }
  }, over?.backend) as unknown as IosBackend
  var options: IosProviderOptions = Object.assign({
    name: 'test-provider'
  , publicIp: '10.0.0.1'
  , endpoints: {sub: ['tcp://sub:1'], push: ['tcp://push:1']}
  , ports: [9000, 9001, 9002, 9003, 9004, 9005, 9006]
  , pollInterval: POLL
  , killTimeout: 200
  , groupTimeout: 900
  , storageUrl: 'http://storage/'
  , heartbeatInterval: 10000
  , screenWsUrlPattern: 'ws://${publicIp}:${publicPort}'
  , screenFrameRate: 10
  , screenJpegQuality: 80
  , keepAwakeInterval: 30000
  , backend: 'fake'
  , backendOptions: {}
  , filter: []
  }, over?.options) as IosProviderOptions
  var deps: IosProviderDeps = Object.assign({
    fork: function(args: string[]) {
      forks.push(args)
      var proc = new FakeProc()
      procs.push(proc)
      return proc as unknown as ChildProcess
    }
  , backend: backend
  , push: push
  , sub: sub as unknown as IosProviderDeps['sub']
  , registerTimeout: REGISTER
  , restartDelay: RESTART
  }, over?.deps)

  return {
    options: options
  , devices: devices
  , procs: procs
  , forks: forks
  , sent: sent
  , sub: sub
  , backend: backend
  , deps: deps
  , register: function(n: number) {
      var msg = new wire.DeviceRegisteredMessage(udid(n))
      var env = wireutil.envelope(msg)
      sub.emit('message', 'channel', env)
    }
  }
}

function portsOf(args: string[]) {
  function val(flag: string) {
    return Number(args[args.indexOf(flag) + 1])
  }
  return [val('--screen-port'), val('--wda-port'), val('--mjpeg-port')]
}

function serialOf(args: string[]) {
  return args[args.indexOf('--serial') + 1]
}

describe('ios-provider unit', function() {
  this.timeout(10000)

  var env: Env

  afterEach(async function() {
    if (env && env.provider) {
      await env.provider.stop()
    }
  })

  function start(e: Env) {
    env = e
    env.provider = iosProvider(env.options, env.deps)
    return env.provider
  }

  it('introduces a new device as ONLINE with the provider name', async function() {
    var e = setup()
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.sent.length > 0
    })
    var first = e.sent[0]!
    expect(first.channel).to.equal(wireutil.global)
    expect(first.type).to.equal(wire.DeviceIntroductionMessage.$code)
    var msg = wire.DeviceIntroductionMessage.decode(first.message)
    expect(msg.serial).to.equal(udid(1))
    expect(msg.status).to.equal(wire.DeviceStatus.ONLINE)
    expect(msg.provider.name).to.equal('test-provider')
    expect(msg.provider.channel).to.be.a('string').and.not.empty
    expect(e.sub.subscribe.calledWith(msg.provider.channel)).to.equal(true)
  })

  it('forks only after the registration ack', async function() {
    var e = setup({deps: {registerTimeout: 5000}})
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.sent.length > 0
    })
    await sleep(60)
    expect(e.forks).to.have.length(0)
    e.register(1)
    await until(function() {
      return e.forks.length === 1
    })
    expect(serialOf(e.forks[0]!)).to.equal(udid(1))
  })

  it('forks after the fallback when no ack arrives', async function() {
    var e = setup()
    e.devices.push(summary(1))
    start(e)
    await sleep(REGISTER / 2)
    expect(e.forks).to.have.length(0)
    await until(function() {
      return e.forks.length === 1
    })
  })

  it('passes the worker CLI contract', async function() {
    var e = setup({options: {
      groupTimeout: 600
    , backend: 'goios'
    , backendOptions: {
        goIosPath: '/bin/ios'
      , wdaBundleId: 'x.wda'
      , fakeDeviceCount: 2
      , commandTimeout: 9000
      }
    , endpoints: {sub: ['tcp://s1', 'tcp://s2'], push: ['tcp://p1']}
    }})
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.sent.length > 0
    })
    e.register(1)
    await until(function() {
      return e.forks.length === 1
    })
    var args = e.forks[0]!
    expect(args[0]).to.equal('ios-device')
    expect(args).to.include.members([
      '--serial', udid(1), '--provider', 'test-provider', '--public-ip', '10.0.0.1'
    , '--storage-url', 'http://storage/', '--group-timeout', '600'
    , '--heartbeat-interval', '10000', '--screen-ws-url-pattern', 'ws://${publicIp}:${publicPort}'
    , '--screen-frame-rate', '10', '--screen-jpeg-quality', '80'
    , '--keep-awake-interval', '30000', '--ios-backend', 'goios'
    , '--go-ios-path', '/bin/ios', '--wda-bundle-id', 'x.wda'
    , '--fake-device-count', '2', '--command-timeout', '9000'
    , '--connect-sub', 'tcp://s1', 'tcp://s2', '--connect-push', 'tcp://p1'
    ])
    expect(args).to.not.include('--wda-xctest-config')
    expect(portsOf(args)).to.deep.equal([9000, 9001, 9002])
  })

  it('omits unset backend flags', function() {
    var e = setup()
    var args = buildWorkerArgs(e.options, udid(1), [1, 2, 3]).map(String)
    ;['--go-ios-path', '--wda-bundle-id', '--wda-test-runner-bundle-id'
    , '--wda-xctest-config', '--wda-simulator-build-dir', '--fake-device-count'
    , '--command-timeout'].forEach(function(flag) {
      expect(args).to.not.include(flag)
    })
  })

  it('gives each device 3 distinct ports and releases them on removal', async function() {
    var e = setup({options: {ports: [9000, 9001, 9002, 9003, 9004, 9005]}})
    e.devices.push(summary(1), summary(2))
    start(e)
    await until(function() {
      return e.forks.length === 2
    })
    var all = e.forks.map(portsOf).reduce(function(a, b) {
      return a.concat(b)
    }, [])
    expect(new Set(all).size).to.equal(6)

    // Pool is exhausted, a third device waits.
    e.devices.push(summary(3))
    await until(function() {
      return e.sent.filter(function(m) {
        return m.type === wire.DeviceIntroductionMessage.$code
      }).length === 3
    })
    await sleep(REGISTER + 60)
    expect(e.forks).to.have.length(2)

    // Removing device 1 frees ports, device 3 gets them on a later poll.
    e.devices.splice(0, 1)
    await until(function() {
      return e.forks.length === 3
    })
    expect(serialOf(e.forks[2]!)).to.equal(udid(3))
    expect(portsOf(e.forks[2]!)).to.deep.equal(portsOf(e.forks[0]!))
  })

  it('restarts a crashed worker after a delay and keeps ports balanced', async function() {
    var e = setup({options: {ports: [9000, 9001, 9002]}})
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    var crashedAt = Date.now()
    e.procs[0]!.emit('exit', 1, null)
    await sleep(RESTART / 3)
    expect(e.forks).to.have.length(1)
    await until(function() {
      return e.forks.length === 2
    })
    expect(Date.now() - crashedAt).to.be.at.least(RESTART - 5)
    expect(serialOf(e.forks[1]!)).to.equal(udid(1))
    expect(portsOf(e.forks[1]!)).to.have.members([9000, 9001, 9002])
    // No absent message for a crash.
    expect(e.sent.some(function(m) {
      return m.type === wire.DeviceAbsentMessage.$code
    })).to.equal(false)
  })

  it('does not restart after exit code 0 and reports the device absent', async function() {
    var e = setup()
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    e.procs[0]!.emit('exit', 0, null)
    await until(function() {
      return e.sent.some(function(m) {
        return m.type === wire.DeviceAbsentMessage.$code
      })
    })
    var absent = e.sent.find(function(m) {
      return m.type === wire.DeviceAbsentMessage.$code
    })!
    expect(wire.DeviceAbsentMessage.decode(absent.message).serial).to.equal(udid(1))
    await sleep(RESTART * 3)
    expect(e.forks).to.have.length(1)
  })

  it('does not restart after a signal exit', async function() {
    var e = setup()
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    e.procs[0]!.emit('exit', null, 'SIGKILL')
    await sleep(RESTART * 3 + POLL * 3)
    expect(e.forks).to.have.length(1)
  })

  it('kills the worker and sends absent when the device is removed', async function() {
    var e = setup()
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    e.devices.length = 0
    await until(function() {
      return e.procs[0]!.killed.length > 0
    })
    expect(e.procs[0]!.killed[0]).to.equal('SIGTERM')
    await until(function() {
      return e.sent.some(function(m) {
        return m.type === wire.DeviceAbsentMessage.$code
      })
    })
    await sleep(RESTART * 3)
    expect(e.forks).to.have.length(1)
  })

  it('escalates to SIGKILL when the worker ignores SIGTERM', async function() {
    var e = setup({options: {killTimeout: 30}})
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    var proc = e.procs[0]!
    proc.autoExit = false
    var kill = proc.kill.bind(proc)
    proc.kill = function(signal?: string | number) {
      kill(signal)
      if (signal === 'SIGKILL') {
        setImmediate(function() {
          proc.emit('exit', null, 'SIGKILL')
        })
      }
      return true
    }
    e.devices.length = 0
    await until(function() {
      return proc.killed.includes('SIGKILL')
    })
    expect(proc.killed).to.deep.equal(['SIGTERM', 'SIGKILL'])
  })

  it('only manages filtered udids', async function() {
    var e = setup({options: {filter: [udid(2)]}})
    e.devices.push(summary(1), summary(2))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    await sleep(REGISTER + 40)
    expect(e.forks).to.have.length(1)
    expect(serialOf(e.forks[0]!)).to.equal(udid(2))
    var intros = e.sent.filter(function(m) {
      return m.type === wire.DeviceIntroductionMessage.$code
    })
    expect(intros).to.have.length(1)
  })

  it('prepares the host once and stops its handle on shutdown', async function() {
    var stop = sinon.stub().resolves()
    var prepareHost = sinon.stub().resolves({stop: stop})
    var e = setup({backend: {prepareHost: prepareHost}})
    e.devices.push(summary(1))
    var provider = start(e)
    await until(function() {
      return e.forks.length === 1
    })
    await sleep(POLL * 4)
    expect(prepareHost.callCount).to.equal(1)
    expect(stop.callCount).to.equal(0)
    await provider.stop()
    await provider.stop()
    expect(stop.callCount).to.equal(1)
    // Worker was asked to stop and the device reported absent.
    expect(e.procs[0]!.killed[0]).to.equal('SIGTERM')
    expect(e.sent.some(function(m) {
      return m.type === wire.DeviceAbsentMessage.$code
    })).to.equal(true)
  })

  it('carries on when prepareHost fails', async function() {
    var prepareHost = sinon.stub().rejects(new Error('no tunnel'))
    var e = setup({backend: {prepareHost: prepareHost}})
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
  })

  it('keeps tracked devices when listing fails once', async function() {
    var calls = 0
    var e = setup()
    e.backend.listDevices = function() {
      calls++
      if (calls === 3) {
        return Promise.reject(new Error('transient'))
      }
      return Promise.resolve(e.devices.slice())
    }
    e.devices.push(summary(1))
    start(e)
    await until(function() {
      return e.forks.length === 1
    })
    var seen = calls
    await until(function() {
      return calls > seen + 3
    })
    expect(calls).to.be.greaterThan(3)
    expect(e.procs[0]!.killed).to.have.length(0)
    expect(e.forks).to.have.length(1)
  })
})
