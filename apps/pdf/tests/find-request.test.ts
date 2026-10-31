import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PDF_CHANNELS } from '../src/shared/ipc'

// The shell main and the preload import electron and App.tsx pulls the editor
// and i18n, so none of those modules can load in this jsdom suite. The find
// wiring is therefore pinned by reading the sources: the defect being guarded
// is a missing or misrouted registration, which is exactly what this checks
// (the html suite's print-request.test.ts pins the same chain the same way —
// that chain once shipped dead: a menu that sent and no renderer received).
const source = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const APP = '../src/renderer/App.tsx'
const PRELOAD = '../src/preload/index.ts'
const MAIN = '../src/main/pdf-main.ts'
const SHELL_MAIN = '../../../apps/shell/src/main/index.ts'
const ZH = '../src/renderer/i18n/lang/zh.ts'
const EN = '../src/renderer/i18n/lang/en.ts'

describe('PDF find wiring (issue #56 P1 #6)', () => {
  it('declares a find request channel distinct from the print channel', () => {
    // Sharing the print channel would run the print flow from the menu's Find.
    expect(PDF_CHANNELS.findRequest).toBe('pdf:find-request')
    expect(PDF_CHANNELS.printRequest).toBe('pdf:print-request')
  })

  it('sends the find request from the shell pdf menu on the chord accelerator', async () => {
    // menu-driven discovery and ⌘F meet at the same find bar: the item must
    // carry the accelerator and dispatch to the live pdf tab
    const main = await source(SHELL_MAIN)
    const item = main.slice(main.indexOf("label: tm('menuFind')"))
    expect(item).toMatch(/accelerator: 'CmdOrCtrl\+F'/)
    expect(item).toMatch(/sendPdfFindRequest\(tab\.webContents\)/)
    expect(main).toMatch(/import \{[^}]*sendPdfFindRequest[^}]*\} from '\.\/app-registry'/)
  })

  it('main sends only to live contents over the declared channel', async () => {
    const main = await source(MAIN)
    const fn = main.slice(main.indexOf('export function sendPdfFindRequest'))
    expect(fn).toMatch(/contents\.isDestroyed\(\)/)
    expect(fn).toMatch(/contents\.send\(PDF_CHANNELS\.findRequest\)/)
  })

  it('exposes onFindRequest over the preload with a disposing subscription', async () => {
    const preload = await source(PRELOAD)
    expect(preload).toMatch(/onFindRequest: \(handler\) => \{/)
    expect(preload).toMatch(/ipcRenderer\.on\(PDF_CHANNELS\.findRequest, listener\)/)
    // leaving the listener attached across a remount would open the bar twice
    expect(preload).toMatch(
      /return \(\) => ipcRenderer\.removeListener\(PDF_CHANNELS\.findRequest, listener\)/,
    )
  })

  it('the renderer opens the find bar on the request and disposes the subscription', async () => {
    const app = await source(APP)
    expect(app).toMatch(/return window\.pdfApi\.onFindRequest\(openSearch\)/)
  })

  it('threads the two find options into the search and re-runs on their change', async () => {
    // dropping the options (or the deps) leaves the toggles inert: the bar
    // re-searches only when the query changes
    const app = await source(APP)
    expect(app).toMatch(/caseSensitive: searchCaseSensitive,/)
    expect(app).toMatch(/wholeWord: searchWholeWord,/)
    expect(app).toMatch(
      /\[searchOpen, searchQuery, searchCaseSensitive, searchWholeWord, getSearchIndex\]/,
    )
  })

  it('labels the toggles with the i18n keys zh defines', async () => {
    // zh defines the key set and the siblings' satisfies constraint carries
    // it to every locale; zh+en presence pins the key names themselves
    const [zh, en] = await Promise.all([source(ZH), source(EN)])
    expect(zh).toMatch(/searchCase: '/)
    expect(zh).toMatch(/searchWholeWord: '/)
    expect(en).toMatch(/searchCase: '/)
    expect(en).toMatch(/searchWholeWord: '/)
  })
})
