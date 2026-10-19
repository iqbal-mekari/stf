import assert from 'node:assert'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import {createGoIosBackend} from '../../lib/units/ios-device/backend/goios.js'
import {ExecError, spawnLongRunning} from '../../lib/units/ios-device/backend/exec.js'
import {createBackend} from '../../lib/units/ios-device/backend/index.js'

const UDID = '00000000-0000000000000001'

// Fake go-ios: logs argv, prints fixture JSON, and serves HTTP on the ports
// that real go-ios would expose (forward -> host port, tunnel -> info port).
const FAKE_IOS = [
  '#!/bin/bash'
, 'echo "$*" >> "$FAKE_DIR/argv.log"'
, 'echo \'{"time":"t","level":"WARN","msg":"go-ios agent is not running"}\' >&2'
, 'serve() {'
, '  echo $$ >> "$FAKE_DIR/pids"'
, '  [ -n "$FAKE_NO_HTTP" ] && exec sleep 300'
, '  exec "$FAKE_NODE" -e \'require("http").createServer((q, r) => {' +
  'r.statusCode = q.url === "/ready" || q.url === "/status" ? 200 : 404; r.end("{}")' +
  '}).listen(+process.argv[1], "127.0.0.1")\' "$1"'
, '}'
, 'case "$1" in'
, '  list) echo \'{"deviceList":[{"Udid":"00000000-0000000000000001","ProductName":"iPhone OS",' +
  '"ProductType":"iPad13,1","ProductVersion":"27.0.1","ConnectionType":"USB"},' +
  '{"Udid":"00000000-0000000000000002","ProductName":"iPhone OS","ProductType":"iPhone99,9",' +
  '"ProductVersion":"26.1","ConnectionType":"Network"},' +
  '{"Udid":"00000000-0000000000000003","ConnectionType":"unknown"}]}\' ;;'
, '  info) printf \'{"DeviceName":"Test Pad","ProductType":"%s",' +
  '"ProductVersion":"27.0.1","BuildVersion":"24A1",' +
  '"UniqueDeviceID":"00000000-0000000000000001"}\' ' +
  '"${FAKE_PRODUCT:-iPad13,1}" ;;'
, '  batterycheck)'
, '    if [ -n "$FAKE_BATTERY_FAIL" ]; then echo "battery boom" >&2; exit 1; fi'
, '    echo \'{"BatteryCurrentCapacity":87,"BatteryIsCharging":true}\' ;;'
, '  install|uninstall|launch|reboot)'
, '    if [ -n "$FAKE_FAIL" ]; then'
, '      echo "  time=x level=ERROR msg=\\"$1 failed\\"  " >&2; exit 4; fi'
, '    echo "slog line, no json" >&2 ;;'
, '  runwda) echo $$ >> "$FAKE_DIR/pids"'
, '    if [ -n "$FAKE_RUNWDA_EXIT" ]; then'
, '      while [ ! -f "$FAKE_DIR/die" ]; do sleep 0.05; done; exit 3; fi'
, '    exec sleep 300 ;;'
, '  forward) serve "$2" ;;'
, '  tunnel) [ -n "$FAKE_TUNNEL_NEVER_READY" ] && { echo $$ >> "$FAKE_DIR/pids"; exec sleep 300; }'
, '    for a in "$@"; do case "$a" in --tunnel-info-port=*) port="${a#*=}" ;; esac; done'
, '    serve "$port" ;;'
, 'esac'
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

describe('go-ios backend', function() {
  this.timeout(15000)

  let dir: string
   , bin: string
  const saved: Record<string, string | undefined> = {}
  const envKeys = [
    'FAKE_DIR', 'FAKE_NODE', 'FAKE_NO_HTTP', 'FAKE_BATTERY_FAIL', 'FAKE_FAIL'
  , 'FAKE_RUNWDA_EXIT', 'FAKE_TUNNEL_NEVER_READY', 'FAKE_PRODUCT'
  ]

  before(function() {
    envKeys.forEach(key => {
      saved[key] = process.env[key]
    })
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stf-ios-goios-'))
    bin = path.join(dir, 'ios')
    fs.writeFileSync(bin, FAKE_IOS + '\n', {mode: 0o755})
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
    envKeys.forEach(key => delete process.env[key])
    process.env.FAKE_DIR = dir
    process.env.FAKE_NODE = process.execPath
    fs.writeFileSync(path.join(dir, 'argv.log'), '')
    fs.writeFileSync(path.join(dir, 'pids'), '')
    fs.rmSync(path.join(dir, 'die'), {force: true})
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
    assert.equal(createBackend('goios', {goIosPath: bin}).name, 'goios')
    assert.throws(() => createBackend('bogus' as never, {}), /Unknown iOS backend/)
  })

  it('should list devices and map connection types', async function() {
    const devices = await createGoIosBackend({goIosPath: bin}).listDevices()
    assert.deepEqual(argv(), ['list --details'])
    assert.deepEqual(devices.map(d => d.connection), ['usb', 'network', 'unknown'])
    assert.equal(devices[0]?.udid, UDID)
    assert.equal(devices[0]?.name, 'iPad13,1')
    assert.equal(devices[1]?.name, 'iPhone99,9')
    assert.equal(devices[0]?.productType, 'iPad13,1')
    assert.equal(devices[0]?.osVersion, '27.0.1')
  })

  it('should merge info and battery and use the verified market name', async function() {
    const info = await createGoIosBackend({goIosPath: bin}).getInfo(UDID)
    assert.deepEqual(argv().sort(), [`batterycheck --udid=${UDID}`, `info --udid=${UDID}`])
    assert.equal(info.name, 'Test Pad')
    assert.equal(info.marketName, 'iPad Air (4th generation)')
    assert.equal(info.buildVersion, '24A1')
    assert.equal(info.batteryLevel, 87)
    assert.equal(info.batteryCharging, true)
  })

  it('should fall back to productType and omit battery when batterycheck fails', async function() {
    process.env.FAKE_BATTERY_FAIL = '1'
    process.env.FAKE_PRODUCT = 'iPad99,9'
    const info = await createGoIosBackend({goIosPath: bin}).getInfo(UDID)
    assert.equal(info.marketName, 'iPad99,9')
    assert.ok(!('batteryLevel' in info))
    assert.ok(!('batteryCharging' in info))
  })

  it('should pass exact arguments for install, uninstall, launch and reboot', async function() {
    const backend = createGoIosBackend({goIosPath: bin})
    await backend.install(UDID, '/x/app.ipa')
    await backend.uninstall(UDID, 'com.example.app')
    await backend.launch(UDID, 'com.example.app')
    await backend.reboot(UDID)
    assert.deepEqual(argv(), [
      `install --path=/x/app.ipa --udid=${UDID}`
    , `uninstall com.example.app --udid=${UDID}`
    , `launch com.example.app --udid=${UDID}`
    , `reboot --udid=${UDID}`
    ])
  })

  it('should reject with an ExecError carrying the exit code and stderr', async function() {
    process.env.FAKE_FAIL = '1'
    await assert.rejects(
      createGoIosBackend({goIosPath: bin}).launch(UDID, 'com.example.app')
    , (err: unknown) => {
        assert.ok(err instanceof ExecError)
        assert.equal(err.code, 4)
        assert.match(err.stderr, /launch failed/)
        assert.equal(err.stderr, err.stderr.trim())
        return true
      }
    )
  })

  it('should surface a missing binary as an ExecError', async function() {
    await assert.rejects(
      createGoIosBackend({goIosPath: path.join(dir, 'missing')}).listDevices()
    , (err: unknown) => err instanceof ExecError && err.code === 'ENOENT'
    )
  })

  it('should read app info through the shared reader', async function() {
    await assert.rejects(
      createGoIosBackend({goIosPath: bin}).readAppInfo(path.join(dir, 'nope.app'))
    , /Not an \.ipa or \.app/
    )
  })

  it('should reject a partial WDA runner configuration', function() {
    assert.throws(
      () => createGoIosBackend({goIosPath: bin, wdaBundleId: 'a.b'})
    , /together or not at all/
    )
  })

  describe('prepareHost', function() {
    it('should start the tunnel agent and stop it again', async function() {
      const port = await freePort()
      const backend = createGoIosBackend({
        goIosPath: bin, tunnelInfoPort: port, tunnelReadyTimeout: 5000
      })
      const host = await backend.prepareHost?.()
      assert.ok(host)
      assert.deepEqual(argv(), [
        'tunnel start --userspace --pair-record-path=/Users/Shared/go-ios ' +
        `--tunnel-info-port=${port}`
      ])
      const pid = pids()[0] as number
      assert.ok(alive(pid))
      await host.stop()
      await eventually(() => !alive(pid))
    })

    it('should create a missing pair record dir before starting the agent', async function() {
      const port = await freePort()
      const pairDir = path.join(dir, 'pair-records', 'nested')
      assert.ok(!fs.existsSync(pairDir))
      const host = await createGoIosBackend({
        goIosPath: bin, tunnelInfoPort: port, tunnelReadyTimeout: 5000
      , tunnelPairRecordPath: pairDir
      }).prepareHost?.()
      assert.ok(fs.statSync(pairDir).isDirectory())
      assert.deepEqual(argv(), [
        `tunnel start --userspace --pair-record-path=${pairDir} --tunnel-info-port=${port}`
      ])
      await host?.stop()
    })

    it('should reuse an agent that is already listening', async function() {
      const port = await freePort()
      const server = http.createServer((req, res) => {
        res.statusCode = req.url === '/ready' ? 200 : 404
        res.end()
      })
      await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
      try {
        const host = await createGoIosBackend({
          goIosPath: bin, tunnelInfoPort: port
        }).prepareHost?.()
        assert.deepEqual(argv(), [])
        await host?.stop()
        assert.deepEqual(argv(), [])
      }
      finally {
        server.close()
      }
    })

    it('should kill the agent and reject when it never becomes ready', async function() {
      process.env.FAKE_TUNNEL_NEVER_READY = '1'
      const port = await freePort()
      await assert.rejects(
        createGoIosBackend({
          goIosPath: bin, tunnelInfoPort: port, tunnelReadyTimeout: 600
        }).prepareHost?.() as Promise<unknown>
      , /not ready within 600ms/
      )
      await eventually(() => pids().every(pid => !alive(pid)))
    })
  })

  describe('startWda', function() {
    it('should spawn runwda and both forwards, then wait for /status', async function() {
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      const backend = createGoIosBackend({
        goIosPath: bin
      , wdaBundleId: 'com.example.wda'
      , wdaTestRunnerBundleId: 'com.example.wda.xctrunner'
      , wdaXctestConfig: 'WDA.xctest'
      , wdaPollInterval: 50
      })
      const handle = await backend.startWda(UDID, {wdaPort, mjpegPort})
      try {
        assert.equal(handle.wdaUrl, `http://127.0.0.1:${wdaPort}`)
        assert.equal(handle.mjpegUrl, `http://127.0.0.1:${mjpegPort}`)
        assert.deepEqual(argv().sort(), [
          `forward ${mjpegPort} 9100 --udid=${UDID}`
        , `forward ${wdaPort} 8100 --udid=${UDID}`
        , 'runwda --bundleid=com.example.wda --testrunnerbundleid=com.example.wda.xctrunner ' +
          `--xctestconfig=WDA.xctest --udid=${UDID} --env USE_PORT=8100 ` +
          '--env MJPEG_SERVER_PORT=9100'
        ].sort())
        assert.equal(pids().length, 3)
      }
      finally {
        await handle.stop()
      }
      await eventually(() => pids().every(pid => !alive(pid)))
    })

    it('should omit the runner ids when none are configured', async function() {
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      const handle = await createGoIosBackend({goIosPath: bin, wdaPollInterval: 50})
        .startWda(UDID, {wdaPort, mjpegPort})
      await handle.stop()
      assert.ok(argv().includes(
        `runwda --udid=${UDID} --env USE_PORT=8100 --env MJPEG_SERVER_PORT=9100`
      ))
    })

    it('should kill every child and reject with a clear error on timeout', async function() {
      process.env.FAKE_NO_HTTP = '1'
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      await assert.rejects(
        createGoIosBackend({
          goIosPath: bin, wdaStartTimeout: 600, wdaPollInterval: 50
        }).startWda(UDID, {wdaPort, mjpegPort})
      , /did not answer \/status within 600ms/
      )
      assert.equal(pids().length, 3)
      assert.ok(pids().every(pid => !alive(pid)))
    })

    it('should resolve exited when any process dies and stop the rest', async function() {
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      process.env.FAKE_RUNWDA_EXIT = '1'
      // runwda stays up until the die file appears; the forwards keep serving.
      const handle = await createGoIosBackend({goIosPath: bin, wdaPollInterval: 50})
        .startWda(UDID, {wdaPort, mjpegPort})
      fs.writeFileSync(path.join(dir, 'die'), '')
      await handle.exited
      await handle.stop()
      await eventually(() => pids().every(pid => !alive(pid)))
    })

    it('should reject when a process exits before WDA is ready', async function() {
      process.env.FAKE_NO_HTTP = '1'
      process.env.FAKE_RUNWDA_EXIT = '1'
      fs.writeFileSync(path.join(dir, 'die'), '')
      const [wdaPort, mjpegPort] = [await freePort(), await freePort()]
      await assert.rejects(
        createGoIosBackend({goIosPath: bin, wdaStartTimeout: 10000, wdaPollInterval: 50})
          .startWda(UDID, {wdaPort, mjpegPort})
      , /exited before it became ready/
      )
      assert.ok(pids().every(pid => !alive(pid)))
    })
  })
})

describe('spawnLongRunning', function() {
  this.timeout(10000)

  it('should escalate to SIGKILL when SIGTERM is ignored', async function() {
    const proc = spawnLongRunning(
      '/bin/bash', ['-c', 'trap "" TERM; echo ready >&2; while true; do sleep 1; done']
    , {killTimeout: 300}
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    await proc.stop()
    assert.equal((await proc.exited).signal, 'SIGKILL')
  })

  it('should call onExit and expose the exit code and stderr tail', async function() {
    const seen: unknown[] = []
    const proc = spawnLongRunning(
      '/bin/bash', ['-c', 'echo oops >&2; exit 7']
    , {onExit: info => seen.push(info)}
    )
    const info = await proc.exited
    assert.equal(info.code, 7)
    assert.deepEqual(seen, [info])
    assert.equal(proc.stderrTail(), 'oops')
    await proc.stop()
  })

  it('should treat a spawn failure as an exit', async function() {
    const proc = spawnLongRunning('/nonexistent/binary-for-test', [])
    assert.equal((await proc.exited).code, null)
    assert.match(proc.stderrTail(), /ENOENT/)
  })
})
