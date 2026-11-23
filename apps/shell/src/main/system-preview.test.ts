import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
  WebContentsView: vi.fn(),
}))

vi.mock('../../../docs/src/main/docs-main', () => ({
  authorizeMcpDocWrite: () => {},
  buildDocsMenu: () => {},
  configureDocsRuntime: () => {},
  createAiDocument: () => {},
  createDocsView: () => ({}),
  defaultSaveDir: () => '',
  docsFileRenamed: () => {},
  docsQueryDirty: () => Promise.resolve(false),
  exportDocsHeadless: () => {},
  getSharedProjectStoreFromMain: () => null,
  markDocsNewBlank: () => {},
  onAiSettingsUpdated: () => {},
  projectFileRenamed: () => {},
  projectFilePaths: () => [],
  queueDocsAiContent: () => {},
  readAttachmentImageFromMain: () => {},
  readAttachmentTextFromMain: () => {},
  readLiveAiSettingsFromMain: () => ({}),
  readRecentFiles: () => [],
  readStarredFiles: () => [],
  readStarredGroupMap: () => new Map(),
  readStarredGroups: () => [],
  recordRecentFile: () => {},
  registerAiIpc: () => {},
  registerDocsIpc: () => {},
  registerProjectIpc: () => {},
  removeRecentFiles: () => {},
  removeStarredFiles: () => {},
  replaceRecentFile: () => {},
  requestDocsClose: () => Promise.resolve(true),
  setActiveDocsResolver: () => {},
  setDocsExtraFileMenuItems: () => {},
  setDocsFileOpenedHook: () => {},
  setDocsFileSavedHook: () => {},
  setDocsHostWindowHook: () => {},
  setDocsMenuGate: () => {},
  setDocsShellHooks: () => {},
  setDocsShellWindow: () => {},
  setProjectChatLifecycleHooks: () => {},
  setSessionPathResolver: () => {},
  setStarredGroup: () => {},
  teardownDocsRenderer: () => {},
  toggleStarredFile: () => {},
  uniquePathIn: () => '',
}))

vi.mock('../../../sheets/src/main/sheets-main', () => ({
  authorizeMcpSheetWrite: () => {},
  configureSheetsRuntime: () => {},
  createSheetsView: () => ({}),
  exportSheetsPdfHeadless: () => {},
  hasActiveQueuedWorkbook: () => false,
  installSheetsMenu: () => {},
  markSheetsShuttingDown: () => {},
  markSheetsUntitledPath: () => {},
  markSheetsUnsavedNew: () => {},
  nudgeQueuedWorkbook: () => {},
  pendingUnsavedNewRecoveries: () => [],
  queueWorkbookForView: () => {},
  requestSheetsClose: () => Promise.resolve(true),
  resetSheetsShuttingDown: () => {},
  resolveSheetsSessionPath: () => '',
  sendSheetsMenuAction: () => {},
  setActiveSheetsWebContents: () => {},
  setSheetsCloseTabHook: () => {},
  setSheetsExtraFileMenuItems: () => {},
  setSheetsHostWindowHook: () => {},
  setSheetsNewBlank: () => {},
  setSheetsShellWindow: () => {},
  setSheetsWorkbookOpenedHook: () => {},
  sheetsFileRenamed: () => {},
  sheetsPendingEditCount: () => 0,
  sheetsSuggestedPathTaken: () => false,
  startSheetsCaptureServer: () => {},
  stopSheetsSidecar: () => {},
  unmarkSheetsUnsavedNew: () => {},
}))

vi.mock('../../../slides/src/main/slides-main', () => ({
  configureSlidesRuntime: () => {},
  createSlidesView: () => ({}),
  discardSlidesRecovery: () => {},
  exportSlidesPdfHeadless: () => {},
  installSlidesMenu: () => {},
  readSlidesRecentFiles: () => [],
  replaceSlidesRecentFile: () => {},
  requestSlidesClose: () => Promise.resolve(true),
  setActiveSlidesWebContents: () => {},
  setSlidesCloseTabHook: () => {},
  setSlidesExtraFileMenuItems: () => {},
  setSlidesHostWindowHook: () => {},
  setSlidesOpenedHook: () => {},
  setSlidesShellWindow: () => {},
  setSlidesShowBleed: () => {},
  slidesFileRenamed: () => {},
  slidesIsDirty: () => false,
}))

