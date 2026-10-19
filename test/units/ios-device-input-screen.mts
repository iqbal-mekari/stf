import events from 'node:events'

import {expect} from 'chai'
import sinon from 'sinon'
import WebSocket from 'ws'

import wire from '../../lib/wire/index.js'
import createRouter from '../../lib/wire/router.js'
import lifecycle from '../../lib/util/lifecycle.js'
import {startFakeWda} from '../../lib/units/ios-device/wda/fake-server.js'
import {createWdaClient} from '../../lib/units/ios-device/wda/client.js'
import touchSyrup, {
  TouchRecorder
, toAction
} from '../../lib/units/ios-device/plugins/touch.js'
import screenSyrup from '../../lib/units/ios-device/plugins/screen.js'
import type {Tick, TouchAction} from '../../lib/units/ios-device/plugins/touch.js'
import type {IosScreenPlugin} from '../../lib/units/ios-device/plugins/screen.js'
import type {FrameMode} from '../../lib/units/ios-device/screen/producer.js'
import type {
  FakeWdaOptions
, FakeWdaServer
, IosDeviceOptions
} from '../../lib/units/ios-device/types.js'
import type {IosIdentity, WdaPlugin} from '../../lib/units/ios-device/plugins/types.js'

const SCREEN = {width: 800, height: 1200, scale: 2}

