import type {ReactNode} from 'react'
import {Menu} from '@mantine/core'
import {describe, expect, it, vi} from 'vitest'
import type {Control} from '@/core/control'
import {makeDevice, renderUi} from '@/test/render-ui'
import {panesFor} from './ControlPage'
import {DeviceMenuItems} from './device-control/DeviceMenuItems'
import DeviceControlPanel from './device-control/DeviceControlPanel'
import AdvancedPane from './panes/advanced/AdvancedPane'
import DashboardPane from './panes/dashboard/DashboardPane'
import InfoPane from './panes/info/InfoPane'

vi.mock('./screen/DeviceScreen', () => stubModule('DeviceScreen', 'screen'))
vi.mock('./device-control/use-control-hotkeys', () => ({useControlHotkeys: vi.fn()}))
vi.mock('./device-control/use-device-actions', () => ({
  useDeviceActions: () => ({
    groupDevices: []
    , rotation: 0
    , currentRotation: 'portrait'
    , rotateBy: vi.fn()
    , tryToRotate: vi.fn()
    , stopUsing: vi.fn()
    , controlDevice: vi.fn()
  })
}))
vi.mock('./device-control/DeviceControlKey', () => ({
  DeviceControlKey: ({deviceKey, children}: {deviceKey: string, children: ReactNode}) => (
    <button data-key={deviceKey}>{children}</button>
  )
}))
vi.mock('./panes/dashboard/navigation/NavigationCard', () => stubModule('NavigationCard', 'navigation'))
vi.mock('./panes/dashboard/clipboard/ClipboardCard', () => stubModule('ClipboardCard', 'clipboard'))
vi.mock('./panes/dashboard/install/InstallCard', () => stubModule('InstallCard', 'install'))
vi.mock('./panes/dashboard/shell/ShellCard', () => stubModule('ShellCard', 'shell'))
vi.mock('./panes/dashboard/apps/AppsCard', () => stubModule('AppsCard', 'apps'))
vi.mock('./panes/dashboard/remote-debug/RemoteDebugCard', () => stubModule('RemoteDebugCard', 'remote-debug'))
vi.mock('./panes/advanced/PortForwardingCard', () => stubModule('PortForwardingCard', 'port-forwarding'))
vi.mock('./panes/advanced/MaintenanceCard', () => stubModule('MaintenanceCard', 'maintenance'))
vi.mock('@/ui/modes', () => ({
  usePlatform: () => ['native', vi.fn()]
  , useStandalone: () => false
  , basicMode: false
}))

async function stubModule(name: string, testId: string) {
  const {stubComponent} = await import('@/test/stub-component')
  return {[name]: stubComponent(testId)}
}

const getSdStatus = vi.fn(() => Promise.resolve({lastData: 'sd_mounted'}))
const control = {
  target: {serial: 'test-serial'}
  , getSdStatus
  , keyPress: vi.fn()
} as unknown as Control

const androidOnlyCards = ['navigation', 'clipboard', 'shell', 'apps', 'remote-debug']

