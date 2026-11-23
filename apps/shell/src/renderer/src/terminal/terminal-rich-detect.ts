/**
 * Rich output detection, sandboxed HTML/SVG wrapper generation, and local path
 * extraction for terminal block output.
 */

import { stripAnsi } from './terminal-ansi'

export type RichOutputKind = 'html' | 'svg' | 'json' | 'table' | 'markdown' | 'plain'

export interface RichTableData {
  headers: string[]
  rows: string[][]
  delimiter: ',' | '\t'
}

export type RichOutputDetection =
  | { kind: 'html'; html: string }
  | { kind: 'svg'; svg: string }
  | { kind: 'json'; parsed: unknown; pretty: string }
  | { kind: 'table'; table: RichTableData }
  | { kind: 'markdown'; markdown: string }
  | { kind: 'plain' }

export interface DetectedPath {
  path: string
  name: string
}

const ALLOWED_PATH_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.pdf',
  '.html',
  '.htm',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.mp4',
  '.mp3',
  '.wav',
])

const MAX_EXTRACTED_PATHS = 8
const MAX_TABLE_LINES = 500
const MAX_TABLE_COLUMNS = 20

const FENCED_CODE_BLOCK_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm
const FULL_HTML_DOCTYPE_RE = /<!doctype\s+html\b[\s\S]*?<\/html\s*>/i
const FULL_HTML_TAG_RE = /<html\b[^>]*>[\s\S]*?<\/html\s*>/i
const PAIRED_HTML_FRAGMENT_RE =
  /(?<![A-Za-z0-9_$])<(div|table|section|article|header|main|style|ul|ol|h[1-6])(?:\s+(?:"[^"]*"|'[^']*'|[^<>])*)?>[\s\S]*?<\/\1\s*>/i
const HTML_FRAGMENT_OPEN_RE =
  /(?<![A-Za-z0-9_$])<(?:div|table|section|article|header|footer|nav|main|style|ul|ol|h[1-6]|p|pre|blockquote|form)\b(?:\s+(?:"[^"]*"|'[^']*'|[^<>])*)?>/i
const HTML_LAYOUT_WRAPPER_RE =
  /(?<![A-Za-z0-9_$])<(?:!doctype\s+html|html|body|div|table|section|article|header|main)\b/i

const SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi
const SCRIPT_SELF_OR_UNCLOSED_RE = /<script\b[^>]*\/>|<script\b[^>]*>[\s\S]*$/gi

const MARKDOWN_HEADING_RE = /^[ \t]{0,3}#{1,6}\s+\S/m
const MARKDOWN_FENCE_RE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/m
const MARKDOWN_LIST_RE = /^(?:[ \t]*[-*+]\s+\S|[ \t]*\d+\.\s+\S)/m
const MARKDOWN_PIPE_TABLE_RE = /^[ \t]*\|.+\|[ \t]*\n[ \t]*\|(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*$/m
const MARKDOWN_BLOCKQUOTE_RE = /^[ \t]*>\s+\S/m
const MARKDOWN_LINK_RE = /(?<![A-Za-z0-9_$])\[[^\]\n]+\]\([^)\s\n]+\)/
const MARKDOWN_BOLD_RE = /\*\*\S(?:[^*\n]*\S)?\*\*/

const URI_ATTR_RE = /^(?:href|src|xlink:href|action|formaction|data|poster|background)$/i

function stripScripts(markup: string): string {
  return markup.replace(SCRIPT_BLOCK_RE, '').replace(SCRIPT_SELF_OR_UNCLOSED_RE, '')
}

function decodeSimpleEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#([0-9]+);?/g, (_, dec) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&colon;/gi, ':')
}

function isDangerousUri(rawValue: string): boolean {
  const decoded = decodeSimpleEntities(rawValue)
  let normalized = ''
  for (let i = 0; i < decoded.length; i++) {
    const code = decoded.charCodeAt(i)
    // Strip ASCII whitespace and control characters before checking scheme.
    if (code <= 0x20) continue
    normalized += decoded[i].toLowerCase()
  }
  return normalized.startsWith('javascript:') || normalized.startsWith('vbscript:')
}

