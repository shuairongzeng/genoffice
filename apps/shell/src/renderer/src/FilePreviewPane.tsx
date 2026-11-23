import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode, WheelEvent as ReactWheelEvent } from 'react'
import type { HomeApi, SystemPreviewResult } from '../../shared/home-api'
import { FileBadge } from './file-badge'
import { useI18n } from './locale'
import './file-preview.css'

export interface FilePreviewPaneProps {
  readonly filePath: string | null
  readonly variant: 'inline' | 'window'
  readonly onOpenInEditor?: (filePath: string) => void
  readonly onOpenInMediaPlayer?: (filePath: string) => void
  readonly onOpenSystemDefault?: (filePath: string) => void
  readonly onPopOutWindow?: (filePath: string) => void
  readonly onClose?: () => void
}

type PreviewViewMode = 'rendered' | 'source'

const ZOOM_MIN = 0.25
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25
const INI_EXTENSIONS = new Set(['ini', 'cfg', 'conf'])
const MAX_MARKDOWN_QUOTE_DEPTH = 4

/** Format a byte count into human-readable B / KB / MB / GB / TB strings. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const rounded =
    value >= 100 || unit === units.length - 1 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

function extractFileName(targetPath: string): string {
  const normalized = targetPath.replace(/[\\/]+$/, '')
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return cut >= 0 ? normalized.slice(cut + 1) : normalized
}

function extractFileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

function clampZoom(next: number): number {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
  return Math.round(clamped * 100) / 100
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/* ── Icons ───────────────────────────────────────────────── */

function EmptyPreviewIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 3.5H7.5A2.5 2.5 0 0 0 5 6v12a2.5 2.5 0 0 0 2.5 2.5h9A2.5 2.5 0 0 0 19 18V8.5L14 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 3.5v5h5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="11.5" cy="13.5" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M13.2 15.2l1.8 1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function PopOutIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 3.5H3.8a1.3 1.3 0 0 0-1.3 1.3v7.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V9.5M9.5 2.5h4v4M13.5 2.5 8 8"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlayIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4.5 3.2l8.2 4.8-8.2 4.8V3.2z" fill="currentColor" />
    </svg>
  )
}

function EditorIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M11.6 2.6l1.8 1.8-7.4 7.4-2.4.6.6-2.4 7.4-7.4z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ExternalAppIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8.5 3H13v4.5M13 3L6.8 9.2M6.2 4H3.8A1.3 1.3 0 0 0 2.5 5.3v6.9a1.3 1.3 0 0 0 1.3 1.3h6.9a1.3 1.3 0 0 0 1.3-1.3V9.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function CopyIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3.5 11H3a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6.5A1.5 1.5 0 0 1 11 3v.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function CheckIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function FolderRevealIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.8 4.2A1.4 1.4 0 0 1 3.2 2.8h2.9c.4 0 .8.18 1.05.48l1 1.12h4.65a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4V4.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RotateIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 4.5V2.2M13 4.5h-2.3M12.6 5.2A5.2 5.2 0 1 0 13.2 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MusicNoteIcon(): ReactElement {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 17V6.8l9-2v10.2"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="17.5" r="2.5" fill="currentColor" />
      <circle cx="16" cy="15.5" r="2.5" fill="currentColor" />
    </svg>
  )
}

