import events from 'node:events'

import {expect} from 'chai'
import sinon from 'sinon'

import Bluebird from 'bluebird'
import rethinkdb from 'rethinkdb'

const IOS_CONNECT = 'Remote ADB connect is not supported for iOS devices'
const IOS_DISCONNECT = 'Remote ADB disconnect is not supported for iOS devices'

// Loaded in before() below: importing the controller pulls in lib/db, which dials RethinkDB at
// import time
type UserApi = typeof import('../../lib/units/api/controllers/user.js')
type DbApi = typeof import('../../lib/db/api.js').default

var dbSandbox = sinon.createSandbox()
var userapi: UserApi
  , dbapi: DbApi

type Handler = (req: never, res: never) => unknown

function ownedDevice(platform: string) {
  return {
    serial: 'dev-1'
  , platform: platform
  , channel: 'dev-channel'
  , present: true
  , ready: true
  , using: true
  , owner: {email: 'a@example.com', name: 'a', group: 'g'}
  }
}

function setup(device: unknown) {
  // The stub is not rejected on purpose: a device that is not there is the cursor's error
  var cursor = {
    next: function(cb: (err: Error | null, d: unknown) => void) {
      cb(device ? null : new Error('none'), device)
    }
  }
  sinon.stub(dbapi, 'loadDevice').resolves(cursor as never)
  sinon.stub(dbapi, 'loadUserAdbPublicKeys').resolves([] as never)

  var res = {
    status: sinon.stub()
  , json: sinon.stub()
  }
  res.status.returns(res)
  res.json.returns(res)

  var req = {
    swagger: {params: {serial: {value: 'dev-1'}}}
  , user: {email: 'a@example.com', privilege: 'user', groups: {subscribed: ['g']}}
  , options: {
      push: {send: sinon.spy()}
    , sub: {subscribe: sinon.spy(), unsubscribe: sinon.spy()}
    , channelRouter: Object.assign(new events.EventEmitter(), {})
    }
  }

  return {req: req, res: res}
}

function settle() {
  return new Promise(function(resolve) {
    setImmediate(resolve)
  })
}

describe('iOS remote ADB guard', function() {
  var clock: sinon.SinonFakeTimers

  before(async function() {
    // A connect that never settles (held for the whole file, as the db layer dials lazily) keeps it quiet without opening a socket or a timer.
    // The controller goes first: adbkit enables bluebird cancellation, which has to precede any
    // other use of bluebird.
    dbSandbox.stub(rethinkdb, 'connect').callsFake(function() {
      return new Bluebird(function() {}) as never
    })
    userapi = await import('../../lib/units/api/controllers/user.js')
    dbapi = (await import('../../lib/db/api.js')).default
  })

  after(function() {
    dbSandbox.restore()
  })

  beforeEach(function() {
    // Only the 5s "device is not responding" timer is faked, so none can outlive a test
    clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
  })

  afterEach(function() {
    clock.restore()
    sinon.restore()
  })

  type Action = 'remoteConnectUserDeviceBySerial' | 'remoteDisconnectUserDeviceBySerial'
  var cases: [string, Action, string][] = [
    ['connect', 'remoteConnectUserDeviceBySerial', IOS_CONNECT]
  , ['disconnect', 'remoteDisconnectUserDeviceBySerial', IOS_DISCONNECT]
  ]

  cases.forEach(function(c) {
    var name = c[0]
    var message = c[2]
    var handler = function(req: never, res: never) {
      return (userapi[c[1]] as unknown as Handler)(req, res)
    }

    it('answers 400 at once for an iOS device on ' + name, async function() {
      var t = setup(ownedDevice('iOS'))
      handler(t.req as never, t.res as never)
      await settle()

      sinon.assert.calledOnceWithExactly(t.res.status, 400)
      sinon.assert.calledOnceWithExactly(t.res.json, {success: false, description: message})
      sinon.assert.notCalled(t.req.options.push.send)
      sinon.assert.notCalled(t.req.options.sub.subscribe)
      expect(clock.countTimers()).to.equal(0)
    })

    it('does not short-circuit an Android device on ' + name, async function() {
      var t = setup(ownedDevice('Android'))
      handler(t.req as never, t.res as never)
      await settle()
      await settle()

      sinon.assert.calledOnce(t.req.options.push.send)
      sinon.assert.calledWith(
        t.req.options.push.send
      , sinon.match.array.startsWith(['dev-channel'])
      )
      sinon.assert.calledOnce(t.req.options.sub.subscribe)
      sinon.assert.notCalled(t.res.status)
      sinon.assert.notCalled(t.res.json)
      expect(clock.countTimers()).to.equal(1)
    })

    it('keeps 403 for an iOS device not owned by the user on ' + name, async function() {
      var device = ownedDevice('iOS')
      device.owner = {email: 'b@example.com', name: 'b', group: 'g'}
      var t = setup(device)
      handler(t.req as never, t.res as never)
      await settle()

      sinon.assert.calledOnceWithExactly(t.res.status, 403)
      sinon.assert.notCalled(t.req.options.push.send)
    })
  })
})
