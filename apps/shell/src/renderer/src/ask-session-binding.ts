import { AGENT_DOCUMENT_KINDS, type SurfaceTab } from '@genoffice/agent-core'

/** Explicit chat target addressing one persisted transcript across mounts. */
export interface SessionTarget {
  readonly projectId: string
  readonly chatId: string
  readonly docPath?: string | null
}

/** Normalized active tab identity tracked for per-document and unsaved-tab binding. */
export interface ActiveTabBinding {
  readonly tabId: string
  readonly kind: string
  readonly title: string
  readonly filePath: string | null
}

/** Thread claim resolution computed from active tab, explicit choice, or mount default. */
export type ThreadClaimPlan =
  | {
      readonly mode: 'explicit'
      readonly projectId: string
      readonly chatId: string
      readonly docPath: string | null
    }
  | {
      readonly mode: 'doc'
      readonly docPath: string
    }
  | {
      readonly mode: 'unsaved-tab'
      readonly tempChatId: string
    }
  | {
      readonly mode: 'family'
      readonly tempChatId: string
    }

/** Stable composite routing key shared across Home executor, IPC cache, and mirror mounts. */
export function sessionKeyOf(projectId: string, chatId: string): string {
  return `${projectId}:${chatId}`
}

/** Whether a tab kind should bind its own document or unsaved-draft session. */
export function isBindableDocumentTab(tab: Pick<SurfaceTab, 'kind'>): boolean {
  return AGENT_DOCUMENT_KINDS.has(tab.kind) || tab.kind === 'media'
}

/** Deterministic safe temporary chat id for an unsaved document tab. */
export function unsavedTabChatId(tabId: string): string {
  const safe = tabId.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '')
  return `tab-${safe || 'untitled'}`
}

/** Generates a child chat id scoped under a document's primary thread id. */
export function docExtraChatId(primaryDocChatId: string, now = Date.now()): string {
  return `${primaryDocChatId}-${Math.max(0, Math.trunc(now))}`
}

/**
 * Extracts the active bindable document tab (saved or unsaved draft) from
 * the shell's current surface tabs snapshot. Returns null on Home/browser tabs.
 */
export function deriveActiveTabBinding(
  tabs: readonly SurfaceTab[] | null | undefined,
): ActiveTabBinding | null {
  const active = tabs?.find((t) => t.active && isBindableDocumentTab(t))
  if (!active) return null
  return {
    tabId: active.id,
    kind: active.kind,
    title: active.title,
    filePath: typeof active.filePath === 'string' && active.filePath !== '' ? active.filePath : null,
  }
}

/**
 * Decides which conversation transcript the panel should claim.
 * An explicit choice (switching threads, starting a new chat in a doc, or jumping
 * from the global session manager) takes priority over resetting to the doc default.
 */
export function planThreadClaim(input: {
  activeTab: ActiveTabBinding | null
  explicitTarget: SessionTarget | null
  fallbackChatId: string
}): ThreadClaimPlan {
  const { activeTab, explicitTarget, fallbackChatId } = input
  if (explicitTarget) {
    return {
      mode: 'explicit',
      projectId: explicitTarget.projectId,
      chatId: explicitTarget.chatId,
      docPath: explicitTarget.docPath ?? null,
    }
  }
  if (activeTab?.filePath) {
    return {
      mode: 'doc',
      docPath: activeTab.filePath,
    }
  }
  if (activeTab) {
    return {
      mode: 'unsaved-tab',
      tempChatId: unsavedTabChatId(activeTab.tabId),
    }
  }
  return {
    mode: 'family',
    tempChatId: fallbackChatId,
  }
}

/**
 * Gate preventing cross-session stream bleed on mirror mounts: untagged legacy
 * events remain accepted, while tagged events only apply to the active sessionKey.
 */
export function shouldAcceptMirrorEvent(
  eventSessionKey: string | undefined,
  currentSessionKey: string | null,
): boolean {
  if (eventSessionKey === undefined || eventSessionKey === '') return true
  return currentSessionKey !== null && eventSessionKey === currentSessionKey
}

/** Normalizes two file paths for UI matching (handles Windows separators/drive case). */
export function sameDocPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (value: string): string => {
    const unified = value.normalize('NFC').replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[a-z]:\//i.test(unified) ? unified.toLowerCase() : unified
  }
  return norm(a) === norm(b)
}

/**
 * Splits a list of threads into those bound to `currentDocPath` and everything else,
 * keeping existing relative order within each bucket.
 */
export function filterCurrentDocThreads<T extends { readonly docPath?: string }>(
  threads: readonly T[],
  currentDocPath: string | null,
): { currentDoc: T[]; otherDocs: T[] } {
  if (!currentDocPath) return { currentDoc: [], otherDocs: [...threads] }
  const currentDoc: T[] = []
  const otherDocs: T[] = []
  for (const thread of threads) {
    if (sameDocPath(thread.docPath, currentDocPath)) currentDoc.push(thread)
    else otherDocs.push(thread)
  }
  return { currentDoc, otherDocs }
}
