import { useCallback, useEffect, useRef, useState } from 'react'
import type { Lang } from '@genoffice/i18n'
import type { HomeApi, KbRecallHit, KbSourceEntry, KbSourcesReport } from '../../shared/home-api'
import { KB_CENTER_STRINGS } from './kb-center-strings'

/**
 * The Knowledge Base center (知识库): a Home surface — the recents/starred
 * pattern, not a modal — opened by the desktop's KB tile. Three jobs:
 *
 * - Sources: every folder root plus every indexed file outside the roots,
 *   each with its readiness (ready / indexing / error / empty), a remove
 *   verb, and the add-folder / add-files pickers. The remove verb is honest
 *   about what it does: a folder root leaves the desktop's knowledge
 *   folders (the folder stays on disk); a file source leaves the corpus by
 *   un-starring and un-recenting it — the index follows at the next
 *   refresh, because those lists ARE the file sources.
 * - The recall test (召回测试): a full-index search — no scope narrowing,
 *   the center tests the whole KB — answered as the top hits with their
 *   matched excerpt, so the person can verify retrieval quality before
 *   trusting the corpus (the Cherry Studio/Dify pattern).
 * - Reindex (重建索引): a genuine rebuild — a file source drops and
 *   re-extracts, a folder's entries drop and the re-walk rebuilds them,
 *   the global verb drops every errored entry first so the scan's diff
 *   (which only re-extracts changed files) cannot leave an error frozen.
 *
 * Everything rides the kb:* channels; the bridge is partial-tolerant like
 * every Home surface (a stale preload keeps the view's own chrome, with
 * the verbs disabled rather than dead).
 */
