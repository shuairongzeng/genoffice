import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { useI18n } from '../locale'
import { parseAnsi, type AnsiSpan } from './terminal-ansi'
import {
  buildSandboxedHtmlDoc,
  buildSandboxedSvgDoc,
  type RichOutputDetection,
  type RichTableData,
} from './terminal-rich-detect'

export type TerminalRichViewMode = 'rendered' | 'raw' | 'split'

export interface TerminalRichOutputProps {
  stdout: string
  stderr: string
  detection: RichOutputDetection
  viewMode: TerminalRichViewMode
  dark: boolean
  filterText?: string
}

const FRAME_HEIGHTS = [260, 420, 580] as const
const DEFAULT_FRAME_HEIGHT = 260
const MAX_JSON_AUTO_COLLECT = 4000

type TableShape = Pick<RichTableData, 'headers' | 'rows'>

function readIsDarkTheme(): boolean {
  if (typeof document === 'undefined') return false
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'dark') return true
  if (attr === 'light') return false
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return false
}

/**
 * Tracks effective light/dark mode reactively across explicit data-theme
 * overrides and OS prefers-color-scheme changes.
 */
export function useDarkTheme(): boolean {
  const [dark, setDark] = useState<boolean>(() => readIsDarkTheme())

  useEffect(() => {
    const sync = (): void => {
      setDark(readIsDarkTheme())
    }
    sync()

    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })

    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null
    mq?.addEventListener?.('change', sync)

    return () => {
      observer.disconnect()
      mq?.removeEventListener?.('change', sync)
    }
  }, [])

  return dark
}

function highlightFilterMatches(text: string, query: string): ReactNode {
  if (!query || !text) return text
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let idx = lowerText.indexOf(lowerQuery, cursor)
  let hitSeq = 0

  while (idx !== -1) {
    if (idx > cursor) {
      parts.push(text.slice(cursor, idx))
    }
    parts.push(
      <mark key={`hit-${hitSeq++}`} className="term-search-hit">
        {text.slice(idx, idx + query.length)}
      </mark>,
    )
    cursor = idx + query.length
    idx = lowerText.indexOf(lowerQuery, cursor)
  }

  if (parts.length === 0) return text
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

function splitAnsiSpansIntoLines(text: string): AnsiSpan[][] {
  if (!text) return []
  const spans = parseAnsi(text)
  const lines: AnsiSpan[][] = [[]]

  for (const span of spans) {
    if (!span.text) continue
    const segments = span.text.split('\n')
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        lines.push([])
      }
      const segmentText = segments[i]!.replace(/\r$/, '')
      if (segmentText.length > 0) {
        lines[lines.length - 1]!.push({ ...span, text: segmentText })
      }
    }
  }

  return lines
}

function renderAnsiSpan(span: AnsiSpan, index: number, query: string): ReactElement {
  const classes: string[] = []
  if (span.bold) classes.push('term-ansi-bold')
  if (span.dim) classes.push('term-ansi-dim')
  if (span.italic) classes.push('term-ansi-italic')
  if (span.underline) classes.push('term-ansi-underline')
  if (span.strike) classes.push('term-ansi-strike')

  const style: CSSProperties | undefined =
    span.fg || span.bg ? { color: span.fg, backgroundColor: span.bg } : undefined

  return (
    <span key={index} className={classes.length > 0 ? classes.join(' ') : undefined} style={style}>
      {highlightFilterMatches(span.text, query)}
    </span>
  )
}

function AnsiLines({
  text,
  filterText,
}: {
  text: string
  filterText: string
}): ReactElement | null {
  const query = filterText.trim()
  const lines = useMemo(() => splitAnsiSpansIntoLines(text), [text])

  const filtered = useMemo(() => {
    if (!query) return { lines, total: lines.length, filtering: false }
    const lower = query.toLowerCase()
    const matched = lines.filter((lineSpans) =>
      lineSpans
        .map((s) => s.text)
        .join('')
        .toLowerCase()
        .includes(lower),
    )
    if (matched.length === 0) {
      return { lines, total: lines.length, filtering: false }
    }
    return { lines: matched, total: lines.length, filtering: true }
  }, [lines, query])

  if (lines.length === 0) return null

  return (
    <>
      {filtered.filtering && (
        <div className="term-filter-meta">
          {filtered.lines.length} / {filtered.total}
        </div>
      )}
      {filtered.lines.map((lineSpans, lineIdx) => (
        <div key={lineIdx} className="term-raw-line">
          {lineSpans.length > 0
            ? lineSpans.map((span, spanIdx) => renderAnsiSpan(span, spanIdx, query))
            : '\u00A0'}
        </div>
      ))}
    </>
  )
}

