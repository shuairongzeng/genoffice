import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { useDismissablePopover } from '@genoffice/ui'
import type {
  HomeApi,
  SystemDirEntry,
  SystemDirListing,
  SystemDriveInfo,
  SystemDriveKind,
  SystemDrivesSnapshot,
  SystemPlaceId,
  SystemPlaceInfo,
  SystemSearchResult,
} from '../../shared/home-api'
import { compileSystemSearchMatcher } from '../../shared/system-search-matcher'
import { ComputerGlyph as BrandComputerGlyph } from './app-glyphs'
import { FileBadge } from './file-badge'
import { FilePreviewPane } from './FilePreviewPane'
import { placeFolderMenu } from './folder-menu-position'
import { fixedViewportWidth, formatModified } from './home-shared'
import { useI18n } from './locale'
import './computer.css'

export interface ComputerViewProps {
  readonly initialPath?: string | null
  readonly embeddedInWindow?: boolean
  readonly onBackToDesktop: () => void
  readonly onOpenTerminalAtPath?: (targetPath: string) => void
  readonly onAddedFolderRoot?: () => void
  readonly onTitleChange?: (title: string) => void
  readonly onPreviewFile?: (filePath: string) => void
  readonly onOpenMediaInPlayer?: (filePath: string) => void
  readonly onNewWindow?: (targetPath?: string) => void
}

interface BreadcrumbSegment {
  readonly label: string
  readonly path: string
}

type EntryMenuTarget =
  | { readonly kind: 'place'; readonly place: SystemPlaceInfo }
  | { readonly kind: 'drive'; readonly drive: SystemDriveInfo }
  | { readonly kind: 'entry'; readonly entry: SystemDirEntry }

interface EntryMenuState {
  readonly target: EntryMenuTarget
  readonly x: number
  readonly y: number
  readonly above: number
  readonly align: 'start' | 'end'
}

const TOAST_DURATION_MS = 2600
const EMPTY_API: Partial<HomeApi> = {}
const AV_MEDIA_EXTS = new Set([
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'opus',
  'wma',
  'aiff',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
])
const QUICK_PREVIEW_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
  'bmp',
  'ico',
  'avif',
  'txt',
  'ini',
  'cfg',
  'conf',
  'properties',
  'env',
  'json',
  'yaml',
  'yml',
  'xml',
  'toml',
  'log',
  'csv',
  'tsv',
  'py',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'css',
  'scss',
  'less',
  'sql',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'bat',
  'cmd',
  'c',
  'cpp',
  'h',
  'hpp',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'swift',
  'kt',
  'vue',
  'svelte',
])

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

/** Check whether a path points to a filesystem / drive / UNC share root. */
function isDriveRootPath(targetPath: string): boolean {
  const trimmed = targetPath.trim()
  if (trimmed === '/') return true
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed)) return true
  if (/^\\\\[^\\]+\\[^\\]+[\\/]?$/.test(trimmed)) return true
  return false
}

/** Compute a fallback parent path while directory metadata is loading or errored. */
function fallbackParentDir(dirPath: string): string | null {
  if (isDriveRootPath(dirPath)) return null
  const normalized = dirPath.replace(/[\\/]+$/, '')
  if (!normalized) return null
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (cut < 0) return null
  if (cut === 0) return '/'
  const parent = normalized.slice(0, cut)
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
  return parent
}

/** Split an absolute path into clickable breadcrumb segments (Windows, UNC, and POSIX). */
function buildBreadcrumbs(dirPath: string): BreadcrumbSegment[] {
  const raw = dirPath.trim()
  if (!raw) return []

  // UNC path: \\server\share\sub\...
  if (raw.startsWith('\\\\')) {
    const parts = raw.slice(2).split('\\').filter(Boolean)
    if (parts.length === 0) return []
    if (parts.length === 1) {
      const root = `\\\\${parts[0]}`
      return [{ label: root, path: root }]
    }
    const shareRoot = `\\\\${parts[0]}\\${parts[1]}`
    const segments: BreadcrumbSegment[] = [{ label: shareRoot, path: shareRoot }]
    let acc = shareRoot
    for (let i = 2; i < parts.length; i++) {
      acc = `${acc}\\${parts[i]}`
      segments.push({ label: parts[i]!, path: acc })
    }
    return segments
  }

  // Windows drive path: C:\Users\Alice
  const winMatch = /^([A-Za-z]:)(?:[\\/](.*))?$/.exec(raw)
  if (winMatch) {
    const drive = winMatch[1]!
    const rootPath = `${drive}\\`
    const rest = (winMatch[2] ?? '').split(/[\\/]/).filter(Boolean)
    const segments: BreadcrumbSegment[] = [{ label: rootPath, path: rootPath }]
    let acc = drive
    for (const part of rest) {
      acc = `${acc}\\${part}`
      segments.push({ label: part, path: acc })
    }
    return segments
  }

  // POSIX path: /Users/alice/Docs
  const parts = raw.split('/').filter(Boolean)
  const segments: BreadcrumbSegment[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc = `${acc}/${part}`
    segments.push({ label: part, path: acc })
  }
  return segments
}

function clampRatio(drive: SystemDriveInfo): number {
  const raw = Number.isFinite(drive.usedRatio)
    ? drive.usedRatio
    : drive.totalBytes > 0
      ? drive.usedBytes / drive.totalBytes
      : 0
  return Math.min(1, Math.max(0, raw))
}

function driveBarTone(ratio: number): 'normal' | 'warn' | 'danger' {
  if (ratio >= 0.92) return 'danger'
  if (ratio >= 0.8) return 'warn'
  return 'normal'
}

function driveDisplayTitle(drive: SystemDriveInfo): string {
  const name = drive.name.trim()
  const label = drive.label.trim()
  if (label && name && !name.toLowerCase().includes(label.toLowerCase())) {
    return `${label} (${name})`
  }
  return label || name || drive.path
}

function BackArrowIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 3.5L5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function UpArrowIcon(): ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 13V3.5M4.2 7.2L8 3.4l3.8 3.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RefreshIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13.6 8a5.6 5.6 0 1 1-1.64-3.96M13.6 2.4v3.2h-3.2"
        stroke="currentColor"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function MiniComputerGlyph({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="2.8"
        y="4"
        width="18.4"
        height="12.5"
        rx="2.2"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M8.5 20h7M12 16.5V20"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

function TerminalGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="1.8"
        y="2.6"
        width="12.4"
        height="10.8"
        rx="2.1"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path
        d="M4.6 6.2L6.8 8l-2.2 1.8M8.2 9.8h3.1"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function AddWorkspaceGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.8 4.2A1.5 1.5 0 0 1 3.3 2.7h2.9c.42 0 .82.18 1.1.5l1.05 1.2h4.35a1.5 1.5 0 0 1 1.5 1.5v5.6a1.5 1.5 0 0 1-1.5 1.5H3.3a1.5 1.5 0 0 1-1.5-1.5V4.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.8v3.6M6.2 8.6h3.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SearchGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function PreviewPaneGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="1.8"
        y="2.6"
        width="12.4"
        height="10.8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M9.6 2.8v10.4" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M11.1 5.6h1.6M11.1 7.8h1.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function NewWindowGlyph(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="4.5" width="9.5" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.5 4.2V3.5A1.5 1.5 0 0 1 7 2h5.5A1.5 1.5 0 0 1 14 3.5V9a1.5 1.5 0 0 1-1.5 1.5h-.7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

function MoreDotsIcon(): ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.35" fill="currentColor" />
      <circle cx="8" cy="8" r="1.35" fill="currentColor" />
      <circle cx="12.8" cy="8" r="1.35" fill="currentColor" />
    </svg>
  )
}

function ReadOnlyShieldIcon(): ReactElement {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 1.8l5 2v3.8c0 3.2-2.1 5.6-5 6.6-2.9-1-5-3.4-5-6.6V3.8l5-2z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M6.2 8.1l1.3 1.3 2.5-2.6"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlaceIcon({ id }: { id: SystemPlaceId }): ReactElement {
  if (id === 'desktop') {
    return (
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="2.8"
          y="4"
          width="18.4"
          height="12.5"
          rx="2.2"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <rect
          x="5.4"
          y="6.6"
          width="4.4"
          height="3.6"
          rx="1"
          fill="currentColor"
          fillOpacity="0.28"
        />
        <path
          d="M8.5 20h7M12 16.5V20"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'downloads') {
    return (
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M12 3.8v11.2M7.6 11.1L12 15.5l4.4-4.4"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'documents') {
    return (
      <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M6.5 3.5h7.6L18.5 8v12.5a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20.5V5a1.5 1.5 0 0 1 1.5-1.5z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M14 3.8V8h4.2" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path
          d="M8.5 12h7M8.5 15.8h4.8"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="9" cy="9.5" r="1.6" fill="currentColor" />
      <path
        d="M4.8 17.5l4.8-4.8 3.2 3 2.4-2.3 4 4.1"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DriveIcon({ kind, isSystem }: { kind: SystemDriveKind; isSystem: boolean }): ReactElement {
  if (kind === 'removable') {
    return (
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect
          x="7"
          y="7"
          width="10"
          height="13.5"
          rx="2.4"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M9.2 7V3.8h5.6V7M10.8 11.2h2.4M10.8 14.8h2.4"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (kind === 'network') {
    return (
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="4.5" width="16" height="8" rx="2" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="16.5" cy="8.5" r="1" fill="currentColor" />
        <path
          d="M12 12.5V17M5 17h14M10 17h4v2.5h-4z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (kind === 'optical') {
    return (
      <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
        <path d="M7.8 6.8l2.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg width="23" height="23" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="3.5"
        y="5.5"
        width="17"
        height="13"
        rx="2.6"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M3.8 13.5h16.4" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16.5" cy="16" r="1" fill="currentColor" />
      {(kind === 'system' || isSystem) && (
        <path
          d="M7.2 8.2h2.2v2.2H7.2zM10.4 8.2h2.2v2.2h-2.2z"
          fill="currentColor"
          fillOpacity="0.85"
        />
      )}
    </svg>
  )
}

function FolderGlyphIcon(): ReactElement {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.2A2.2 2.2 0 0 1 5.2 4h4.2c.62 0 1.2.27 1.6.75L12.5 6.5h6.3A2.2 2.2 0 0 1 21 8.7v9.1a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8V6.2z"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.65"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * "This PC" read-only local drives, quick places, and lazy directory browser.
 * Isolated from `folderRoots` and `FileIndexer` until the user explicitly adds
 * a regular directory to the desktop workspace.
 */
export function ComputerView({
  initialPath,
  embeddedInWindow = false,
  onBackToDesktop,
  onOpenTerminalAtPath,
  onAddedFolderRoot,
  onTitleChange,
  onPreviewFile,
  onOpenMediaInPlayer,
  onNewWindow,
}: ComputerViewProps): ReactElement {
  const i18n = useI18n()
  const { t } = i18n
  const api = (window.aiOffice ?? EMPTY_API) as Partial<HomeApi>

  const [currentDir, setCurrentDir] = useState<string | null>(initialPath ?? null)
  const [snapshot, setSnapshot] = useState<SystemDrivesSnapshot | null>(null)
  const [drivesLoading, setDrivesLoading] = useState(false)

  const [listing, setListing] = useState<SystemDirListing | null>(null)
  const [dirLoading, setDirLoading] = useState(false)
  const [showAllFiles, setShowAllFiles] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [useRegex, setUseRegex] = useState(false)
  const [recursiveSearch, setRecursiveSearch] = useState(true)
  const [previewPaneOpen, setPreviewPaneOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchResult, setSearchResult] = useState<SystemSearchResult | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  const [entryMenu, setEntryMenu] = useState<EntryMenuState | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const drivesReqRef = useRef(0)
  const drivesLoadedRef = useRef(false)
  const dirReqRef = useRef(0)
  const searchReqRef = useRef(0)
  const activeSearchIdRef = useRef<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevSearchTextRef = useRef('')
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const cancelActiveSearch = useCallback(() => {
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
    searchReqRef.current += 1
    if (activeSearchIdRef.current && typeof api.systemCancelSearch === 'function') {
      void api.systemCancelSearch(activeSearchIdRef.current)
    }
    activeSearchIdRef.current = null
    setSearchLoading(false)
  }, [api])

  // Synchronize current directory only when parent updates initialPath on a non-window or explicit switch
  const lastInitialPathRef = useRef(initialPath)
  useEffect(() => {
    if (lastInitialPathRef.current === initialPath) return
    lastInitialPathRef.current = initialPath
    cancelActiveSearch()
    setCurrentDir(initialPath ?? null)
    setSearchQuery('')
    setSearchResult(null)
    setSelectedPath(null)
    setEntryMenu(null)
  }, [cancelActiveSearch, initialPath])

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(message)
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null
      setToast(null)
    }, TOAST_DURATION_MS)
  }, [])

  useEffect(() => {
    return () => {
      cancelActiveSearch()
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [cancelActiveSearch])

  const loadDrives = useCallback(
    async (forceRefresh = false) => {
      if (typeof api.systemDrives !== 'function') return
      const reqId = ++drivesReqRef.current
      drivesLoadedRef.current = true
      setDrivesLoading(true)
      try {
        const next = await api.systemDrives(forceRefresh)
        if (drivesReqRef.current === reqId) setSnapshot(next)
      } catch {
        // Keep the previous snapshot visible when a refresh fails
      } finally {
        if (drivesReqRef.current === reqId) setDrivesLoading(false)
      }
    },
    [api],
  )

  const loadDir = useCallback(
    async (dir: string, allFiles: boolean) => {
      if (typeof api.systemListDir !== 'function') return
      const reqId = ++dirReqRef.current
      setDirLoading(true)
      try {
        const next = await api.systemListDir(dir, { showAllFiles: allFiles })
        if (dirReqRef.current === reqId) setListing(next)
      } catch {
        if (dirReqRef.current === reqId) {
          setListing({
            dir,
            parentDir: fallbackParentDir(dir),
            isDriveRoot: isDriveRootPath(dir),
            folders: [],
            files: [],
            totalCount: 0,
            truncated: false,
            error: 'denied',
          })
        }
      } finally {
        if (dirReqRef.current === reqId) setDirLoading(false)
      }
    },
    [api],
  )

  // Fetch overview snapshot when viewing root; fetch directory listing when inside a path
  useEffect(() => {
    if (currentDir === null) {
      if (!drivesLoadedRef.current) void loadDrives(false)
      return
    }
    void loadDir(currentDir, showAllFiles)
  }, [currentDir, showAllFiles, loadDrives, loadDir])

  // Dismiss context menu on outside click, window blur, Escape, or scroll
  useDismissablePopover(entryMenu !== null, () => setEntryMenu(null), {
    inside: () => [menuRef.current],
  })

  useEffect(() => {
    if (!entryMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setEntryMenu(null)
    }
    const onScroll = () => setEntryMenu(null)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [entryMenu])

  // Clamp fixed context menu inside the viewport bounds
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!entryMenu || !el) return
    const { left, top } = placeFolderMenu(
      entryMenu,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: fixedViewportWidth(), height: document.documentElement.clientHeight },
    )
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [entryMenu])

  const navigateTo = useCallback(
    (nextDir: string | null) => {
      cancelActiveSearch()
      setEntryMenu(null)
      setSelectedPath(null)
      setSearchQuery('')
      setSearchResult(null)
      setCurrentDir(nextDir)
    },
    [cancelActiveSearch],
  )

  const handleGoUp = useCallback(() => {
    if (currentDir === null) return
    const activeListing = listing?.dir === currentDir ? listing : null
    if (activeListing) {
      if (activeListing.isDriveRoot || activeListing.parentDir === null) {
        navigateTo(null)
      } else {
        navigateTo(activeListing.parentDir)
      }
      return
    }
    navigateTo(fallbackParentDir(currentDir))
  }, [currentDir, listing, navigateTo])

  // Support Alt+ArrowUp, ArrowUp/ArrowDown selection walk, and Space Quick Look

  const openEntryFile = useCallback(
    (entry: SystemDirEntry) => {
      const cleanExt = entry.ext.trim().toLowerCase()
      if (AV_MEDIA_EXTS.has(cleanExt) && onOpenMediaInPlayer) {
        onOpenMediaInPlayer(entry.path)
        return
      }
      if (QUICK_PREVIEW_EXTS.has(cleanExt) && onPreviewFile) {
        onPreviewFile(entry.path)
        return
      }
      if (entry.supported) {
        void api.openPath?.(entry.path)
      } else {
        void api.desktopOpenExternal?.(entry.path)
      }
    },
    [api, onOpenMediaInPlayer, onPreviewFile],
  )

  const handleCopyPath = useCallback(
    (targetPath: string) => {
      void navigator.clipboard?.writeText(targetPath)
      showToast(`${t('copyPath')}: ${targetPath}`)
    },
    [showToast, t],
  )

  const handleRevealPath = useCallback(
    (targetPath: string) => {
      void api.revealPath?.(targetPath)
    },
    [api],
  )

  const handleAddToWorkspace = useCallback(
    async (targetPath: string) => {
      if (isDriveRootPath(targetPath) || typeof api.dropFolderRoots !== 'function') return
      try {
        await api.dropFolderRoots([targetPath])
        onAddedFolderRoot?.()
        showToast(t('pcAddedToWorkspace'))
      } catch {
        // Ignore IPC errors on read-only or unavailable paths
      }
    },
    [api, onAddedFolderRoot, showToast, t],
  )

  const openContextMenuAtPointer = (
    event: ReactMouseEvent<HTMLElement>,
    target: EntryMenuTarget,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setEntryMenu({
      target,
      x: event.clientX + 2,
      y: event.clientY + 2,
      above: event.clientY + 2,
      align: 'start',
    })
  }

  const openContextMenuAtButton = (
    event: ReactMouseEvent<HTMLButtonElement>,
    target: EntryMenuTarget,
  ) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setEntryMenu({
      target,
      x: rect.right,
      y: rect.bottom + 4,
      above: rect.top - 4,
      align: 'end',
    })
  }

  const placeLabel = (id: SystemPlaceId): string => {
    switch (id) {
      case 'desktop':
        return t('pcPlaceDesktop')
      case 'downloads':
        return t('pcPlaceDownloads')
      case 'documents':
        return t('pcPlaceDocuments')
      case 'pictures':
        return t('pcPlacePictures')
    }
  }

  const driveKindLabel = (drive: SystemDriveInfo): string => {
    if (drive.isSystem || drive.kind === 'system') return t('pcDriveSystem')
    switch (drive.kind) {
      case 'removable':
        return t('pcDriveRemovable')
      case 'network':
        return t('pcDriveNetwork')
      case 'optical':
        return t('pcDriveOptical')
      case 'fixed':
      case 'unknown':
      default:
        return t('pcDriveFixed')
    }
  }

  const activeListing = currentDir !== null && listing?.dir === currentDir ? listing : null
  const breadcrumbs = useMemo(
    () => (currentDir !== null ? buildBreadcrumbs(currentDir) : []),
    [currentDir],
  )

  const trimmedQuery = searchQuery.trim()
  const compiledQuery = useMemo(
    () =>
      trimmedQuery ? compileSystemSearchMatcher({ query: trimmedQuery, regex: useRegex }) : null,
    [trimmedQuery, useRegex],
  )
  const isRegexError =
    (compiledQuery !== null && !compiledQuery.ok) || searchResult?.error === 'invalid-regex'
  const isRecursiveActive = currentDir !== null && recursiveSearch && trimmedQuery.length > 0

  const runRecursiveSearch = useCallback(
    async (dir: string, query: string, regex: boolean, allFiles: boolean) => {
      const precheck = compileSystemSearchMatcher({ query, regex })
      if (!precheck.ok) {
        cancelActiveSearch()
        setSearchResult(null)
        return
      }
      if (typeof api.systemSearch !== 'function') return

      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
      if (activeSearchIdRef.current && typeof api.systemCancelSearch === 'function') {
        void api.systemCancelSearch(activeSearchIdRef.current)
      }

      const reqId = ++searchReqRef.current
      const searchId = `pc-search-${reqId}`
      activeSearchIdRef.current = searchId
      setSearchLoading(true)

      try {
        const next = await api.systemSearch(dir, {
          query,
          regex,
          showAllFiles: allFiles,
          searchId,
        })
        if (searchReqRef.current !== reqId) return
        if (next.cancelled) return
        setSearchResult(next)
      } catch {
        if (searchReqRef.current === reqId) {
          setSearchResult(null)
        }
      } finally {
        if (searchReqRef.current === reqId) {
          activeSearchIdRef.current = null
          setSearchLoading(false)
        }
      }
    },
    [api, cancelActiveSearch],
  )

  // Schedule or cancel recursive background searches when directory, query, or flags change
  useEffect(() => {
    if (currentDir === null || !recursiveSearch || !trimmedQuery) {
      prevSearchTextRef.current = trimmedQuery
      cancelActiveSearch()
      setSearchResult(null)
      return
    }
    if (compiledQuery && !compiledQuery.ok) {
      prevSearchTextRef.current = trimmedQuery
      cancelActiveSearch()
      setSearchResult(null)
      return
    }

    const queryChanged = prevSearchTextRef.current !== trimmedQuery
    prevSearchTextRef.current = trimmedQuery
    const delayMs = queryChanged ? 280 : 0

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(() => {
      searchTimerRef.current = null
      void runRecursiveSearch(currentDir, trimmedQuery, useRegex, showAllFiles)
    }, delayMs)

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = null
      }
    }
  }, [
    cancelActiveSearch,
    compiledQuery,
    currentDir,
    recursiveSearch,
    runRecursiveSearch,
    showAllFiles,
    trimmedQuery,
    useRegex,
  ])

  const activeSearchResult =
    isRecursiveActive &&
    searchResult !== null &&
    searchResult.rootDir === currentDir &&
    searchResult.query === trimmedQuery
      ? searchResult
      : null

  const filteredFolders = useMemo(() => {
    if (isRecursiveActive) {
      if (isRegexError) return []
      return activeSearchResult?.folders ?? []
    }
    const items = activeListing?.folders ?? []
    if (!trimmedQuery) return items
    if (!compiledQuery?.ok) return []
    return items.filter((item) => compiledQuery.matches(item.name))
  }, [
    activeListing,
    activeSearchResult,
    compiledQuery,
    isRecursiveActive,
    isRegexError,
    trimmedQuery,
  ])

  const filteredFiles = useMemo(() => {
    if (isRecursiveActive) {
      if (isRegexError) return []
      return activeSearchResult?.files ?? []
    }
    const items = activeListing?.files ?? []
    if (!trimmedQuery) return items
    if (!compiledQuery?.ok) return []
    return items.filter((item) => compiledQuery.matches(item.name))
  }, [
    activeListing,
    activeSearchResult,
    compiledQuery,
    isRecursiveActive,
    isRegexError,
    trimmedQuery,
  ])

  const selectedFileEntry = useMemo(
    () => filteredFiles.find((file) => file.path === selectedPath) ?? null,
    [filteredFiles, selectedPath],
  )

  // Notify parent floating window whenever current folder or overview changes
  useEffect(() => {
    if (!onTitleChange) return
    if (currentDir === null) {
      onTitleChange(t('pcTitle'))
      return
    }
    const lastSeg = breadcrumbs[breadcrumbs.length - 1]?.label ?? currentDir
    onTitleChange(`${t('pcTitle')} — ${lastSeg}`)
  }, [breadcrumbs, currentDir, onTitleChange, t])

  // Support Alt+ArrowUp, ArrowUp/ArrowDown selection walk, and Space Quick Look
  const handleRootKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (currentDir === null) return
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault()
      handleGoUp()
      return
    }
    const target = event.target as HTMLElement | null
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      entryMenu !== null
    ) {
      return
    }
    if (
      (event.key === ' ' || event.code === 'Space') &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (selectedFileEntry) {
        event.preventDefault()
        if (onPreviewFile) onPreviewFile(selectedFileEntry.path)
        else setPreviewPaneOpen(true)
      }
      return
    }
    if (
      (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      if (filteredFiles.length === 0) return
      event.preventDefault()
      const idx = filteredFiles.findIndex((file) => file.path === selectedPath)
      const nextIdx =
        event.key === 'ArrowDown'
          ? idx < 0
            ? 0
            : Math.min(filteredFiles.length - 1, idx + 1)
          : idx <= 0
            ? 0
            : idx - 1
      const nextEntry = filteredFiles[nextIdx]
      if (nextEntry) setSelectedPath(nextEntry.path)
    }
  }

  const canAddCurrentDir =
    currentDir !== null &&
    !isDriveRootPath(currentDir) &&
    activeListing !== null &&
    !activeListing.isDriveRoot &&
    !activeListing.error

  const renderContextMenu = () => {
    if (!entryMenu) return null
    const { target } = entryMenu

    if (target.kind === 'place') {
      const { place } = target
      return (
        <div ref={menuRef} className="pc-menu" role="menu" data-testid="pc-entry-menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              navigateTo(place.path)
            }}
          >
            {t('open')}
          </button>
          {!isDriveRootPath(place.path) && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setEntryMenu(null)
                void handleAddToWorkspace(place.path)
              }}
            >
              {t('pcAddToWorkspace')}
            </button>
          )}
          <div className="pc-menu-divider" />
          {onOpenTerminalAtPath && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setEntryMenu(null)
                onOpenTerminalAtPath(place.path)
              }}
            >
              {t('openInTerminal')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              handleRevealPath(place.path)
            }}
          >
            {t('revealInFolder')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              handleCopyPath(place.path)
            }}
          >
            {t('copyPath')}
          </button>
        </div>
      )
    }

    if (target.kind === 'drive') {
      const { drive } = target
      return (
        <div ref={menuRef} className="pc-menu" role="menu" data-testid="pc-entry-menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              navigateTo(drive.path)
            }}
          >
            {t('open')}
          </button>
          <div className="pc-menu-divider" />
          {onOpenTerminalAtPath && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setEntryMenu(null)
                onOpenTerminalAtPath(drive.path)
              }}
            >
              {t('openInTerminal')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              handleRevealPath(drive.path)
            }}
          >
            {t('revealInFolder')}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              handleCopyPath(drive.path)
            }}
          >
            {t('copyPath')}
          </button>
        </div>
      )
    }

    const { entry } = target
    const isFolder = entry.kind === 'folder'
    const cleanExt = entry.ext.trim().toLowerCase()
    const entryParentDir = fallbackParentDir(entry.path) ?? currentDir ?? entry.path
    const terminalTarget = isFolder ? entry.path : entryParentDir
    const hasRelativeParent = Boolean(entry.relativeDir && entry.relativeDir.length > 0)

    return (
      <div ref={menuRef} className="pc-menu" role="menu" data-testid="pc-entry-menu">
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setEntryMenu(null)
            if (isFolder) navigateTo(entry.path)
            else openEntryFile(entry)
          }}
        >
          {t('open')}
        </button>
        {!isFolder && onPreviewFile && (
          <button
            type="button"
            role="menuitem"
            data-testid="pc-menu-quick-preview"
            onClick={() => {
              setEntryMenu(null)
              onPreviewFile(entry.path)
            }}
          >
            {t('pcQuickPreview')}
          </button>
        )}
        {!isFolder && AV_MEDIA_EXTS.has(cleanExt) && onOpenMediaInPlayer && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              onOpenMediaInPlayer(entry.path)
            }}
          >
            {t('pcOpenInPlayer')}
          </button>
        )}
        {hasRelativeParent && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              navigateTo(entryParentDir)
            }}
          >
            {t('pcOpenParentFolder')}
          </button>
        )}
        {isFolder && !isDriveRootPath(entry.path) && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              void handleAddToWorkspace(entry.path)
            }}
          >
            {t('pcAddToWorkspace')}
          </button>
        )}
        {!isFolder && !entry.supported && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              void api.desktopOpenExternal?.(entry.path)
            }}
          >
            {t('pcOpenSystemDefault')}
          </button>
        )}
        <div className="pc-menu-divider" />
        {onOpenTerminalAtPath && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setEntryMenu(null)
              onOpenTerminalAtPath(terminalTarget)
            }}
          >
            {t('openInTerminal')}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setEntryMenu(null)
            handleRevealPath(entry.path)
          }}
        >
          {t('revealInFolder')}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setEntryMenu(null)
            handleCopyPath(entry.path)
          }}
        >
          {t('copyPath')}
        </button>
      </div>
    )
  }

  const renderOverview = () => {
    const showSkeleton = drivesLoading && snapshot === null
    return (
      <div className="pc-container">
        <header className="pc-header">
          <div className="pc-header-left">
            {!embeddedInWindow && (
              <button
                type="button"
                className="pc-back-btn"
                data-testid="pc-back-desktop-btn"
                onClick={onBackToDesktop}
              >
                <BackArrowIcon />
                <span>{t('pcBackToDesktop')}</span>
              </button>
            )}
            <div className="pc-title-wrap">
              <span className="pc-title-icon">
                <BrandComputerGlyph />
              </span>
              <h1 className="pc-title">{t('pcTitle')}</h1>
            </div>
          </div>
          <div className="pc-header-right">
            <span className="pc-readonly-badge">
              <ReadOnlyShieldIcon />
              <span>{t('pcReadOnlyNotice')}</span>
            </span>
            {onNewWindow && (
              <button
                type="button"
                className="pc-action-btn"
                data-testid="pc-new-window-btn"
                onClick={() => onNewWindow()}
              >
                <NewWindowGlyph />
                <span>{t('pcNewWindow')}</span>
              </button>
            )}
            <button
              type="button"
              className={`pc-refresh-btn${drivesLoading ? ' is-spinning' : ''}`}
              data-testid="pc-refresh-btn"
              disabled={drivesLoading}
              aria-label={t('pcRefresh')}
              title={t('pcRefresh')}
              onClick={() => void loadDrives(true)}
            >
              <RefreshIcon />
              <span>{t('pcRefresh')}</span>
            </button>
          </div>
        </header>

        <section className="pc-section" aria-label={t('pcPlacesTitle')}>
          <div className="pc-section-head">
            <h2 className="pc-section-title">{t('pcPlacesTitle')}</h2>
          </div>
          <div className="pc-places-grid" data-testid="pc-places-grid">
            {showSkeleton
              ? Array.from({ length: 4 }, (_, index) => (
                  <div key={index} className="pc-place-card is-skeleton" aria-hidden="true">
                    <span className="pc-skeleton-box pc-skeleton-icon" />
                    <div className="pc-place-meta">
                      <span className="pc-skeleton-box pc-skeleton-line-md" />
                      <span className="pc-skeleton-box pc-skeleton-line-sm" />
                    </div>
                  </div>
                ))
              : (snapshot?.places ?? []).map((place) => (
                  <button
                    key={place.id}
                    type="button"
                    className={`pc-place-card${place.accessible ? '' : ' is-disabled'}`}
                    data-testid={`pc-place-${place.id}`}
                    disabled={!place.accessible}
                    aria-disabled={!place.accessible}
                    title={place.path}
                    onClick={() => {
                      if (place.accessible) navigateTo(place.path)
                    }}
                    onContextMenu={(event) => {
                      if (place.accessible)
                        openContextMenuAtPointer(event, { kind: 'place', place })
                    }}
                  >
                    <span className={`pc-place-icon place-${place.id}`}>
                      <PlaceIcon id={place.id} />
                    </span>
                    <span className="pc-place-meta">
                      <span className="pc-place-name">{placeLabel(place.id)}</span>
                      <span className="pc-place-path">{place.path}</span>
                    </span>
                  </button>
                ))}
          </div>
        </section>

        <section className="pc-section" aria-label={t('pcDrivesTitle')}>
          <div className="pc-section-head">
            <h2 className="pc-section-title">{t('pcDrivesTitle')}</h2>
          </div>
          <div className="pc-drives-grid" data-testid="pc-drives-grid">
            {showSkeleton
              ? Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="pc-drive-card is-skeleton" aria-hidden="true">
                    <div className="pc-drive-top">
                      <span className="pc-skeleton-box pc-skeleton-icon-lg" />
                      <div className="pc-drive-info">
                        <span className="pc-skeleton-box pc-skeleton-line-md" />
                        <span className="pc-skeleton-box pc-skeleton-line-sm" />
                      </div>
                    </div>
                    <span className="pc-skeleton-box pc-skeleton-bar" />
                  </div>
                ))
              : (snapshot?.drives ?? []).map((drive) => {
                  const ratio = clampRatio(drive)
                  const tone = driveBarTone(ratio)
                  const hasCapacity = drive.accessible && drive.totalBytes > 0
                  const usedPct = Math.round(ratio * 100)
                  return (
                    <button
                      key={drive.id}
                      type="button"
                      className={`pc-drive-card${drive.accessible ? '' : ' is-disabled'}`}
                      data-testid={`pc-drive-${drive.id}`}
                      disabled={!drive.accessible}
                      aria-disabled={!drive.accessible}
                      title={drive.path}
                      onClick={() => {
                        if (drive.accessible) navigateTo(drive.path)
                      }}
                      onContextMenu={(event) => {
                        if (drive.accessible)
                          openContextMenuAtPointer(event, { kind: 'drive', drive })
                      }}
                    >
                      <div className="pc-drive-top">
                        <span
                          className={`pc-drive-icon kind-${drive.isSystem ? 'system' : drive.kind}`}
                        >
                          <DriveIcon kind={drive.kind} isSystem={drive.isSystem} />
                        </span>
                        <div className="pc-drive-info">
                          <div className="pc-drive-title-row">
                            <span className="pc-drive-name">{driveDisplayTitle(drive)}</span>
                            <span className="pc-drive-kind-pill">{driveKindLabel(drive)}</span>
                          </div>
                          <span className="pc-drive-path">{drive.path}</span>
                        </div>
                      </div>

                      <div className="pc-drive-capacity">
                        {hasCapacity ? (
                          <>
                            <div className="pc-drive-bar-track" aria-hidden="true">
                              <div
                                className={`pc-drive-bar-fill is-${tone}`}
                                style={{ width: `${usedPct}%` }}
                              />
                            </div>
                            <div className="pc-drive-stats">
                              <span>
                                {t('pcDriveFreeOf', {
                                  free: formatBytes(drive.freeBytes),
                                  total: formatBytes(drive.totalBytes),
                                })}
                              </span>
                              <span className="pc-drive-pct">{usedPct}%</span>
                            </div>
                          </>
                        ) : (
                          <div className="pc-drive-unavailable">
                            {drive.accessible ? drive.path : t('pcDriveUnavailable')}
                          </div>
                        )}
                      </div>
                    </button>
                  )
                })}
          </div>
        </section>
      </div>
    )
  }

  const renderBrowser = (dir: string) => {
    const showDirSkeleton =
      (dirLoading && activeListing === null && !isRecursiveActive) ||
      (isRecursiveActive && searchLoading && activeSearchResult === null && !isRegexError)
    const listingError = activeListing?.error
    const totalShown = activeListing ? activeListing.folders.length + activeListing.files.length : 0
    const searchMatchCount = filteredFolders.length + filteredFiles.length
    const showSearchStatusBar =
      isRecursiveActive && !isRegexError && (searchLoading || activeSearchResult !== null)

    return (
      <div className="pc-container">
        <div className="pc-browser-chrome">
          <div className="pc-nav-row">
            <div className="pc-nav-controls">
              {!embeddedInWindow && (
                <button
                  type="button"
                  className="pc-back-btn is-compact"
                  data-testid="pc-back-desktop-btn"
                  title={t('pcBackToDesktop')}
                  aria-label={t('pcBackToDesktop')}
                  onClick={onBackToDesktop}
                >
                  <BackArrowIcon />
                  <span>{t('pcBackToDesktop')}</span>
                </button>
              )}
              <button
                type="button"
                className="pc-up-btn"
                data-testid="pc-up-btn"
                onClick={handleGoUp}
              >
                <UpArrowIcon />
              </button>
            </div>

            <nav className="pc-breadcrumbs" data-testid="pc-breadcrumbs" aria-label={t('pcTitle')}>
              <button type="button" className="pc-crumb is-root" onClick={() => navigateTo(null)}>
                <MiniComputerGlyph size={14} />
                <span>{t('pcTitle')}</span>
              </button>
              {breadcrumbs.map((crumb, index) => {
                const isLast = index === breadcrumbs.length - 1
                return (
                  <span key={crumb.path} className="pc-crumb-wrap">
                    <span className="pc-crumb-sep" aria-hidden="true">
                      /
                    </span>
                    <button
                      type="button"
                      className={`pc-crumb${isLast ? ' is-current' : ''}`}
                      aria-current={isLast ? 'location' : undefined}
                      onClick={() => {
                        if (!isLast) navigateTo(crumb.path)
                      }}
                    >
                      {crumb.label}
                    </button>
                  </span>
                )
              })}
            </nav>

            <div className="pc-nav-actions">
              {canAddCurrentDir && (
                <button
                  type="button"
                  className="pc-action-btn is-accent"
                  data-testid="pc-add-workspace-btn"
                  onClick={() => void handleAddToWorkspace(dir)}
                >
                  <AddWorkspaceGlyph />
                  <span>{t('pcAddToWorkspace')}</span>
                </button>
              )}
              {onOpenTerminalAtPath && (
                <button
                  type="button"
                  className="pc-action-btn"
                  data-testid="pc-toolbar-terminal-btn"
                  onClick={() => onOpenTerminalAtPath(dir)}
                >
                  <TerminalGlyph />
                  <span>{t('openInTerminal')}</span>
                </button>
              )}
              {onNewWindow && (
                <button
                  type="button"
                  className="pc-action-btn"
                  data-testid="pc-new-window-btn"
                  onClick={() => onNewWindow(dir)}
                >
                  <NewWindowGlyph />
                  <span>{t('pcNewWindow')}</span>
                </button>
              )}
              <button
                type="button"
                className={`pc-refresh-btn is-icon-only${dirLoading || searchLoading ? ' is-spinning' : ''}`}
                data-testid="pc-refresh-btn"
                disabled={dirLoading || searchLoading}
                aria-label={t('pcRefresh')}
                title={t('pcRefresh')}
                onClick={() => {
                  if (isRecursiveActive) {
                    void runRecursiveSearch(dir, trimmedQuery, useRegex, showAllFiles)
                  } else {
                    void loadDir(dir, showAllFiles)
                  }
                }}
              >
                <RefreshIcon />
              </button>
            </div>
          </div>

          <div className="pc-toolbar-row">
            <div className="pc-filter-pills" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={!showAllFiles}
                className={`pc-filter-pill${!showAllFiles ? ' active' : ''}`}
                data-testid="pc-filter-supported"
                onClick={() => setShowAllFiles(false)}
              >
                {t('pcFilterSupported')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={showAllFiles}
                className={`pc-filter-pill${showAllFiles ? ' active' : ''}`}
                data-testid="pc-filter-all"
                onClick={() => setShowAllFiles(true)}
              >
                {t('pcFilterAll')}
              </button>
            </div>

            <div className={`pc-search-box${isRegexError ? ' is-invalid' : ''}`}>
              <SearchGlyph />
              <input
                type="text"
                value={searchQuery}
                data-testid="pc-search-input"
                placeholder={t('pcSearchPlaceholder')}
                aria-label={t('pcSearchPlaceholder')}
                aria-invalid={isRegexError || undefined}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && isRecursiveActive && !isRegexError) {
                    event.preventDefault()
                    void runRecursiveSearch(dir, trimmedQuery, useRegex, showAllFiles)
                  } else if (event.key === 'Escape' && searchQuery) {
                    event.preventDefault()
                    cancelActiveSearch()
                    setSearchQuery('')
                    setSearchResult(null)
                  }
                }}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="pc-search-clear"
                  aria-label="Clear"
                  onClick={() => {
                    cancelActiveSearch()
                    setSearchQuery('')
                    setSearchResult(null)
                  }}
                >
                  ×
                </button>
              )}
              <button
                type="button"
                className={`pc-search-flag${useRegex ? ' is-active' : ''}`}
                data-testid="pc-regex-toggle"
                aria-pressed={useRegex}
                title={t('pcSearchRegex')}
                onClick={() => setUseRegex((prev) => !prev)}
              >
                .*
              </button>
              <button
                type="button"
                className={`pc-search-flag is-scope${recursiveSearch ? ' is-active' : ''}`}
                data-testid="pc-recursive-toggle"
                aria-pressed={recursiveSearch}
                title={t('pcSearchRecursive')}
                onClick={() => setRecursiveSearch((prev) => !prev)}
              >
                {t('pcSearchRecursive')}
              </button>
            </div>

            <button
              type="button"
              className={`pc-preview-toggle-btn${previewPaneOpen ? ' is-active' : ''}`}
              data-testid="pc-preview-pane-toggle"
              aria-pressed={previewPaneOpen}
              onClick={() => setPreviewPaneOpen((prev) => !prev)}
            >
              <PreviewPaneGlyph />
              <span>{t('pcTogglePreviewPane')}</span>
            </button>

            <span className="pc-readonly-badge is-subtle">
              <ReadOnlyShieldIcon />
              <span>{t('pcReadOnlyNotice')}</span>
            </span>
          </div>
        </div>

        {isRegexError && (
          <div className="pc-search-error" data-testid="pc-search-error" role="alert">
            {t('pcSearchInvalidRegex')}
          </div>
        )}

        {showSearchStatusBar && (
          <div className="pc-search-status" data-testid="pc-search-status" role="status">
            {searchLoading ? (
              <>
                <span className="pc-search-spinner" aria-hidden="true" />
                <span>{t('pcSearching')}</span>
                <button
                  type="button"
                  className="pc-search-stop-btn"
                  data-testid="pc-search-stop-btn"
                  onClick={cancelActiveSearch}
                >
                  {t('pcSearchStop')}
                </button>
              </>
            ) : activeSearchResult ? (
              <>
                <span>
                  {t('pcSearchSummary', {
                    count: String(searchMatchCount),
                    dirs: String(activeSearchResult.scannedDirs),
                  })}
                </span>
                {activeSearchResult.timedOut ? (
                  <span className="pc-search-warn-note">
                    {t('pcSearchTimedOut', { count: String(searchMatchCount) })}
                  </span>
                ) : activeSearchResult.truncated ? (
                  <span className="pc-search-warn-note">
                    {t('pcSearchTruncated', { shown: String(searchMatchCount) })}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        )}

        {!isRecursiveActive && activeListing?.truncated && (
          <div className="pc-truncated-banner" role="status">
            {t('pcTruncatedTip', {
              shown: String(totalShown),
              totalCount: String(activeListing.totalCount),
            })}
          </div>
        )}

        <div className={`pc-browser-split${previewPaneOpen ? ' has-preview' : ''}`}>
          <div className="pc-dir-body" data-testid="pc-dir-list">
            {showDirSkeleton ? (
              <div className="pc-table">
                <div className="pc-table-head">
                  <span className="pc-col-name">{t('colName')}</span>
                  <span className="pc-col-ext" aria-hidden="true" />
                  <span className="pc-col-modified">{t('colModified')}</span>
                  <span className="pc-col-size">{t('colSize')}</span>
                  <span aria-hidden="true" />
                </div>
                <div className="pc-skeleton-rows" aria-hidden="true">
                  {Array.from({ length: 6 }, (_, idx) => (
                    <div key={idx} className="pc-skeleton-row">
                      <span className="pc-skeleton-box pc-skeleton-dot" />
                      <span className="pc-skeleton-box pc-skeleton-line-lg" />
                      <span className="pc-skeleton-box pc-skeleton-line-xs" />
                      <span className="pc-skeleton-box pc-skeleton-line-sm" />
                    </div>
                  ))}
                </div>
              </div>
            ) : !isRecursiveActive && listingError ? (
              <div className="pc-state-card is-error" role="alert">
                <div className="pc-state-icon">
                  <ReadOnlyShieldIcon />
                </div>
                <p className="pc-state-title">{t('pcAccessDenied')}</p>
                <p className="pc-state-path">{dir}</p>
                <div className="pc-state-actions">
                  <button type="button" className="btn btn-secondary" onClick={handleGoUp}>
                    <UpArrowIcon />
                    <span>
                      {(activeListing?.parentDir ?? fallbackParentDir(dir)) || t('pcTitle')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => handleRevealPath(dir)}
                  >
                    <span>{t('revealInFolder')}</span>
                  </button>
                </div>
              </div>
            ) : isRegexError ? null : filteredFolders.length === 0 && filteredFiles.length === 0 ? (
              <div className="pc-state-card">
                <div className="pc-state-icon">
                  <FolderGlyphIcon />
                </div>
                <p className="pc-state-title">{t('pcEmptyDir')}</p>
                {!showAllFiles && (
                  <div className="pc-state-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setShowAllFiles(true)}
                    >
                      {t('pcFilterAll')}
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className={`pc-table${dirLoading || searchLoading ? ' is-refreshing' : ''}`}>
                <div className="pc-table-head">
                  <span className="pc-col-name">{t('colName')}</span>
                  <span className="pc-col-ext" aria-hidden="true" />
                  <span className="pc-col-modified">{t('colModified')}</span>
                  <span className="pc-col-size">{t('colSize')}</span>
                  <span aria-hidden="true" />
                </div>
                <ul className="pc-entry-list">
                  {filteredFolders.map((entry) => {
                    const isSelected = selectedPath === entry.path
                    return (
                      <li
                        key={entry.path}
                        className={`pc-entry-li${isSelected ? ' is-selected' : ''}`}
                      >
                        <div
                          className="pc-entry-row is-folder"
                          data-testid="pc-folder-row"
                          role="button"
                          tabIndex={0}
                          onClick={() => navigateTo(entry.path)}
                          onDoubleClick={() => navigateTo(entry.path)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && event.target === event.currentTarget) {
                              navigateTo(entry.path)
                            }
                          }}
                          onContextMenu={(event) => {
                            setSelectedPath(entry.path)
                            openContextMenuAtPointer(event, { kind: 'entry', entry })
                          }}
                        >
                          <span className="pc-entry-icon is-folder">
                            <FolderGlyphIcon />
                          </span>
                          <span className="pc-entry-name-col">
                            <span className="pc-entry-name" title={entry.name}>
                              {entry.name}
                            </span>
                            {entry.relativeDir && (
                              <span className="pc-entry-subpath" title={entry.path}>
                                {entry.relativeDir}
                              </span>
                            )}
                          </span>
                          <span className="pc-entry-type">{t('folderType')}</span>
                          <span className="pc-entry-time">
                            {entry.mtimeMs > 0 ? formatModified(entry.mtimeMs, i18n) : '—'}
                          </span>
                          <span className="pc-entry-size">—</span>
                          <button
                            type="button"
                            className="pc-row-more-btn"
                            aria-label={entry.name}
                            onClick={(event) => {
                              setSelectedPath(entry.path)
                              openContextMenuAtButton(event, { kind: 'entry', entry })
                            }}
                          >
                            <MoreDotsIcon />
                          </button>
                        </div>
                      </li>
                    )
                  })}

                  {filteredFiles.map((entry) => {
                    const isSelected = selectedPath === entry.path
                    return (
                      <li
                        key={entry.path}
                        className={`pc-entry-li${isSelected ? ' is-selected' : ''}`}
                      >
                        <div
                          className="pc-entry-row is-file"
                          data-testid="pc-file-row"
                          role="button"
                          tabIndex={0}
                          onClick={() => setSelectedPath(entry.path)}
                          onDoubleClick={() => openEntryFile(entry)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && event.target === event.currentTarget) {
                              openEntryFile(entry)
                            }
                          }}
                          onContextMenu={(event) => {
                            setSelectedPath(entry.path)
                            openContextMenuAtPointer(event, { kind: 'entry', entry })
                          }}
                        >
                          <span className="pc-entry-icon">
                            <FileBadge ext={entry.ext} size={22} />
                          </span>
                          <span className="pc-entry-name-col">
                            <span className="pc-entry-name" title={entry.name}>
                              {entry.name}
                            </span>
                            {entry.relativeDir && (
                              <span className="pc-entry-subpath" title={entry.path}>
                                {entry.relativeDir}
                              </span>
                            )}
                          </span>
                          <span className="pc-entry-type">
                            {entry.ext ? (
                              <span
                                className={`pc-ext-pill${entry.supported ? ' is-supported' : ''}`}
                              >
                                {entry.ext.toUpperCase()}
                              </span>
                            ) : (
                              '—'
                            )}
                          </span>
                          <span className="pc-entry-time">
                            {entry.mtimeMs > 0 ? formatModified(entry.mtimeMs, i18n) : '—'}
                          </span>
                          <span className="pc-entry-size">{formatBytes(entry.size)}</span>
                          <button
                            type="button"
                            className="pc-row-more-btn"
                            aria-label={entry.name}
                            onClick={(event) => {
                              setSelectedPath(entry.path)
                              openContextMenuAtButton(event, { kind: 'entry', entry })
                            }}
                          >
                            <MoreDotsIcon />
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
          {previewPaneOpen && (
            <aside
              className="pc-preview-dock"
              data-testid="pc-preview-dock"
              aria-label={t('pcTogglePreviewPane')}
            >
              <FilePreviewPane
                filePath={selectedFileEntry?.path ?? null}
                variant="inline"
                onOpenInEditor={(path) => void api.openPath?.(path)}
                onOpenInMediaPlayer={onOpenMediaInPlayer}
                onOpenSystemDefault={(path) => void api.desktopOpenExternal?.(path)}
                onPopOutWindow={onPreviewFile}
                onClose={() => setPreviewPaneOpen(false)}
              />
            </aside>
          )}
        </div>
      </div>
    )
  }

  return (
    <main
      className={`pc-view${embeddedInWindow ? ' is-windowed' : ''}`}
      aria-label={t('pcTitle')}
      onKeyDown={handleRootKeyDown}
    >
      {currentDir === null ? renderOverview() : renderBrowser(currentDir)}
      {renderContextMenu()}
      {toast !== null && (
        <div className="pc-toast" role="status" aria-live="polite">
          {toast}
        </div>
      )}
    </main>
  )
}
