import type {ReactElement} from 'react'
import {MantineProvider} from '@mantine/core'
import {cleanup, render} from '@testing-library/react'
import {MemoryRouter} from 'react-router'
import {afterEach} from 'vitest'
import type {Device} from '@/core/devices/types'

afterEach(cleanup)

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false
    , media: query
    , onchange: null
    , addEventListener: () => undefined
    , removeEventListener: () => undefined
    , addListener: () => undefined
    , removeListener: () => undefined
    , dispatchEvent: () => false
  })) as typeof window.matchMedia
}

if (!('ResizeObserver' in window)) {
  Object.assign(window, {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
}

export function renderUi(ui: ReactElement) {
  return render(
    <MantineProvider>
      <MemoryRouter>{ui}</MemoryRouter>
    </MantineProvider>
  )
}

export function makeDevice(platform?: string): Device {
  return {
    serial: 'test-serial'
    , present: true
    , ready: true
    , status: 3
    , group: {} as Device['group']
    , channel: 'channel'
    , ...(platform === undefined ? {} : {platform})
  } as Device
}
