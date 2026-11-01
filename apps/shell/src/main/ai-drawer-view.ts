import { join } from 'node:path'
import { shell, WebContentsView } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

import { rendererUrl, safeExternalUrl } from '@genoffice/electron-utils'
import { drawerOverlayBounds, type AiDockPrefs } from '../shared/desktop-geometry'
import { applyUiScaleTo } from './ui-scale'

/**
 * The AI drawer's native overlay (W2). While a document tab is active, its
 * WebContentsView paints above the whole Home renderer — the HTML drawer and
 * the pet included — so the drawer's open state drives this sibling view
 * instead: a WebContentsView at the window's right edge, as wide as
 * `aiDockWidth()` and the full content height (drawerOverlayBounds), loading
 * the shell renderer's ask-panel mount (`?view=ask-panel`, the same
 * one-bundle-two-branches trick the manual plays with `?mode=help`). The
 * entry renders the panel plus the floating pet — the overlay's only click
 * affordance, since the drawer head and scrim belong to the Home surface the
 * document is covering (the keyboard's Esc answers inside the panel itself).
 *
 * Z-order: the view sits above every document/browser view of the window's
 * contentView — addChildView re-adds an existing child as the topmost
 * (documented Electron semantics), so every shown sync re-asserts it over
 * views added while the drawer is open (a tab opened mid-conversation, a
 * browser tab's page sibling). Pinned desktop widgets would outrank it — they
 * are child *windows* of the shell, and the OS stacks a child window above
 * its parent's content however the views are ordered — but that ordering is
 * unreachable in practice: widgets show only while Home is the active tab
 * (setPinsHostSurfaceActive), and the overlay exists only while a document
 * is. Had both ever shown, the intent is the overlay's — it is a temporary
 * floating layer over a presentation of work, the widget is furniture — so
 * this is recorded as a known, benign gap rather than fought with window
 * re-parenting.
 *
 * Mounting and hiding, never destroying on state changes: the view is created
 * lazily (the first time the drawer opens over a document) and then survives
 * drawer closes, tab switches and HTML fullscreen hidden — the same
 * "the panel stays mounted, closing only hides it" contract the HTML drawer
 * keeps (a streaming answer keeps streaming). It dies with the shell window,
 * like every tab view — an in-flight AgentLoop in this copy is interrupted,
 * the same tradeoff closing the window already makes. The Home renderer's
 * own panel copy is a second, independent session: each mount claims its own
 * chat id (P0-1 — the overlay's is `kb-overlay-ask`, Home's is `kb-ask`), so
 * a question asked over a document is not in Home's thread list and vice
 * versa. Ask-intent handoffs that arrive while this view is the visible
 * drawer are forwarded to it through the main process (P0-2, see
 * deliverToPanel), with Home's covered copy kept out of the routing.
 *
 * The panel entry's URL rides the `help` scheme host — the shell renderer's
 * own root in the renderer protocol (`installRendererProtocol` maps `help` to
 * the shell's renderer directory); the `view=ask-panel` query routes the
 * bundle to the panel entry, exactly as `mode=help` routes it to the manual.
 */
export interface AiDrawerOverlayState {
  /** the drawer's persisted prefs — collapsed hides the overlay */
  dock: AiDockPrefs
  /** the interface scale, sizing the footprint like every chrome band */
  scale: number
  /** a document tab is the active tab (any kind but `home` covers the renderer) */
  docActive: boolean
  /**
   * The active tab's view covers the whole window (HTML fullscreen — a slides
   * slideshow — or the slides show's content bleed). The overlay hides for the
   * presentation's duration rather than intruding on it: the drawer state
   * stays recorded and the view returns on leave. Hiding, not destroying, so
   * the panel's session survives the round trip.
   */
  suppressed: boolean
  /** the window's live content area */
  window: { width: number; height: number }
}

/** the overlay's face the TabManager drives; no-op safe after teardown */
export interface AiDrawerOverlay {
  /** apply the state: mount/hide the view and fit its bounds */
  sync(state: AiDrawerOverlayState): void
  /** drop the view (tests, explicit teardown); the window's own close does it implicitly */
  destroy(): void
  /**
   * Push one message to the panel copy's renderer (P0-2 — the ask-intent
   * forward). Buffered until the view exists and its renderer finished
   * loading: a forwarded ask can beat the very prefs write that mounts this
   * view (Home's openAskDock hands off in the same breath), and dropping it
   * would route the question nowhere.
   */
  deliverToPanel(channel: string, payload: unknown): void
}

/**
 * The window-shaped effects the overlay cannot reach on its own. Injected by
 * the shell window's wiring (window-lifecycle.ts) so this module stays
 * testable with plain fakes.
 */
export interface AiDrawerOverlayDeps {
  /**
   * Hand the keyboard back to the active tab's view when the overlay hides
   * (P1-3): the composer inside the overlay held the focus, and a hidden
   * WebContentsView keeps it — without this, keystrokes strand in a surface
   * the person cannot see. The TabManager's focusActiveView is the verb.
   */
  focusActiveView: () => void
}

/** how many messages may wait for the panel's renderer; oldest dropped past it */
const MAX_PENDING_PANEL_MESSAGES = 25

