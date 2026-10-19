//
// Tests for iOS device support, driven through the browser.
//
// Skipped entirely unless STF_IOS_SERIAL names an iOS device that the iOS
// provider serves. Start stf local with --ios-provider first (fake or
// simulator backend, always with NO-ANDROID-DEVICE so no real phone is used).
//
// STF_IOS_WDA_URL (e.g. http://127.0.0.1:8100) is the WebDriverAgent of that
// simulator. With it set the suite also runs the "real tap" checks, which
// confirm through WDA that a click on the canvas really reached the device.
// Without it the fake backend is assumed, whose frames change every time.
//

import {test, expect} from '@playwright/test'
import type {APIRequestContext, Locator, Page} from '@playwright/test'
import * as h from './helpers.ts'

const SERIAL = process.env.STF_IOS_SERIAL
const WDA_URL = (process.env.STF_IOS_WDA_URL || '').replace(/\/+$/, '')
// The simulator streams MJPEG first and falls back to screenshot polling after
// about 5s, so its first frame is slow. The fake backend answers at once.
const FIRST_FRAME_TIMEOUT = WDA_URL ? 60000 : 30000

const SETTINGS_BUNDLE = 'com.apple.Preferences'
const SPRINGBOARD_BUNDLE = 'com.apple.springboard'

interface Sample {
  width: number
  height: number
  opaque: number
  lit: number
  colors: number
  hash: string
}

interface WdaRect {
  x: number
  y: number
  width: number
  height: number
}

interface WdaElement {
  id: string
  rect: WdaRect
}

// Sample the canvas into a coarse grid. A blank canvas is fully transparent or
// pure black. The fake backend paints one solid colour per frame, so a single
// colour is not blank. The hash lets two samples be compared without shipping pixels.
async function sampleCanvas(canvas: Locator): Promise<Sample> {
  return canvas.evaluate(function(el: HTMLCanvasElement) {
    const empty = {width: el.width, height: el.height, opaque: 0, lit: 0, colors: 0, hash: ''}
    const ctx = el.getContext('2d')
    if (!ctx || !el.width || !el.height) {
      return empty
    }
    const stepX = Math.max(1, Math.floor(el.width / 24))
    const stepY = Math.max(1, Math.floor(el.height / 24))
    const seen: Record<string, boolean> = {}
    let opaque = 0
    let lit = 0
    let hash = 0
    for (let y = 0; y < el.height; y += stepY) {
      for (let x = 0; x < el.width; x += stepX) {
        const d = ctx.getImageData(x, y, 1, 1).data
        if (d[3]) {
          opaque++
          if (d[0] || d[1] || d[2]) {
            lit++
          }
        }
        const key = d[0] + ',' + d[1] + ',' + d[2]
        seen[key] = true
        hash = (hash * 31 + d[0]! * 65536 + d[1]! * 256 + d[2]!) % 2147483647
      }
    }
    return {
      width: el.width
    , height: el.height
    , opaque: opaque
    , lit: lit
    , colors: Object.keys(seen).length
    , hash: String(hash)
    }
  })
}

function isLive(sample: Sample) {
  return !(sample.width === 300 && sample.height === 150) &&
    sample.opaque > 0 && sample.lit > 0
}

// Minimal WebDriverAgent client. Only used for verification, never to drive the
// device: every action under test goes through the STF UI.
async function wda(
  request: APIRequestContext
, method: 'GET' | 'POST'
, path: string
, body?: unknown
) {
  const res = method === 'GET' ?
    await request.get(WDA_URL + path, {timeout: 30000}) :
    await request.post(WDA_URL + path, {data: body || {}, timeout: 60000})
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  }
  catch (e) {
    // Leave json null, the caller reports the raw text.
  }
  return {status: res.status(), json: json, text: text}
}

