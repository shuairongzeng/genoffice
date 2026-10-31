import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Knowledge-base wiring tripwire (the app's own idiom — see
 * preload-wire-coverage.test.ts and sheet-zoom-scale.test.ts: the preload is
 * not importable in a jsdom harness, so its wire contract is pinned against
 * the source). The sheets agent loop gains the shared kb skill through three
 * hand-wired pieces that can each drift silently: the desktop-api interface
 * decls, the preload methods that invoke the shell main's process-wide kb:*
 * channels, and the App's skill composition over window.desktopApi. A string
 * appearing in the source is a necessary, not sufficient, condition — the
 * skill itself and its empty-corpus gating are pinned in agent-core, and the
 * other four editors' panels pin the same wiring behaviorally end to end.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

const preloadSource = read('../src/preload/index.ts')
const appSource = read('../src/renderer/App.tsx')
const apiSource = read('../src/shared/desktop-api.ts')

describe('the knowledge base is wired into the sheets agent loop', () => {
  it("the preload invokes the shell main's kb channels", () => {
    // the kb:* handlers are registered once by the shell main (home-ipc) and
    // serve every app's panel; sheets must call the same channels docs does
    expect(preloadSource).toContain("ipcRenderer.invoke('kb:list')")
    expect(preloadSource).toContain("ipcRenderer.invoke('kb:search', query)")
    expect(preloadSource).toContain("ipcRenderer.invoke('kb:read', { path, offset })")
  })

  it('the bridge declares the kb methods on DesktopApi', () => {
    expect(apiSource).toContain('kbList(): Promise<KbFileInfo[]>')
    expect(apiSource).toContain(
      'kbSearch(query: { q: string; limit?: number }): Promise<KbSearchHit[]>',
    )
    expect(apiSource).toContain('kbRead(path: string, offset: number): Promise<KbReadPage>')
  })

  it('the loop composes the shared kb skill over the desktopApi bridge', () => {
    expect(appSource).toContain('createKnowledgeBaseSkill({')
    // mounted only when the bridge carries the channel (an older preload must
    // not grow tools that cannot execute), corpus snapshotted in kbFilesRef
    expect(appSource).toContain("typeof window.desktopApi?.kbList === 'function'")
    expect(appSource).toContain('listFiles: () => kbFilesRef.current')
    expect(appSource).toContain('window.desktopApi.kbSearch({ q: query, limit })')
    expect(appSource).toContain('window.desktopApi.kbRead(path, offset)')
  })

  it('the corpus is actually populated and re-fetched per send', () => {
    // deleting refreshKbFiles (the assignment, the mount effect or the two
    // pre-run awaits) would leave kbFilesRef permanently empty — the skill
    // then silently contributes nothing and the agent is re-blinded with the
    // suite green, which is exactly the item-17 complaint again
    expect(appSource).toContain('kbFilesRef.current = files')
    expect(appSource).toContain('void refreshKbFiles()')
    expect(appSource).toContain('await refreshKbFiles()')
  })
})
