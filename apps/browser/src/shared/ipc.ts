import type { Lang } from '@genoffice/i18n'
import type { BrowserAnnotation } from './annotations'

/** the theme the shell persists (app-settings.json `theme`) */
export type BrowserUiTheme = 'light' | 'dark' | 'system'

/** the live state of one browser tab's page, pushed to the chrome renderer */
export interface BrowserPageState {
  /** the page's current URL ('' before the first navigation) */
  url: string
  /** the page's title (the address host before the page reports one) */
  title: string
  /** the page's favicon URL, when it published one */
  faviconUrl: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** a navigation the policy refused (disallowed scheme): the chrome explains it */
  blockedUrl: string | null
  /** the annotation picker is on: the page shows the hover highlight, the chrome's toggle stays pressed */
  annotateMode: boolean
}

/** the annotate state main pushes into a page view's preload */
export interface PageAnnotateState {
  /** the picker is on: hover highlight + click-to-pin; off: markers only */
  mode: boolean
  /** the suite's UI language — the overlay resolves its strings from it */
  lang: Lang
  /** the annotations saved for the page being shown (hash-stripped URL key) */
  annotations: readonly BrowserAnnotation[]
}

export interface BrowserApi {
  /** resolve address-bar input (URL or search terms) and load it; answers the URL used */
  navigate(input: string): Promise<{ url: string }>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  /** toggle the page's annotation picker (hover highlight + click-to-pin) */
  setAnnotateMode(on: boolean): void
  /** the tab's current state (a freshly mounted chrome starts from it) */
  getState(): Promise<BrowserPageState | null>
  /** subscribe to state pushes; returns unsubscribe */
  onState(handler: (state: BrowserPageState) => void): () => void
  /** report the content area's rect (view-local px) so the page view can overlay it */
  reportContentRect(rect: { x: number; y: number; width: number; height: number }): void
  getLanguage(): Promise<Lang>
  onLanguageChanged(handler: (lang: Lang) => void): () => void
  getTheme(): Promise<BrowserUiTheme>
  onThemeChanged(handler: (theme: BrowserUiTheme) => void): () => void
}

export const BROWSER_CHANNELS = {
  navigate: 'browser:navigate',
  goBack: 'browser:go-back',
  goForward: 'browser:go-forward',
  reload: 'browser:reload',
  stop: 'browser:stop',
  getState: 'browser:get-state',
  stateChanged: 'browser:state-changed',
  contentRect: 'browser:content-rect',
  // ── annotations ──────────────────────────────────────────────────────────
  // The chrome owns the toggle (annotateMode rides the state fold); the page
  // view's preload owns the overlay (it runs in the page's isolated world and
  // never exposes a context-bridge surface, so the untrusted page cannot
  // originate any of the page-annotate messages). The ask-about channel is
  // main → the shell window's renderer: the Home AI dock consumes it as a
  // parked question draft (park-into-draft semantics — never auto-sent).
  /** chrome → main: the annotate toggle's new state */
  setAnnotateMode: 'browser:set-annotate-mode',
  /** main → page preload: the full annotate state for the shown page */
  pageAnnotateState: 'browser:page-annotate-state',
  /** page preload → main: fetch the annotate state at overlay startup (invoke) */
  pageAnnotateSync: 'browser:page-annotate-sync',
  /** page preload → main: pin the hovered element as a new annotation */
  pageAnnotatePin: 'browser:page-annotate-pin',
  /** page preload → main: update one annotation's note */
  pageAnnotateNote: 'browser:page-annotate-note',
  /** page preload → main: delete one annotation */
  pageAnnotateDelete: 'browser:page-annotate-delete',
  /** page preload → main: hand one annotation to the Home AI dock */
  pageAnnotateAsk: 'browser:page-annotate-ask',
  /** page preload → main: Esc pressed inside the picker — exit it */
  pageAnnotateExit: 'browser:page-annotate-exit',
  /** main → shell renderer: one annotation handed to the Home AI dock (browser:ask-about) */
  askAbout: 'browser:ask-about',
  // language/theme ride the app-wide channels the shell (and the other apps)
  // already serve, so the browser chrome follows a language switch like every
  // editor tab does
  getLanguage: 'app:get-language',
  languageChanged: 'app:language-changed',
  getTheme: 'app:get-theme',
  themeChanged: 'app:theme-changed',
} as const