async function wdaActiveBundle(request: APIRequestContext) {
  const res = await wda(request, 'GET', '/wda/activeAppInfo')
  return res.json && res.json.value && res.json.value.bundleId as string | undefined
}

async function wdaScreen(request: APIRequestContext) {
  const res = await wda(request, 'GET', '/wda/screen')
  const size = res.json && res.json.value && res.json.value.screenSize
  if (!size || !size.width || !size.height) {
    throw new Error('WDA /wda/screen returned no screenSize: ' + res.text.slice(0, 300))
  }
  return size as {width: number, height: number}
}

async function wdaNewSession(request: APIRequestContext) {
  const res = await wda(request, 'POST', '/session', {
    capabilities: {alwaysMatch: {}}
  })
  const id = res.json && (res.json.sessionId || (res.json.value && res.json.value.sessionId))
  if (!id) {
    throw new Error('WDA did not create a session: ' + res.text.slice(0, 300))
  }
  return id as string
}

// Find one element and read its rect, retrying on a session the STF worker
// killed in the meantime (WDA answers 404 "invalid session id").
async function wdaFind(
  request: APIRequestContext
, using: string
, value: string
, attempts?: number
): Promise<WdaElement | null> {
  let lastError = ''
  for (let attempt = 0; attempt < (attempts || 4); attempt++) {
    const session = await wdaNewSession(request)
    const found = await wda(request, 'POST', '/session/' + session + '/element', {
      using: using
    , value: value
    })
    const el = found.json && found.json.value
    const id = el && (el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf'])
    if (id) {
      const rect = await wda(request, 'GET', '/session/' + session + '/element/' + id + '/rect')
      if (rect.json && rect.json.value && rect.json.value.width) {
        return {id: id, rect: rect.json.value as WdaRect}
      }
      lastError = 'rect: ' + rect.text.slice(0, 200)
    }
    else {
      lastError = 'find: ' + found.text.slice(0, 200)
    }
    await new Promise<void>(function(resolve) {
      setTimeout(resolve, 1500)
    })
  }
  console.log(
    'WDA could not find ' + using + '=' + value +
    ' on screen (' + lastError.replace(/\s+/g, ' ') + ')'
  )
  return null
}

async function wdaFindOrFail(request: APIRequestContext, using: string, value: string) {
  const el = await wdaFind(request, using, value)
  if (!el) {
    throw new Error('WDA could not find ' + using + '=' + value)
  }
  return el
}

async function wdaElementValue(request: APIRequestContext, id: string) {
  // A fresh session would not know the element, and the STF worker may have
  // replaced ours, so search again by class instead of reusing the id.
  const session = await wdaNewSession(request)
  const found = await wda(request, 'POST', '/session/' + session + '/element', {
    using: 'class name'
  , value: 'XCUIElementTypeSearchField'
  })
  const el = found.json && found.json.value
  const elId = el && (el.ELEMENT || el['element-6066-11e4-a52e-4f735466cecf'])
  if (!elId) {
    return ''
  }
  const val = await wda(
    request, 'GET', '/session/' + session + '/element/' + elId + '/attribute/value'
  )
  return String(val.json && val.json.value || '')
}

// Click the canvas where a WDA rect (in points) has its centre.
async function clickWdaRect(page: Page, request: APIRequestContext, rect: WdaRect) {
  const screen = await wdaScreen(request)
  const fx = (rect.x + rect.width / 2) / screen.width
  const fy = (rect.y + rect.height / 2) / screen.height
  expect(fx, 'rect centre is on screen horizontally').toBeGreaterThan(0)
  expect(fx).toBeLessThan(1)
  expect(fy, 'rect centre is on screen vertically').toBeGreaterThan(0)
  expect(fy).toBeLessThan(1)
  await h.tapDeviceScreen(page, fx, fy)
  return {fx: fx, fy: fy}
}

async function pressHome(page: Page) {
  await page.click('a[device-control-key="home"]')
}

test.describe('STF against an iOS device', function() {
  // Serial, no retries, for the reason given in device.spec.ts: a retry would
  // rerun the group while this user already holds the device.
  test.describe.configure({mode: 'serial', retries: 0})
  test.skip(!SERIAL, 'STF_IOS_SERIAL is not set')

  let page: Page
    , wdaApi: APIRequestContext
  let controlOpenedAt = 0

  const tile = function() {
    return page.locator(h.SEL.deviceTiles).filter({
      has: page.locator('a[href="#/control/' + SERIAL + '"]')
    })
  }

  test.beforeAll(async function({browser, playwright}, testInfo) {
    const context = await browser.newContext({
      viewport: {width: 1600, height: 1000}
    , recordVideo: {
        dir: testInfo.outputPath('session')
      , size: {width: 1280, height: 800}
      }
    })
    page = await context.newPage()
    wdaApi = await playwright.request.newContext()
    await h.login(page)

    // A run that died midway leaves the device held by this user, and a held
    // tile no longer reads state-available. Release it, ignoring "not held".
    const base = process.env.STF_URL || 'http://127.0.0.1:7100'
    await page.context().request.delete(base + '/api/v1/user/devices/' + SERIAL)
      .catch(function() {
        return null
      })
  })

  test.afterAll(async function() {
    if (wdaApi) {
      await wdaApi.dispose()
    }
    if (page) {
      await page.context().close()
    }
  })

  test('[check:ios_device_listed] the device list shows the iOS device as usable',
    async function() {
      await page.goto('/#/devices')
      await h.waitForDeviceTile(page)

      await expect(tile(), 'a tile for the iOS device').toHaveCount(1, {
        timeout: 120000
      })
      await expect(tile().locator('.device-name')).not.toHaveText('')
      await expect(tile(), 'tile names the platform and a version')
        .toContainText(/iOS \d+(\.\d+)*/)
      await expect(
        tile().locator(h.SEL.availableMarker)
      , 'the iOS device is offered as available'
      ).toHaveCount(1, {timeout: 120000})
      await expect(tile()).not.toContainText(/unavailable/i)
    })

  test('[check:ios_device_use] the device can be used and its control page opens',
    async function() {
      await tile().locator(h.SEL.deviceName).first().click()

      controlOpenedAt = Date.now()
      await page.waitForURL(new RegExp('#/control/' + SERIAL), {timeout: 90000})
      await expect(page.locator(h.SEL.screen)).toBeVisible({timeout: 60000})
      await expect(
        page.locator(h.SEL.stopUsing)
      , 'the device was handed over to us'
      ).toBeVisible({timeout: 90000})
    })

  test('[check:ios_screen_stream] the screen canvas receives live, non-blank frames',
    async function({}, testInfo) {
      const canvas = page.locator(h.SEL.canvas)
      await expect(canvas).toBeVisible({timeout: 60000})

      let first: Sample = {width: 300, height: 150, opaque: 0, lit: 0, colors: 0, hash: ''}
      await expect.poll(async function() {
        first = await sampleCanvas(canvas)
        return isLive(first)
      }, {
        timeout: FIRST_FRAME_TIMEOUT
      , intervals: [500]
      , message: 'canvas never showed a non-blank frame'
      }).toBeTruthy()

      const elapsed = Date.now() - controlOpenedAt
      console.log('first non-blank frame ' + elapsed + ' ms after opening the control page')
      await testInfo.attach('time-to-first-frame', {
        body: elapsed + ' ms'
      , contentType: 'text/plain'
      })

      await page.waitForTimeout(4000)
      const second = await sampleCanvas(canvas)
      expect(isLive(second), 'second sample is still non-blank').toBeTruthy()
      expect(second.width + 'x' + second.height, 'frame size is stable')
        .toBe(first.width + 'x' + first.height)
      await expect(page.locator(h.SEL.screenError)).toHaveCount(0)

      if (!WDA_URL) {
        // The fake backend repaints with a new colour on every frame.
        let changed = first.hash !== second.hash
        await expect.poll(async function() {
          const now = await sampleCanvas(canvas)
          changed = changed || now.hash !== first.hash
          return changed
        }, {timeout: 15000, message: 'fake frames never changed'}).toBeTruthy()
      }
    })

  test('[check:ios_ui_platform] Android-only UI is absent and iOS keys are present',
    async function() {
      // Navigation keys.
      await expect(page.locator('a[device-control-key="home"]')).toHaveCount(1)
      for (const key of ['back', 'menu', 'app_switch']) {
        await expect(
          page.locator('a[device-control-key="' + key + '"]'), key + ' key'
        ).toHaveCount(0)
      }

      // Tabs.
      const tabs = page.locator('[role=tab]')
      await expect(tabs.filter({hasText: /^Dashboard$/})).toHaveCount(1)
      await expect(tabs.filter({hasText: /^Advanced$/})).toHaveCount(1)
      for (const name of ['Logs', 'File Explorer']) {
        await expect(
          tabs.filter({hasText: new RegExp('^' + name + '$')}), name + ' tab'
        ).toHaveCount(0)
      }

      // Cards. The dashboard is open by default.
      await expect(page.locator('.stf-shell'), 'Shell card').toHaveCount(0)
      await expect(
        page.getByText(/^Shell$/), 'Shell heading'
      ).toHaveCount(0)

      // Volume keys live in the Advanced pane.
      await tabs.filter({hasText: /^Advanced$/}).click()
      for (const key of ['volume_up', 'volume_down']) {
        await expect(
          page.locator('.stf-advanced-input [data-key="' + key + '"]'), key + ' key'
        ).toBeVisible()
      }
      await tabs.filter({hasText: /^Dashboard$/}).click()
    })

  test('[check:ios_real_tap] a click on the canvas opens the Settings app',
    async function() {
      test.skip(!WDA_URL, 'STF_IOS_WDA_URL is not set (fake backend)')
      test.setTimeout(240000)

      await pressHome(page)
      await expect.poll(function() {
        return wdaActiveBundle(wdaApi)
      }, {
        timeout: 30000
      , message: 'SpringBoard is not the active app after Home'
      }).toBe(SPRINGBOARD_BUNDLE)

      // SpringBoard keeps the page it was left on, and Home on the SpringBoard
      // does not always go back to page one. An icon on another page reports a
      // zero rect, so page back with a swipe on the canvas until it is on screen.
      let icon: WdaElement | null = null
      for (let page_ = 0; page_ < 4 && !icon; page_++) {
        icon = await wdaFind(wdaApi, 'accessibility id', 'Settings', 2)
        if (!icon) {
          await h.swipeDeviceScreen(page, [0.15, 0.5], [0.85, 0.5])
          await page.waitForTimeout(1500)
        }
      }
      if (!icon) {
        throw new Error('the Settings icon never became visible on the SpringBoard')
      }
      const at = await clickWdaRect(page, wdaApi, icon.rect)
      console.log('tapped Settings at ' + at.fx.toFixed(3) + ',' + at.fy.toFixed(3))

      // A cold launch of Settings on a freshly booted simulator has been
      // observed to take longer than 10s, so allow a cold-start margin.
      await expect.poll(function() {
        return wdaActiveBundle(wdaApi)
      }, {
        timeout: 30000
      , intervals: [500]
      , message: 'Settings did not become the active app within 30s'
      }).toBe(SETTINGS_BUNDLE)
    })

  test('[check:ios_typing] typing through the UI reaches the focused field',
    async function() {
      test.skip(!WDA_URL, 'STF_IOS_WDA_URL is not set (fake backend)')
      test.setTimeout(240000)

      expect(await wdaActiveBundle(wdaApi), 'Settings is open from the tap test')
        .toBe(SETTINGS_BUNDLE)

      const field = await wdaFindOrFail(wdaApi, 'class name', 'XCUIElementTypeSearchField')
      await clickWdaRect(page, wdaApi, field.rect)
      await page.waitForTimeout(1500)

      // The canvas click focuses STF's hidden keyboard input, so typed keys go
      // to the device.
      await page.keyboard.type('Wi', {delay: 200})

      await expect.poll(function() {
        return wdaElementValue(wdaApi, field.id)
      }, {
        timeout: 15000
      , intervals: [1000]
      , message: 'the Settings search field never contained "Wi"'
      }).toContain('Wi')
    })

  test('[check:ios_home_return] the Home key returns to the SpringBoard',
    async function() {
      test.skip(!WDA_URL, 'STF_IOS_WDA_URL is not set (fake backend)')

      await pressHome(page)
      await expect.poll(function() {
        return wdaActiveBundle(wdaApi)
      }, {
        timeout: 15000
      , intervals: [500]
      , message: 'the active app did not return to the SpringBoard'
      }).toBe(SPRINGBOARD_BUNDLE)
    })

  test('[check:ios_api] reserve, remoteConnect refusal and release over /api/v1',
    async function({playwright, baseURL}) {
      const cookies = page.context().request
      const base = baseURL || 'http://127.0.0.1:7100'

      // Create an access token with the mock-login session, then use it as a
      // bearer token like an API client would.
      const created = await cookies.post(base + '/api/v1/user/accessTokens', {
        params: {title: 'playwright-ios'}
      })
      expect(created.status(), 'token creation').toBe(201)
      const tokenId = (await created.json()).token.id as string
      expect(tokenId).toBeTruthy()

      const api = await playwright.request.newContext({
        baseURL: base
      , extraHTTPHeaders: {authorization: 'Bearer ' + tokenId}
      })

      try {
        // The UI step already holds the device, so confirm that, then drop it
        // so the reserve call is exercised from a clean state.
        const mine = await api.get('/api/v1/user/devices')
        expect(mine.status()).toBe(200)
        const serials = ((await mine.json()).devices as {serial: string}[])
          .map(function(d) {
            return d.serial
          })
        expect(serials, 'device is held by this user after Use').toContain(SERIAL)

        const dropped = await api.delete('/api/v1/user/devices/' + SERIAL)
        expect(dropped.status(), 'first release').toBe(200)

        await expect.poll(async function() {
          const res = await api.post('/api/v1/user/devices', {data: {serial: SERIAL}})
          return res.status()
        }, {
          timeout: 30000
        , intervals: [1000]
        , message: 'POST /user/devices never reserved the iOS device'
        }).toBe(200)

        const started = Date.now()
        const remote = await api.post('/api/v1/user/devices/' + SERIAL + '/remoteConnect')
        const elapsed = Date.now() - started
        const text = await remote.text()
        console.log('remoteConnect answered ' + remote.status() + ' in ' + elapsed + ' ms')

        expect(
          remote.status()
        , 'remoteConnect must be a client error, got: ' + text.slice(0, 300)
        ).toBeGreaterThanOrEqual(400)
        expect(remote.status()).toBeLessThan(500)
        expect(text, 'the refusal says iOS is not supported').toMatch(/ios|not supported/i)
        expect(elapsed, 'remoteConnect answers immediately, not after a timeout')
          .toBeLessThan(2000)

        const released = await api.delete('/api/v1/user/devices/' + SERIAL)
        expect(released.status(), 'final release').toBe(200)
      }
      finally {
        // Best effort, a failed assertion must not leave the device held.
        await api.delete('/api/v1/user/devices/' + SERIAL).catch(function() {
          return null
        })
        await cookies.delete(base + '/api/v1/user/accessTokens/' + tokenId)
          .catch(function() {
            return null
          })
        await api.dispose()
      }
    })
})
