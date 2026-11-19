/**
 * Pure helpers for organizing delegated document-agent edits into a
 * Git-style checkpoint timeline and computing safe reverse-chronological
 * rollback sequences per document tab.
 */

export interface DocCheckpoint {
  tabId: string
  kind: string
  title: string
  checkpointId: string
  editCount: number
  createdAt?: number
  summary?: string
  reverted?: boolean
  reverting?: boolean
  error?: string
}

export interface CheckpointMessageLike {
  docCheckpoints?: readonly DocCheckpoint[]
}

export interface CheckpointTimelineEntry {
  stepNumber: number
  messageIndex: number
  checkpoint: DocCheckpoint
  /** Number of newer un-reverted checkpoints targeting the same document tab */
  laterActiveCount: number
}

/** Collect all checkpoints in newest-first order with per-tab later active counts. */
export function collectDocCheckpoints(
  messages: readonly CheckpointMessageLike[],
): CheckpointTimelineEntry[] {
  const ordered: Array<{ messageIndex: number; checkpoint: DocCheckpoint; stepNumber: number }> = []
  let stepNumber = 0
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const cps = messages[messageIndex]?.docCheckpoints
    if (!cps || cps.length === 0) continue
    for (const checkpoint of cps) {
      stepNumber += 1
      ordered.push({ messageIndex, checkpoint, stepNumber })
    }
  }
  const activeCountByTab = new Map<string, number>()
  const entries = new Array<CheckpointTimelineEntry>(ordered.length)
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i]!
    const tabId = item.checkpoint.tabId
    const laterActiveCount = activeCountByTab.get(tabId) ?? 0
    entries[i] = {
      stepNumber: item.stepNumber,
      messageIndex: item.messageIndex,
      checkpoint: item.checkpoint,
      laterActiveCount,
    }
    if (!item.checkpoint.reverted) {
      activeCountByTab.set(tabId, laterActiveCount + 1)
    }
  }
  return entries.reverse()
}

/**
 * Compute the reverse-chronological rollback list for rolling back a document
 * tab to before `targetCheckpointId`. Every newer un-reverted checkpoint on
 * the same tab is undone first so step-based undo engines (Sheets) and
 * snapshot-based engines (Docs/Slides/Markdown/HTML) restore cleanly.
 */
export function checkpointsToRollback(
  messages: readonly CheckpointMessageLike[],
  targetCheckpointId: string,
): DocCheckpoint[] {
  const ordered: DocCheckpoint[] = []
  for (const msg of messages) {
    if (!msg.docCheckpoints || msg.docCheckpoints.length === 0) continue
    for (const cp of msg.docCheckpoints) ordered.push(cp)
  }
  const targetIndex = ordered.findIndex((cp) => cp.checkpointId === targetCheckpointId)
  if (targetIndex < 0) return []
  const target = ordered[targetIndex]!
  if (target.reverted || target.reverting) return []
  const plan: DocCheckpoint[] = []
  for (let i = ordered.length - 1; i >= targetIndex; i -= 1) {
    const cp = ordered[i]!
    if (cp.tabId !== target.tabId) continue
    if (cp.reverted || cp.reverting) continue
    plan.push(cp)
  }
  return plan
}