function sanitizeTagAttributes(tagText: string): string {
  // tagText starts with '<' and ends with '>'.
  const isSelfClosing = tagText.endsWith('/>')
  const innerEnd = isSelfClosing ? tagText.length - 2 : tagText.length - 1
  const inner = tagText.slice(1, innerEnd)

  let pos = 0
  while (pos < inner.length && !/\s/.test(inner[pos])) {
    pos++
  }
  const tagName = inner.slice(0, pos)
  const keptAttrs: string[] = []

  while (pos < inner.length) {
    while (pos < inner.length && /\s/.test(inner[pos])) pos++
    if (pos >= inner.length) break

    const nameStart = pos
    while (pos < inner.length && !/[\s=]/.test(inner[pos])) pos++
    const attrName = inner.slice(nameStart, pos)
    if (!attrName) break

    let wsAfterName = pos
    while (wsAfterName < inner.length && /\s/.test(inner[wsAfterName])) wsAfterName++

    let rawValue: string | undefined
    let unquotedVal = ''
    if (inner[wsAfterName] === '=') {
      let valPos = wsAfterName + 1
      while (valPos < inner.length && /\s/.test(inner[valPos])) valPos++
      const quote = inner[valPos]
      if (quote === '"' || quote === "'") {
        const valStart = valPos
        valPos++
        while (valPos < inner.length && inner[valPos] !== quote) valPos++
        if (valPos < inner.length) valPos++
        rawValue = inner.slice(valStart, valPos)
        unquotedVal = rawValue.slice(1, rawValue.endsWith(quote) ? -1 : undefined)
        pos = valPos
      } else {
        const valStart = valPos
        while (valPos < inner.length && !/\s/.test(inner[valPos])) valPos++
        rawValue = inner.slice(valStart, valPos)
        unquotedVal = rawValue
        pos = valPos
      }
    } else {
      pos = wsAfterName
    }

    if (/^on[a-z0-9_:-]*$/i.test(attrName)) {
      continue
    }
    if (rawValue !== undefined && URI_ATTR_RE.test(attrName) && isDangerousUri(unquotedVal)) {
      keptAttrs.push(`${attrName}="#"`)
      continue
    }

    keptAttrs.push(rawValue !== undefined ? `${attrName}=${rawValue}` : attrName)
  }

  const attrsPart = keptAttrs.length > 0 ? ` ${keptAttrs.join(' ')}` : ''
  return `<${tagName}${attrsPart}${isSelfClosing ? '/>' : '>'}`
}

function sanitizeMarkup(markup: string): string {
  const withoutScripts = stripScripts(markup)
  let out = ''
  let i = 0

  while (i < withoutScripts.length) {
    const lt = withoutScripts.indexOf('<', i)
    if (lt === -1) {
      out += withoutScripts.slice(i)
      break
    }

    out += withoutScripts.slice(i, lt)
    const next = withoutScripts[lt + 1]
    // Only scan attribute tokens on real opening tags like <div ...>.
    if (!next || !/[A-Za-z]/.test(next)) {
      out += '<'
      i = lt + 1
      continue
    }

    let j = lt + 2
    let quote: string | null = null
    while (j < withoutScripts.length) {
      const ch = withoutScripts[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }

    if (j >= withoutScripts.length) {
      out += withoutScripts.slice(lt)
      break
    }

    const rawTag = withoutScripts.slice(lt, j + 1)
    out += sanitizeTagAttributes(rawTag)
    i = j + 1
  }

  return out
}

function maskMarkdownFences(text: string): string {
  return text.replace(FENCED_CODE_BLOCK_RE, (block) => block.replace(/[^\n]/g, ' '))
}

function detectJson(trimmed: string): RichOutputDetection | null {
  const startsObject = trimmed.startsWith('{') && trimmed.endsWith('}')
  const startsArray = trimmed.startsWith('[') && trimmed.endsWith(']')
  if (!startsObject && !startsArray) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null
    return {
      kind: 'json',
      parsed,
      pretty: JSON.stringify(parsed, null, 2),
    }
  } catch {
    return null
  }
}

