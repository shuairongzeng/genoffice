import { basename } from 'node:path'
import type { WebContents } from 'electron'
import type { CompareDocumentMeta, CompareSourceRef } from '../../shared/compare-api'
import type { TabKind } from '../../shared/tabs-api'
import { splitLines } from './text-diff-engine'

export const MAX_COMPARE_CHARS = 300_000
const MAX_DOCS_PAGINATION_CHUNKS = 40
const MAX_DOCS_RAW_HTML_CHARS = MAX_COMPARE_CHARS * 4

export interface DocumentTabInfo {
  id: string
  kind: TabKind
  title: string
  filePath?: string
  webContents?: WebContents
}

export interface ParseFileResult {
  ok: boolean
  kind: string
  text?: string
  error?: string
}

export interface DocumentTextExtractorDeps {
  findTab: (tabId: string) => DocumentTabInfo | undefined
  readLiveDocs?: (wc: WebContents, payload?: Record<string, unknown>) => Promise<{ text?: string }>
  readLiveSheets?: (wc: WebContents, payload?: Record<string, unknown>) => Promise<unknown>
  readLiveSlides?: (wc: WebContents, payload?: Record<string, unknown>) => Promise<unknown>
  readLivePdf?: (wc: WebContents) => Promise<string>
  readLiveMarkdown?: (wc: WebContents) => Promise<string>
  readLiveHtml?: (wc: WebContents) => Promise<string>
  readLiveBrowser?: (wc: WebContents) => Promise<string>
  parseFileOnDisk: (filePath: string) => Promise<ParseFileResult>
}

export interface ExtractedDocument {
  meta: CompareDocumentMeta
  text: string
}

export interface DocumentTextExtractor {
  extract: (ref: CompareSourceRef) => Promise<ExtractedDocument>
}

const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
}

const HTML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|nbsp|amp|lt|gt|quot|apos);/gi
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/

function decodeHtmlEntities(text: string): string {
  return text.replace(HTML_ENTITY_RE, (full, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower in NAMED_HTML_ENTITIES) {
      return NAMED_HTML_ENTITIES[lower]!
    }
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16)
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code)
      }
      return full
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10)
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code)
      }
      return full
    }
    return full
  })
}

function normalizePlainText(text: string, trimLeadingWhitespace = true): string {
  const normalized = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
  return trimLeadingWhitespace ? normalized.trim() : normalized.replace(/^\n+|\n+$/g, '').trimEnd()
}

/** Convert an HTML fragment or document into normalized plain text. */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, '\t')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')

  text = decodeHtmlEntities(text)
  return normalizePlainText(text)
}

interface DocsLiveChunk {
  rawBody: string
  hasHtml: boolean
  totalLength?: number
  nextOffset?: number
}

const DOCS_HEADER_RE = /^##\s+(?:Full content|Content preview)\b[^\n]*\r?\n?/im
const DOCS_TRUNCATED_RE =
  /(?:\r?\n)?(?:\u2026|\.\.\.)?\(truncated:\s*(\d+)\s+characters in total([^\n]*)\)\s*$/i
const DOCS_END_RANGE_RE = /(?:\r?\n)?\(end of range:\s*(\d+)\s+characters in total\)\s*$/i
const DOCS_OFFSET_RE = /\boffset=(\d+)\b/i
const DOCS_OVERVIEW_HEAD_RE = /^The document has (\d+) blocks, listed below\b[^\n]*\r?\n?/i

