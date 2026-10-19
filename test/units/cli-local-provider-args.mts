import {expect} from 'chai'
import yargs from 'yargs'
import type {Argv} from 'yargs'

import * as local from '../../lib/cli/local/index.js'
import * as provider from '../../lib/cli/provider/index.js'
import * as iosProvider from '../../lib/cli/ios-provider/index.js'

interface CommandModule {
  command: string
  builder: unknown
}

// Parses args exactly like the CLI: the module is registered as a command so
// its `[serial..]` positional is recognised.
function parse(mod: CommandModule, args: (string | number)[]): Record<string, unknown> {
  var name = mod.command.split(' ')[0] || mod.command
  return yargs([name].concat(args.map(String)))
    .exitProcess(false)
    .command(mod.command, '', mod.builder as (y: Argv) => Argv)
    .fail(function(msg: string, err: Error) {
      throw err || new Error(msg)
    })
    .parseSync() as Record<string, unknown>
}

function localArgv(args: string[]) {
  // The provider argument lists built from `local` are then parsed by the
  // real provider command builders.
  return parse(local, args) as unknown as Parameters<typeof local.providerArgs>[0]
}

describe('stf local provider arguments', function() {
  it('keeps the serial filter for the Android provider with default cleanup folders', function() {
    var argv = localArgv(['SERIAL-A', 'SERIAL-B'])
    var built = local.providerArgs(argv)
    expect(built[0]).to.equal('provider')
    expect(built).to.not.include('--cleanup-folder')
    var parsed = parse(provider, built.slice(1))
    expect(parsed.serial).to.deep.equal(['SERIAL-A', 'SERIAL-B'])
  })

  it('keeps the serial filter when cleanup folders are given', function() {
    var argv = localArgv(['SERIAL-A', '--cleanup-folder', '/data/local', '/tmp'])
    var parsed = parse(provider, local.providerArgs(argv).slice(1))
    expect(parsed.serial).to.deep.equal(['SERIAL-A'])
    expect(parsed.cleanupFolder).to.deep.equal(['/data/local', '/tmp'])
  })

  it('passes no serials when none are given, so every device is used', function() {
    var parsed = parse(provider, local.providerArgs(localArgv([])).slice(1))
    expect(parsed.serial).to.deep.equal([])
  })

  it('applies the same serial filter to the iOS provider', function() {
    var argv = localArgv(['--ios-provider', '--ios-backend', 'fake', 'SERIAL-A', 'UDID-B'])
    var built = local.iosProviderArgs(argv)
    expect(built[0]).to.equal('ios-provider')
    var parsed = parse(iosProvider, built.slice(1))
    expect(parsed.serial).to.deep.equal(['SERIAL-A', 'UDID-B'])
    expect(parsed.iosBackend).to.equal('fake')
  })
})