function findCompleteSvgRange(text: string): { start: number; end: number } | null {
  const openRe = /<svg\b[^>]*>/gi
  const firstOpen = openRe.exec(text)
  if (!firstOpen) return null

  const start = firstOpen.index
  const tagRe = /<\/?svg\b[^>]*>/gi
  tagRe.lastIndex = start
  let depth = 0
  let m: RegExpExecArray | null

  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[0]
    if (tag.startsWith('</')) {
      depth--
      if (depth === 0) {
        return { start, end: m.index + tag.length }
      }
    } else if (!tag.endsWith('/>')) {
      depth++
    } else if (depth === 0) {
      return { start, end: m.index + tag.length }
    }
  }

  return null
}

function detectSvg(trimmed: string, fenceMasked: string): RichOutputDetection | null {
  const range = findCompleteSvgRange(fenceMasked)
  if (!range) return null

  const { start, end } = range
  const outsideMasked = (fenceMasked.slice(0, start) + fenceMasked.slice(end))
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!doctype\s+svg[^>]*>/gi, '')
    .trim()

  if (HTML_LAYOUT_WRAPPER_RE.test(outsideMasked)) {
    return null
  }

  const outsideLines = outsideMasked ? outsideMasked.split('\n').filter((l) => l.trim()) : []
  const svgSlice = trimmed.slice(start, end).trim()
  const dominates =
    outsideMasked.length === 0 ||
    (svgSlice.length / trimmed.length >= 0.6 && outsideLines.length <= 3)

  if (!dominates) return null

  return {
    kind: 'svg',
    svg: stripScripts(svgSlice).trim(),
  }
}

function findLastTagEnd(text: string): number {
  let i = 0
  let lastTagEnd = -1
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt === -1) break
    const next = text[lt + 1]
    if (!next || !/[A-Za-z/]/.test(next)) {
      i = lt + 1
      continue
    }
    let j = lt + 2
    let quote: string | null = null
    while (j < text.length) {
      const ch = text[j]
      if (quote) {
        if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j++
    }
    if (j < text.length && text[j] === '>') {
      lastTagEnd = j + 1
      i = j + 1
    } else {
      break
    }
  }
  return lastTagEnd
}

function detectHtml(trimmed: string, fenceMasked: string): RichOutputDetection | null {
  const docMatch = FULL_HTML_DOCTYPE_RE.exec(fenceMasked) ?? FULL_HTML_TAG_RE.exec(fenceMasked)
  if (docMatch) {
    const slice = trimmed.slice(docMatch.index, docMatch.index + docMatch[0].length).trim()
    const outside = (
      trimmed.slice(0, docMatch.index) + trimmed.slice(docMatch.index + docMatch[0].length)
    ).trim()
    const outsideLineCount = outside ? outside.split('\n').filter((l) => l.trim()).length : 0
    if (outsideLineCount <= 12 || slice.length >= trimmed.length * 0.35) {
      return { kind: 'html', html: slice }
    }
  }

  const pairedMatch = PAIRED_HTML_FRAGMENT_RE.exec(fenceMasked)
  if (!pairedMatch) return null

  const openMatch = HTML_FRAGMENT_OPEN_RE.exec(fenceMasked)
  const start = openMatch ? Math.min(openMatch.index, pairedMatch.index) : pairedMatch.index
  const lastEnd = findLastTagEnd(fenceMasked)
  const end = lastEnd > pairedMatch.index ? lastEnd : pairedMatch.index + pairedMatch[0].length
  const htmlSlice = trimmed.slice(start, end).trim()

  const beforeRaw = trimmed.slice(0, start)
  const before = beforeRaw.trim()
  const after = trimmed.slice(end).trim()
  const outsideText = [before, after].filter(Boolean).join('\n')
  const outsideLines = outsideText ? outsideText.split('\n').filter((l) => l.trim()).length : 0
  const isLineAligned =
    (beforeRaw.length === 0 || beforeRaw.endsWith('\n')) && !/\bError:/i.test(before)

  if (
    trimmed.startsWith('<') ||
    (outsideLines <= 4 && htmlSlice.length >= trimmed.length * 0.4) ||
    (outsideLines <= 2 && isLineAligned)
  ) {
    return { kind: 'html', html: htmlSlice }
  }

  return null
}