function isDocsOverviewMetaLine(line: string): boolean {
  return (
    /^Full-text stats:/i.test(line) ||
    /^Tracked changes:/i.test(line) ||
    /^Current selection:/i.test(line) ||
    /^No selection;/i.test(line) ||
    /^Header\b/i.test(line) ||
    /^Footer\b/i.test(line) ||
    /^(?:\u2026|\.\.\.)?\(\d+ blocks elided here/i.test(line)
  )
}

function stripDocsOverview(raw: string): string {
  const headMatch = DOCS_OVERVIEW_HEAD_RE.exec(raw)
  if (!headMatch) return raw
  const blockCount = Number.parseInt(headMatch[1] ?? '0', 10)
  if (blockCount === 0) return ''

  const lines = raw.slice(headMatch[0].length).replace(/\r\n?/g, '\n').split('\n')
  const extracted: string[] = []
  for (const line of lines) {
    if (!line.trim() || isDocsOverviewMetaLine(line)) continue
    const blockMatch = /^\d+\|[^|]+\|(.*)$/.exec(line)
    if (blockMatch) {
      const content = blockMatch[1] ?? ''
      if (content) extracted.push(content)
    } else {
      extracted.push(line)
    }
  }
  return extracted.join('\n')
}

function parseDocsLiveChunk(rawText: string): DocsLiveChunk {
  const normalizedInput = rawText.replace(/\r\n?/g, '\n')
  const trimmed = normalizedInput.trim()
  if (trimmed === '(document is empty)' || trimmed === '(range is empty)') {
    return { rawBody: '', hasHtml: false }
  }

  let body = normalizedInput
  let totalLength: number | undefined
  let nextOffset: number | undefined

  const truncMatch = DOCS_TRUNCATED_RE.exec(body)
  if (truncMatch) {
    totalLength = Number.parseInt(truncMatch[1]!, 10)
    const offsetMatch = DOCS_OFFSET_RE.exec(truncMatch[2] ?? '')
    if (offsetMatch) {
      nextOffset = Number.parseInt(offsetMatch[1]!, 10)
    }
    body = body.slice(0, truncMatch.index)
  } else {
    const endMatch = DOCS_END_RANGE_RE.exec(body)
    if (endMatch) {
      totalLength = Number.parseInt(endMatch[1]!, 10)
      body = body.slice(0, endMatch.index)
    }
  }

  const headerMatch = DOCS_HEADER_RE.exec(body)
  if (headerMatch) {
    body = body.slice(headerMatch.index + headerMatch[0].length)
  } else if (DOCS_OVERVIEW_HEAD_RE.test(body)) {
    body = stripDocsOverview(body)
  }

  const hasHtml = HTML_TAG_RE.test(body)
  return {
    rawBody: body,
    hasHtml,
    ...(totalLength !== undefined && Number.isFinite(totalLength) ? { totalLength } : {}),
    ...(nextOffset !== undefined && Number.isFinite(nextOffset) ? { nextOffset } : {}),
  }
}

/** Parse one Docs `read_document` response into plain text plus optional pagination metadata. */
export function extractDocsLivePlainText(rawText: string): {
  text: string
  totalLength?: number
  nextOffset?: number
} {
  const chunk = parseDocsLiveChunk(rawText)
  const text = chunk.hasHtml ? htmlToPlainText(chunk.rawBody) : normalizePlainText(chunk.rawBody)
  return {
    text,
    ...(chunk.totalLength !== undefined ? { totalLength: chunk.totalLength } : {}),
    ...(chunk.nextOffset !== undefined ? { nextOffset: chunk.nextOffset } : {}),
  }
}

function formatSheetCell(cell: unknown): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
    return String(cell)
  }
  if (typeof cell === 'object') {
    const obj = cell as Record<string, unknown>
    const candidate = obj.display ?? obj.text ?? obj.value ?? obj.formula
    if (candidate !== undefined && candidate !== null) return String(candidate)
  }
  return ''
}

function formatSheetRows(rows: unknown[]): string {
  const lines: string[] = []
  for (const row of rows) {
    if (Array.isArray(row)) {
      lines.push(row.map(formatSheetCell).join(' | '))
    } else if (typeof row === 'string') {
      lines.push(row)
    } else if (row && typeof row === 'object') {
      const obj = row as Record<string, unknown>
      if (Array.isArray(obj.cells)) {
        lines.push(obj.cells.map(formatSheetCell).join(' | '))
      } else {
        const vals = Object.values(obj).map(formatSheetCell)
        if (vals.some(Boolean)) lines.push(vals.join(' | '))
      }
    }
  }
  return lines.join('\n')
}

