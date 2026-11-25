#!/usr/bin/env node
/**
 * Dual-track upstream drift monitor for GenOffice fork governance:
 *   Track 1 (Core Conflict Guard): runs `git merge-tree --write-tree` and
 *     checks conflicted paths against the 15 synced engine/converter/shared
 *     packages. Exits 1 if any protected package has a merge conflict.
 *   Track 2 (Filtered Non-Core Drift Digest): summarizes commits and differing
 *     files in `<base>..<upstream>` outside permanently skipped Desktop OS /
 *     fork-only paths and excluded `tr`/`hu` locales.
 *
 * Pure Node.js ESM with zero external dependencies.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const GIT_MAX_BUFFER = 64 * 1024 * 1024
const DEFAULT_MAX_COMMITS = 15

export const TRACK1_PROTECTED_PACKAGES = [
  'compound-file',
  'doc2docx',
  'docx-engine',
  'file-parse',
  'html2docx',
  'hwp2docx',
  'odf2ooxml',
  'pdf2docx',
  'pipelines',
  'ppt2pptx',
  'pptx-engine',
  'pptx-ops',
  'pptx-render',
  'xlsx-gateway',
  'zip-gate',
]

const TRACK1_PREFIXES = TRACK1_PROTECTED_PACKAGES.map((pkg) => `packages/${pkg}/`)

const PERMANENT_SKIP_EXACT = new Set(['apps/shell/scripts/collect-pi-deps.mjs'])

const PERMANENT_SKIP_PREFIXES = [
  { prefix: 'apps/browser/', category: 'apps/browser/**' },
  { prefix: 'packages/agent-pi-bridge/', category: 'packages/agent-pi-bridge/**' },
  { prefix: 'tools/stubs/no-sharp/', category: 'tools/stubs/no-sharp/**' },
]

const DESKTOP_OS_BASENAME_RE = /(?:^|\/)(?:Home\.tsx|KbAskPanel\.tsx|tabbar\.css)$/
const LAST_SESSION_RE = /(?:^|\/)last-session(?:[.-][^/]*)?$/
const STANDALONE_TR_HU_RE = /(?:^|\/)(?:tr|hu)\.(?:ts|tsx|js|mjs|cjs|json|md)$/i
const DOTTED_TR_HU_RE = /\.(?:tr|hu)\.(?:ts|tsx|js|mjs|cjs|json|md|png)$/i
const DIR_TR_HU_RE = /(?:^|\/)(?:i18n|locales?|lang|help|docs)\/(?:.*\/)?(?:tr|hu)\//i
const MULTI_LOCALE_CANDIDATE_RE = /(?:i18n|locale|locales|strings)/i

function printUsage() {
  console.log(
    [
      'Usage: node tools/upstream-drift-check.mjs [options]',
      '',
      'Options:',
      '  --base <ref>           Base git ref (default: HEAD)',
      '  --upstream <ref>       Upstream git ref (default: upstream/main)',
      '  --summary-file <path>  Markdown summary file (default: $GITHUB_STEP_SUMMARY)',
      `  --max-commits <n>      Max commits listed in Track 2 digest (default: ${DEFAULT_MAX_COMMITS})`,
      '  -h, --help             Show this help message',
    ].join('\n'),
  )
}

function parseArgs(argv) {
  const opts = {
    base: 'HEAD',
    upstream: 'upstream/main',
    summaryFile: process.env.GITHUB_STEP_SUMMARY || '',
    maxCommits: DEFAULT_MAX_COMMITS,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      printUsage()
      process.exit(0)
    }

    const eqIdx = arg.indexOf('=')
    const flag = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg
    const nextVal = () => {
      if (eqIdx >= 0) return arg.slice(eqIdx + 1)
      if (i + 1 >= argv.length) {
        console.error(`Missing value for ${flag}`)
        process.exit(2)
      }
      i++
      return argv[i]
    }

    if (flag === '--base') {
      opts.base = nextVal()
    } else if (flag === '--upstream') {
      opts.upstream = nextVal()
    } else if (flag === '--summary-file') {
      opts.summaryFile = nextVal()
    } else if (flag === '--max-commits') {
      const raw = nextVal()
      const parsed = Number.parseInt(raw, 10)
      if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw.trim()) {
        console.error(`Invalid --max-commits value: ${raw}`)
        process.exit(2)
      }
      opts.maxCommits = parsed
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }

  if (!opts.base || !opts.upstream) {
    console.error('Both --base and --upstream must be non-empty refs.')
    process.exit(2)
  }

  return opts
}

function runGit(args, { allowedExitCodes = [0] } = {}) {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
  })
  if (result.error) {
    console.error(`Failed to execute git ${args[0]}: ${result.error.message}`)
    process.exit(2)
  }
  const allowed = new Set(allowedExitCodes)
  if (!allowed.has(result.status)) {
    const detail = (result.stderr || result.stdout || '').trim()
    console.error(
      `git ${args.join(' ')} exited with ${result.status}${detail ? `:\n${detail}` : ''}`,
    )
    process.exit(2)
  }
  return result
}

function resolveCommit(ref) {
  const res = runGit(['rev-parse', '--verify', `${ref}^{commit}`])
  return res.stdout.trim()
}

export function isTrack1Protected(filePath) {
  return TRACK1_PREFIXES.some((prefix) => filePath.startsWith(prefix))
}

export function classifyPermanentSkipPath(filePath) {
  if (PERMANENT_SKIP_EXACT.has(filePath)) return filePath
  for (const { prefix, category } of PERMANENT_SKIP_PREFIXES) {
    if (filePath.startsWith(prefix)) return category
  }
  if (DESKTOP_OS_BASENAME_RE.test(filePath) || LAST_SESSION_RE.test(filePath)) {
    return 'Desktop OS (Home/KbAsk/tabbar/last-session)'
  }
  if (
    STANDALONE_TR_HU_RE.test(filePath) ||
    DOTTED_TR_HU_RE.test(filePath) ||
    DIR_TR_HU_RE.test(filePath)
  ) {
    return 'Excluded locales (tr/hu)'
  }
  return null
}

function updateBraceDepth(line, depth) {
  const withoutStrings = line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '')
  let next = depth
  for (const ch of withoutStrings) {
    if (ch === '{' || ch === '[') next++
    else if (ch === '}' || ch === ']') next--
  }
  return next
}

/**
 * Checks whether every changed line in a multi-locale file's `git diff -U0`
 * belongs strictly to `tr` or `hu` locale keys/blocks.
 */
