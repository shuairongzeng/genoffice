export const MAX_SYSTEM_SEARCH_QUERY_LEN = 256

export interface SearchMatcherOptions {
  readonly query: string
  readonly regex?: boolean
  readonly caseSensitive?: boolean
}

export interface SearchMatcherHit {
  readonly ok: true
  readonly mode: 'substring' | 'glob' | 'regex'
  readonly matchPath: boolean
  readonly matches: (name: string, relativePath?: string) => boolean
}

export interface SearchMatcherError {
  readonly ok: false
  readonly error: 'invalid-regex'
  readonly message: string
}

export type CompiledSearchMatcher = SearchMatcherHit | SearchMatcherError

const LITERAL_REGEX_RE = /^\/(.+)\/([gimsuy]*)$/

function escapeRegExpChar(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeSlash(input: string): string {
  return input.replace(/\\/g, '/')
}

/**
 * Converts a wildcard glob pattern (`*`, `**`, `?`) to an anchored RegExp source string.
 */
export function globToRegExpSource(pattern: string): string {
  const normalized = normalizeSlash(pattern)
  const pathScoped = normalized.includes('/')
  let src = '^'
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        src += '.*'
        i += 1
      } else {
        src += pathScoped ? '[^/]*' : '.*'
      }
    } else if (ch === '?') {
      src += pathScoped ? '[^/]' : '.'
    } else {
      src += escapeRegExpChar(ch)
    }
  }
  src += '$'
  return src
}

function sanitizeRegExpFlags(rawFlags: string, defaultCaseInsensitive: boolean): string {
  const unique = new Set<string>()
  for (const ch of rawFlags) {
    // Strip 'g' and 'y' so repeated `.test()` calls never drift via `lastIndex`.
    if (ch === 'i' || ch === 'm' || ch === 's' || ch === 'u') {
      unique.add(ch)
    }
  }
  if (defaultCaseInsensitive) unique.add('i')
  return [...unique].join('')
}

function buildRegExpTargetSelector(matchPath: boolean): (name: string, rel?: string) => string {
  return (name: string, rel?: string) => {
    if (matchPath && typeof rel === 'string' && rel.length > 0) {
      return normalizeSlash(rel)
    }
    return name
  }
}

/**
 * Compiles user search text into a safe, stateless matcher supporting plain substrings,
 * wildcard globs (`*`, `?`), `/pattern/flags` literals, and explicit regular expressions.
 */
export function compileSystemSearchMatcher(opts: SearchMatcherOptions): CompiledSearchMatcher {
  const rawQuery = typeof opts.query === 'string' ? opts.query.trim() : ''
  const caseSensitive = opts.caseSensitive === true

  if (rawQuery.length > MAX_SYSTEM_SEARCH_QUERY_LEN) {
    return {
      ok: false,
      error: 'invalid-regex',
      message: `Search query exceeds ${MAX_SYSTEM_SEARCH_QUERY_LEN} characters`,
    }
  }

  if (!rawQuery) {
    return {
      ok: true,
      mode: 'substring',
      matchPath: false,
      matches: () => true,
    }
  }

  if (opts.regex === true) {
    const normalized = normalizeSlash(rawQuery)
    const matchPath = normalized.includes('/')
    try {
      const re = new RegExp(rawQuery, caseSensitive ? '' : 'i')
      const pick = buildRegExpTargetSelector(matchPath)
      return {
        ok: true,
        mode: 'regex',
        matchPath,
        matches: (name, relativePath) => re.test(pick(name, relativePath)),
      }
    } catch (err) {
      return {
        ok: false,
        error: 'invalid-regex',
        message: err instanceof Error ? err.message : 'Invalid regular expression',
      }
    }
  }

  const literalMatch = LITERAL_REGEX_RE.exec(rawQuery)
  if (literalMatch) {
    const [, body, rawFlags] = literalMatch
    const normalizedBody = normalizeSlash(body)
    const matchPath = normalizedBody.includes('/')
    const flags = sanitizeRegExpFlags(rawFlags, !caseSensitive && !rawFlags.includes('i'))
    try {
      const re = new RegExp(body, flags)
      const pick = buildRegExpTargetSelector(matchPath)
      return {
        ok: true,
        mode: 'regex',
        matchPath,
        matches: (name, relativePath) => re.test(pick(name, relativePath)),
      }
    } catch (err) {
      return {
        ok: false,
        error: 'invalid-regex',
        message: err instanceof Error ? err.message : 'Invalid regular expression',
      }
    }
  }

  if (rawQuery.includes('*') || rawQuery.includes('?')) {
    const matchPath = normalizeSlash(rawQuery).includes('/')
    const source = globToRegExpSource(rawQuery)
    const re = new RegExp(source, caseSensitive ? '' : 'i')
    const pick = buildRegExpTargetSelector(matchPath)
    return {
      ok: true,
      mode: 'glob',
      matchPath,
      matches: (name, relativePath) => re.test(pick(name, relativePath)),
    }
  }

  const matchPath = normalizeSlash(rawQuery).includes('/')
  const needle = caseSensitive ? normalizeSlash(rawQuery) : normalizeSlash(rawQuery).toLowerCase()
  const pick = buildRegExpTargetSelector(matchPath)
  return {
    ok: true,
    mode: 'substring',
    matchPath,
    matches: (name, relativePath) => {
      const target = pick(name, relativePath)
      const haystack = caseSensitive ? target : target.toLowerCase()
      return haystack.includes(needle)
    },
  }
}