function formatSheetCellsMap(cells: Record<string, unknown>): string {
  const entries = Object.entries(cells)
  if (entries.length === 0) return ''
  const lines: string[] = []
  for (const [addr, cell] of entries) {
    const text = formatSheetCell(cell)
    if (text !== '') lines.push(`${addr}: ${text}`)
  }
  return lines.join('\n')
}

function formatSingleSheet(entry: Record<string, unknown>, includeTitle = true): string {
  const titleRaw = entry.sheetName ?? entry.name ?? entry.title
  const title = typeof titleRaw === 'string' && titleRaw.trim() ? titleRaw.trim() : undefined

  let body = ''
  if (typeof entry.text === 'string' && entry.text.trim()) {
    body = normalizePlainText(entry.text)
  } else if (typeof entry.grid === 'string' && entry.grid.trim()) {
    const grid = normalizePlainText(entry.grid, false)
    body = grid === '(empty range)' ? '' : grid
  } else if (Array.isArray(entry.rows)) {
    body = formatSheetRows(entry.rows)
  } else if (Array.isArray(entry.data)) {
    body = formatSheetRows(entry.data)
  } else if (entry.cells && typeof entry.cells === 'object' && !Array.isArray(entry.cells)) {
    body = formatSheetCellsMap(entry.cells as Record<string, unknown>)
  } else if (typeof entry.summary === 'string' && entry.summary.trim()) {
    body = normalizePlainText(entry.summary)
  }

  if (!body) return ''
  return includeTitle && title ? `# ${title}\n${body}` : body
}

/** Format live Sheets reader payloads ({ sheets, text, summary, data, rows, preview, grid }) into plain text. */
export function formatSheetsLiveText(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return normalizePlainText(raw)
  if (Array.isArray(raw)) return normalizePlainText(formatSheetRows(raw))
  if (typeof raw !== 'object') return ''

  const obj = raw as Record<string, unknown>

  if (obj.preview && typeof obj.preview === 'object' && !Array.isArray(obj.preview)) {
    const previewText = formatSingleSheet(obj.preview as Record<string, unknown>)
    if (previewText) return normalizePlainText(previewText, false)
  }

  if (Array.isArray(obj.sheets)) {
    const sections = obj.sheets
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      .map((s) => formatSingleSheet(s, true))
      .filter(Boolean)
    if (sections.length > 0) return normalizePlainText(sections.join('\n\n'), false)
  }

  const direct = formatSingleSheet(obj, true)
  if (direct) return normalizePlainText(direct, false)

  if (obj.context && typeof obj.context === 'object') {
    return formatSheetsLiveText(obj.context)
  }

  return ''
}

function collectSlideElementLines(element: unknown, out: string[]): void {
  if (element === null || element === undefined) return
  if (typeof element === 'string') {
    if (element.trim()) out.push(element.trim())
    return
  }
  if (typeof element !== 'object') return

  const el = element as Record<string, unknown>
  if (typeof el.text === 'string' && el.text.trim()) {
    out.push(el.text.trim())
  } else if (typeof el.content === 'string' && el.content.trim()) {
    out.push(el.content.trim())
  }

  if (Array.isArray(el.paragraphs)) {
    for (const p of el.paragraphs) {
      if (typeof p === 'string' && p.trim()) out.push(p.trim())
    }
  }

  if (Array.isArray(el.categories) || Array.isArray(el.series)) {
    const cats = Array.isArray(el.categories) ? el.categories.map((c) => String(c ?? '')) : []
    if (cats.length > 0) out.push(`Categories: ${cats.join(' | ')}`)
    if (Array.isArray(el.series)) {
      for (const s of el.series) {
        if (!s || typeof s !== 'object') continue
        const ser = s as { name?: unknown; values?: unknown[] }
        const name = typeof ser.name === 'string' && ser.name.trim() ? `${ser.name}: ` : ''
        const vals = Array.isArray(ser.values)
          ? ser.values.map((v) => String(v ?? '')).join(' | ')
          : ''
        if (name || vals) out.push(`${name}${vals}`)
      }
    }
  }

  if (Array.isArray(el.children)) {
    for (const child of el.children) {
      collectSlideElementLines(child, out)
    }
  }
}