function StderrBlock({
  stderr,
  filterText,
}: {
  stderr: string
  filterText: string
}): ReactElement | null {
  if (!stderr) return null
  return (
    <div className="term-stderr-block" role="status">
      <AnsiLines text={stderr} filterText={filterText} />
    </div>
  )
}

function RawAnsiView({
  stdout,
  stderr,
  filterText,
}: {
  stdout: string
  stderr: string
  filterText: string
}): ReactElement {
  return (
    <div>
      {stdout && (
        <div className="term-raw-output">
          <AnsiLines text={stdout} filterText={filterText} />
        </div>
      )}
      <StderrBlock stderr={stderr} filterText={filterText} />
    </div>
  )
}

function isJsonContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null
}

function collectDefaultJsonPaths(
  value: unknown,
  path = '$',
  depth = 0,
  out = new Set<string>(),
): Set<string> {
  if (!isJsonContainer(value) || depth >= 2 || out.size >= MAX_JSON_AUTO_COLLECT) {
    return out
  }
  out.add(path)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.size < MAX_JSON_AUTO_COLLECT; i++) {
      collectDefaultJsonPaths(value[i], `${path}[${i}]`, depth + 1, out)
    }
  } else {
    for (const [k, v] of Object.entries(value)) {
      if (out.size >= MAX_JSON_AUTO_COLLECT) break
      collectDefaultJsonPaths(v, `${path}.${k}`, depth + 1, out)
    }
  }
  return out
}

function collectAllJsonPaths(value: unknown, path = '$', out = new Set<string>()): Set<string> {
  if (!isJsonContainer(value) || out.size >= MAX_JSON_AUTO_COLLECT) {
    return out
  }
  out.add(path)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.size < MAX_JSON_AUTO_COLLECT; i++) {
      collectAllJsonPaths(value[i], `${path}[${i}]`, out)
    }
  } else {
    for (const [k, v] of Object.entries(value)) {
      if (out.size >= MAX_JSON_AUTO_COLLECT) break
      collectAllJsonPaths(v, `${path}.${k}`, out)
    }
  }
  return out
}

function JsonPrimitive({
  value,
  filterText,
}: {
  value: unknown
  filterText: string
}): ReactElement {
  if (value === null) {
    return <span className="term-json-null">{highlightFilterMatches('null', filterText)}</span>
  }
  if (typeof value === 'boolean') {
    return (
      <span className="term-json-boolean">
        {highlightFilterMatches(value ? 'true' : 'false', filterText)}
      </span>
    )
  }
  if (typeof value === 'number') {
    return (
      <span className="term-json-number">{highlightFilterMatches(String(value), filterText)}</span>
    )
  }
  if (typeof value === 'string') {
    return (
      <span className="term-json-string">
        &quot;{highlightFilterMatches(value, filterText)}&quot;
      </span>
    )
  }
  return <span>{String(value)}</span>
}