function parseDelimitedLine(line: string, delimiter: ',' | '\t'): string[] | null {
  const cells: string[] = []
  let i = 0

  while (true) {
    // Skip leading whitespace before a potential quoted field so `a, "b, c"` works.
    let wsEnd = i
    while (wsEnd < line.length && line[wsEnd] === ' ') wsEnd++

    if (wsEnd < line.length && line[wsEnd] === '"') {
      let pos = wsEnd + 1
      let quoted = ''
      let closed = false
      while (pos < line.length) {
        const ch = line[pos]
        if (ch === '"') {
          if (line[pos + 1] === '"') {
            quoted += '"'
            pos += 2
            continue
          }
          closed = true
          pos++
          break
        }
        quoted += ch
        pos++
      }
      if (!closed) return null

      while (pos < line.length && line[pos] === ' ') pos++
      if (pos < line.length && line[pos] !== delimiter) {
        return null
      }
      cells.push(quoted)
      if (pos >= line.length) break
      i = pos + 1
      continue
    }

    let pos = i
    while (pos < line.length && line[pos] !== delimiter) {
      pos++
    }
    cells.push(line.slice(i, pos).trim())
    if (pos >= line.length) break
    i = pos + 1
  }

  return cells
}

function looksLikeCsvProseOrCode(rows: string[][]): boolean {
  const headers = rows[0]
  if (
    headers[0].startsWith('{') ||
    headers[0].startsWith('[') ||
    headers[0].startsWith('//') ||
    headers[0].startsWith('/*')
  ) {
    return true
  }

  // Reject trailing-comma lists where every line ends with an empty final column.
  if (rows.every((r) => r[r.length - 1] === '')) {
    return true
  }

  for (const h of headers) {
    if (h.length > 60) return true
    const words = h.trim().split(/\s+/).filter(Boolean)
    if (words.length >= 3 && /[.!?]$/.test(h.trim())) {
      return true
    }
  }

  return false
}

function tryParseTableWithDelimiter(lines: string[], delimiter: ',' | '\t'): RichTableData | null {
  const parsed: string[][] = []
  let expectedCols = -1

  for (const line of lines) {
    const cells = parseDelimitedLine(line, delimiter)
    if (!cells) return null
    if (expectedCols === -1) {
      expectedCols = cells.length
      if (expectedCols < 2 || expectedCols > MAX_TABLE_COLUMNS) return null
    } else if (cells.length !== expectedCols) {
      return null
    }
    parsed.push(cells)
  }

  if (parsed.length < 2) return null
  if (delimiter === ',' && looksLikeCsvProseOrCode(parsed)) {
    return null
  }

  return {
    headers: parsed[0],
    rows: parsed.slice(1),
    delimiter,
  }
}

function detectTable(trimmed: string): RichOutputDetection | null {
  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2 || lines.length > MAX_TABLE_LINES) return null

  if (MARKDOWN_PIPE_TABLE_RE.test(trimmed)) return null
  if (MARKDOWN_HEADING_RE.test(lines[0]) || MARKDOWN_LIST_RE.test(lines[0])) {
    return null
  }

  // Check TSV before CSV so tab-separated cells containing commas stay TSV.
  const tsv = tryParseTableWithDelimiter(lines, '\t')
  if (tsv) return { kind: 'table', table: tsv }

  const csv = tryParseTableWithDelimiter(lines, ',')
  if (csv) return { kind: 'table', table: csv }

  return null
}

function detectMarkdown(trimmed: string): RichOutputDetection | null {
  let signals = 0
  if (MARKDOWN_HEADING_RE.test(trimmed)) signals++
  if (MARKDOWN_FENCE_RE.test(trimmed)) signals++
  if (MARKDOWN_LIST_RE.test(trimmed)) signals++
  if (MARKDOWN_PIPE_TABLE_RE.test(trimmed)) signals++
  if (MARKDOWN_BLOCKQUOTE_RE.test(trimmed)) signals++
  if (MARKDOWN_LINK_RE.test(trimmed)) signals++
  if (MARKDOWN_BOLD_RE.test(trimmed)) signals++

  if (signals >= 2) {
    return { kind: 'markdown', markdown: trimmed }
  }
  return null
}