/** Format live Slides reader payloads ({ slides, text, summary }) by slide number. */
export function formatSlidesLiveText(raw: unknown): string {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') return normalizePlainText(raw)
  if (typeof raw !== 'object') return ''

  const obj = raw as Record<string, unknown>
  if (Array.isArray(obj.slides)) {
    const sections: string[] = []
    obj.slides.forEach((entry, idx) => {
      if (!entry || typeof entry !== 'object') return
      const slide = entry as Record<string, unknown>
      const pageNum =
        typeof slide.slideNumber === 'number'
          ? slide.slideNumber
          : typeof slide.number === 'number'
            ? slide.number
            : typeof slide.index === 'number'
              ? slide.index + 1
              : idx + 1

      const lines: string[] = [`## Slide ${pageNum}`]
      if (typeof slide.title === 'string' && slide.title.trim()) {
        lines.push(slide.title.trim())
      }
      if (typeof slide.text === 'string' && slide.text.trim()) {
        lines.push(slide.text.trim())
      }
      if (Array.isArray(slide.paragraphs)) {
        for (const p of slide.paragraphs) {
          if (typeof p === 'string' && p.trim()) lines.push(p.trim())
        }
      }
      if (Array.isArray(slide.elements)) {
        for (const el of slide.elements) collectSlideElementLines(el, lines)
      }
      if (Array.isArray(slide.shapes)) {
        for (const el of slide.shapes) collectSlideElementLines(el, lines)
      }

      const rawNotes = slide.notes ?? slide.speakerNotes
      if (typeof rawNotes === 'string' && rawNotes.trim()) {
        lines.push('### Notes', rawNotes.trim())
      }

      if (lines.length > 1) {
        sections.push(lines.join('\n'))
      } else {
        sections.push(`## Slide ${pageNum}`)
      }
    })
    return normalizePlainText(sections.join('\n\n'))
  }

  if (typeof obj.text === 'string') return normalizePlainText(obj.text)
  if (typeof obj.summary === 'string') return normalizePlainText(obj.summary)
  return ''
}

function applyCharLimit(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized.length <= MAX_COMPARE_CHARS) {
    return { text: normalized, truncated: false }
  }
  return { text: normalized.slice(0, MAX_COMPARE_CHARS), truncated: true }
}

function buildMeta(
  params: Omit<CompareDocumentMeta, 'charCount' | 'lineCount'>,
  text: string,
): CompareDocumentMeta {
  return {
    ...params,
    charCount: text.length,
    lineCount: splitLines(text).length,
  }
}