function isPureTrHuDiff(diffText) {
  let sawChange = false
  let blockDepth = 0
  let inTrHuBlock = false

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      blockDepth = 0
      inTrHuBlock = false
      continue
    }
    if (
      (!line.startsWith('+') && !line.startsWith('-')) ||
      line.startsWith('+++') ||
      line.startsWith('---')
    ) {
      continue
    }

    const body = line.slice(1).trim()
    if (!body) continue
    sawChange = true

    if (inTrHuBlock) {
      blockDepth = updateBraceDepth(body, blockDepth)
      if (blockDepth <= 0) {
        blockDepth = 0
        inTrHuBlock = false
      }
      continue
    }

    const singleLineMatch =
      /^(?:\|\s*)?['"]?(?:tr|hu)(?:-[A-Z]{2})?['"]?(?:\s*[:,]|\s*$)/.test(body) ||
      /^(?:export\s+)?(?:const\s+)?ribbonCommon(?:Tr|Hu)\b/.test(body)
    if (singleLineMatch) {
      const nextDepth = updateBraceDepth(body, 0)
      if (nextDepth > 0) {
        blockDepth = nextDepth
        inTrHuBlock = true
      }
      continue
    }

    return false
  }

  return sawChange && !inTrHuBlock
}

function detectPureTrHuFiles(base, upstream, candidatePaths) {
  const pureFiles = new Set()
  if (candidatePaths.length === 0) return pureFiles

  const chunkSize = 80
  for (let i = 0; i < candidatePaths.length; i += chunkSize) {
    const chunk = candidatePaths.slice(i, i + chunkSize)
    const out = runGit([
      'diff',
      '-U0',
      '--no-renames',
      `${base}..${upstream}`,
      '--',
      ...chunk,
    ]).stdout

    let currentFile = null
    let currentLines = []
    const flush = () => {
      if (currentFile && isPureTrHuDiff(currentLines.join('\n'))) {
        pureFiles.add(currentFile)
      }
    }

    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('diff --git ')) {
        flush()
        currentFile = null
        currentLines = []
      } else if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6)
      } else if (line.startsWith('--- a/') && !currentFile) {
        currentFile = line.slice(6)
      } else if (currentFile !== null) {
        currentLines.push(line)
      }
    }
    flush()
  }

  return pureFiles
}

