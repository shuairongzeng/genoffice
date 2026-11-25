import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { naturalCompareMediaName, normalizeMediaPathKey } from '../media-library'

const DEFAULT_PLAYABLE_MEDIA_EXTS = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wma',
  'mp4',
  'webm',
  'mov',
  'm4v',
  'mkv',
])

const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.venv'])
const LEADING_TRACK_INDEX_RE = /^\s*\d+\s*[.\-_、)\]]+\s*/
const TRACK_WRAPPER_PUNCT_RE = /[《》〈〉「」『』（）()[\]【】"'“”‘’`]/g
const TRACK_SEPARATOR_RE = /[\s.\-_—–/|\\,，、:：;；!！?？~～·]+/g
const QUERY_FILLER_PREFIX_RE =
  /^(?:(?:帮我|请帮我|麻烦|给我|请|我想听|我要听|想听|要听|打开一下|打开|播放一下|播放|听一首|听一下|放一首|来一首|放一下|放个|放一曲|play|open|listen\s+to)\s*)+/i
const QUERY_FILLER_SUFFIX_RE = /(?:\s*(?:这首歌|那首歌|一首歌|的歌|吧|呀|啦|啊|哦|呢))+$/

export interface ButlerMediaTrackCandidate {
  readonly path: string
  readonly title: string
  readonly folder: string
}

export interface ButlerMediaSearchResult {
  readonly bestMatch: ButlerMediaTrackCandidate | null
  readonly matches: readonly ButlerMediaTrackCandidate[]
  readonly totalScanned: number
}

export interface CollectPlayableMediaFilesOptions {
  readonly folders?: readonly string[]
  readonly pinnedFiles?: readonly string[]
  readonly lastFilePath?: string | null
  readonly isSupportedExt?: (ext: string) => boolean
  readonly maxDepth?: number
  readonly maxFiles?: number
}

function isSupportedMediaFile(
  filePath: string,
  isSupportedExt?: (ext: string) => boolean,
): boolean {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!ext) return false
  return isSupportedExt ? isSupportedExt(ext) : DEFAULT_PLAYABLE_MEDIA_EXTS.has(ext)
}

function buildTrackCandidate(rawPath: string, folderHint?: string): ButlerMediaTrackCandidate {
  const fullPath = resolve(rawPath)
  const fileName = basename(fullPath)
  const ext = extname(fileName)
  const title = ext ? fileName.slice(0, -ext.length) : fileName
  return {
    path: fullPath,
    title,
    folder: folderHint ? resolve(folderHint) : resolve(fullPath, '..'),
  }
}

/**
 * Scan configured media folders, pinned files, and last played file for playable media tracks.
 */
export function collectPlayableMediaFiles(
  opts: CollectPlayableMediaFilesOptions,
): readonly ButlerMediaTrackCandidate[] {
  const maxDepth = Math.max(0, opts.maxDepth ?? 3)
  const maxFiles = Math.max(1, opts.maxFiles ?? 2000)
  const seen = new Set<string>()
  const collected: ButlerMediaTrackCandidate[] = []

  const pushCandidate = (filePath: string, folderHint?: string): void => {
    if (collected.length >= maxFiles) return
    if (!isSupportedMediaFile(filePath, opts.isSupportedExt)) return
    const key = normalizeMediaPathKey(filePath)
    if (seen.has(key)) return
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) return
    } catch {
      return
    }
    seen.add(key)
    collected.push(buildTrackCandidate(filePath, folderHint))
  }

  const walkDir = (dirPath: string, rootFolder: string, depth: number): void => {
    if (collected.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }
    const sorted = [...entries].sort((a, b) => naturalCompareMediaName(a.name, b.name))
    for (const entry of sorted) {
      if (collected.length >= maxFiles) break
      if (entry.name.startsWith('.')) continue
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_SCAN_DIRS.has(entry.name) && depth < maxDepth) {
          walkDir(fullPath, rootFolder, depth + 1)
        }
        continue
      }
      if (entry.isFile()) {
        pushCandidate(fullPath, rootFolder)
      }
    }
  }

  for (const folder of opts.folders ?? []) {
    const trimmed = folder.trim()
    if (!trimmed) continue
    const resolvedFolder = resolve(trimmed)
    if (!existsSync(resolvedFolder)) continue
    walkDir(resolvedFolder, resolvedFolder, 0)
  }

  for (const pinned of opts.pinnedFiles ?? []) {
    const trimmed = pinned.trim()
    if (trimmed) pushCandidate(trimmed)
  }

  if (opts.lastFilePath && opts.lastFilePath.trim()) {
    pushCandidate(opts.lastFilePath.trim())
  }

  collected.sort((a, b) => naturalCompareMediaName(a.title, b.title))
  return collected
}

/**
 * Normalize song titles and spoken queries by stripping book-title marks, punctuation, and extra spaces.
 */