async function readDocsLivePaginated(
  wc: WebContents,
  readLiveDocs: NonNullable<DocumentTextExtractorDeps['readLiveDocs']>,
): Promise<{ text: string; truncated: boolean }> {
  const firstRes = await readLiveDocs(wc, {})
  const firstChunk = parseDocsLiveChunk(firstRes?.text ?? '')
  const rawChunks: string[] = [firstChunk.rawBody]
  let anyHtml = firstChunk.hasHtml
  let rawCharCount = firstChunk.rawBody.length
  let nextOffset = firstChunk.nextOffset
  let docsTruncated = false

  const seenOffsets = new Set<number>()
  let pages = 0

  while (nextOffset !== undefined && nextOffset > 0 && !seenOffsets.has(nextOffset)) {
    if (pages >= MAX_DOCS_PAGINATION_CHUNKS || rawCharCount >= MAX_DOCS_RAW_HTML_CHARS) {
      docsTruncated = true
      break
    }

    if (rawCharCount >= MAX_COMPARE_CHARS) {
      const currentPlain = anyHtml
        ? htmlToPlainText(rawChunks.join(''))
        : normalizePlainText(rawChunks.join(''))
      if (currentPlain.length >= MAX_COMPARE_CHARS) {
        docsTruncated = true
        break
      }
    }

    seenOffsets.add(nextOffset)
    pages += 1

    const nextRes = await readLiveDocs(wc, { offset: nextOffset })
    const chunk = parseDocsLiveChunk(nextRes?.text ?? '')
    if (!chunk.rawBody) break
    if (chunk.hasHtml) anyHtml = true

    rawChunks.push(chunk.rawBody)
    rawCharCount += chunk.rawBody.length

    if (chunk.nextOffset !== undefined && chunk.nextOffset > nextOffset) {
      nextOffset = chunk.nextOffset
    } else {
      nextOffset = undefined
    }
  }

  const combinedRaw = rawChunks.join('')
  const plainText = anyHtml ? htmlToPlainText(combinedRaw) : normalizePlainText(combinedRaw)
  return { text: plainText, truncated: docsTruncated }
}

async function readBrowserLiveText(
  wc: WebContents,
  readLiveBrowser?: (wc: WebContents) => Promise<string>,
): Promise<string> {
  if (readLiveBrowser) return await readLiveBrowser(wc)
  const runner = wc as unknown as { executeJavaScript?: (code: string) => Promise<unknown> }
  if (typeof runner.executeJavaScript !== 'function') return ''
  const result = await runner.executeJavaScript('document.body?.innerText || ""')
  return typeof result === 'string' ? result : ''
}

function supportsLiveRead(
  kind: TabKind,
  deps: DocumentTextExtractorDeps,
  wc: WebContents | undefined,
): boolean {
  if (!wc) return false
  switch (kind) {
    case 'docs':
      return Boolean(deps.readLiveDocs)
    case 'sheets':
      return Boolean(deps.readLiveSheets)
    case 'slides':
      return Boolean(deps.readLiveSlides)
    case 'pdf':
      return Boolean(deps.readLivePdf)
    case 'markdown':
      return Boolean(deps.readLiveMarkdown)
    case 'html':
      return Boolean(deps.readLiveHtml)
    case 'browser':
      return (
        Boolean(deps.readLiveBrowser) ||
        typeof (wc as unknown as { executeJavaScript?: unknown }).executeJavaScript === 'function'
      )
    default:
      return false
  }
}

async function readTabLiveContent(
  tab: DocumentTabInfo,
  deps: DocumentTextExtractorDeps,
): Promise<{ text: string; truncated: boolean }> {
  const wc = tab.webContents!
  switch (tab.kind) {
    case 'docs':
      return await readDocsLivePaginated(wc, deps.readLiveDocs!)
    case 'sheets': {
      const raw = await deps.readLiveSheets!(wc, {})
      return { text: formatSheetsLiveText(raw), truncated: false }
    }
    case 'slides': {
      const raw = await deps.readLiveSlides!(wc, {})
      return { text: formatSlidesLiveText(raw), truncated: false }
    }
    case 'pdf': {
      const raw = await deps.readLivePdf!(wc)
      return { text: raw ?? '', truncated: false }
    }
    case 'markdown': {
      const raw = await deps.readLiveMarkdown!(wc)
      return { text: raw ?? '', truncated: false }
    }
    case 'html': {
      const raw = await deps.readLiveHtml!(wc)
      return { text: htmlToPlainText(raw ?? ''), truncated: false }
    }
    case 'browser': {
      const raw = await readBrowserLiveText(wc, deps.readLiveBrowser)
      return { text: normalizePlainText(raw), truncated: false }
    }
    default:
      return { text: '', truncated: false }
  }
}

function appendWarning(existing: string | undefined, extra: string): string {
  return existing ? `${existing} ${extra}` : extra
}