vi.mock('../../../pdf/src/main/pdf-main', () => ({
  clearPdfDirty: () => {},
  configurePdfRuntime: () => {},
  createPdfView: () => ({}),
  flushPdfSave: () => {},
  markPdfUntitledPath: () => {},
  pdfFileRenamed: () => {},
  pdfIsDirty: () => false,
  pdfReadText: () => Promise.resolve(''),
  requestPdfClose: () => Promise.resolve(true),
  requestPdfSaveAs: () => {},
  sendPdfFindRequest: () => {},
  sendPdfPrintRequest: () => {},
  setPdfRedactionSavedHook: () => {},
  setPdfRenamedHook: () => {},
  setPdfSaveAsInFlight: () => {},
}))

vi.mock('../../../markdown/src/main/markdown-main', () => ({
  configureMarkdownRuntime: () => {},
  createMarkdownView: () => ({}),
  exportMarkdownPdfHeadless: () => {},
  markdownDiscardPendingAssets: () => Promise.resolve(),
  markdownFileRenamed: () => {},
  markdownIsDirty: () => false,
  markdownReadText: () => Promise.resolve(''),
  markdownSaveToPath: () => Promise.resolve(),
  requestMarkdownClose: () => Promise.resolve(true),
  requestMarkdownSave: () => {},
  sendMarkdownExportRequest: () => {},
  sendMarkdownPrintRequest: () => {},
  setMarkdownDocxExportedHook: () => {},
  setMarkdownFileSavedHook: () => {},
}))

vi.mock('../../../html/src/main/html-main', () => ({
  configureHtmlRuntime: () => {},
  createHtmlPresentView: () => ({}),
  createHtmlView: () => ({}),
  exportHtmlHeadless: () => {},
  htmlDiscardPendingAssets: () => Promise.resolve(),
  htmlFileRenamed: () => {},
  htmlIsDirty: () => false,
  htmlReadText: () => Promise.resolve(''),
  htmlSaveToPath: () => Promise.resolve(),
  registerPrivilegedSchemes: () => {},
  requestHtmlClose: () => Promise.resolve(true),
  requestHtmlSave: () => {},
  sendHtmlExportRequest: () => {},
  sendHtmlPrintRequest: () => {},
  setHtmlDocxExportedHook: () => {},
  setHtmlDocxExportPrepareHook: () => {},
  setHtmlFileSavedHook: () => {},
  setHtmlPresentHooks: () => {},
  setHtmlProvisionalTitleHook: () => {},
}))

vi.mock('../../../browser/src/main/browser-main', () => ({
  browserNavigate: () => {},
  configureBrowserRuntime: () => {},
  createBrowserView: () => ({}),
  requestBrowserClose: () => Promise.resolve(true),
  setBrowserShellHooks: () => {},
  syncBrowserPageView: () => {},
  teardownBrowserTab: () => {},
}))

import { HOME_CHANNELS, type SystemPreviewResult } from '../shared/home-api'
import {
  MAX_TRANSIENT_PREVIEW_TOKENS,
  clearMediaSessions,
  mediaSessionForToken,
  mediaSessionForWebContents,
  registerMediaSession,
  registerTransientPreviewUrl,
  setMediaFileChangedHook,
  setMediaLibraryPathResolver,
} from './media-main'
import {
  MAX_OFFICE_PREVIEW_BYTES,
  MAX_OFFICE_PREVIEW_CHARS,
  MAX_TEXT_PREVIEW_BYTES,
  decodePreviewTextBytes,
  previewSystemFile,
} from './system-preview'

const tempDirs: string[] = []

function makeTempDir(prefix = 'genoffice-syspreview-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function createMinimalDocx(filePath: string, paragraphText: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body><w:p><w:r><w:t>${paragraphText}</w:t></w:r></w:p></w:body>` +
      '</w:document>',
  )
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(filePath, buf)
}

