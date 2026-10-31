import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The five editor panels must route their live chat growth through the shared
 * bound (issue #51 P1): docs' panel and the shell Ask panel were bounded, but
 * slides/sheets/pdf/markdown/html grew without limit — every turn appends a
 * user entry plus one or more assistant entries, so an 80-turn session held
 * the whole transcript in React state for the life of the panel.
 *
 * Each panel's chat state is a single useState valve; the wiring renames the
 * raw setter (setChatRaw) and exposes a setChat that bounds every updater's
 * result through boundChatHistory. The census asserts the exact set of files
 * importing the shared module (comment-stripped, so prose in comments does
 * not count): a panel losing the wiring goes red, and a file gaining the
 * import goes red too — re-read the site before updating the map (a new app
 * adopting the bound is welcome, but it must actually wire the valve, which
 * the setChatRaw/boundChatHistory checks below verify).
 */
const EXPECTED_BOUND_PANELS = [
  'apps/slides/src/renderer/ai/AiPanel.tsx',
  // sheets keeps its chat state in App.tsx (AiChatPanel is presentational)
  'apps/sheets/src/renderer/App.tsx',
  'apps/pdf/src/renderer/ai/AiPanel.tsx',
  'apps/markdown/src/renderer/ai/AiPanel.tsx',
  'apps/html/src/renderer/ai/AiPanel.tsx',
]

// packages/ui/tests/ is three levels below the repo root; git ls-files must run
// from the root so its output is repo-relative
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function importersOfSharedBound(): string[] {
  const files = execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.(ts|tsx)$/.test(file))
    // this test's own prose names the import path; it is the census taker
    .filter((file) => !file.includes('/tests/'))
  const importers: string[] = []
  for (const file of files) {
    const src = readFileSync(join(REPO_ROOT, file), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    if (code.includes("'@genoffice/ui/chat-retention'")) importers.push(file)
  }
  return importers.sort()
}

describe('editor panels bound their live chat transcript (issue #51 P1)', () => {
  it('exactly the five editor panels import the shared bound', () => {
    expect(importersOfSharedBound()).toEqual([...EXPECTED_BOUND_PANELS].sort())
  })

  it('each panel wires the bound at its single chat growth valve', () => {
    for (const file of EXPECTED_BOUND_PANELS) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      // the raw useState setter renamed → nothing can bypass the wrapper
      expect(code, `${file} must expose setChat through the bounded wrapper`).toContain(
        'setChatRaw',
      )
      // ...and the wrapper actually applies the shared bound
      expect(code, `${file} must apply boundChatHistory in the wrapper`).toContain(
        'boundChatHistory(',
      )
      // one valve only: the chat useState itself, not several scattered bounds
      expect((code.match(/setChatRaw\(/g) ?? []).length).toBe(1)
    }
  })

  it('slides/html receipts anchor by entry id, never by array index (a trim shifts indexes)', () => {
    // a receipt anchored by absolute index re-attaches to a different message once
    // the head-trim starts shifting indexes — the two panels that keep
    // receipts (slides clarify answers, html clarify/brief) stamp every
    // ChatEntry with a monotonic id and match afterId === entry.id instead
    for (const file of [
      'apps/slides/src/renderer/ai/AiPanel.tsx',
      'apps/html/src/renderer/ai/AiPanel.tsx',
    ]) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      expect(code, `${file} must not anchor receipts by chat index`).not.toContain('afterIdx')
      expect(code, `${file} receipts must match the entry id`).toContain('=== entry.id')
    }
  })

  it('markdown/html/pdf restore exactly the entries the bound can keep', () => {
    // these three panels restore persisted history INTO the bounded chat
    // array (slides/sheets keep it in a separate historic array): loading
    // more than the bound would feed loop.restore a transcript the panel
    // cannot display — display 60 while the model sees 200
    for (const file of [
      'apps/markdown/src/renderer/ai/AiPanel.tsx',
      'apps/html/src/renderer/ai/AiPanel.tsx',
      'apps/pdf/src/renderer/ai/AiPanel.tsx',
    ]) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
      expect(code, `${file} chat-history load must use the shared bound`).toContain(
        'limit: MAX_CHAT_ENTRIES',
      )
      expect(code, `${file} must not load a fixed 200-entry history`).not.toContain('limit: 200')
    }
  })
})