/** Create a document text extractor supporting both live open tabs and disk files. */
export function createDocumentTextExtractor(
  deps: DocumentTextExtractorDeps,
): DocumentTextExtractor {
  async function extractFromDisk(filePath: string): Promise<string> {
    const res = await deps.parseFileOnDisk(filePath)
    if (!res.ok) {
      throw new Error(res.error || `Failed to read file "${filePath}"`)
    }
    if (res.kind !== 'text') {
      throw new Error(
        res.error || `File "${filePath}" is not a comparable text document (kind: ${res.kind})`,
      )
    }
    return res.text ?? ''
  }

  async function extractFile(filePath: string): Promise<ExtractedDocument> {
    const rawText = await extractFromDisk(filePath)
    const limited = applyCharLimit(rawText)
    const warning = limited.truncated
      ? `Document text exceeded ${MAX_COMPARE_CHARS.toLocaleString()} characters and was truncated.`
      : undefined
    return {
      meta: buildMeta(
        {
          id: `file:${filePath}`,
          label: basename(filePath) || filePath,
          filePath,
          source: 'disk',
          ...(limited.truncated ? { truncated: true } : {}),
          ...(warning ? { warning } : {}),
        },
        limited.text,
      ),
      text: limited.text,
    }
  }

  async function extractTab(tabId: string): Promise<ExtractedDocument> {
    const tab = deps.findTab(tabId)
    if (!tab) {
      throw new Error(`Tab "${tabId}" is no longer open`)
    }

    const label = tab.title || (tab.filePath ? basename(tab.filePath) : tab.id)
    let rawText = ''
    let source: 'live' | 'disk' = 'live'
    let preTruncated = false
    let warning: string | undefined

    if (supportsLiveRead(tab.kind, deps, tab.webContents)) {
      let liveError: string | undefined
      try {
        const live = await readTabLiveContent(tab, deps)
        rawText = live.text
        preTruncated = live.truncated
      } catch (err) {
        liveError = err instanceof Error ? err.message : String(err)
      }

      if (liveError !== undefined) {
        if (!tab.filePath) {
          throw new Error(`Failed to read unsaved tab "${label}": ${liveError}`)
        }
        rawText = await extractFromDisk(tab.filePath)
        source = 'disk'
        preTruncated = false
        warning = `Live editor content could not be read (${liveError}); fell back to the saved file on disk.`
      } else if (rawText === '' && tab.filePath) {
        const diskText = await extractFromDisk(tab.filePath)
        source = 'disk'
        preTruncated = false
        if (diskText !== '') {
          rawText = diskText
          warning = 'Live editor returned empty content; loaded the saved file from disk.'
        }
      }
    } else if (tab.filePath) {
      rawText = await extractFromDisk(tab.filePath)
      source = 'disk'
    }

    const limited = applyCharLimit(rawText)
    const truncated = preTruncated || limited.truncated
    if (truncated) {
      warning = appendWarning(
        warning,
        `Document text exceeded ${MAX_COMPARE_CHARS.toLocaleString()} characters and was truncated.`,
      )
    }

    return {
      meta: buildMeta(
        {
          id: `tab:${tab.id}`,
          label,
          ...(tab.filePath ? { filePath: tab.filePath } : {}),
          tabId: tab.id,
          tabKind: tab.kind,
          source,
          ...(truncated ? { truncated: true } : {}),
          ...(warning ? { warning } : {}),
        },
        limited.text,
      ),
      text: limited.text,
    }
  }

  return {
    extract: async (ref: CompareSourceRef): Promise<ExtractedDocument> => {
      if (ref.kind === 'tab') {
        return await extractTab(ref.tabId)
      }
      if (ref.kind === 'file') {
        return await extractFile(ref.filePath)
      }
      throw new Error(
        `Unsupported compare source kind: ${String((ref as { kind?: unknown }).kind)}`,
      )
    },
  }
}