function ShieldIcon(): ReactElement {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.8l5 2v3.8c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6V3.8l5-2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function InfoIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 7.2v3.6M8 5.2h.01"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/* ── Safe Pure-React INI / Code Renderer ─────────────────── */

function renderIniValue(rawValue: string): ReactNode {
  const commentMatch = /^([\s\S]*?)(\s+[;#].*)$/.exec(rawValue)
  if (!commentMatch) {
    return <span className="fp-ini-val">{rawValue}</span>
  }
  return (
    <>
      <span className="fp-ini-val">{commentMatch[1]}</span>
      <span className="fp-ini-comment">{commentMatch[2]}</span>
    </>
  )
}

function renderIniLine(line: string): ReactNode {
  if (/^\s*[;#]/.test(line)) {
    return <span className="fp-ini-comment">{line}</span>
  }
  const sectionMatch = /^(\s*)(\[[^\]]+\])(\s*(?:[;#].*)?)$/.exec(line)
  if (sectionMatch) {
    return (
      <>
        {sectionMatch[1]}
        <span className="fp-ini-section">{sectionMatch[2]}</span>
        {sectionMatch[3] ? <span className="fp-ini-comment">{sectionMatch[3]}</span> : null}
      </>
    )
  }
  const kvMatch = /^(\s*)([^=\s][^=]*?)(\s*=\s*)(.*)$/.exec(line)
  if (kvMatch) {
    return (
      <>
        {kvMatch[1]}
        <span className="fp-ini-key">{kvMatch[2]}</span>
        <span className="fp-ini-eq">{kvMatch[3]}</span>
        {renderIniValue(kvMatch[4] ?? '')}
      </>
    )
  }
  return line
}

function CodeLinesView({
  text,
  ext,
  language,
  truncated,
  truncatedLabel,
}: {
  readonly text: string
  readonly ext: string
  readonly language?: string
  readonly truncated?: boolean
  readonly truncatedLabel: string
}): ReactElement {
  const isIniStyle = useMemo(() => {
    const cleanExt = ext.toLowerCase()
    const cleanLang = language?.toLowerCase() ?? ''
    return INI_EXTENSIONS.has(cleanExt) || cleanLang === 'ini' || cleanLang === 'conf'
  }, [ext, language])

  const lines = useMemo(() => normalizeNewlines(text).split('\n'), [text])

  return (
    <div className="fp-code-stage">
      {truncated && (
        <div className="fp-truncated-banner" role="status">
          <InfoIcon />
          <span>{truncatedLabel}</span>
        </div>
      )}
      <div className="fp-code-scroll g-scroll">
        <div className="fp-code-lines">
          {lines.map((line, idx) => (
            <div key={idx} className="fp-code-row">
              <span className="fp-code-lineno" aria-hidden="true">
                {idx + 1}
              </span>
              <span className="fp-code-content">
                {line.length === 0 ? '\u00A0' : isIniStyle ? renderIniLine(line) : line}
              </span>
            </div>
          ))}
        </div>
      </div>
      {truncated && (
        <div className="fp-truncated-footer" role="status">
          <span>… {truncatedLabel}</span>
        </div>
      )}
    </div>
  )
}

/* ── Safe Pure-React Markdown Renderer ───────────────────── */

type MarkdownBlock =
  | { readonly type: 'heading'; readonly level: number; readonly text: string }
  | { readonly type: 'code'; readonly lang: string; readonly code: string }
  | { readonly type: 'blockquote'; readonly lines: readonly string[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | {
      readonly type: 'table'
      readonly headers: readonly string[]
      readonly rows: readonly (readonly string[])[]
    }
  | { readonly type: 'hr' }
  | { readonly type: 'paragraph'; readonly text: string }

function isSafeLinkHref(href: string): boolean {
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

function renderMarkdownInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const tokenRegex =
    /(`[^`]+`|\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
  let lastIdx = 0
  let seq = 0

  for (const match of text.matchAll(tokenRegex)) {
    const index = match.index ?? 0
    if (index > lastIdx) {
      nodes.push(<Fragment key={`${keyPrefix}-t-${seq++}`}>{text.slice(lastIdx, index)}</Fragment>)
    }

    const token = match[0]
    const k = `${keyPrefix}-${seq++}`
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={k}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('***') && token.endsWith('***')) {
      nodes.push(
        <strong key={k}>
          <em>{renderMarkdownInline(token.slice(3, -3), k)}</em>
        </strong>,
      )
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      nodes.push(<strong key={k}>{renderMarkdownInline(token.slice(2, -2), k)}</strong>)
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={k}>{renderMarkdownInline(token.slice(2, -2), k)}</del>)
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      nodes.push(<em key={k}>{renderMarkdownInline(token.slice(1, -1), k)}</em>)
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (linkMatch) {
        const label = linkMatch[1] ?? ''
        const href = (linkMatch[2] ?? '').trim()
        if (isSafeLinkHref(href)) {
          nodes.push(
            <a key={k} href={href} target="_blank" rel="noopener noreferrer">
              {renderMarkdownInline(label, k)}
            </a>,
          )
        } else {
          nodes.push(<Fragment key={k}>{renderMarkdownInline(label, k)}</Fragment>)
        }
      } else {
        nodes.push(<Fragment key={k}>{token}</Fragment>)
      }
    }

    lastIdx = index + token.length
  }

  if (lastIdx < text.length) {
    nodes.push(<Fragment key={`${keyPrefix}-tail`}>{text.slice(lastIdx)}</Fragment>)
  }

  return nodes
}

function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = normalizeNewlines(source).split('\n')
  const blocks: MarkdownBlock[] = []
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
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (!trimmed) {
      i += 1
      continue
    }

    const fenceMatch = /^(```|~~~)\s*([\w-]*)/.exec(trimmed)
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? '```'
      const lang = fenceMatch[2] ?? ''
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(fence)) {
        codeLines.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') })
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: (headingMatch[1] ?? '#').length,
        text: headingMatch[2] ?? '',
      })
      i += 1
      continue
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'blockquote', lines: quoteLines })
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && isPipeDivider(lines[i + 1] ?? '')) {
      const headers = splitPipeCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? '').trim().includes('|')) {
        rows.push(splitPipeCells(lines[i] ?? ''))
        i += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    if (/^\s*[-*+]\s+(.+)$/.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*[-*+]\s+(.+)$/.exec(lines[i] ?? '')
        if (!m) break
        items.push(m[1] ?? '')
        i += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    if (/^\s*\d+[.)]\s+(.+)$/.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*\d+[.)]\s+(.+)$/.exec(lines[i] ?? '')
        if (!m) break
        items.push(m[1] ?? '')
        i += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    const paraLines: string[] = []
    while (i < lines.length) {
      const curr = lines[i] ?? ''
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
      i += 1
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') })
    } else {
      i += 1
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
  depth = 0,
}: {
  readonly source: string
  readonly depth?: number
}): ReactElement {
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source])

  return (
    <div className="fp-markdown-doc">
      {blocks.map((block, idx) => {
        const key = `fp-md-${depth}-${idx}`
        switch (block.type) {
          case 'heading':
            return renderHeading(block.level, renderMarkdownInline(block.text, key), key)
          case 'code':
            return (
              <pre key={key}>
                {block.lang ? <div className="fp-md-code-lang">{block.lang}</div> : null}
                <code>{block.code}</code>
              </pre>
            )
          case 'blockquote':
            return (
              <blockquote key={key}>
                {depth < MAX_MARKDOWN_QUOTE_DEPTH ? (
                  <MarkdownBlocks source={block.lines.join('\n')} depth={depth + 1} />
                ) : (
                  <p>{block.lines.join(' ')}</p>
                )}
              </blockquote>
            )
          case 'list':
            return block.ordered ? (
              <ol key={key}>
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>
                    {renderMarkdownInline(item, `${key}-${itemIdx}`)}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {block.items.map((item, itemIdx) => (
                  <li key={`${key}-${itemIdx}`}>
                    {renderMarkdownInline(item, `${key}-${itemIdx}`)}
                  </li>
                ))}
              </ul>
            )
          case 'table':
            return (
              <div key={key} className="fp-markdown-table-wrap g-scroll">
                <table className="fp-markdown-table">
                  <thead>
                    <tr>
                      {block.headers.map((header, hIdx) => (
                        <th key={hIdx}>{renderMarkdownInline(header, `${key}-h-${hIdx}`)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rIdx) => (
                      <tr key={rIdx}>
                        {block.headers.map((_, cIdx) => (
                          <td key={cIdx}>
                            {renderMarkdownInline(row[cIdx] ?? '', `${key}-c-${rIdx}-${cIdx}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'hr':
            return <hr key={key} />
          case 'paragraph':
            return <p key={key}>{renderMarkdownInline(block.text, key)}</p>
        }
      })}
    </div>
  )
}

/* ── Office Tab-Separated Table & Document Parser ────────── */

type OfficeBlock =
  | { readonly type: 'table'; readonly rows: readonly (readonly string[])[]; readonly cols: number }
  | { readonly type: 'paragraph'; readonly text: string }

function parseOfficeBlocks(text: string): OfficeBlock[] {
  const lines = normalizeNewlines(text).split('\n')
  const blocks: OfficeBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!line.trim()) {
      i += 1
      continue
    }

    if (line.includes('\t')) {
      const rawRows: string[][] = []
      let maxCols = 1
      while (i < lines.length && (lines[i] ?? '').includes('\t')) {
        const cells = (lines[i] ?? '').split('\t')
        if (cells.length > maxCols) maxCols = cells.length
        rawRows.push(cells)
        i += 1
      }
      const paddedRows = rawRows.map((row) => {
        if (row.length === maxCols) return row
        const padded = row.slice()
        while (padded.length < maxCols) padded.push('')
        return padded
      })
      blocks.push({ type: 'table', rows: paddedRows, cols: maxCols })
      continue
    }

    const paraLines: string[] = []
    while (i < lines.length) {
      const curr = lines[i] ?? ''
      if (!curr.trim() || curr.includes('\t')) break
      paraLines.push(curr)
      i += 1
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join('\n') })
    }
  }

  return blocks
}

function OfficePreviewStage({
  text,
  canOpenInEditor,
  truncated,
  truncatedLabel,
  openEditorLabel,
  emptyLabel,
  onOpenInEditor,
}: {
  readonly text: string
  readonly canOpenInEditor: boolean
  readonly truncated?: boolean
  readonly truncatedLabel: string
  readonly openEditorLabel: string
  readonly emptyLabel: string
  readonly onOpenInEditor?: () => void
}): ReactElement {
  const blocks = useMemo(() => parseOfficeBlocks(text), [text])

  return (
    <div className="fp-office-stage" data-testid="fp-office-preview">
      {truncated && (
        <div className="fp-truncated-banner" role="status">
          <InfoIcon />
          <span>{truncatedLabel}</span>
        </div>
      )}
      <div className="fp-office-scroll g-scroll">
        <div className="fp-office-paper">
          {canOpenInEditor && onOpenInEditor && (
            <div className="fp-office-cta-bar">
              <span className="fp-office-cta-note">
                {truncated ? truncatedLabel : openEditorLabel}
              </span>
              <button
                type="button"
                className="fp-action-btn is-solid"
                data-testid="fp-office-open-editor-btn"
                onClick={onOpenInEditor}
              >
                <EditorIcon />
                <span>{openEditorLabel}</span>
              </button>
            </div>
          )}
          {blocks.length === 0 ? (
            <p className="fp-office-empty">{emptyLabel}</p>
          ) : (
            <div className="fp-office-body">
              {blocks.map((block, idx) => {
                if (block.type === 'paragraph') {
                  return (
                    <p key={idx} className="fp-office-para">
                      {block.text}
                    </p>
                  )
                }
                const hasHeader = block.rows.length > 1
                const headerRow = hasHeader ? block.rows[0] : null
                const bodyRows = hasHeader ? block.rows.slice(1) : block.rows
                return (
                  <div key={idx} className="fp-office-table-wrap g-scroll">
                    <table className="fp-office-table">
                      {headerRow && (
                        <thead>
                          <tr>
                            {headerRow.map((cell, cIdx) => (
                              <th key={cIdx}>{cell || '\u00A0'}</th>
                            ))}
                          </tr>
                        </thead>
                      )}
                      <tbody>
                        {bodyRows.map((row, rIdx) => (
                          <tr key={rIdx}>
                            {row.map((cell, cIdx) => (
                              <td key={cIdx}>{cell || '\u00A0'}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ── Main Component ──────────────────────────────────────── */

export function FilePreviewPane({
  filePath,
  variant,
  onOpenInEditor,
  onOpenInMediaPlayer,
  onOpenSystemDefault,
  onPopOutWindow,
  onClose,
}: FilePreviewPaneProps): ReactElement {
  const { t } = useI18n()

  const [preview, setPreview] = useState<SystemPreviewResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchError, setFetchError] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [audioPlaying, setAudioPlaying] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [viewMode, setViewMode] = useState<PreviewViewMode>('rendered')
  const [copiedPath, setCopiedPath] = useState(false)

  const reqIdRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const reqId = ++reqIdRef.current

    setZoom(1)
    setRotation(0)
    setViewMode('rendered')
    setMediaError(false)
    setAudioPlaying(false)
    setCopiedPath(false)

    if (!filePath) {
      setPreview(null)
      setLoading(false)
      setFetchError(false)
      return () => {
        reqIdRef.current += 1
      }
    }

    const api = (typeof window !== 'undefined' ? window.aiOffice : undefined) as
      Partial<HomeApi> | undefined
    const previewFn = api?.systemPreviewFile

    if (typeof previewFn !== 'function') {
      setPreview(null)
      setLoading(false)
      setFetchError(true)
      return () => {
        reqIdRef.current += 1
      }
    }

    setPreview(null)
    setLoading(true)
    setFetchError(false)

    void previewFn(filePath).then(
      (result) => {
        if (reqId !== reqIdRef.current) return
        setPreview(result ?? null)
        setFetchError(!result)
        setLoading(false)
      },
      () => {
        if (reqId !== reqIdRef.current) return
        setPreview(null)
        setFetchError(true)
        setLoading(false)
      },
    )

    return () => {
      reqIdRef.current += 1
    }
  }, [filePath])

  const handleCopyPath = useCallback((targetPath: string) => {
    try {
      void navigator.clipboard?.writeText(targetPath).catch(() => undefined)
      setCopiedPath(true)
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => {
        setCopiedPath(false)
        copyTimerRef.current = null
      }, 1500)
    } catch {
      // Clipboard write may be unavailable in restricted contexts.
    }
  }, [])

  const handleRevealFolder = useCallback((targetPath: string) => {
    const api = (typeof window !== 'undefined' ? window.aiOffice : undefined) as
      Partial<HomeApi> | undefined
    void api?.revealPath?.(targetPath)
  }, [])

  const handleImageWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    const delta = event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP
    setZoom((prev) => clampZoom(prev + delta))
  }, [])

  // Empty state when no file is selected.
  if (filePath === null) {
    return (
      <section
        className={`fp-pane is-${variant}`}
        data-testid="file-preview-pane"
        aria-label={t('pcQuickPreview')}
      >
        {variant === 'inline' && onClose && (
          <button
            type="button"
            className="fp-close-btn fp-empty-float-close"
            data-testid="fp-close-btn"
            title={t('wmClose')}
            aria-label={t('wmClose')}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        )}
        <div className="fp-state-wrap" data-testid="fp-empty">
          <div className="fp-state-card">
            <div className="fp-empty-icon">
              <EmptyPreviewIcon />
            </div>
            <p className="fp-state-title">{t('pcPreviewEmpty')}</p>
          </div>
        </div>
      </section>
    )
  }

  const activePath = preview?.path ?? filePath
  const fallbackName = extractFileName(filePath)
  const displayName = preview?.name || fallbackName
  const displayExt = preview?.ext ?? extractFileExt(displayName)
  const hasSize = preview !== null && Number.isFinite(preview.size)
  const isMediaPlayable = preview?.kind === 'audio' || preview?.kind === 'video'
  const showModeToggle =
    !loading &&
    !fetchError &&
    preview !== null &&
    !preview.error &&
    (preview.kind === 'markdown' || preview.kind === 'html')

  const api = (typeof window !== 'undefined' ? window.aiOffice : undefined) as
    Partial<HomeApi> | undefined
  const canRevealPath = typeof api?.revealPath === 'function'

  const renderUnsupported = () => (
    <div className="fp-state-wrap" data-testid="fp-unsupported">
      <div className="fp-state-card">
        <FileBadge ext={displayExt} size={56} />
        <p className="fp-unsupported-name" title={activePath}>
          {displayName}
        </p>
        <div className="fp-unsupported-meta">
          {displayExt ? <span className="fp-ext-pill">{displayExt.toUpperCase()}</span> : null}
          {hasSize ? <span>{formatBytes(preview.size)}</span> : null}
        </div>
        <p className="fp-state-title">{t('pcPreviewUnsupported')}</p>
        {onOpenSystemDefault && (
          <button
            type="button"
            className="fp-action-btn is-primary"
            data-testid="fp-unsupported-open-external-btn"
            onClick={() => onOpenSystemDefault(activePath)}
          >
            <ExternalAppIcon />
            <span>{t('pcOpenSystemDefault')}</span>
          </button>
        )}
      </div>
    </div>
  )

  const renderBody = (): ReactElement => {
    if (loading) {
      return (
        <div className="fp-state-wrap" data-testid="fp-loading" role="status">
          <div className="fp-state-card">
            <div className="fp-loading-spinner" aria-hidden="true" />
            <p className="fp-state-title">{t('pcPreviewLoading')}</p>
            <div className="fp-skeleton-stack" aria-hidden="true">
              <span className="fp-skeleton-line is-long" />
              <span className="fp-skeleton-line is-med" />
              <span className="fp-skeleton-line is-short" />
            </div>
          </div>
        </div>
      )
    }

    if (fetchError || !preview || preview.error || preview.kind === 'unsupported') {
      return renderUnsupported()
    }

    switch (preview.kind) {
      case 'image': {
        if (!preview.mediaUrl || mediaError) return renderUnsupported()
        const zoomPercent = `${Math.round(zoom * 100)}%`
        return (
          <div className="fp-image-stage" data-testid="fp-image-preview">
            <div className="fp-image-viewport g-scroll" onWheel={handleImageWheel}>
              <img
                key={preview.path}
                className="fp-image-img"
                src={preview.mediaUrl}
                alt={preview.name}
                draggable={false}
                style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }}
                onError={() => setMediaError(true)}
              />
            </div>
            <div className="fp-image-controls" role="toolbar" aria-label={preview.name}>
              <button
                type="button"
                className="fp-ctrl-btn"
                data-testid="fp-zoom-out-btn"
                title={t('pcPreviewZoomOut')}
                aria-label={t('pcPreviewZoomOut')}
                disabled={zoom <= ZOOM_MIN}
                onClick={() => setZoom((prev) => clampZoom(prev - ZOOM_STEP))}
              >
                −
              </button>
              <button
                type="button"
                className="fp-ctrl-btn"
                data-testid="fp-zoom-reset-btn"
                title={t('pcPreviewZoomReset')}
                aria-label={t('pcPreviewZoomReset')}
                onClick={() => setZoom(1)}
              >
                {zoomPercent}
              </button>
              <button
                type="button"
                className="fp-ctrl-btn"
                data-testid="fp-zoom-in-btn"
                title={t('pcPreviewZoomIn')}
                aria-label={t('pcPreviewZoomIn')}
                disabled={zoom >= ZOOM_MAX}
                onClick={() => setZoom((prev) => clampZoom(prev + ZOOM_STEP))}
              >
                +
              </button>
              <span className="fp-ctrl-divider" aria-hidden="true" />
              <button
                type="button"
                className="fp-ctrl-btn"
                data-testid="fp-rotate-btn"
                title={t('pcPreviewRotate')}
                aria-label={t('pcPreviewRotate')}
                onClick={() => setRotation((prev) => prev + 90)}
              >
                <RotateIcon />
                <span>90°</span>
              </button>
            </div>
          </div>
        )
      }

      case 'video': {
        if (!preview.mediaUrl || mediaError) return renderUnsupported()
        return (
          <div className="fp-video-stage" data-testid="fp-video-preview">
            <video
              key={preview.path}
              className="fp-video-player"
              controls
              playsInline
              preload="metadata"
              src={preview.mediaUrl}
              onError={() => setMediaError(true)}
            />
          </div>
        )
      }

      case 'audio': {
        if (!preview.mediaUrl || mediaError) return renderUnsupported()
        return (
          <div className="fp-audio-stage" data-testid="fp-audio-preview">
            <div className="fp-audio-card">
              <div
                className={`fp-audio-disc${audioPlaying ? ' is-playing' : ''}`}
                aria-hidden="true"
              >
                <span className="fp-audio-disc-grooves" />
                <span className="fp-audio-disc-core">
                  <MusicNoteIcon />
                </span>
              </div>
              <div className="fp-audio-meta">
                <h3 className="fp-audio-title" title={preview.name}>
                  {preview.name}
                </h3>
                <div className="fp-audio-sub">
                  {displayExt ? (
                    <span className="fp-ext-pill">{displayExt.toUpperCase()}</span>
                  ) : null}
                  <span>{formatBytes(preview.size)}</span>
                </div>
              </div>
              <audio
                key={preview.path}
                className="fp-audio-player"
                controls
                preload="metadata"
                src={preview.mediaUrl}
                onPlay={() => setAudioPlaying(true)}
                onPause={() => setAudioPlaying(false)}
                onEnded={() => setAudioPlaying(false)}
                onError={() => setMediaError(true)}
              />
            </div>
          </div>
        )
      }

      case 'pdf': {
        if (!preview.mediaUrl || mediaError) return renderUnsupported()
        return (
          <div className="fp-pdf-stage" data-testid="fp-pdf-preview">
            <iframe
              key={preview.path}
              className="fp-pdf-frame"
              title={preview.name}
              src={preview.mediaUrl}
            />
          </div>
        )
      }

      case 'markdown': {
        const sourceText = preview.text ?? ''
        return (
          <div className="fp-markdown-stage" data-testid="fp-markdown-preview">
            {viewMode === 'source' ? (
              <CodeLinesView
                text={sourceText}
                ext={preview.ext}
                language={preview.language}
                truncated={preview.truncated}
                truncatedLabel={t('pcPreviewTruncated')}
              />
            ) : (
              <>
                {preview.truncated && (
                  <div className="fp-truncated-banner" role="status">
                    <InfoIcon />
                    <span>{t('pcPreviewTruncated')}</span>
                  </div>
                )}
                <div className="fp-markdown-scroll g-scroll">
                  <MarkdownBlocks source={sourceText} />
                </div>
              </>
            )}
          </div>
        )
      }

      case 'html': {
        const htmlText = preview.text ?? ''
        return (
          <div className="fp-html-stage" data-testid="fp-html-preview">
            {viewMode === 'source' ? (
              <CodeLinesView
                text={htmlText}
                ext={preview.ext}
                language={preview.language}
                truncated={preview.truncated}
                truncatedLabel={t('pcPreviewTruncated')}
              />
            ) : (
              <>
                {preview.truncated && (
                  <div className="fp-truncated-banner" role="status">
                    <InfoIcon />
                    <span>{t('pcPreviewTruncated')}</span>
                  </div>
                )}
                <iframe
                  key={preview.path}
                  sandbox=""
                  referrerPolicy="no-referrer"
                  srcDoc={htmlText}
                  title={preview.name}
                  className="fp-html-frame"
                />
              </>
            )}
          </div>
        )
      }

      case 'text': {
        return (
          <div className="fp-code-stage" data-testid="fp-text-preview">
            <CodeLinesView
              text={preview.text ?? ''}
              ext={preview.ext}
              language={preview.language}
              truncated={preview.truncated}
              truncatedLabel={t('pcPreviewTruncated')}
            />
          </div>
        )
      }

      case 'office': {
        return (
          <OfficePreviewStage
            text={preview.text ?? ''}
            canOpenInEditor={preview.canOpenInEditor}
            truncated={preview.truncated}
            truncatedLabel={t('pcPreviewTruncated')}
            openEditorLabel={t('pcOpenInEditor')}
            emptyLabel={t('pcPreviewUnsupported')}
            onOpenInEditor={onOpenInEditor ? () => onOpenInEditor(activePath) : undefined}
          />
        )
      }
    }
  }

  return (
    <section
      className={`fp-pane is-${variant}`}
      data-testid="file-preview-pane"
      aria-label={t('pcQuickPreview')}
    >
      <header className="fp-header">
        <div className="fp-header-info">
          <span className="fp-badge-wrap">
            <FileBadge ext={displayExt} size={22} />
          </span>
          <span className="fp-file-name" title={displayName}>
            {displayName}
          </span>
          {displayExt ? <span className="fp-ext-pill">{displayExt.toUpperCase()}</span> : null}
          {hasSize ? <span className="fp-file-size">{formatBytes(preview.size)}</span> : null}
        </div>

        <div className="fp-header-actions">
          {variant === 'inline' && onPopOutWindow && (
            <button
              type="button"
              className="fp-icon-btn"
              data-testid="fp-popout-btn"
              title={t('pcPopOutPreview')}
              aria-label={t('pcPopOutPreview')}
              onClick={() => onPopOutWindow(activePath)}
            >
              <PopOutIcon />
            </button>
          )}
          {isMediaPlayable && onOpenInMediaPlayer && (
            <button
              type="button"
              className="fp-action-btn is-primary"
              data-testid="fp-open-player-btn"
              title={t('pcOpenInPlayer')}
              onClick={() => onOpenInMediaPlayer(activePath)}
            >
              <PlayIcon />
              <span className="fp-btn-label">{t('pcOpenInPlayer')}</span>
            </button>
          )}
          {preview?.canOpenInEditor && onOpenInEditor && (
            <button
              type="button"
              className="fp-action-btn is-primary"
              data-testid="fp-open-editor-btn"
              title={t('pcOpenInEditor')}
              onClick={() => onOpenInEditor(activePath)}
            >
              <EditorIcon />
              <span className="fp-btn-label">{t('pcOpenInEditor')}</span>
            </button>
          )}
          {onOpenSystemDefault && (
            <button
              type="button"
              className="fp-action-btn is-compact-icon"
              data-testid="fp-open-external-btn"
              title={t('pcOpenSystemDefault')}
              aria-label={t('pcOpenSystemDefault')}
              onClick={() => onOpenSystemDefault(activePath)}
            >
              <ExternalAppIcon />
              <span className="fp-btn-label">{t('pcOpenSystemDefault')}</span>
            </button>
          )}
          {variant === 'inline' && onClose && (
            <button
              type="button"
              className="fp-close-btn"
              data-testid="fp-close-btn"
              title={t('wmClose')}
              aria-label={t('wmClose')}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </header>

      <div className="fp-path-bar">
        <span className="fp-path-text" title={activePath}>
          {activePath}
        </span>
        <div className="fp-path-actions">
          <button
            type="button"
            className={`fp-mini-icon-btn${copiedPath ? ' is-copied' : ''}`}
            title={t('copyPath')}
            aria-label={t('copyPath')}
            onClick={() => handleCopyPath(activePath)}
          >
            {copiedPath ? <CheckIcon /> : <CopyIcon />}
          </button>
          {canRevealPath && (
            <button
              type="button"
              className="fp-mini-icon-btn"
              title={t('revealInFolder')}
              aria-label={t('revealInFolder')}
              onClick={() => handleRevealFolder(activePath)}
            >
              <FolderRevealIcon />
            </button>
          )}
        </div>
      </div>

      {showModeToggle && (
        <div className="fp-subbar">
          <div className="fp-mode-tabs" role="tablist" aria-label={displayName}>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'rendered'}
              className={`fp-mode-tab${viewMode === 'rendered' ? ' is-active' : ''}`}
              data-testid="fp-mode-rendered"
              onClick={() => setViewMode('rendered')}
            >
              {t('pcPreviewRendered')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'source'}
              className={`fp-mode-tab${viewMode === 'source' ? ' is-active' : ''}`}
              data-testid="fp-mode-source"
              onClick={() => setViewMode('source')}
            >
              {t('pcPreviewSource')}
            </button>
          </div>
          {preview.kind === 'html' && viewMode === 'rendered' && (
            <span className="fp-sandbox-badge">
              <ShieldIcon />
              <span>{t('termSandboxNote')}</span>
            </span>
          )}
        </div>
      )}

      <div className="fp-body">{renderBody()}</div>
    </section>
  )
}
