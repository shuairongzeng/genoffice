import { PROXIED_APP_DOCUMENT_FIELD, type ProxiedAppTool } from '@genoffice/agent-core'
import type { DocumentTabKind } from '../../shared/tabs-api'

export const DOCS_PAYLOAD_KEYS = ['startBlockIndex', 'endBlockIndex', 'offset'] as const
export const SHEETS_PAYLOAD_KEYS = ['range', 'addresses', 'sheet', 'sheetId'] as const
export const SLIDES_PAYLOAD_KEYS = ['slideIndex', 'start', 'end'] as const
export const PDF_PAYLOAD_KEYS = ['start', 'end'] as const
export const MEDIA_READ_PAYLOAD_KEYS = ['timestampSec'] as const
export const MEDIA_ANALYZE_PAYLOAD_KEYS = ['requirements'] as const
export const MAX_READ_ADDRESSES = 100
export const TEXT_PAGED_DEFAULT_CHARS = 24_000
export const TEXT_PAGED_MAX_CHARS = 48_000

export interface AppSkillToolSpec {
  kind: DocumentTabKind
  name: string
  description: string
  inputSchema: Record<string, unknown>
  payloadKeys: readonly string[]
  requiresToolReader?: boolean
}

export const TOOL_SPECS: Partial<Record<DocumentTabKind, readonly AppSkillToolSpec[]>> = {
  docs: [
    {
      kind: 'docs',
      name: 'docs:read_document',
      description:
        'Read a Word document the user has open in GenOffice. Without range arguments: returns the ' +
        'block list overview ("index|type|text" per block) plus the full HTML content preview ' +
        '(up to 16,000 characters). Pass 0-based `startBlockIndex` / `endBlockIndex` / `offset` to ' +
        'read full blocks or continue paginated content (up to 24,000 characters per call). ' +
        'Read-only: to modify this open document, switch to its tab if needed (shell:switch_tab) and call document_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          startBlockIndex: {
            type: 'integer',
            description: '0-based first top-level block index to read (defaults to 0 when paginating)',
          },
          endBlockIndex: {
            type: 'integer',
            description: '0-based last top-level block index to read inclusive (clamped safely to the document end)',
          },
          offset: {
            type: 'integer',
            description: '0-based character offset to continue reading a truncated block/preview response',
          },
        },
      },
      payloadKeys: DOCS_PAYLOAD_KEYS,
    },
  ],
  sheets: [
    {
      kind: 'sheets',
      name: 'sheets:read_sheet',
      description:
        'Read a spreadsheet the user has open in GenOffice. Without `range` or `addresses`: ' +
        'returns the workbook overview (sheet names, ids, data extents) plus a first-screen ' +
        'cell preview grid with formulas (up to 100 rows / 2,000 cells). Pass `range` (e.g. ' +
        '"A1:F32") or `addresses` (cell addresses or A1 ranges) to read specific regions, ' +
        'clamped automatically to the worksheet data extent. ' +
        'Read-only: to modify this open workbook, switch to its tab if needed (shell:switch_tab) and call document_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          range: {
            type: 'string',
            description:
              'A1 range to read as a grid (e.g. "A1:F32", clamped safely to the worksheet data extent; max 2,000 cells)',
          },
          addresses: {
            type: 'array',
            items: { type: 'string' },
            description:
              'A1 cell addresses (e.g. ["A1", "B2"]) or A1 range strings (e.g. ["A1:F32"]) to read; omit for the overview + preview grid',
          },
          sheet: {
            type: 'string',
            description: 'worksheet name to read from; default the active sheet',
          },
          sheetId: {
            type: 'string',
            description: 'worksheet id from a previous overview (a name is preferred)',
          },
        },
      },
      payloadKeys: SHEETS_PAYLOAD_KEYS,
    },
  ],
  slides: [
    {
      kind: 'slides',
      name: 'slides:read_deck',
      description:
        'Read the presentation the user has open in GenOffice: slides with their elements ' +
        '(ids, types, text, tables, charts, speaker notes, geometry in document-space EMU). ' +
        'Without page arguments returns a deck overview; pass 0-based `slideIndex` or `start`/`end` ' +
        'to read full untruncated text, tables, charts, and speaker notes for specific slides. ' +
        'Read-only: to modify this open deck, switch to its tab if needed (shell:switch_tab) and call document_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          slideIndex: {
            type: 'integer',
            description: '0-based single slide index to read in full without element truncation',
          },
          start: {
            type: 'integer',
            description: '0-based start slide index to read in full inclusive',
          },
          end: {
            type: 'integer',
            description: '0-based end slide index inclusive (clamped to deck length)',
          },
        },
      },
      payloadKeys: SLIDES_PAYLOAD_KEYS,
    },
  ],
  markdown: [
    {
      kind: 'markdown',
      name: 'markdown:read_text',
      description:
        'Read the markdown/plain-text content of a document the user has open in the GenOffice markdown/text editor. ' +
        'Large documents slice at 24,000 characters by default; pass `offset` (0-based) and optional `maxChars` to paginate. ' +
        'Read-only: to modify this open document, switch to its tab if needed (shell:switch_tab) and call document_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          offset: {
            type: 'integer',
            description: '0-based starting character offset for large files (defaults to 0)',
          },
          maxChars: {
            type: 'integer',
            description: 'maximum characters to return in one chunk (default 24,000, max 48,000)',
          },
        },
      },
      payloadKeys: [],
    },
  ],
  html: [
    {
      kind: 'html',
      name: 'html:read_text',
      description:
        'Read the HTML source text of a document the user has open in the GenOffice html editor. ' +
        'Large documents slice at 24,000 characters by default; pass `offset` (0-based) and optional `maxChars` to paginate. ' +
        'Read-only: to modify this open document, switch to its tab if needed (shell:switch_tab) and call document_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          offset: {
            type: 'integer',
            description: '0-based starting character offset for large files (defaults to 0)',
          },
          maxChars: {
            type: 'integer',
            description: 'maximum characters to return in one chunk (default 24,000, max 48,000)',
          },
        },
      },
      payloadKeys: [],
    },
  ],
  pdf: [
    {
      kind: 'pdf',
      name: 'pdf:read_pages',
      description:
        'Read text (including OCR text for scanned pages) from a PDF the user has open in GenOffice, ' +
        '1-based inclusive page numbers (up to 10 pages per call; defaults to pages 1-10). ' +
        'Read-only: to modify or annotate this open PDF, switch to its tab if needed (shell:switch_tab) and call document_agent.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          start: {
            type: 'integer',
            description: '1-based start page number (defaults to 1)',
          },
          end: {
            type: 'integer',
            description: '1-based end page number, inclusive (defaults to start + 9, capped at 10 pages per call)',
          },
        },
      },
      payloadKeys: PDF_PAYLOAD_KEYS,
    },
  ],
  media: [
    {
      kind: 'media',
      name: 'media:read_media',
      description:
        'Read and visually inspect an open image, video, or audio tab in GenOffice. For images: returns ' +
        'dimensions/file metadata plus the normalized image for direct vision understanding. For videos: ' +
        'captures the current playback frame (or seeks to optional `timestampSec` first) plus metadata. ' +
        'For audio: returns file metadata, duration, and playback position. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          timestampSec: {
            type: 'number',
            description: 'optional video playback timestamp in seconds to seek before capturing a frame',
          },
        },
      },
      payloadKeys: MEDIA_READ_PAYLOAD_KEYS,
    },
    {
      kind: 'media',
      name: 'media:analyze_media',
      description:
        'Analyze an open audio or video file (transcription, dialogue/event summary, semantic understanding) ' +
        'using the configured AI media analysis provider. Pass `requirements` describing what to transcribe or analyze.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PROXIED_APP_DOCUMENT_FIELD,
          requirements: {
            type: 'string',
            description: 'what to transcribe, summarize, or analyze in this media file',
          },
        },
        required: ['requirements'],
      },
      payloadKeys: MEDIA_ANALYZE_PAYLOAD_KEYS,
      requiresToolReader: true,
    },
  ],
}

export const STATIC_PROXIED_APP_TOOLS: readonly ProxiedAppTool[] = Object.values(TOOL_SPECS)
  .flat()
  .map((spec) => ({
    name: spec.name,
    kind: spec.kind,
    description: spec.description,
    inputSchema: spec.inputSchema,
  }))
