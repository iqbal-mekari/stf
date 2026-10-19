import assert from 'node:assert'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {createSimulatorBackend} from '../../lib/units/ios-device/backend/simulator.js'
import {createBackend} from '../../lib/units/ios-device/backend/index.js'

const UDID = '11111111-2222-3333-4444-555555555555'

const SIM_JSON = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [{
      udid: UDID
    , name: 'Test iPad Air'
    , state: 'Booted'
    , deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4'
    , isAvailable: true
    }, {
      udid: '11111111-2222-3333-4444-666666666666'
    , name: 'Sleeping Phone'
    , state: 'Shutdown'
    , deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17'
    , isAvailable: true
    }]
  , 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{
      udid: '11111111-2222-3333-4444-777777777777'
    , name: 'Older Phone'
    , state: 'Booted'
    , deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16'
    , isAvailable: true
    }]
  , 'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [{
      udid: '11111111-2222-3333-4444-888888888888'
    , name: 'Test Watch'
    , state: 'Booted'
    , deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-12'
    , isAvailable: true
    }]
  }
})

const FAKE_XCRUN = [
  '#!/bin/bash'
, 'echo "xcrun $*" >> "$FAKE_DIR/argv.log"'
, '[ "$1" = simctl ] || exit 2'
, 'case "$2" in'
, '  list) cat "$FAKE_DIR/sim.json" ;;'
, '  install)'
, '    if [ -n "$FAKE_FAIL" ]; then echo "install denied" >&2; exit 5; fi'
, '    if [ -d "$4" ]; then echo "$4" > "$FAKE_DIR/installed-path"; fi ;;'
, '  shutdown|boot|uninstall|launch) ;;'
, 'esac'
].join('\n')

const FAKE_XCODEBUILD = [
  '#!/bin/bash'
, 'echo "xcodebuild $*" >> "$FAKE_DIR/argv.log"'
, 'echo "env $TEST_RUNNER_USE_PORT $TEST_RUNNER_MJPEG_SERVER_PORT" >> "$FAKE_DIR/argv.log"'
, 'echo $$ >> "$FAKE_DIR/pids"'
, '[ -n "$FAKE_NO_HTTP" ] && exec sleep 300'
, 'exec "$FAKE_NODE" -e \'require("http").createServer((q, r) => {' +
  'r.statusCode = q.url === "/status" ? 200 : 404; r.end("{}")' +
  '}).listen(+process.argv[1], "127.0.0.1")\' "$TEST_RUNNER_USE_PORT"'
].join('\n')

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function eventually(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(check(), 'condition not met in time')
}