function JsonTreeNode({
  label,
  value,
  path,
  depth,
  expanded,
  onToggle,
  filterText,
  trailingComma,
}: {
  label?: string
  value: unknown
  path: string
  depth: number
  expanded: ReadonlySet<string>
  onToggle: (path: string) => void
  filterText: string
  trailingComma: boolean
}): ReactElement {
  const isContainer = isJsonContainer(value)
  const isArray = Array.isArray(value)
  const entries = useMemo(() => {
    if (!isContainer) return []
    return isArray ? value.map((item, idx) => [String(idx), item] as const) : Object.entries(value)
  }, [isArray, isContainer, value])

  const openBracket = isArray ? '[' : '{'
  const closeBracket = isArray ? ']' : '}'
  const isOpen = expanded.has(path)
  const isEmpty = entries.length === 0

  if (!isContainer) {
    return (
      <div className={`term-json-node${depth === 0 ? ' is-root' : ''}`}>
        <div className="term-json-row">
          {label !== undefined && (
            <>
              <span className="term-json-key">
                &quot;{highlightFilterMatches(label, filterText)}&quot;
              </span>
              <span className="term-json-punct">:</span>
            </>
          )}
          <JsonPrimitive value={value} filterText={filterText} />
          {trailingComma && <span className="term-json-punct">,</span>}
        </div>
      </div>
    )
  }

  return (
    <div className={`term-json-node${depth === 0 ? ' is-root' : ''}`}>
      <div className="term-json-row">
        {!isEmpty && (
          <button
            type="button"
            className="term-json-toggle"
            aria-expanded={isOpen}
            onClick={() => onToggle(path)}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        )}
        {label !== undefined && (
          <>
            <span className="term-json-key">
              &quot;{highlightFilterMatches(label, filterText)}&quot;
            </span>
            <span className="term-json-punct">:</span>
          </>
        )}
        <span className="term-json-punct">{openBracket}</span>
        {(!isOpen || isEmpty) && (
          <>
            {!isEmpty && <span className="term-json-punct">…</span>}
            <span className="term-json-punct">{closeBracket}</span>
            {trailingComma && <span className="term-json-punct">,</span>}
            {!isEmpty && <span className="term-json-count">({entries.length})</span>}
          </>
        )}
      </div>

      {isOpen && !isEmpty && (
        <>
          {entries.map(([entryKey, entryVal], idx) => (
            <JsonTreeNode
              key={entryKey}
              label={isArray ? undefined : entryKey}
              value={entryVal}
              path={isArray ? `${path}[${entryKey}]` : `${path}.${entryKey}`}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              filterText={filterText}
              trailingComma={idx < entries.length - 1}
            />
          ))}
          <div className="term-json-row">
            <span className="term-json-punct">
              {closeBracket}
              {trailingComma ? ',' : ''}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function JsonTreeView({ value, filterText }: { value: unknown; filterText: string }): ReactElement {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<Set<string>>(() => collectDefaultJsonPaths(value))

  useEffect(() => {
    setExpanded(collectDefaultJsonPaths(value))
  }, [value])

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleExpandAll = useCallback(() => {
    setExpanded(collectAllJsonPaths(value))
  }, [value])

  const handleCollapseAll = useCallback(() => {
    setExpanded(new Set())
  }, [])

  return (
    <div className="term-json-wrap">
      <div className="term-json-toolbar">
        <button type="button" className="term-mini-btn" onClick={handleExpandAll}>
          {t('termExpandAll')}
        </button>
        <button type="button" className="term-mini-btn" onClick={handleCollapseAll}>
          {t('termCollapseAll')}
        </button>
      </div>
      <div className="term-json-tree">
        <JsonTreeNode
          value={value}
          path="$"
          depth={0}
          expanded={expanded}
          onToggle={handleToggle}
          filterText={filterText}
          trailingComma={false}
        />
      </div>
    </div>
  )
}

function SandboxedDocPreview({
  kind,
  rawContent,
  dark,
}: {
  kind: 'html' | 'svg'
  rawContent: string
  dark: boolean
}): ReactElement {
  const { t } = useI18n()
  const [frameHeight, setFrameHeight] = useState<number>(DEFAULT_FRAME_HEIGHT)

  const doc = useMemo(() => {
    return kind === 'svg'
      ? buildSandboxedSvgDoc(rawContent, dark)
      : buildSandboxedHtmlDoc(rawContent, dark)
  }, [dark, kind, rawContent])

  return (
    <div className="term-sandbox-wrap">
      <div className="term-sandbox-bar">
        <span className="term-sandbox-note">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 1.5L13 3.5v4c0 3.2-2.1 5.8-5 7-2.9-1.2-5-3.8-5-7v-4l5-2Z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          <span>{t('termSandboxNote')}</span>
        </span>
        <div className="term-sandbox-heights">
          {FRAME_HEIGHTS.map((height) => (
            <button
              key={height}
              type="button"
              className={`term-height-btn${frameHeight === height ? ' is-active' : ''}`}
              onClick={() => setFrameHeight(height)}
            >
              {height}px
            </button>
          ))}
        </div>
      </div>
      <iframe
        className="term-sandbox-frame"
        sandbox=""
        referrerPolicy="no-referrer"
        title={kind === 'svg' ? t('termBadgeSvg') : t('termBadgeHtml')}
        srcDoc={doc}
        style={{ height: `${frameHeight}px` }}
      />
    </div>
  )
}

function RichTableView({
  table,
  filterText,
}: {
  table: TableShape
  filterText: string
}): ReactElement {
  const query = filterText.trim()
  return (
    <div className="term-table-wrap g-scroll">
      <table className="term-table">
        <thead>
          <tr>
            {table.headers.map((header, idx) => (
              <th key={idx}>{highlightFilterMatches(header, query)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {table.headers.map((_, colIdx) => (
                <td key={colIdx}>{highlightFilterMatches(row[colIdx] ?? '', query)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function isSafeMarkdownHref(href: string): boolean {
  const trimmed = href.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('#')) return true
  try {
    const parsed = new URL(trimmed)
    return (
      parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
    )
  } catch {
    return false
  }
}

function renderMarkdownInline(text: string, filterText: string, keyPrefix = 'md'): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenRegex =
    /(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
  let lastIdx = 0
  let seq = 0

  for (const match of text.matchAll(tokenRegex)) {
    const index = match.index ?? 0
    if (index > lastIdx) {
      nodes.push(
        <Fragment key={`${keyPrefix}-t-${seq++}`}>
          {highlightFilterMatches(text.slice(lastIdx, index), filterText)}
        </Fragment>,
      )
    }

    const token = match[0]
    const k = `${keyPrefix}-${seq++}`
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={k}>{highlightFilterMatches(token.slice(1, -1), filterText)}</code>)
    } else if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push(
        <strong key={k}>
          <em>{renderMarkdownInline(token.slice(3, -3), filterText, k)}</em>
        </strong>,
      )
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      nodes.push(<strong key={k}>{renderMarkdownInline(token.slice(2, -2), filterText, k)}</strong>)
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={k}>{renderMarkdownInline(token.slice(2, -2), filterText, k)}</del>)
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      nodes.push(<em key={k}>{renderMarkdownInline(token.slice(1, -1), filterText, k)}</em>)
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch) {
        const label = linkMatch[1]!
        const href = linkMatch[2]!.trim()
        if (isSafeMarkdownHref(href)) {
          nodes.push(
            <a key={k} href={href} target="_blank" rel="noopener noreferrer">
              {renderMarkdownInline(label, filterText, k)}
            </a>,
          )
        } else {
          nodes.push(<Fragment key={k}>{renderMarkdownInline(label, filterText, k)}</Fragment>)
        }
      } else {
        nodes.push(highlightFilterMatches(token, filterText))
      }
    }

    lastIdx = index + token.length
  }

  if (lastIdx < text.length) {
    nodes.push(
      <Fragment key={`${keyPrefix}-tail`}>
        {highlightFilterMatches(text.slice(lastIdx), filterText)}
      </Fragment>,
    )
  }

  return nodes
}

type MdBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'blockquote'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'hr' }
  | { type: 'paragraph'; text: string }

function parseMarkdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: MdBlock[] = []
  let i = 0

  const isPipeDivider = (line: string): boolean => /^\|?[\s:-]+(?:\|[\s:-]+)+\|?$/.test(line.trim())

  const splitPipeCells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()

    if (!trimmed) {
      i++
      continue
    }

    const fenceMatch = /^(```|~~~)\s*([\w-]*)/.exec(trimmed)
    if (fenceMatch) {
      const fence = fenceMatch[1]!
      const lang = fenceMatch[2] ?? ''
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trim().startsWith(fence)) {
        codeLines.push(lines[i]!)
        i++
      }
      if (i < lines.length) i++
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1]!.length,
        text: headingMatch[2]!,
      })
      i++
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''))
        i++
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isPipeDivider(lines[i + 1]!)) {
      const headers = splitPipeCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim().includes('|')) {
        rows.push(splitPipeCells(lines[i]!))
        i++
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    const ulMatch = /^\s*[-*+]\s+(.+)$/.exec(line)
    if (ulMatch) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*[-*+]\s+(.+)$/.exec(lines[i]!)
        if (!m) break
        items.push(m[1]!)
        i++
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    const olMatch = /^\s*\d+[.)]\s+(.+)$/.exec(line)
    if (olMatch) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*\d+[.)]\s+(.+)$/.exec(lines[i]!)
        if (!m) break
        items.push(m[1]!)
        i++
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    const paraLines: string[] = []
    while (i < lines.length) {
      const curr = lines[i]!
      const currTrim = curr.trim()
      if (
        !currTrim ||
        /^(```|~~~)/.test(currTrim) ||
        /^(#{1,6})\s+/.test(currTrim) ||
        currTrim.startsWith('>') ||
        /^(?:-{3,}|\*{3,}|_{3,})$/.test(currTrim) ||
        /^\s*[-*+]\s+/.test(curr) ||
        /^\s*\d+[.)]\s+/.test(curr)
      ) {
        break
      }
      paraLines.push(curr)
      i++
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') })
    } else {
      i++
    }
  }

  return blocks
}

function renderHeading(level: number, children: ReactNode[], key: string): ReactElement {
  switch (level) {
    case 1:
      return <h1 key={key}>{children}</h1>
    case 2:
      return <h2 key={key}>{children}</h2>
    case 3:
      return <h3 key={key}>{children}</h3>
    case 4:
      return <h4 key={key}>{children}</h4>
    case 5:
      return <h5 key={key}>{children}</h5>
    default:
      return <h6 key={key}>{children}</h6>
  }
}

function MarkdownBlocks({
  source,
  filterText,
}: {
  source: string
  filterText: string
}): ReactElement {
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source])
  const query = filterText.trim()

  return (
    <div className="term-markdown">
      {blocks.map((block, idx) => {
        const key = `mdb-${idx}`
        switch (block.type) {
          case 'heading':
            return renderHeading(block.level, renderMarkdownInline(block.text, query, key), key)
          case 'code':
            return (
              <pre key={key}>
                {block.lang && <div className="term-md-code-lang">{block.lang}</div>}
                <code>{highlightFilterMatches(block.code, query)}</code>
              </pre>
            )
          case 'blockquote':
            return (
              <blockquote key={key}>
                <MarkdownBlocks source={block.lines.join('\n')} filterText={query} />
              </blockquote>
            )
          case 'list':
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>
                    {renderMarkdownInline(item, query, `${key}-${itemIdx}`)}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>
                    {renderMarkdownInline(item, query, `${key}-${itemIdx}`)}
                  </li>
                ))}
              </ul>
            )
          case 'table':
            return (
              <RichTableView
                key={key}
                table={{ headers: block.headers, rows: block.rows }}
                filterText={query}
              />
            )
          case 'hr':
            return <hr key={key} />
          case 'paragraph':
            return <p key={key}>{renderMarkdownInline(block.text, query, key)}</p>
        }
      })}
    </div>
  )
}

