import React from 'react'
import { createRoot } from 'react-dom/client'
import { htmlDir, htmlLang } from '@genoffice/i18n'
import { AppFrame } from './AppFrame'
import { LocaleProvider } from './locale'
import { AskPanelEntry, isAskPanelView } from './panel-entry'
import { DockEntry, isDockView } from './dock-entry'
import { TopBarEntry, isTopBarView } from './topbar-entry'
import '@genoffice/ui/tokens.css'
import '@genoffice/ui/screentip.css'
import '@genoffice/ui/dropdown.css'
import '@genoffice/ui/ai-model-picker.css'
import '@genoffice/ui/ai-usage.css'
import '@genoffice/ui/ai-skills.css'
import '@genoffice/ui/ai-panel.css'
import '@genoffice/ui/ai-confirm-card.css'
import '@genoffice/ui/scrollbar.css'
import './home.css'
import { ButlerHudEntry, isButlerHudView } from './butler-hud-entry'
import { applyAiPanelPrefs, installScreenTips } from '@genoffice/ui'
import { loadStrings } from './strings'

installScreenTips()

// macOS shell window is created with vibrancy; a transparent body lets the
// editor views' translucent regions (e.g. slides thumbnail pane) show it
const IS_MAC = navigator.platform.toLowerCase().includes('mac')
if (IS_MAC) document.body.classList.add('vib')
// non-mac: the workbench chrome doubles as the title bar (the caption buttons
// overlay the window's top-right; home.css keeps the dock head clear of them)
document.body.classList.add(IS_MAC ? 'mac' : 'overlay-title-bar')

const params = new URLSearchParams(location.search)
const isHelp = params.get('mode') === 'help'
const isMedia = params.get('view') === 'media'
const isCompare = params.get('view') === 'compare'
const isTerminal = params.get('view') === 'terminal'
// The ask panel's standalone mount (?view=ask-panel): the panel alone, the
// surface W2's native overlay view above documents loads. Like the manual,
// it shares this boot (language, theme, panel prefs) but renders none of
// the workbench around it.
const isAskPanel = isAskPanelView()
// The dock's standalone mount (?view=dock): the fisheye dock alone, the
// surface the doc-mode native overlay loads above covering documents. Like
// the ask panel it shares this boot but renders none of the workbench —
// and deliberately runs no panel-entry logic: no prefs subscription, no
// ready ping (the ask panel's buffered-message handshake is not this
// surface's contract; its shape is main's state machine)
const isDock = isDockView()
const isTopBar = isTopBarView()
const isButlerHud = isButlerHudView()

const snap =
  !isHelp &&
  !isMedia &&
  !isCompare &&
  !isTerminal &&
  !isAskPanel &&
  !isDock &&
  !isTopBar &&
  !isButlerHud
    ? window.aiOffice.bootSnapshot
    : undefined

const bootPrefsPromise = snap
  ? Promise.resolve([snap.lang, snap.onboardingSeen, snap.theme] as const)
  : Promise.all([
      window.aiOffice.getLanguage(),
      // if the flag is unreadable, skip onboarding rather than block the home screen
      window.aiOffice.onboardingSeen().catch(() => true),
      window.aiOffice.getTheme().catch(() => 'system' as const),
    ])

function notifyFirstPaintReady(): void {
  const signal = window.aiOffice.signalFirstPaint
  if (!signal) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      signal()
    })
  })
}

// resolve the persisted language, first-run flag, and theme before first paint
// so the UI never flashes (home showing briefly before the onboarding overlay)
void bootPrefsPromise.then(async ([lang, onboardingSeen, theme]) => {
  document.documentElement.lang = htmlLang(lang)
  document.documentElement.dir = htmlDir(lang)
  // apply theme attribute before first paint to avoid flash
  if (theme !== 'system') {
    document.documentElement.setAttribute('data-theme', theme)
  }
  window.aiOffice.onThemeChanged((next) => {
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  })
  // AI panel prefs feed useAiPanelPrefs() consumers (KbAskPanel's streaming and
  // tool-call switches); the shell main broadcasts every change
  void window.aiOffice
    .getAiPanelPrefs()
    .then(applyAiPanelPrefs)
    .catch(() => undefined)
  window.aiOffice.onAiPanelPrefsChanged?.(applyAiPanelPrefs)
  // fetch only the current language's dictionary before first paint; switching
  // later loads the new one before the re-render
  await loadStrings(lang)
  const HelpScreen = React.lazy(() =>
    import('./i18n/help/HelpScreen').then((m) => ({ default: m.HelpScreen })),
  )
  const MediaViewer = React.lazy(() =>
    import('./MediaViewer').then((m) => ({ default: m.MediaViewer })),
  )
  const CompareView = React.lazy(() =>
    import('./CompareView').then((m) => ({ default: m.CompareView })),
  )
  const TerminalView = React.lazy(() =>
    import('./terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
  )
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <LocaleProvider initial={lang}>
        {isAskPanel ? (
          <AskPanelEntry />
        ) : isDock ? (
          <DockEntry />
        ) : isTopBar ? (
          <TopBarEntry />
        ) : isButlerHud ? (
          <ButlerHudEntry />
        ) : isCompare ? (
          <React.Suspense fallback={<div className="boot" />}>
            <CompareView />
          </React.Suspense>
        ) : isTerminal ? (
          <React.Suspense fallback={<div className="boot" />}>
            <TerminalView />
          </React.Suspense>
        ) : isMedia ? (
          <React.Suspense fallback={<div className="boot" />}>
            <MediaViewer />
          </React.Suspense>
        ) : isHelp ? (
          <React.Suspense fallback={<div className="boot" />}>
            <HelpScreen />
          </React.Suspense>
        ) : (
          <AppFrame initialOnboardingSeen={onboardingSeen} />
        )}
      </LocaleProvider>
    </React.StrictMode>,
  )
  notifyFirstPaintReady()
})