export function createAiDrawerOverlay(
  shellWindow: BrowserWindow,
  deps: AiDrawerOverlayDeps = { focusActiveView: () => undefined },
): AiDrawerOverlay {
  let view: WebContentsView | null = null
  /** the interface scale the overlay's renderer last carried (`--ui-scale`) */
  let appliedScale = 1
  /** whether the last sync left the view showing — the hide path's guard */
  let shown = false
  /** messages waiting for the panel's renderer to load (deliverToPanel) */
  const pendingPanelMessages: Array<{ channel: string; payload: unknown }> = []
  /** whether the view's renderer finished a load — deliveries go direct then */
  let panelLoaded = false

  const applyScale = (wc: WebContents, scale: number): void => {
    appliedScale = scale
    applyUiScaleTo(wc, scale)
  }

  const createView = (scale: number): WebContentsView => {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // like every hidden tab view, a hidden overlay must throttle its
        // renderer (issue #27): the drawer's copy sleeps while nobody looks
      },
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      const target = safeExternalUrl(url)
      if (target) void shell.openExternal(target)
      return { action: 'deny' }
    })
    // The shared ui-scale boot (installUiScale) does reach this view's
    // webContents — `web-contents-created` fires for WebContentsView
    // renderers too — but the sync path here cannot rely on its timing: the
    // scale this overlay was handed is the authoritative one for the view,
    // and the load-time application must not race the first paint. The
    // load-time application below is therefore unconditional (an
    // executeJavaScript racing the load can fail silently); the sync-time one
    // only on change; both write the same inline `--ui-scale`, so the double
    // application with the shared boot is harmless.
    view.webContents.once('did-finish-load', () => {
      applyScale(view.webContents, scale)
      panelLoaded = true
      deliverPending()
    })
    // a failed load leaves a dead surface floating over the document — and
    // the pet that could dismiss it lives inside the very renderer that did
    // not load. Retry once (the common failure is a dev server still
    // booting), then report and stand down: the drawer is gone until the
    // state flips, which is better than a blank pane nobody can close.
    // Subframe failures (an image inside an answer) are not the panel's load.
    let retried = false
    view.webContents.on(
      'did-fail-load',
      (_event, code: number, description: string, failedUrl: string, isMainFrame: boolean) => {
        if (!isMainFrame) return
        // ERR_ABORTED (-3) is a navigation superseding itself (the retry, a
        // redirect): retrying it would loop
        if (code === -3 || retried) {
          if (code !== -3 && !panelLoaded) {
            console.warn(`[shell] ai drawer overlay failed to load (${description}): ${failedUrl}`)
          }
          return
        }
        retried = true
        loadPanelUrl(view.webContents)
      },
    )
    loadPanelUrl(view.webContents)
    return view
  }

  const loadPanelUrl = (wc: WebContents): void => {
    wc.loadURL(rendererUrl(process.env.ELECTRON_RENDERER_URL, 'help', { view: 'ask-panel' })).catch(
      () => {
        // the did-fail-load handler above owns the failure; the rejection is
        // only kept from becoming an unhandled one
      },
    )
  }

  const deliverPending = (): void => {
    const wc = view?.webContents
    if (!wc || wc.isDestroyed() || !panelLoaded) return
    for (const message of pendingPanelMessages.splice(0)) wc.send(message.channel, message.payload)
  }

  // the window's teardown destroys its contentView's children with it — the
  // overlay's renderer dies like every tab's. Only the reference must go, or
  // a late sync would act on a dead view.
  shellWindow.once('closed', () => {
    view = null
    pendingPanelMessages.length = 0
  })

  return {
    sync(state: AiDrawerOverlayState): void {
      if (shellWindow.isDestroyed()) return
      const show = !state.dock.collapsed && state.docActive && !state.suppressed
      if (!show) {
        // hidden, never destroyed: the prefs and the active tab decide
        // visibility, and the panel's thread outlives both flipping back
        const wasShown = shown
        shown = false
        view?.setVisible(false)
        // the composer inside the overlay held the keyboard, and a hidden
        // view keeps it: hand focus back to whatever owns the window now (the
        // TabManager's own focus verb — the active tab's view, or the shell
        // renderer when Home is the tab). Only on a real hide: a sync that
        // never showed this overlay must not move anyone's focus.
        if (wasShown) deps.focusActiveView()
        return
      }
      // a minimized or mid-restore window reports a degenerate rect: keep the
      // last good bounds, the same guard layout() gives the document views
      const { width, height } = state.window
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return
      const live = view ?? (view = createView(state.scale))
      live.setBounds(drawerOverlayBounds(state.window, { scale: state.scale, dock: state.dock }))
      // the entry opts into `zoom: var(--ui-scale)` like the app frame, so
      // the drawer's content reads at the same size whichever layer hosts it
      if (state.scale !== appliedScale) applyScale(live.webContents, state.scale)
      // re-adding an existing child re-orders it topmost: the overlay must
      // lead every view added since it last showed (a new tab's view, a
      // browser page sibling) without anyone tracking those additions
      shellWindow.contentView.addChildView(live)
      live.setVisible(true)
      shown = true
    },
    deliverToPanel(channel: string, payload: unknown): void {
      pendingPanelMessages.push({ channel, payload })
      if (pendingPanelMessages.length > MAX_PENDING_PANEL_MESSAGES) {
        pendingPanelMessages.splice(0, pendingPanelMessages.length - MAX_PENDING_PANEL_MESSAGES)
      }
      deliverPending()
    },
    destroy(): void {
      const live = view
      view = null
      pendingPanelMessages.length = 0
      if (!live) return
      if (!shellWindow.isDestroyed()) shellWindow.contentView.removeChildView(live)
      if (!live.webContents.isDestroyed()) live.webContents.close()
    },
  }
}