function runTrack1(base, upstream) {
  const res = runGit(['merge-tree', '--write-tree', base, upstream], {
    allowedExitCodes: [0, 1],
  })

  if (res.status === 0) {
    return {
      totalRepoConflicts: 0,
      protectedConflicts: [],
    }
  }

  const conflictedSet = new Set()
  for (const line of res.stdout.split(/\r?\n/)) {
    const match = /^[0-9]{6} [0-9a-f]{40,} [0-9]\t(.+)$/.exec(line)
    if (match) {
      conflictedSet.add(match[1])
    }
  }

  if (conflictedSet.size === 0) {
    console.error('git merge-tree exited 1 but no conflicted stage entries were parsed.')
    process.exit(2)
  }

  const allConflicts = [...conflictedSet].sort()
  const protectedConflicts = allConflicts.filter(isTrack1Protected)

  return {
    totalRepoConflicts: allConflicts.length,
    protectedConflicts,
  }
}

function areaKeyFor(filePath) {
  const parts = filePath.split('/')
  if (parts.length === 1) return '(root)'
  if (parts[0] === 'apps' || parts[0] === 'packages') {
    return `${parts[0]}/${parts[1]}`
  }
  return parts[0]
}

function runTrack2(base, upstream, maxCommits) {
  const diffOut = runGit(['diff', '--name-status', '--no-renames', `${base}..${upstream}`]).stdout
  const diffEntries = []
  for (const line of diffOut.split(/\r?\n/)) {
    if (!line.trim()) continue
    const tabIdx = line.indexOf('\t')
    if (tabIdx < 0) continue
    const status = line.slice(0, tabIdx).trim()
    const filePath = line.slice(tabIdx + 1).trim()
    if (filePath) diffEntries.push({ status, filePath })
  }

  const candidateMultiLocale = diffEntries
    .map((e) => e.filePath)
    .filter(
      (p) =>
        !isTrack1Protected(p) &&
        classifyPermanentSkipPath(p) === null &&
        MULTI_LOCALE_CANDIDATE_RE.test(p),
    )
  const pureTrHuFiles = detectPureTrHuFiles(base, upstream, candidateMultiLocale)

  const skipCounts = new Map()
  const areaCounts = new Map()
  let track1DiffCount = 0
  let skippedFileCount = 0
  let track2FileCount = 0

  const skipReasonFor = (filePath) => {
    const pathSkip = classifyPermanentSkipPath(filePath)
    if (pathSkip) return pathSkip
    if (pureTrHuFiles.has(filePath)) return 'Excluded locales (tr/hu)'
    return null
  }

  for (const { status, filePath } of diffEntries) {
    if (isTrack1Protected(filePath)) {
      track1DiffCount++
      continue
    }
    const skipReason = skipReasonFor(filePath)
    if (skipReason) {
      skippedFileCount++
      skipCounts.set(skipReason, (skipCounts.get(skipReason) ?? 0) + 1)
      continue
    }
    track2FileCount++
    const area = areaKeyFor(filePath)
    const entry = areaCounts.get(area) ?? { area, total: 0, added: 0, modified: 0, deleted: 0 }
    entry.total++
    if (status.startsWith('A')) entry.added++
    else if (status.startsWith('D')) entry.deleted++
    else entry.modified++
    areaCounts.set(area, entry)
  }

  const sortedAreas = [...areaCounts.values()].sort(
    (a, b) => b.total - a.total || a.area.localeCompare(b.area),
  )
  const sortedSkips = [...skipCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )

  const logOut = runGit([
    'log',
    '--format=%H%x09%ad%x09%s',
    '--date=short',
    '--name-only',
    `${base}..${upstream}`,
  ]).stdout

  const commits = []
  let current = null
  for (const line of logOut.split(/\r?\n/)) {
    if (/^[0-9a-f]{40,}\t/.test(line)) {
      if (current) commits.push(current)
      const [sha, date, ...subjectParts] = line.split('\t')
      current = {
        sha,
        date,
        subject: subjectParts.join('\t'),
        files: [],
      }
    } else if (current && line.trim()) {
      current.files.push(line.trim())
    }
  }
  if (current) commits.push(current)

  let skipOnlyCommits = 0
  const relevantCommits = []
  for (const commit of commits) {
    const nonSkipped = commit.files.filter((f) => skipReasonFor(f) === null)
    if (commit.files.length > 0 && nonSkipped.length === 0) {
      skipOnlyCommits++
      continue
    }
    relevantCommits.push({
      ...commit,
      nonSkippedCount: nonSkipped.length,
      totalCount: commit.files.length,
    })
  }

  return {
    totalDiffFiles: diffEntries.length,
    track1DiffCount,
    skippedFileCount,
    track2FileCount,
    sortedSkips,
    sortedAreas,
    totalCommits: commits.length,
    skipOnlyCommits,
    relevantCommitCount: relevantCommits.length,
    recentCommits: relevantCommits.slice(0, maxCommits),
  }
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function formatMarkdown({
  baseRef,
  upstreamRef,
  baseSha,
  upstreamSha,
  track1,
  track2,
  maxCommits,
}) {
  const lines = [
    '## Upstream Drift Governance Report',
    '',
    `- **Base**: \`${baseRef}\` (\`${baseSha.slice(0, 8)}\`)`,
    `- **Upstream**: \`${upstreamRef}\` (\`${upstreamSha.slice(0, 8)}\`)`,
    '',
    '### Track 1: Core Conflict Guard (15 Synced Protected Packages)',
    '',
  ]

  if (track1.protectedConflicts.length === 0) {
    lines.push(
      `- **Status**: CLEAN — \`0\` merge conflicts across all ${TRACK1_PROTECTED_PACKAGES.length} synced protected packages (repo-wide non-protected \`merge-tree\` conflicts: ${track1.totalRepoConflicts}).`,
    )
  } else {
    lines.push(
      `- **Status**: CONFLICT — \`${track1.protectedConflicts.length}\` conflicted file(s) in protected packages (repo-wide \`merge-tree\` conflicts: ${track1.totalRepoConflicts}).`,
      '',
      'Conflicted protected files:',
      '',
      ...track1.protectedConflicts.map((file) => `- \`${file}\``),
    )
  }

  lines.push(
    '',
    '### Track 2: Filtered Non-Core Drift Digest',
    '',
    `- **Commits in range (\`${baseRef}..${upstreamRef}\`)**: ${track2.relevantCommitCount} relevant (${track2.skipOnlyCommits} skip-only excluded, ${track2.totalCommits} total)`,
    `- **Changed files in diff (\`${baseRef}..${upstreamRef}\`)**: ${track2.track2FileCount} non-core files (${track2.skippedFileCount} permanently skipped, ${track2.track1DiffCount} in Track 1 protected packages, ${track2.totalDiffFiles} total)`,
  )

  if (track2.sortedSkips.length > 0) {
    lines.push('', 'Permanently skipped / excluded items:')
    for (const [category, count] of track2.sortedSkips) {
      lines.push(`- ${category}: ${count}`)
    }
  }

  if (track2.sortedAreas.length > 0) {
    lines.push(
      '',
      'Top non-core drift areas:',
      '',
      '| Area | Files | +Added | ~Modified | -Deleted |',
      '| --- | ---: | ---: | ---: | ---: |',
    )
    for (const row of track2.sortedAreas.slice(0, 15)) {
      lines.push(
        `| \`${row.area}\` | ${row.total} | ${row.added} | ${row.modified} | ${row.deleted} |`,
      )
    }
    if (track2.sortedAreas.length > 15) {
      lines.push(`| *(+${track2.sortedAreas.length - 15} more areas)* | | | | |`)
    }
  }

  if (track2.recentCommits.length > 0) {
    lines.push(
      '',
      `Recent relevant upstream commits (showing ${track2.recentCommits.length} of ${track2.relevantCommitCount}, limit ${maxCommits}):`,
      '',
      '| Commit | Date | Non-skipped / Total | Subject |',
      '| --- | --- | ---: | --- |',
    )
    for (const c of track2.recentCommits) {
      lines.push(
        `| \`${c.sha.slice(0, 8)}\` | ${c.date} | ${c.nonSkippedCount}/${c.totalCount} | ${escapeCell(c.subject)} |`,
      )
    }
  } else {
    lines.push('', 'No non-skipped upstream commits in range.')
  }

  return lines.join('\n')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const baseSha = resolveCommit(opts.base)
  const upstreamSha = resolveCommit(opts.upstream)

  const track1 = runTrack1(opts.base, opts.upstream)
  const track2 = runTrack2(opts.base, opts.upstream, opts.maxCommits)

  const markdown = formatMarkdown({
    baseRef: opts.base,
    upstreamRef: opts.upstream,
    baseSha,
    upstreamSha,
    track1,
    track2,
    maxCommits: opts.maxCommits,
  })

  console.log(markdown)

  if (opts.summaryFile) {
    const dir = dirname(opts.summaryFile)
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
    appendFileSync(opts.summaryFile, `${markdown}\n\n`, 'utf8')
  }

  process.exit(track1.protectedConflicts.length > 0 ? 1 : 0)
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])

if (isDirectRun) {
  main()
}
