import {expect} from 'chai'

import {createFakeBackend} from '../../lib/units/ios-device/backend/fake.js'
import {createWdaClient} from '../../lib/units/ios-device/wda/client.js'

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  }
  catch (err) {
    return err as Error
  }
  throw new Error('Expected promise to reject')
}

describe('Fake iOS backend', function() {
  it('lists one device by default with the documented identity', async function() {
    const backend = createFakeBackend()
    expect(backend.name).to.equal('fake')
    const devices = await backend.listDevices()
    expect(devices).to.deep.equal([{
      udid: '00000000-FAKE00000000001'
    , name: 'Fake iPad 1'
    , productType: 'iPad13,1'
    , osVersion: '27.0.1'
    , connection: 'usb'
    }])
  })

  it('honours fakeDeviceCount', async function() {
    const devices = await createFakeBackend({fakeDeviceCount: 3}).listDevices()
    expect(devices.map(function(d) {
      return d.name
    })).to.deep.equal(['Fake iPad 1', 'Fake iPad 2', 'Fake iPad 3'])
    expect(new Set(devices.map(function(d) {
      return d.udid
    })).size).to.equal(3)
    expect(new Set(devices.map(function(d) {
      return d.udid.length
    })).size).to.equal(1)
  })

  it('reports device info', async function() {
    const backend = createFakeBackend()
    const [device] = await backend.listDevices()
    const info = await backend.getInfo(device!.udid)
    expect(info.marketName).to.equal('iPad Air (4th generation)')
    expect(info.batteryLevel).to.equal(100)
    expect(info.batteryCharging).to.equal(true)
    expect(info.productType).to.equal('iPad13,1')
  })

  it('reads app info from the file name', async function() {
    const info = await createFakeBackend().readAppInfo('/some/dir/Example.ipa')
    expect(info).to.deep.equal({bundleId: 'dev.fake.Example'})
  })

  it('records install, launch, uninstall and reboot', async function() {
    const backend = createFakeBackend()
    const udid = (await backend.listDevices())[0]!.udid
    await backend.install(udid, '/tmp/Example.ipa')
    await backend.launch(udid, 'dev.fake.Example')
    await backend.uninstall(udid, 'dev.fake.Example')
    await backend.reboot(udid)
    expect(backend.log).to.deep.equal([
      {op: 'install', udid: udid, arg: '/tmp/Example.ipa'}
    , {op: 'launch', udid: udid, arg: 'dev.fake.Example'}
    , {op: 'uninstall', udid: udid, arg: 'dev.fake.Example'}
    , {op: 'reboot', udid: udid}
    ])
  })

  it('keeps a separate log per instance', async function() {
    const a = createFakeBackend()
    const b = createFakeBackend()
    await a.install((await a.listDevices())[0]!.udid, 'x.ipa')
    expect(a.log).to.have.length(1)
    expect(b.log).to.have.length(0)
  })

  it('fails for unknown UDIDs', async function() {
    const backend = createFakeBackend()
    const bogus = 'no-such-device'
    for (const call of [
      backend.getInfo(bogus)
    , backend.install(bogus, 'x.ipa')
    , backend.uninstall(bogus, 'dev.fake.x')
    , backend.launch(bogus, 'dev.fake.x')
    , backend.reboot(bogus)
    , backend.startWda(bogus, {wdaPort: 0, mjpegPort: 0})
    ]) {
      const err = await rejection(call)
      expect(err.message).to.contain(bogus)
    }
    expect(backend.log).to.have.length(0)
  })

  it('starts WDA that answers /status and stops it', async function() {
    const backend = createFakeBackend()
    const udid = (await backend.listDevices())[0]!.udid
    const handle = await backend.startWda(udid, {wdaPort: 0, mjpegPort: 0})
    try {
      const client = createWdaClient(handle.wdaUrl)
      expect((await client.status()).ready).to.equal(true)
      const res = await fetch(handle.mjpegUrl)
      expect(res.headers.get('content-type')).to.contain('multipart/x-mixed-replace')
      await res.body!.cancel()
    }
    finally {
      let exited = false
      handle.exited.then(function() {
        exited = true
      })
      await handle.stop()
      await handle.exited
      expect(exited).to.equal(true)
      // stop() is idempotent.
      await handle.stop()
    }
    const err = await rejection(createWdaClient(handle.wdaUrl, {timeoutMs: 500}).status())
    expect(err.message).to.contain('/status')
  })
})
