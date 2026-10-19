import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {Control} from './control'
import type {Device} from './devices/types'
import {installFile, iosManifest, shouldLaunch} from './install'

const storeFiles = vi.hoisted(() => vi.fn())
const apiGet = vi.hoisted(() => vi.fn())

vi.mock('./storage', () => ({storeFiles, storeUrl: vi.fn()}))
vi.mock('./api', () => ({api: {get: apiGet}}))

function fakeControl(platform?: string) {
  const install = vi.fn(() => ({progressed: () => Promise.resolve()}))
  const target = {serial: 'serial', ...(platform === undefined ? {} : {platform})} as Device
  return {control: {target, install} as unknown as Control, install}
}

const file = (name: string) => new File(['x'], name)

describe('install manifest and launch flag', () => {
  beforeEach(() => {
    storeFiles.mockReset()
    apiGet.mockReset()
    storeFiles.mockResolvedValue({resources: {file: {href: '/s/file'}}})
  })

  it('sends the iOS manifest without launching', async() => {
    const {control, install} = fakeControl('iOS')
    await installFile(control, [file('app.ipa')])
    expect(install).toHaveBeenCalledWith({
      href: '/s/file'
      , manifest: {application: {launcherActivities: [], activities: {}}, ios: true}
      , launch: false
    })
    expect(apiGet).not.toHaveBeenCalled()
  })

  it('filters for .ipa on iOS', async() => {
    const {control} = fakeControl('iOS')
    await installFile(control, [file('app.ipa')])
    const {filter} = storeFiles.mock.calls[0]![2]
    expect(filter(file('app.ipa'))).toBe(true)
    expect(filter(file('app.apk'))).toBe(false)
  })

  it('fetches the manifest and launches on Android', async() => {
    const manifest = {package: 'com.example', application: {activities: []}}
    apiGet.mockResolvedValue({success: true, manifest})
    const {control, install} = fakeControl('Android')
    await installFile(control, [file('app.apk')])
    expect(install).toHaveBeenCalledWith({href: '/s/file', manifest, launch: true})
  })

  it('treats a missing platform as Android', async() => {
    const manifest = {package: 'com.example'}
    apiGet.mockResolvedValue({success: true, manifest})
    const {control, install} = fakeControl()
    await installFile(control, [file('app.apk')])
    expect(install).toHaveBeenCalledWith({href: '/s/file', manifest, launch: true})
  })

  it('launches iOS only when a bundle id is known', () => {
    expect(shouldLaunch(iosManifest)).toBe(false)
    expect(shouldLaunch({...iosManifest, package: 'com.example.app'})).toBe(true)
    expect(shouldLaunch({package: 'com.example'})).toBe(true)
  })
})
