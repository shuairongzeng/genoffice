import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { LAUNCHABLE_EXTS } from '../src/main/launch-paths'

const require = createRequire(import.meta.url)
// Inspect packaging metadata without downloading Electron or compiling OCR
// helpers (same approach as shell-new.test.ts).
const configModule = { exports: {} as ReturnType<typeof require> }
runInNewContext(readFileSync(resolve(import.meta.dirname, '../electron-builder.cjs'), 'utf8'), {
  module: configModule,
  __dirname: resolve(import.meta.dirname, '..'),
  process: { platform: 'linux', arch: 'x64', env: {} },
  require: (id: string) =>
    id === 'node:fs' ? { ...require(id), existsSync: () => true } : require(id),
})
const config = configModule.exports
const installerNsh = readFileSync(resolve(import.meta.dirname, '../build/installer.nsh'), 'utf8')

type AssociationEntry = {
  ext: string
  name: string
  description?: string
  mimeType?: string
}

// Mirror PlatformPackager.get fileAssociations() in app-builder-lib, which
// concatenates top-level fileAssociations with the platform-specific list.
function effectiveAssociations(platform: 'win' | 'mac' | 'linux'): AssociationEntry[] {
  return [
    ...((config.fileAssociations ?? []) as AssociationEntry[]),
    ...((config[platform]?.fileAssociations ?? []) as AssociationEntry[]),
  ]
}

describe('packaged file associations', () => {
  it('advertises every launchable extension uniquely with descriptions and mimeTypes on mac and linux', () => {
    for (const platform of ['mac', 'linux'] as const) {
      const list = effectiveAssociations(platform)
      const exts = list.map((entry) => entry.ext)
      expect(new Set(exts).size, `${platform} has duplicate fileAssociations`).toBe(exts.length)
      expect(exts).toHaveLength(LAUNCHABLE_EXTS.length)
      for (const ext of LAUNCHABLE_EXTS) {
        const entry = list.find((item) => item.ext === ext)
        expect(entry, `no file association declared for .${ext} on ${platform}`).toBeTruthy()
        expect(entry?.description, `.${ext} missing description`).toBeTruthy()
        expect(entry?.mimeType, `.${ext} missing mimeType on ${platform}`).toBeTruthy()
      }
    }
  })

  it('resolves Windows to 55 unique associations without duplicating entries or leaking .bat', () => {
    const winList = effectiveAssociations('win')
    const winExts = winList.map((entry) => entry.ext)
    const expectedWinExts = LAUNCHABLE_EXTS.filter((ext) => ext !== 'bat')

    expect(config.win.fileAssociations).toBeUndefined()
    expect(new Set(winExts).size).toBe(winExts.length)
    expect(winExts).not.toContain('bat')
    expect(winExts).toHaveLength(expectedWinExts.length)
    for (const ext of expectedWinExts) {
      const entry = winList.find((item) => item.ext === ext)
      expect(entry, `.${ext} missing from Windows associations`).toBeTruthy()
      expect(entry?.description, `.${ext} missing Windows description`).toBeTruthy()
    }
  })

  it('keeps installer.nsh capabilities and context verbs aligned with Windows associations', () => {
    const winList = effectiveAssociations('win')
    const capMatches = [
      ...installerNsh.matchAll(/!insertmacro\s+GenOfficeRegisterCapability\s+"([^"]+)"\s+"([^"]+)"/g),
    ]
    const registeredCaps = new Map(capMatches.map((m) => [m[1], m[2]]))
    expect(capMatches).toHaveLength(winList.length)

    for (const entry of winList) {
      expect(registeredCaps.get(entry.ext), `mismatch for .${entry.ext} capability ProgID`).toBe(
        entry.name,
      )
    }

    const addVerbs = new Set(
      [...installerNsh.matchAll(/!insertmacro\s+GenOfficeRegisterOpenVerb\s+"([^"]+)"/g)].map(
        (m) => m[1],
      ),
    )
    const delVerbs = new Set(
      [...installerNsh.matchAll(/!insertmacro\s+GenOfficeUnregisterOpenVerb\s+"([^"]+)"/g)].map(
        (m) => m[1],
      ),
    )

    for (const ext of LAUNCHABLE_EXTS) {
      expect(addVerbs.has(ext), `.${ext} missing GenOfficeRegisterOpenVerb`).toBe(true)
      expect(delVerbs.has(ext), `.${ext} missing GenOfficeUnregisterOpenVerb`).toBe(true)
    }

    expect(installerNsh).toContain(
      'WriteRegStr SHELL_CONTEXT "Software\\RegisteredApplications" "GenOffice" "Software\\GenOffice\\Capabilities"',
    )
    expect(installerNsh).toContain(
      'DeleteRegValue SHELL_CONTEXT "Software\\RegisteredApplications" "GenOffice"',
    )
    expect(installerNsh).toContain('DeleteRegKey SHELL_CONTEXT "Software\\GenOffice\\Capabilities"')
  })
})
