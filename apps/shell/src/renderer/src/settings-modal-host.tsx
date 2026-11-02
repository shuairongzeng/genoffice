import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountStatus } from '../../shared/home-api'
import { useI18n } from './locale'
import { SettingsModal } from './SettingsModal'
import type { SettingsTarget } from './SettingsModal'
import { skillUpdateDue } from './IntegrationsPane'

// ── the settings modal's host ────────────────────────────
// The retired sidebar's account entry owned the modal; the modal outlived it.
// This host keeps that half: it opens on every existing opener (the dock's
// 设置中心 launcher, the ask panel's scope CTA, deep links through Home's
// settingsRequest), reports its live state up (the dock's running dots and
// the doc-mode open-target report), and carries the Genspark login
// machinery the modal's account section needs — the polling, the device-code
// rescue, the logout guard. The account ROW is gone with the sidebar: the
// login surface is the modal's own account section, and while a device-code
// login runs with the modal closed, the rescue hint floats at the window's
// bottom-left (the dock is centered; the corner is free).

const LOGIN_POLL_MS = 2500
/** fallback deadline when the CLI does not report expires_in (device codes live ~300s) */
const LOGIN_MAX_WAIT_MS = 300_000

export function SettingsModalHost({
  onStatusChange,
  onFileSearchSettingsChange,
  openRequest,
  closeRequest,
  onOpenChange,
  onSectionChange,
}: {
  onStatusChange?: (status: AccountStatus | null) => void
  onFileSearchSettingsChange?: () => void
  /** a fresh object per request: the home list asks to open the modal on a given block */
  openRequest?: SettingsTarget | null
  /**
   * The imperative close signal (the dock context menu's 关闭标签, routed
   * through the dock-nav intent): Home bumps the counter, this closes the
   * modal. A counter rather than a boolean so every bump is its own edge.
   */
  closeRequest?: number
  /** the modal's open state, reported up (the dock's running dots) */
  onOpenChange?: (open: boolean) => void
  /** the modal's live section, reported up (the plugins pane's dot) */
  onSectionChange?: (section: SettingsTarget['section']) => void
}) {
  const { t } = useI18n()
  const [status, setStatus] = useState<AccountStatus | null>(null)

  useEffect(() => {
    onStatusChange?.(status)
  }, [status, onStatusChange])
  const [waiting, setWaiting] = useState(false)
  // incremented on login retry, resetting the polling timer
  const [loginNonce, setLoginNonce] = useState(0)
  // the login failure kind (its text fed the retired account row; the
  // state stays so the polling's transitions keep one shape)
  const [, setLoginError] = useState<
    'timeout' | 'launch' | 'network' | 'expired' | 'failed' | null
  >(null)
  // auth URL reported by the login CLI — rescue entry when the browser did not open
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [urlCopied, setUrlCopied] = useState(false)
  const loginDeadline = useRef(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [skillUpdate, setSkillUpdate] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  // bumped on logout so an in-flight status refresh (which can still
  // report logged-in) is discarded instead of resurrecting the UI
  const statusSeq = useRef(0)

  // query login state once on mount
  useEffect(() => {
    let alive = true
    void window.aiOffice.accountStatus?.().then((s) => {
      if (alive) setStatus(s)
    })
    return () => {
      alive = false
    }
  }, [])

  // the skill state is a few file reads; re-probe after the modal closes so an
  // update done inside it clears the dot
  useEffect(() => {
    if (settingsOpen) return
    let alive = true
    void window.aiOfficeIntegrations?.status().then((st) => {
      if (alive) setSkillUpdate(skillUpdateDue(st))
    })
    return () => {
      alive = false
    }
  }, [settingsOpen])

  // login progress pushed from main (gsk login CLI output)
  useEffect(() => {
    const off = window.aiOffice.onAccountLogin?.((ev) => {
      if (ev.phase === 'url') {
        if (ev.url) setAuthUrl(ev.url)
        if (ev.expiresInSec) loginDeadline.current = Date.now() + ev.expiresInSec * 1000
      } else if (ev.phase === 'success') {
        void window.aiOffice.accountStatus().then((s) => {
          if (s.loggedIn) {
            setStatus(s)
            setWaiting(false)
            setAuthUrl(null)
          }
        })
      } else if (ev.phase === 'error') {
        setWaiting(false)
        setAuthUrl(null)
        setLoginError(
          ev.error === 'network' ? 'network' : ev.error === 'expired' ? 'expired' : 'failed',
        )
      }
    })
    return off
  }, [])

  // config-file polling stays as the fallback success path (works even if progress events are lost)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void window.aiOffice.accountStatus().then((s) => {
        if (s.loggedIn) {
          setStatus(s)
          setWaiting(false)
          setAuthUrl(null)
        } else if (Date.now() > loginDeadline.current) {
          setWaiting(false)
          setAuthUrl(null)
          setLoginError('timeout')
        }
      })
    }, LOGIN_POLL_MS)
    return () => clearInterval(timer)
  }, [waiting, loginNonce])

  const doLogout = () => {
    setLoggingOut(true)
    statusSeq.current++
    void window.aiOffice.accountLogout().then(() => {
      setLoggingOut(false)
      setStatus({ loggedIn: false })
    })
  }

  const startLogin = () => {
    // clicking again while waiting = relaunch the login (main kills the stale CLI, so the new device code is the live one)
    setLoginError(null)
    setWaiting(true)
    setAuthUrl(null)
    setUrlCopied(false)
    loginDeadline.current = Date.now() + LOGIN_MAX_WAIT_MS
    setLoginNonce((n) => n + 1)
    void window.aiOffice.accountLogin().then((launched) => {
      if (!launched) {
        setWaiting(false)
        setLoginError('launch')
      }
    })
  }

  const openLoginUrl = () => void window.aiOffice.openLoginUrl?.()

  const copyLoginUrl = () => {
    if (!authUrl) return
    void navigator.clipboard.writeText(authUrl).then(() => {
      setUrlCopied(true)
      window.setTimeout(() => setUrlCopied(false), 2000)
    })
  }

  const [target, setTarget] = useState<SettingsTarget | null>(null)
  const openSettings = useCallback((to: SettingsTarget | null) => {
    // refresh the login state / credit balance; drop the response
    // when a logout happened while it was in flight
    const seq = statusSeq.current
    void window.aiOffice.accountStatus?.().then((s) => {
      if (seq === statusSeq.current) setStatus(s)
    })
    setTarget(to)
    setSettingsOpen(true)
  }, [])
  useEffect(() => {
    if (openRequest) openSettings(openRequest)
  }, [openRequest, openSettings])
  // the dock's close verb: each bump of the counter is one close edge (the
  // initial 0 mounts without one)
  useEffect(() => {
    if (!closeRequest) return
    setSettingsOpen(false)
    setTarget(null)
  }, [closeRequest])
  // the modal's state rides up to Home (the dock's running dots and the
  // doc-mode open-target report)
  useEffect(() => {
    onOpenChange?.(settingsOpen)
  }, [settingsOpen, onOpenChange])

  return (
    <>
      {settingsOpen && (
        <SettingsModal
          status={status}
          loggingOut={loggingOut}
          loginWaiting={waiting}
          loginUrl={authUrl}
          urlCopied={urlCopied}
          onOpenLoginUrl={openLoginUrl}
          onCopyLoginUrl={copyLoginUrl}
          onClose={() => setSettingsOpen(false)}
          onSectionChange={onSectionChange}
          onFileSearchChange={onFileSearchSettingsChange}
          onLogin={() => {
            setSettingsOpen(false)
            startLogin()
          }}
          onLogout={doLogout}
          skillUpdateDue={skillUpdate}
          onSkillUpdateDue={setSkillUpdate}
          target={target}
        />
      )}
      {!settingsOpen && waiting && authUrl && (
        <div className="login-hint login-hint-floating" role="status">
          <button className="login-hint-open" onClick={openLoginUrl}>
            {t('loginOpenShort')}
          </button>
          <button
            className={`login-hint-copy${urlCopied ? ' copied' : ''}`}
            onClick={copyLoginUrl}
            // static tip: screentips are suppressed from pointerdown until the pointer
            // leaves the control, so a swapped-in "copied" tip would never show — the
            // check-mark icon is the visible feedback
            data-tip={t('loginCopyUrl')}
            aria-label={urlCopied ? t('loginCopied') : t('loginCopyUrl')}
          >
            {urlCopied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="m3.5 8.5 3 3 6-7"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect
                  x="5.5"
                  y="5.5"
                  width="7"
                  height="7"
                  rx="1.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M3.5 10.5V5a1.5 1.5 0 0 1 1.5-1.5h5.5"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>
      )}
    </>
  )
}
