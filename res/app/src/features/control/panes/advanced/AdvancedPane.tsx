import {SimpleGrid} from '@mantine/core'
import {isIosDevice} from '@/core/devices/platform'
import type {PaneProps} from '../../types'
import {AdvancedInputCard} from './AdvancedInputCard'
import {MaintenanceCard} from './MaintenanceCard'
import {PortForwardingCard} from './PortForwardingCard'

export default function AdvancedPane({device, control}: PaneProps) {
  return (
    <SimpleGrid minColWidth='min(380px, 100%)' autoFlow='auto-fit' spacing='md' className='stf-advanced'>
      <AdvancedInputCard device={device} control={control} />
      {!isIosDevice(device) && <PortForwardingCard device={device} control={control} />}
      <MaintenanceCard control={control} />
    </SimpleGrid>
  )
}