describe('simulator backend', function() {
  this.timeout(15000)

  let dir: string
   , buildDir: string
  const saved: Record<string, string | undefined> = {}
  const envKeys = ['PATH', 'FAKE_DIR', 'FAKE_NODE', 'FAKE_NO_HTTP', 'FAKE_FAIL']

  before(function() {
    envKeys.forEach(key => {
      saved[key] = process.env[key]
    })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stf-ios-sim-'))
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'xcrun'), FAKE_XCRUN + '\n', {mode: 0o755})
    fs.writeFileSync(path.join(bin, 'xcodebuild'), FAKE_XCODEBUILD + '\n', {mode: 0o755})
    fs.writeFileSync(path.join(dir, 'sim.json'), SIM_JSON)
    buildDir = path.join(dir, 'wda-build')
    fs.mkdirSync(buildDir)
    fs.writeFileSync(path.join(buildDir, 'Other.txt'), '')
    fs.writeFileSync(path.join(buildDir, 'WDA_iphonesimulator.xctestrun'), '')
    process.env.PATH = bin + path.delimiter + (saved.PATH ?? '')
  })

  after(function() {
    envKeys.forEach(key => {
      if (saved[key] === undefined) {
        delete process.env[key]
      }
      else {
        process.env[key] = saved[key]
      }
    })
    fs.rmSync(dir, {recursive: true, force: true})
  })

  beforeEach(function() {
    ['FAKE_NO_HTTP', 'FAKE_FAIL'].forEach(key => delete process.env[key])
    process.env.FAKE_DIR = dir
    process.env.FAKE_NODE = process.execPath
    fs.writeFileSync(path.join(dir, 'argv.log'), '')
    fs.writeFileSync(path.join(dir, 'pids'), '')
    fs.rmSync(path.join(dir, 'installed-path'), {force: true})
  })

  function argv(): string[] {
    return fs.readFileSync(path.join(dir, 'argv.log'), 'utf8').trim().split('\n')
      .filter(Boolean)
  }

  function pids(): number[] {
    return fs.readFileSync(path.join(dir, 'pids'), 'utf8').trim().split('\n')
      .filter(Boolean).map(Number)
  }

  it('should be selectable through the backend factory', function() {
    assert.equal(createBackend('simulator', {}).name, 'simulator')
  })

  it('should list only booted iOS simulators with parsed fields', async function() {
    const devices = await createSimulatorBackend().listDevices()
    assert.deepEqual(argv(), ['xcrun simctl list devices booted -j'])
    assert.deepEqual(devices.map(d => d.udid).sort(), [
      UDID
    , '11111111-2222-3333-4444-777777777777'
    ].sort())
    const ipad = devices.find(d => d.udid === UDID)
    assert.deepEqual(ipad, {
      udid: UDID
    , name: 'Test iPad Air'
    , productType: 'iPad-Air-11-inch-M4'
    , osVersion: '27.0'
    , connection: 'simulator'
    , marketName: 'Test iPad Air'
    })
    assert.equal(devices.find(d => d.name === 'Older Phone')?.osVersion, '26.1')
  })

  it('should return info for a booted simulator and fail for an unknown one', async function() {
    const backend = createSimulatorBackend()
    const info = await backend.getInfo(UDID)
    assert.equal(info.marketName, 'Test iPad Air')
    assert.equal(info.connection, 'simulator')
    await assert.rejects(backend.getInfo('nope'), /not booted/)
  })

  it('should pass exact arguments for uninstall, launch and reboot', async function() {
    const backend = createSimulatorBackend()
    await backend.uninstall(UDID, 'com.example.app')
    await backend.launch(UDID, 'com.example.app')
    await backend.reboot(UDID)
    assert.deepEqual(argv(), [
      `xcrun simctl uninstall ${UDID} com.example.app`
    , `xcrun simctl launch ${UDID} com.example.app`
    , `xcrun simctl shutdown ${UDID}`
    , `xcrun simctl boot ${UDID}`
    ])
  })

  it('should install an .app directly', async function() {
    await createSimulatorBackend().install(UDID, '/some/where/Demo.app')
    assert.deepEqual(argv(), [`xcrun simctl install ${UDID} /some/where/Demo.app`])
  })

  it('should unzip an .ipa, install its .app and clean up', async function() {
    const root = path.join(dir, 'ipa-root')
    const app = path.join(root, 'Payload', 'Demo.app')
    fs.mkdirSync(app, {recursive: true})
    fs.writeFileSync(path.join(app, 'Info.plist'), '')
    const ipa = path.join(dir, 'Demo.ipa')
    childProcess.execFileSync('zip', ['-qr', ipa, 'Payload'], {cwd: root})

    await createSimulatorBackend().install(UDID, ipa)

    const installed = fs.readFileSync(path.join(dir, 'installed-path'), 'utf8').trim()
    assert.match(installed, /stf-ios-app-[^/]+\/Payload\/Demo\.app$/)
    assert.ok(!fs.existsSync(installed), 'temp .app should be removed')
    assert.ok(!fs.existsSync(path.dirname(path.dirname(installed))))
  })

  it('should clean up and surface stderr when the install fails', async function() {
    process.env.FAKE_FAIL = '1'
    await assert.rejects(
      createSimulatorBackend().install(UDID, '/x/Demo.app')
    , (err: unknown) => (err as {stderr?: string}).stderr === 'install denied'
    )
  })

  describe('startWda', function() {
    it('should run xcodebuild with the ports in the environment', async function() {
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      const handle = await createSimulatorBackend({
        wdaSimulatorBuildDir: buildDir, wdaPollInterval: 50
      }).startWda(UDID, {wdaPort, mjpegPort})
      try {
        assert.equal(handle.wdaUrl, `http://127.0.0.1:${wdaPort}`)
        assert.equal(handle.mjpegUrl, `http://127.0.0.1:${mjpegPort}`)
        assert.deepEqual(argv(), [
          'xcodebuild test-without-building -xctestrun ' +
          `${path.join(buildDir, 'WDA_iphonesimulator.xctestrun')} -destination id=${UDID}`
        , `env ${wdaPort} ${mjpegPort}`
        ])
      }
      finally {
        await handle.stop()
      }
      await eventually(() => pids().every(pid => !alive(pid)))
    })

    it('should resolve exited when xcodebuild dies', async function() {
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      const handle = await createSimulatorBackend({
        wdaSimulatorBuildDir: buildDir, wdaPollInterval: 50
      }).startWda(UDID, {wdaPort, mjpegPort})
      process.kill(pids()[0] as number, 'SIGKILL')
      await handle.exited
      await handle.stop()
    })

    it('should kill xcodebuild and reject on timeout', async function() {
      process.env.FAKE_NO_HTTP = '1'
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      await assert.rejects(
        createSimulatorBackend({
          wdaSimulatorBuildDir: buildDir, wdaStartTimeout: 500, wdaPollInterval: 50
        }).startWda(UDID, {wdaPort, mjpegPort})
      , /did not answer \/status within 500ms/
      )
      assert.equal(pids().length, 1)
      assert.ok(pids().every(pid => !alive(pid)))
    })

    it('should require a build dir containing an .xctestrun', async function() {
      const ports = {wdaPort: 1, mjpegPort: 2}
      await assert.rejects(createSimulatorBackend().startWda(UDID, ports), /wdaSimulatorBuildDir/)
      const empty = fs.mkdtempSync(path.join(dir, 'empty-'))
      await assert.rejects(
        createSimulatorBackend({wdaSimulatorBuildDir: empty}).startWda(UDID, ports)
      , /No \.xctestrun/
      )
    })
  })
})
