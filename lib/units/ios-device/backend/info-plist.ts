import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {run} from './exec.js'
import type {IosAppInfo} from '../types.js'

interface InfoPlist {
  CFBundleIdentifier?: string
  CFBundleDisplayName?: string
  CFBundleName?: string
  CFBundleShortVersionString?: string
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stf-ios-app-'))
}

function removeDir(dir: string) {
  fs.rmSync(dir, {recursive: true, force: true})
}

function findAppDir(extracted: string): string {
  const payload = path.join(extracted, 'Payload')
  const entries = fs.existsSync(payload) ? fs.readdirSync(payload) : []
  const app = entries.find(name => name.endsWith('.app'))
  if (!app) {
    throw new Error('No Payload/*.app found in ipa')
  }
  return path.join(payload, app)
}

export interface ExtractedApp {
  appPath: string
  cleanup(): void
}

// Unpacks an .ipa into a temp dir. `only` limits extraction to matching
// entries (unzip pattern), `cleanup` removes the temp dir.
export async function extractIpa(ipaPath: string, only?: string): Promise<ExtractedApp> {
  const dir = makeTempDir()
  try {
    await run('unzip', ['-q', '-o', ipaPath, only ?? 'Payload/*', '-d', dir])
    return {appPath: findAppDir(dir), cleanup: () => removeDir(dir)}
  }
  catch (err) {
    removeDir(dir)
    throw err
  }
}

export function isIpa(appPath: string): boolean {
  return appPath.toLowerCase().endsWith('.ipa')
}

async function readPlist(plistPath: string): Promise<InfoPlist> {
  const {stdout} = await run('plutil', ['-convert', 'json', '-o', '-', plistPath])
  return JSON.parse(stdout) as InfoPlist
}

function toAppInfo(plist: InfoPlist): IosAppInfo {
  if (!plist.CFBundleIdentifier) {
    throw new Error('Info.plist has no CFBundleIdentifier')
  }
  const info: IosAppInfo = {bundleId: plist.CFBundleIdentifier}
  const name = plist.CFBundleDisplayName || plist.CFBundleName
  if (name) {
    info.name = name
  }
  if (plist.CFBundleShortVersionString) {
    info.version = plist.CFBundleShortVersionString
  }
  return info
}

// Reads bundle metadata from an .ipa or an .app directory.
export async function readAppInfo(appPath: string): Promise<IosAppInfo> {
  if (isIpa(appPath)) {
    const extracted = await extractIpa(appPath, 'Payload/*/Info.plist')
    try {
      return toAppInfo(await readPlist(path.join(extracted.appPath, 'Info.plist')))
    }
    finally {
      extracted.cleanup()
    }
  }
  if (!fs.existsSync(path.join(appPath, 'Info.plist'))) {
    throw new Error('Not an .ipa or .app bundle: ' + path.basename(appPath))
  }
  return toAppInfo(await readPlist(path.join(appPath, 'Info.plist')))
}