async function createMinimalXlsx(filePath: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '</Types>',
  )
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="销售表" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>',
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' +
      '<row r="1"><c r="A1" t="inlineStr"><is><t>季度</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>2026</v></c></row>' +
      '</sheetData>' +
      '</worksheet>',
  )
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  writeFileSync(filePath, buf)
}

function encodeUtf16BeWithBom(text: string): Buffer {
  const le = Buffer.from(text, 'utf16le')
  const swapped = Buffer.allocUnsafe(le.length)
  for (let i = 0; i < le.length; i += 2) {
    swapped[i] = le[i + 1]!
    swapped[i + 1] = le[i]!
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), swapped])
}

beforeEach(() => {
  clearMediaSessions()
  setMediaFileChangedHook(null)
})

afterEach(() => {
  clearMediaSessions()
  setMediaFileChangedHook(null)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('decodePreviewTextBytes', () => {
  it('decodes UTF-8, UTF-8 BOM, UTF-16 LE/BE BOM, and GB18030 Chinese bytes cleanly', () => {
    expect(decodePreviewTextBytes(Buffer.alloc(0))).toBe('')

    const utf8Text = '[配置]\n标题=GenOffice 中文预览'
    expect(decodePreviewTextBytes(Buffer.from(utf8Text, 'utf8'))).toBe(utf8Text)

    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Text, 'utf8')])
    expect(decodePreviewTextBytes(utf8Bom)).toBe(utf8Text)

    const utf16LeBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好 UTF16-LE', 'utf16le')])
    expect(decodePreviewTextBytes(utf16LeBom)).toBe('你好 UTF16-LE')

    const utf16BeBom = encodeUtf16BeWithBom('你好 UTF16-BE')
    expect(decodePreviewTextBytes(utf16BeBom)).toBe('你好 UTF16-BE')

    // GB18030 bytes for "[配置]\r\n名称=中文预览测试"
    const gbBytes = Buffer.from([
      0x5b, 0xc5, 0xe4, 0xd6, 0xc3, 0x5d, 0x0d, 0x0a, 0xc3, 0xfb, 0xb3, 0xc6, 0x3d, 0xd6, 0xd0,
      0xce, 0xc4, 0xd4, 0xa4, 0xc0, 0xc0, 0xb2, 0xe2, 0xca, 0xd4,
    ])
    expect(decodePreviewTextBytes(gbBytes)).toBe('[配置]\r\n名称=中文预览测试')
  })
})

