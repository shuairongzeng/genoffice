import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Tab views must not disable Chromium's background throttling (issue #27 item
 * 1): a hidden tab that keeps its timers running burns CPU and battery for
 * the whole session — the docs 30s autosave tick and the sheets 250ms grid
 * guard would otherwise wake a hidden renderer all day.
 *
 * The flag's legitimate homes are windows whose work must outlive their
 * visibility: the hidden headless/print export windows (a throttled timer
 * would stall their settle waits), the standalone docs/sheets windows (out of
 * the audit's scope), and the html2docx driver window. The expected map below
 * is the complete repo-wide census of the flag — every tracked .ts file under
 * apps/ and packages/ is scanned (comments stripped: the surrounding code
 * documents the flag in prose, and doc text must not count as a flag site) and
 * the result must equal this map exactly. So the flag reaching ANY new site —
 * a tab-view constructor in this or a future app, or a copy-paste into a
 * detached window — goes red, as does an export window losing the flag it
 * needs. When the census legitimately changes, re-read the site before
 * updating the number.
 */
const EXPECTED_FLAG_SITES: Record<string, number> = {
  // exportDocsHeadless's hidden export window + the standalone
  // createDocsWindow; createDocsView (the tab view) carries none
  'apps/docs/src/main/docs-main.ts': 2,
  // the headless html export window; createHtmlView (the tab view) none
  'apps/html/src/main/html-main.ts': 1,
  // the headless markdown export window; createMarkdownView (the tab view) none
  'apps/markdown/src/main/markdown-main.ts': 1,
  // the standalone createSheetsWindow + the headless xlsx export window;
  // createSheetsView (the tab view) carries none
  'apps/sheets/src/main/sheets-main.ts': 2,
  // the hidden print window + the headless export window; createSlidesView
  // (the tab view) none
  'apps/slides/src/main/slides-main.ts': 2,
  // the conversion driver's hidden window: it renders documents to settle
  // export output, exactly the export-window case
  'packages/html2docx/src/drivers/electron.ts': 1,
  // deliberately absent: the shell's tab views (docs, sheets, slides, pdf,
  // markdown, html, help) all keep default throttling — pdf-main.ts and
  // tab-manager.ts carry the flag nowhere, and no detached-window or
  // renderer-side file may grow a copy
}

// apps/shell/tests/ is three levels below the repo root; git ls-files must
// run from the root so its output is repo-relative and the apps/packages
// filter below sees the full tree
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

function flagSitesByFile(): Record<string, number> {
  const files = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(
      (file) => file.endsWith('.ts') && (file.startsWith('apps/') || file.startsWith('packages/')),
    )
    // this test's own title and matching regex spell the flag out; it is the
    // census taker, not a window site
    .filter((file) => file !== 'apps/shell/tests/tab-view-throttling.test.ts')
  const sites: Record<string, number> = {}
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const count = (code.match(/backgroundThrottling:\s*false/g) ?? []).length
    if (count > 0) sites[file] = count
  }
  return sites
}

describe('tab views keep default background throttling', () => {
  it('every backgroundThrottling:false site is an expected window', () => {
    expect(flagSitesByFile()).toEqual(EXPECTED_FLAG_SITES)
  })
})
