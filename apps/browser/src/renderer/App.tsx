import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'

import { useI18n } from './i18n/locale'
import type { BrowserPageState } from '../shared/ipc'

/**
 * The browser tab's chrome: navigation controls and the address bar. The page
 * itself renders in a sibling WebContentsView the main process bounds to this
 * component's content area (window coordinates: this view's bounds plus the
 * rect reported below) — everything below the toolbar belongs to the page
 * view, which is why the empty hint only ever shows before the first
 * navigation.
 */
export default function App(): ReactElement {
  const { t } = useI18n()
  const [page, setPage] = useState<BrowserPageState | null>(null)
  /** the address bar's in-progress text; null while it mirrors the page URL */
  const [editing, setEditing] = useState<string | null>(null)
  const [faviconBroken, setFaviconBroken] = useState(false)
  /** the docked AI panel's strip width (window px): the toolbar pads itself
   *  clear of it; 0 while the panel floats collapsed or away */
  const [drawerInset, setDrawerInset] = useState(0)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => window.browserApi.onDrawerInset(setDrawerInset), [])

  useEffect(() => {
    let alive = true
    void window.browserApi.getState().then((state) => {
      if (alive && state) setPage(state)
    })
    const off = window.browserApi.onState((state) => setPage(state))
    return () => {
      alive = false
      off()
    }
  }, [])

  // the content area's rect, in this view's own pixels: the main process
  // bounds the sibling page view to this rect offset by this view's own
  // bounds, on mount and on resize
  useEffect(() => {
    const node = contentRef.current
    if (!node) return
    const report = (): void => {
      const rect = node.getBoundingClientRect()
      window.browserApi.reportContentRect({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setFaviconBroken(false)
  }, [page?.faviconUrl])

  const submit = useCallback((input: string) => {
    const value = input.trim()
    if (value === '') return
    void window.browserApi.navigate(value)
    setEditing(null)
  }, [])

  const onAddressKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') submit(event.currentTarget.value)
      else if (event.key === 'Escape') {
        setEditing(null)
        event.currentTarget.blur()
      }
    },
    [submit],
  )

  const address = editing ?? page?.url ?? ''
  const loading = page?.loading ?? false
  const faviconUrl = page?.faviconUrl ?? null
  const showFavicon = faviconUrl !== null && !faviconBroken && page?.url !== ''

  return (
    <div className="browser-chrome">
      {/* paddingRight keeps the annotate verb clear of the docked AI panel:
          the page view narrows main-side, this row shortens to match */}
      <div
        className="browser-toolbar"
        role="toolbar"
        style={drawerInset > 0 ? { paddingRight: drawerInset + 10 } : undefined}
      >
        <button
          type="button"
          className="browser-nav"
          disabled={!page?.canGoBack}
          aria-label={t('btnBack')}
          title={t('btnBack')}
          onClick={() => window.browserApi.goBack()}
        >
          <BackIcon />
        </button>
        <button
          type="button"
          className="browser-nav"
          disabled={!page?.canGoForward}
          aria-label={t('btnForward')}
          title={t('btnForward')}
          onClick={() => window.browserApi.goForward()}
        >
          <ForwardIcon />
        </button>
        <button
          type="button"
          className="browser-nav"
          aria-label={loading ? t('btnStop') : t('btnReload')}
          title={loading ? t('btnStop') : t('btnReload')}
          onClick={() => (loading ? window.browserApi.stop() : window.browserApi.reload())}
        >
          {loading ? <StopIcon /> : <ReloadIcon />}
        </button>
        <div className={`browser-address${loading ? ' loading' : ''}`}>
          {showFavicon && (
            <img
              className="browser-favicon"
              src={faviconUrl ?? undefined}
              alt=""
              onError={() => setFaviconBroken(true)}
            />
          )}
          <input
            type="text"
            spellCheck={false}
            autoComplete="off"
            aria-label={t('addressLabel')}
            placeholder={t('addressPlaceholder')}
            value={address}
            onFocus={(event) => {
              setEditing(event.currentTarget.value)
              event.currentTarget.select()
            }}
            onChange={(event) => setEditing(event.currentTarget.value)}
            onKeyDown={onAddressKeyDown}
            onBlur={() => setEditing(null)}
          />
        </div>
        <button
          type="button"
          className={`browser-nav browser-annotate${page?.annotateMode ? ' on' : ''}`}
          disabled={!page?.url}
          aria-pressed={page?.annotateMode === true}
          aria-label={t('btnAnnotate')}
          title={t('btnAnnotate')}
          onClick={() => window.browserApi.setAnnotateMode(!page?.annotateMode)}
        >
          <AnnotateIcon />
        </button>
      </div>
      {page?.blockedUrl && (
        <div className="browser-blocked">{t('blockedNavigation', { url: page.blockedUrl })}</div>
      )}
      <div ref={contentRef} className="browser-content">
        {!page?.url && (
          <div className="browser-empty">
            <GlobeIcon />
            <p>{t('emptyHint')}</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── toolbar glyphs (theme ink; no document data lives in this UI) ──────────

function BackIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.5 3.5 5 8l4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ForwardIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 3.5 11 8l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ReloadIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StopIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function GlobeIcon(): ReactElement {
  return (
    <svg width="40" height="40" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.8 8h12.4M2.6 5h10.8M2.6 11h10.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** a marker pen: the annotate toggle's glyph (theme ink; no document data) */
function AnnotateIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.8 2.6l2.6 2.6-7.2 7.2-3.4.8.8-3.4 7.2-7.2z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.6 3.8l2.6 2.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}
