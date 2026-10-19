import cp from 'node:child_process'

import {expect} from 'chai'

function stf(args: string[]) {
  return cp.spawnSync('./bin/stf', args, {encoding: 'utf8', timeout: 60000})
}

describe('iOS CLI commands', function() {
  this.timeout(70000)

  it('ios-device --help lists its flags', function() {
    var res = stf(['ios-device', '--help'])
    expect(res.status).to.equal(0)
    expect(res.stdout).to.contain('--wda-port')
    expect(res.stdout).to.contain('--mjpeg-port')
    expect(res.stdout).to.contain('--ios-backend')
  })

  it('ios-provider --help lists its flags', function() {
    var res = stf(['ios-provider', '--help'])
    expect(res.status).to.equal(0)
    expect(res.stdout).to.contain('--poll-interval')
    expect(res.stdout).to.contain('--ios-backend')
  })

  it('local --help offers the opt-in iOS provider', function() {
    var res = stf(['local', '--help'])
    expect(res.status).to.equal(0)
    expect(res.stdout).to.contain('--ios-provider')
  })
})
