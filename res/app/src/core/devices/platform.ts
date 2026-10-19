import type {Device} from './types'

type PlatformSource = Pick<Device, 'platform'> | null | undefined

export function isIosDevice(device: PlatformSource): boolean {
  return device?.platform === 'iOS'
}

// A missing platform means Android, for backward compatibility.
export function isAndroidDevice(device: PlatformSource): boolean {
  return !isIosDevice(device)
}
