# iOS device support

STF can manage iPhones, iPads and iOS Simulators next to Android devices. iOS
devices show up in the same device list. You can reserve them through the UI
or the REST API, and control them from the browser.

## What works

| Feature | iOS |
|---|---|
| Device list, presence, battery | yes |
| Reservation (UI and `POST /api/v1/user/devices`) | yes |
| Live screen in the browser | yes (see [Screen](#screen)) |
| Tap, swipe, multi-finger gestures | yes, replayed after release |
| Typing, `home`, `volume_up`, `volume_down` | yes |
| Install `.ipa` (optionally launch), uninstall | yes |
| Screenshot, reboot | yes |
| Keep-awake watchdog (unlock when locked) | yes |
| Shell, logcat, file explorer, port forwarding, clipboard copy, wifi/bluetooth/ringer, rotation | no; the UI hides them and the worker replies "not supported" immediately |
| `remoteConnect` (remote ADB) | no; the API returns `400` right away |

Running test frameworks (XCUITest, Flutter Patrol, Appium, ...) is not part of
STF. Reserve the device through the API, then run your runner on the Mac the
device is attached to, e.g. `xcodebuild test-without-building -destination id=<udid>`.

## Architecture

```
stf ios-provider (macOS host)
  ├─ polls the backend for devices, introduces them to STF
  ├─ backend.prepareHost()  (go-ios tunnel agent for iOS 17+)
  └─ forks one `stf ios-device` worker per device (ports: screen, WDA, MJPEG)
        ├─ starts WebDriverAgent through the backend, restarts it with backoff
        ├─ identity / solo / heartbeat / group  (platform = "iOS")
        ├─ screen: WDA MJPEG, falls back to WDA screenshot polling
        └─ touch, input, install, capture, reboot, battery, keep-awake
```

Backends (`--ios-backend`):

- `goios`: real devices through [go-ios](https://github.com/danielpaulus/go-ios)
  (`ios list`, `install`, `runwda`, `forward`, `tunnel start --userspace`).
  WebDriverAgent must already be installed and signed on the device.
- `simulator`: booted iOS Simulators through `xcrun simctl`. WebDriverAgent runs
  from a prebuilt `build-for-testing` directory via `xcodebuild test-without-building`.
- `fake`: in-process fake devices and a fake WebDriverAgent. Used by tests and CI;
  needs no Xcode.

The worker reuses STF's platform-neutral plugins: logger, heartbeat, and the
sub/push/router support. Reservation logic is shared with Android through
`lib/units/device/plugins/util/group.ts`.

## Requirements

- A macOS host (Apple Silicon or Intel). The worker runs natively; Docker on
  macOS cannot reach USB devices or Xcode. The rest of STF can stay in Docker.
- Xcode. Set `DEVELOPER_DIR` if the global `xcode-select` points elsewhere.
- Real devices: Developer Mode on, trusted with this Mac, **Auto-Lock set to
  Never**, and a WebDriverAgent signed with your team installed.
- Optionally, go-ios v1.3.2 or later (`--go-ios-path`).

## Running

Local development:

```sh
# real devices (only the listed serials are used by either provider)
stf local --ios-provider --ios-backend goios \
  --go-ios-path /path/to/ios \
  --wda-bundle-id <runner>.xctrunner --wda-test-runner-bundle-id <runner>.xctrunner \
  --wda-xctest-config WebDriverAgentRunner.xctest \
  [serial ...]

# simulators
stf local --ios-provider --ios-backend simulator \
  --wda-simulator-build-dir /path/to/wda-build/Build/Products [serial ...]
```

Standalone provider, the same way as `stf provider`:

```sh
stf ios-provider --name mac-mini-1 --connect-sub tcp://<dev-pub> --connect-push tcp://<dev-pull> \
  --public-ip <host-ip> --storage-url http://<storage>/ --ios-backend goios ... [udid ...]
```

`stf ios-provider --help` lists every option. Useful ones are
`--keep-awake-interval` (0 disables it), `--poll-interval`, `--min-port` and `--max-port`.

## Screen

WebDriverAgent's MJPEG server is used first. If it produces no frame for 5s, at
startup or later, the worker polls WDA `/screenshot` at up to 2 frames/s and
sends PNG frames. Every 60s it probes MJPEG again and switches back when frames
flow. On Xcode 27 iOS Simulators the MJPEG server sends no frames ("Cannot take
a screenshot within 20000 ms timeout"), so simulators use the polling path.
Polled frames are full-resolution PNGs, about 3 MB each for an iPad.

## Known limitations

- Rotation is reported as 0.
- Gestures replay after release instead of streaming live.
- Multi-finger gestures use the nearest position for fingers that land late or lift early.
- Battery health, temperature and voltage are not reported.
- Copy is not supported; paste types the text.

## Tests

- Unit: `npx mocha --extension mts test/units/ios-*.mts`. Part of `npm test`.
- UI: `npm run test:component`.
- End to end: `test/playwright/ios.spec.ts`.
  - Fake backend: `STF_IOS_SERIAL=00000000-FAKE00000000001`.
  - Real simulator: also set `STF_IOS_WDA_URL=http://127.0.0.1:<wda-port>`. This adds a
    real tap that opens Settings, typing into its search field, and the Home key.
