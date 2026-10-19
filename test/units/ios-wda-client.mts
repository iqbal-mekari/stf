import {expect} from 'chai'

import {createWdaClient} from '../../lib/units/ios-device/wda/client.js'
import {startFakeWda} from '../../lib/units/ios-device/wda/fake-server.js'
import type {FakeWdaServer, WdaClient} from '../../lib/units/ios-device/types.js'

const SESSION_PATH = /^\/session\/[^/]+/

describe('WDA client', function() {
  let fake: FakeWdaServer, client: WdaClient

  beforeEach(async function() {
    fake = await startFakeWda({framerate: 5})
    client = createWdaClient(fake.wdaUrl)
  })

  afterEach(async function() {
    await fake.close()
  })

  function callsTo(method: string, suffix: string) {
    return fake.calls.filter(function(c) {
      return c.method === method && c.path.replace(SESSION_PATH, '') === suffix
    })
  }

  it('reads status', async function() {
    expect(await client.status()).to.deep.equal({ready: true, osVersion: '27.0.1'})
  })

  it('reads the screen in points', async function() {
    expect(await client.screen()).to.deep.equal({width: 820, height: 1180, scale: 2})
    fake.screen = {width: 100, height: 200, scale: 3}
    expect(await client.screen()).to.deep.equal({width: 100, height: 200, scale: 3})
  })

  it('taps with /wda/tap inside the session', async function() {
    await client.tap(10, 20)
    const calls = callsTo('POST', '/wda/tap')
    expect(calls).to.have.length(1)
    expect(calls[0]!.body).to.deep.equal({x: 10, y: 20})
  })

  it('types text, presses buttons and goes home', async function() {
    await client.typeText('hello')
    await client.pressButton('volumeup')
    await client.homescreen()
    expect(callsTo('POST', '/wda/keys')[0]!.body).to.deep.equal({value: ['hello']})
    expect(callsTo('POST', '/wda/pressButton')[0]!.body).to.deep.equal({name: 'volumeup'})
    expect(fake.calls.some(function(c) {
      return c.method === 'POST' && c.path === '/wda/homescreen'
    })).to.equal(true)
  })

  it('tracks lock state', async function() {
    fake.locked = true
    expect(await client.isLocked()).to.equal(true)
    await client.unlock()
    expect(fake.locked).to.equal(false)
    expect(await client.isLocked()).to.equal(false)
  })

  it('maps stream settings', async function() {
    await client.setStreamSettings({framerate: 15, quality: 40, scalingFactor: 50})
    expect(callsTo('POST', '/appium/settings')[0]!.body).to.deep.equal({
      settings: {
        mjpegServerFramerate: 15
      , mjpegServerScreenshotQuality: 40
      , mjpegScalingFactor: 50
      }
    })
    await client.setStreamSettings({quality: 10})
    expect(callsTo('POST', '/appium/settings')[1]!.body).to.deep.equal({
      settings: {mjpegServerScreenshotQuality: 10}
    })
  })

  it('returns a PNG-decodable buffer for screenshots', async function() {
    const buf = await client.screenshotPng()
    expect(buf.length).to.be.greaterThan(0)
  })

  describe('session handling', function() {
    it('reuses the session across calls', async function() {
      const first = await client.ensureSession()
      await client.tap(1, 1)
      await client.tap(2, 2)
      expect(await client.ensureSession()).to.equal(first)
      expect(fake.calls.filter(function(c) {
        return c.method === 'POST' && c.path === '/session'
      })).to.have.length(1)
    })

    it('shares one creation between concurrent callers', async function() {
      const ids = await Promise.all([
        client.ensureSession()
      , client.ensureSession()
      , client.ensureSession()
      ])
      expect(new Set(ids).size).to.equal(1)
      expect(fake.calls.filter(function(c) {
        return c.path === '/session'
      })).to.have.length(1)
    })

    it('recreates the session once after an invalid session 404', async function() {
      const first = await client.ensureSession()
      // Creating a session on the fake kills the previous one.
      await fetch(fake.wdaUrl + '/session', {
        method: 'POST'
      , body: JSON.stringify({capabilities: {alwaysMatch: {}}})
      })
      await client.tap(5, 6)
      const second = await client.ensureSession()
      expect(second).to.not.equal(first)
      const taps = callsTo('POST', '/wda/tap')
      expect(taps).to.have.length(2)
      expect(taps[0]!.path).to.contain(first)
      expect(taps[1]!.path).to.contain(second)
    })
  })

  describe('gesture', function() {
    it('builds W3C actions for a swipe', async function() {
      await client.gesture([{
        steps: [
          {x: 100, y: 200, delayMs: 0}
        , {x: 150, y: 250, delayMs: 40}
        , {x: 300, y: 400, delayMs: 60}
        ]
      }])
      const calls = callsTo('POST', '/actions')
      expect(calls).to.have.length(1)
      expect(calls[0]!.body).to.deep.equal({
        actions: [{
          type: 'pointer'
        , id: 'finger1'
        , parameters: {pointerType: 'touch'}
        , actions: [
            {type: 'pointerMove', duration: 0, x: 100, y: 200, origin: 'viewport'}
          , {type: 'pointerDown', button: 0}
          , {type: 'pointerMove', duration: 40, x: 150, y: 250, origin: 'viewport'}
          , {type: 'pointerMove', duration: 60, x: 300, y: 400, origin: 'viewport'}
          , {type: 'pointerUp', button: 0}
          ]
        }]
      })
    })

    it('uses one pointer object per finger', async function() {
      await client.gesture([
        {steps: [{x: 1, y: 2, delayMs: 0}, {x: 3, y: 4, delayMs: 10}]}
      , {steps: [{x: 5, y: 6, delayMs: 0}, {x: 7, y: 8, delayMs: 10}]}
      ])
      const body = callsTo('POST', '/actions')[0]!.body as {
        actions: {id: string, actions: {type: string}[]}[]
      }
      expect(body.actions.map(function(a) {
        return a.id
      })).to.deep.equal(['finger1', 'finger2'])
      for (const pointer of body.actions) {
        expect(pointer.actions.map(function(a) {
          return a.type
        })).to.deep.equal(['pointerMove', 'pointerDown', 'pointerMove', 'pointerUp'])
      }
    })
  })

  describe('errors', function() {
    it('include method, path and status but never the request body', async function() {
      const secret = 'hunter2-typed-secret'
      await client.ensureSession()
      await fake.close()
      let err: Error | undefined
      try {
        await client.typeText(secret)
      }
      catch (e) {
        err = e as Error
      }
      expect(err).to.be.instanceOf(Error)
      expect(err!.message).to.contain('POST')
      expect(err!.message).to.contain('/wda/keys')
      expect(err!.message).to.not.contain(secret)
      fake = await startFakeWda()
    })

    it('reports HTTP status for failures', async function() {
      const bad = createWdaClient(fake.wdaUrl + '/nope')
      let err: Error | undefined
      try {
        await bad.status()
      }
      catch (e) {
        err = e as Error
      }
      expect(err!.message).to.contain('GET')
      expect(err!.message).to.contain('/status')
      expect(err!.message).to.contain('404')
    })

    it('times out stalled requests', async function() {
      const stalled = createWdaClient('http://127.0.0.1:1', {timeoutMs: 100})
      let err: Error | undefined
      try {
        await stalled.status()
      }
      catch (e) {
        err = e as Error
      }
      expect(err).to.be.instanceOf(Error)
      expect(err!.message).to.contain('/status')
    })
  })
})