export function normalizeTrackSearchText(raw: string): string {
  const withoutWrappers = raw.toLowerCase().replace(TRACK_WRAPPER_PUNCT_RE, ' ')
  const collapsed = withoutWrappers.replace(TRACK_SEPARATOR_RE, ' ').trim()
  const stripped = collapsed.replace(QUERY_FILLER_PREFIX_RE, '').trim() || collapsed
  const withoutSuffix = stripped.replace(QUERY_FILLER_SUFFIX_RE, '').trim()
  return withoutSuffix.length >= 2 ? withoutSuffix : stripped
}

function compactSearchText(normalized: string): string {
  return normalized.replace(/\s+/g, '')
}

function scoreTrackCandidate(
  track: ButlerMediaTrackCandidate,
  normQuery: string,
  compactQuery: string,
  queryTokens: readonly string[],
): number {
  const normTitle = normalizeTrackSearchText(track.title)
  const titleWithoutIndex = normTitle.replace(LEADING_TRACK_INDEX_RE, '').trim()
  const compactTitle = compactSearchText(normTitle)
  const compactNoIndex = compactSearchText(titleWithoutIndex)
  const compactPath = compactSearchText(normalizeTrackSearchText(track.path))

  if (normTitle === normQuery || titleWithoutIndex === normQuery) {
    return 1000
  }
  if (compactTitle === compactQuery || compactNoIndex === compactQuery) {
    return 950
  }

  const segments = titleWithoutIndex
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (segments.some((seg) => seg === normQuery || seg === compactQuery)) {
    return 820
  }

  let score = 0
  if (compactTitle.includes(compactQuery) || compactNoIndex.includes(compactQuery)) {
    const lengthRatio = Math.min(1, compactQuery.length / Math.max(1, compactNoIndex.length))
    score = Math.max(score, 550 + Math.round(lengthRatio * 150))
  } else if (compactPath.includes(compactQuery)) {
    score = Math.max(score, 420)
  }

  if (queryTokens.length > 0) {
    let matchedWeight = 0
    let totalWeight = 0
    let matchedCount = 0
    for (const token of queryTokens) {
      const compactToken = compactSearchText(token)
      if (!compactToken) continue
      const weight = compactToken.length
      totalWeight += weight
      if (compactTitle.includes(compactToken) || compactNoIndex.includes(compactToken)) {
        matchedWeight += weight
        matchedCount += 1
      } else if (compactPath.includes(compactToken)) {
        matchedWeight += weight * 0.65
        matchedCount += 1
      }
    }
    if (totalWeight > 0 && matchedCount > 0) {
      const coverage = matchedWeight / totalWeight
      if (matchedCount === queryTokens.length) {
        const brevityBonus = Math.round(
          (matchedWeight / Math.max(1, compactNoIndex.length)) * 80,
        )
        score = Math.max(score, 620 + brevityBonus)
      } else if (coverage >= 0.55) {
        score = Math.max(score, 260 + Math.round(coverage * 180))
      }
    }

    // Handle spoken possessive phrasing ("artist + de + song") while preserving literal titles.
    if (queryTokens.some((token) => token.includes('的'))) {
      const possessiveParts = queryTokens.flatMap((token) => {
        if (!token.includes('的')) {
          const compact = compactSearchText(token)
          return compact ? [compact] : []
        }
        const split = token
          .split('的')
          .map((part) => compactSearchText(part))
          .filter((part) => part.length >= 2)
        return split.length >= 2 ? split : [compactSearchText(token)]
      })
      if (
        possessiveParts.length >= 2 &&
        possessiveParts.every(
          (part) => compactTitle.includes(part) || compactNoIndex.includes(part),
        )
      ) {
        const matchedChars = possessiveParts.reduce((acc, part) => acc + part.length, 0)
        const brevityBonus = Math.round(
          (matchedChars / Math.max(1, compactNoIndex.length)) * 80,
        )
        score = Math.max(score, 610 + brevityBonus)
      }
    }
  }

  return score
}

/**
 * Search scanned local media tracks for a spoken song or artist query.
 */
export function searchLocalMediaTracks(
  tracks: readonly ButlerMediaTrackCandidate[],
  rawQuery: string,
  limit = 8,
): ButlerMediaSearchResult {
  const normQuery = normalizeTrackSearchText(rawQuery)
  const compactQuery = compactSearchText(normQuery)
  if (!compactQuery) {
    return { bestMatch: null, matches: [], totalScanned: tracks.length }
  }

  const queryTokens = normQuery
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  const scored: Array<{ track: ButlerMediaTrackCandidate; score: number }> = []
  for (const track of tracks) {
    const score = scoreTrackCandidate(track, normQuery, compactQuery, queryTokens)
    if (score > 0) {
      scored.push({ track, score })
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return naturalCompareMediaName(a.track.title, b.track.title)
  })

  const matches = scored.slice(0, Math.max(1, limit)).map((item) => item.track)
  return {
    bestMatch: matches[0] ?? null,
    matches,
    totalScanned: tracks.length,
  }
}

/**
 * Return a bounded sample list of track titles for conversational library inspection.
 */
export function listSampleMediaTracks(
  tracks: readonly ButlerMediaTrackCandidate[],
  limit = 15,
): readonly ButlerMediaTrackCandidate[] {
  return tracks.slice(0, Math.max(1, limit))
}