/**
 * Strip ANSI escape sequences and classify terminal output into a structured
 * rich format when unambiguous.
 */
export function detectRichOutput(rawOutput: string): RichOutputDetection {
  const stripped = stripAnsi(rawOutput)
  const trimmed = stripped.trim()
  if (!trimmed) return { kind: 'plain' }

  // Check valid JSON first so JSON objects containing HTML/SVG strings stay JSON.
  const jsonResult = detectJson(trimmed)
  if (jsonResult) return jsonResult

  const fenceMasked = maskMarkdownFences(trimmed)

  const svgResult = detectSvg(trimmed, fenceMasked)
  if (svgResult) return svgResult

  const htmlResult = detectHtml(trimmed, fenceMasked)
  if (htmlResult) return htmlResult

  const tableResult = detectTable(trimmed)
  if (tableResult) return tableResult

  const markdownResult = detectMarkdown(trimmed)
  if (markdownResult) return markdownResult

  return { kind: 'plain' }
}

function getSandboxPalette(dark: boolean) {
  return dark
    ? {
        scheme: 'dark',
        bg: '#1e1e1e',
        fg: '#e4e4e4',
        muted: '#a0a0a0',
        border: '#3a3a3a',
        codeBg: '#2a2a2a',
        link: '#60a5fa',
      }
    : {
        scheme: 'light',
        bg: '#ffffff',
        fg: '#242424',
        muted: '#606366',
        border: '#e3e6ea',
        codeBg: '#f5f6f8',
        link: '#0969da',
      }
}

function buildHtmlBaseStyles(dark: boolean, zeroSpecificity: boolean): string {
  const p = getSandboxPalette(dark)
  const rootSel = zeroSpecificity ? ':where(html, body)' : 'html, body'
  const elemSel = (s: string) => (zeroSpecificity ? `:where(${s})` : s)

  return [
    `:root { color-scheme: ${p.scheme}; }`,
    `${elemSel('*')} { box-sizing: border-box; }`,
    `${rootSel} { margin: 0; padding: 14px 16px; background: ${p.bg}; color: ${p.fg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; font-size: 13.5px; line-height: 1.55; overflow-wrap: break-word; }`,
    `${elemSel('a')} { color: ${p.link}; }`,
    `${elemSel('pre, code')} { background: ${p.codeBg}; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }`,
    `${elemSel('pre')} { padding: 10px 12px; overflow-x: auto; }`,
    `${elemSel('code')} { padding: 1px 4px; }`,
    `${elemSel('pre code')} { padding: 0; background: transparent; }`,
    `${elemSel('table')} { border-collapse: collapse; max-width: 100%; }`,
    `${elemSel('th, td')} { border: 1px solid ${p.border}; padding: 6px 10px; text-align: left; }`,
    `${elemSel('th')} { background: ${p.codeBg}; }`,
    `${elemSel('hr')} { border: 0; border-top: 1px solid ${p.border}; }`,
    `${elemSel('blockquote')} { margin: 8px 0; padding-left: 12px; border-left: 3px solid ${p.border}; color: ${p.muted}; }`,
    `${elemSel('img, svg')} { max-width: 100%; height: auto; }`,
  ].join('\n')
}

/**
 * Build a script-free sandbox HTML document suitable for `<iframe sandbox="" srcDoc>`.
 */