describe('iOS device UI', () => {
  it('hides Android-only dashboard cards but keeps install', () => {
    const view = renderUi(<DashboardPane device={makeDevice('iOS')} control={control} />)
    expect(view.queryByTestId('install')).not.toBeNull()
    for (const id of androidOnlyCards) {
      expect(view.queryByTestId(id), id).toBeNull()
    }
  })

  it('shows home and volume keys only in the advanced pane, with port forwarding hidden', () => {
    const view = renderUi(<AdvancedPane device={makeDevice('iOS')} control={control} />)
    const keys = Array.from(view.container.querySelectorAll('[data-key]')).map((el) => el.getAttribute('data-key'))
    expect(keys).toEqual(['home', 'volume_down', 'volume_up'])
    expect(view.queryByTestId('port-forwarding')).toBeNull()
    expect(view.queryByTestId('maintenance')).not.toBeNull()
  })

  it('shows only the home key in the nav pill and no rotate controls', () => {
    const view = renderUi(<DeviceControlPanel device={makeDevice('iOS')} control={control} />)
    const keys = Array.from(view.container.querySelectorAll('[data-key]')).map((el) => el.getAttribute('data-key'))
    expect(keys).toEqual(['home'])
    expect(view.queryByLabelText('Portrait')).toBeNull()
    expect(view.queryByLabelText('Landscape')).toBeNull()
    expect(view.queryByLabelText('Rotate Left')).toBeNull()
    expect(view.queryByLabelText('Rotate Right')).toBeNull()
    expect(view.queryByLabelText('Stop Using')).not.toBeNull()
  })

  it('keeps only home, screenshot and stop in the context menu', () => {
    const view = renderUi(
      <Menu opened withinPortal={false}>
        <Menu.Target><button>t</button></Menu.Target>
        <Menu.Dropdown>
          <DeviceMenuItems device={makeDevice('iOS')} control={control} onStopUsing={vi.fn()} />
        </Menu.Dropdown>
      </Menu>
    )
    for (const label of ['Back', 'Recents', 'Rotate Left', 'Rotate Right']) {
      expect(view.queryByText(label), label).toBeNull()
    }
    for (const label of ['Home', 'Save ScreenShot', 'Stop Using']) {
      expect(view.queryByText(label), label).not.toBeNull()
    }
  })

  it('hides SDK, ABI and SD card rows and skips the SD status query', () => {
    getSdStatus.mockClear()
    const view = renderUi(<InfoPane device={makeDevice('iOS')} control={control} />)
    expect(view.queryByText('OS')).not.toBeNull()
    for (const label of ['SDK', 'ABI', 'SD Card Mounted']) {
      expect(view.queryByText(label), label).toBeNull()
    }
    expect(getSdStatus).not.toHaveBeenCalled()
  })

  it('hides the Logs, Automation and File Explorer tabs', () => {
    const ids = panesFor(makeDevice('iOS')).map((pane) => pane.id)
    expect(ids).toEqual(['dashboard', 'screenshots', 'advanced', 'info'])
  })
})

describe.each([['Android'], [undefined]])('Android device UI (platform %s)', (platform) => {
  it('keeps all dashboard cards', () => {
    const view = renderUi(<DashboardPane device={makeDevice(platform)} control={control} />)
    for (const id of ['install', ...androidOnlyCards]) {
      expect(view.queryByTestId(id), id).not.toBeNull()
    }
  })

  it('keeps the full advanced input and port forwarding', () => {
    const view = renderUi(<AdvancedPane device={makeDevice(platform)} control={control} />)
    const keys = Array.from(view.container.querySelectorAll('[data-key]')).map((el) => el.getAttribute('data-key'))
    expect(keys).toEqual(expect.arrayContaining(['power', 'camera', 'mute', 'volume_up', 'media_play_pause']))
    expect(view.queryByTestId('port-forwarding')).not.toBeNull()
  })

  it('keeps nav pill keys and rotate controls', () => {
    const view = renderUi(<DeviceControlPanel device={makeDevice(platform)} control={control} />)
    const keys = Array.from(view.container.querySelectorAll('[data-key]')).map((el) => el.getAttribute('data-key'))
    expect(keys).toEqual(['menu', 'back', 'home', 'app_switch'])
    expect(view.queryByLabelText('Portrait')).not.toBeNull()
    expect(view.queryByLabelText('Rotate Left')).not.toBeNull()
  })

  it('keeps the full context menu', () => {
    const view = renderUi(
      <Menu opened withinPortal={false}>
        <Menu.Target><button>t</button></Menu.Target>
        <Menu.Dropdown>
          <DeviceMenuItems device={makeDevice(platform)} control={control} onStopUsing={vi.fn()} />
        </Menu.Dropdown>
      </Menu>
    )
    for (const label of ['Back', 'Home', 'Recents', 'Rotate Left', 'Rotate Right', 'Save ScreenShot']) {
      expect(view.queryByText(label), label).not.toBeNull()
    }
  })

  it('keeps SDK, ABI and SD card rows', () => {
    const view = renderUi(<InfoPane device={makeDevice(platform)} control={control} />)
    for (const label of ['SDK', 'ABI', 'SD Card Mounted']) {
      expect(view.queryByText(label), label).not.toBeNull()
    }
    expect(getSdStatus).toHaveBeenCalled()
  })

  it('keeps every tab', () => {
    const ids = panesFor(makeDevice(platform)).map((pane) => pane.id)
    expect(ids).toEqual(['dashboard', 'logs', 'screenshots', 'automation', 'advanced', 'explorer', 'info'])
  })
})
