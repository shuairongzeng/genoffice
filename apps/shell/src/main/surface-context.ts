import type { SurfaceTab } from '@genoffice/agent-core'

import type { WebContents } from 'electron'

/**
 * The surface context's collector (main side): every open tab — the shell
 * strip's and the detached editor windows' — with the URL a browser tab is
 * showing or the file path a document tab holds. This feeds the agent loop's
 * "current surface" prompt section (both panel mounts pull it over
 * `home:surface-tabs` before every send) and the `shell:list_tabs` tool's
 * answer; one collector, one truth.
 *
 * Pure plumbing over injected sources (like browser-agent's deps): the shell
 * strip and the detached windows enumerate differently, and the URL lives
 * behind the browser module's chrome→tab map, so index.ts wires the sources
 * and this module just shapes them.
 */

/** one tab as the sources report it (the strip's and the detached windows' shapes both fit) */
export interface SurfaceTabInput {
  id: string
  kind: string
  title: string
  active: boolean
  /** document tabs: the path behind the tab */
  filePath?: string
  /** the tab lives in its own OS window (a detached editor) */
  detached?: boolean
}

/** the sources the collector reads; index.ts wires them, tests fake them */
export interface SurfaceContextDeps {
  /** every open tab (shell strip first, detached windows after — the display order) */
  listTabs(): readonly SurfaceTabInput[] | Promise<readonly SurfaceTabInput[]>
  /**
   * The URL the browser tab behind one id is showing: '' when the id names no
   * browser tab or its page is not reachable — an absent URL is honest (the
   * tab shows it in its strip row), never a guess.
   */
  urlOf(tabId: string): string
}

/**
 * Collect the surface tabs. The browser tab's URL rides only when the source
 * answers a non-empty one; document tabs keep their file path; untitled
 * documents carry neither. Sync-or-async sources, one flat answer.
 *
 * One active-tab rule: when a detached window is focused, the strip's own
 * active flag (the tab the shell window had selected when it lost focus) is
 * stale — the person is looking at the detached window, so the section says
 * exactly that and no other tab claims active.
 */
export async function collectSurfaceTabs(deps: SurfaceContextDeps): Promise<SurfaceTab[]> {
  const tabs = await deps.listTabs()
  if (!Array.isArray(tabs)) return []
  const out: SurfaceTab[] = []
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object') continue
    if (typeof tab.id !== 'string' || tab.id === '') continue
    if (typeof tab.kind !== 'string' || typeof tab.title !== 'string') continue
    const url = tab.kind === 'browser' ? deps.urlOf(tab.id) : ''
    out.push({
      id: tab.id,
      kind: tab.kind,
      title: tab.title,
      active: tab.active === true,
      ...(url !== '' ? { url } : {}),
      ...(typeof tab.filePath === 'string' && tab.filePath !== ''
        ? { filePath: tab.filePath }
        : {}),
      ...(tab.detached === true ? { detached: true } : {}),
    })
  }
  if (out.some((t) => t.active && t.detached)) {
    for (const tab of out) if (tab.active && !tab.detached) tab.active = false
  }
  return out
}

/** the shape index.ts needs to turn a chrome webContents into the tab's URL */
export type PageUrlResolver = (chrome: WebContents) => string

/** build urlOf from the tab-id → chrome webContents resolver and the browser module's URL getter */
export function urlOfWith(
  webContentsFor: (tabId: string) => WebContents | undefined,
  pageUrlOf: PageUrlResolver,
): (tabId: string) => string {
  return (tabId: string): string => {
    const chrome = webContentsFor(tabId)
    if (!chrome || chrome.isDestroyed()) return ''
    return pageUrlOf(chrome)
  }
}