export function buildSandboxedHtmlDoc(html: string, dark: boolean): string {
  const cleaned = sanitizeMarkup(html)
  const isFullDoc = /(<!doctype|<html)/i.test(cleaned)

  if (!isFullDoc) {
    const css = buildHtmlBaseStyles(dark, false)
    return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${cleaned}</body></html>`
  }

  const hasCharset = /<meta\s+[^>]*charset\s*=/i.test(cleaned)
  const charsetTag = hasCharset ? '' : '<meta charset="utf-8">'
  // Zero-specificity defaults ensure any author-provided CSS overrides them.
  const injectedHeadContent = `${charsetTag}<style>${buildHtmlBaseStyles(dark, true)}</style>`

  if (/<head\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<head\b[^>]*>/i, (tag) => `${tag}${injectedHeadContent}`)
  }
  if (/<html\b[^>]*>/i.test(cleaned)) {
    return cleaned.replace(/<html\b[^>]*>/i, (tag) => `${tag}<head>${injectedHeadContent}</head>`)
  }
  return cleaned.replace(/<!doctype\b[^>]*>/i, (tag) => `${tag}<head>${injectedHeadContent}</head>`)
}

/**
 * Wrap an SVG snippet inside a script-free centered sandbox HTML document.
 */
export function buildSandboxedSvgDoc(svg: string, dark: boolean): string {
  const range = findCompleteSvgRange(svg)
  const rawSvg = range ? svg.slice(range.start, range.end) : svg
  const cleanedSvg = sanitizeMarkup(rawSvg).trim()
  const p = getSandboxPalette(dark)

  const css = [
    `:root { color-scheme: ${p.scheme}; }`,
    `* { box-sizing: border-box; }`,
    `html, body { margin: 0; padding: 0; width: 100%; min-height: 100vh; background: ${p.bg}; color: ${p.fg}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; }`,
    `body { display: flex; align-items: center; justify-content: center; padding: 16px; }`,
    `.svg-stage { display: flex; align-items: center; justify-content: center; max-width: 100%; max-height: 100%; }`,
    `.svg-stage > svg { max-width: 100%; max-height: calc(100vh - 32px); height: auto; display: block; }`,
  ].join('\n')

  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div class="svg-stage">${cleanedSvg}</div></body></html>`
}

function cleanCandidatePath(rawCandidate: string): string | null {
  let clean = rawCandidate.replace(/[.,;:)\]}]+$/, '')
  // Strip compiler/grep `:line` or `:line:col` suffixes when present.
  const lineColMatch = /^(.*?):(\d+)(?::\d+)?$/.exec(clean)
  if (lineColMatch && lineColMatch[1].length > 2) {
    clean = lineColMatch[1].replace(/[.,;:)\]}]+$/, '')
  }

  const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  const fileName = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
  const dotIdx = fileName.lastIndexOf('.')
  if (dotIdx <= 0) return null

  const ext = fileName.slice(dotIdx).toLowerCase()
  if (!ALLOWED_PATH_EXTENSIONS.has(ext)) return null

  return clean
}

function normalizePathKey(cleanPath: string): string {
  if (/^[A-Za-z]:/.test(cleanPath)) {
    return cleanPath.replace(/\//g, '\\').toLowerCase()
  }
  return cleanPath.replace(/\/+/g, '/')
}

/**
 * Extract unique local Windows and POSIX file paths matching supported file
 * extensions from terminal output, capped at 8 results.
 */
export function extractLocalPaths(rawOutput: string): DetectedPath[] {
  const stripped = stripAnsi(rawOutput)
  if (!stripped) return []

  const winRe = /(?<![A-Za-z0-9_])([A-Za-z]:\\[^\s"'<>|*?\r\n]+)/g
  const posixRe =
    /(?:^|[\s"'(=])(\/(?:Users|home|tmp|var|etc|opt|mnt|Volumes|[A-Za-z0-9._-]+)\/[^\s"'<>|*?\r\n]+)/g

  const candidates: Array<{ index: number; raw: string }> = []

  let m: RegExpExecArray | null
  while ((m = winRe.exec(stripped)) !== null) {
    candidates.push({ index: m.index, raw: m[1] })
  }
  while ((m = posixRe.exec(stripped)) !== null) {
    const startOffset = m.index + (m[0].length - m[1].length)
    candidates.push({ index: startOffset, raw: m[1] })
  }

  candidates.sort((a, b) => a.index - b.index)

  const seen = new Set<string>()
  const results: DetectedPath[] = []

  for (const item of candidates) {
    const clean = cleanCandidatePath(item.raw)
    if (!clean) continue

    const key = normalizePathKey(clean)
    if (seen.has(key)) continue
    seen.add(key)

    const lastSlash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
    const name = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean
    results.push({ path: clean, name })

    if (results.length >= MAX_EXTRACTED_PATHS) break
  }

  return results
}
