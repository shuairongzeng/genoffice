import type { DesktopPrefs, DesktopRecentsMode } from '../../shared/home-api'
import type { DesktopItem, DesktopStackCategory } from './desktop-items'
import type { DesktopStrings } from './desktop-strings'

export type { DesktopStackCategory }

export type FileStackCategory = Exclude<DesktopStackCategory, 'recent'>

export const STACK_RECENT_ID = 'stack:recent'
export const STACK_CATEGORY_ID_PREFIX = 'stack:cat:'

const DOC_EXTS: ReadonlySet<string> = new Set([
  'doc',
  'docx',
  'odt',
  'ott',
  'rtf',
  'md',
  'markdown',
  'txt',
  'log',
  'json',
  'yaml',
  'yml',
  'xml',
  'ini',
  'toml',
  'html',
  'htm',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'sql',
  'sh',
  'bat',
])

const SHEET_EXTS: ReadonlySet<string> = new Set([
  'xlsx',
  'xlsm',
  'xls',
  'csv',
  'tsv',
  'ods',
  'ots',
  'numbers',
])

const SLIDE_EXTS: ReadonlySet<string> = new Set(['pptx', 'ppt', 'odp', 'otp', 'key'])

const MEDIA_EXTS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'opus',
  'wma',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
  'avi',
  'wmv',
  'flv',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'bmp',
  'ico',
  'avif',
])

function normalizedExt(ext: string, path?: string | null): string {
  const clean = ext.trim().replace(/^\.+/, '').toLowerCase()
  if (clean) return clean
  if (!path) return ''
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** Classify a desktop file extension/path into its display stack category. */
export function classifyFileStackCategory(
  ext: string,
  path?: string | null,
): FileStackCategory {
  const clean = normalizedExt(ext, path)
  if (!clean) return 'other'
  if (clean === 'pdf') return 'pdf'
  if (DOC_EXTS.has(clean)) return 'docs'
  if (SHEET_EXTS.has(clean)) return 'sheets'
  if (SLIDE_EXTS.has(clean)) return 'slides'
  if (MEDIA_EXTS.has(clean)) return 'media'
  return 'other'
}

/** Resolve the effective recents display mode, defaulting omitted values to 'stack'. */
export function effectiveRecentsMode(prefs?: Partial<DesktopPrefs> | null): DesktopRecentsMode {
  if (
    prefs?.recentsMode === 'stack' ||
    prefs?.recentsMode === 'spread' ||
    prefs?.recentsMode === 'off'
  ) {
    return prefs.recentsMode
  }
  return 'stack'
}

/** Localized stack card title for a stack category. */
export function stackCategoryTitle(
  category: DesktopStackCategory,
  strings: Pick<
    DesktopStrings,
    | 'stackRecent'
    | 'stackDocs'
    | 'stackSheets'
    | 'stackSlides'
    | 'stackPdf'
    | 'stackMedia'
    | 'stackOther'
  >,
): string {
  switch (category) {
    case 'recent':
      return strings.stackRecent
    case 'docs':
      return strings.stackDocs
    case 'sheets':
      return strings.stackSheets
    case 'slides':
      return strings.stackSlides
    case 'pdf':
      return strings.stackPdf
    case 'media':
      return strings.stackMedia
    case 'other':
      return strings.stackOther
  }
}

export interface ApplyDesktopStacksOptions {
  readonly recentsMode: DesktopRecentsMode
  readonly useStacks: boolean
  readonly hiddenRecentPaths: ReadonlySet<string>
  readonly strings: DesktopStrings
  readonly onOpenStack?: (stackId: string) => void
}

function newestMtime(items: readonly DesktopItem[]): number | undefined {
  let maxMtime: number | undefined
  for (const item of items) {
    if (typeof item.mtimeMs !== 'number') continue
    if (maxMtime === undefined || item.mtimeMs > maxMtime) {
      maxMtime = item.mtimeMs
    }
  }
  return maxMtime
}

function makeStackItem(
  id: string,
  category: DesktopStackCategory,
  stackItems: readonly DesktopItem[],
  strings: DesktopStrings,
  onOpenStack?: (stackId: string) => void,
): DesktopItem {
  return {
    id,
    kind: 'stack',
    title: stackCategoryTitle(category, strings),
    tile: null,
    ext: '',
    path: null,
    mtimeMs: newestMtime(stackItems),
    alias: false,
    draggable: true,
    stackCategory: category,
    stackItems,
    open: () => onOpenStack?.(id),
  }
}

/**
 * Group non-alias recent files and/or categorized desktop files into interactive stack
 * tiles so the desktop surface never overflows from opened files. System apps, folders,
 * and pinned folder aliases always pass through untouched.
 */
export function applyDesktopStacks(
  items: readonly DesktopItem[],
  options: ApplyDesktopStacksOptions,
): DesktopItem[] {
  const { recentsMode, useStacks, hiddenRecentPaths, strings, onOpenStack } = options
  const visibleRecents: DesktopItem[] = []
  const filePool: DesktopItem[] = []
  const widgets: DesktopItem[] = []
  const prefixPassthrough: DesktopItem[] = []

  for (const item of items) {
    if (item.kind === 'widget') {
      widgets.push(item)
      continue
    }
    if (item.kind !== 'file') {
      prefixPassthrough.push(item)
      continue
    }
    if (!item.alias) {
      if (item.path !== null && hiddenRecentPaths.has(item.path)) {
        continue
      }
      if (recentsMode === 'off') {
        continue
      }
      if (recentsMode === 'stack') {
        visibleRecents.push(item)
        continue
      }
      filePool.push(item)
      continue
    }
    filePool.push(item)
  }

  let groupedFiles: DesktopItem[]
  if (!useStacks) {
    groupedFiles = filePool
  } else {
    const buckets = new Map<FileStackCategory, DesktopItem[]>()
    const bucketOrder: FileStackCategory[] = []
    for (const fileItem of filePool) {
      const category = classifyFileStackCategory(fileItem.ext, fileItem.path)
      let bucket = buckets.get(category)
      if (!bucket) {
        bucket = []
        buckets.set(category, bucket)
        bucketOrder.push(category)
      }
      bucket.push(fileItem)
    }
    groupedFiles = []
    for (const category of bucketOrder) {
      const bucket = buckets.get(category)!
      if (bucket.length >= 2) {
        groupedFiles.push(
          makeStackItem(
            `${STACK_CATEGORY_ID_PREFIX}${category}`,
            category,
            bucket,
            strings,
            onOpenStack,
          ),
        )
      } else {
        groupedFiles.push(bucket[0])
      }
    }
  }

  const recentStackItems: DesktopItem[] =
    recentsMode === 'stack' && visibleRecents.length > 0
      ? [makeStackItem(STACK_RECENT_ID, 'recent', visibleRecents, strings, onOpenStack)]
      : []

  return [...prefixPassthrough, ...groupedFiles, ...recentStackItems, ...widgets]
}
