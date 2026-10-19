import assert from 'node:assert'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {readAppInfo} from '../../lib/units/ios-device/backend/info-plist.js'

function plist(entries: Record<string, string>): string {
  const body = Object.entries(entries)
    .map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`)
    .join('\n')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>'
  , '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  , '<plist version="1.0">\n<dict>'
  , body
  , '</dict>\n</plist>\n'
  ].join('\n')
}

function stfTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('stf-ios-app-'))
}

describe('iOS app info reader', function() {
  this.timeout(15000)

  let dir: string
   , savedTmp: string | undefined

  // Private TMPDIR so the temp-dir cleanup assertions are not disturbed by
  // other processes extracting ipas at the same time.
  before(function() {
    savedTmp = process.env.TMPDIR
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stf-ios-plist-'))
    const tmp = path.join(dir, 'tmp')
    fs.mkdirSync(tmp)
    process.env.TMPDIR = tmp
  })

  after(function() {
    if (savedTmp === undefined) {
      delete process.env.TMPDIR
    }
    else {
      process.env.TMPDIR = savedTmp
    }
    fs.rmSync(dir, {recursive: true, force: true})
  })

  function makeApp(parent: string, name: string, entries: Record<string, string>) {
    const app = path.join(parent, name)
    fs.mkdirSync(app, {recursive: true})
    fs.writeFileSync(path.join(app, 'Info.plist'), plist(entries))
    return app
  }

  function makeIpa(name: string, entries: Record<string, string>) {
    const root = path.join(dir, name + '-root')
    makeApp(path.join(root, 'Payload'), 'Demo.app', entries)
    const ipa = path.join(dir, name + '.ipa')
    childProcess.execFileSync('zip', ['-qr', ipa, 'Payload'], {cwd: root})
    return ipa
  }

  it('should read an .app directory and prefer CFBundleDisplayName', async function() {
    const app = makeApp(dir, 'Plain.app', {
      CFBundleIdentifier: 'com.example.plain'
    , CFBundleDisplayName: 'Plain Display'
    , CFBundleName: 'Plain'
    , CFBundleShortVersionString: '1.2.3'
    })
    assert.deepEqual(await readAppInfo(app), {
      bundleId: 'com.example.plain'
    , name: 'Plain Display'
    , version: '1.2.3'
    })
  })

  it('should fall back to CFBundleName and omit a missing version', async function() {
    const app = makeApp(dir, 'Bare.app', {
      CFBundleIdentifier: 'com.example.bare'
    , CFBundleName: 'Bare'
    })
    assert.deepEqual(await readAppInfo(app), {bundleId: 'com.example.bare', name: 'Bare'})
  })

  it('should read an .ipa and clean up its temp directory', async function() {
    const ipa = makeIpa('demo', {
      CFBundleIdentifier: 'com.example.demo'
    , CFBundleName: 'Demo'
    , CFBundleShortVersionString: '4.5'
    })
    const before = stfTempDirs()
    assert.deepEqual(await readAppInfo(ipa), {
      bundleId: 'com.example.demo'
    , name: 'Demo'
    , version: '4.5'
    })
    assert.deepEqual(stfTempDirs(), before)
  })

  it('should clean up even when the plist is unusable', async function() {
    const ipa = makeIpa('noid', {CFBundleName: 'NoId'})
    const before = stfTempDirs()
    await assert.rejects(readAppInfo(ipa), /no CFBundleIdentifier/)
    assert.deepEqual(stfTempDirs(), before)
  })

  it('should reject an ipa without a Payload app and leave no temp dir', async function() {
    const root = path.join(dir, 'empty-root')
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'readme.txt'), 'x')
    const ipa = path.join(dir, 'empty.ipa')
    childProcess.execFileSync('zip', ['-qr', ipa, 'readme.txt'], {cwd: root})
    const before = stfTempDirs()
    await assert.rejects(readAppInfo(ipa))
    assert.deepEqual(stfTempDirs(), before)
  })

  it('should reject a path that is neither an ipa nor an app', async function() {
    await assert.rejects(readAppInfo(path.join(dir, 'missing.app')), /Not an \.ipa or \.app/)
  })
})
