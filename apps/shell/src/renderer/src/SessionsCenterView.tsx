import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '@genoffice/ui'
import type { ChatMessage, GlobalChatMeta } from '@genoffice/project-store'
import { useI18n } from './locale'
import { useConfirm } from './ConfirmDialog'
import { FileBadge } from './file-badge'
import { SESSIONS_CENTER_STRINGS } from './sessions-center-strings'
import { sessionKeyOf, type SessionTarget } from './ask-session-binding'

export type SessionFilterKind = 'all' | 'docs' | 'free' | 'pinned' | 'missing'
export type SessionSortKind = 'recent' | 'messages'

function docBaseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

function sessionDisplayTitle(meta: GlobalChatMeta): string {
  if (meta.title && meta.title.trim() !== '') return meta.title.trim()
  if (meta.docPath) return docBaseName(meta.docPath)
  const firstQ = meta.firstQuestion?.replace(/\s+/g, ' ').trim()
  if (firstQ) return firstQ.slice(0, 60)
  return meta.chatId
}

/** Filters and sorts global sessions deterministically for list display. */
export function filterAndSortSessions(
  sessions: readonly GlobalChatMeta[],
  filter: SessionFilterKind,
  sort: SessionSortKind,
): GlobalChatMeta[] {
  const filtered = sessions.filter((meta) => {
    if (filter === 'docs') return Boolean(meta.docPath)
    if (filter === 'free') return !meta.docPath
    if (filter === 'pinned') return meta.pinned === true
    if (filter === 'missing') return Boolean(meta.docPath) && meta.docExists === false
    return true
  })
  return [...filtered].sort((a, b) => {
    const pinDiff = Number(b.pinned === true) - Number(a.pinned === true)
    if (sort === 'messages') {
      if (pinDiff !== 0) return pinDiff
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount
    }
    if (pinDiff !== 0) return pinDiff
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

/** Formats a conversation transcript into portable Markdown. */
export function formatSessionMarkdown(
  meta: GlobalChatMeta,
  messages: readonly ChatMessage[],
  labels?: { user?: string; assistant?: string; doc?: string },
): string {
  const title = sessionDisplayTitle(meta)
  const docLabel = labels?.doc ?? 'Document'
  const userLabel = labels?.user ?? 'User'
  const assistantLabel = labels?.assistant ?? 'Assistant'
  const lines: string[] = [`# ${title}`]
  if (meta.docPath) {
    lines.push('', `> ${docLabel}: \`${meta.docPath}\``)
  }
  for (const msg of messages) {
    const heading = msg.role === 'user' ? userLabel : assistantLabel
    lines.push('', `## ${heading}`, '', msg.text)
  }
  return lines.join('\n')
}

function downloadMarkdownFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Full-workbench AI Sessions Center: unified search, filtering, transcript preview,
 * jump-back to bound documents, inline rename/pin, Markdown export, and batch cleanup.
 */
export function SessionsCenterView({
  onOpenSession,
}: {
  onOpenSession: (target: SessionTarget) => void
}): React.JSX.Element {
  const { lang, dateLocale } = useI18n()
  const s = SESSIONS_CENTER_STRINGS[lang] ?? SESSIONS_CENTER_STRINGS.en
  const { confirm: confirmBox, dialog: confirmDialog } = useConfirm(s.confirmLabel)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SessionFilterKind>('all')
  const [sort, setSort] = useState<SessionSortKind>('recent')
  const [sessions, setSessions] = useState<GlobalChatMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [previewMessages, setPreviewMessages] = useState<ChatMessage[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadList = useCallback(async (searchQuery: string): Promise<void> => {
    const api = window.projectApi
    if (!api) {
      if (mountedRef.current) setLoading(false)
      return
    }
    if (mountedRef.current) setLoading(true)
    try {
      const trimmed = searchQuery.trim()
      let next: GlobalChatMeta[]
      if (typeof api.listAllChats === 'function') {
        next = await api.listAllChats(trimmed ? { query: trimmed } : undefined)
      } else {
        const metas = await api.listChats({
          projectId: 'default',
          ...(trimmed ? { query: trimmed } : {}),
        })
        next = metas.map((m) => ({
          ...m,
          projectId: m.projectId ?? 'default',
          projectName: m.projectName ?? s.projectDefault,
          messageCount: m.messageCount ?? m.approxCount,
          docExists: m.docExists ?? true,
        }))
      }
      if (!mountedRef.current) return
      setSessions(next)
    } catch {
      if (mountedRef.current) setSessions([])
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current)
    const delay = query === '' ? 0 : 180
    fetchTimerRef.current = setTimeout(() => {
      fetchTimerRef.current = null
      void loadList(query)
    }, delay)
    return () => {
      if (fetchTimerRef.current) {
        clearTimeout(fetchTimerRef.current)
        fetchTimerRef.current = null
      }
    }
  }, [query, loadList])

  const visibleSessions = useMemo(
    () => filterAndSortSessions(sessions, filter, sort),
    [sessions, filter, sort],
  )

  useEffect(() => {
    if (visibleSessions.length === 0) {
      setSelectedKey(null)
      return
    }
    const stillVisible =
      selectedKey !== null &&
      visibleSessions.some((m) => sessionKeyOf(m.projectId, m.chatId) === selectedKey)
    if (!stillVisible) {
      const first = visibleSessions[0]
      setSelectedKey(sessionKeyOf(first.projectId, first.chatId))
    }
  }, [visibleSessions, selectedKey])

  const selectedMeta = useMemo(
    () =>
      selectedKey === null
        ? null
        : (visibleSessions.find((m) => sessionKeyOf(m.projectId, m.chatId) === selectedKey) ?? null),
    [visibleSessions, selectedKey],
  )

  useEffect(() => {
    if (!selectedMeta) {
      setPreviewMessages([])
      return
    }
    const api = window.projectApi
    if (!api) return
    let active = true
    setPreviewLoading(true)
    void api
      .loadChat({ projectId: selectedMeta.projectId, chatId: selectedMeta.chatId })
      .then((msgs) => {
        if (active) setPreviewMessages(msgs)
      })
      .catch(() => {
        if (active) setPreviewMessages([])
      })
      .finally(() => {
        if (active) setPreviewLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedMeta])

  const counts = useMemo(() => {
    const total = sessions.length
    const docs = sessions.filter((m) => Boolean(m.docPath)).length
    return { total, docs, free: total - docs }
  }, [sessions])

  const toggleChecked = (key: string): void => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleTogglePin = async (meta: GlobalChatMeta): Promise<void> => {
    await window.projectApi
      ?.setChatMeta?.({
        projectId: meta.projectId,
        chatId: meta.chatId,
        pinned: !meta.pinned,
      })
      .catch(() => undefined)
    await loadList(query)
  }

  const handleSaveRename = async (meta: GlobalChatMeta, draft: string): Promise<void> => {
    setRenaming(null)
    await window.projectApi
      ?.setChatMeta?.({
        projectId: meta.projectId,
        chatId: meta.chatId,
        title: draft,
      })
      .catch(() => undefined)
    await loadList(query)
  }

  const handleDeleteOne = async (meta: GlobalChatMeta): Promise<void> => {
    const label = sessionDisplayTitle(meta)
    const ok = await confirmBox({
      body: <p>{s.confirmDeleteOne.replace('{label}', label)}</p>,
      confirmLabel: s.confirmLabel,
      cancelLabel: s.cancelLabel,
      danger: true,
    })
    if (!ok) return
    await window.projectApi
      ?.deleteChat({ projectId: meta.projectId, chatId: meta.chatId })
      .catch(() => undefined)
    await loadList(query)
  }

  const handleBatchDelete = async (): Promise<void> => {
    const targets = visibleSessions
      .filter((m) => checkedKeys.has(sessionKeyOf(m.projectId, m.chatId)))
      .map((m) => ({ projectId: m.projectId, chatId: m.chatId }))
    if (targets.length === 0) return
    const ok = await confirmBox({
      body: <p>{s.confirmDeleteBatch.replace('{n}', String(targets.length))}</p>,
      confirmLabel: s.confirmLabel,
      cancelLabel: s.cancelLabel,
      danger: true,
    })
    if (!ok) return
    const api = window.projectApi
    if (api?.deleteChats) {
      await api.deleteChats({ targets }).catch(() => undefined)
    } else if (api) {
      for (const target of targets) {
        await api.deleteChat(target).catch(() => undefined)
      }
    }
    setCheckedKeys(new Set())
    setBatchMode(false)
    await loadList(query)
  }

  const handleCopyMarkdown = async (meta: GlobalChatMeta): Promise<void> => {
    const key = sessionKeyOf(meta.projectId, meta.chatId)
    const md = formatSessionMarkdown(meta, previewMessages, {
      user: s.roleUser,
      assistant: s.roleAssistant,
      doc: s.docLinkLabel,
    })
    try {
      await navigator.clipboard?.writeText(md)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1800)
    } catch {
      // Ignore clipboard write restrictions.
    }
  }

  const handleExportMarkdown = (meta: GlobalChatMeta): void => {
    const md = formatSessionMarkdown(meta, previewMessages, {
      user: s.roleUser,
      assistant: s.roleAssistant,
      doc: s.docLinkLabel,
    })
    const safeTitle = sessionDisplayTitle(meta).replace(/[<>:"/\\|?*]+/g, '_')
    downloadMarkdownFile(`${safeTitle || meta.chatId}.md`, md)
  }

  const formatDate = (iso: string): string => {
    const ts = Date.parse(iso)
    if (!Number.isFinite(ts)) return ''
    try {
      return new Intl.DateTimeFormat(dateLocale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ts))
    } catch {
      return iso.slice(0, 16)
    }
  }

  return (
    <main className="sessions-center">
      <header className="sessions-center-header">
        <div>
          <h1>{s.title}</h1>
          <p>{s.intro}</p>
        </div>
        <div className="sessions-center-stats">
          {s.statsSummary
            .replace('{total}', String(counts.total))
            .replace('{docs}', String(counts.docs))
            .replace('{free}', String(counts.free))}
        </div>
      </header>

      <div className="sessions-center-toolbar">
        <input
          type="search"
          className="sessions-center-search"
          placeholder={s.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <div className="sessions-center-filters" role="tablist" aria-label={s.title}>
          {(
            [
              ['all', s.filterAll],
              ['docs', s.filterDocs],
              ['free', s.filterFree],
              ['pinned', s.filterPinned],
              ['missing', s.filterMissing],
            ] as const
          ).map(([kind, label]) => (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={filter === kind}
              className={`sessions-center-filter${filter === kind ? ' active' : ''}`}
              onClick={() => setFilter(kind)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="sessions-center-tools-right">
          <select
            className="sessions-center-sort"
            aria-label={s.sortRecent}
            value={sort}
            onChange={(e) => setSort(e.currentTarget.value as SessionSortKind)}
          >
            <option value="recent">{s.sortRecent}</option>
            <option value="messages">{s.sortMessages}</option>
          </select>
          <button
            type="button"
            className="sessions-center-tool-btn"
            onClick={() => void loadList(query)}
            disabled={loading}
          >
            {s.refresh}
          </button>
          <button
            type="button"
            className={`sessions-center-tool-btn${batchMode ? ' active' : ''}`}
            onClick={() => {
              setBatchMode((was) => !was)
              setCheckedKeys(new Set())
            }}
          >
            {batchMode ? s.batchCancel : s.batchToggle}
          </button>
        </div>
      </div>

      {batchMode && (
        <div className="sessions-center-batch-bar">
          <button
            type="button"
            className="sessions-center-tool-btn"
            onClick={() =>
              setCheckedKeys(
                new Set(visibleSessions.map((m) => sessionKeyOf(m.projectId, m.chatId))),
              )
            }
          >
            {s.batchSelectAll}
          </button>
          <button
            type="button"
            className="sessions-center-tool-btn"
            onClick={() =>
              setCheckedKeys(
                new Set(
                  visibleSessions
                    .filter((m) => (m.docPath && m.docExists === false) || m.messageCount === 0)
                    .map((m) => sessionKeyOf(m.projectId, m.chatId)),
                ),
              )
            }
          >
            {s.batchSelectMissingOrEmpty}
          </button>
          <button
            type="button"
            className="sessions-center-tool-btn danger"
            disabled={checkedKeys.size === 0}
            onClick={() => void handleBatchDelete()}
          >
            {s.batchDelete.replace('{n}', String(checkedKeys.size))}
          </button>
        </div>
      )}

      <div className="sessions-center-body">
        <section className="sessions-center-list" aria-label={s.title}>
          {visibleSessions.length === 0 && !loading ? (
            <div className="sessions-center-empty">{s.emptyList}</div>
          ) : (
            visibleSessions.map((meta) => {
              const key = sessionKeyOf(meta.projectId, meta.chatId)
              const active = key === selectedKey
              const title = sessionDisplayTitle(meta)
              const ext = meta.docPath
                ? meta.docPath.slice(meta.docPath.lastIndexOf('.') + 1).toLowerCase()
                : ''
              return (
                <div
                  key={key}
                  className={`sessions-center-item${active ? ' active' : ''}`}
                  data-session-key={key}
                >
                  {batchMode && (
                    <input
                      type="checkbox"
                      className="sessions-center-checkbox"
                      checked={checkedKeys.has(key)}
                      onChange={() => toggleChecked(key)}
                    />
                  )}
                  <button
                    type="button"
                    className="sessions-center-item-btn"
                    onClick={() => (batchMode ? toggleChecked(key) : setSelectedKey(key))}
                  >
                    <span className="sessions-center-item-glyph">
                      {meta.docPath ? <FileBadge ext={ext} size={22} /> : '💬'}
                    </span>
                    <span className="sessions-center-item-main">
                      <span className="sessions-center-item-title-row">
                        <span className="sessions-center-item-title">{title}</span>
                        {meta.pinned && <span className="sessions-center-badge">📌</span>}
                        {meta.docPath && meta.docExists === false && (
                          <span className="sessions-center-badge missing">
                            {s.docBadgeMissing}
                          </span>
                        )}
                      </span>
                      {meta.lastMessagePreview && (
                        <span className="sessions-center-item-preview">
                          {meta.lastMessagePreview}
                        </span>
                      )}
                      <span className="sessions-center-item-meta">
                        <span>{meta.projectName ?? s.projectDefault}</span>
                        <span>·</span>
                        <span>{s.msgCount.replace('{n}', String(meta.messageCount))}</span>
                        <span>·</span>
                        <span>{formatDate(meta.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </section>

        <section className="sessions-center-preview">
          {!selectedMeta ? (
            <div className="sessions-center-empty">{s.noPreviewSelected}</div>
          ) : (
            <>
              <div className="sessions-center-preview-head">
                <div className="sessions-center-preview-title-wrap">
                  {renaming?.key === sessionKeyOf(selectedMeta.projectId, selectedMeta.chatId) ? (
                    <div className="sessions-center-rename-row">
                      <input
                        type="text"
                        autoFocus
                        value={renaming.draft}
                        onChange={(e) =>
                          setRenaming({ key: renaming.key, draft: e.currentTarget.value })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleSaveRename(selectedMeta, renaming.draft)
                          else if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveRename(selectedMeta, renaming.draft)}
                      >
                        {s.renameSave}
                      </button>
                      <button type="button" onClick={() => setRenaming(null)}>
                        {s.renameCancel}
                      </button>
                    </div>
                  ) : (
                    <h2>{sessionDisplayTitle(selectedMeta)}</h2>
                  )}
                  <div className="sessions-center-preview-sub">
                    {selectedMeta.docPath ? (
                      <>
                        <span className="sessions-center-doc-path" title={selectedMeta.docPath}>
                          {s.docLinkLabel}: {selectedMeta.docPath}
                        </span>
                        {selectedMeta.docExists === false && (
                          <span className="sessions-center-missing-hint">
                            {s.missingDocHint}
                          </span>
                        )}
                      </>
                    ) : (
                      <span>{s.freeChatLabel}</span>
                    )}
                  </div>
                </div>
                <div className="sessions-center-preview-actions">
                  {(selectedMeta.docExists !== false || !selectedMeta.docPath) && (
                    <button
                      type="button"
                      className="sessions-center-primary-btn"
                      onClick={() =>
                        onOpenSession({
                          projectId: selectedMeta.projectId,
                          chatId: selectedMeta.chatId,
                          docPath: selectedMeta.docPath ?? null,
                        })
                      }
                    >
                      {selectedMeta.docPath ? s.openDocContinue : s.continueInPanel}
                    </button>
                  )}
                  <button
                    type="button"
                    className="sessions-center-action-btn"
                    onClick={() =>
                      setRenaming({
                        key: sessionKeyOf(selectedMeta.projectId, selectedMeta.chatId),
                        draft: sessionDisplayTitle(selectedMeta),
                      })
                    }
                  >
                    {s.rename}
                  </button>
                  <button
                    type="button"
                    className="sessions-center-action-btn"
                    onClick={() => void handleTogglePin(selectedMeta)}
                  >
                    {selectedMeta.pinned ? s.unpin : s.pin}
                  </button>
                  <button
                    type="button"
                    className="sessions-center-action-btn"
                    onClick={() => void handleCopyMarkdown(selectedMeta)}
                  >
                    {copiedKey === sessionKeyOf(selectedMeta.projectId, selectedMeta.chatId)
                      ? s.copiedMarkdown
                      : s.copyMarkdown}
                  </button>
                  <button
                    type="button"
                    className="sessions-center-action-btn"
                    onClick={() => handleExportMarkdown(selectedMeta)}
                  >
                    {s.exportMarkdown}
                  </button>
                  <button
                    type="button"
                    className="sessions-center-action-btn danger"
                    onClick={() => void handleDeleteOne(selectedMeta)}
                  >
                    {s.deleteOne}
                  </button>
                </div>
              </div>

              <div className="sessions-center-transcript">
                {previewLoading ? null : previewMessages.length === 0 ? (
                  <div className="sessions-center-empty">{s.previewEmptyChat}</div>
                ) : (
                  previewMessages.map((msg, idx) => (
                    <article
                      key={idx}
                      className={`sessions-center-msg ${msg.role === 'user' ? 'is-user' : 'is-assistant'}`}
                    >
                      <div className="sessions-center-msg-role">
                        {msg.role === 'user' ? s.roleUser : s.roleAssistant}
                      </div>
                      <div className="sessions-center-msg-body">
                        <Markdown text={msg.text} />
                      </div>
                    </article>
                  ))
                )}
              </div>
            </>
          )}
        </section>
      </div>
      {confirmDialog}
    </main>
  )
}
