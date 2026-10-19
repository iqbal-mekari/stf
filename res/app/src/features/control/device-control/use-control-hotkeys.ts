import {useHotkeys, type HotkeyItem} from '@mantine/hooks'
import {useNavigate} from 'react-router'
import type {Control} from '@/core/control'
import {isIosDevice} from '@/core/devices/platform'
import type {Device} from '@/core/devices/types'
import {usePlatform} from '@/ui/modes'
import type {DeviceActions} from './use-device-actions'

const allowInInputs = ['SELECT']

function androidHotkeys(control: Control, actions: DeviceActions): HotkeyItem[] {
  return [
    ['shift+space', () => control.keyPress('switch_charset')]
    , ['meta+ArrowLeft', () => actions.rotateBy(-90)]
    , ['meta+ArrowRight', () => actions.rotateBy(90)]
    , ['meta+shift+M', () => control.menu()]
    , ['meta+shift+B', () => control.back()]
  ]
}

export function useControlHotkeys(device: Device, control: Control, actions: DeviceActions) {
  const navigate = useNavigate()
  const [platform, setPlatform] = usePlatform()
  const ios = isIosDevice(device)

  useHotkeys([
    ['meta+shift+D', () => navigate('/devices')]
    , ...(ios ? [] : androidHotkeys(control, actions))
    , ['meta+shift+H', () => control.home()]
    , ['shift+W', () => setPlatform(platform === 'web' ? 'native' : 'web'), {preventDefault: false}]
  ], allowInInputs)
}
