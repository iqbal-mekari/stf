import {describe, expect, it} from 'vitest'
import {isAndroidDevice, isIosDevice} from './platform'

describe('platform', () => {
  it('detects iOS devices', () => {
    expect(isIosDevice({platform: 'iOS'})).toBe(true)
    expect(isAndroidDevice({platform: 'iOS'})).toBe(false)
  })

  it('detects Android devices', () => {
    expect(isIosDevice({platform: 'Android'})).toBe(false)
    expect(isAndroidDevice({platform: 'Android'})).toBe(true)
  })

  it('treats a missing platform as Android', () => {
    expect(isIosDevice({})).toBe(false)
    expect(isAndroidDevice({})).toBe(true)
    expect(isAndroidDevice(undefined)).toBe(true)
    expect(isIosDevice(null)).toBe(false)
  })
})