function eventually(check: () => boolean, timeout = 5000) {
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

async function wdaStub(opts?: FakeWdaOptions) {
  const server = await startFakeWda(Object.assign({screen: SCREEN}, opts))
  const plugin = Object.assign(new events.EventEmitter(), {
    client: createWdaClient(server.wdaUrl)
  , mjpegUrl: server.mjpegUrl
  , screen: {...SCREEN}
  , isRunning: function() {
      return true
    }
  , stop: function() {
      return server.close()
    }
  }) as unknown as WdaPlugin
  return {server: server, wda: plugin}
}

function actionCalls(server: FakeWdaServer) {
  return server.calls
    .filter(function(call) {
      return /\/(wda\/tap|actions)$/.test(call.path)
    })
    .map(function(call) {
      return {path: call.path.replace(/^\/session\/[^/]+/, ''), body: call.body}
    })
}

// Records with a fake clock and returns what the recorder produced.
function record(steps: (r: TouchRecorder, clock: {now: number}) => void) {
  const clock = {now: 1000}
  const actions: Array<TouchAction | null> = []
  const recorder = new TouchRecorder(function(ticks: Tick[], releasedAt: number) {
    actions.push(toAction(ticks, releasedAt, SCREEN))
  }, function() {
    return clock.now
  })
  steps(recorder, clock)
  return actions
}

describe('iOS touch', function() {
  it('turns a short press into a tap in points', function() {
    const actions = record(function(r, clock) {
      r.touchDown(0, 0.5, 0.25)
      r.commit()
      clock.now += 80
      r.touchMove(0, 0.501, 0.251)
      r.commit()
      clock.now += 40
      r.touchUp(0)
      r.commit()
    })
    expect(actions).to.eql([{type: 'tap', x: 400, y: 300}])
  })

  it('replays a long press as a gesture that holds', function() {
    const actions = record(function(r, clock) {
      r.touchDown(0, 0.5, 0.5)
      r.commit()
      clock.now += 900
      r.touchUp(0)
      r.commit()
    })
    expect(actions).to.eql([{
      type: 'gesture'
    , pointers: [{steps: [
        {x: 400, y: 600, delayMs: 0}
      , {x: 400, y: 600, delayMs: 900}
      ]}]
    }])
  })

  it('replays a swipe with its timing', function() {
    const actions = record(function(r, clock) {
      r.touchDown(0, 0.5, 0.8)
      r.commit()
      clock.now += 50
      r.touchMove(0, 0.5, 0.6)
      r.commit()
      clock.now += 50
      // No movement, merged into the next step.
      r.commit()
      clock.now += 50
      r.touchMove(0, 0.5, 0.2)
      r.commit()
      clock.now += 20
      r.touchUp(0)
      r.commit()
    })
    expect(actions).to.eql([{
      type: 'gesture'
    , pointers: [{steps: [
        {x: 400, y: 960, delayMs: 0}
      , {x: 400, y: 720, delayMs: 50}
      , {x: 400, y: 240, delayMs: 100}
      , {x: 400, y: 240, delayMs: 20}
      ]}]
    }])
  })

  it('replays two fingers as two synchronised pointers', function() {
    const actions = record(function(r, clock) {
      r.touchDown(0, 0.4, 0.4)
      r.touchDown(1, 0.6, 0.6)
      r.commit()
      clock.now += 30
      r.touchMove(0, 0.3, 0.3)
      r.touchMove(1, 0.7, 0.7)
      r.commit()
      clock.now += 30
      r.touchUp(0)
      r.touchUp(1)
      r.commit()
    })
    expect(actions).to.have.length(1)
    const action = actions[0]!
    expect(action.type).to.equal('gesture')
    if (action.type !== 'gesture') {
      return
    }
    expect(action.pointers).to.have.length(2)
    expect(action.pointers[0]!.steps).to.eql([
      {x: 320, y: 480, delayMs: 0}
    , {x: 240, y: 360, delayMs: 30}
    , {x: 240, y: 360, delayMs: 30}
    ])
    expect(action.pointers[1]!.steps).to.eql([
      {x: 480, y: 720, delayMs: 0}
    , {x: 560, y: 840, delayMs: 30}
    , {x: 560, y: 840, delayMs: 30}
    ])
  })

  it('releases everything on reset', function() {
    const actions = record(function(r, clock) {
      r.touchDown(0, 0.1, 0.1)
      r.commit()
      clock.now += 10
      r.reset()
      // Nothing left to send on a second reset.
      r.reset()
    })
    expect(actions).to.eql([{type: 'tap', x: 80, y: 120}])
  })

  describe('plugin', function() {
    let stub: Awaited<ReturnType<typeof wdaStub>>
     , router: ReturnType<typeof createRouter>
     , touch: {idle(): Promise<void>}

    beforeEach(async function() {
      stub = await wdaStub()
      router = createRouter()
      touch = touchSyrup.invoke({} as IosDeviceOptions, stub.wda, router)
    })

    afterEach(async function() {
      await stub.server.close()
    })

    function send(type: {$code: number}, message: unknown) {
      router.emit(type.$code, 'c', message)
    }

    it('taps through WebDriverAgent even with out of order messages', async function() {
      send(wire.GestureStartMessage, new wire.GestureStartMessage(10))
      // seq 12 and 14 arrive before 11 and 13.
      send(wire.TouchCommitMessage, new wire.TouchCommitMessage(12))
      send(wire.TouchDownMessage, new wire.TouchDownMessage(11, 0, 0.25, 0.5, 0.5))
      send(wire.TouchCommitMessage, new wire.TouchCommitMessage(14))
      send(wire.TouchUpMessage, new wire.TouchUpMessage(13, 0))
      send(wire.GestureStopMessage, new wire.GestureStopMessage(15))
      await eventually(function() {
        return actionCalls(stub.server).length > 0
      })
      await touch.idle()
      expect(actionCalls(stub.server)).to.eql([
        {path: '/wda/tap', body: {x: 200, y: 600}}
      ])
    })

    it('sends a multi-finger gesture as W3C actions', async function() {
      send(wire.GestureStartMessage, new wire.GestureStartMessage(0))
      send(wire.TouchDownMessage, new wire.TouchDownMessage(1, 0, 0.5, 0.5, 0.5))
      send(wire.TouchDownMessage, new wire.TouchDownMessage(2, 1, 0.5, 0.5, 0.5))
      send(wire.TouchCommitMessage, new wire.TouchCommitMessage(3))
      send(wire.TouchMoveMessage, new wire.TouchMoveMessage(4, 0, 0.25, 0.25, 0.5))
      send(wire.TouchMoveMessage, new wire.TouchMoveMessage(5, 1, 0.75, 0.75, 0.5))
      send(wire.TouchCommitMessage, new wire.TouchCommitMessage(6))
      send(wire.TouchUpMessage, new wire.TouchUpMessage(7, 0))
      send(wire.TouchUpMessage, new wire.TouchUpMessage(8, 1))
      send(wire.TouchCommitMessage, new wire.TouchCommitMessage(9))
      send(wire.GestureStopMessage, new wire.GestureStopMessage(10))
      await eventually(function() {
        return actionCalls(stub.server).length > 0
      })
      await touch.idle()
      const calls = actionCalls(stub.server)
      expect(calls).to.have.length(1)
      expect(calls[0]!.path).to.equal('/actions')
      type Actions = Array<{id: string, actions: Array<Record<string, unknown>>}>
      const body = calls[0]!.body as {actions: Actions}
      expect(body.actions.map(function(a) {
        return a.id
      })).to.eql(['finger1', 'finger2'])
      expect(body.actions[0]!.actions[0]).to.include({type: 'pointerMove', x: 400, y: 600})
      expect(body.actions[0]!.actions[1]).to.include({type: 'pointerDown'})
      expect(body.actions[0]!.actions[2]).to.include({type: 'pointerMove', x: 200, y: 300})
      expect(body.actions[1]!.actions[2]).to.include({type: 'pointerMove', x: 600, y: 900})
      expect(body.actions[0]!.actions[body.actions[0]!.actions.length - 1])
        .to.include({type: 'pointerUp'})
    })
  })
})

describe('iOS screen', function() {
  this.timeout(15000)

  let stub: Awaited<ReturnType<typeof wdaStub>>
   , screen: IosScreenPlugin | undefined
  const sockets: WebSocket[] = []

  const identity = {
    display: {width: 1600, height: 2400}
  } as IosIdentity

  function options(overrides?: Partial<IosDeviceOptions>) {
    return Object.assign({
      screenPort: 0
    , screenPingInterval: 30000
    , screenFrameRate: 10
    , screenJpegQuality: 70
    , screenFallbackTimeout: 300
    , screenPollFrameRate: 20
    , screenMjpegRetryInterval: 0
    }, overrides) as IosDeviceOptions
  }

  async function start(wdaOptions?: FakeWdaOptions, overrides?: Partial<IosDeviceOptions>) {
    stub = await wdaStub(Object.assign({framerate: 20}, wdaOptions))
    screen = await screenSyrup.invoke(options(overrides), stub.wda, identity)
    return screen!
  }

  function connect() {
    const ws = new WebSocket('ws://127.0.0.1:' + screen!.port)
    sockets.push(ws)
    const texts: string[] = []
    const frames: Buffer[] = []
    ws.on('message', function(data, isBinary) {
      if (isBinary) {
        frames.push(data as Buffer)
      }
      else {
        texts.push(data.toString())
      }
    })
    return events.once(ws, 'open').then(function() {
      return {ws: ws, texts: texts, frames: frames}
    })
  }

  function modes() {
    const seen: FrameMode[] = []
    screen!.producer.on('mode', function(mode) {
      seen.push(mode)
    })
    return seen
  }

  beforeEach(function() {
    sinon.stub(lifecycle, 'observe')
  })

  afterEach(async function() {
    sinon.restore()
    sockets.splice(0).forEach(function(ws) {
      ws.terminate()
    })
    await screen?.close()
    screen = undefined
    await stub.server.close()
  })

  it('greets clients and streams MJPEG frames while on', async function() {
    await start()
    const client = await connect()
    await eventually(function() {
      return client.texts.length > 0
    })
    const banner = JSON.parse(client.texts[0]!.replace(/^start /, ''))
    expect(banner.realWidth).to.equal(1600)
    expect(banner.realHeight).to.equal(2400)
    expect(banner.quirks).to.eql({dumb: false, alwaysUpright: false, tear: false})
    expect(client.frames).to.have.length(0)
    expect(screen!.producer.mode).to.equal('idle')

    client.ws.send('size 400x600')
    client.ws.send('on')
    await eventually(function() {
      return client.frames.length >= 3
    })
    expect(screen!.producer.mode).to.equal('mjpeg')
    // Every message is one complete JPEG.
    expect(client.frames[0]!.subarray(0, 2)).to.eql(Buffer.from([0xff, 0xd8]))
    expect(client.frames[0]!.subarray(-2)).to.eql(Buffer.from([0xff, 0xd9]))

    const settings = stub.server.calls.find(function(call) {
      return /\/appium\/settings$/.test(call.path)
    })
    expect(settings!.body).to.eql({settings: {
      mjpegServerFramerate: 10
    , mjpegServerScreenshotQuality: 70
    }})

    client.ws.send('off')
    await eventually(function() {
      return screen!.producer.mode === 'idle'
    })
    const count = client.frames.length
    await new Promise(function(resolve) {
      setTimeout(resolve, 200)
    })
    expect(client.frames.length).to.be.at.most(count + 1)
  })

  it('keeps producing while any client is on', async function() {
    await start()
    const a = await connect()
    const b = await connect()
    a.ws.send('on')
    b.ws.send('on')
    await eventually(function() {
      return a.frames.length > 0 && b.frames.length > 0
    })
    a.ws.close()
    await new Promise(function(resolve) {
      setTimeout(resolve, 100)
    })
    expect(screen!.producer.mode).to.equal('mjpeg')
    b.ws.send('off')
    await eventually(function() {
      return screen!.producer.mode === 'idle'
    })
  })

  it('falls back to screenshot polling when MJPEG stays silent', async function() {
    await start({mjpegPaused: true})
    const seen = modes()
    const client = await connect()
    client.ws.send('on')
    await eventually(function() {
      return screen!.producer.mode === 'polling' && client.frames.length >= 2
    })
    expect(seen).to.eql(['mjpeg', 'polling'])
    expect(stub.server.calls.filter(function(call) {
      return call.path === '/screenshot'
    }).length).to.be.at.least(2)
  })

  it('falls back when MJPEG stalls and returns once it delivers again', async function() {
    await start({}, {screenMjpegRetryInterval: 200})
    const seen = modes()
    const client = await connect()
    client.ws.send('on')
    await eventually(function() {
      return client.frames.length > 0
    })
    stub.server.mjpegPaused = true
    await eventually(function() {
      return screen!.producer.mode === 'polling'
    })
    stub.server.mjpegPaused = false
    await eventually(function() {
      return screen!.producer.mode === 'mjpeg' && seen.length >= 3
    })
    expect(seen).to.eql(['mjpeg', 'polling', 'mjpeg'])
  })

  it('polls no faster than the configured frame rate', async function() {
    await start({mjpegPaused: true}, {screenPollFrameRate: 5})
    const client = await connect()
    client.ws.send('on')
    await eventually(function() {
      return screen!.producer.mode === 'polling'
    })
    const before = stub.server.calls.length
    await new Promise(function(resolve) {
      setTimeout(resolve, 1000)
    })
    const shots = stub.server.calls.slice(before).filter(function(call) {
      return call.path === '/screenshot'
    }).length
    expect(shots).to.be.within(1, 7)
  })

  it('starts over with MJPEG after WebDriverAgent restarts', async function() {
    await start({mjpegPaused: true})
    const client = await connect()
    client.ws.send('on')
    await eventually(function() {
      return screen!.producer.mode === 'polling'
    })
    const seen = modes()
    stub.server.mjpegPaused = false
    stub.wda.emit('start')
    await eventually(function() {
      return seen.length > 0
    })
    expect(seen[0]).to.equal('mjpeg')
    // The MJPEG settings are applied again to the new WebDriverAgent.
    await eventually(function() {
      return stub.server.calls.filter(function(call) {
        return /\/appium\/settings$/.test(call.path)
      }).length === 2
    })
  })
})
