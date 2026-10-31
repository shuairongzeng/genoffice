// Pins the issue-1 item-13 convergence invariants that CSS itself cannot
// enforce from inside a unit test:
//   1. every renderer loads the shared ai-panel.css BEFORE its app stylesheet,
//      so app-specific rules keep winning at equal specificity;
//   2. no renderer still imports the retired send/stop PNG bitmaps;
//   3. the shared file exists and is exported by the ui package.
// Source-tripwire style (see the sheets ai-kb-wiring precedent): reading the
// source files is the point — the runtime renders fine with a broken order,
// which is exactly why it needs a pin.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const RENDERERS: Array<{ app: string; entry: string; appSheet: string }> = [
  { app: 'docs', entry: 'apps/docs/src/renderer/main.tsx', appSheet: './styles.css' },
  { app: 'sheets', entry: 'apps/sheets/src/renderer/main.tsx', appSheet: './styles.css' },
  { app: 'slides', entry: 'apps/slides/src/renderer/main.tsx', appSheet: './styles.css' },
  { app: 'pdf', entry: 'apps/pdf/src/renderer/main.tsx', appSheet: './styles.css' },
  { app: 'markdown', entry: 'apps/markdown/src/renderer/main.tsx', appSheet: './styles.css' },
  { app: 'html', entry: 'apps/html/src/renderer/main.tsx', appSheet: './styles.css' },
  { app: 'shell', entry: 'apps/shell/src/renderer/src/main.tsx', appSheet: './home.css' },
]

for (const r of RENDERERS) {
  it(`${r.app} imports the shared ai-panel.css before its app stylesheet`, () => {
    const src = readFileSync(join(repoRoot, r.entry), 'utf8')
    const shared = src.indexOf('@genoffice/ui/ai-panel.css')
    expect(shared).toBeGreaterThanOrEqual(0)
    const app = src.indexOf(`'${r.appSheet}'`)
    expect(app).toBeGreaterThanOrEqual(0)
    // load order decides the cascade: shared first, app overrides after
    expect(shared).toBeLessThan(app)
  })
}

// the retired-bitmap scan only looks at source/stylesheet files (the old
// grep's --include set), and runs on windows CI too — so it walks the tree
// with node fs instead of shelling out to a POSIX-only grep.
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.css'])

function* sourceFiles(dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    // join() keeps separators right on both platforms; a symlinked directory
    // is not descended (ent.isDirectory() is false for it), like grep -r
    const full = join(dir, ent.name)
    if (ent.isDirectory()) yield* sourceFiles(full)
    else if (ent.isFile() && SCAN_EXTENSIONS.has(extname(ent.name))) yield full
  }
}

it('no renderer source still wires the retired send/stop PNG bitmaps', () => {
  // the imports lived in the AI panel files, not the entry points — scan the
  // whole renderer tree of every app so a re-added import anywhere fails
  const roots = RENDERERS.map((r) => dirname(join(repoRoot, r.entry)))
  const offenders: string[] = []
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8')
      if (src.includes('send-enter') || src.includes('send-stop')) offenders.push(file)
    }
  }
  expect(offenders).toEqual([])
})

it('the ui package exports the shared stylesheet and it exists', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/ui/package.json'), 'utf8'))
  expect(pkg.exports['./ai-panel.css']).toBe('./src/ai-panel.css')
  expect(existsSync(join(repoRoot, 'packages/ui/src/ai-panel.css'))).toBe(true)
})

it('the shared file carries the core composer and message rules', () => {
  // jsdom never renders CSS, so a rule silently lost in the move keeps every
  // suite green — pin the load-bearing selectors and the keyframes by name
  const css = readFileSync(join(repoRoot, 'packages/ui/src/ai-panel.css'), 'utf8')
  for (const sel of [
    '.ai-input-box {',
    '.ai-input-box textarea {',
    '.ai-input-footer {',
    '.ai-send-btn {',
    '.ai-send-btn:disabled {',
    '.ai-send-btn svg {',
    '.ai-msg-user {',
    '.ai-msg-assistant {',
    '.ai-typing-label {',
    '.ai-ask-pop {',
    '.ai-ask-confirm {',
    '.ai-step-icon.error {',
  ]) {
    expect(css.includes(sel)).toBe(true)
  }
  for (const kf of [
    'ai-thinking-shimmer',
    'ai-caret-blink',
    'ai-dot-grow',
    'ai-dot-shrink',
    'ai-hourglass-flip',
    'ai-row-ease-in',
    'ai-summary-pulse',
    'ai-tool-dot-grow',
    'ai-tool-dot-shrink',
  ]) {
    expect(css.includes('@keyframes ' + kf)).toBe(true)
  }
  // the all-apps intersection is ~100 rule blocks; a mass loss must fail
  const ruleBlocks = (css.match(/^\.[\w-]/gm) ?? []).length
  expect(ruleBlocks).toBeGreaterThanOrEqual(90)
})