function RichRenderedView({
  stdout,
  stderr,
  detection,
  dark,
  filterText,
}: {
  stdout: string
  stderr: string
  detection: RichOutputDetection
  dark: boolean
  filterText: string
}): ReactElement {
  const body = useMemo((): ReactElement => {
    switch (detection.kind) {
      case 'html':
        return <SandboxedDocPreview kind="html" rawContent={detection.html} dark={dark} />
      case 'svg':
        return <SandboxedDocPreview kind="svg" rawContent={detection.svg} dark={dark} />
      case 'json':
        return <JsonTreeView value={detection.parsed} filterText={filterText.trim()} />
      case 'table':
        return <RichTableView table={detection.table} filterText={filterText} />
      case 'markdown':
        return <MarkdownBlocks source={detection.markdown} filterText={filterText} />
      case 'plain':
        return <RawAnsiView stdout={stdout} stderr="" filterText={filterText} />
    }
  }, [dark, detection, filterText, stdout])

  return (
    <div>
      {body}
      <StderrBlock stderr={stderr} filterText={filterText} />
    </div>
  )
}

/**
 * Renders a terminal block's stdout/stderr in raw ANSI mode, rich rendered
 * preview mode (sandboxed HTML/SVG, JSON tree, sticky table, React Markdown),
 * or side-by-side split comparison mode.
 */
export function TerminalRichOutput({
  stdout,
  stderr,
  detection,
  viewMode,
  dark,
  filterText = '',
}: TerminalRichOutputProps): ReactElement {
  if (viewMode === 'raw' || (viewMode === 'rendered' && detection.kind === 'plain')) {
    return <RawAnsiView stdout={stdout} stderr={stderr} filterText={filterText} />
  }

  if (viewMode === 'split') {
    return (
      <div className="term-rich-split">
        <div className="term-rich-split-col">
          <RawAnsiView stdout={stdout} stderr={stderr} filterText={filterText} />
        </div>
        <div className="term-rich-split-col">
          <RichRenderedView
            stdout={stdout}
            stderr=""
            detection={detection}
            dark={dark}
            filterText={filterText}
          />
        </div>
      </div>
    )
  }

  return (
    <RichRenderedView
      stdout={stdout}
      stderr={stderr}
      detection={detection}
      dark={dark}
      filterText={filterText}
    />
  )
}