describe('previewSystemFile text, markdown, and html', () => {
  it('decodes UTF-8 and GB18030 .ini files with exact metadata and Chinese characters', async () => {
    const dir = makeTempDir()
    const utf8Ini = join(dir, 'utf8.ini')
    const gbIni = join(dir, 'legacy-gb.ini')
    writeFileSync(utf8Ini, '[General]\nName=系统预置配置\n', 'utf8')
    writeFileSync(
      gbIni,
      Buffer.from([
        0x5b, 0xc5, 0xe4, 0xd6, 0xc3, 0x5d, 0x0d, 0x0a, 0xc3, 0xfb, 0xb3, 0xc6, 0x3d, 0xd6, 0xd0,
        0xce, 0xc4, 0xd4, 0xa4, 0xc0, 0xc0, 0xb2, 0xe2, 0xca, 0xd4,
      ]),
    )

    const resUtf8 = await previewSystemFile(utf8Ini)
    expect(resUtf8).toMatchObject({
      path: resolve(utf8Ini),
      name: 'utf8.ini',
      ext: 'ini',
      kind: 'text',
      language: 'ini',
      truncated: false,
      canOpenInEditor: true,
    })
    expect(resUtf8.error).toBeUndefined()
    expect(resUtf8.text).toContain('系统预置配置')

    const resGb = await previewSystemFile(gbIni)
    expect(resGb).toMatchObject({
      path: resolve(gbIni),
      name: 'legacy-gb.ini',
      ext: 'ini',
      kind: 'text',
      language: 'ini',
      truncated: false,
      canOpenInEditor: true,
    })
    expect(resGb.text).toBe('[配置]\r\n名称=中文预览测试')
  })

  it('classifies markdown, html, code, and dotfiles properly', async () => {
    const dir = makeTempDir()
    const mdPath = join(dir, 'README.md')
    const htmlPath = join(dir, 'index.html')
    const ps1Path = join(dir, 'build.ps1')
    const gitignorePath = join(dir, '.gitignore')
    const dockerPath = join(dir, 'Dockerfile')

    writeFileSync(mdPath, '# 标题\n内容', 'utf8')
    writeFileSync(htmlPath, '<h1>Hello</h1>', 'utf8')
    writeFileSync(ps1Path, 'Write-Host "ok"', 'utf8')
    writeFileSync(gitignorePath, 'node_modules/\n', 'utf8')
    writeFileSync(dockerPath, 'FROM node:22\n', 'utf8')

    const mdRes = await previewSystemFile(mdPath)
    expect(mdRes.kind).toBe('markdown')
    expect(mdRes.canOpenInEditor).toBe(true)

    const htmlRes = await previewSystemFile(htmlPath)
    expect(htmlRes.kind).toBe('html')
    expect(htmlRes.canOpenInEditor).toBe(true)

    const ps1Res = await previewSystemFile(ps1Path)
    expect(ps1Res.kind).toBe('text')
    expect(ps1Res.language).toBe('ps1')
    expect(ps1Res.canOpenInEditor).toBe(false)

    const giRes = await previewSystemFile(gitignorePath)
    expect(giRes.kind).toBe('text')
    expect(giRes.language).toBe('.gitignore')
    expect(giRes.canOpenInEditor).toBe(false)

    const dfRes = await previewSystemFile(dockerPath)
    expect(dfRes.kind).toBe('text')
    expect(dfRes.language).toBe('dockerfile')
    expect(dfRes.canOpenInEditor).toBe(false)
  })

  it('reads at most 512KB of oversized logs, sets truncated: true, and keeps split trailing UTF-8 clean', async () => {
    const dir = makeTempDir()
    const logPath = join(dir, 'huge.log')
    // Fill 512KB - 1 bytes with ASCII, then append 3-byte Chinese chars so the 512KB boundary bisects one char.
    const prefix = Buffer.alloc(MAX_TEXT_PREVIEW_BYTES - 1, 0x41) // 'A'
    const tail = Buffer.from('中文日志结尾'.repeat(40_000), 'utf8')
    const full = Buffer.concat([prefix, tail])
    writeFileSync(logPath, full)

    const res = await previewSystemFile(logPath)
    expect(res.error).toBeUndefined()
    expect(res.kind).toBe('text')
    expect(res.language).toBe('log')
    expect(res.size).toBe(full.length)
    expect(res.truncated).toBe(true)
    expect(res.canOpenInEditor).toBe(true)
    expect(Buffer.byteLength(res.text!, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_PREVIEW_BYTES)
    expect(res.text!.startsWith('AAAA')).toBe(true)
    expect(res.text!).not.toContain('\uFFFD')
  })
})

describe('media/pdf preview and bounded 64-LRU transient token channel', () => {
  it('issues genoffice-media://view URLs for image, audio, video, and pdf without touching player state', async () => {
    const dir = makeTempDir()
    const libPath = join(dir, 'media-player.json')
    setMediaLibraryPathResolver(() => libPath)
    const hook = vi.fn()
    setMediaFileChangedHook(hook)

    const playerTrack = join(dir, 'player.mp3')
    writeFileSync(playerTrack, 'player')
    const playerEntry = registerMediaSession(77, playerTrack)

    const imgPath = join(dir, 'photo.png')
    const svgPath = join(dir, 'icon.svg')
    const audioPath = join(dir, 'clip.mp3')
    const videoPath = join(dir, 'demo.mp4')
    const pdfPath = join(dir, 'manual.pdf')
    for (const p of [imgPath, svgPath, audioPath, videoPath, pdfPath]) writeFileSync(p, 'data')

    const imgRes = await previewSystemFile(imgPath)
    const svgRes = await previewSystemFile(svgPath)
    const audioRes = await previewSystemFile(audioPath)
    const videoRes = await previewSystemFile(videoPath)
    const pdfRes = await previewSystemFile(pdfPath)

    expect(imgRes).toMatchObject({ kind: 'image', mime: 'image/png', canOpenInEditor: true })
    expect(svgRes).toMatchObject({ kind: 'image', mime: 'image/svg+xml', canOpenInEditor: true })
    expect(audioRes).toMatchObject({ kind: 'audio', mime: 'audio/mpeg', canOpenInEditor: true })
    expect(videoRes).toMatchObject({ kind: 'video', mime: 'video/mp4', canOpenInEditor: true })
    expect(pdfRes).toMatchObject({ kind: 'pdf', mime: 'application/pdf', canOpenInEditor: true })

    for (const r of [imgRes, svgRes, audioRes, videoRes, pdfRes]) {
      expect(r.mediaUrl).toMatch(/^genoffice-media:\/\/view\/[0-9a-f-]+$/i)
      const token = r.mediaUrl!.split('/').pop()!
      const entry = mediaSessionForToken(token)
      expect(entry?.wcId).toBe(-1)
      expect(entry?.filePath).toBe(r.path)
    }

    // Repeated preview of same normalized path returns the same transient token URL.
    const repeated = await previewSystemFile(join(dir, '.', 'manual.pdf'))
    expect(repeated.mediaUrl).toBe(pdfRes.mediaUrl)

    // Existing player session and persisted library remain untouched.
    expect(mediaSessionForWebContents(77)?.token).toBe(playerEntry.token)
    expect(mediaSessionForWebContents(-1)).toBeUndefined()
    expect(hook).not.toHaveBeenCalled()
    expect(existsSync(libPath)).toBe(false)
  })

  it('evicts oldest transient tokens past MAX_TRANSIENT_PREVIEW_TOKENS=64 with LRU refresh', () => {
    expect(MAX_TRANSIENT_PREVIEW_TOKENS).toBe(64)
    const dir = makeTempDir()
    const tokens: string[] = []
    for (let i = 1; i <= 64; i += 1) {
      const url = registerTransientPreviewUrl(join(dir, `img-${i}.png`))
      tokens.push(url.split('/').pop()!)
    }

    // Refresh item 1 to the tail of LRU queue before overflowing.
    const refreshedUrl = registerTransientPreviewUrl(join(dir, 'img-1.png'))
    expect(refreshedUrl.split('/').pop()).toBe(tokens[0])

    // Adding items 65 and 66 should evict items 2 and 3, keeping item 1 and item 66.
    const url65 = registerTransientPreviewUrl(join(dir, 'img-65.png'))
    const url66 = registerTransientPreviewUrl(join(dir, 'img-66.png'))
    const tok65 = url65.split('/').pop()!
    const tok66 = url66.split('/').pop()!

    expect(mediaSessionForToken(tokens[1]!)).toBeUndefined()
    expect(mediaSessionForToken(tokens[2]!)).toBeUndefined()
    expect(mediaSessionForToken(tokens[0]!)).toBeDefined()
    expect(mediaSessionForToken(tok65)).toBeDefined()
    expect(mediaSessionForToken(tok66)).toBeDefined()

    // Also test strict FIFO eviction when no refresh happens on a fresh run of 66 items.
    clearMediaSessions()
    expect(mediaSessionForToken(tok66)).toBeUndefined()

    const fifoTokens: string[] = []
    for (let i = 1; i <= 66; i += 1) {
      const url = registerTransientPreviewUrl(join(dir, `seq-${i}.png`))
      fifoTokens.push(url.split('/').pop()!)
    }
    expect(mediaSessionForToken(fifoTokens[0]!)).toBeUndefined()
    expect(mediaSessionForToken(fifoTokens[1]!)).toBeUndefined()
    expect(mediaSessionForToken(fifoTokens[2]!)).toBeDefined()
    expect(mediaSessionForToken(fifoTokens[65]!)).toBeDefined()

    clearMediaSessions()
    expect(mediaSessionForToken(fifoTokens[65]!)).toBeUndefined()
  })
})

describe('office preview and error boundaries', () => {
  it('parses real .docx and .xlsx via @genoffice/file-parse with canOpenInEditor: true', async () => {
    const dir = makeTempDir()
    const docxPath = join(dir, 'contract.docx')
    const xlsxPath = join(dir, 'budget.xlsx')
    await createMinimalDocx(docxPath, 'GenOffice 合同正文段落')
    await createMinimalXlsx(xlsxPath)

    const docxRes = await previewSystemFile(docxPath)
    expect(docxRes).toMatchObject({
      kind: 'office',
      canOpenInEditor: true,
      truncated: false,
    })
    expect(docxRes.error).toBeUndefined()
    expect(docxRes.text).toContain('GenOffice 合同正文段落')

    const xlsxRes = await previewSystemFile(xlsxPath)
    expect(xlsxRes).toMatchObject({
      kind: 'office',
      canOpenInEditor: true,
      truncated: false,
    })
    expect(xlsxRes.error).toBeUndefined()
    expect(xlsxRes.text).toContain('销售表')
    expect(xlsxRes.text).toContain('2026')
  })

  it('supports injected parseOfficeFile, truncates over MAX_OFFICE_PREVIEW_CHARS, and enforces 40MB cap', async () => {
    const dir = makeTempDir()
    const docxPath = join(dir, 'injected.docx')
    writeFileSync(docxPath, 'placeholder')

    const longText = 'X'.repeat(MAX_OFFICE_PREVIEW_CHARS + 25)
    const parseSpy = vi.fn(async () => ({
      ok: true,
      kind: 'text',
      text: longText,
    }))
    const res = await previewSystemFile(docxPath, { parseOfficeFile: parseSpy })
    expect(parseSpy).toHaveBeenCalledWith(resolve(docxPath), {
      maxChars: MAX_OFFICE_PREVIEW_CHARS,
    })
    expect(res.kind).toBe('office')
    expect(res.truncated).toBe(true)
    expect(res.text?.length).toBe(MAX_OFFICE_PREVIEW_CHARS)
    expect(res.canOpenInEditor).toBe(true)

    const failedRes = await previewSystemFile(docxPath, {
      parseOfficeFile: async () => ({ ok: false, kind: 'text', error: 'corrupt' }),
    })
    expect(failedRes.kind).toBe('office')
    expect(failedRes.error).toBe('parse-failed')

    const oversizedDocx = join(dir, 'huge.docx')
    writeFileSync(oversizedDocx, '')
    truncateSync(oversizedDocx, MAX_OFFICE_PREVIEW_BYTES + 1)
    const neverCalled = vi.fn()
    const bigRes = await previewSystemFile(oversizedDocx, { parseOfficeFile: neverCalled })
    expect(bigRes.kind).toBe('office')
    expect(bigRes.error).toBe('too-large')
    expect(bigRes.canOpenInEditor).toBe(true)
    expect(neverCalled).not.toHaveBeenCalled()
  })

  it('returns unsupported without reading body for binaries like .dll and handles missing or directory paths', async () => {
    const dir = makeTempDir()
    const dllPath = join(dir, 'native.dll')
    writeFileSync(dllPath, Buffer.from([0x4d, 0x5a, 0x90, 0x00]))

    const dllRes = await previewSystemFile(dllPath)
    expect(dllRes).toMatchObject({
      path: resolve(dllPath),
      name: 'native.dll',
      ext: 'dll',
      size: 4,
      kind: 'unsupported',
      mime: 'application/octet-stream',
      canOpenInEditor: false,
    })
    expect(dllRes.text).toBeUndefined()
    expect(dllRes.mediaUrl).toBeUndefined()

    const emptyRes = await previewSystemFile('')
    expect(emptyRes.error).toBe('missing')

    const missingRes = await previewSystemFile(join(dir, 'absent.txt'))
    expect(missingRes.error).toBe('missing')

    const subDir = join(dir, 'subdir')
    mkdirSync(subDir)
    const dirRes = await previewSystemFile(subDir)
    expect(dirRes.error).toBe('not-file')
  })

  it('validates home:system-preview-file IPC arguments and never modifies folderRoots', async () => {
    const userData = makeTempDir('genoffice-preview-ipc-')
    const settingsPath = join(userData, 'app-settings.json')
    const initialSettings = JSON.stringify({ folderRoots: [] }, null, 2)
    writeFileSync(settingsPath, initialSettings, 'utf8')

    const targetIni = join(userData, 'sample.ini')
    writeFileSync(targetIni, '[section]\nkey=中文\n', 'utf8')

    const handles = new Map<string, (...args: unknown[]) => unknown>()
    vi.resetModules()
    vi.doMock('electron', () => ({
      app: { getPath: () => userData, isPackaged: false },
      BrowserWindow: { fromWebContents: () => null },
      dialog: { showOpenDialog: vi.fn() },
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
          handles.set(channel, handler),
      },
      protocol: { handle: vi.fn() },
      shell: { openPath: vi.fn(), openExternal: vi.fn(), showItemInFolder: vi.fn() },
      WebContentsView: vi.fn(),
    }))
    vi.doMock('./app-registry', () => ({
      appForPath: (p: string) => (p.endsWith('.ini') ? 'markdown' : undefined),
      appForKind: () => undefined,
      documentApps: [],
      defaultSaveDir: () => join(userData, 'save'),
      projectFileRenamed: () => {},
      readRecentFiles: () => [],
      readStarredFiles: () => [],
      readStarredGroupMap: () => new Map(),
      readStarredGroups: () => [],
      recordRecentFile: () => {},
      removeRecentFiles: () => {},
      removeStarredFiles: () => {},
      setStarredGroup: () => {},
      toggleStarredFile: () => {},
      uniquePathIn: () => '',
    }))

    try {
      const { registerHomeFileIpc } = await import('./home-ipc')
      registerHomeFileIpc({
        translate: (k) => k,
        appSettingsPath: () => settingsPath,
        getShellWindow: () => null,
        getTabManager: () => null,
        ensureFileIndexer: () => null,
        indexStore: () => null,
        refreshIndexer: () => {},
        indexNow: async () => {},
        readFileSearchSettings: () => ({}) as never,
        ensureSearchReranker: () => null,
        openDocumentPath: () => true,
        openDocumentAtText: () => {},
        rememberPendingDir: () => {},
        newDocTab: () => {},
        newSheetTab: () => {},
        newSlideTab: () => {},
        newMarkdownTab: () => {},
        newHtmlTab: () => {},
        newBrowserTab: () => {},
        newPdfTab: () => {},
        afterFileMoved: () => {},
        afterFolderMoved: () => {},
        trackedFilesUnder: () => [],
        fileTargetSources: () => ({}) as never,
        statMaybeFile: () => null,
        openDocumentPaths: () => [],
        extraFolderRoots: () => [],
        insideAnyRoot: () => false,
        isAnyRoot: () => false,
        desktopAliases: () => [],
        ensureFolderWatchers: () => {},
        droppedFilesDeps: () => ({}) as never,
        cliRunner: () => ({}) as never,
        fetchGithubStars: async () => null,
        openDialogExtensions: [],
        runEditorCommand: () => {},
      })

      const previewHandler = handles.get(HOME_CHANNELS.systemPreviewFile)!
      expect(previewHandler).toBeDefined()

      const relRes = (await previewHandler({} as never, 'relative/sample.ini')) as SystemPreviewResult
      expect(relRes.error).toBe('missing')

      const nonStringRes = (await previewHandler({} as never, 123)) as SystemPreviewResult
      expect(nonStringRes.error).toBe('missing')

      const emptyRes = (await previewHandler({} as never, '')) as SystemPreviewResult
      expect(emptyRes.error).toBe('missing')

      const overlongRes = (await previewHandler(
        {} as never,
        `C:\\${'a'.repeat(4100)}`,
      )) as SystemPreviewResult
      expect(overlongRes.error).toBe('missing')

      const okRes = (await previewHandler({} as never, targetIni)) as SystemPreviewResult
      expect(okRes.error).toBeUndefined()
      expect(okRes.kind).toBe('text')
      expect(okRes.language).toBe('ini')
      expect(okRes.text).toContain('中文')
      expect(okRes.canOpenInEditor).toBe(true)

      expect(readFileSync(settingsPath, 'utf8')).toBe(initialSettings)
    } finally {
      vi.doUnmock('electron')
      vi.doUnmock('./app-registry')
      vi.resetModules()
    }
  })
})
