/**
 * Issue #56 P2 #8 — the preview-find wiring, pinned the way the repo pins
 * unmountable chains (the html print-request convention): the App↔controller
 * decisions are read from the source, since mounting the full App (CodeMirror,
 * iframe preview, IPC) is not possible in jsdom. The frame half runs for real
 * in inspector-find.test.ts; the mirror math in preview-find.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const source = (relative: string) =>
  readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const APP = '../src/renderer/App.tsx'
const FRAME = '../src/renderer/preview/PreviewFrame.tsx'

describe('App preview-find wiring (issue #56 P2 #8)', () => {
  it('Cmd+F in preview view searches the rendered text, not the source', async () => {
    const app = await source(APP)
    // the preview branch keys on the reader's view and the draft overlay
    expect(app).toMatch(/if \(view === 'preview' && draftHtml === null\) \{/)
    expect(app).toMatch(/controller\.start\(\)/)
    expect(app).toMatch(/setFindTarget\(controller\.findTarget\(\)\)/)
    // the preview branch's OWN return keeps it out of the source-pane
    // fallback that forces split — the old behavior dumped the reader into
    // the source pane (the slice ends at the source branch, so the source
    // branch's own `if (!target) return` cannot satisfy this pin)
    const previewBranch = app.slice(
      app.indexOf("if (view === 'preview' && draftHtml === null)"),
      app.indexOf('// retargeting to the source pane'),
    )
    expect(previewBranch).toMatch(/\breturn\b/)
    expect(app).toMatch(/\/\/ hits live in the source pane, so it must be on screen/)
    // the forced split switch stays in the source branch only
    expect(app).toMatch(/setView\(\(v\) => \(v === 'preview' \? 'split' : v\)\)/)
    // the mode is tracked so close/ready know which surface the panel owns
    expect(app).toMatch(/findModeRef\.current = 'preview'/)
    expect(app).toMatch(/findModeRef\.current = 'source'/)
  })

  it('retargeting to the source tears the preview session down first', async () => {
    const app = await source(APP)
    const openFind = app.slice(app.indexOf('const openFind'), app.indexOf('const closeFind'))
    // an orphaned session would leave painted marks on the frame and keep
    // pushing docText under the source target
    expect(openFind).toMatch(
      /if \(findModeRef\.current === 'preview'\) getPreviewFind\(\)\.stop\(\)/,
    )
    // and that stop sits in the source branch, after the preview branch's own
    // return — not inside the preview branch itself
    const previewBranch = openFind.slice(
      openFind.indexOf("if (view === 'preview' && draftHtml === null)"),
      openFind.indexOf('// retargeting to the source pane'),
    )
    expect(previewBranch).not.toMatch(/getPreviewFind\(\)\.stop\(\)/)
  })

  it('closing the panel stops the frame reporting; a reload re-arms it', async () => {
    const app = await source(APP)
    // the stop must be closeFind's own (an openFind line reads identically, so
    // slice closeFind's body to pin it there)
    const closeFindBody = app.slice(
      app.indexOf('const closeFind'),
      app.indexOf('useEffect', app.indexOf('const closeFind')),
    )
    expect(closeFindBody).toMatch(
      /if \(findModeRef\.current === 'preview'\) getPreviewFind\(\)\.stop\(\)/,
    )
    // the frame reloaded under an open panel: the fresh inspector knows
    // nothing, so text reporting is re-armed and the panel self-heals off the
    // snapshot that follows
    expect(app).toMatch(/if \(findModeRef\.current === 'preview'\) getPreviewFind\(\)\.start\(\)/)
  })

  it('the shared panel clears a swapped-out target, so retargeted marks never linger', async () => {
    // the html app swaps the panel's target between the source editor and the
    // preview controller; the panel itself must drop the OLD target's marks
    // (nothing else owns them once the target is gone)
    const panel = await source('../../../packages/ui/src/find-panel.tsx')
    expect(panel).toMatch(/useEffect\(\(\) => \(\) => target\.clear\(\), \[target\]\)/)
  })

  it('leaving the preview surface (view switch, draft overlay) closes the panel', async () => {
    const app = await source(APP)
    // the panel would otherwise keep painting marks on a hidden frame off a
    // stale mirror
    expect(app).toMatch(
      /findModeRef\.current === 'preview' && \(view !== 'preview' \|\| draftHtml !== null\)/,
    )
  })

  it('docText snapshots feed the controller through the versioned message handler', async () => {
    const app = await source(APP)
    expect(app).toMatch(/case 'gx:docText':/)
    expect(app).toMatch(/getPreviewFind\(\)\.onDocText\(msg\.nodes\)/)
    // the controller posts through the frame handle, lazily constructed once
    expect(app).toMatch(
      /new PreviewFindController\(\(msg\) => previewRef\.current\?\.post\(msg\)\)/,
    )
  })

  it('frame messages still arrive through the version-guarded listener', async () => {
    const frame = await source(FRAME)
    expect(frame).toMatch(/isFromInspector\(event\.data\)/)
    expect(frame).toMatch(/onMessageRef\.current\(event\.data\)/)
  })
})