export function KbCenterView({
  lang,
  onOpenScopeSettings,
}: {
  lang: Lang
  /** the scope settings entry where it already lives: Settings › General */
  onOpenScopeSettings: () => void
}): React.JSX.Element {
  const s = KB_CENTER_STRINGS[lang] ?? KB_CENTER_STRINGS.en
  const api = window.aiOffice as Partial<HomeApi>

  // ── the sources report: pulled on mount and after every verb that can
  // change it (add/remove/reindex) — plus a poll while the pipeline runs,
  // because "indexing" is a state the view cannot push-subscribe to
  const [report, setReport] = useState<KbSourcesReport | null>(null)
  const [verbsBusy, setVerbsBusy] = useState(false)
  const refresh = useCallback(() => {
    if (typeof api.kbSources !== 'function') return Promise.resolve()
    return api
      .kbSources()
      .then((next) => setReport(next))
      .catch(() => undefined)
  }, [api])
  useEffect(() => {
    void refresh()
  }, [refresh])
  // the poll: only while a scan is in flight, a settled report stops it
  const pollingRef = useRef(false)
  useEffect(() => {
    if (report?.scanning !== true) {
      pollingRef.current = false
      return
    }
    if (pollingRef.current) return
    pollingRef.current = true
    const timer = window.setInterval(() => {
      void api
        .kbSources?.()
        .then((next) => {
          setReport(next)
          if (next.scanning !== true) pollingRef.current = false
        })
        .catch(() => undefined)
    }, 1500)
    return () => {
      window.clearInterval(timer)
      pollingRef.current = false
    }
  }, [report?.scanning, api])

  const runVerb = (verb: () => unknown): void => {
    setVerbsBusy(true)
    Promise.resolve(verb())
      .catch(() => undefined)
      .finally(() => {
        setVerbsBusy(false)
        void refresh()
      })
  }

  const addFolder = (): void => {
    void runVerb(() => api.addFolderRoot?.())
  }
  const addFiles = (): void => {
    void runVerb(() => api.kbPickSourceFiles?.())
  }

  /** the remove verb: honest about the mechanism — the folder root leaves
   *  the knowledge folders; a file source leaves the corpus by un-starring
   *  and un-recenting (the extra-path sources that put it in the index) */
  const removeSource = (source: KbSourceEntry): void => {
    void runVerb(async () => {
      if (source.kind === 'folder') {
        await api.removeFolderRoot?.(source.path)
        return
      }
      await api.unstarPaths?.([source.path])
      await api.removeRecent?.([source.path])
    })
  }

  const reindex = (path?: string): void => {
    void runVerb(() => api.kbReindex?.(path !== undefined ? { path } : {}))
  }

  const canVerb = (fn: unknown): boolean => !verbsBusy && typeof fn === 'function'

  const statusLabel = (status: KbSourceEntry['status']): string =>
    status === 'ready'
      ? s.statusReady
      : status === 'indexing'
        ? s.statusIndexing
        : status === 'error'
          ? s.statusError
          : s.statusEmpty

  // ── the recall test: the input, the run, the hits
  const [recallQuery, setRecallQuery] = useState('')
  const [recallRunning, setRecallRunning] = useState(false)
  const [recallHits, setRecallHits] = useState<KbRecallHit[] | null>(null)
  const runRecall = (): void => {
    const q = recallQuery.trim()
    if (!q || recallRunning || typeof api.kbRecallTest !== 'function') return
    setRecallRunning(true)
    setRecallHits(null)
    void api
      .kbRecallTest({ q, limit: 5 })
      .then((hits) => setRecallHits(hits))
      .catch(() => setRecallHits([]))
      .finally(() => setRecallRunning(false))
  }

  return (
    <main className="kb-center">
      <header className="kb-center-header">
        <h1>{s.title}</h1>
        <p>{s.intro}</p>
        <button type="button" className="kb-center-scope-link" onClick={onOpenScopeSettings}>
          {s.scopeSettings}
        </button>
      </header>

      <section className="kb-center-sources" aria-label={s.sourcesTitle}>
        <div className="kb-center-section-head">
          <h2>{s.sourcesTitle}</h2>
          <div className="kb-center-verbs">
            <button type="button" onClick={addFolder} disabled={!canVerb(api.addFolderRoot)}>
              {s.addFolder}
            </button>
            <button type="button" onClick={addFiles} disabled={!canVerb(api.kbPickSourceFiles)}>
              {s.addFiles}
            </button>
            <button type="button" onClick={() => reindex()} disabled={!canVerb(api.kbReindex)}>
              {s.reindexAll}
            </button>
          </div>
        </div>
        {report?.scanning === true && (
          <p className="kb-center-scanning" role="status">
            {s.scanning.replace('{n}', String(report.pending))}
          </p>
        )}
        {report?.truncated === true && <p className="kb-center-truncated">{s.truncated}</p>}
        <ul className="kb-center-source-list">
          {(report?.sources ?? []).map((source) => (
            <li
              key={`${source.kind}:${source.path}`}
              className={`kb-center-source is-${source.status}`}
            >
              <span className="kb-center-source-kind" aria-hidden="true">
                {source.kind === 'folder' ? '📁' : '📄'}
              </span>
              <span className="kb-center-source-name" title={source.path}>
                {source.name}
              </span>
              <span className={`kb-center-source-status status-${source.status}`}>
                {statusLabel(source.status)}
              </span>
              {source.kind === 'folder' && (source.indexed > 0 || source.errors > 0) && (
                <span className="kb-center-source-counts">
                  {s.countsFolder
                    .replace('{i}', String(source.indexed))
                    .replace('{e}', String(source.errors))}
                </span>
              )}
              <span className="kb-center-source-actions">
                <button
                  type="button"
                  className="kb-center-source-verb"
                  onClick={() => reindex(source.path)}
                  disabled={!canVerb(api.kbReindex)}
                >
                  {s.reindex}
                </button>
                <button
                  type="button"
                  className="kb-center-source-verb danger"
                  onClick={() => removeSource(source)}
                  disabled={!canVerb(api.removeFolderRoot) && !canVerb(api.unstarPaths)}
                >
                  {s.remove}
                </button>
              </span>
            </li>
          ))}
        </ul>
        {report !== null && report.sources.length === 0 && !report.scanning && (
          <p className="kb-center-sources-empty">{s.sourcesEmpty}</p>
        )}
      </section>

      <section className="kb-center-recall" aria-label={s.recallTitle}>
        <h2>{s.recallTitle}</h2>
        <div className="kb-center-recall-form">
          <input
            type="text"
            value={recallQuery}
            placeholder={s.recallPlaceholder}
            aria-label={s.recallTitle}
            onChange={(event) => setRecallQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                runRecall()
              }
            }}
          />
          <button
            type="button"
            onClick={runRecall}
            disabled={
              !recallQuery.trim() || recallRunning || typeof api.kbRecallTest !== 'function'
            }
          >
            {recallRunning ? s.recallRunning : s.recallRun}
          </button>
        </div>
        {recallHits !== null && (
          <p className="kb-center-recall-count">
            {recallHits.length > 0
              ? s.recallHits.replace('{n}', String(recallHits.length))
              : s.recallNone}
          </p>
        )}
        {recallHits !== null && recallHits.length > 0 && (
          <ol className="kb-center-recall-hits">
            {recallHits.map((hit) => (
              <li key={hit.path} className="kb-center-recall-hit">
                <span className="kb-center-recall-path" title={hit.path}>
                  {hit.name}
                </span>
                {hit.snippet && (
                  <blockquote className="kb-center-recall-snippet">{hit.snippet}</blockquote>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  )
}
