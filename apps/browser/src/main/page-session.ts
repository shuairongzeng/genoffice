/**
 * Policy for the page views' `persist:browser` session: the pure decisions
 * behind the permission request handler and the download sink's filename
 * handling. Pure on purpose — browser-main applies them against Electron, the
 * tests pin every rule.
 */

/**
 * The permissions the page session may ever grant. Deliberately near-empty:
 * web content is untrusted here, so the default answer to every capability
 * question is no — geolocation, camera/microphone, notifications, pointer
 * lock, MIDI, clipboard read *and* write all deny. `fullscreen` is the one
 * entry because HTML fullscreen is a shipped feature of the page views
 * (enter/leave-html-full-screen in browser-main), and it grants no data
 * access — only the page's own bounds.
 *
 * Extension point: a future feature that needs a capability (say, a setting
 * that lets a site use the clipboard) adds its permission string to this set
 * — nothing else changes; everything not listed keeps denying.
 */
const GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(['fullscreen'])

/** the answer to one permission request from a page view */
export function decidePermissionRequest(permission: string): 'allow' | 'deny' {
  return GRANTED_PERMISSIONS.has(permission) ? 'allow' : 'deny'
}

/** longest download filename kept (a page-supplied string) */
const DOWNLOAD_NAME_MAX = 200

/**
 * The filename a download lands under: the page-supplied name reduced to a
 * bare, control-character-free name (Chromium sanitizes most of this already;
 * the belt-and-braces pass keeps a hostile name from ever reaching the
 * filesystem API with separators or NULs in it).
 */
export function sanitizeDownloadFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    // strip control chars (C0 + DEL) without a regex — eslint's
    // no-control-regex rejects the range in both literal and constructor form
    .replace(/./g, (ch) => (ch < ' ' || ch === '\u007f' ? '' : ch))
    .trim()
    .slice(0, DOWNLOAD_NAME_MAX)
  return cleaned || 'download'
}

/**
 * Same-name de-duplication: a download never overwrites a file that is
 * already there (or one that landed earlier in the same batch) — it becomes
 * `report (1).pdf`, `report (2).pdf`, … A name that stays taken past a
 * thousand tries falls back to a timestamped stem, so the handler always has
 * a path to write to.
 */
export function dedupeDownloadName(taken: (name: string) => boolean, filename: string): string {
  if (!taken(filename)) return filename
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  for (let i = 1; i <= 1000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}
